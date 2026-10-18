"""Tests for the request lw_search sends, its header relabel when a single content type is
requested, its next-page hint, its fail-fast over-window guard, and how it trims its query.

The upstream search page labels its count line 'Results across all types' even when
`content_type` restricts to one kind, so the number there is really that one type's total.
lw_search relabels just that line so the header matches the filter, and leaves the
all-types header untouched. Hermetic: `_get_markdown` is stubbed via the shared
`markdown_stub` fixture (see conftest); its `captured["calls"]` proves whether the network
layer was reached.
"""
from __future__ import annotations

import pytest
from mcp.server.mcpserver.exceptions import ToolError

import lesswrong_mcp as m
from lesswrong_mcp import config

SEARCH_MD = (
    "# Search Results: deceptive alignment\n\n"
    "- Query: `deceptive alignment`\n"
    "- Results across all types: 47914\n"
    "- Per-type page size: 3\n\n"
    "## Comments (47914 total)\n"
)


@pytest.mark.parametrize(
    "kwargs, params",
    [
        # Unfiltered: no `type` key at all, and the 1-indexed page goes out 0-indexed.
        ({}, {"search": "mesa optimization", "page": 0, "limit": 10}),
        ({"content_type": "sequences", "page": 3, "limit": 7},
         {"search": "mesa optimization", "page": 2, "limit": 7, "type": "sequences"}),
    ],
    ids=["defaults", "typed-page-3"],
)
def test_search_sends_zero_based_page_and_filters(kwargs, params, markdown_stub, run):
    # Search has no `site` parameter: the two forums share one index, served from LessWrong.
    captured = markdown_stub(SEARCH_MD)
    run(m.lw_search("mesa optimization", **kwargs))
    assert captured["calls"] == [("lesswrong", "/api/search", params)]


def test_type_relabels_count_line(markdown_stub, run):
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("deceptive alignment", content_type="comments"))
    assert "- Results for comments: 47914" in out
    assert "across all types" not in out


def test_no_type_leaves_header_unchanged(markdown_stub, run):
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("deceptive alignment"))
    assert "- Results across all types: 47914" in out
    assert "Results for" not in out


def test_relabel_is_noop_when_wording_absent(markdown_stub, run):
    # If the upstream count line ever changes, the relabel does nothing — no crash, no
    # mangling of the body (a next-page footer may still be appended below it).
    text = "# Search Results\n\n- Total matches: 5\n"
    markdown_stub(text)
    out = run(m.lw_search("x", content_type="posts"))
    assert out.startswith(text)       # body untouched by the (no-op) relabel
    assert "Results for" not in out   # nothing to relabel, so no relabel happened


# --------------------------------------------------------------------------- #
# Result-window guard — page * limit > 10000 is a deterministic backend 500
# (Elasticsearch max_result_window), so it must fail fast before the network call.
# --------------------------------------------------------------------------- #

def test_over_window_search_is_blocked_before_network(markdown_stub, run):
    # 501 * 20 = 10020 > 10000: the guard raises an actionable error and must never
    # reach _get_markdown (which would 500 and burn the retry budget).
    captured = markdown_stub(SEARCH_MD)
    with pytest.raises(ToolError, match=f"{config.SEARCH_RESULT_WINDOW:,}"):
        run(m.lw_search("mesa optimization", page=501, limit=20))
    assert captured["calls"] == []  # never reached the network layer


def test_at_window_search_passes_through(markdown_stub, run):
    # 500 * 20 = 10000 == the window: allowed, so the call reaches the (stubbed) network
    # layer and returns its Markdown (plus the all-types per-type note) rather than the
    # guard error. At this depth the next page (501 * 20 > 10000) is unreachable, so no
    # next-page footer is appended.
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", page=500, limit=20))
    assert out.startswith(SEARCH_MD)
    assert "results per content type" in out   # the all-types note
    # Last reachable page: no next-page hint.
    assert "Next page" not in out and "call again with page=" not in out


# --------------------------------------------------------------------------- #
# Per-type note (all-types only) + next-page footer
# --------------------------------------------------------------------------- #

def test_all_types_search_states_per_type_cap(markdown_stub, run):
    # An all-types search fans `limit` across every content type, so it returns up to
    # limit × (types) rows; the output must say so.
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", limit=3))
    assert "Showing up to 3 results per content type" in out
    assert "5 types" in out                     # the five SearchType choices


def test_single_type_search_omits_per_type_note(markdown_stub, run):
    # The per-type multiplication only applies to all-types searches; a scoped one keeps the
    # relabel and drops the note.
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", content_type="posts", limit=3))
    assert "results per content type" not in out


def test_next_page_footer_when_reachable(markdown_stub, run):
    # A page whose successor stays within the window gets a "call again with page=N+1" hint.
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", page=2, limit=10))
    assert "call again with page=3" in out


@pytest.mark.parametrize(
    "body, content_type, page, limit, next_page",
    [
        # Nothing matched: no page 2 to offer.
        ("## Posts (0 total)\n_No results._\n", "posts", 1, 10, None),
        # The last, partial page (21-25 of 25) and the exact boundary (11-20 of 20).
        ("## Posts (25 total)\n", "posts", 3, 10, None),
        ("## Posts (20 total)\n", "posts", 2, 10, None),
        ("## Posts (25 total)\n", "posts", 2, 10, 3),
        # All types: `limit` applies per type, so the deepest type decides.
        ("## Posts (5 total)\n- a\n\n## Comments (40 total)\n- b\n", None, 1, 10, 2),
        ("## Posts (15 total)\n- a\n\n## Comments (10 total)\n- b\n", None, 2, 10, None),
        # No "(N total)" header to read: fall back to offering the next page.
        ("# Search Results\n\n- Total matches: 5\n", None, 1, 10, 2),
    ],
)
def test_search_next_page_hint_tracks_totals(markdown_stub, run, body, content_type, page, limit, next_page):
    markdown_stub(body)
    out = run(m.lw_search("mesa optimization", content_type=content_type, page=page, limit=limit))
    if next_page is None:
        assert "call again with page=" not in out
    else:
        assert f"call again with page={next_page}." in out


def test_no_next_page_footer_at_page_ceiling(markdown_stub, run):
    # page is capped at SEARCH_PAGE_MAX (1000). Even though (1001)*9 <= 10000 clears the
    # window guard, page=1001 would be rejected by the tool's own bound, so no next-page
    # footer is offered — the hint must never point at a page the tool refuses.
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", page=config.SEARCH_PAGE_MAX, limit=9))
    assert "Next page" not in out and "call again with page=" not in out


# --------------------------------------------------------------------------- #
# Query whitespace — a blank `search` term makes the backend serve its /api/search docs page
# instead of results, so the query is stripped before its 2-character minimum applies.
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("query", ["   ", "\t\n ", " a "])
def test_query_under_two_characters_once_stripped_is_rejected(query, markdown_stub, call_tool):
    captured = markdown_stub(SEARCH_MD)
    result = call_tool("lw_search", {"query": query})
    assert result.is_error is True
    text = result.content[0].text
    assert "validation error" in text and "query" in text
    assert captured["calls"] == []  # no /api/search request for a blank term


def test_query_is_sent_stripped(markdown_stub, call_tool):
    captured = markdown_stub(SEARCH_MD)
    assert call_tool("lw_search", {"query": "  mesa optimization\n"}).is_error is False
    assert captured["params"]["search"] == "mesa optimization"
