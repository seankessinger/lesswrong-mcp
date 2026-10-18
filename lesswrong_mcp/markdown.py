"""Pure text helpers: Markdown link-text escaping and inline character-slice paging for long
bodies. No network I/O.
"""
from __future__ import annotations

from mcp.server.mcpserver.exceptions import ToolError


def _md_inline(text: str | None) -> str:
    """Flatten a value to safe single-line Markdown link text, so a title like '[AN #80] ...'
    can't break the link. Only lw_filter_posts needs it; the /api/* routes escape upstream."""
    s = " ".join((text or "").split())
    return s.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _slice_markdown(text: str, offset: int, max_chars: int, *, label: str) -> str:
    """Return an inline character-slice so callers can bound the response size — a long post
    or comment thread can otherwise blow the token budget. `label` names the calling tool.

    A slice that stops short appends a footer with the exact `offset` to resume from; an
    offset past the end is a ToolError, since it is bad input rather than an empty page.
    """
    total = len(text)
    # Only a positive offset can land past the end; offset 0 on a short or empty body is the
    # first page, and returns it as-is rather than an error.
    if offset > 0 and offset >= total:
        raise ToolError(f"offset {offset} is past the end of the content ({total} characters).")
    end = min(offset + max_chars, total)
    # The body is exactly text[offset:end], so the reported next offset (`end`) resumes
    # with no dropped or duplicated characters and paged reads reconstruct the content
    # byte-for-byte.
    chunk = text[offset:end]
    notes = []
    if offset > 0:
        notes.append(f"continues from character {offset}")
    if end < total:
        notes.append(f"truncated at {end} of {total} characters — call again with offset={end} to continue")
    if notes:
        chunk = chunk + f"\n\n---\n[{label}: {'; '.join(notes)}.]"
    return chunk
