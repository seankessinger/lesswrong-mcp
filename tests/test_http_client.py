"""Tests for the http_client layer: the _request choke point (retry/backoff/concurrency/
deadline), the _get_markdown wrapper over it, the SSRF redirect guard, and the per-loop
client lifecycle.

Hermetic: the network seams are patched via the shared conftest fixtures (patch_io,
patch_sleep); nothing hits the network.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

import lesswrong_mcp as m


# ------------------------------------------------------------------------- #
# _request — retry, backoff, concurrency, total deadline
# ------------------------------------------------------------------------- #

def _req(url="https://www.lesswrong.com/x", method="GET"):
    return httpx.Request(method, url)


# --------------------------------------------------------------------------- #
# _parse_retry_after (pure)
# --------------------------------------------------------------------------- #

def test_retry_after_none_and_empty():
    assert m._parse_retry_after(None) is None
    assert m._parse_retry_after("") is None


def test_retry_after_delta_seconds():
    assert m._parse_retry_after("120") == 120.0
    assert m._parse_retry_after("  30 ") == 30.0   # surrounding whitespace tolerated
    assert m._parse_retry_after("0") == 0.0


def test_retry_after_negative_and_garbage_are_none():
    assert m._parse_retry_after("-5") is None
    assert m._parse_retry_after("soon") is None


def test_retry_after_http_date_in_past_clamps_to_zero():
    # A date already in the past yields 0.0 (max(0, negative)), never a negative wait.
    assert m._parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT") == 0.0


def test_retry_after_http_date_in_future_is_positive():
    secs = m._parse_retry_after("Sun, 06 Nov 2033 08:49:37 GMT")
    assert secs is not None and secs > 0


# --------------------------------------------------------------------------- #
# _request retry / backoff / deadline
# --------------------------------------------------------------------------- #

class _FakeClient:
    """Async client stub: each call pops the next canned item — an httpx.Response to
    return or an Exception to raise."""

    def __init__(self, items):
        self._items = list(items)
        self.calls = 0

    async def request(self, method, url, headers=None, **kwargs):
        self.calls += 1
        item = self._items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def _install(patch_io, patch_sleep, items):
    """Point `_request` at a fake client + fresh semaphore. `patch_sleep` (the shared
    fixture) has already stubbed backoff sleeps and is the `slept` list returned here."""
    client = _FakeClient(items)

    def fake_resources():
        return client, asyncio.Semaphore(m._CONCURRENCY_LIMIT)

    patch_io("_resources", fake_resources)
    return client, patch_sleep


def test_retries_429_then_succeeds(patch_io, patch_sleep, run):
    client, slept = _install(patch_io, patch_sleep, [
        httpx.Response(429, headers={"retry-after": "1"}, request=_req()),
        httpx.Response(200, request=_req()),
    ])
    resp = run(m._request("GET", "https://www.lesswrong.com/x"))
    assert resp.status_code == 200
    assert client.calls == 2
    assert slept == [1.0]  # honoured Retry-After (min(1, 60))


def test_gives_up_after_max_retries_and_returns_last_5xx(patch_io, patch_sleep, run):
    client, slept = _install(patch_io, patch_sleep, [httpx.Response(503, request=_req()) for _ in range(m.MAX_RETRIES)])
    resp = run(m._request("GET", "https://www.lesswrong.com/x"))
    assert resp.status_code == 503
    assert client.calls == m.MAX_RETRIES
    # Exponential self-computed backoff on the two non-final attempts (no Retry-After).
    assert slept == [0.5, 1.0]


def test_non_retryable_status_returns_immediately(patch_io, patch_sleep, run):
    client, slept = _install(patch_io, patch_sleep, [httpx.Response(404, request=_req())])
    resp = run(m._request("GET", "https://www.lesswrong.com/x"))
    assert resp.status_code == 404
    assert client.calls == 1
    assert slept == []  # a 404 is not retried


def test_transient_transport_error_is_retried_then_succeeds(patch_io, patch_sleep, run):
    client, slept = _install(patch_io, patch_sleep, [
        httpx.ConnectError("boom"),
        httpx.Response(200, request=_req()),
    ])
    resp = run(m._request("GET", "https://www.lesswrong.com/x"))
    assert resp.status_code == 200
    assert client.calls == 2
    assert slept == [0.5]


def test_persistent_timeout_raises_after_retries(patch_io, patch_sleep, run):
    client, _ = _install(patch_io, patch_sleep, [httpx.ConnectTimeout("t") for _ in range(m.MAX_RETRIES)])
    with pytest.raises(httpx.TimeoutException):
        run(m._request("GET", "https://www.lesswrong.com/x"))
    assert client.calls == m.MAX_RETRIES


def test_overall_deadline_breach_surfaces_as_httpx_timeout(patch_io, patch_sleep, run):
    # An asyncio.TimeoutError (the overall-deadline breach from wait_for) is re-raised as
    # httpx's timeout type so it flows through _handle_error like any other timeout.
    _install(patch_io, patch_sleep, [asyncio.TimeoutError() for _ in range(m.MAX_RETRIES)])
    with pytest.raises(httpx.TimeoutException) as exc:
        run(m._request("GET", "https://www.lesswrong.com/x"))
    assert "deadline" in str(exc.value)


# ------------------------------------------------------------------------- #
# _get_markdown — the Markdown-route wrapper
# ------------------------------------------------------------------------- #

def _request_recorder(status=200, text="# ok"):
    """A fake `_request` that records the call and returns a canned response."""
    seen: dict = {}

    async def fake_request(method, url, *, headers=None, **kwargs):
        seen.update(method=method, url=url, headers=headers, params=kwargs.get("params"))
        return httpx.Response(status, text=text, request=httpx.Request(method, url))

    return fake_request, seen


def test_get_markdown_builds_url_sends_accept_and_strips_none_params(patch_io, run):
    fake_request, seen = _request_recorder()
    patch_io("_request", fake_request)
    out = run(m._get_markdown("alignmentforum", "/api/post/x", {"limit": 5, "sort": None}))
    assert out == "# ok"
    assert seen["method"] == "GET"
    assert seen["url"] == "https://www.alignmentforum.org/api/post/x"
    assert seen["headers"]["Accept"] == "text/markdown, */*"
    assert seen["params"] == {"limit": 5}   # the None-valued 'sort' is dropped before the call


def test_get_markdown_raises_for_error_status(patch_io, run):
    fake_request, _ = _request_recorder(status=406)
    patch_io("_request", fake_request)
    with pytest.raises(httpx.HTTPStatusError):
        run(m._get_markdown("lesswrong", "/api/post/x"))


# ------------------------------------------------------------------------- #
# _block_offsite_redirect — the SSRF guard
# ------------------------------------------------------------------------- #

def _redirect(location, *, from_url="https://www.lesswrong.com/posts/abc", status=301):
    return httpx.Response(status, headers={"location": location}, request=httpx.Request("GET", from_url))


def test_same_host_relative_redirect_is_allowed(run):
    # The canonical slug -> id redirect the API itself issues: stays on the forum host.
    run(m._block_offsite_redirect(_redirect("/posts/abc/the-canonical-slug")))  # no raise


def test_cross_host_redirect_to_other_forum_is_allowed(run):
    # Both forum hosts are allow-listed, so a hop between them is fine.
    run(m._block_offsite_redirect(_redirect("https://www.alignmentforum.org/posts/abc")))  # no raise


def test_offsite_redirect_to_metadata_address_is_blocked(run):
    # The SSRF case: a redirect to a link-local metadata address must be refused.
    with pytest.raises(RuntimeError) as exc:
        run(m._block_offsite_redirect(_redirect("http://169.254.169.254/latest/meta-data/")))
    assert "169.254.169.254" in str(exc.value)


def test_offsite_redirect_to_arbitrary_host_is_blocked(run):
    with pytest.raises(RuntimeError):
        run(m._block_offsite_redirect(_redirect("https://evil.example.com/steal")))


def test_non_redirect_response_is_ignored_even_with_location_header(run):
    # A 200 that happens to carry a Location header is not a redirect and must be a no-op.
    resp = httpx.Response(200, headers={"location": "http://evil.example.com"},
                          request=httpx.Request("GET", "https://www.lesswrong.com/x"))
    run(m._block_offsite_redirect(resp))  # no raise


# ------------------------------------------------------------------------- #
# per-loop client/semaphore lifecycle
# ------------------------------------------------------------------------- #

def test_resources_are_per_loop_singletons_with_ssrf_hook_and_clean_up(run):
    async def scenario():
        client, sem = m._resources()
        # Same loop -> the pooled client + semaphore are created once and reused.
        again_c, again_s = m._resources()
        assert again_c is client and again_s is sem
        assert isinstance(sem, asyncio.Semaphore)
        # The SSRF guard is wired as a response event hook on the pooled client.
        assert m._block_offsite_redirect in client.event_hooks["response"]
        # The running loop has an entry while the client lives...
        loop = asyncio.get_running_loop()
        assert loop in m._LOOP_RESOURCES
        # ...and _aclose_client drops that entry and closes the client.
        await m._aclose_client()
        assert loop not in m._LOOP_RESOURCES
        return client

    client = run(scenario())
    assert client.is_closed


def test_aclose_client_is_a_noop_when_no_client_exists(run):
    # A loop that never called _resources() has nothing to close -> no KeyError.
    async def scenario():
        loop = asyncio.get_running_loop()
        assert loop not in m._LOOP_RESOURCES
        await m._aclose_client()  # must not raise

    run(scenario())


def test_lifespan_closes_client_only_outside_stateless_http(patch_io, run):
    calls = []

    async def spy_aclose():
        calls.append(1)

    patch_io("_aclose_client", spy_aclose)

    async def drive():
        async with m._lifespan(m.mcp):
            pass

    # stdio (default): the lifespan runs once per process, so it closes the pooled client.
    patch_io("_STATELESS_HTTP", False)
    run(drive())
    assert calls == [1]

    # stateless HTTP: the SDK runs the lifespan per request, so it must NOT close the
    # process-scoped client (the bug the _STATELESS_HTTP flag guards).
    calls.clear()
    patch_io("_STATELESS_HTTP", True)
    run(drive())
    assert calls == []
