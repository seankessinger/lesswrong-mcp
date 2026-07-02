"""Characterization tests for the per-event-loop HTTP lifecycle the split will relocate to
http_client: `_resources` (pooled client + semaphore creation and the wired SSRF hook),
`_aclose_client` (loop teardown), and `_lifespan`'s close-only-in-stdio behaviour.

These pin the contract on the current single module BEFORE the extraction, so a silent
regression there — a dropped SSRF hook, a per-request client close in HTTP mode, a leaked
loop entry — fails loudly. Hermetic: creating an httpx.AsyncClient does no network.
"""
from __future__ import annotations

import asyncio

import lesswrong_mcp as m


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
