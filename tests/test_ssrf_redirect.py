"""Tests for `_block_offsite_redirect`, the SSRF guard httpx runs on every response before
issuing the next hop. It must permit the API's own same-host slug -> canonical redirects
but refuse any redirect whose target host leaves the two allow-listed forum hosts.

Hermetic: responses are constructed in-memory; nothing hits the network.
"""
from __future__ import annotations

import httpx
import pytest

import lesswrong_mcp as m


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
