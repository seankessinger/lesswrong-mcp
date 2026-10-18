"""The MCP server singleton and the tool-registration machinery.

Owns `mcp` (a `LessWrongServer`) with its instructions and lifespan, the shared read-only
annotations, the shared parameter aliases, the `_tool_errors` funnel, the inputSchema
flattening, and `lw_tool`, the one way a tool is registered. Must NOT import the tools module —
that would bind @lw_tool before `mcp` exists. Registration happens when something imports
`tools` for its side effect.
"""
from __future__ import annotations

import functools
import inspect
from collections.abc import AsyncIterator, Callable, Coroutine
from contextlib import asynccontextmanager
from typing import Annotated, Any, ParamSpec

import httpx
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import CallToolResult, InputRequiredResult, Tool, ToolAnnotations
from pydantic import Field, ValidationError, ValidatorFunctionWrapHandler, WrapValidator
from pydantic_core import PydanticCustomError

from lesswrong_mcp import http_client
from lesswrong_mcp.config import LOG_LEVEL, MAX_CHARS, MAX_TAG_FILTERS, Site, __version__
from lesswrong_mcp.errors import SHAPE, ForumAPIError, Kind, _handle_error


# --------------------------------------------------------------------------- #
# Tool annotations (all read-only) + shared parameter aliases
# --------------------------------------------------------------------------- #

# All eight tools are read-only, non-destructive, idempotent, and open-world.
# `_readonly_annotations` stamps a per-tool title onto a copy (MCPServer wants a
# ToolAnnotations, so a bare dict would trip the type check).
_READONLY = ToolAnnotations(
    read_only_hint=True,
    destructive_hint=False,
    idempotent_hint=True,
    open_world_hint=True,
)


def _readonly_annotations(title: str) -> ToolAnnotations:
    """The shared read-only annotations with `title` set — one per tool."""
    return _READONLY.model_copy(update={"title": title})

# Parameters several tools share. PEP 593 aliases are transparent to inspect.signature /
# Pydantic, so the schema matches spelling them out inline; the bounds-only aliases take each
# tool's own description from an outer Field, which Pydantic merges in.
SiteParam = Annotated[Site, Field(description="'lesswrong' (default) or 'alignmentforum'.")]
MaxCharsParam = Annotated[int, Field(ge=500, le=MAX_CHARS)]
OffsetParam = Annotated[int, Field(ge=0, le=10_000_000)]

# Every identifier is one bare value: a post, comment or sequence _id, or a post, user or tag
# slug. Nothing that matches can hold '/', '.', '?', '#', '%', whitespace or a non-ASCII
# letter, and pydantic's regex engine anchors '$' at the very end, so a value goes into its
# route as given. The pattern needs at least one character, so it also refuses an empty value.
_REF = r"^[A-Za-z0-9_-]+$"


def _shape_error(kind: Kind) -> WrapValidator:
    """Report a value that misses its pattern with SHAPE[kind] instead of pydantic's regex text.

    Only a pattern miss is replaced, since pydantic's text for it names nothing but the regex;
    a length or type error passes through as pydantic words it.
    """
    def validate(value: Any, handler: ValidatorFunctionWrapHandler) -> Any:
        try:
            return handler(value)
        except ValidationError as exc:
            if any(error["type"] == "string_pattern_mismatch" for error in exc.errors()):
                raise PydanticCustomError("ref_shape", SHAPE[kind]) from None
            raise

    return WrapValidator(validate)


PostRef = Annotated[str, Field(max_length=300, pattern=_REF), _shape_error("post")]
CommentRef = Annotated[str, Field(max_length=300, pattern=_REF), _shape_error("comment")]
UserRef = Annotated[str, Field(max_length=300, pattern=_REF), _shape_error("user")]
TagRef = Annotated[str, Field(max_length=300, pattern=_REF), _shape_error("tag")]
SequenceRef = Annotated[str, Field(max_length=300, pattern=_REF), _shape_error("sequence")]
TagsParam = Annotated[list[TagRef], Field(min_length=1, max_length=MAX_TAG_FILTERS)]


_P = ParamSpec("_P")
# A tool handler: a coroutine function returning Markdown text.
_Tool = Callable[_P, Coroutine[Any, Any, str]]


