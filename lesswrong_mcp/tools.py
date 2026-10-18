"""The eight read-only MCP tools, registered on the `mcp` singleton.

Importing this module has the side effect of registering the tools (via @lw_tool) on `mcp`, so
a bare `import lesswrong_mcp` — whose __init__ imports this module — yields a fully-populated
server. Tool bodies are the happy path: the _tool_errors funnel that lw_tool applies turns
anticipated network/API failures into MCP tool errors, the bodies' own input checks raise
ToolError directly (as does the single-comment fetch, for the two statuses its route gives a
missing comment), and all I/O goes THROUGH the http_client module so the hermetic suite can
patch it.
"""
from __future__ import annotations

import json
import re
from collections.abc import Sequence
from datetime import date, timedelta
from typing import Annotated, Any, NamedTuple, get_args
from urllib.parse import quote

import httpx
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BeforeValidator, Field, StringConstraints

from lesswrong_mcp import http_client
from lesswrong_mcp.config import (
    MAX_CHARS,
    MAX_GRAPHQL_SKIP,
    MAX_TAG_FILTERS,
    SEARCH_PAGE_MAX,
    SEARCH_RESULT_WINDOW,
    SITE_BASE_URLS,
    ResponseFormat,
    SearchType,
    CommentSort,
    Feed,
    PostSort,
    Site,
)
from lesswrong_mcp.errors import FIND
from lesswrong_mcp.graphql_resolve import _resolve_tag_id, _resolve_user_id
from lesswrong_mcp.markdown import _md_inline, _slice_markdown
from lesswrong_mcp.server import (
    CommentRef,
    MaxCharsParam,
    OffsetParam,
    PostRef,
    SequenceRef,
    SiteParam,
    TagRef,
    TagsParam,
    UserRef,
    lw_tool,
)

# The per-type headers of a search page, e.g. "## Posts (25 total)".
_SEARCH_TOTAL_RE = re.compile(r"^## .+? \((\d+) total\)\s*$", re.MULTILINE)


