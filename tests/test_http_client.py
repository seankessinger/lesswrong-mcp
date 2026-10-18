"""Tests for the http_client layer: the _request choke point (retry/backoff/concurrency/
deadline), the _get_markdown wrapper over it, the SSRF redirect guard, the per-loop client
lifecycle, and the request each backend puts on the wire through the real pooled client; plus
the suite's own network guard, which keeps all of them offline.

Hermetic: the network seams are patched via the shared conftest fixtures (patch_io,
patch_sleep, spy_sleep), or the real pooled client talks to an in-process transport (forum);
nothing hits the network.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import socket
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import httpx
import pytest

import lesswrong_mcp as m
from lesswrong_mcp import config, errors, http_client

LW = config.SITE_BASE_URLS["lesswrong"]


# ------------------------------------------------------------------------- #
# _parse_retry_after (pure)
# ------------------------------------------------------------------------- #

def test_retry_after_none_and_empty():
    assert http_client._parse_retry_after(None) is None
    assert http_client._parse_retry_after("") is None


def test_retry_after_delta_seconds():
    assert http_client._parse_retry_after("120") == 120.0
    assert http_client._parse_retry_after("  30 ") == 30.0   # surrounding whitespace tolerated
    assert http_client._parse_retry_after("0") == 0.0


# An HTTP-date whose year is too large for a C long: the date parser raises OverflowError on it
# rather than ValueError.
OUT_OF_RANGE_DATE = "Wed, 21 Oct 99999999999999999999 07:28:00 GMT"


def test_retry_after_negative_and_garbage_are_none():
    assert http_client._parse_retry_after("-5") is None
    assert http_client._parse_retry_after("soon") is None
    assert http_client._parse_retry_after(OUT_OF_RANGE_DATE) is None


def test_retry_after_http_date_in_past_clamps_to_zero():
    # A date already in the past yields 0.0 (max(0, negative)), never a negative wait.
    assert http_client._parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT") == 0.0


@pytest.fixture
def local_time_off_utc():
    """Local time five hours behind UTC, so a time read as local rather than as UTC is caught
    on a UTC host such as CI too (POSIX only: elsewhere the host's own zone stands)."""
    tzset = getattr(time, "tzset", lambda: None)
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("TZ", "EST5")  # POSIX TZ syntax: "EST", five hours behind UTC, no DST
        tzset()
        yield
    tzset()


@pytest.mark.usefixtures("local_time_off_utc")
@pytest.mark.parametrize("zone", ["GMT", "-0000"])
def test_retry_after_http_date_is_seconds_from_now(zone):
    # An HTTP-date an hour ahead is about 3600 s away. "-0000" is RFC 5322's "UTC, source zone
    # unknown", which parses to a naive time that must be read as UTC, not as local time.
    in_an_hour = datetime.now(timezone.utc) + timedelta(hours=1)
    header = format_datetime(in_an_hour, usegmt=True).replace("GMT", zone)
    secs = http_client._parse_retry_after(header)
    # The date carries whole seconds, which can only shorten the wait; the lower bound leaves
    # slack for a slow machine.
    assert secs is not None and 3500 < secs <= 3600


# ------------------------------------------------------------------------- #
# _request — retry, backoff, concurrency, per-attempt deadline
# ------------------------------------------------------------------------- #

URL = f"{LW}/x"


def _req(url=URL, method="GET"):
    return httpx.Request(method, url)


# A canned item for an attempt the server never answers.
_NO_ANSWER = object()


class _FakeClient:
    """Async client stub: each call pops the next canned item — an httpx.Response to
    return, an Exception to raise, or _NO_ANSWER to wait forever."""

    def __init__(self, items):
        self._items = list(items)
        self.calls = 0

    async def request(self, method, url, headers=None, **kwargs):
        self.calls += 1
        item = self._items.pop(0)
        if item is _NO_ANSWER:
            await asyncio.Event().wait()
        if isinstance(item, BaseException):
            raise item
        return item


def _install(patch_io, patch_sleep, items, *, max_retries=2):
    """Point `_request` at a fake client + fresh semaphore, with MAX_RETRIES pinned so an
    LW_MAX_RETRIES in the developer's environment can't change the outcome. `patch_sleep`
    (the shared fixture) has already stubbed backoff sleeps and is the `slept` list returned
    here."""
    patch_io("MAX_RETRIES", max_retries)
    client = _FakeClient(items)

    def fake_resources():
        return client, asyncio.Semaphore(config._CONCURRENCY_LIMIT)

    patch_io("_resources", fake_resources)
    return client, patch_sleep


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_retryable_status_is_retried(status, patch_io, patch_sleep, run):
    client, slept = _install(patch_io, patch_sleep, [
        httpx.Response(status, request=_req()),
        httpx.Response(200, request=_req()),
    ])
    assert run(http_client._request("GET", URL)).status_code == 200
    assert client.calls == 2
    assert len(slept) == 1


@pytest.mark.parametrize("status", [400, 404, 406])
def test_non_retryable_status_is_returned_without_retrying(status, patch_io, patch_sleep, run):
    client, slept = _install(patch_io, patch_sleep, [httpx.Response(status, request=_req())])
    assert run(http_client._request("GET", URL)).status_code == status
    assert client.calls == 1
    assert slept == []


def test_gives_up_after_max_retries_and_returns_last_5xx(patch_io, patch_sleep, run, caplog):
    patch_io("_backoff", lambda attempt: float(attempt + 1))
    client, slept = _install(patch_io, patch_sleep, [httpx.Response(503, request=_req()) for _ in range(3)])
    with caplog.at_level(logging.WARNING, logger="lesswrong_mcp.http_client"):
        resp = run(http_client._request("GET", URL))
    assert resp.status_code == 503
    assert client.calls == 3
    # Self-computed backoff before each of the two retries (no Retry-After), by attempt index.
    assert slept == [1.0, 2.0]
    # One warning per retry, plus one when giving up.
    assert [r.levelno for r in caplog.records] == [logging.WARNING] * 3
    assert all("503" in r.getMessage() for r in caplog.records)


def test_max_retries_counts_retries(patch_io, patch_sleep, run):
    # MAX_RETRIES is the number of retries after the first attempt: 0 disables them.
    client, slept = _install(patch_io, patch_sleep, [httpx.Response(503, request=_req())], max_retries=0)
    assert run(http_client._request("GET", URL)).status_code == 503
    assert client.calls == 1
    assert slept == []

    client, _ = _install(
        patch_io, patch_sleep, [httpx.Response(503, request=_req()) for _ in range(3)], max_retries=2
    )
    assert run(http_client._request("GET", URL)).status_code == 503
    assert client.calls == 3


# 60 s is the documented ceiling (README), so the boundary is pinned as a literal rather than
# read back from _MAX_RETRY_AFTER.
@pytest.mark.parametrize(("status", "hint"), [(429, "1"), (503, "5"), (429, "60")])
def test_retry_after_up_to_sixty_seconds_is_slept_exactly(status, hint, patch_io, patch_sleep, run):
    client, slept = _install(patch_io, patch_sleep, [
        httpx.Response(status, headers={"retry-after": hint}, request=_req()),
        httpx.Response(200, request=_req()),
    ])
    assert run(http_client._request("GET", URL)).status_code == 200
    assert client.calls == 2
    assert slept == [float(hint)]  # the forum's Retry-After, unjittered


@pytest.mark.parametrize("hint", ["61", "3600"])
def test_retry_after_over_sixty_seconds_stops_retrying(hint, patch_io, patch_sleep, run, caplog):
    # A Retry-After longer than the client will wait means stop: retrying sooner would land
    # inside the window the forum asked to be left alone.
    client, slept = _install(patch_io, patch_sleep, [
        httpx.Response(429, headers={"retry-after": hint}, request=_req()),
        httpx.Response(200, request=_req()),
    ])
    with caplog.at_level(logging.WARNING, logger="lesswrong_mcp.http_client"):
        resp = run(http_client._request("GET", URL))
    assert resp.status_code == 429
    assert client.calls == 1
    assert slept == []
    assert any(hint in r.getMessage() for r in caplog.records if r.levelno == logging.WARNING)


def test_out_of_range_retry_after_date_falls_back_to_backoff(patch_io, patch_sleep, run):
    # A Retry-After that can't be read as a date counts as absent: the request retries on its
    # own backoff rather than failing.
    patch_io("_backoff", lambda attempt: 0.25 + attempt)
    client, slept = _install(patch_io, patch_sleep, [
        httpx.Response(503, headers={"retry-after": OUT_OF_RANGE_DATE}, request=_req()),
        httpx.Response(200, request=_req()),
    ])
    assert run(http_client._request("GET", URL)).status_code == 200
    assert client.calls == 2
    assert slept == [0.25]


def test_backoff_is_jittered_within_bounds():
    # Attempt 1024 is where an uncapped 0.5 * 2 ** attempt stops fitting in a float.
    for attempt, base in [(0, 0.5), (1, 1.0), (2, 2.0), (3, 4.0), (4, 8.0), (5, 8.0), (1024, 8.0)]:
        samples = [http_client._backoff(attempt) for _ in range(200)]
        assert all(0.5 * base <= s <= base for s in samples), attempt
        assert len(set(samples)) > 1, attempt


def test_transient_transport_error_is_retried_then_succeeds(patch_io, patch_sleep, run):
    patch_io("_backoff", lambda attempt: 0.75 + attempt)
    client, slept = _install(patch_io, patch_sleep, [
        httpx.ConnectError("boom"),
        httpx.Response(200, request=_req()),
    ])
    resp = run(http_client._request("GET", URL))
    assert resp.status_code == 200
    assert client.calls == 2
    assert slept == [0.75]  # transport retries back off through _backoff too


def test_persistent_timeout_raises_after_retries(patch_io, patch_sleep, run):
    client, _ = _install(patch_io, patch_sleep, [httpx.ConnectTimeout("t") for _ in range(3)])
    with pytest.raises(httpx.TimeoutException):
        run(http_client._request("GET", URL))
    assert client.calls == 3


def test_each_attempt_is_cut_off_at_the_total_timeout(patch_io, patch_sleep, run):
    # HTTP_TOTAL_TIMEOUT bounds one attempt's round-trip, not the retry loop, and its breach
    # surfaces as httpx's timeout type so it flows through _handle_error like any other.
    patch_io("MAX_RETRIES", 2)
    patch_io("HTTP_TOTAL_TIMEOUT", 0.01)
    attempts = 0

    class _SilentServer:
        async def request(self, method, url, **kwargs):
            nonlocal attempts
            attempts += 1
            await asyncio.Event().wait()  # never answers

    patch_io("_resources", lambda: (_SilentServer(), asyncio.Semaphore(config._CONCURRENCY_LIMIT)))
    with pytest.raises(httpx.TimeoutException, match="per-attempt") as exc:
        # The outer bound makes a missing deadline fail the test instead of hanging it.
        run(asyncio.wait_for(http_client._request("GET", URL), 5))
    assert attempts == 3  # the deadline is per attempt, so every retry runs
    assert "overall" not in str(exc.value)


def test_deadline_message_speaks_for_the_final_attempt_only(patch_io, patch_sleep, run):
    # Earlier attempts can fail some other way (here a refused connection, then a 503), so
    # the timeout raised for the last one claims nothing about them.
    patch_io("HTTP_TOTAL_TIMEOUT", 0.01)
    client, _ = _install(patch_io, patch_sleep, [
        httpx.ConnectError("refused"),
        httpx.Response(503, request=_req()),
        _NO_ANSWER,
    ])
    with pytest.raises(httpx.TimeoutException) as exc:
        run(asyncio.wait_for(http_client._request("GET", URL), 5))
    assert client.calls == 3
    assert str(exc.value) == "The final attempt exceeded the 0.01s per-attempt deadline."


def test_in_flight_requests_never_exceed_the_concurrency_limit(forum, run):
    # The calls must really interleave on the event loop, so this test takes neither
    # patch_sleep nor spy_sleep, which replace asyncio.sleep.
    limit = config._CONCURRENCY_LIMIT
    in_flight = peak = 0
    gate: asyncio.Event | None = None

    async def handler(request):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        try:
            await gate.wait()
        finally:
            in_flight -= 1
        return httpx.Response(200, text="ok")

    forum(handler)

    async def scenario():
        nonlocal gate
        gate = asyncio.Event()
        calls = [asyncio.ensure_future(http_client._get_markdown("lesswrong", f"/api/post/p{i}"))
                 for i in range(limit + 3)]
        # Let every call that can take a slot reach the transport, then give any call that
        # should be queued the same chance to slip past the limit.
        for _ in range(1000):
            if in_flight >= limit:
                break
            await asyncio.sleep(0)
        for _ in range(20):
            await asyncio.sleep(0)
        gate.set()
        return await asyncio.wait_for(asyncio.gather(*calls), 5)

    bodies = run(scenario())
    assert peak == limit
    assert bodies == ["ok"] * (limit + 3)


@pytest.mark.parametrize(
    "failure",
    [httpx.Response(503, request=_req()), httpx.ConnectError("connection reset")],
    ids=["retryable-status", "transport-error"],
)
def test_backoff_sleep_holds_no_concurrency_slot(failure, patch_io, spy_sleep, run):
    # With a single slot, the semaphore is locked during the sleep only if this call kept it.
    patch_io("MAX_RETRIES", 2)
    sem = asyncio.Semaphore(1)
    client = _FakeClient([failure, httpx.Response(200, request=_req())])
    patch_io("_resources", lambda: (client, sem))
    locked_while_sleeping: list[bool] = []
    spy_sleep(lambda delay: locked_while_sleeping.append(sem.locked()))
    # The outer bound turns a slot that is never given back into a failure, not a hang.
    assert run(asyncio.wait_for(http_client._request("GET", URL), 5)).status_code == 200
    assert locked_while_sleeping == [False]


def test_retry_after_the_pooled_client_closes_uses_a_replacement(forum, patch_io, patch_sleep, run):
    patch_io("MAX_RETRIES", 2)
    pool: dict = {}

    async def handler(request):
        first = pool["first"]
        if not first.is_closed:
            # The pooled client is closed under this in-flight attempt, which then fails.
            await first.aclose()
            raise httpx.ConnectError("connection reset")
        return httpx.Response(200, text="ok")

    seen = forum(handler)

    async def scenario():
        pool["first"], _ = http_client._resources()
        return await http_client._get_markdown("lesswrong", "/api/post/abc")

    # Bounded: a concurrency slot the failed attempt fails to release would block the retry
    # on acquire forever, which this turns into a failure instead of a hang.
    assert run(asyncio.wait_for(scenario(), 5)) == "ok"
    assert len(seen) == 2


def test_retry_warnings_are_logged_without_query(patch_io, patch_sleep, run, caplog):
    _install(patch_io, patch_sleep, [
        httpx.Response(503, request=_req()),
        httpx.Response(200, request=_req()),
    ])
    with caplog.at_level(logging.DEBUG):
        run(http_client._request("GET", f"{LW}/api/search?search=secret"))
    warnings = [r for r in caplog.records
                if r.name == "lesswrong_mcp.http_client" and r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "/api/search" in warnings[0].getMessage() and "503" in warnings[0].getMessage()
    assert not any("secret" in r.getMessage() for r in caplog.records)
    # httpx logs each request URL, query string included, at INFO.
    assert logging.getLogger("httpx").level == logging.WARNING


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
    out = run(http_client._get_markdown("alignmentforum", "/api/post/x", {"limit": 5, "page": 0, "sort": None}))
    assert out == "# ok"
    assert seen["method"] == "GET"
    assert seen["url"] == "https://www.alignmentforum.org/api/post/x"
    assert seen["headers"]["Accept"] == "text/markdown, */*"
    # Only the None-valued 'sort' is dropped before the call; a falsy page 0 is a real value.
    assert seen["params"] == {"limit": 5, "page": 0}


def test_get_markdown_raises_for_error_status(patch_io, run):
    fake_request, _ = _request_recorder(status=406)
    patch_io("_request", fake_request)
    with pytest.raises(httpx.HTTPStatusError):
        run(http_client._get_markdown("lesswrong", "/api/post/x"))


# ------------------------------------------------------------------------- #
# _block_offsite_redirect — the SSRF guard
# ------------------------------------------------------------------------- #

def _redirect(location, *, from_url="https://www.lesswrong.com/posts/abc", status=301):
    return httpx.Response(status, headers={"location": location}, request=httpx.Request("GET", from_url))


def test_same_host_relative_redirect_is_allowed(run):
    # The canonical slug -> id redirect the API itself issues: stays on the forum host.
    run(http_client._block_offsite_redirect(_redirect("/posts/abc/the-canonical-slug")))  # no raise


def test_cross_host_redirect_to_other_forum_is_allowed(run):
    # Both forum hosts are allow-listed, so a hop between them is fine.
    run(http_client._block_offsite_redirect(_redirect("https://www.alignmentforum.org/posts/abc")))  # no raise


def test_offsite_redirect_to_metadata_address_is_blocked(run):
    # The SSRF case: a redirect to a link-local metadata address must be refused.
    with pytest.raises(errors.ForumAPIError) as exc:
        run(http_client._block_offsite_redirect(_redirect("http://169.254.169.254/latest/meta-data/")))
    assert "169.254.169.254" in str(exc.value)


@pytest.mark.parametrize(
    "location",
    ["https://xn--www-lesswrong-.com/x", "https://xn--/x"],
    ids=["invalid-punycode", "empty-punycode"],
)
def test_redirect_to_a_host_that_is_not_valid_idna_is_refused(location, run):
    # Such a host can't be decoded for display, and is refused like any other off-forum one.
    with pytest.raises(errors.ForumAPIError, match="Refused to follow a redirect off the forum"):
        run(http_client._block_offsite_redirect(_redirect(location)))


def test_redirect_host_case_and_explicit_port_are_normalised(run):
    run(http_client._block_offsite_redirect(_redirect("https://WWW.LessWrong.com:443/posts/abc")))  # no raise


def test_offsite_redirect_to_arbitrary_host_is_blocked(run):
    with pytest.raises(errors.ForumAPIError):
        run(http_client._block_offsite_redirect(_redirect("https://evil.example.com/steal")))


def test_non_redirect_response_is_ignored_even_with_location_header(run):
    # A 200 that happens to carry a Location header is not a redirect and must be a no-op.
    resp = httpx.Response(200, headers={"location": "http://evil.example.com"},
                          request=httpx.Request("GET", "https://www.lesswrong.com/x"))
    run(http_client._block_offsite_redirect(resp))  # no raise


def _follow(location, run):
    """GET https://www.lesswrong.com/start through a real AsyncClient carrying the guard,
    where /start redirects to `location` and anything else answers 200. Returns the URLs the
    transport was asked for and the response or the raised exception."""
    requested: list[str] = []

    def handler(request):
        requested.append(str(request.url))
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": location})
        return httpx.Response(200, text="ok")

    async def go():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            follow_redirects=True,
            event_hooks={"response": [http_client._block_offsite_redirect]},
        ) as client:
            try:
                return await client.get("https://www.lesswrong.com/start")
            except errors.ForumAPIError as exc:
                return exc

    return requested, run(go())


def test_redirect_guard_pins_scheme_and_port(run, caplog):
    start = "https://www.lesswrong.com/start"
    # A plaintext downgrade and a non-default port both stay on a forum host, yet neither is
    # the forum's HTTPS origin: refused before the hop is requested.
    for location in ("http://www.lesswrong.com/x", "https://www.lesswrong.com:8443/x"):
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="lesswrong_mcp.http_client"):
            requested, outcome = _follow(location, run)
        assert isinstance(outcome, errors.ForumAPIError), location
        assert requested == [start], location
        assert [r.levelno for r in caplog.records] == [logging.WARNING], location

    requested, outcome = _follow("https://www.alignmentforum.org/x", run)
    assert isinstance(outcome, httpx.Response) and outcome.status_code == 200
    assert requested == [start, "https://www.alignmentforum.org/x"]

    requested, outcome = _follow("http://[::1", run)
    assert isinstance(outcome, errors.ForumAPIError)
    assert str(outcome) == "Refused a malformed redirect from the forum."
    assert requested == [start]


