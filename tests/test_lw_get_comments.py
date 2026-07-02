"""Tests for lw_get_comments' size paging (max_chars/offset), which caps and pages the
thread Markdown alongside the comment-count `limit`, and labels its own slice footer.

Hermetic: `_get_markdown` is stubbed via the shared `markdown_stub` fixture (see conftest);
nothing hits the network.
"""
from __future__ import annotations

import lesswrong_mcp as m
from lesswrong_mcp import Site

# ~9.6k chars, long enough to page.
THREAD = "# Comments (3)\n\n" + ("A commenter wrote a fairly long paragraph here. " * 200)


def test_default_returns_whole_thread(markdown_stub, run):
    markdown_stub(THREAD)
    out = run(m.lw_get_comments("somepost", site=Site.lesswrong))
    assert out == THREAD  # no cap, no footer


def test_max_chars_caps_and_reports_next_offset(markdown_stub, run):
    markdown_stub(THREAD)
    page = run(m.lw_get_comments("somepost", max_chars=1000, site=Site.lesswrong))
    assert page.startswith("# Comments")
    assert "offset=1000 to continue" in page
    # The footer names this tool, not lw_get_post.
    assert "[lw_get_comments:" in page
    assert "[lw_get_post:" not in page


def test_offset_pages_middle(markdown_stub, run):
    markdown_stub(THREAD)
    page = run(m.lw_get_comments("somepost", max_chars=1000, offset=1000, site=Site.lesswrong))
    assert "continues from character 1000" in page
    assert "[lw_get_comments:" in page


def test_limit_and_route_still_pass_through(markdown_stub, run):
    captured = markdown_stub(THREAD)
    run(m.lw_get_comments("somepost", limit=2000, site=Site.lesswrong))
    assert captured["params"]["limit"] == 2000
    assert captured["path"].endswith("/comments")


def test_upstream_count_header_passed_through_verbatim(markdown_stub, run):
    """The upstream 'Showing X of Y' header is returned as-is — the server must not
    'reconcile' its two (nested-node vs. top-level) counts. Confirmed against the live
    API: the raw /api/post/<id>/comments body contains 'Showing 192 of 188 comments'
    verbatim, so the mismatch is upstream, not a transform this server applies."""
    thread = (
        "# Comments\n\nShowing 192 of 188 comments (sort=top).\n\n"
        "### Comment by [x](/users/x)\n\n\thi\n"
    )
    markdown_stub(thread)
    out = run(m.lw_get_comments("somepost", site=Site.lesswrong))
    assert out == thread  # byte-for-byte; count line untouched


def test_reaction_flag_forwarded_only_when_true(markdown_stub, run):
    """include_reaction_users forwards includeReactionUsers=1 iff true, and is absent
    otherwise — pinning the forwarding contract (the flag itself is verified working
    upstream: it appends reacting-user names to each emoji-reaction line)."""
    cap = markdown_stub("# Comments (0)\n")
    run(m.lw_get_comments("p", include_reaction_users=True, site=Site.lesswrong))
    assert cap["params"].get("includeReactionUsers") == 1

    cap = markdown_stub("# Comments (0)\n")
    run(m.lw_get_comments("p", include_reaction_users=False, site=Site.lesswrong))
    assert "includeReactionUsers" not in cap["params"]


def test_reaction_user_names_in_body_passed_through_verbatim(markdown_stub, run):
    """With the flag on, upstream renders reacting-user names appended to each emoji-
    reaction line (e.g. 'agree: 1 (Dakara)', 'disagree: 1 (a, b, c)'); the server
    returns that body untouched. Documents the real rendered format."""
    thread = (
        "# Comments (1)\n\n### Comment by [a](/users/a)\n\n"
        "*   agree: 1 (Dakara)\n*   disagree: 1 (ryan_greenblatt, 1a3orn, MinusGix)\n"
    )
    markdown_stub(thread)
    out = run(m.lw_get_comments("p", include_reaction_users=True, site=Site.lesswrong))
    assert out == thread
