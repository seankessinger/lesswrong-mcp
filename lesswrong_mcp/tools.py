"""The eight read-only MCP tools (and the /health route), registered on the `mcp` singleton.

Importing this module has the side effect of registering the tools (via @mcp.tool) and the
liveness route (via @mcp.custom_route) on `mcp`, so a bare `import lesswrong_mcp` — whose
__init__ imports this module — yields a fully-populated server. Tool bodies are the happy
path: the _tool_errors funnel (from server) turns anticipated network/API failures into
"Error: ..." strings, and all I/O goes THROUGH the http_client module so the hermetic suite
can patch it.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Annotated, Any

from pydantic import Field
from starlette.requests import Request
from starlette.responses import PlainTextResponse

from lesswrong_mcp import http_client
from lesswrong_mcp.config import (
    DEFAULT_SITE,
    MAX_GRAPHQL_SKIP,
    SEARCH_PAGE_MAX,
    SEARCH_RESULT_WINDOW,
    Site,
    ResponseFormat,
    SearchType,
    CommentSort,
    Feed,
    PostSort,
    _base,
)
from lesswrong_mcp.graphql_resolve import _resolve_tag_id, _resolve_user_id
from lesswrong_mcp.markdown import (
    _extract_post_ref,
    _extract_sequence_ref,
    _extract_tag_ref,
    _extract_user_ref,
    _md_inline,
    _seg,
    _slice_markdown,
    _slug_hint,
)
from lesswrong_mcp.server import (
    SiteParam,
    _apply_flat_schemas,
    _readonly_annotations,
    _tool_errors,
    mcp,
)


@mcp.tool(name="lw_search", annotations=_readonly_annotations("Search LessWrong / Alignment Forum"))
@_tool_errors
async def lw_search(
    query: Annotated[str, Field(description="Full-text search query, e.g. 'mesa optimization'.", min_length=2, max_length=300)],
    content_type: Annotated[SearchType | None, Field(description="Restrict to one content type: 'posts', 'comments', 'tags', 'users', or 'sequences'. Omit to search all of them.")] = None,
    page: Annotated[int, Field(description="1-indexed results page. Max 1000, but page × limit must be ≤ 10000 — the shared index only serves the first 10,000 results.", ge=1, le=SEARCH_PAGE_MAX)] = 1,
    limit: Annotated[int, Field(description="Results per content type. Max 20.", ge=1, le=20)] = 10,
) -> str:
    """Full-text search across LessWrong and the Alignment Forum together.

    The two forums share one search index, so this single query covers both; there is
    no separate "Alignment Forum only" search. (For AF-only browsing by author, tag,
    date, or karma, use lw_filter_posts with alignment_forum_only=true.)

    This is the primary discovery tool. It returns a Markdown results page grouped by
    content type. Each post result includes title, author, karma, date, and its post
    `<id>` (shown in a `/api/post/<id>` link) — pass that id to lw_get_post; comment
    results include a snippet and a link to the parent post + comment. Pass `content_type`
    to search just one kind of content and get more of it.

    Returns:
        str: Markdown search results, or "Error: ..." on failure.

    Use when: "find posts about deceptive alignment" -> query="deceptive alignment".
    Don't use to fetch one known post's body -> use lw_get_post instead.
    """
    # min_length=2 only bounds the raw length, so an all-whitespace query (e.g. "  ")
    # slips through. The backend treats a blank `search` term as "no query" and serves
    # its /api/search *documentation* page instead of results — a silently-useless
    # response. Reject an empty-after-strip query up front with an actionable error,
    # before the network call, matching how the other tools fail fast.
    if not query.strip():
        return "Error: empty search query. Pass at least one non-whitespace search term."
    # The shared search index (Elasticsearch max_result_window) only serves the first
    # SEARCH_RESULT_WINDOW results: from + size <= 10000, i.e. page * limit <= 10000.
    # A deeper request is a *deterministic* backend HTTP 500, which _request would also
    # waste its retry budget on — so fail fast here, before the network call, with an
    # actionable message instead of an opaque "Forum API returned HTTP 500".
    if page * limit > SEARCH_RESULT_WINDOW:
        return (
            f"Error: search returns at most the first {SEARCH_RESULT_WINDOW:,} results "
            f"(page × limit must be ≤ {SEARCH_RESULT_WINDOW:,}). Lower page or limit."
        )
    params: dict[str, Any] = {"search": query, "page": page - 1, "limit": limit}
    if content_type is not None:
        params["type"] = content_type.value
    md = await http_client._get_markdown(DEFAULT_SITE, "/api/search", params)
    notes: list[str] = []
    if content_type is not None:
        # With a single type requested, the page still labels its count line "across all
        # types" though the number is that one type's total; relabel just that line so the
        # header matches the filter. A no-op if the upstream wording ever changes.
        md = md.replace("- Results across all types:", f"- Results for {content_type.value}:", 1)
    else:
        # An all-types search fans `limit` across every content type, so it returns up to
        # limit × (number of types) rows — state that so `limit=2` yielding ~10 rows isn't a
        # surprise (see the tool docstring).
        notes.append(f"Showing up to {limit} results per content type (× {len(SearchType)} types).")
    # A next-page affordance mirroring the other list tools' footers. Only offer a page the
    # tool would actually accept: it must clear this tool's own two bounds — the page ceiling
    # (page+1 ≤ SEARCH_PAGE_MAX) and the result window ((page+1)·limit ≤ SEARCH_RESULT_WINDOW,
    # the same pre-flight guard above). Gating on both avoids pointing at a page that Pydantic
    # then rejects (page > SEARCH_PAGE_MAX) or the window guard blocks.
    if page < SEARCH_PAGE_MAX and (page + 1) * limit <= SEARCH_RESULT_WINDOW:
        notes.append(
            f"Next page (within the first {SEARCH_RESULT_WINDOW:,} results): call again with "
            f"page={page + 1}."
        )
    if notes:
        md = md + "\n\n---\n" + "\n".join(f"[{note}]" for note in notes)
    return md


@mcp.tool(name="lw_get_post", annotations=_readonly_annotations("Get a post (full body + metadata)"))
@_tool_errors(not_found="post", id_param="id_or_slug")
async def lw_get_post(
    id_or_slug: Annotated[str, Field(description="Post _id (17-char, e.g. 'RuGZ5tMdqpnraJahJ') or its URL slug.", min_length=1, max_length=300)],
    max_chars: Annotated[int | None, Field(description="Cap the returned Markdown to this many characters (metadata + start of body come first). Omit for the whole post. A footer notes the offset to pass next when truncated. Minimum 500.", ge=500, le=500000)] = None,
    offset: Annotated[int, Field(description="Skip this many characters from the start before returning — for paging through a long post together with max_chars. Max 10000000.", ge=0, le=10000000)] = 0,
    site: SiteParam = Site.lesswrong,
) -> str:
    """Fetch a single post's full body and metadata as clean Markdown.

    Metadata includes author (and coauthors), date, karma, tags, frontpage status,
    comment count, and canonical URLs. The body is Markdown (no HTML stripping needed);
    images arrive as CDN links and math/tables as terse source, so the whole post is
    returned by default.

    For very long posts that would blow the response/token budget, cap the output with
    max_chars (the metadata header and body start are returned first); when the slice
    stops short, a footer gives the exact offset to pass on the next call, so you can
    page through the whole post inline. offset alone (with no max_chars) skips a prefix.

    The same post can return slightly different Markdown (and so a different total
    character count) on `lesswrong` vs `alignmentforum` — absolute links carry the site
    host and the embedded top-comments differ — so a paging offset isn't portable across
    sites; page within one `site`.

    Returns:
        str: Markdown of the post, or "Error: ..." on failure.
    """
    ref = _extract_post_ref(id_or_slug)
    md = await http_client._get_markdown(site.value, f"/api/post/{_seg(ref)}")
    return _slice_markdown(md, offset, max_chars)


@mcp.tool(name="lw_get_comments", annotations=_readonly_annotations("Get a post's comment thread"))
@_tool_errors(not_found="post", id_param="id_or_slug")
async def lw_get_comments(
    id_or_slug: Annotated[str, Field(description="Post _id or slug whose comment thread you want.", min_length=1, max_length=300)],
    sort: Annotated[CommentSort, Field(description="Comment ordering: 'top', 'new', or 'old'.")] = CommentSort.top,
    limit: Annotated[int, Field(description="Max comments to return. Max 2000; long threads need a high value to be complete.", ge=1, le=2000)] = 50,
    include_reaction_users: Annotated[bool, Field(description="Append the reacting users' names to each emoji-reaction line, e.g. 'agree: 1 (Dakara)'. Only affects comments that carry emoji reactions; plain karma/approval votes render nothing extra.")] = False,
    max_chars: Annotated[int | None, Field(description="Cap the returned Markdown to this many characters. Omit for the whole thread. A footer notes the offset to pass next when truncated. Minimum 500.", ge=500, le=500000)] = None,
    offset: Annotated[int, Field(description="Skip this many characters from the start before returning — for paging a long thread together with max_chars. Max 10000000.", ge=0, le=10000000)] = 0,
    site: SiteParam = Site.lesswrong,
) -> str:
    """Fetch the comment thread for a post as Markdown, with author, karma, and nesting.

    Keep the default `lesswrong` site for completeness: it returns the full thread. The
    `alignmentforum` view of the same post returns only the comments promoted to the
    Alignment Forum, which is a subset. Big threads can run to hundreds of comments, so
    raise `limit` (up to 2000) when you need the whole thing.

    `limit` bounds the comment *count*; a big thread can still be a large payload, so
    max_chars/offset cap and page the Markdown by size the same way lw_get_post does.

    The thread's upstream header (e.g. "Showing 192 of 188 comments") is returned
    verbatim. The first figure is how many comments were rendered (it tracks `limit`);
    the second is the post's stored total. The two are computed differently upstream and
    can legitimately differ — the rendered count can even exceed the total — so don't
    treat the header as an authoritative count.

    Returns:
        str: Markdown comment thread, or "Error: ..." on failure.
    """
    ref = _extract_post_ref(id_or_slug)
    params: dict[str, Any] = {"sort": sort.value, "limit": limit}
    if include_reaction_users:
        params["includeReactionUsers"] = 1
    md = await http_client._get_markdown(site.value, f"/api/post/{_seg(ref)}/comments", params)
    return _slice_markdown(md, offset, max_chars, label="lw_get_comments")


@mcp.tool(name="lw_get_user", annotations=_readonly_annotations("Get a user profile + top posts"))
@_tool_errors(not_found="user", id_param="slug")
async def lw_get_user(
    slug: Annotated[str, Field(description="User profile slug, e.g. 'cleo-nardo' (from /users/<slug>).", min_length=1, max_length=300)],
    site: SiteParam = Site.lesswrong,
) -> str:
    """Fetch a user's profile as Markdown: karma (site + Alignment Forum), post/comment
    counts, join date, bio, and their top posts with karma/tags/dates and post links.

    For date/karma-filtered or fully-sorted author listings, use lw_filter_posts with
    author=<slug> instead.

    Accepts the bare slug or a full profile URL / `/users/<slug>` path (the same forms the
    post/comment/sequence tools accept), so a copied profile link works as-is.

    The profile's "Posts:" figure comes from the site's own profile view and can differ
    from the row count lw_filter_posts returns for the same author: the two use different
    backends with different inclusion rules (drafts, shortform, link-posts, unlisted/
    deleted, AF-vs-site scope), so they were never defined to match.

    Returns:
        str: Markdown user profile, or "Error: ..." on failure.
    """
    return await http_client._get_markdown(site.value, f"/api/user/{_seg(_extract_user_ref(slug))}")


@mcp.tool(name="lw_get_tag", annotations=_readonly_annotations("Get a tag / wiki page"))
@_tool_errors(not_found="tag", id_param="slug")
async def lw_get_tag(
    slug: Annotated[str, Field(description="Tag / wiki slug, e.g. 'ai' or 'mesa-optimization' (from /w/<slug>).", min_length=1, max_length=300)],
    site: SiteParam = Site.lesswrong,
) -> str:
    """Fetch a tag/wiki page as Markdown: the wiki article plus posts carrying the tag.

    Useful for orienting in a topic area (e.g. 'ai', 'mesa-optimization',
    'infra-bayesianism'). For precise tag filtering by date/karma/sort, use
    lw_filter_posts with tag=<slug>.

    Accepts the bare slug or a full wiki URL / `/w/<slug>` (or `/tag/<slug>`) path (the same
    forms the post/comment/sequence tools accept), so a copied tag link works as-is.

    Returns:
        str: Markdown tag/wiki page, or "Error: ..." on failure.
    """
    return await http_client._get_markdown(site.value, f"/api/tag/{_seg(_extract_tag_ref(slug))}")


@mcp.tool(name="lw_get_sequence", annotations=_readonly_annotations("Get a sequence (ordered post list)"))
@_tool_errors(not_found="sequence", id_param="id_or_slug")
async def lw_get_sequence(
    id_or_slug: Annotated[str, Field(description="Sequence _id (e.g. 'r9tYkB2a8Fp4DN8yB') or its URL slug (from /s/<id> or /api/sequence/<id>).", min_length=1, max_length=300)],
    site: SiteParam = Site.lesswrong,
) -> str:
    """Fetch a sequence as Markdown: its title, author, description, and the ordered
    list of chapter posts (each linked as /api/post/<id> to pass to lw_get_post).

    Sequences are the site's curated, ordered reading lists. lw_search (type='sequences')
    surfaces them and posts carry sequence nav; this expands one into its full ordered
    post list.

    Returns:
        str: Markdown sequence page, or "Error: ..." on failure.
    """
    ref = _extract_sequence_ref(id_or_slug)
    return await http_client._get_markdown(site.value, f"/api/sequence/{_seg(ref)}")


@mcp.tool(name="lw_list_feed", annotations=_readonly_annotations("List a front-page feed"))
@_tool_errors
async def lw_list_feed(
    feed: Annotated[Feed, Field(description="Which feed: 'latest', 'recent', 'curated', or 'home'. 'home' is a fixed composite view and ignores 'limit'.")] = Feed.latest,
    limit: Annotated[int, Field(description="Max posts to list. Max 100. Honoured by 'latest'/'recent'/'curated'; the 'home' composite ignores it.", ge=1, le=100)] = 20,
    site: SiteParam = Site.lesswrong,
) -> str:
    """List posts from a site feed ('latest', 'recent', 'curated', 'home') as Markdown.

    'latest', 'recent', and 'curated' are flat lists that honour `limit`. 'home' is a
    fixed composite page (spotlight + recently curated + recent + latest) and ignores
    `limit`; use one of the flat feeds when you need a specific count.

    Returns:
        str: Markdown feed, or "Error: ..." on failure.
    """
    return await http_client._get_markdown(site.value, f"/api/{feed.value}", {"limit": limit})


@mcp.tool(name="lw_filter_posts", annotations=_readonly_annotations("Filter posts by author/tag/date/karma"))
@_tool_errors
async def lw_filter_posts(
    author: Annotated[str | None, Field(description="Author profile slug (e.g. 'cleo-nardo') or user _id. Restricts to that author.")] = None,
    tag: Annotated[str | None, Field(description="Tag slug (e.g. 'ai') or tag _id. Restricts to posts with that tag. Require several at once (their intersection) by passing them comma-separated, e.g. 'ai,interpretability'.")] = None,
    after: Annotated[str | None, Field(description="Only posts on/after this date. ISO 'YYYY-MM-DD'.", pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    before: Annotated[str | None, Field(description="Only posts on/before this date. ISO 'YYYY-MM-DD'.", pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    min_karma: Annotated[int | None, Field(description="Only posts with karma (baseScore) >= this value. Range -100 to 100000.", ge=-100, le=100000)] = None,
    sort: Annotated[PostSort, Field(description="Sort order: 'top' (karma), 'new', 'old', 'magic', 'recentComments'.")] = PostSort.top,
    alignment_forum_only: Annotated[bool, Field(description="If true, restrict to Alignment-Forum-promoted posts (af=true).")] = False,
    limit: Annotated[int, Field(description="Max posts to return. Max 100.", ge=1, le=100)] = 20,
    offset: Annotated[int, Field(description="Number of posts to skip (pagination). Max 2000.", ge=0, le=MAX_GRAPHQL_SKIP)] = 0,
    response_format: Annotated[ResponseFormat, Field(description="'markdown' (readable) or 'json' (structured).")] = ResponseFormat.markdown,
    site: SiteParam = Site.lesswrong,
) -> str:
    """Precise, structured post filtering via GraphQL — the one thing full-text search
    can't do deterministically.

    Combine any of: author, tag, date range (after/before), minimum karma, and an
    explicit sort order. author/tag may be a slug (resolved automatically) or a raw
    _id; tag may be several comma-separated slugs/ids to require all of them at once
    (their intersection). Set alignment_forum_only=true to restrict to AF-promoted posts.

    The returned `count` is this selector's own row count and can differ from a user
    profile's "Posts:" figure (see lw_get_user) — the two backends count different sets.

    Returns:
        str: Markdown list (title, author, karma, date, comments, /api/post link) or,
        with response_format='json', a JSON object:
        {
          "count": int,
          "has_more": bool,        # a further page is fetchable — pass next_offset as offset
          "next_offset": int|null, # offset for the next page when has_more, else null
          "depth_limited": bool,   # true at the paging-depth cap (offset == 2000): more posts
                                   #   exist but no offset reaches them — narrow the filters
          "posts": [
            {"_id": str, "title": str, "slug": str, "url": str, "postedAt": str,
             "karma": int, "commentCount": int, "author": str, "authorSlug": str}
          ]
        }
        These reflect the server's row count (before the min_karma safety-net filter), so
        count < limit does not by itself mean the last page. offset is capped at 2000, so
        near the cap next_offset clamps to 2000 and the final page overlaps the previous one
        — de-duplicate by _id when paging.
        On failure, "Error: ..." (e.g. author/tag slug not found).
    """
    s = site.value

    # The date Fields only regex-check shape (^\d{4}-\d{2}-\d{2}$), which admits
    # non-dates like '2025-02-30'. Parse both up front and return a clean error rather
    # than letting date.fromisoformat raise an uncaught ValueError past _tool_errors.
    after_date: date | None = None
    if after:
        try:
            after_date = date.fromisoformat(after)
        except ValueError:
            return f"Error: invalid 'after' date {after!r}. Use a real calendar date (YYYY-MM-DD)."
    before_date: date | None = None
    if before:
        try:
            before_date = date.fromisoformat(before)
        except ValueError:
            return f"Error: invalid 'before' date {before!r}. Use a real calendar date (YYYY-MM-DD)."

    author_id: str | None = None
    if author:
        author_id = await _resolve_user_id(s, author)
        if not author_id:
            return (
                f"Error: no user found for author '{author}'. "
                f"Pass a valid profile slug or user _id.{_slug_hint(author)}"
            )

    tag_ids: list[str] = []
    if tag:
        # A single call can require several tags at once (their intersection) by passing
        # them comma-separated, e.g. tag="ai,interpretability". Each is resolved
        # independently (slug -> _id, cached) and applied as its own Required filterSettings
        # entry below; a lone slug is the common case and behaves exactly as before.
        for slug in (t.strip() for t in tag.split(",")):
            if not slug:
                continue
            tag_id = await _resolve_tag_id(s, slug)
            if not tag_id:
                return (
                    f"Error: no tag found for '{slug}'. "
                    f"Pass a valid tag slug or tag _id.{_slug_hint(slug)}"
                )
            tag_ids.append(tag_id)
        if not tag_ids:
            # `tag` was truthy but every comma-separated segment was blank (e.g. "," or
            # " , "). Fail fast like the old single-tag path rather than silently running an
            # unfiltered query under a header that falsely claims a tag filter.
            return f"Error: no tag found for {tag!r}. Pass a valid tag slug or tag _id."

    # Query the view named by the requested sort, and apply any tag as a `filterSettings`
    # required-tag — the same mechanism the site's own tag pages use. Every sort view
    # honours filterSettings, and it composes with the shared userId/after/before/
    # karmaThreshold/af fields, so a tag combines cleanly with any sort and any other
    # filter. (The dedicated tagRelevance view ties a tag to its own relevance ordering,
    # so it can't serve an explicit sort — filterSettings keeps the two independent.)
    view = sort.value
    inner: dict[str, Any] = {"sortedBy": sort.value}
    if author_id:
        inner["userId"] = author_id
    if tag_ids:
        inner["filterSettings"] = {
            "tags": [{"tagId": tid, "filterMode": "Required"} for tid in tag_ids]
        }
    if after_date is not None:
        inner["after"] = after_date.isoformat()
    if before_date is not None and before_date < date.max:
        # The GraphQL selector treats `before` as an exclusive midnight-start bound,
        # so a raw date would drop the whole boundary day. Advance one day to make
        # `before` inclusive of its date, matching the docstring and the `after` side.
        inner["before"] = (before_date + timedelta(days=1)).isoformat()
    if min_karma is not None:
        inner["karmaThreshold"] = min_karma
    if alignment_forum_only:
        inner["af"] = True

    gql = (
        "query ($selector: PostSelector!, $limit: Int, $offset: Int) {"
        "  posts(selector: $selector, limit: $limit, offset: $offset) {"
        "    results { _id title slug pageUrl postedAt baseScore commentCount"
        "              user { displayName slug } }"
        "  }"
        "}"
    )
    # Over-fetch one extra row so has_more can be reported without a second round-trip:
    # if the (limit+1)th row comes back, more posts exist at offset+limit. Trim it off
    # before building the page so the response still holds at most `limit` rows. (The
    # GraphQL posts view accepts limit > 100, so limit+1 is safe even at the max limit.)
    data = await http_client._graphql(s, gql, {"selector": {view: inner}, "limit": limit + 1, "offset": offset})
    results = (data.get("posts") or {}).get("results") or []
    # A surplus (limit+1)th row means more posts exist server-side. Whether the caller can
    # *reach* them turns on offset alone: the backend caps skip at MAX_GRAPHQL_SKIP and the
    # cap is on the offset value itself (not offset+limit), so a further page is fetchable
    # iff offset < the cap — regardless of limit. That splits the signal two ways:
    #   - has_more:      offset is below the cap, so another page is fetchable. Its offset is
    #                    min(offset+limit, cap): near the cap this clamps to the cap, so the
    #                    final page overlaps this one (de-dup by _id when paging).
    #   - depth_limited: offset is already at the cap, so no higher offset exists and the
    #                    surplus rows are unreachable — narrow the filters to reach them.
    # Splitting them keeps has_more=False from conflating "last page" with "hit the wall".
    surplus = len(results) > limit
    has_more = surplus and offset < MAX_GRAPHQL_SKIP
    depth_limited = surplus and not has_more
    next_offset = min(offset + limit, MAX_GRAPHQL_SKIP) if has_more else None
    results = results[:limit]

    posts = [
        {
            "_id": p.get("_id"),
            "title": p.get("title"),
            "slug": p.get("slug"),
            "url": p.get("pageUrl"),
            "postedAt": p.get("postedAt"),
            "karma": p.get("baseScore"),
            "commentCount": p.get("commentCount"),
            "author": (p.get("user") or {}).get("displayName"),
            "authorSlug": (p.get("user") or {}).get("slug"),
        }
        for p in results
    ]

    # ForumMagnum's post view no-ops karmaThreshold == 0 (it applies a baseScore
    # bound only for non-zero thresholds), so a bare min_karma=0 would let
    # negative-karma posts slip through. Enforce the documented ">= min_karma"
    # contract here for every value; it's a no-op when the server already filtered.
    if min_karma is not None:
        posts = [p for p in posts if (p["karma"] or 0) >= min_karma]

    if response_format == ResponseFormat.json:
        # has_more/next_offset/depth_limited reflect the server's row count (computed above,
        # before the min_karma safety-net filter), so they signal further *server* rows — the
        # right paging signal even when that client filter trims some rows from this page.
        return json.dumps(
            {
                "count": len(posts),
                "has_more": has_more,
                "next_offset": next_offset,
                "depth_limited": depth_limited,
                "posts": posts,
            },
            indent=2,
        )

    # A next-page / depth hint for the Markdown branch, mirroring the char-paging footers
    # the body tools already append, so the paging signal isn't JSON-only.
    if has_more:
        footer = f"\n\n---\n[More results — call again with offset={next_offset} to continue.]"
    elif depth_limited:
        footer = (
            f"\n\n---\n[More results exist but lie past the paging-depth cap (offset can't exceed "
            f"{MAX_GRAPHQL_SKIP}); narrow the filters (author/tag/date range/min_karma) to reach them.]"
        )
    else:
        footer = ""

    if not posts:
        # min_karma can empty this page while the server still has (reachable or capped-off)
        # rows, so surface the paging hint and scope the lead to "this page" rather than a
        # flat — and, with a footer, self-contradictory — "nothing matched".
        lead = "No posts on this page matched those filters." if footer else "No posts matched those filters."
        return lead + footer

    base = _base(s)
    # Keep this display in lock-step with `inner` above: one spec row per filter,
    # gated exactly as the selector is (strings by truthiness, min_karma by None).
    crumb_specs = (
        ("author", author or None),
        ("tag", tag or None),
        ("after", after or None),
        ("before", before or None),
        ("min_karma", min_karma),
        ("alignment_forum_only", "true" if alignment_forum_only else None),
    )
    crumbs = [f"{label}={value}" for label, value in crumb_specs if value is not None]
    crumbs.append(f"sort={sort.value}")

    lines = [f"# Filtered posts ({len(posts)}) — {', '.join(crumbs)}", ""]
    for p in posts:
        posted = (p["postedAt"] or "")[:10]
        link = f"{base}/api/post/{p['_id']}"
        title = _md_inline(p["title"])
        author = _md_inline(p["author"])
        lines.append(
            f"- [{title}]({link}) — author: {author} | "
            f"karma: {p['karma']} | {posted} | comments: {p['commentCount']}"
        )
    return "\n".join(lines) + footer


@mcp.custom_route("/health", methods=["GET"])
async def health_check(request: Request) -> PlainTextResponse:
    """Liveness probe for hosting platforms."""
    return PlainTextResponse("ok")


# With every tool now registered, hoist each schema's nullable/enum constraints to the top
# level so schema-shallow clients can read and enforce them (see server._apply_flat_schemas).
_apply_flat_schemas(mcp)
