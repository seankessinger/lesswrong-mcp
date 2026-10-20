"""The packaging files agree with each other: pyproject.toml, manifest.json."""
from __future__ import annotations

import json
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def pyproject() -> dict:
    return tomllib.loads((ROOT / "pyproject.toml").read_text())


def manifest() -> dict:
    return json.loads((ROOT / "manifest.json").read_text())


def test_version_is_3_0_0_in_pyproject_and_manifest():
    assert pyproject()["project"]["version"] == manifest()["version"] == "3.0.0"


def test_display_name_has_no_slash():
    # Claude Desktop builds a log path from display_name, and a "/" fails its path-escape guard.
    assert "/" not in manifest()["display_name"]


def test_manifest_python_range_matches_pyproject():
    assert manifest()["compatibility"]["runtimes"]["python"] == pyproject()["project"]["requires-python"]


def test_manifest_tools_match_registered():
    import asyncio

    import lesswrong_mcp
    registered = {t.name for t in asyncio.run(lesswrong_mcp.mcp.list_tools())}
    assert {t["name"] for t in manifest()["tools"]} == registered


def test_python_m_launcher_answers_initialize_quietly():
    # How the bundle starts the server: one initialize line in, one reply out, exit at end of
    # input, and nothing on stderr (Desktop shows stderr in its server log).
    import subprocess
    import sys
    request = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}}
    done = subprocess.run([sys.executable, "-m", "lesswrong_mcp"], input=json.dumps(request) + "\n",
                          capture_output=True, text=True, timeout=60)
    reply = json.loads(done.stdout.splitlines()[0])
    assert done.returncode == 0 and reply["id"] == 1 and "result" in reply
    assert done.stderr == ""
