"""Tests for the GraphQL plumbing: `_graphql`'s error surfacing (a validation error comes
back as HTTP 400 *with* a descriptive errors[] body, which must be shown before the status
raise would hide it, while an error status with no errors[] surfaces as the status itself),
`_resolve_id`'s slug -> _id resolution, and the bounded LRU cache of successful resolutions.

Hermetic: `_request` / `_graphql` are stubbed via the shared `patch_io` seam; nothing hits
the network.
"""
from __future__ import annotations

import httpx
import pytest
from mcp.server.mcpserver.exceptions import ToolError

import lesswrong_mcp as m
from lesswrong_mcp import errors, graphql_resolve, http_client


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
    data = run(http_client._graphql("lesswrong", "query { posts { results { _id } } }"))
    assert data == {"posts": {"results": []}}


def test_graphql_surfaces_errors_body_over_400_status(patch_io, run):
    # A 400 carrying errors[] must raise the descriptive GraphQL message, not a bare status.
    resp = httpx.Response(400, json={"errors": [{"message": "Exceeded maximum value for skip"}]}, request=_req())
    _patch_request(patch_io, resp)
    with pytest.raises(errors.ForumAPIError) as exc:
        run(http_client._graphql("lesswrong", "query {}"))
    assert "GraphQL error: Exceeded maximum value for skip" in str(exc.value)


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"text": "<html>bad gateway</html>"}, id="non-json"),
        pytest.param({"json": {"message": "bad gateway"}}, id="json-object-without-errors"),
        pytest.param({"json": ["bad gateway"]}, id="json-non-object"),
    ],
)
def test_graphql_error_status_without_errors_raises_status_error(patch_io, run, body):
    # With no errors[] to report, an error status surfaces as the status itself, whatever
    # the body is.
    _patch_request(patch_io, httpx.Response(502, request=_req(), **body))
    with pytest.raises(httpx.HTTPStatusError):
        run(http_client._graphql("lesswrong", "query {}"))


def test_filter_posts_reports_a_json_gateway_error_instead_of_no_matches(patch_io, run):
    # An outage answered with a JSON body is reported as the outage, not as an empty result.
    _patch_request(patch_io, httpx.Response(502, json={"message": "bad gateway"}, request=_req()))
    with pytest.raises(ToolError, match="502"):
        run(m.lw_filter_posts())


def test_graphql_non_json_2xx_body_raises_forum_api_error(patch_io, run):
    _patch_request(patch_io, httpx.Response(200, text="not json", request=_req()))
    with pytest.raises(errors.ForumAPIError) as exc:
        run(http_client._graphql("lesswrong", "query {}"))
    assert "non-JSON" in str(exc.value)


def test_graphql_null_data_becomes_empty_dict(patch_io, run):
    _patch_request(patch_io, httpx.Response(200, json={"data": None}, request=_req()))
    assert run(http_client._graphql("lesswrong", "query {}")) == {}


def test_graphql_non_object_2xx_body_raises_forum_api_error(patch_io, run):
    # A 2xx body that parses to a non-object (here JSON null; also a list or scalar) would
    # make the payload.get() calls raise AttributeError and escape the tool error funnel —
    # so it must surface as a clean ForumAPIError instead.
    _patch_request(patch_io, httpx.Response(
        200, content=b"null", headers={"content-type": "application/json"}, request=_req()))
    with pytest.raises(errors.ForumAPIError) as exc:
        run(http_client._graphql("lesswrong", "query {}"))
    assert "non-object" in str(exc.value)


