"""The FastMCP server singleton and the tool-registration machinery.

Owns `mcp` (wired to the http_client lifespan), the shared read-only annotation dict, the
SiteParam alias, and the `_tool_errors` funnel decorator. The tools module imports `mcp` and
these helpers to register on it; this module must NOT import the tools module at module scope
— that would try to bind @mcp.tool before `mcp` exists, an import cycle. Registration is
driven by the entry point importing the tools module for its side effect.
"""
from __future__ import annotations

import functools
import inspect
from typing import Annotated, Any

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from lesswrong_mcp import http_client
from lesswrong_mcp.config import Site
from lesswrong_mcp.markdown import _handle_error

mcp = FastMCP("lesswrong_mcp", lifespan=http_client._lifespan)


# --------------------------------------------------------------------------- #
# Tool annotations (all read-only) + shared parameter aliases
# --------------------------------------------------------------------------- #

# Shared annotation template — all eight tools are read-only, non-destructive, idempotent,
# and open-world. `_readonly_annotations` stamps a per-tool display title onto a copy;
# FastMCP's `annotations=` wants a ToolAnnotations, so a bare dict would trip the type check.
_READONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=True,
)


def _readonly_annotations(title: str) -> ToolAnnotations:
    """The shared read-only annotations with `title` set — one per tool."""
    return _READONLY.model_copy(update={"title": title})

# Seven of the eight tools share this exact site parameter; alias it once. PEP 593
# Annotated aliases are transparent to inspect.signature / Pydantic, so the tool
# schema is identical to spelling it out inline.
SiteParam = Annotated[Site, Field(description="'lesswrong' (default) or 'alignmentforum'.")]


def _tool_errors(fn=None, *, not_found: str | None = None, id_param: str | None = None):
    """Funnel the anticipated network/API failures raised by a tool through
    _handle_error, so each tool body is just its happy path. Only these expected
    types are turned into an actionable "Error: ..." string; anything else (a
    programming bug, an unexpected response shape) is left to propagate so FastMCP
    marks the tool result isError=True instead of masking a fault as success text.

    Usable bare (`@_tool_errors`) or parameterised (`@_tool_errors(not_found="post",
    id_param="id_or_slug")`): for a tool that looks a document up by id/slug, the
    parameterised form makes a 404 name the subject and echo the caller's identifier
    (read back from the bound arguments) instead of a generic "Not found".

    functools.wraps sets __wrapped__, so FastMCP's inspect.signature / get_type_hints
    still see the real Annotated params, defaults, and docstring. @mcp.tool must
    stay the OUTERMOST decorator.
    """
    def decorate(f):
        sig = inspect.signature(f)

        @functools.wraps(f)
        async def wrapper(*args, **kwargs):
            try:
                return await f(*args, **kwargs)
            except (
                httpx.HTTPStatusError,
                httpx.TimeoutException,
                httpx.TransportError,
                RuntimeError,
            ) as exc:
                bad_value = None
                if id_param is not None:
                    try:
                        bad_value = sig.bind(*args, **kwargs).arguments.get(id_param)
                    except TypeError:
                        bad_value = None
                return _handle_error(exc, not_found=not_found, bad_value=bad_value)
        return wrapper

    return decorate if fn is None else decorate(fn)


# --------------------------------------------------------------------------- #
# inputSchema flattening
#
# Pydantic renders an Optional[...] param (`X | None`) as `anyOf: [{...X...}, {"type":
# "null"}]` and an Enum param as a `$ref` into `$defs`. A client that validates/displays
# only top-level JSON-Schema keywords (common) then can't see the real constraints — the
# `minimum`/`maximum`/`pattern`/`enum` are buried a level down — so an out-of-range value
# isn't caught (or shown to the model) up front and only fails later as a runtime Pydantic
# error. Rewrite each tool's advertised schema to hoist those constraints to the top level:
# collapse a nullable `anyOf` to its non-null branch (folding "null" into `type`) and inline
# `$ref` enums. The Pydantic models are untouched, so they stay the runtime safety net.
# --------------------------------------------------------------------------- #

def _flatten_schema(node: dict[str, Any], defs: dict[str, Any]) -> dict[str, Any]:
    """Return `node` with a top-level `$ref` inlined and a nullable `anyOf` collapsed, so
    the property's constraints sit at the top level. Recurses so a `$ref` nested inside a
    nullable `anyOf` (an `Enum | None`) is both inlined and made nullable."""
    ref = node.get("$ref")
    if ref:
        # Inline the referenced $defs entry; the referrer's own keys (e.g. a param-specific
        # `description`/`default`) win over the definition's.
        target = defs.get(ref.rsplit("/", 1)[-1], {})
        merged = {**target, **{k: v for k, v in node.items() if k != "$ref"}}
        return _flatten_schema(merged, defs)

    variants = node.get("anyOf")
    if variants and any(v.get("type") == "null" for v in variants):
        non_null = [v for v in variants if v.get("type") != "null"]
        if len(non_null) == 1:
            base = dict(_flatten_schema(non_null[0], defs))  # inline a $ref enum first
            t = base.get("type")
            if isinstance(t, str):
                base["type"] = [t, "null"]
            elif t is None and "enum" in base and None not in base["enum"]:
                # A typeless enum: fold null in as a permitted value rather than a `type`.
                base["enum"] = [*base["enum"], None]
            # (an already-listed `type` is left as-is — idempotent.)
            return {**base, **{k: v for k, v in node.items() if k != "anyOf"}}
    return node


def _contains_ref(obj: Any) -> bool:
    """True if a `$ref` survives anywhere in `obj` (so `$defs` is still needed)."""
    if isinstance(obj, dict):
        return "$ref" in obj or any(_contains_ref(v) for v in obj.values())
    if isinstance(obj, list):
        return any(_contains_ref(v) for v in obj)
    return False


def _flatten_parameters(schema: dict[str, Any]) -> dict[str, Any]:
    """Flatten every property of a tool's JSON-Schema, dropping `$defs` once its enums are
    inlined. A schema with no `properties` (e.g. a zero-argument tool) has nothing to
    flatten and is returned **as the same object** — so callers that mutate must check
    identity (see `_apply_flat_schemas`) before clearing it."""
    props = schema.get("properties")
    if not props:
        return schema
    defs = schema.get("$defs", {})
    out = dict(schema)
    out["properties"] = {name: _flatten_schema(prop, defs) for name, prop in props.items()}
    if "$defs" in out and not _contains_ref(out["properties"]):
        del out["$defs"]
    return out


def _apply_flat_schemas(server: FastMCP) -> None:
    """Rewrite every registered tool's advertised inputSchema in place (mutating the stored
    `parameters` dict, which `FastMCP.list_tools` emits as `inputSchema`). Call once after
    the tools are registered."""
    for tool in server._tool_manager.list_tools():
        flat = _flatten_parameters(tool.parameters)
        # `_flatten_parameters` returns the SAME dict when there's nothing to flatten (a
        # zero-argument tool has no `properties`); clearing it in place would then wipe the
        # schema (type/title). Only mutate when a distinct, flattened dict came back.
        if flat is tool.parameters:
            continue
        tool.parameters.clear()
        tool.parameters.update(flat)
