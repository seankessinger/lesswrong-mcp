"""The five read-only tools. Importing this module registers them on `server.mcp`.

Each tool checks its input, fetches through `forum`, and renders through `render`. Network
failures reach the client through the server's funnel; a lookup that finds nothing raises its
kind's miss.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Annotated, Any, Literal

import httpx
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import Field, StringConstraints

from lesswrong_mcp import forum
from lesswrong_mcp.render import comment_item, post_row, search_page, sequence, slice_text, thread
from lesswrong_mcp.server import (
    FIND, MAX_CHARS, CommentId, IsoDate, Kind, MaxChars, Offset, PostId, SequenceId, TagSlugs, UserSlug, miss,
    tool,
)

# The forum's view limit for one thread read: high enough that every thread comes back whole
# (checked live: 731 comments in one call).
THREAD_LIMIT = 5000


@tool("lw_get_post", "Read a post")
async def lw_get_post(post_id: PostId, max_chars: MaxChars = MAX_CHARS, offset: Offset = 0) -> str:
    """Read one post: its full body and metadata, as the forum's own Markdown.

    The header gives author, date, karma, tags and links. Its links name the post by slug; the
    post's id is the <id> in its "Post URL (HTML)" /posts/<id>/<slug>. The Markdown carries no
    Alignment Forum status: lw_search and lw_filter_posts mark AF posts.

    A post longer than max_chars ends with a footer giving the offset to call again with, so a
    long post is read whole across calls.
    """
    try:
        md = await forum.markdown(f"/api/post/{post_id}")
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            raise miss("post", post_id) from exc
        raise
    return slice_text(md, offset, max_chars, label="lw_get_post")


_COMMENT_FIELDS = (
    "fragment C on Comment { _id postId parentCommentId answer af deleted baseScore postedAt "
    "extendedScore user { displayName slug } contents { markdown } }"
)
_THREAD_QUERY = _COMMENT_FIELDS + (
    " query Thread($id: String, $answers: CommentSelector, $comments: CommentSelector) {"
    " post(input: {selector: {_id: $id}, allowNull: true}) { result { _id title question commentCount } }"
    f" answers: comments(selector: $answers, limit: {THREAD_LIMIT}) {{ results {{ ...C }} }}"
    f" comments: comments(selector: $comments, limit: {THREAD_LIMIT}) {{ results {{ ...C }} }} }}"
)
_ONE_QUERY = _COMMENT_FIELDS + (
    " query One($id: String) { comment(input: {selector: {_id: $id}, allowNull: true}) { result { ...C } } }"
)
_THREAD_VIEW = {"top": "postCommentsTop", "new": "postCommentsNew", "old": "postCommentsOld"}


@tool("lw_get_comments", "Read a post's discussion, or one comment")
async def lw_get_comments(
    post_id: PostId,
    comment_id: Annotated[CommentId | None, Field(description="Read just this comment (with a line naming the comment it replies to) instead of the whole discussion.")] = None,
    sort: Annotated[Literal["top", "new", "old"], Field(description="Order of the top-level items: 'top' (karma), 'new' or 'old'. Replies always follow their parent.")] = "top",
    max_chars: MaxChars = MAX_CHARS,
    offset: Offset = 0,
) -> str:
    """Read a post's whole discussion, or one comment.

    The discussion is always complete. On a question post, the answers come first, each followed
    by its replies, then the ordinary comments. Every item has a one-line header: its id link,
    author name (slug), date, karma, agreement score where the forum has one, AF when it is on
    the Alignment Forum, and "reply to <id>" for a reply. Replies follow their parent; a reply
    whose parent the forum hides appears at the top level, still naming its parent.

    A long discussion ends with a footer giving the offset to call again with, so it is read
    whole across calls.
    """
    if comment_id is not None:
        data = await forum.graphql(_ONE_QUERY, {"id": comment_id})
        found = (data.get("comment") or {}).get("result")
        if not found:
            raise miss("comment", comment_id)
        if found.get("postId") != post_id:
            raise ToolError(
                f"comment {comment_id!r} is not on post {post_id!r}; it is on post "
                f"{found.get('postId')!r}. {FIND['comment']}"
            )
        return slice_text(comment_item(found, post_id), offset, max_chars, label="lw_get_comments")
    data = await forum.graphql(_THREAD_QUERY, {
        "id": post_id,
        "answers": {"answersAndReplies": {"postId": post_id}},
        "comments": {_THREAD_VIEW[sort]: {"postId": post_id}},
    })
    post = (data.get("post") or {}).get("result")
    if not post:
        raise miss("post", post_id)
    answers = (data.get("answers") or {}).get("results") or []
    # The answers view has one fixed order, so the answers follow `sort` here, as the comments
    # view does upstream; a stable sort keeps the view's order among equals.
    if sort == "top":
        answers.sort(key=lambda c: -(c.get("baseScore") or 0))
    else:
        answers.sort(key=lambda c: c.get("postedAt") or "", reverse=sort == "new")
    comments = (data.get("comments") or {}).get("results") or []
    limit_hit = THREAD_LIMIT in (len(answers), len(comments))
    return slice_text(thread(post, answers, comments, limit_hit=limit_hit), offset, max_chars, label="lw_get_comments")


SearchKind = Literal["posts", "comments", "tags", "users", "sequences"]
_KINDS: tuple[SearchKind, ...] = ("posts", "comments", "tags", "users", "sequences")
_SORT_SUFFIX = {"relevance": "", "newest": "_newest_first", "oldest": "_oldest_first", "karma": "_karma"}
# The search index serves only the first 10,000 hits; a deeper page is a deterministic error.
SEARCH_WINDOW = 10_000
_SLUG_QUERY = "query ($id: String) { post(input: {selector: {_id: $id}, allowNull: true}) { result { slug } } }"


def _day_ms(d: date) -> int:
    """Midnight UTC at the start of `d`, in milliseconds (the index's publicDateMs)."""
    return int(datetime.combine(d, time(0), tzinfo=timezone.utc).timestamp() * 1000)


def _check_dates(after: date | None, before: date | None) -> None:
    if after is not None and before is not None and after > before:
        raise ToolError(f"after ({after}) is later than before ({before}); no day matches.")


@tool("lw_search", "Search LessWrong and the Alignment Forum")
async def lw_search(
    query: Annotated[str, StringConstraints(strip_whitespace=True), Field(min_length=2, max_length=300, description='Search text. "An exact phrase" in double quotes must appear as written; -word excludes a word.')],
    types: Annotated[list[SearchKind] | None, Field(min_length=1, max_length=5, description="Kinds to search: posts, comments, tags, users, sequences. Omit for all five.")] = None,
    sort: Annotated[Literal["relevance", "newest", "oldest", "karma"], Field(description="Order of posts and comments. 'oldest' finds the earliest. Tags, users and sequences always come in relevance order.")] = "relevance",
    after: Annotated[IsoDate | None, Field(description="Posts and comments from this day on (YYYY-MM-DD).")] = None,
    before: Annotated[IsoDate | None, Field(description="Posts and comments up to and including this day (YYYY-MM-DD).")] = None,
    af_only: Annotated[bool, Field(description="Only Alignment Forum posts and comments.")] = False,
    in_post: Annotated[PostId | None, Field(description="Search only the comments on this post, to find a point in a long discussion without reading all of it.")] = None,
    limit: Annotated[int, Field(ge=1, le=20, description="Results per kind, at most 20.")] = 10,
    page: Annotated[int, Field(ge=1, le=1000, description="1-based page; page × limit may not pass 10,000.")] = 1,
) -> str:
    """Search LessWrong and the Alignment Forum: posts, comments, tags, users and sequences.

    The search is by keyword, so try several phrasings for an idea that goes by different names.
    Each result links the value the other tools take: a post's /api/post/<id>, a comment's
    /api/post/<post>/comments/<cid>, a user's /users/<slug>, a tag's /w/<slug>, a sequence's
    /s/<id>. Posts and comments on the Alignment Forum are marked AF.

    sort="oldest" orders by publication date. An old post can be edited later to add a phrase,
    so read the earliest hit's text before crediting it with being first.
    """
    _check_dates(after, before)
    if page * limit > SEARCH_WINDOW:
        raise ToolError(f"search serves only the first {SEARCH_WINDOW:,} results (page × limit ≤ {SEARCH_WINDOW:,}). Lower page or limit.")
    if in_post is not None:
        if types not in (None, ["comments"]):
            raise ToolError('in_post searches one post\'s comments; pass types=["comments"] or omit types.')
        types = ["comments"]
    kinds = [k for k in _KINDS if types is None or k in types]
    dated = sort != "relevance" or after is not None or before is not None or af_only
    if dated and not {"posts", "comments"} & set(kinds):
        raise ToolError("sort, after, before and af_only apply to posts or comments; include one of them in types.")

    notes = []
    facets: list[list[str]] = [["af:true"]] if af_only else []
    if in_post is not None:
        data = await forum.graphql(_SLUG_QUERY, {"id": in_post})
        found = (data.get("post") or {}).get("result")
        if not found:
            raise miss("post", in_post)
        facets.append([f"postSlug:{found['slug']}"])
        notes.append(f"Comments on post {in_post} only; the total counts every comment on posts with its slug.")
    # The index ORs several filters on one field, so a range's two bounds go on two fields that
    # hold the same instant (checked live): the lower on publicDateMs, the upper on postedAt.
    numeric = []
    if after is not None:
        numeric.append(f"publicDateMs>={_day_ms(after)}")
    if before is not None and before < date.max:  # date.max has no next day, and bounds nothing
        numeric.append(f"postedAt<{_day_ms(before + timedelta(days=1))}")
    if sort != "relevance":
        notes.append(f"Sort: {sort} (posts and comments).")
    if numeric or af_only:
        span = f"{after or 'any day'} to {before or 'today'}"
        notes.append(f"Posts and comments only from {span}" + (", Alignment Forum only." if af_only else "."))

    queries = []
    for kind in kinds:
        params: dict[str, Any] = {"query": query, "hitsPerPage": limit, "page": page - 1}
        index: str = kind
        if kind in ("posts", "comments"):
            index += _SORT_SUFFIX[sort]
            if facets:
                params["facetFilters"] = facets
            if numeric:
                params["numericFilters"] = numeric
        queries.append({"indexName": index, "params": params})
    results = await forum.search(queries)

    sections: list[tuple[str, int, list[dict[str, Any]]]] = []
    for kind, result in zip(kinds, results):
        hits = result.get("hits") or []
        if in_post is not None:
            hits = [h for h in hits if h.get("postId") == in_post]
        sections.append((kind, int(result.get("nbHits") or 0), hits))
    more = any(total > page * limit for _, total, _ in sections)
    next_page = page + 1 if more and page < 1000 and (page + 1) * limit <= SEARCH_WINDOW else None
    return search_page(query, notes, sections, next_page=next_page)


# The forum's posts view caps skip at this value (offset itself, not offset + limit).
MAX_SKIP = 2000
_POST_FIELDS = "_id title postedAt baseScore commentCount af user { displayName slug }"
_POSTS_QUERY = (
    "query ($s: PostSelector!, $limit: Int, $offset: Int) {"
    f" posts(selector: $s, limit: $limit, offset: $offset, enableTotal: true) {{ totalCount results {{ {_POST_FIELDS} }} }} }}"
)
_BACKLINKS_QUERY = (
    "query ($s: PostSelector!, $limit: Int, $offset: Int, $target: String) {"
    " target: post(input: {selector: {_id: $target}, allowNull: true}) { result { _id } }"
    f" posts(selector: $s, limit: $limit, offset: $offset, enableTotal: true) {{ totalCount results {{ {_POST_FIELDS} }} }} }}"
)
_SLUG_LOOKUP = {
    "user": ("users", "UserSelector!", "usersProfile"),
    "tag": ("tags", "TagSelector!", "tagBySlug"),
}


async def _resolve(kind: Kind, slug: str) -> str:
    """A user or tag slug's _id. The value is looked up as a slug and nothing else."""
    field, selector_type, view = _SLUG_LOOKUP[kind]
    query = f"query ($s: {selector_type}) {{ {field}(selector: $s, limit: 1) {{ results {{ _id }} }} }}"
    data = await forum.graphql(query, {"s": {view: {"slug": slug}}})
    results = (data.get(field) or {}).get("results") or []
    if not results:
        raise miss(kind, slug)
    return results[0]["_id"]


@tool("lw_filter_posts", "List posts by author, tag, date and karma, or a post's backlinks")
async def lw_filter_posts(
    author: Annotated[UserSlug | None, Field(description="Only this author's posts. A user slug often differs from the display name: find it with lw_search(types=[\"users\"]).")] = None,
    tags: Annotated[TagSlugs | None, Field(description="Only posts carrying all of these tags (tag slugs, at most 10).")] = None,
    after: Annotated[IsoDate | None, Field(description="Posts from this day on (YYYY-MM-DD).")] = None,
    before: Annotated[IsoDate | None, Field(description="Posts up to and including this day (YYYY-MM-DD).")] = None,
    min_karma: Annotated[int | None, Field(ge=-100, le=100_000, description="Only posts with at least this LessWrong karma.")] = None,
    af_only: Annotated[bool, Field(description="Only Alignment Forum posts.")] = False,
    sort: Annotated[Literal["top", "new", "old"] | None, Field(description="'top' (karma, the default), 'new' (newest first) or 'old' (oldest first).")] = None,
    links_to: Annotated[PostId | None, Field(description="List the posts that link to this post (its backlinks), with the filters above. Backlinks come in karma order only.")] = None,
    limit: Annotated[int, Field(ge=1, le=100, description="Posts per page, at most 100.")] = 20,
    offset: Annotated[int, Field(ge=0, le=MAX_SKIP, description=f"Posts to skip, at most {MAX_SKIP}: the offset a previous page's footer gave.")] = 0,
) -> str:
    """List posts precisely: by author, tags, date range, karma and Alignment Forum status, in a
    stated order; or, with links_to, the posts that link to a given post.

    Karma is LessWrong karma on both forums. A tag listing is neither complete nor clean: authors
    tag unevenly, so a search can find posts a tag misses.

    Backlinks trace what came after a post: responses, critiques and follow-ups usually link to
    what they answer, even when their titles don't say so. They count only post-to-post links
    (not comments) and include roundups and newsletters, so read a candidate before calling it
    a response.
    """
    _check_dates(after, before)
    if links_to is not None and sort in ("new", "old"):
        raise ToolError('backlinks come in karma order only; omit sort or pass sort="top".')
    order = sort or "top"
    terms: dict[str, Any] = {} if links_to is not None else {"sortedBy": order}
    filters = [] if links_to is None else [f"links to {links_to}"]
    if author is not None:
        terms["userId"] = await _resolve("user", author)
        filters.append(f"author={author}")
    if tags:
        unique = list(dict.fromkeys(tags))
        terms["filterSettings"] = {"tags": [{"tagId": await _resolve("tag", t), "filterMode": "Required"} for t in unique]}
        filters.append("tags=" + ",".join(unique))
    if after is not None:
        terms["after"] = after.isoformat()
    if before is not None and before < date.max:  # date.max has no next day, and bounds nothing
        terms["before"] = (before + timedelta(days=1)).isoformat()
    if after is not None or before is not None:
        filters.append(f"{after or 'any day'} to {before or 'today'}")
    if min_karma is not None:
        terms["karmaThreshold"] = min_karma
        filters.append(f"karma ≥ {min_karma}")
    if af_only:
        terms["af"] = True
        filters.append("Alignment Forum only")
    filters.append(f"sort={order}")

    variables: dict[str, Any] = {"limit": limit + 1, "offset": offset}
    if links_to is None:
        data = await forum.graphql(_POSTS_QUERY, {"s": {order: terms}, **variables})
    else:
        data = await forum.graphql(_BACKLINKS_QUERY, {"s": {"pingbackPosts": {**terms, "postId": links_to}}, **variables, "target": links_to})
        if not (data.get("target") or {}).get("result"):
            raise miss("post", links_to)
    block = data.get("posts") or {}
    fetched = block.get("results") or []
    surplus = len(fetched) > limit
    # The forum counts the whole selector only when the page comes back full; otherwise its
    # total is just this page's rows.
    total = block.get("totalCount") if surplus else offset + len(fetched)
    rows = [p for p in fetched[:limit] if min_karma is None or (p.get("baseScore") or 0) >= min_karma]
    if links_to is not None:
        filters[0] += f" — {total} total"
    if surplus and offset < MAX_SKIP:
        footer = f"\n\n---\n[More: call again with offset={min(offset + limit, MAX_SKIP)}.]"
    elif surplus:
        footer = f"\n\n---\n[More posts exist past the paging cap (offset {MAX_SKIP}); narrow the filters to reach them.]"
    else:
        footer = ""
    if not rows:
        return "No posts matched those filters." + footer
    return "\n".join([f"# Posts ({len(rows)}) — " + "; ".join(filters), ""] + [post_row(p) for p in rows]) + footer


_SEQUENCE_QUERY = (
    "query ($id: String) { sequence(input: {selector: {_id: $id}, allowNull: true}) { result {"
    " _id title user { displayName slug } contents { markdown }"
    f" chapters {{ title number posts {{ {_POST_FIELDS} }} }} }} }} }}"
)


@tool("lw_get_sequence", "Read a sequence")
async def lw_get_sequence(sequence_id: SequenceId, max_chars: MaxChars = MAX_CHARS, offset: Offset = 0) -> str:
    """Read a sequence (a series of posts) in order: its title, author and description, then
    every post, numbered, under its chapter's title. Each post links its /api/post/<id>, for
    lw_get_post; Alignment Forum posts are marked AF.
    """
    data = await forum.graphql(_SEQUENCE_QUERY, {"id": sequence_id})
    found = (data.get("sequence") or {}).get("result")
    if not found:
        raise miss("sequence", sequence_id)
    return slice_text(sequence(found), offset, max_chars, label="lw_get_sequence")
