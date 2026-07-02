"""Characterization tests for `_get_markdown`'s own body — the URL it builds, the Accept
header it sends, the None-valued param stripping, and raise_for_status — exercised THROUGH
the `_request` seam. Every tool test stubs `_get_markdown` away, so its body is otherwise
never run; these pin it before the http_client extraction moves it.

Hermetic: `_request` is stubbed via the shared `patch_io` seam.
"""
from __future__ import annotations

import httpx
import pytest

import lesswrong_mcp as m


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
