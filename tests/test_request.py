"""Tests for the shared HTTP layer: `_parse_retry_after` and `_request`'s retry / backoff /
deadline behaviour — the single choke point all network I/O flows through.

Hermetic: `_request` is driven against a fake client (via a `_resources` stub installed
through the shared `patch_io` seam) that returns canned responses or raises, and
`asyncio.sleep` is stubbed via `patch_sleep` so backoff waits are recorded instead of slept.
Nothing touches the network.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

import lesswrong_mcp as m


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
