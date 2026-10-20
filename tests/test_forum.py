"""The network layer: retries, Retry-After, the concurrency cap, the redirect guard, and the three
fetchers, all through the real pooled client over a fake transport."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from lesswrong_mcp import forum


@pytest.fixture
def drive(run):
    """Run a coroutine, then close the pooled client it opened."""
    def _drive(coro):
        async def closing():
            try:
                return await coro
            finally:
                await forum.close()
        return run(closing())
    return _drive


def statuses(*codes: int, headers: dict | None = None):
    """A handler answering with each status in turn, then 200 "ok"."""
    queue = list(codes)

    def handler(request: httpx.Request) -> httpx.Response:
        if queue:
            return httpx.Response(queue.pop(0), headers=headers or {}, text="no")
        return httpx.Response(200, text="ok")
    return handler


# --------------------------------------------------------------------------- retries

def test_retries_each_retryable_status_then_returns(fake_forum, patch_sleep, drive):
    seen = fake_forum(statuses(503, 503))
    assert drive(forum.markdown("/api/post/x")) == "ok"
    assert len(seen) == 3 and len(patch_sleep) == 2


def test_honours_retry_after_seconds(fake_forum, patch_sleep, drive):
    fake_forum(statuses(429, headers={"Retry-After": "7"}))
    assert drive(forum.markdown("/api/post/x")) == "ok"
    assert patch_sleep == [7.0]


def test_retry_after_over_cap_stops_retrying(fake_forum, patch_sleep, drive):
    seen = fake_forum(statuses(429, 429, 429, headers={"Retry-After": "120"}))
    with pytest.raises(httpx.HTTPStatusError) as exc:
        drive(forum.markdown("/api/post/x"))
    assert exc.value.response.status_code == 429
    assert len(seen) == 1 and patch_sleep == []


def test_does_not_retry_404(fake_forum, patch_sleep, drive):
    seen = fake_forum(statuses(404))
    with pytest.raises(httpx.HTTPStatusError):
        drive(forum.markdown("/api/post/x"))
    assert len(seen) == 1 and patch_sleep == []


def test_transport_error_retried_then_raised(fake_forum, patch_sleep, drive):
    def handler(request):
        raise httpx.ConnectError("refused", request=request)
    seen = fake_forum(handler)
    with pytest.raises(httpx.ConnectError):
        drive(forum.markdown("/api/post/x"))
    assert len(seen) == 3 and len(patch_sleep) == 2


def test_slot_released_after_round_trip(fake_forum, drive):
    in_flight = peak = 0

    async def handler(request):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return httpx.Response(200, text="ok")

    fake_forum(handler)

    async def five():
        calls = [forum.markdown(f"/api/post/{i}") for i in range(5)]
        return await asyncio.wait_for(asyncio.gather(*calls), 5)

    assert drive(five()) == ["ok"] * 5
    assert peak == 4


# --------------------------------------------------------------------------- redirect guard

def redirect_to(location: str):
    def handler(request):
        if request.url.host == "www.lesswrong.com" and request.url.path == "/api/post/x":
            return httpx.Response(302, headers={"Location": location})
        return httpx.Response(200, text=f"from {request.url.host}")
    return handler


def test_redirect_offsite_refused(fake_forum, drive):
    seen = fake_forum(redirect_to("https://evil.example/steal"))
    with pytest.raises(forum.ForumError):
        drive(forum.markdown("/api/post/x"))
    assert [r.url.host for r in seen] == ["www.lesswrong.com"]


def test_redirect_plain_http_refused(fake_forum, drive):
    fake_forum(redirect_to("http://www.lesswrong.com/api/post/y"))
    with pytest.raises(forum.ForumError):
        drive(forum.markdown("/api/post/x"))


def test_redirect_to_alignmentforum_followed(fake_forum, drive):
    fake_forum(redirect_to("https://www.alignmentforum.org/api/post/y"))
    assert drive(forum.markdown("/api/post/x")) == "from www.alignmentforum.org"


# --------------------------------------------------------------------------- fetchers

def test_graphql_errors_surface_before_status(fake_forum, drive):
    fake_forum(lambda r: httpx.Response(400, json={"errors": [{"message": "bad"}]}))
    with pytest.raises(forum.ForumError, match="^GraphQL error: bad$"):
        drive(forum.graphql("query { x }", {}))


def test_graphql_non_json_200_is_forum_error(fake_forum, drive):
    fake_forum(lambda r: httpx.Response(200, text="<html>"))
    with pytest.raises(forum.ForumError):
        drive(forum.graphql("query { x }", {}))


def test_graphql_returns_data_and_sends_query_and_variables(fake_forum, drive):
    seen = fake_forum(lambda r: httpx.Response(200, json={"data": {"x": 1}}))
    assert drive(forum.graphql("query { x }", {"a": 1})) == {"x": 1}
    assert seen[0].url == "https://www.lesswrong.com/graphql"
    assert json.loads(seen[0].read()) == {"query": "query { x }", "variables": {"a": 1}}


def test_search_accepts_list_or_results_object(fake_forum, drive):
    result = {"nbHits": 0, "hits": []}
    fake_forum(lambda r: httpx.Response(200, json=[result]))
    assert drive(forum.search([{"indexName": "posts"}])) == [result]
    fake_forum(lambda r: httpx.Response(200, json={"results": [result]}))
    assert drive(forum.search([{"indexName": "posts"}])) == [result]


def test_user_agent_and_accept_headers_sent(fake_forum, drive):
    seen = fake_forum(statuses())
    drive(forum.markdown("/api/post/x"))
    assert seen[0].headers["user-agent"] == forum.USER_AGENT
    assert forum.USER_AGENT.startswith(f"lesswrong-mcp/{forum.VERSION} (+https://github.com/")
    assert seen[0].headers["accept"] == "text/markdown, */*"
