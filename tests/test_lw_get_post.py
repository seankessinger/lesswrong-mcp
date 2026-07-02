"""Tests for lw_get_post's inline size control (max_chars / offset).

These are hermetic: `_slice_markdown` is pure, and the handler tests stub `_get_markdown`
via the shared `markdown_stub` fixture (see conftest) so nothing hits the network. The
point is that a very long post can be paged through inline (bounded response) without
changing the default full-post behaviour at all.
"""
from __future__ import annotations

import pytest

import lesswrong_mcp as m
from lesswrong_mcp import Site

BODY = "# Title\nby someone | karma: 42\n\n" + ("body paragraph. " * 400)  # ~6.4k chars


# --------------------------------------------------------------------------- #
# _slice_markdown (pure)
# --------------------------------------------------------------------------- #

def test_slice_noop_by_default():
    assert m._slice_markdown(BODY, 0, None) is BODY


def test_slice_full_fit_has_no_footer():
    # max_chars >= length -> whole text, no truncation footer.
    out = m._slice_markdown(BODY, 0, len(BODY) + 100)
    assert out == BODY


_FOOTER_SEP = "\n\n---\n[lw_get_post:"


def _body_of(page):
    """The post-content portion of a sliced page, with any footer annotation removed."""
    return page.split(_FOOTER_SEP, 1)[0]


def test_slice_cap_truncates_and_reports_next_offset():
    out = m._slice_markdown(BODY, 0, 1000)
    assert out.startswith("# Title")
    # The body is exactly the first 1000 chars — no rewriting/stripping.
    assert _body_of(out) == BODY[:1000]
    assert f"truncated at 1000 of {len(BODY)} characters" in out
    assert "offset=1000 to continue" in out


def test_slice_middle_page_notes_both_ends():
    out = m._slice_markdown(BODY, 1000, 1000)
    assert _body_of(out) == BODY[1000:2000]
    assert "continues from character 1000" in out
    assert "offset=2000 to continue" in out


def test_slice_tail_page_has_no_truncation_note():
    start = len(BODY) - 200
    out = m._slice_markdown(BODY, start, 1000)
    assert _body_of(out) == BODY[start:]
    assert f"continues from character {start}" in out
    assert "truncated at" not in out


def test_slice_offset_past_end():
    out = m._slice_markdown(BODY, len(BODY) + 5, None)
    assert "past the end" in out
    assert str(len(BODY)) in out


def test_slice_offset_zero_on_empty_post_returns_empty_not_error():
    # An empty body with an explicit cap returns empty, not an offset error.
    assert m._slice_markdown("", 0, 500) == ""


def test_slice_paging_reconstructs_byte_for_byte_across_whitespace_boundaries():
    # The invariant: following each page's reported offset reassembles the original text
    # exactly, even when slice boundaries fall on paragraph breaks or runs of whitespace.
    text = "Section one.\n\n## Section Two\n\n\n\nTrailing   spaces   here   \n\nEnd."
    for step in (1, 3, 5, 7, 13):
        rebuilt = ""
        offset = 0
        while offset < len(text):
            page = m._slice_markdown(text, offset, step)
            rebuilt += _body_of(page)
            offset += step
        assert rebuilt == text, f"reconstruction failed at step={step}"


def test_slice_all_whitespace_chunk_is_preserved():
    text = "AAAA" + " " * 20 + "BBBB"
    page = m._slice_markdown(text, 4, 20)
    assert _body_of(page) == " " * 20  # whitespace-only page keeps its content


# --------------------------------------------------------------------------- #
# lw_get_post handler wiring
# --------------------------------------------------------------------------- #

def test_get_post_default_returns_full_body(markdown_stub, run):
    markdown_stub(BODY)
    out = run(m.lw_get_post("somepostid", site=Site.lesswrong))
    assert out == BODY  # default behaviour unchanged: no truncation, no footer


def test_get_post_max_chars_caps_and_pages(markdown_stub, run):
    markdown_stub(BODY)
    page1 = run(m.lw_get_post("somepostid", max_chars=1000, site=Site.lesswrong))
    assert page1.startswith("# Title")
    assert "offset=1000 to continue" in page1

    page2 = run(m.lw_get_post("somepostid", max_chars=1000, offset=1000, site=Site.lesswrong))
    assert "continues from character 1000" in page2


def test_get_post_footer_is_labelled_for_this_tool(markdown_stub, run):
    markdown_stub(BODY)
    page = run(m.lw_get_post("somepostid", max_chars=1000, site=Site.lesswrong))
    assert "[lw_get_post:" in page


def test_get_post_has_no_compact_param(markdown_stub, run):
    # The `compact` knob is gone; passing it is a TypeError, not a silently-ignored arg.
    markdown_stub(BODY)
    with pytest.raises(TypeError):
        run(m.lw_get_post("somepostid", compact=True, site=Site.lesswrong))


# --------------------------------------------------------------------------- #
# _extract_post_ref: normalise a pasted URL / path down to the bare id/slug
# --------------------------------------------------------------------------- #

def test_extract_post_ref_forms():
    # A bare id or slug passes through untouched.
    assert m._extract_post_ref("RuGZ5tMdqpnraJahJ") == "RuGZ5tMdqpnraJahJ"
    assert m._extract_post_ref("my-post-slug") == "my-post-slug"
    # A full URL or /post(s)/<id>/<slug> path reduces to the id after the marker.
    assert m._extract_post_ref("https://www.lesswrong.com/posts/abc123/some-slug") == "abc123"
    assert m._extract_post_ref("/post/xyz789") == "xyz789"
    # A path with no recognised marker falls back to its last segment.
    assert m._extract_post_ref("foo/bar") == "bar"