# ------------------------------------------------------------------------- #
# per-loop client/semaphore lifecycle
# ------------------------------------------------------------------------- #

def test_resources_are_per_loop_singletons_with_ssrf_hook_and_clean_up(run):
    async def scenario():
        client, sem = http_client._resources()
        # Same loop -> the pooled client + semaphore are created once and reused.
        again_c, again_s = http_client._resources()
        assert again_c is client and again_s is sem
        assert isinstance(sem, asyncio.Semaphore)
        # The SSRF guard is wired as a response event hook on the pooled client.
        assert http_client._block_offsite_redirect in client.event_hooks["response"]
        # The running loop has an entry while the client lives...
        loop = asyncio.get_running_loop()
        assert loop in http_client._LOOP_RESOURCES
        # ...and _aclose_client drops that entry and closes the client.
        await http_client._aclose_client()
        assert loop not in http_client._LOOP_RESOURCES
        return client

    client = run(scenario())
    assert client.is_closed


def test_aclose_client_is_a_noop_when_no_client_exists(run):
    # A loop that never called _resources() has nothing to close -> no KeyError.
    async def scenario():
        loop = asyncio.get_running_loop()
        assert loop not in http_client._LOOP_RESOURCES
        await http_client._aclose_client()  # must not raise

    run(scenario())


