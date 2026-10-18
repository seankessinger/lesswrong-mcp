"""Shared hermetic-test scaffolding: the async runner, the network-I/O patch seams, the guard
that keeps the suite offline and the gate for the opt-in live tests, centralized so relocating
the I/O layer is a one-line edit rather than a sweep across files.

Every test drives the async tool/handler coroutines with `asyncio.run` (the suite carries no
pytest-asyncio) and stays offline by monkeypatching the I/O functions on the module that owns
them — `lesswrong_mcp.http_client`, named once as `IO_HOME` below. This works only because
every caller reaches those functions THROUGH that module (`http_client._get_markdown(...)`)
rather than importing them by value; keep it that way when adding code. The autouse `_offline`
guard fails any test that reaches the real network anyway, unless the test is marked `live`.
"""
from __future__ import annotations

import asyncio
import functools
import inspect
import ipaddress
import os
import socket

import httpx
import pytest
from mcp.client import Client
from mcp.types import CallToolResult

import lesswrong_mcp
from lesswrong_mcp import graphql_resolve, http_client

# The module that owns the network-I/O functions the hermetic suite patches
# (_get_markdown / _graphql / _request / _resources), the `asyncio` it backs off through and the
# `httpx` it builds its pooled client from. The I/O layer lives in `lesswrong_mcp.http_client`,
# and the callers (the tools and the slug resolvers) reach it THROUGH that module, so patching
# http_client is seen. This is the single patch target; repoint this ONE name if the I/O layer
# ever moves.
IO_HOME = http_client


# The one switch for tests marked `live`, which reach the real forum. Only an explicit yes
# turns them on, so LW_LIVE_TESTS=0 or =false keeps the run offline.
_LIVE_TESTS = os.environ.get("LW_LIVE_TESTS", "").strip().lower() in {"1", "true", "yes"}


def pytest_collection_modifyitems(config, items):
    """Skip every test marked `live` unless LW_LIVE_TESTS is an explicit yes."""
    if _LIVE_TESTS:
        return
    skip = pytest.mark.skip(reason="network test; set LW_LIVE_TESTS=1 to run")
    for item in items:
        if item.get_closest_marker("live"):
            item.add_marker(skip)


# httpx reads these whenever a client is built (trust_env: proxies and CA bundle), and the ssl
# module reads SSLKEYLOGFILE, so a developer's proxy, CA bundle or key log would otherwise decide
# whether the tests that build the real pooled client pass.
_CLIENT_ENV = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "SSLKEYLOGFILE",
)


def _leaves_the_host(sock: socket.socket, address) -> bool:
    """True for an IP connection to anything but loopback. Loopback and Unix sockets stay on
    the machine (asyncio builds its self-pipe from a loopback connection on Windows)."""
    if sock.family not in (socket.AF_INET, socket.AF_INET6):
        return False
    host = address[0]
    try:
        return not ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host != "localhost"


@pytest.fixture(autouse=True)
def _offline(request, monkeypatch):
    """Keep every test that is not marked `live` off the network. A request that reaches
    httpx's real transport fails the test at once with its method and URL, and so does a
    socket.connect() to an off-host address, the backstop for a client that bypasses httpx
    (DNS lookups and connectionless sends are not intercepted). pytest.fail raises a
    BaseException, so neither _request's retry loop nor the tool error funnel can turn it into
    a plausible tool error. Tests that stub an I/O seam, or install their own transport, never
    get this far."""
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


@pytest.fixture(autouse=True)
def _clear_id_cache():
    """Reset the slug->_id resolution cache around every test, so a cached hit from one test
    can't suppress a resolution call another test asserts on (nor vice versa). Autouse, so
    every test stays hermetic w.r.t. the cache without opting in."""
    graphql_resolve._ID_CACHE.clear()
    yield
    graphql_resolve._ID_CACHE.clear()


@pytest.fixture
def run():
    """Drive an async handler to completion — the suite's single substitute for
    pytest-asyncio, which it deliberately does not depend on."""
    return asyncio.run


@pytest.fixture(params=["legacy", "auto"], ids=["2025-11-25", "2026-07-28"])
def protocol_era(request) -> str:
    """The two protocol eras a client can negotiate, as the `Client(mode=...)` that reaches
    each: "legacy" runs the 2025-11-25 initialize handshake over in-memory JSON-RPC streams,
    and "auto" (the default) discovers the server and takes the 2026-07-28 per-request path."""
    return request.param


