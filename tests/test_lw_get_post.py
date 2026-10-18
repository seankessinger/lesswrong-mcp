"""Tests for the inline size control (max_chars / offset) lw_get_post and lw_get_comments
share, and the pure `_slice_markdown` behind it.

These are hermetic: `_slice_markdown` is pure, and the tool tests stub `_get_markdown` via the
shared `markdown_stub` fixture (see conftest) so nothing hits the network. The point is that a
very long post or thread is paged through inline in bounded slices: no slice is longer than
`MAX_CHARS` characters, and the footers' offsets lead through the whole body.
"""
from __future__ import annotations

import functools
import re

import pytest
from mcp.server.mcpserver.exceptions import ToolError

import lesswrong_mcp as m
from lesswrong_mcp import config, markdown

BODY = "# Title\nby someone | karma: 42\n\n" + ("body paragraph. " * 400)  # ~6.4k chars
# _slice_markdown as lw_get_post calls it.
_slice = functools.partial(markdown._slice_markdown, label="lw_get_post")


# --------------------------------------------------------------------------- #
# _slice_markdown (pure)
# --------------------------------------------------------------------------- #

def test_slice_full_fit_has_no_footer():
    # max_chars >= length -> whole text, no truncation footer.
    out = _slice(BODY, 0, len(BODY) + 100)
    assert out == BODY


_FOOTER_SEP = "\n\n---\n[lw_get_post:"


def _body_of(page):
    """The post-content portion of a sliced page, with any footer annotation removed."""
    return page.split(_FOOTER_SEP, 1)[0]


def test_slice_cap_truncates_and_reports_next_offset():
    out = _slice(BODY, 0, 1000)
    assert out.startswith("# Title")
    # The body is exactly the first 1000 chars — no rewriting/stripping.
    assert _body_of(out) == BODY[:1000]
    assert f"truncated at 1000 of {len(BODY)} characters" in out
    assert "offset=1000 to continue" in out


def test_slice_middle_page_notes_both_ends():
    out = _slice(BODY, 1000, 1000)
    assert _body_of(out) == BODY[1000:2000]
    assert "continues from character 1000" in out
    assert "offset=2000 to continue" in out


def test_slice_tail_page_has_no_truncation_note():
    start = len(BODY) - 200
    out = _slice(BODY, start, 1000)
    assert _body_of(out) == BODY[start:]
    assert f"continues from character {start}" in out
    assert "truncated at" not in out


@pytest.mark.parametrize("beyond", [0, 5])
def test_slice_offset_past_end(beyond):
    # An offset at or beyond the end of the content is bad input, so it is a tool error,
    # not an empty page.
    with pytest.raises(ToolError, match="past the end") as exc:
        _slice(BODY, len(BODY) + beyond, 500)
    assert str(len(BODY)) in str(exc.value)


def test_slice_last_valid_offset_returns_the_final_character():
    assert _body_of(_slice(BODY, len(BODY) - 1, 500)) == BODY[-1]


def test_get_post_offset_past_end_is_a_tool_error(markdown_stub, call_tool):
    markdown_stub(BODY)
    result = call_tool("lw_get_post", {"id_or_slug": "somepostid", "offset": len(BODY) + 5})
    assert result.is_error is True
    assert result.content[0].text.startswith("Error executing tool lw_get_post: offset ")


def test_slice_offset_zero_on_empty_post_returns_empty_not_error():
    # An empty body with an explicit cap returns empty, not an offset error.
    assert _slice("", 0, 500) == ""


_NEXT_OFFSET = re.compile(r"offset=(\d+) to continue")


@pytest.mark.parametrize("step", [1, 3, 5, 7, 13])
def test_slice_paging_following_reported_offsets_reconstructs_text(step):
    # Following the offset each page's footer reports reassembles the original text exactly,
    # even when slice boundaries fall on paragraph breaks or runs of whitespace.
    text = "Section one.\n\n## Section Two\n\n\n\nTrailing   spaces   here   \n\nEnd."
    rebuilt, offset = "", 0
    while True:
        page = _slice(text, offset, step)
        rebuilt += _body_of(page)
        reported = _NEXT_OFFSET.search(page)
        if reported is None:
            break
        assert int(reported.group(1)) > offset  # a footer that fails to advance fails here
        offset = int(reported.group(1))
    assert rebuilt == text


def test_slice_all_whitespace_chunk_is_preserved():
    text = "AAAA" + " " * 20 + "BBBB"
    page = _slice(text, 4, 20)
    assert _body_of(page) == " " * 20  # whitespace-only page keeps its content


# --------------------------------------------------------------------------- #
# The size control lw_get_post and lw_get_comments share
# --------------------------------------------------------------------------- #

# About twice the default cap in numbered 8-character lines, so any slice is identifiable by
# its content.
LONG = "".join(f"{i:07d}\n" for i in range(config.MAX_CHARS // 4))
# Each call the size control serves: a post, a thread, and one comment fetched by its _id.
SLICED_CALLS = [
    pytest.param("lw_get_post", {}, id="lw_get_post"),
    pytest.param("lw_get_comments", {}, id="lw_get_comments"),
    pytest.param("lw_get_comments", {"comment_id": "c1"}, id="lw_get_comments-comment_id"),
]


@pytest.mark.parametrize("name, extra", SLICED_CALLS)
def test_long_body_defaults_to_a_bounded_slice(name, extra, markdown_stub, run):
    # A long body comes back as its first MAX_CHARS characters plus the footer to continue
    # from, rather than as one payload too large for the host to keep inline.
    cap = config.MAX_CHARS
    markdown_stub(LONG)
    body, _, footer = run(getattr(m, name)("p", **extra)).partition(f"\n\n---\n[{name}:")
    assert body == LONG[:cap]
    assert f"truncated at {cap} of {len(LONG)} characters — call again with offset={cap}" in footer


@pytest.mark.parametrize("name, extra", SLICED_CALLS)
def test_following_the_footer_reads_a_long_body_whole(name, extra, markdown_stub, run):
    # The cap is also the default, so paging is the one way through a long body: the offsets
    # the footers give lead through it with nothing dropped or repeated.
    markdown_stub(LONG)
    sep = f"\n\n---\n[{name}:"
    rebuilt, offset = "", 0
    while True:
        page = run(getattr(m, name)("p", **extra, offset=offset))
        rebuilt += page.split(sep, 1)[0]
        reported = _NEXT_OFFSET.search(page)
        if reported is None:
            break
        assert int(reported.group(1)) > offset  # a footer that fails to advance fails here
        offset = int(reported.group(1))
    assert rebuilt == LONG


@pytest.mark.parametrize("name, extra", SLICED_CALLS)
def test_body_at_the_default_cap_is_returned_whole(name, extra, markdown_stub, run):
    # The longest body that needs no footer: exactly MAX_CHARS characters.
    at_cap = LONG[: config.MAX_CHARS]
    markdown_stub(at_cap)
    assert run(getattr(m, name)("p", **extra)) == at_cap


@pytest.mark.parametrize("name, extra", SLICED_CALLS)
def test_max_chars_and_offset_page_under_a_footer_naming_the_tool(name, extra, markdown_stub, run):
    markdown_stub(BODY)
    first = run(getattr(m, name)("p", **extra, max_chars=1000))
    assert first.startswith(BODY[:1000] + f"\n\n---\n[{name}:")
    assert "offset=1000 to continue" in first
    second = run(getattr(m, name)("p", **extra, max_chars=1000, offset=1000))
    assert second.startswith(BODY[1000:2000] + f"\n\n---\n[{name}:")
    assert "continues from character 1000" in second