def test_resources_replace_a_closed_client(run):
    async def scenario():
        client, sem = http_client._resources()
        await client.aclose()
        replacement, again_sem = http_client._resources()
        try:
            assert replacement is not client
            assert not replacement.is_closed
            # The semaphore is kept, so callers already queued on it stay counted.
            assert again_sem is sem
        finally:
            await http_client._aclose_client()

    run(scenario())


# ------------------------------------------------------------------------- #
# a proxy URL httpx can't parse
# ------------------------------------------------------------------------- #

def test_a_proxy_url_that_will_not_parse_keeps_its_password_out_of_the_error(monkeypatch, call_tool, caplog):
    # An unescaped '#' ends the authority early, so httpx's parse error would quote the start of
    # the password as the port it choked on. The funnel reports the neutral message and nothing
    # logs the error's text.
    monkeypatch.setenv("HTTPS_PROXY", "http://alice:Tr0ub4dor#3@proxy.example:8080")
    with caplog.at_level(logging.DEBUG):
        result = call_tool("lw_get_tag", {"slug": "ai"})
    assert result.content[0].text == "Error executing tool lw_get_tag: Could not build a valid forum URL."
    assert "Tr0ub4dor" not in caplog.text


# ------------------------------------------------------------------------- #
# on the wire: tool -> _get_markdown / _graphql -> _request -> pooled client
# ------------------------------------------------------------------------- #

