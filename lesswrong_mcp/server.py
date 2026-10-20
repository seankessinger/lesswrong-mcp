"""The MCP server, the identifier types with their advice, the error funnel, and `tool`, the one
way a tool is registered.

Must not import `tools`: registration happens when something imports that module.
"""
from __future__ import annotations

import functools
import inspect
import re
from collections.abc import AsyncIterator, Callable, Coroutine
from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated, Any, Literal, ParamSpec

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import BeforeValidator, Field, ValidationError, ValidatorFunctionWrapHandler, WrapValidator
from pydantic_core import PydanticCustomError

from lesswrong_mcp import forum

# --------------------------------------------------------------------------- identifiers

Kind = Literal["post", "comment", "sequence", "user", "tag"]

# Where each kind of value comes from. A value that misses its pattern (SHAPE) and a lookup
# that finds nothing (miss) both end with this sentence. Nothing is guessed from a malformed
# value: a user slug comes from the username, and a popular display name is held by several
# accounts. SHAPE becomes a pydantic message template, so no entry may contain a brace.
FIND: dict[Kind, str] = {
    "post": "Find posts with lw_search; each result links /api/post/<id>, and a pasted /posts/<id>/<slug> link holds the id.",
    "comment": "It is the 17-character <cid> in /api/post/<post>/comments/<cid>, or in a pasted link after /comment/, in ?commentId=<cid>, or after #.",
    "sequence": 'Find a sequence\'s id with lw_search(query=<title>, types=["sequences"]); results link /s/<id>.',
    "user": 'User slugs often differ from display names; find the slug with lw_search(query=<name>, types=["users"]); results link /users/<slug>.',
    "tag": 'Find a tag\'s slug with lw_search(query=<name>, types=["tags"]); results link /w/<slug>.',
}

WHAT: dict[Kind, str] = {
    "post": "17-character post _id",
    "comment": "17-character comment _id",
    "sequence": "17-character sequence _id",
    "user": "user slug",
    "tag": "tag slug",
}

SHAPE: dict[Kind, str] = {kind: f"takes a bare {WHAT[kind]}, not a link. {FIND[kind]}" for kind in FIND}

ID = r"^[A-Za-z0-9]{17}$"
SLUG = r"^[A-Za-z0-9_-]+$"


def miss(kind: Kind, value: str) -> ToolError:
    """The error for a lookup that found nothing, naming where the value comes from."""
    return ToolError(f"no {kind} found for {value!r}. Pass a {WHAT[kind]}. {FIND[kind]}")


def _shape_error(kind: Kind) -> WrapValidator:
    """Report a pattern miss with SHAPE[kind] instead of pydantic's regex text. A length or type
    error passes through as pydantic words it."""
    def validate(value: Any, handler: ValidatorFunctionWrapHandler) -> Any:
        try:
            return handler(value)
        except ValidationError as exc:
            if any(error["type"] == "string_pattern_mismatch" for error in exc.errors()):
                raise PydanticCustomError("ref_shape", SHAPE[kind]) from None
            raise

    return WrapValidator(validate)


# The length bound is loose so that a pasted link fails the pattern, whose message is the advice.
PostId = Annotated[str, Field(pattern=ID, max_length=300, description="A post's 17-character _id: the <id> in /api/post/<id>, or in a pasted /posts/<id>/<slug> link."), _shape_error("post")]
CommentId = Annotated[str, Field(pattern=ID, max_length=300, description="A comment's 17-character _id: the <cid> in /api/post/<post>/comments/<cid>."), _shape_error("comment")]
SequenceId = Annotated[str, Field(pattern=ID, max_length=300, description="A sequence's 17-character _id: the <id> in /s/<id>."), _shape_error("sequence")]
UserSlug = Annotated[str, Field(pattern=SLUG, max_length=300, description="A user's slug: the <slug> in /users/<slug>. It often differs from the display name; find it with lw_search(types=[\"users\"])."), _shape_error("user")]
TagSlug = Annotated[str, Field(pattern=SLUG, max_length=300, description="A tag's slug: the <slug> in /w/<slug>."), _shape_error("tag")]
TagSlugs = Annotated[list[TagSlug], Field(min_length=1, max_length=10)]

MAX_CHARS = 40_000
MaxChars = Annotated[int, Field(ge=500, le=MAX_CHARS, description=f"Cap the result at this many characters (500 to {MAX_CHARS}, the default). A longer result ends with the offset to call again with.")]
Offset = Annotated[int, Field(ge=0, le=10_000_000, description="Skip this many characters: the offset a previous result's footer gave.")]

