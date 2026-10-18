"""Anticipated-failure types and the user-facing messages the tools report for them, including
the advice that says where each kind of identifier comes from.

Messages carry no "Error" lead-in: MCPServer already renders a tool error as
"Error executing tool <name>: <message>".
"""
from __future__ import annotations

from typing import Literal

import httpx


class ForumAPIError(Exception):
    """An anticipated forum/API failure whose str() is a user-facing message (GraphQL
    errors[], a malformed GraphQL body, a refused redirect)."""


# The kinds of identifier a tool takes.
Kind = Literal["post", "comment", "user", "tag", "sequence"]

# Where each kind of value comes from. A value that is not an identifier (SHAPE) and a lookup
# that finds nothing (the miss messages) both end with the same sentence, so each piece of
# advice is written once. Nothing is guessed from the value: a user slug comes from the
# username, not the display name, and a popular name is held by several accounts, so a slug
# derived from a name can name the wrong person. Each sentence points to the search or link
# that shows the real value instead.
FIND: dict[Kind, str] = {
    "post": "Find posts with lw_search; each result links /api/post/<id>.",
    "comment": (
        "It is the <cid> in /api/post/<post>/comments/<cid>, or in a pasted link the <cid> "
        "after /comment/, in ?commentId=<cid>, or after # (a 17-character id)."
    ),
    "user": (
        "User slugs often differ from display names; find the account's slug with "
        "lw_search(query=<name>, content_type='users'), whose results link /api/user/<slug>."
    ),
    "tag": (
        "Find a tag's slug with lw_search(query=<name>, content_type='tags'), whose results "
        "link /api/tag/<slug>."
    ),
    "sequence": (
        "Find a sequence's _id with lw_search(query=<title>, content_type='sequences'), whose "
        "results link /api/sequence/<id>."
    ),
}

# What a value of each kind must look like, said before the advice on where to find it.
_SHAPE_LEAD: dict[Kind, str] = {
    "post": (
        "takes a bare post _id or slug (letters, digits, '_' and '-'), not a link: the segment "
        "after /api/post/ in a link, or the <id> in a pasted /posts/<id>/<slug> link; for one "
        "comment, call lw_get_comments with its id as comment_id."
    ),
    "comment": "takes a bare comment _id, not a link.",
    "user": "takes a bare user slug (letters, digits, '_' and '-'), not a link or a display name.",
    "tag": "takes a bare tag slug (letters, digits, '_' and '-'), not a link or a tag's name.",
    "sequence": "takes a bare sequence _id, not a link: the <id> in /s/<id> or /api/sequence/<id>.",
}

# The text for a value that is not a bare identifier of its kind. It becomes a pydantic
# message template, so neither it nor FIND may contain a brace.
SHAPE: dict[Kind, str] = {kind: f"{lead} {FIND[kind]}" for kind, lead in _SHAPE_LEAD.items()}

# What a 404 asks the caller to pass, by the kind that was looked up.
_WHAT: dict[Kind, str] = {
    "post": "post _id or slug",
    "comment": "comment _id",
    "user": "user slug",
    "tag": "tag slug",
    "sequence": "sequence _id",
}


def _handle_error(exc: Exception, *, not_found: Kind | None = None, bad_value: str | None = None) -> str:
    """A uniform, actionable message for an anticipated tool failure.

    For a 404, `not_found` names what was looked up and `bad_value` echoes the caller's
    identifier, so the message points at the offending input rather than a generic 404.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code == 404:
            if not_found:
                target = f" for {bad_value!r}" if bad_value else ""
                return f"no {not_found} found{target} (404). Pass a {_WHAT[not_found]}. {FIND[not_found]}"
            # Only the tools that look nothing up by id or slug get here (feeds, search, the
            # GraphQL endpoint), so the route itself is what's missing.
            return "The forum has no such page (404); its API may have changed."
        if code == 406:
            return "No Markdown version exists for that route (406)."
        if code == 429:
            # Echo only a delta-seconds Retry-After; an HTTP-date would need converting
            # against a clock to mean anything to the caller. No claim about retries: a
            # Retry-After longer than the client waits ends the call after one attempt.
            ra = exc.response.headers.get("retry-after", "").strip()
            wait = ""
            if ra.isascii() and ra.isdigit():
                wait = f" The forum asked to wait {ra} seconds."
            return f"Rate limited by the forum (429).{wait} Wait a bit and try again."
        if code in (500, 502, 503, 504):
            # Errors that pass with time. No attempt count: a Retry-After past the cap ends the
            # call after one.
            return f"The forum had a server error (HTTP {code}). Try again later."
        return f"Forum API returned HTTP {code}."
    if isinstance(exc, httpx.TimeoutException):
        return "Request timed out. Try again."
    if isinstance(exc, httpx.TooManyRedirects):
        return "The forum redirected too many times."
    if isinstance(exc, httpx.DecodingError):
        return "The forum sent a response that could not be decoded."
    # TimeoutException is itself a TransportError, so it is handled above; any *other*
    # transport failure (ConnectError, ReadError, RemoteProtocolError, ...) gets a generic
    # message rather than leaking an httpx class name.
    if isinstance(exc, httpx.TransportError):
        return "Could not reach the forum API (network error). Try again."
    if isinstance(exc, httpx.InvalidURL):
        return "Could not build a valid forum URL."
    if isinstance(exc, httpx.HTTPError):
        return f"Forum request failed ({type(exc).__name__})."
    # A ForumAPIError's text is already the user-facing message.
    return str(exc)