def test_search_request_on_the_wire(forum, call_tool):
    body = "# Search\n\n## Posts (0 total)\n"
    seen = forum(lambda request: httpx.Response(200, text=body))
    query = "mesa & optimization #2"  # characters a hand-built query string would mangle
    result = call_tool("lw_search", {"query": query, "page": 1, "limit": 7})
    assert result.is_error is False
    assert result.content[0].text.startswith(body)
    [request] = seen
    assert request.method == "GET"
    assert str(request.url.copy_with(query=None)) == f"{LW}/api/search"
    # Page 1 travels as the backend's zero-based page 0, a falsy value that must not be dropped.
    assert dict(request.url.params) == {"search": query, "page": "0", "limit": "7"}
    assert request.headers["accept"] == "text/markdown, */*"
    assert request.headers["user-agent"] == config.USER_AGENT


def test_filter_posts_request_on_the_wire(forum, call_tool):
    seen = forum(lambda request: httpx.Response(200, json={"data": {"posts": {"results": []}}}))
    result = call_tool("lw_filter_posts", {"offset": 40})
    assert result.is_error is False
    [request] = seen
    assert (request.method, str(request.url)) == ("POST", f"{LW}/graphql")
    assert request.headers["content-type"] == "application/json"
    assert request.headers["accept"] == "application/json"
    assert request.headers["user-agent"] == config.USER_AGENT
    payload = json.loads(request.content)
    assert set(payload) == {"query", "variables"}
    assert payload["variables"]["offset"] == 40


