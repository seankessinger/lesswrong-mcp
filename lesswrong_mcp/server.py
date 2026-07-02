"""The FastMCP server singleton and the tool-registration machinery.

Owns `mcp`, the shared read-only annotations, the SiteParam alias, the `_tool_errors` funnel,
and the inputSchema flattening. Must NOT import the tools module — that would bind @mcp.tool
before `mcp` exists. Registration happens when something imports `tools` for its side effect.
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

# All eight tools are read-only, non-destructive, idempotent, and open-world.
# `_readonly_annotations` stamps a per-tool title onto a copy (FastMCP wants a
# ToolAnnotations, so a bare dict would trip the type check).
_READONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=True,
)


def _readonly_annotations(title: str) -> ToolAnnotations:
    """The shared read-only annotations with `title` set — one per tool."""
    return _READONLY.model_copy(update={"title": title})

# Seven of the eight tools share this parameter. PEP 593 aliases are transparent to
# inspect.signature / Pydantic, so the schema matches spelling it out inline.
SiteParam = Annotated[Site, Field(description="'lesswrong' (default) or 'alignmentforum'.")]


def _tool_errors(fn=None, *, not_found: str | None = None, id_param: str | None = None):
    """Funnel a tool's anticipated network/API failures through _handle_error, so each tool
    body is just its happy path. Only the expected types become an "Error: ..." string;
    anything else propagates so FastMCP marks the result isError=True rather than masking a
    fault as success text.

    Usable bare or parameterised (`@_tool_errors(not_found="post", id_param="id_or_slug")`),
    where a 404 then names the subject and echoes the caller's identifier.

    functools.wraps preserves the real signature and docstring for FastMCP, so @mcp.tool must
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
# Pydantic renders `X | None` as a nullable `anyOf` and an Enum as a `$ref` into `$defs`, so
# a client that reads only top-level JSON-Schema keywords can't see the real constraints —
# they sit a level down, and an out-of-range value then fails late as a runtime Pydantic
# error instead of being caught (or shown to the model) up front. Hoist them: collapse the
# nullable `anyOf`, inline `$ref` enums. The Pydantic models are untouched and stay the
# runtime safety net.
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
