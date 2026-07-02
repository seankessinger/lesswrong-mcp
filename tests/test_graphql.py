"""Tests for the GraphQL plumbing: `_graphql`'s error surfacing (a validation error comes
back as HTTP 400 *with* a descriptive errors[] body, which must be shown before the status
raise would hide it) and `_resolve_id`'s slug -> _id resolution with a raw-_id fallback.

Hermetic: `_request` / `_graphql` are stubbed via the shared `patch_io` seam; nothing hits
the network.
"""
from __future__ import annotations

import httpx
import pytest

import lesswrong_mcp as m


def _patch_request(patch_io, response):
    async def fake_request(method, url, **kwargs):
        return response

    patch_io("_request", fake_request)


def _req():
    return httpx.Request("POST", "https://www.lesswrong.com/graphql")


# --------------------------------------------------------------------------- #
# _graphql
# --------------------------------------------------------------------------- #

def test_graphql_returns_data_on_success(patch_io, run):
    _patch_request(patch_io, httpx.Response(200, json={"data": {"posts": {"results": []}}}, request=_req()))
    data = run(m._graphql("lesswrong", "query { posts { results { _id } } }"))
    assert data == {"posts": {"results": []}}


def test_graphql_surfaces_errors_body_over_400_status(patch_io, run):
    # A 400 carrying errors[] must raise the descriptive GraphQL message, not a bare status.
    resp = httpx.Response(400, json={"errors": [{"message": "Exceeded maximum value for skip"}]}, request=_req())
    _patch_request(patch_io, resp)
    with pytest.raises(RuntimeError) as exc:
        run(m._graphql("lesswrong", "query {}"))
    assert "GraphQL error: Exceeded maximum value for skip" in str(exc.value)


def test_graphql_non_json_error_status_raises_status_error(patch_io, run):
    _patch_request(patch_io, httpx.Response(500, text="<html>bad gateway</html>", request=_req()))
    with pytest.raises(httpx.HTTPStatusError):
        run(m._graphql("lesswrong", "query {}"))


def test_graphql_non_json_2xx_body_raises_runtime_error(patch_io, run):
    _patch_request(patch_io, httpx.Response(200, text="not json", request=_req()))
    with pytest.raises(RuntimeError) as exc:
        run(m._graphql("lesswrong", "query {}"))
    assert "non-JSON" in str(exc.value)


def test_graphql_null_data_becomes_empty_dict(patch_io, run):
    _patch_request(patch_io, httpx.Response(200, json={"data": None}, request=_req()))
    assert run(m._graphql("lesswrong", "query {}")) == {}


def test_graphql_non_object_2xx_body_raises_runtime_error(patch_io, run):
    # A 2xx body that parses to a non-object (here JSON null; also a list or scalar) would
    # make the payload.get() calls raise AttributeError and escape the tool error funnel —
    # so it must surface as a clean RuntimeError instead.
    _patch_request(patch_io, httpx.Response(
        200, content=b"null", headers={"content-type": "application/json"}, request=_req()))
    with pytest.raises(RuntimeError) as exc:
        run(m._graphql("lesswrong", "query {}"))
    assert "non-object" in str(exc.value)


# --------------------------------------------------------------------------- #
# _resolve_id
# --------------------------------------------------------------------------- #

_KW = dict(field="users", selector_type="UserSelector!", selector_key="usersProfile")


def _patch_graphql(patch_io, results):
    async def fake_graphql(site, query, variables=None):
        return {"users": {"results": results}}

    patch_io("_graphql", fake_graphql)


def test_resolve_id_returns_slug_match(patch_io, run):
    _patch_graphql(patch_io, [{"_id": "abcdefghij1234567"}])
    out = run(m._resolve_id("lesswrong", "some-slug", **_KW))
    assert out == "abcdefghij1234567"


def test_resolve_id_falls_back_to_raw_17char_id(patch_io, run):
    # No slug match, but the value is itself a document _id (17 alphanumerics): use it.
    _patch_graphql(patch_io, [])
    raw = "EQNTWXLKMeWMp2FQS"
    assert len(raw) == 17
    assert run(m._resolve_id("lesswrong", raw, **_KW)) == raw


def test_resolve_id_returns_none_when_unresolvable(patch_io, run):
    # No slug match and not _id-shaped -> None, so callers surface a clean not-found error.
    _patch_graphql(patch_io, [])
    assert run(m._resolve_id("lesswrong", "not-an-id", **_KW)) is None
