"""Tests for lw_search's header relabel when a single content type is requested, plus its
two fail-fast guards (over-window paging and blank query).

The upstream search page labels its count line 'Results across all types' even when
`type` restricts to one kind, so the number there is really that one type's total.
lw_search relabels just that line so the header matches the filter, and leaves the
all-types header untouched. Hermetic: `_get_markdown` is stubbed via the shared
`markdown_stub` fixture (see conftest); its `captured["calls"]` proves whether the network
layer was reached.
"""
from __future__ import annotations

import lesswrong_mcp as m
from lesswrong_mcp import SearchType

SEARCH_MD = (
    "# Search Results: deceptive alignment\n\n"
    "- Query: `deceptive alignment`\n"
    "- Results across all types: 47914\n"
    "- Per-type page size: 3\n\n"
    "## Comments (47914 total)\n"
)


def test_type_relabels_count_line(markdown_stub, run):
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("deceptive alignment", content_type=SearchType.comments))
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
    out = run(m.lw_search("x", content_type=SearchType.posts))
    assert out.startswith(text)       # body untouched by the (no-op) relabel
    assert "Results for" not in out   # nothing to relabel, so no relabel happened


# --------------------------------------------------------------------------- #
# Result-window guard — page * limit > 10000 is a deterministic backend 500
# (Elasticsearch max_result_window), so it must fail fast before the network call.
# --------------------------------------------------------------------------- #

def test_over_window_search_is_blocked_before_network(markdown_stub, run):
    # 501 * 20 = 10020 > 10000: the guard returns an actionable error and must never
    # reach _get_markdown (which would 500 and burn the retry budget).
    captured = markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", page=501, limit=20))
    assert out.startswith("Error:")
    assert "10,000" in out
    assert m.SEARCH_RESULT_WINDOW == 10000
    assert captured["calls"] == []  # never reached the network layer


def test_at_window_search_passes_through(markdown_stub, run):
    # 500 * 20 = 10000 == the window: allowed, so the call reaches the (stubbed) network
    # layer and returns its Markdown (plus the all-types per-type note) rather than the
    # guard error. At this depth the next page (501 * 20 > 10000) is unreachable, so no
    # next-page footer is appended.
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", page=500, limit=20))
    assert out.startswith(SEARCH_MD)
    assert not out.startswith("Error:")
    assert "results per content type" in out   # the all-types note
    assert "Next page" not in out              # last reachable page: no next-page hint


# --------------------------------------------------------------------------- #
# Per-type note (all-types only) + next-page footer (W6)
# --------------------------------------------------------------------------- #

def test_all_types_search_states_per_type_cap(markdown_stub, run):
    # An all-types search fans `limit` across every content type, so it returns up to
    # limit × (types) rows; the output must say so.
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", limit=3))
    assert "Showing up to 3 results per content type" in out
    assert "5 types" in out                     # len(SearchType)


def test_single_type_search_omits_per_type_note(markdown_stub, run):
    # The per-type multiplication only applies to all-types searches; a scoped one keeps the
    # relabel and drops the note.
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", content_type=SearchType.posts, limit=3))
    assert "results per content type" not in out


def test_next_page_footer_when_reachable(markdown_stub, run):
    # A page whose successor stays within the window gets a "call again with page=N+1" hint.
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", page=2, limit=10))
    assert "call again with page=3" in out


def test_no_next_page_footer_at_window_boundary(markdown_stub, run):
    # (page+1)*limit must clear the window; at the last reachable page there is no next-page
    # hint (page=500, limit=20 -> the next page's 501*20 = 10020 > 10000).
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", page=500, limit=20))
    assert "Next page" not in out and "call again with page=" not in out


def test_no_next_page_footer_at_page_ceiling(markdown_stub, run):
    # page is capped at SEARCH_PAGE_MAX (1000). Even though (1001)*9 <= 10000 clears the
    # window guard, page=1001 would be rejected by the tool's own bound, so no next-page
    # footer is offered — the hint must never point at a page the tool refuses.
    markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization", page=m.SEARCH_PAGE_MAX, limit=9))
    assert "Next page" not in out and "call again with page=" not in out


# --------------------------------------------------------------------------- #
# Whitespace-only query guard — a blank `search` term makes the backend serve its
# /api/search docs page instead of results, so an empty-after-strip query must fail
# fast before the network call. (`min_length=2` only bounds the raw length, so "  "
# passes Pydantic.)
# --------------------------------------------------------------------------- #

def test_whitespace_only_query_errors_before_network(markdown_stub, run):
    captured = markdown_stub(SEARCH_MD)
    out = run(m.lw_search("   "))
    assert out.startswith("Error:")
    assert "empty search query" in out
    # It must fail fast — no /api/search request for a blank term.
    assert captured["calls"] == []


def test_tab_and_newline_only_query_is_rejected(markdown_stub, run):
    # Other whitespace (tab/newline) is empty-after-strip too, and must be rejected.
    captured = markdown_stub(SEARCH_MD)
    out = run(m.lw_search("\t\n "))
    assert out.startswith("Error:") and "empty search query" in out
    assert captured["calls"] == []


def test_normal_query_still_performs_one_search_request(markdown_stub, run):
    # A real query is unaffected: exactly one /api/search request goes through.
    captured = markdown_stub(SEARCH_MD)
    out = run(m.lw_search("mesa optimization"))
    assert not out.startswith("Error:")
    assert len(captured["calls"]) == 1
    site, path, params = captured["calls"][0]
    assert path == "/api/search"
    assert params["search"] == "mesa optimization"