@lw_tool("lw_search", "Search LessWrong / Alignment Forum")
async def lw_search(
    # Stripped before its bounds apply, so a blank query fails the 2-character minimum rather
    # than reaching the backend, which answers a blank `search` with its /api/search docs page.
    query: Annotated[str, StringConstraints(strip_whitespace=True), Field(description="Full-text search query, e.g. 'mesa optimization'.", min_length=2, max_length=300)],
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
    to search one kind only; `limit` then counts just that kind (an all-types search returns
    up to `limit` of each).

    Returns:
        str: Markdown search results. Failures come back as tool errors.

    Use when: "find posts about deceptive alignment" -> query="deceptive alignment".
    Don't use to fetch one known post's body -> use lw_get_post instead.
    """
    # The shared index serves only the first SEARCH_RESULT_WINDOW results (page * limit <=
    # 10000). A deeper request is a deterministic 500 that would also burn the retry budget,
    # so fail fast with an actionable message.
    if page * limit > SEARCH_RESULT_WINDOW:
        raise ToolError(
            f"search returns at most the first {SEARCH_RESULT_WINDOW:,} results "
            f"(page × limit must be ≤ {SEARCH_RESULT_WINDOW:,}). Lower page or limit."
        )
    params: dict[str, Any] = {"search": query, "page": page - 1, "limit": limit}
    if content_type is not None:
        params["type"] = content_type
    # One index serves both forums, so search always asks LessWrong.
    md = await http_client._get_markdown("lesswrong", "/api/search", params)
    notes: list[str] = []
    if content_type is not None:
        # With one type requested the page still labels its count "across all types" though
        # the number is that type's total. A no-op if the upstream wording changes.
        md = md.replace("- Results across all types:", f"- Results for {content_type}:", 1)
    else:
        # An all-types search fans `limit` across every type, so `limit=2` yields ~10 rows.
        types = len(get_args(SearchType))
        notes.append(f"Showing up to {limit} results per content type (× {types} types).")
    # Offer a next page only while results remain and the page is one this tool would accept.
    # `limit` applies per type, so the deepest type's total bounds the useful pages; with no
    # total parsed, fall back to offering it. The page ceiling and the result window must both
    # hold too, or the hint would point at a page Pydantic rejects.
    totals = [int(n) for n in _SEARCH_TOTAL_RE.findall(md)]
    results_remain = not totals or page * limit < max(totals)
    if results_remain and page < SEARCH_PAGE_MAX and (page + 1) * limit <= SEARCH_RESULT_WINDOW:
        notes.append(
            f"Next page (within the first {SEARCH_RESULT_WINDOW:,} results): call again with "
            f"page={page + 1}."
        )
    if notes:
        md = md + "\n\n---\n" + "\n".join(f"[{note}]" for note in notes)
    return md


@lw_tool("lw_get_post", "Get a post (full body + metadata)", not_found="post", id_param="id_or_slug")
async def lw_get_post(
    id_or_slug: Annotated[PostRef, Field(description="Post _id (17 characters, e.g. 'RuGZ5tMdqpnraJahJ') or slug, as a bare value: the segment after /api/post/; in a pasted /posts/<id>/<slug> or /s/<seq>/p/<id> link, the <id>.")],
    max_chars: Annotated[MaxCharsParam, Field(description=f"Cap the returned Markdown to this many characters (metadata + start of body come first). Minimum 500, Max {MAX_CHARS}, the default: to read further, call again with the offset the footer gives.")] = MAX_CHARS,
    offset: Annotated[OffsetParam, Field(description="Skip this many characters from the start before returning — for paging through a long post together with max_chars. Max 10000000.")] = 0,
    site: SiteParam = "lesswrong",
) -> str:
    """Fetch a single post's full body and metadata as clean Markdown.

    Metadata includes author (and coauthors), date, karma, tags, frontpage status,
    comment count, and canonical URLs. The body is Markdown (no HTML stripping needed);
    images arrive as CDN links and math/tables as terse source.

    The output is sliced to max_chars characters (at most 40000, the default), metadata
    header and body start first; when the slice stops short, a footer gives the exact offset
    to pass on the next call, so you page through a long post inline.

    The same post can return slightly different Markdown (and so a different total
    character count) on `lesswrong` vs `alignmentforum` — absolute links carry the site
    host and the embedded top-comments differ — so a paging offset isn't portable across
    sites; page within one `site`.

    Returns:
        str: Markdown of the post. Failures come back as tool errors.
    """
    md = await http_client._get_markdown(site, f"/api/post/{id_or_slug}")
    return _slice_markdown(md, offset, max_chars, label="lw_get_post")


async def _get_comment(site: Site, ref: str, cid: str) -> str:
    """One comment's Markdown, from /api/post/<ref>/comments/<cid>.

    The route answers 404 for a post it can't find or a comment that isn't on that post, and a
    bare 500 for a comment id the forum doesn't have (checked live, 2026-10-16), so both are
    reported as the comment lookup they are. Any other failure reaches the error funnel.
    """
    path = f"/api/post/{ref}/comments/{cid}"
    try:
        return await http_client._get_markdown(site, path)
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        if code == 404:
            raise ToolError(
                f"no comment {cid!r} found on post {ref!r} (404). "
                "Pass the post's _id or slug and the _id of one of its comments."
            ) from exc
        if code == 500:
            raise ToolError(
                f"the forum answered HTTP 500 for comment {cid!r} on post {ref!r}, as it does for "
                "a comment id it doesn't have. Check the comment _id; if it is right, try again later."
            ) from exc
        raise


@lw_tool("lw_get_comments", "Get a post's comment thread or one comment", not_found="post", id_param="id_or_slug")
async def lw_get_comments(
    id_or_slug: Annotated[PostRef, Field(description="Post _id or slug whose thread you want, as a bare value: the segment after /api/post/; in a pasted /posts/<id>/<slug> link, the <id>; in a comment link, the post part.")],
    comment_id: Annotated[CommentRef | None, Field(description="Fetch just this one comment instead of the thread: the <cid> in /api/post/<post>/comments/<cid>; in a pasted comment link, the <cid> after /comment/, in ?commentId=<cid>, or after # (a 17-character id).")] = None,
    sort: Annotated[CommentSort, Field(description="Comment ordering: 'top', 'new', or 'old'.")] = "top",
    limit: Annotated[int, Field(description="Max comments to return. Max 2000; long threads need a high value to be complete.", ge=1, le=2000)] = 50,
    include_reaction_users: Annotated[bool, Field(description="Append the reacting users' names to each emoji-reaction line, e.g. 'agree: 1 (Dakara)'. Only affects comments that carry emoji reactions; plain karma/approval votes render nothing extra.")] = False,
    max_chars: Annotated[MaxCharsParam, Field(description=f"Cap the returned Markdown to this many characters. Minimum 500, Max {MAX_CHARS}, the default: to read further, call again with the offset the footer gives.")] = MAX_CHARS,
    offset: Annotated[OffsetParam, Field(description="Skip this many characters from the start before returning — for paging a long thread together with max_chars. Max 10000000.")] = 0,
    site: SiteParam = "lesswrong",
) -> str:
    """Fetch the comment thread for a post as Markdown, with author, karma, and nesting, or
    one comment on its own.

    Keep the default `lesswrong` site for completeness: it returns the full thread. The
    `alignmentforum` view of the same post returns only the comments promoted to the
    Alignment Forum, which is a subset. Big threads can run to hundreds of comments, so
    raise `limit` (up to 2000) when you need the whole thing.

    `limit` bounds the comment *count*; a big thread can still be a large payload, so
    max_chars/offset cap and page the Markdown by size the same way lw_get_post does
    (slices of at most 40000 characters, the default).

    The thread's upstream header (e.g. "Showing 192 of 188 comments") is returned
    verbatim. The first figure is how many comments were rendered (it tracks `limit`);
    the second is the post's stored total. The two are computed differently upstream and
    can legitimately differ — the rendered count can even exceed the total — so don't
    treat the header as an authoritative count.

    To fetch one comment, pass its _id as comment_id. That returns just the comment, without
    its replies, under its post's title. It always lists the reacting users, and sort, limit
    and include_reaction_users don't apply to it.

    Returns:
        str: Markdown comment thread, or the one comment. Failures come back as tool errors.
    """
    if comment_id is not None:
        md = await _get_comment(site, id_or_slug, comment_id)
    else:
        params: dict[str, Any] = {"sort": sort, "limit": limit}
        if include_reaction_users:
            params["includeReactionUsers"] = 1
        md = await http_client._get_markdown(site, f"/api/post/{id_or_slug}/comments", params)
    return _slice_markdown(md, offset, max_chars, label="lw_get_comments")


@lw_tool("lw_get_user", "Get a user profile + top posts", not_found="user", id_param="slug")
async def lw_get_user(
    slug: Annotated[UserRef, Field(description="User slug, e.g. 'cleo-nardo': the <slug> in /users/<slug> or /api/user/<slug>. It often differs from the display name: find it with lw_search(content_type='users').")],
    site: SiteParam = "lesswrong",
) -> str:
    """Fetch a user's profile as Markdown: karma (site + Alignment Forum), post/comment
    counts, join date, bio, and their top posts with karma/tags/dates and post links.

    For date/karma-filtered or fully-sorted author listings, use lw_filter_posts with
    author=<slug> instead.

    The profile's "Posts:" figure comes from the site's own profile view and can differ
    from the number of posts lw_filter_posts lists for the same author when paged to the end:
    the two use different backends with different inclusion rules (drafts, shortform,
    link-posts, unlisted/deleted, AF-vs-site scope), so they were never defined to match.

    Returns:
        str: Markdown user profile. Failures come back as tool errors.
    """
    return await http_client._get_markdown(site, f"/api/user/{slug}")


@lw_tool("lw_get_tag", "Get a tag / wiki page", not_found="tag", id_param="slug")
async def lw_get_tag(
    slug: Annotated[TagRef, Field(description="Tag slug, e.g. 'ai' or 'mesa-optimization': the <slug> in /w/<slug> or /api/tag/<slug>.")],
    site: SiteParam = "lesswrong",
) -> str:
    """Fetch a tag/wiki page as Markdown: the wiki article plus posts carrying the tag.

    Useful for orienting in a topic area (e.g. 'ai', 'mesa-optimization',
    'infra-bayesianism'). For precise tag filtering by date/karma/sort, use
    lw_filter_posts with tags=[<slug>].

    Returns:
        str: Markdown tag/wiki page. Failures come back as tool errors.
    """
    return await http_client._get_markdown(site, f"/api/tag/{slug}")


@lw_tool("lw_get_sequence", "Get a sequence (ordered post list)", not_found="sequence", id_param="sequence_id")
async def lw_get_sequence(
    sequence_id: Annotated[SequenceRef, Field(description="Sequence _id (17 characters, e.g. 'r9tYkB2a8Fp4DN8yB'; sequences have no slug): the <id> in /s/<id> or /api/sequence/<id>. Find one with lw_search(content_type='sequences').")],
    site: SiteParam = "lesswrong",
) -> str:
    """Fetch a sequence as Markdown: its title, author, description, and the ordered
    list of chapter posts (each linked as /api/post/<id>; pass the <id> to lw_get_post).

    Sequences are the site's curated, ordered reading lists. Posts carry sequence nav; this
    expands one into its full ordered post list.

    Returns:
        str: Markdown sequence page. Failures come back as tool errors.
    """
    return await http_client._get_markdown(site, f"/api/sequence/{sequence_id}")


@lw_tool("lw_list_feed", "List a front-page feed")
async def lw_list_feed(
    feed: Annotated[Feed, Field(description="Which feed: 'latest', 'recent', 'curated', or 'home'. 'home' is a fixed composite view and ignores 'limit'.")] = "latest",
    limit: Annotated[int, Field(description="Max posts to list. Max 100. Honoured by 'latest'/'recent'/'curated'; the 'home' composite ignores it.", ge=1, le=100)] = 20,
    site: SiteParam = "lesswrong",
) -> str:
    """List posts from a site feed ('latest', 'recent', 'curated', 'home') as Markdown.

    'latest', 'recent', and 'curated' are flat lists that honour `limit`. 'home' is a
    fixed composite page (spotlight + recently curated + recent + latest) and ignores
    `limit`; use one of the flat feeds when you need a specific count.

    Returns:
        str: Markdown feed. Failures come back as tool errors.
    """
    return await http_client._get_markdown(site, f"/api/{feed}", {"limit": limit})


# lw_filter_posts' date bounds take a calendar day spelled YYYY-MM-DD and nothing else.
_ISO_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def _iso_date(value: Any) -> Any:
    """Let only a 'YYYY-MM-DD' string (or a date) through to the date parser, which still
    rejects a day that doesn't exist. Pydantic's lax parsing would otherwise read a number as a
    Unix timestamp ('0' as 1970-01-01) and a midnight datetime as its day."""
    if isinstance(value, date) or (isinstance(value, str) and _ISO_DATE_RE.fullmatch(value)):
        return value
    raise ValueError("use an ISO date 'YYYY-MM-DD', e.g. '2023-01-01'")


_IsoDate = Annotated[date, BeforeValidator(_iso_date)]


# The one GraphQL query lw_filter_posts sends; _posts_selector builds its selector.
_POSTS_QUERY = (
    "query ($selector: PostSelector!, $limit: Int, $offset: Int) {"
    "  posts(selector: $selector, limit: $limit, offset: $offset) {"
    "    results { _id title slug pageUrl postedAt baseScore commentCount"
    "              user { displayName slug } }"
    "  }"
    "}"
)


class _Page(NamedTuple):
    """One page's paging signal. The field names and order are the JSON output's keys."""
    has_more: bool
    next_offset: int | None
    depth_limited: bool


def _posts_selector(
    sort: PostSort,
    *,
    author_id: str | None = None,
    tag_ids: Sequence[str] = (),
    after: date | None = None,
    before: date | None = None,
    min_karma: int | None = None,
    af: bool = False,
) -> dict[str, Any]:
    """The posts() selector: the view named by `sort`, with each filter as a term on it.

    Each distinct tag becomes a `filterSettings` Required tag — the mechanism the site's own
    tag pages use. Every sort view honours it and it composes with the other terms, so a tag
    combines cleanly with any sort. (The dedicated tagRelevance view ties a tag to its own
    ordering, so it can't serve an explicit sort.) Two distinct slugs can resolve to one tag,
    so the ids are deduplicated too. The selector treats `before` as an exclusive
    midnight-start bound, so it advances one day to be inclusive like `after`; date.max has no
    next day and nothing lies past it, so it bounds nothing.
    """
    terms: dict[str, Any] = {"sortedBy": sort}
    if author_id:
        terms["userId"] = author_id
    if tag_ids:
        terms["filterSettings"] = {
            "tags": [{"tagId": tid, "filterMode": "Required"} for tid in dict.fromkeys(tag_ids)]
        }
    if after is not None:
        terms["after"] = after.isoformat()
    if before is not None and before < date.max:
        terms["before"] = (before + timedelta(days=1)).isoformat()
    if min_karma is not None:
        terms["karmaThreshold"] = min_karma
    if af:
        terms["af"] = True
    return {sort: terms}


def _page_signal(fetched: int, limit: int, offset: int, *, exhausted: bool = False) -> _Page:
    """The paging signal for the page at `offset` whose limit+1 probe returned `fetched` rows.

    A surplus row means more posts exist server-side, unless `exhausted` says none of them can
    match (the caller knows the rest are filtered out). Whether the caller can reach them turns
    on offset alone: the backend caps skip at MAX_GRAPHQL_SKIP on the offset value itself (not
    offset+limit). Below the cap they are `has_more`, with the next page at
    min(offset+limit, cap) — near the cap that final page overlaps this one (de-dup by _id).
    At the cap they are `depth_limited`: unreachable, so narrow the filters. Keeping the two
    apart stops has_more=False from conflating "last page" with "hit the wall".
    """
    surplus = fetched > limit and not exhausted
    has_more = surplus and offset < MAX_GRAPHQL_SKIP
    next_offset = min(offset + limit, MAX_GRAPHQL_SKIP) if has_more else None
    return _Page(has_more, next_offset, depth_limited=surplus and not has_more)


def _post_row(p: dict[str, Any]) -> dict[str, Any]:
    """One posts() result as an output row (the JSON `posts` item)."""
    user = p.get("user") or {}
    return {
        "_id": p.get("_id"),
        "title": p.get("title"),
        "slug": p.get("slug"),
        "url": p.get("pageUrl"),
        "postedAt": p.get("postedAt"),
        "karma": p.get("baseScore"),
        "commentCount": p.get("commentCount"),
        "author": user.get("displayName"),
        "authorSlug": user.get("slug"),
    }


def _author_md(p: dict[str, Any], base: str) -> str:
    """A row's author: the display name linked to its /api/user route on `base`, since a slug
    often differs from the name and is what lw_get_user and lw_filter_posts take."""
    slug = p["authorSlug"]
    name = _md_inline(p["author"]) or _md_inline(slug) or "unknown"
    return f"[{name}]({base}/api/user/{quote(slug, safe='')})" if slug else name


def _render_posts(posts: list[dict[str, Any]], filters: str, page: _Page, base: str) -> str:
    """The Markdown listing: a header naming `filters`, one line per post linking its
    /api/post route and its author's /api/user route on `base`, and a footer carrying the same
    paging signal as the JSON."""
    if page.has_more:
        footer = f"\n\n---\n[More results — call again with offset={page.next_offset} to continue.]"
    elif page.depth_limited:
        footer = (
            f"\n\n---\n[More results exist but lie past the paging-depth cap (offset can't exceed "
            f"{MAX_GRAPHQL_SKIP}); narrow the filters (author/tag/date range/min_karma) to reach them.]"
        )
    else:
        footer = ""

    if not posts:
        # min_karma can empty this page while the server still has rows, so scope the lead to
        # "this page" rather than a flat — and, with a footer, contradictory — "nothing matched".
        lead = "No posts on this page matched those filters." if footer else "No posts matched those filters."
        return lead + footer

    lines = [f"# Filtered posts ({len(posts)}) — {filters}", ""]
    for p in posts:
        posted = (p["postedAt"] or "")[:10]
        link = f"{base}/api/post/{p['_id']}"
        title = _md_inline(p["title"])
        lines.append(
            f"- [{title}]({link}) — author: {_author_md(p, base)} | "
            f"karma: {p['karma']} | {posted} | comments: {p['commentCount']}"
        )
    return "\n".join(lines) + footer


@lw_tool("lw_filter_posts", "Filter posts by author/tag/date/karma")
async def lw_filter_posts(
    author: Annotated[UserRef | None, Field(description="Author's user slug, as lw_get_user takes it (the <slug> in /users/<slug> or /api/user/<slug>, or authorSlug in this tool's JSON). It often differs from the display name: find it with lw_search(content_type='users'). Restricts to that author.")] = None,
    tags: Annotated[TagsParam | None, Field(description=f"Tag slugs, as lw_get_tag takes them (the <slug> in /w/<slug> or /api/tag/<slug>), as a JSON array, e.g. [\"ai\", \"interpretability\"]: posts must carry all of them. At most {MAX_TAG_FILTERS}.")] = None,
    after: Annotated[_IsoDate | None, Field(description="Only posts on/after this date (a UTC day). ISO 'YYYY-MM-DD'.")] = None,
    before: Annotated[_IsoDate | None, Field(description="Only posts on/before this date (a UTC day). ISO 'YYYY-MM-DD'.")] = None,
    min_karma: Annotated[int | None, Field(description="Only posts with LessWrong karma (baseScore) >= this value, on either site. Range -100 to 100000.", ge=-100, le=100000)] = None,
    sort: Annotated[PostSort, Field(description="Sort order: 'top' (highest LessWrong karma), 'new' (newest first), 'old' (oldest first), 'magic' (the site's default 'hot' ranking), or 'recentComments' (most recently active discussions).")] = "top",
    alignment_forum_only: Annotated[bool, Field(description="If true, restrict to Alignment-Forum-promoted posts (af=true). Redundant on site='alignmentforum', which returns only those.")] = False,
    limit: Annotated[int, Field(description="Max posts to return. Max 100.", ge=1, le=100)] = 20,
    offset: Annotated[int, Field(description="Number of posts to skip (pagination). Max 2000.", ge=0, le=MAX_GRAPHQL_SKIP)] = 0,
    response_format: Annotated[ResponseFormat, Field(description="'markdown' (readable) or 'json' (structured).")] = "markdown",
    site: SiteParam = "lesswrong",
) -> str:
    """Precise, structured post filtering via GraphQL — the one thing full-text search
    can't do deterministically.

    Combine any of: author, tags, date range (after/before), minimum karma, and an
    explicit sort order. author and tags are slugs (resolved automatically); tags may
    hold several to require all of them at once (their intersection). Set
    alignment_forum_only=true to restrict to AF-promoted posts.

    On site='alignmentforum' every result is already an Alignment Forum post, so
    alignment_forum_only changes nothing there. Karma is LessWrong's score (baseScore) on
    either site: the `karma` field, min_karma and sort='top' all use it, never the separate
    Alignment Forum score (afBaseScore).

    `count` is the number of posts in this response — at most `limit`, after the min_karma
    filter — not a total, so don't compare it with a profile's "Posts:" figure (see
    lw_get_user).

    Returns:
        str: Markdown list (title linking /api/post/<id>, author linking /api/user/<slug>,
        karma, date, comments) or, with response_format='json', a JSON object:
        {
          "count": int,            # posts in this response (<= limit, after min_karma)
          "has_more": bool,        # a further page is fetchable — pass next_offset as offset
          "next_offset": int|null, # offset for the next page when has_more, else null
          "depth_limited": bool,   # true at the paging-depth cap (offset == 2000): more posts
                                   #   exist but no offset reaches them — narrow the filters
          "posts": [
            {"_id": str, "title": str, "slug": str, "url": str, "postedAt": str,
             "karma": int, "commentCount": int, "author": str|null, "authorSlug": str|null}
          ]
        }
        has_more, next_offset and depth_limited reflect the server's rows (before the min_karma
        safety-net filter), so count < limit does not by itself mean the last page; under
        sort='top' they end once the next post falls below min_karma. offset is capped at 2000,
        so near the cap next_offset clamps to 2000 and the final page overlaps the previous one
        — de-duplicate by _id when paging.
        Failures (e.g. an author/tag slug that matches nothing) come back as tool errors.
    """
    if after is not None and before is not None and after > before:
        raise ToolError(
            f"'after' ({after}) is later than 'before' ({before}), so no post can match. "
            "Swap them or widen the range."
        )

    # The posts must carry every tag given (their intersection). Each distinct tag costs a
    # resolution round-trip, so repeats are dropped, first-seen order kept, before any lookup;
    # the argument model already bounds the list to MAX_TAG_FILTERS items.
    distinct = list(dict.fromkeys(tags or ()))

    author_id: str | None = None
    if author:
        author_id = await _resolve_user_id(site, author)
        if not author_id:
            raise ToolError(f"no user found for author {author!r}. Pass a user slug. {FIND['user']}")

    tag_ids: list[str] = []
    for slug in distinct:
        tag_id = await _resolve_tag_id(site, slug)
        if not tag_id:
            raise ToolError(f"no tag found for {slug!r}. Pass a tag slug. {FIND['tag']}")
        tag_ids.append(tag_id)

    selector = _posts_selector(
        sort, author_id=author_id, tag_ids=tag_ids, after=after, before=before,
        min_karma=min_karma, af=alignment_forum_only,
    )
    # Over-fetch one row so has_more needs no second round-trip; trimmed off below. (The
    # posts view accepts limit > 100, so limit+1 is safe even at the max limit.)
    data = await http_client._graphql(site, _POSTS_QUERY, {"selector": selector, "limit": limit + 1, "offset": offset})
    results = (data.get("posts") or {}).get("results") or []
    # 'top' orders rows by descending baseScore, so once the surplus row is below min_karma no
    # later row can reach it, and the listing ends here although the server has more rows.
    exhausted = (
        sort == "top" and min_karma is not None and len(results) > limit
        and (results[limit].get("baseScore") or 0) < min_karma
    )
    page = _page_signal(len(results), limit, offset, exhausted=exhausted)
    posts = [_post_row(p) for p in results[:limit]]

    # ForumMagnum no-ops karmaThreshold == 0 (it bounds baseScore only for non-zero
    # thresholds), so min_karma=0 would let negative-karma posts through. Enforce the
    # documented ">= min_karma" contract for every value; a no-op when the server filtered.
    # `page` counts the server's rows, so it still signals further pages when this trims.
    if min_karma is not None:
        posts = [p for p in posts if (p["karma"] or 0) >= min_karma]

    if response_format == "json":
        return json.dumps({"count": len(posts), **page._asdict(), "posts": posts}, indent=2, ensure_ascii=False)
    # The header names each filter given, the author and tags by the slugs they resolved from,
    # then the sort.
    crumbs = (
        ("author", author),
        ("tags", ",".join(distinct) or None),
        ("after", after),
        ("before", before),
        ("min_karma", min_karma),
        ("alignment_forum_only", "true" if alignment_forum_only else None),
        ("sort", sort),
    )
    filters = ", ".join(f"{label}={value}" for label, value in crumbs if value is not None)
    return _render_posts(posts, filters, page, SITE_BASE_URLS[site])