@pytest.fixture
def call_tool(protocol_era, run):
    """Call a tool on `lesswrong_mcp.mcp` through a real in-process MCP client, once per
    protocol era, and return the CallToolResult — what a client actually receives (`isError`,
    the rendered text), as opposed to the bare coroutine's return value or exception."""
    def _call(name: str, args: dict) -> CallToolResult:
        async def scenario() -> CallToolResult:
            async with Client(lesswrong_mcp.mcp, mode=protocol_era) as client:
                return await client.call_tool(name, args)
        return run(scenario())
    return _call


@pytest.fixture
def listed_tool(run):
    """Look up one tool by name as the server lists it to a client — the advertised
    `inputSchema` and `description`. Listing is pure schema generation; it touches no
    network."""
    def _lookup(name: str):
        return next(t for t in run(lesswrong_mcp.mcp.list_tools()) if t.name == name)
    return _lookup


@pytest.fixture
def tool_schema(listed_tool):
    """The JSON input schema the server advertises for one tool (what a client validates
    arguments against)."""
    def _schema(name: str) -> dict:
        return listed_tool(name).input_schema
    return _schema


@pytest.fixture
def patch_io(monkeypatch):
    """Set an attribute on IO_HOME and return it — the single place a test names a
    network-I/O seam (`_get_markdown`, `_graphql`, `_request`, `_resources`), so relocating
    one is a one-line IO_HOME edit here, not a change at every call site."""
    def _patch(name, value):
        monkeypatch.setattr(IO_HOME, name, value)
        return value
    return _patch


@pytest.fixture
def spy_sleep(monkeypatch):
    """Replace the HTTP layer's backoff sleep with `probe(delay)`, which runs at the moment a
    retry would sleep and returns at once, so a test can inspect state mid-backoff. Patches
    `sleep` on the asyncio the HTTP layer reaches through (IO_HOME.asyncio), which is the
    global `asyncio.sleep`: a test that needs real event-loop yields must not use this or
    `patch_sleep`."""
    def install(probe):
        async def fake_sleep(delay):
            probe(delay)

        monkeypatch.setattr(IO_HOME.asyncio, "sleep", fake_sleep)

    return install


@pytest.fixture
def patch_sleep(spy_sleep):
    """Record backoff sleeps instead of sleeping, returning the `slept` list."""
    slept: list[float] = []
    spy_sleep(slept.append)
    return slept


@pytest.fixture
def forum(monkeypatch):
    """Serve the pooled client's traffic from `handler(request)` (sync or async) through
    httpx.MockTransport, and return the list of requests that reached the transport. Only the
    transport is faked: `_resources()` builds the real client and semaphore, so the
    User-Agent, redirect following, SSRF hook and concurrency cap stay under test. Patches
    `AsyncClient` on the httpx the HTTP layer reaches through (IO_HOME.httpx). Each `run`
    starts a fresh loop, and so a fresh pooled client built under the patch."""
    def install(handler):
        seen: list[httpx.Request] = []

        async def record(request):
            seen.append(request)
            result = handler(request)
            return await result if inspect.isawaitable(result) else result

        monkeypatch.setattr(
            IO_HOME.httpx, "AsyncClient",
            functools.partial(IO_HOME.httpx.AsyncClient, transport=httpx.MockTransport(record)),
        )
        return seen

    return install


@pytest.fixture
def markdown_stub(patch_io):
    """Install the common `_get_markdown` fake: return `text` and record each call.

    Returns a `captured` dict exposing the last call's `site`/`path`/`params` plus a
    `calls` list of every (site, path, params) — enough for both the route-assertion tool
    tests and the reached / not-reached guard tests."""
    def install(text=""):
        captured: dict = {"calls": []}

        async def fake_get_markdown(site, path, params=None):
            captured.update(site=site, path=path, params=params)
            captured["calls"].append((site, path, params))
            return text

        patch_io("_get_markdown", fake_get_markdown)
        return captured

    return install


@pytest.fixture
def live_run(run):
    """Drive a live test's coroutine to completion, then close the pooled client its
    requests opened, before asyncio.run closes the loop under it."""
    def _run(coro):
        async def closing():
            try:
                return await coro
            finally:
                await http_client._aclose_client()
        return run(closing())
    return _run
