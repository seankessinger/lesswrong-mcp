"""Shared test scaffolding: the async runner, the fake forum, the guard that keeps the suite
offline, and the gate for the opt-in live tests.

The suite has no pytest-asyncio: each test drives its coroutines with `asyncio.run` (the `run`
fixture). Hermetic tests fake the forum at the transport (`fake_forum`), so the real pooled
client, its headers, retries and redirect guard stay under test. The autouse `_offline` guard
fails any test that reaches the real network anyway, unless the test is marked `live`.
"""
from __future__ import annotations

import asyncio
import functools
import importlib
import inspect
import ipaddress
import os
import socket

import httpx
import pytest


def _forum():
    """The module that owns all network I/O. Imported when a fixture needs it, so the
    packaging tests run without it."""
    return importlib.import_module("lesswrong_mcp.forum")


# Only an explicit yes turns the live tests on, so LW_LIVE_TESTS=0 or =false keeps the run offline.
_LIVE_TESTS = os.environ.get("LW_LIVE_TESTS", "").strip().lower() in {"1", "true", "yes"}


def pytest_collection_modifyitems(config, items):
    """Skip every test marked `live` unless LW_LIVE_TESTS is an explicit yes."""
    if _LIVE_TESTS:
        return
    skip = pytest.mark.skip(reason="network test; set LW_LIVE_TESTS=1 to run")
    for item in items:
        if item.get_closest_marker("live"):
            item.add_marker(skip)


# httpx reads these whenever a client is built (proxies and CA bundle), and the ssl module reads
# SSLKEYLOGFILE, so a developer's environment would otherwise decide whether a test passes.
_CLIENT_ENV = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "SSLKEYLOGFILE",
)


def _leaves_the_host(sock: socket.socket, address) -> bool:
    """True for an IP connection to anything but loopback."""
    if sock.family not in (socket.AF_INET, socket.AF_INET6):
        return False
    host = address[0]
    try:
        return not ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host != "localhost"


@pytest.fixture(autouse=True)
def _offline(request, monkeypatch):
    """Keep every test not marked `live` off the network: a request that reaches httpx's real
    transport, or a socket connecting off the machine, fails the test at once. pytest.fail
    raises a BaseException, so neither the retry loop nor the tool error funnel can turn it
    into a plausible tool error."""
    if request.node.get_closest_marker("live"):
        return
    for name in _CLIENT_ENV:
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.lower(), raising=False)

    async def refuse_request(self, req):
        pytest.fail(f"unstubbed network call: {req.method} {req.url}", pytrace=False)

    connect = socket.socket.connect

    def refuse_connect(self, address):
        if _leaves_the_host(self, address):
            pytest.fail(f"unstubbed network call: connect to {address!r}", pytrace=False)
        return connect(self, address)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse_request)
    monkeypatch.setattr(socket.socket, "connect", refuse_connect)


@pytest.fixture
def run():
    """Drive a coroutine to completion."""
    return asyncio.run


@pytest.fixture(params=["legacy", "auto"], ids=["2025-11-25", "2026-07-28"])
def protocol_era(request) -> str:
    """The two protocol eras a client can negotiate, as the `Client(mode=...)` that reaches
    each: the 2025-11-25 initialize handshake, and the 2026-07-28 per-request path."""
    return request.param


@pytest.fixture
def call_tool(protocol_era, run):
    """Call a tool through a real in-process MCP client, once per protocol era, and return
    the CallToolResult the client receives."""
    from mcp.client import Client

    import lesswrong_mcp

    def _call(name: str, args: dict):
        async def scenario():
            async with Client(lesswrong_mcp.mcp, mode=protocol_era) as client:
                return await client.call_tool(name, args)
        return run(scenario())
    return _call


@pytest.fixture
def listed_tool(run):
    """One tool as the server lists it to a client."""
    import lesswrong_mcp

    def _lookup(name: str):
        return next(t for t in run(lesswrong_mcp.mcp.list_tools()) if t.name == name)
    return _lookup


@pytest.fixture
def tool_schema(listed_tool):
    """The JSON input schema the server advertises for one tool."""
    def _schema(name: str) -> dict:
        return listed_tool(name).input_schema
    return _schema


@pytest.fixture
def patch_sleep(monkeypatch):
    """Record the network layer's backoff sleeps instead of sleeping, returning the list. It
    patches the global asyncio.sleep, so a test that needs real event-loop yields must not
    take it."""
    slept: list[float] = []

    async def fake_sleep(delay):
        slept.append(delay)

    monkeypatch.setattr(_forum().asyncio, "sleep", fake_sleep)
    return slept


@pytest.fixture
def fake_forum(monkeypatch):
    """Serve the pooled client's traffic from `handler(request)` (sync or async) through
    httpx.MockTransport, and return the list of requests it received. Only the transport is
    faked: the real client, User-Agent, redirect guard and concurrency cap stay under test.
    Each `run` starts a fresh loop, and so a fresh pooled client built under the patch."""
    forum = _forum()

    def install(handler):
        seen: list[httpx.Request] = []

        async def record(request):
            seen.append(request)
            result = handler(request)
            return await result if inspect.isawaitable(result) else result

        monkeypatch.setattr(
            forum.httpx, "AsyncClient",
            functools.partial(forum.httpx.AsyncClient, transport=httpx.MockTransport(record)),
        )
        return seen

    return install


@pytest.fixture
def live_run(run):
    """Drive a live test's coroutine, then close the pooled client its requests opened."""
    forum = _forum()

    def _run(coro):
        async def closing():
            try:
                return await coro
            finally:
                await forum.close()
        return run(closing())
    return _run