def _tool_errors(fn: _Tool[_P], *, not_found: Kind | None, id_param: str | None) -> _Tool[_P]:
    """Wrap a tool so its anticipated network/API failures raise a ToolError carrying a
    readable message from _handle_error; the tool body is just its happy path and the client
    gets a result with isError=True. MCPServer logs each ToolError once, at INFO with the tool
    name, so the funnel adds no log line of its own. For a 404, `not_found` names the subject
    and the `id_param` argument is echoed. functools.wraps keeps the real signature, which
    MCPServer reads to build the tool's schema, and the docstring.
    """
    sig = inspect.signature(fn)

    @functools.wraps(fn)
    async def wrapper(*args: _P.args, **kwargs: _P.kwargs) -> str:
        try:
            return await fn(*args, **kwargs)
        # Only the anticipated failures: httpx's whole HTTPError family, httpx's InvalidURL
        # (which sits outside it), and ForumAPIError (GraphQL errors, a malformed body, a
        # refused redirect). No tool input can raise InvalidURL: it comes from a proxy or
        # NO_PROXY variable httpx can't parse when it builds the client, and catching it keeps
        # httpx's text, which can quote the start of a proxy password, out of the message and
        # the logs. Anything else, a library RuntimeError included, is a fault and propagates
        # untouched rather than being dressed up as a forum failure.
        except (httpx.HTTPError, httpx.InvalidURL, ForumAPIError) as exc:
            # The call above already bound these arguments, so binding them again succeeds.
            bad_value = sig.bind(*args, **kwargs).arguments.get(id_param) if id_param else None
            message = _handle_error(exc, not_found=not_found, bad_value=bad_value)
            raise ToolError(message) from exc

    return wrapper


# --------------------------------------------------------------------------- #
# inputSchema flattening
#
# Pydantic renders `X | None` as a nullable `anyOf`, so a client that reads only top-level
# JSON-Schema keywords can't see the real constraints — they sit a level down, and an
# out-of-range value then fails late as a runtime Pydantic error instead of being caught (or
# shown to the model) up front. Hoist them by collapsing the nullable `anyOf`. The Pydantic
# models are untouched and stay the runtime safety net.
# --------------------------------------------------------------------------- #

def _flatten_schema(node: dict[str, Any]) -> dict[str, Any]:
    """Return `node` with a nullable `anyOf` collapsed, so the property's constraints sit at
    the top level. A `$ref` variant is left in place: the tools' choice types are Literals,
    which render inline."""
    variants = node.get("anyOf")
    if variants and any(v.get("type") == "null" for v in variants):
        non_null = [v for v in variants if v.get("type") != "null"]
        if len(non_null) == 1 and "$ref" not in non_null[0]:
            base = dict(non_null[0])
            t = base.get("type")
            if isinstance(t, str):
                base["type"] = [t, "null"]
            # (an already-listed `type` is left as-is — idempotent.)
            if "enum" in base and None not in base["enum"]:
                # JSON Schema checks `enum` independently of `type`, so null must be listed
                # here too or the property rejects its own null default.
                base["enum"] = [*base["enum"], None]
            return {**base, **{k: v for k, v in node.items() if k != "anyOf"}}
    return node


def _flatten_parameters(schema: dict[str, Any]) -> dict[str, Any]:
    """Return a flattened copy of a tool's JSON-Schema (the input is never mutated): every
    property flattened, and `additionalProperties: false` so clients see the closed shape
    `LessWrongServer.call_tool` enforces."""
    out = dict(schema)
    props = schema.get("properties")
    if props:
        out["properties"] = {name: _flatten_schema(prop) for name, prop in props.items()}
    out["additionalProperties"] = False
    return out


# --------------------------------------------------------------------------- #
# The server: a closed, flattened tool surface, and a lifespan that owns the pooled client
# --------------------------------------------------------------------------- #