_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _iso_date(value: Any) -> Any:
    """Let only a 'YYYY-MM-DD' string (or a date) through to the date parser, which still
    rejects a day that doesn't exist. Lax parsing would read a number as a Unix timestamp."""
    if isinstance(value, date) or (isinstance(value, str) and _ISO_DATE.fullmatch(value)):
        return value
    raise ValueError("use an ISO date 'YYYY-MM-DD', e.g. '2023-01-01'")


IsoDate = Annotated[date, BeforeValidator(_iso_date)]


# --------------------------------------------------------------------------- errors

def handle_error(exc: Exception) -> str:
    """A readable message for an anticipated failure. MCPServer already prefixes 'Error
    executing tool <name>:', so no message starts with 'Error'."""
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code == 404:
            return "The forum has no such page (404); its API may have changed."
        if code == 429:
            ra = exc.response.headers.get("retry-after", "").strip()
            wait = f" The forum asked to wait {ra} seconds." if ra.isascii() and ra.isdigit() else ""
            return f"Rate limited by the forum (429).{wait} Wait a bit and try again."
        if code in (500, 502, 503, 504):
            return f"The forum had a server error (HTTP {code}). Try again later."
        return f"The forum returned HTTP {code}."
    if isinstance(exc, httpx.TimeoutException):
        return "The request to the forum timed out. Try again."
    if isinstance(exc, httpx.TooManyRedirects):
        return "The forum redirected too many times."
    if isinstance(exc, httpx.DecodingError):
        return "The forum sent a response that could not be decoded."
    if isinstance(exc, httpx.TransportError):
        return "Could not reach the forum (network error). Try again."
    if isinstance(exc, httpx.InvalidURL):
        # Only a proxy or NO_PROXY variable httpx can't parse gets here; its text can quote
        # the start of a proxy password, so it stays out of the message.
        return "Could not build a valid forum URL."
    if isinstance(exc, httpx.HTTPError):
        return f"The request to the forum failed ({type(exc).__name__})."
    return str(exc)  # a ForumError's text is already the message


_P = ParamSpec("_P")
_Tool = Callable[_P, Coroutine[Any, Any, str]]


def _funnel(fn: _Tool[_P]) -> _Tool[_P]:
    """Report each anticipated failure as a tool error with a readable message. Anything else is
    a fault, left for MCPServer to log with its traceback. functools.wraps keeps the signature
    MCPServer builds the schema from."""
    @functools.wraps(fn)
    async def wrapper(*args: _P.args, **kwargs: _P.kwargs) -> str:
        try:
            return await fn(*args, **kwargs)
        except (httpx.HTTPError, httpx.InvalidURL, forum.ForumError) as exc:
            raise ToolError(handle_error(exc)) from exc

    return wrapper


# --------------------------------------------------------------------------- server

@asynccontextmanager
async def _lifespan(server: MCPServer[None]) -> AsyncIterator[None]:
    """Close the pooled forum client when serving stops."""
    try:
        yield
    finally:
        await forum.close()


INSTRUCTIONS = (
    "Read-only tools for researching LessWrong and the Alignment Forum, which run on one backend: "
    "lw_search finds posts, comments, tags, users and sequences; lw_get_post reads a post; "
    "lw_get_comments reads a post's whole discussion (answers on question posts included) or one "
    "comment; lw_filter_posts lists posts by author, tag, date range and karma, or the posts that "
    "link to a post (links_to); lw_get_sequence reads a series in order. Listed items and comments "
    "on the Alignment Forum are marked AF. Results link /api/post/<id>, /users/<slug>, /w/<slug> "
    "and /s/<id>; pass that value alone, never the link. In a pasted /posts/<id>/<slug> link the "
    "post is the <id>; a comment link's 17-character <cid> is comment_id."
)

# The tool set is fixed and there are no resources or prompts, so nothing is subscribable.
mcp: MCPServer[None] = MCPServer(
    "lesswrong_mcp",
    version=forum.VERSION,
    instructions=INSTRUCTIONS,
    lifespan=_lifespan,
    subscriptions=False,
)


def tool(name: str, title: str) -> Callable[[_Tool[_P]], _Tool[_P]]:
    """Register a coroutine as a read-only tool: wrapped in the funnel, described by its cleaned
    docstring, returning Markdown text (no structured output, which would only duplicate it)."""
    annotations = ToolAnnotations(
        title=title, read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=True
    )

    def register(fn: _Tool[_P]) -> _Tool[_P]:
        wrapped = _funnel(fn)
        mcp.tool(
            name=name,
            annotations=annotations,
            description=inspect.cleandoc(fn.__doc__ or ""),
            structured_output=False,
        )(wrapped)
        return wrapped

    return register
