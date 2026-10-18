"""Tests for the server lifespan that closes the pooled HTTP client, and the
`python -m lesswrong_mcp` launcher.

The lifespan tests drive in-process clients; the launcher tests run the real stdio server in a
subprocess.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from mcp.client import Client

import lesswrong_mcp
from lesswrong_mcp import cli, http_client

_REPO_ROOT = Path(__file__).resolve().parent.parent


class _SessionFailed(Exception):
    pass


def _leaves(exc: BaseException) -> list[BaseException]:
    """The exceptions inside `exc`, through any exception groups (the legacy client's task
    group wraps what its session raises)."""
    nested = getattr(exc, "exceptions", None)
    return [leaf for sub in nested for leaf in _leaves(sub)] if nested else [exc]


@pytest.mark.parametrize("fail", [False, True], ids=["clean-exit", "session-error"])
def test_lifespan_closes_the_pooled_client_when_a_connection_ends(forum, run, protocol_era, fail):
    # An in-process client enters the server's lifespan for its connection, as the stdio
    # transport does for the process: the pooled client a tool call opened is closed on the
    # way out, an error included.
    forum(lambda request: httpx.Response(200, text="# ai\n"))
    opened: list = []

    async def scenario():
        async with Client(lesswrong_mcp.mcp, mode=protocol_era) as client:
            assert (await client.call_tool("lw_get_tag", {"slug": "ai"})).is_error is False
            opened.append(http_client._resources()[0])
            if fail:
                raise _SessionFailed

    if fail:
        with pytest.raises(Exception) as exc:
            run(scenario())
        assert any(isinstance(leaf, _SessionFailed) for leaf in _leaves(exc.value))
    else:
        run(scenario())
    assert len(opened) == 1 and opened[0].is_closed


def test_stdio_server_closes_the_pooled_client_when_stdin_ends():
    # The real stdio transport, in a process whose stdin is at EOF: main() serves, the session
    # ends, and the lifespan closes the pooled client (traced on stderr) before a clean exit.
    script = (
        "import sys\n"
        "from lesswrong_mcp import cli, http_client\n"
        "close = http_client._aclose_client\n"
        "async def traced():\n"
        "    print('pooled client closed', file=sys.stderr)\n"
        "    await close()\n"
        "http_client._aclose_client = traced\n"
        "cli.main()\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", script],
        cwd=_REPO_ROOT, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60,
    )
    assert out.returncode == 0, out.stderr
    assert out.stderr.count("pooled client closed") == 1


_INITIALIZE = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}})


def test_python_dash_m_serves_stdio():
    # Both launchers reach cli.main: the console script names the package's main, and
    # `python -m` runs __main__ in a real process that answers one initialize line on stdin
    # and exits cleanly at end of input.
    assert lesswrong_mcp.main is cli.main
    out = subprocess.run(
        [sys.executable, "-m", "lesswrong_mcp"], input=_INITIALIZE + "\n",
        env={**os.environ, "MCP_TRANSPORT": "bogus"},  # not read: stdio is the only transport
        cwd=_REPO_ROOT, capture_output=True, text=True, timeout=60,
    )
    assert out.returncode == 0, out.stderr
    [line] = out.stdout.splitlines()
    assert json.loads(line)["result"]["serverInfo"]["name"] == "lesswrong_mcp"
