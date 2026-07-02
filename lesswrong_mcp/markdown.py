"""Pure text and reference helpers: uniform error strings, inline character-slice paging for
long bodies, and URL/path -> bare id/slug normalisation. No network I/O.
"""
from __future__ import annotations

from urllib.parse import quote

import httpx

from lesswrong_mcp.config import _ID_RE


def _handle_error(exc: Exception, *, not_found: str | None = None, bad_value: str | None = None) -> str:
    """Uniform, actionable error strings for tool returns.

    For a 404, `not_found` names what was looked up and `bad_value` echoes the caller's
    identifier, so the message points at the offending input rather than a generic 404.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code == 404:
            if not_found:
                target = f" for {bad_value!r}" if bad_value else ""
                # Tag/user lookups are the ones testers hit with a display name ('Cleo
                # Nardo', 'Mesa-Optimization') instead of the slug, so nudge toward the
                # slug form; the hint is empty when the value already looks like a slug/_id.
                hint = _slug_hint(bad_value) if not_found in ("user", "tag") else ""
                return (
                    f"Error: no {not_found} found{target} (404). "
                    f"Pass a valid {not_found} _id or slug.{hint}"
                )
            return "Error: Not found (404). Double-check the post id / user slug / tag slug."
        if code == 406:
            return "Error: No Markdown version exists for that route (406)."
        if code == 429:
            return "Error: Rate limited (429) even after retries. Wait a bit and try again."
        return f"Error: Forum API returned HTTP {code}."
    if isinstance(exc, httpx.TimeoutException):
        return "Error: Request timed out after retries. Try again."
    # TimeoutException is itself a TransportError, so it is handled above; any *other*
    # transport failure (ConnectError, ReadError, RemoteProtocolError, ...) gets a generic
    # message rather than leaking an httpx class name through the catch-all below.
    if isinstance(exc, httpx.TransportError):
        return "Error: Could not reach the forum API (network error). Try again."
    if isinstance(exc, RuntimeError):
        return f"Error: {exc}"
    return f"Error: {type(exc).__name__}: {exc}"


def _slug_hint(value: str | None) -> str:
    """A one-line nudge (or '') for a lookup that looks like it was given a display name.

    Slugs are lowercase-hyphenated, but the tools surface display names ('Cleo Nardo') that a
    caller pastes straight back — which 404s. Fires on a space or any uppercase, excluding a
    raw 17-char _id (legitimately mixed-case). Returns '' otherwise, so callers append it
    unconditionally.
    """
    if not value or _ID_RE.match(value):
        return ""
    if "/" in value:
        # A pasted URL or /path (an accepted input form for the tag/user/post/... tools) is
        # not a display name, and the extractors already reduce it to a slug — so don't
        # mislabel it or derive a bogus lowercased-URL "example slug" from it.
        return ""
    if " " in value or value != value.lower():
        example = "-".join(value.lower().split())
        return (
            f" — that looks like a display name; pass the URL slug instead "
            f"(lowercase, hyphenated, e.g. {example!r})."
        )
    return ""


def _md_inline(text: str | None) -> str:
    """Flatten a value to safe single-line Markdown link text, so a title like '[AN #80] ...'
    can't break the link. Only lw_filter_posts needs it; the /api/* routes escape upstream."""
    s = " ".join((text or "").split())
    return s.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _slice_markdown(text: str, offset: int, max_chars: int | None, *, label: str = "lw_get_post") -> str:
    """Return an inline character-slice so callers can bound the response size — a long post
    or comment thread can otherwise blow the token budget. `label` names the calling tool.

    A no-op when offset == 0 and max_chars is None, so uncapped output is untouched. A slice
    that stops short appends a footer with the exact `offset` to resume from.
    """
    if offset == 0 and max_chars is None:
        return text
    total = len(text)
    # Only a positive offset can land past the end; offset 0 on a short/empty body is
    # a legitimate "give me the whole thing" and must return it as-is, not an error.
    if offset > 0 and offset >= total:
        return f"[{label}: offset {offset} is past the end of the content ({total} characters).]"
    end = total if max_chars is None else min(offset + max_chars, total)
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


def _extract_ref(value: str, markers: tuple[str, ...]) -> str:
    """Normalise a reference to the bare _id/slug an /api/* route expects.

    Forgivingly pulls the id out of a full URL or a `/<marker>/<id>/<slug>` path — the kind
    of value a model pastes from a search result. Real slugs are single path segments, so a
    bare slug/_id is never altered.
    """
    v = value.strip()
    if "://" in v:  # a full URL was passed; drop scheme + host, keep the path
        v = httpx.URL(v).path
    if "/" in v:
        parts = [p for p in v.split("/") if p]
        for marker in markers:
            if marker in parts:
                i = parts.index(marker)
                if i + 1 < len(parts):
                    return parts[i + 1]
        if parts:
            return parts[-1]
    return v


def _seg(ref: str) -> str:
    """Percent-encode a value as one URL path segment, so a stray space or slash in an
    id/slug can't split the /api/* route or smuggle in extra segments."""
    return quote(ref, safe="")


def _extract_post_ref(value: str) -> str:
    """Bare _id/slug for the /api/post route (accepts a URL or /posts/<id>/<slug> path)."""
    return _extract_ref(value, ("post", "posts"))


def _extract_sequence_ref(value: str) -> str:
    """Bare _id/slug for the /api/sequence route (accepts a URL or /s/<id> path)."""
    return _extract_ref(value, ("sequence", "s"))


def _extract_tag_ref(value: str) -> str:
    """Bare slug/_id for the /api/tag route (accepts a URL or /w/<slug> or /tag/<slug> path)."""
    return _extract_ref(value, ("tag", "w"))


def _extract_user_ref(value: str) -> str:
    """Bare slug/_id for the /api/user route (accepts a URL or /users/<slug> path)."""
    return _extract_ref(value, ("user", "users"))