@pytest.mark.parametrize(
    "payload, fragments",
    [
        ({"errors": "boom"}, ["boom"]),                    # errors[] that isn't a list
        ({"errors": [1, {"message": "m"}]}, ["1; m"]),        # a non-object entry
        ({"errors": [{"message": None}]}, ["unknown error"]),
        ({"data": []}, ["non-object data"]),
        ({"data": "x"}, ["non-object data"]),
    ],
)
def test_graphql_malformed_shapes_raise_forum_api_error(patch_io, run, payload, fragments):
    # Spec-violating inner shapes must still fail as a ForumAPIError the funnel reports,
    # never as a TypeError/AttributeError from trusting them.
    _patch_request(patch_io, httpx.Response(200, json=payload, request=_req()))
    with pytest.raises(errors.ForumAPIError) as exc:
        run(http_client._graphql("lesswrong", "query {}"))
    for fragment in fragments:
        assert fragment in str(exc.value)


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
    out = run(graphql_resolve._resolve_id("lesswrong", "some-slug", **_KW))
    assert out == "abcdefghij1234567"


def test_an_id_shaped_value_that_matches_no_slug_resolves_to_none(patch_io, run):
    # The resolver applies no shape check: a value that matches no slug is unresolved, whatever
    # it looks like, so a document _id is never taken for a slug.
    _patch_graphql(patch_io, [])
    raw = "EQNTWXLKMeWMp2FQS"
    assert len(raw) == 17
    assert run(graphql_resolve._resolve_id("lesswrong", raw, **_KW)) is None


def test_resolve_id_returns_none_when_unresolvable(patch_io, run):
    # No slug match -> None, so callers surface a clean not-found error.
    _patch_graphql(patch_io, [])
    assert run(graphql_resolve._resolve_id("lesswrong", "not-an-id", **_KW)) is None


# --------------------------------------------------------------------------- #
# _resolve_id cache: a bounded LRU of successful resolutions
# --------------------------------------------------------------------------- #

def _counting_resolver(patch_io, known=None):
    """Stub `_graphql` so a slug resolves to "<field>-<slug>" (only the slugs in `known`, when
    given) and return the list of slugs actually looked up."""
    lookups: list[str] = []

    async def fake_graphql(site, query, variables=None):
        field = "users" if "users(" in query else "tags"
        slug = next(iter(variables["s"].values()))["slug"]
        lookups.append(slug)
        found = known is None or slug in known
        return {field: {"results": [{"_id": f"{field}-{slug}"}] if found else []}}

    patch_io("_graphql", fake_graphql)
    return lookups


def _resolve_users(run, slugs):
    """Resolve each user slug in order, in one event loop, and return the results."""
    async def scenario():
        return [await graphql_resolve._resolve_user_id("lesswrong", slug) for slug in slugs]

    return run(scenario())


def test_id_cache_evicts_the_least_recently_used_entry(patch_io, run, monkeypatch):
    # A three-entry cache: 'a' is used again before 'd' arrives, so 'b' is the least recently
    # used entry when 'd' overflows the cache, and the only one looked up again.
    monkeypatch.setattr(graphql_resolve, "_ID_CACHE_MAX", 3)
    lookups = _counting_resolver(patch_io)
    _resolve_users(run, ["a", "b", "c", "a", "d"])
    assert lookups == ["a", "b", "c", "d"]
    lookups.clear()
    _resolve_users(run, ["a", "c", "d", "b"])
    assert lookups == ["b"]


def test_unresolved_slugs_are_never_cached(patch_io, run, monkeypatch):
    # A miss is looked up again every time, and never takes the slot of a cached hit.
    monkeypatch.setattr(graphql_resolve, "_ID_CACHE_MAX", 1)
    lookups = _counting_resolver(patch_io, known={"evhub"})
    out = _resolve_users(run, ["evhub", "no-such-user", "no-such-user", "evhub"])
    assert out == ["users-evhub", None, None, "users-evhub"]
    assert lookups == ["evhub", "no-such-user", "no-such-user"]


def test_id_cache_keeps_users_and_tags_apart(patch_io, run):
    # A user and a tag can share a slug; each resolves to its own _id.
    lookups = _counting_resolver(patch_io)

    async def scenario():
        return (
            await graphql_resolve._resolve_user_id("lesswrong", "ai"),
            await graphql_resolve._resolve_tag_id("lesswrong", "ai"),
        )

    assert run(scenario()) == ("users-ai", "tags-ai")
    assert lookups == ["ai", "ai"]
