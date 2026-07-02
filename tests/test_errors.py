"""Tests for the 404 error strings: a document-lookup tool names the subject and echoes
the caller's identifier, while a non-lookup tool keeps the generic handler, and other
statuses are untouched.

Hermetic: `_get_markdown` is stubbed (via the shared `patch_io` seam) to raise a status
error without any network.
"""
from __future__ import annotations

import httpx
import pytest

import lesswrong_mcp as m


def _raise_status(patch_io, code):
    async def fake_get_markdown(site, path, params=None):
        req = httpx.Request("GET", "https://www.lesswrong.com" + path)
        raise httpx.HTTPStatusError(
            "err", request=req, response=httpx.Response(code, request=req)
        )

    patch_io("_get_markdown", fake_get_markdown)


@pytest.mark.parametrize(
    "tool_name, arg, subject",
    [
        ("lw_get_post", "badid", "post"),
        ("lw_get_comments", "badid", "post"),
        ("lw_get_user", "no-such-user", "user"),
        ("lw_get_tag", "no-such-tag", "tag"),
        ("lw_get_sequence", "no-such-seq", "sequence"),
    ],
)
def test_404_names_subject_and_echoes_value(patch_io, run, tool_name, arg, subject):
    _raise_status(patch_io, 404)
    out = run(getattr(m, tool_name)(arg))
    assert out == (
        f"Error: no {subject} found for {arg!r} (404). Pass a valid {subject} _id or slug."
    )


@pytest.mark.parametrize("tool_name, subject", [("lw_get_tag", "tag"), ("lw_get_user", "user")])
def test_404_display_name_hints_the_slug(patch_io, run, tool_name, subject):
    # A tag/user lookup given a display name (space or uppercase) gets a nudge toward the
    # lowercase-hyphenated slug, derived from the value itself.
    _raise_status(patch_io, 404)
    out = run(getattr(m, tool_name)("Mesa Optimization"))
    assert out.startswith(f"Error: no {subject} found for 'Mesa Optimization' (404).")
    assert "display name" in out and "mesa-optimization" in out


def test_404_clean_slug_gets_no_hint(patch_io, run):
    # A value that already looks like a slug must not get the misleading display-name hint.
    _raise_status(patch_io, 404)
    out = run(m.lw_get_tag("mesa-optimization"))
    assert out.endswith("Pass a valid tag _id or slug.")


def test_404_url_form_gets_no_display_name_hint(patch_io, run):
    # A pasted URL (an accepted input form) that 404s must not be mislabeled a "display name"
    # nor get a bogus lowercased-full-URL example slug — even when its slug segment has caps.
    _raise_status(patch_io, 404)
    out = run(m.lw_get_tag("https://www.lesswrong.com/w/Mesa-Optimization"))
    assert "display name" not in out
    assert out.endswith("Pass a valid tag _id or slug.")


def test_non_lookup_tool_keeps_generic_404(patch_io, run):
    # lw_list_feed looks nothing up by id/slug, so its 404 stays the generic message.
    _raise_status(patch_io, 404)
    out = run(m.lw_list_feed())
    assert out == "Error: Not found (404). Double-check the post id / user slug / tag slug."


def test_other_status_is_unaffected(patch_io, run):
    _raise_status(patch_io, 406)
    out = run(m.lw_get_post("whatever"))
    assert out == "Error: No Markdown version exists for that route (406)."


def test_transport_error_gives_generic_message_without_class_name():
    # A non-timeout transport failure gets a generic message; the httpx class name must
    # never leak through the catch-all branch.
    out = m._handle_error(httpx.ConnectError("boom"))
    assert out == "Error: Could not reach the forum API (network error). Try again."
    assert "ConnectError" not in out


def test_persistent_transport_error_through_tool_funnel(patch_io, run):
    # _tool_errors catches httpx.TransportError, so a persistent ConnectError surfaces as
    # the generic network message rather than an isError fault or a leaked class name.
    async def fake_get_markdown(site, path, params=None):
        raise httpx.ConnectError("boom")

    patch_io("_get_markdown", fake_get_markdown)
    out = run(m.lw_get_post("x"))
    assert out == "Error: Could not reach the forum API (network error). Try again."