def test_a_pattern_valid_slug_reaches_the_wire_unchanged(forum, call_tool):
    # Every character the identifier pattern allows is one a URL path carries as itself, so the
    # slug goes out exactly as given: case, '_' and '-' kept, nothing escaped.
    seen = forum(lambda request: httpx.Response(200, text="# A user"))
    result = call_tool("lw_get_user", {"slug": "a_b-C", "site": "alignmentforum"})
    assert result.is_error is False
    [request] = seen
    assert str(request.url) == f"{config.SITE_BASE_URLS['alignmentforum']}/api/user/a_b-C"


def test_same_host_redirect_is_followed(forum, call_tool):
    # The API's own slug -> canonical-id redirect.
    def handler(request):
        if request.url.path == "/api/post/some-slug":
            return httpx.Response(301, headers={"location": "/api/post/RuGZ5tMdqpnraJahJ"})
        return httpx.Response(200, text="# The post")

    seen = forum(handler)
    result = call_tool("lw_get_post", {"id_or_slug": "some-slug"})
    assert result.is_error is False
    assert result.content[0].text.startswith("# The post")
    assert [r.url.path for r in seen] == ["/api/post/some-slug", "/api/post/RuGZ5tMdqpnraJahJ"]


def test_offsite_redirect_is_refused_before_the_hop(forum, call_tool, patch_io):
    # The refusal is final: it is neither followed nor retried, and the caller gets a tool error.
    patch_io("MAX_RETRIES", 2)
    seen = forum(lambda request: httpx.Response(
        302, headers={"location": "http://169.254.169.254/latest/meta-data/"}))
    result = call_tool("lw_get_post", {"id_or_slug": "some-slug"})
    assert result.is_error is True
    assert "Refused to follow a redirect" in result.content[0].text
    assert [str(r.url) for r in seen] == [f"{LW}/api/post/some-slug"]


# ------------------------------------------------------------------------- #
# the suite's network guard (tests/conftest.py's `_offline`)
# ------------------------------------------------------------------------- #

def test_an_unstubbed_request_fails_the_test(run):
    # The guard raises past _request's retries and the tool error funnel, so a test that
    # forgets its stub fails instead of passing on a plausible tool error.
    url = f"{config.SITE_BASE_URLS['lesswrong']}/api/tag/ai"
    with pytest.raises(pytest.fail.Exception, match=re.escape(f"unstubbed network call: GET {url}")):
        run(m.lw_get_tag("ai"))


def test_an_off_host_connection_fails_the_test_and_loopback_does_not():
    # Anything that bypasses httpx meets the guard at the socket; loopback stays usable.
    with socket.socket() as server, socket.socket() as local, socket.socket() as remote:
        server.bind(("127.0.0.1", 0))
        server.listen()
        local.connect(server.getsockname())
        remote.settimeout(1)
        refused = re.escape("unstubbed network call: connect to ('192.0.2.1', 443)")
        with pytest.raises(pytest.fail.Exception, match=refused):
            remote.connect(("192.0.2.1", 443))  # TEST-NET-1: reserved, never a real host
