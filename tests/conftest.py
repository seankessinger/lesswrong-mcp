"""Shared hermetic-test scaffolding: the async runner and the network-I/O patch seams,
centralized so relocating the I/O layer is a one-line edit rather than a sweep across files.

Every test drives the async tool/handler coroutines with `asyncio.run` (the suite carries no
pytest-asyncio) and stays offline by monkeypatching the I/O functions on the module that owns
them — `lesswrong_mcp.http_client`, named once as `IO_HOME` below. This works only because
every caller reaches those functions THROUGH that module (`http_client._get_markdown(...)`)
rather than importing them by value; keep it that way when adding code.
"""
from __future__ import annotations

import asyncio

import pytest

from lesswrong_mcp import graphql_resolve, http_client

# The module that owns the network-I/O functions the hermetic suite patches
# (_get_markdown / _graphql / _request / _resources) and the `asyncio` it backs off through.
# The I/O layer lives in `lesswrong_mcp.http_client`, and the callers (the tools and the slug
# resolvers) reach it THROUGH that module, so patching http_client is seen. This is the single
# patch target; repoint this ONE name if the I/O layer ever moves again.
IO_HOME = http_client


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
def patch_sleep(monkeypatch):
    """Record backoff sleeps instead of sleeping, returning the `slept` list. Patches
    `sleep` on the asyncio the HTTP layer reaches through (IO_HOME.asyncio), so relocating
    that import needs only the IO_HOME edit above."""
    slept: list[float] = []

    async def fake_sleep(delay):
        slept.append(delay)

    monkeypatch.setattr(IO_HOME.asyncio, "sleep", fake_sleep)
    return slept


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
