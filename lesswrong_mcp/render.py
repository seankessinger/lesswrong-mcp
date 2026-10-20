"""Pure renderers: forum JSON in, Markdown out. No I/O.

Everything rendered here links what it mentions by the value the tools take (a post by
/api/post/<id>, a comment by /api/post/<post>/comments/<id>, a user by /users/<slug>, a tag by
/w/<slug>, a sequence by /s/<id>), names every user as "Name (slug)", and marks Alignment Forum
items "AF".
"""
from __future__ import annotations

import html
import re
from html.entities import html5
from typing import Any

from mcp.server.mcpserver.exceptions import ToolError

# The host links point at. forum.BASE is the host requests go to; it is the same site.
SITE = "https://www.lesswrong.com"
SNIPPET_CHARS = 300
# Something shaped like a character reference. html.unescape alone would also decode the start
# of plain text that begins like one, such as "&copy" in a query string or "&para" in "&params;".
_ENTITY = re.compile(r"&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);")


def md_inline(text: str | None) -> str:
    """Flatten a value to single-line Markdown link text, escaping what would break a link
    (a title like '[AN #80] ...')."""
    s = " ".join((text or "").split())
    return s.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def user_label(user: dict[str, Any] | None) -> str:
    """'Display Name (slug)': the name a reader knows, and the slug the tools take."""
    if not user or not (user.get("displayName") or user.get("slug")):
        return "[deleted account]"
    name = md_inline(user.get("displayName") or user.get("slug"))
    return f"{name} ({user['slug']})" if user.get("slug") else name


def day(iso: Any) -> str:
    """The UTC day of an ISO timestamp; anything else reads "undated"."""
    return iso[:10] if isinstance(iso, str) and iso else "undated"


def af_mark(item: dict[str, Any]) -> str:
    return " · AF" if item.get("af") else ""


def post_row(p: dict[str, Any]) -> str:
    """One listing row for a GraphQL post."""
    title = md_inline(p.get("title")) or "(untitled)"
    return (
        f"- [{title}]({SITE}/api/post/{p['_id']}) — {user_label(p.get('user'))} · "
        f"karma {p.get('baseScore') or 0} · {day(p.get('postedAt'))} · "
        f"{p.get('commentCount') or 0} comments{af_mark(p)}"
    )


def _decode(ref: re.Match[str]) -> str:
    """A numeric reference, or a named one HTML defines, decoded; anything else as written."""
    return html.unescape(ref[0]) if ref[0][1] == "#" or ref[0][1:] in html5 else ref[0]


def _snippet(hit: dict[str, Any], field: str, fallback: str | None = None) -> str:
    """The hit's highlighted snippet as plain text, trimmed to SNIPPET_CHARS. The index marks
    matches with <em> tags, even inside a word or an entity, so only those go, and nothing
    takes their place; any other angle bracket is the text's own. Then each character reference
    HTML defines is decoded."""
    raw = ((hit.get("_snippetResult") or {}).get(field) or {}).get("value") or fallback or ""
    text = _ENTITY.sub(_decode, re.sub(r"</?em>", "", raw))
    text = " ".join(text.split())
    return text if len(text) <= SNIPPET_CHARS else text[:SNIPPET_CHARS].rstrip() + "…"


def hit_line(kind: str, hit: dict[str, Any]) -> str:
    """One search hit, by kind, with its snippet on a second line when it has one."""
    author = user_label({"displayName": hit.get("authorDisplayName"), "slug": hit.get("authorSlug")})
    snippet = ""
    if kind == "posts":
        line = (
            f"- [{md_inline(hit.get('title')) or '(untitled)'}]({SITE}/api/post/{hit['_id']}) — {author} · "
            f"karma {hit.get('baseScore') or 0} · {day(hit.get('postedAt'))}{af_mark(hit)}"
        )
        snippet = _snippet(hit, "body")
    elif kind == "comments":
        cid, post_id = hit["_id"], hit.get("postId")
        if post_id:
            where = (f"[{cid}]({SITE}/api/post/{post_id}/comments/{cid}) by {author} on "
                     f"[{md_inline(hit.get('postTitle')) or '(untitled)'}]({SITE}/api/post/{post_id})")
        else:  # a comment on a tag page: no tool reads those, so there is no fetch link
            tag = hit.get("tagSlug")
            where = f"{cid} by {author} on " + (f"tag [{md_inline(tag)}]({SITE}/w/{tag})" if tag else "a tag page")
        line = f"- Comment {where} · karma {hit.get('baseScore') or 0} · {day(hit.get('postedAt'))}{af_mark(hit)}"
        snippet = _snippet(hit, "body")
    elif kind == "tags":
        name = md_inline(hit.get("name"))
        line = f"- [{name}]({SITE}/w/{hit['slug']})" if hit.get("slug") else f"- {name}"
        snippet = _snippet(hit, "description")
    elif kind == "users":
        name = md_inline(hit.get("displayName") or hit.get("slug"))
        link = f"[{name}]({SITE}/users/{hit['slug']})" if hit.get("slug") else name
        line = f"- {link} · karma {hit.get('karma') or 0}"
    else:  # sequences
        line = f"- [{md_inline(hit.get('title')) or '(untitled)'}]({SITE}/s/{hit['_id']})"
        snippet = _snippet(hit, "plaintextDescription", hit.get("plaintextDescription"))
    return f"{line}\n  snippet: {snippet}" if snippet else line