class LessWrongServer(MCPServer[None]):
    """MCPServer with a closed, flattened tool surface, applied through its public
    `list_tools` and `call_tool` hooks (the protocol handlers call both).

    `list_tools` advertises each tool's flattened schema (see `_flatten_parameters`).
    `call_tool` refuses an argument the tool does not declare: MCPServer validates arguments
    with a model that ignores unknown keys, so a misspelled argument would otherwise be
    dropped silently. The refusal is a ToolError caused by a ValidationError, the shape of
    MCPServer's own argument errors, so the client reads the same kind of text and the server
    logs only the refused names. It runs before validation, so a call that also has an invalid
    argument reports the unknown ones first; a required argument the call lacks is reported with
    them, so a misspelt name comes back next to the one it stands for.
    """

    async def list_tools(self) -> list[Tool]:
        return [
            tool.model_copy(update={"input_schema": _flatten_parameters(tool.input_schema)})
            for tool in await super().list_tools()
        ]

    async def call_tool(
        self, name: str, arguments: dict[str, Any], context: Context[None, Any] | None = None
    ) -> CallToolResult | InputRequiredResult:
        # An unknown tool name falls through, so MCPServer reports it as usual.
        tool = next((t for t in await super().list_tools() if t.name == name), None)
        if tool is not None:
            schema = tool.input_schema
            unknown = [key for key in arguments if key not in schema["properties"]]
            if unknown:
                required = schema.get("required", ())
                refused = [("missing", key, arguments) for key in required if key not in arguments]
                refused += [("extra_forbidden", key, arguments[key]) for key in unknown]
                error = ValidationError.from_exception_data(
                    schema.get("title", name),
                    [{"type": kind, "loc": (key,), "input": value} for kind, key, value in refused],
                )
                raise ToolError(f"Error executing tool {name}: {error}") from error
        return await super().call_tool(name, arguments, context)


@asynccontextmanager
async def _lifespan(server: MCPServer[None]) -> AsyncIterator[None]:
    """Close the pooled forum client when the server stops serving. MCPServer enters this
    once per run of the stdio transport, and once per in-process client connection, in the
    event loop that served the requests."""
    try:
        yield
    finally:
        await http_client._aclose_client()


# What a host reads, on either era, to decide when to reach for this server and which tool to
# start with, plus the link-to-value summary for hosts that show these instructions but not each
# parameter's description; each tool's own description carries the detail.
_INSTRUCTIONS = (
    "Use these read-only tools to research LessWrong and the Alignment Forum: posts, comments, "
    "authors, tags and sequences on rationality and AI alignment. The two forums run on one "
    "backend, so lw_search covers both at once; the other tools take a `site` to choose which "
    "forum's view they return. Start with lw_search to discover content, fetch a post's full "
    "text with lw_get_post (and its discussion with lw_get_comments), and use lw_filter_posts "
    "for precise listings by author, tag, date range or karma in an explicit sort order. "
    "Results link what they mention as /<kind>/<value> (/api/post/<id>, /users/<slug>, "
    "/w/<slug>, /s/<id>); pass that value alone, never the link or its ?query. In "
    "/posts/<id>/<slug> and /s/<seq>/p/<id> the post is the <id>. A comment link "
    "(/api/post/<post>/comments/<cid>, or a pasted post link with /comment/<cid>, "
    "?commentId=<cid> or #<cid>, a 17-character id) is "
    "lw_get_comments(id_or_slug=<post>, comment_id=<cid>)."
)

# The tool set is fixed and the server has no resources or prompts, so it serves no
# subscriptions: no era advertises a list that can change or a resource to subscribe to.
mcp = LessWrongServer(
    "lesswrong_mcp",
    version=__version__,
    instructions=_INSTRUCTIONS,
    log_level=LOG_LEVEL,
    lifespan=_lifespan,
    subscriptions=False,
)


# --------------------------------------------------------------------------- #
# Tool registration
# --------------------------------------------------------------------------- #

def lw_tool(
    name: str,
    title: str,
    *,
    not_found: Kind | None = None,
    id_param: str | None = None,
) -> Callable[[_Tool[_P]], _Tool[_P]]:
    """Register a coroutine as a read-only tool on `mcp`; every tool goes through here.

    MCPServer registers exactly the callable it is handed, so the `_tool_errors` funnel is
    applied first and the funnelled function is what gets registered (and returned). The
    description is the docstring through `inspect.cleandoc`, so it reads the same on every
    Python (3.13+ dedents docstrings when compiling them; earlier versions keep the source
    indentation). Auto structured output is off: the tools return Markdown text, which a
    `{result: str}` structuredContent would only duplicate on the wire.
    """
    def register(fn: _Tool[_P]) -> _Tool[_P]:
        wrapped = _tool_errors(fn, not_found=not_found, id_param=id_param)
        mcp.tool(
            name=name,
            annotations=_readonly_annotations(title),
            description=inspect.cleandoc(fn.__doc__ or ""),
            structured_output=False,
        )(wrapped)
        return wrapped

    return register