def search_page(query: str, notes: list[str], sections: list[tuple[str, int, list[dict[str, Any]]]], *, next_page: int | None) -> str:
    """A search results page: the query, notes on the filters, one section per kind with the
    forum's total, and a next-page footer while results remain."""
    out = [f"# Search: {md_inline(query)}", ""] + [f"- {note}" for note in notes]
    for kind, total, hits in sections:
        out += ["", f"## {kind.title()} ({total} total)", ""]
        out += [hit_line(kind, hit) for hit in hits] or ["_No results._"]
    if next_page is not None:
        out += ["", "---", f"[Next page: call again with page={next_page}.]"]
    return "\n".join(out)


def comment_item(c: dict[str, Any], post_id: str) -> str:
    """One comment: a header line (link, author, day, karma, agreement, AF, parent), then its
    Markdown body."""
    agreement = (c.get("extendedScore") or {}).get("agreement")
    deleted = bool(c.get("deleted"))
    author = "[deleted]" if deleted and not c.get("user") else user_label(c.get("user"))
    header = (
        f"### [{c['_id']}]({SITE}/api/post/{post_id}/comments/{c['_id']}) {author} · "
        f"{day(c.get('postedAt'))} · karma {c.get('baseScore') or 0}"
        + (f" · agree {agreement}" if agreement is not None else "")
        + af_mark(c)
        + (f" · reply to {c['parentCommentId']}" if c.get("parentCommentId") else "")
    )
    # The forum keeps a publicly deleted comment in the thread; show that it was there, not its text.
    body = "" if deleted else ((c.get("contents") or {}).get("markdown") or "").strip()
    return f"{header}\n\n{body or '[deleted]'}"


def _depth_first(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Items in depth-first order, so every reply follows its parent. An item whose parent is
    not among `items` (the forum hides some comments but returns their replies) is a root, so
    nothing returned is dropped. Roots and siblings keep the view's order. Iterative, so a deep
    thread can't hit the recursion limit."""
    ids = {c["_id"] for c in items}
    children: dict[str, list[dict[str, Any]]] = {}
    roots = []
    for c in items:
        parent = c.get("parentCommentId")
        if parent and parent in ids:
            children.setdefault(parent, []).append(c)
        else:
            roots.append(c)
    ordered, stack = [], list(reversed(roots))
    while stack:
        c = stack.pop()
        ordered.append(c)
        stack.extend(reversed(children.get(c["_id"], [])))
    return ordered


def thread(post: dict[str, Any], answers: list[dict[str, Any]], comments: list[dict[str, Any]], *, limit_hit: bool) -> str:
    """A post's whole discussion: answers (on question posts) first, then comments, each
    section depth-first."""
    n_answers = sum(1 for c in answers if c.get("answer"))
    counts = f"Comments: {len(comments)}"
    if answers:
        counts = f"Answers: {n_answers} (+{len(answers) - n_answers} replies) · " + counts
    state = (f"showing the first {len(answers) + len(comments)}; the thread may be longer"
             if limit_hit else "complete")
    out = [f"# Comments on [{md_inline(post.get('title')) or '(untitled)'}]({SITE}/api/post/{post['_id']})",
           "", f"{counts} · {state}"]
    for title, items in (("Answers", answers), ("Comments", comments)):
        if items:
            out += ["", f"## {title}"]
            out += [f"\n{comment_item(c, post['_id'])}" for c in _depth_first(items)]
    if not answers and not comments:
        out += ["", "No comments yet."]
    return "\n".join(out)


def sequence(seq: dict[str, Any]) -> str:
    """A sequence: title, author and description, then its posts in order, numbered across
    chapters in the order of their `number`, under each chapter's title where it has one."""
    out = [f"# {md_inline(seq.get('title')) or '(untitled)'}", "", f"by {user_label(seq.get('user'))}"]
    description = ((seq.get("contents") or {}).get("markdown") or "").strip()
    if description:
        out += ["", description]
    n = 0
    chapters = [c for c in seq.get("chapters") or [] if c]
    # A chapter without a number (an untitled preface) comes first, as on the forum; the sort
    # keeps the response's order among equals.
    for chapter in sorted(chapters, key=lambda c: (c.get("number") is not None, c.get("number") or 0)):
        out.append("")
        if chapter.get("title"):
            out += [f"## {md_inline(chapter['title'])}", ""]
        for p in chapter.get("posts") or []:
            if p:
                n += 1
                out.append(f"{n}. {post_row(p)[2:]}")
    return "\n".join(out)


def slice_text(text: str, offset: int, max_chars: int, *, label: str) -> str:
    """A character slice of `text`, so a long post or thread fits the host's result limit. A
    slice that stops short ends with the exact offset to resume from; an offset past the end is
    a ToolError, since it is bad input rather than an empty page."""
    total = len(text)
    if offset > 0 and offset >= total:
        raise ToolError(f"offset {offset} is past the end of the content ({total} characters).")
    end = min(offset + max_chars, total)
    chunk = text[offset:end]
    notes = []
    if offset > 0:
        notes.append(f"continues from character {offset}")
    if end < total:
        notes.append(f"truncated at {end} of {total} characters — call again with offset={end} to continue")
    if notes:
        chunk += f"\n\n---\n[{label}: {'; '.join(notes)}.]"
    return chunk
