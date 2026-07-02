"""Tests for the five straight-through Markdown-API tools: lw_get_sequence, lw_list_feed,
lw_get_tag, lw_get_user, and lw_get_comments.

Each fetches one /api/* route and returns its Markdown as-is, so the assertions are about
route construction, the `site` switch, escaping, and reference normalisation. lw_get_post,
lw_search, and lw_filter_posts carry enough behaviour of their own to keep separate files.

Hermetic: `_get_markdown` is stubbed via the shared `markdown_stub` fixture (see conftest);
nothing hits the network.
"""
from __future__ import annotations

import lesswrong_mcp as m
from lesswrong_mcp import Feed, Site


# ------------------------------------------------------------------------- #
# lw_get_sequence
# ------------------------------------------------------------------------- #

SEQ_ID = "r9tYkB2a8Fp4DN8yB"
SEQ_MD = "# Sequence: Risks from Learned Optimization\n\n*   Posts: 5\n"


def test_ref_extraction_forms():
    # A bare id, a full /s/<id> URL, and an /api/sequence/<id> path all reduce to the id.
    assert m._extract_sequence_ref(SEQ_ID) == SEQ_ID
    assert m._extract_sequence_ref(f"https://www.lesswrong.com/s/{SEQ_ID}") == SEQ_ID
    assert m._extract_sequence_ref(f"/api/sequence/{SEQ_ID}") == SEQ_ID
    assert m._extract_sequence_ref(f"/s/{SEQ_ID}/some-slug") == SEQ_ID


def test_get_sequence_fetches_sequence_route(markdown_stub, run):
    captured = markdown_stub(SEQ_MD)
    out = run(m.lw_get_sequence(f"https://www.lesswrong.com/s/{SEQ_ID}", site=Site.lesswrong))
    assert out == SEQ_MD
    assert captured["path"] == f"/api/sequence/{SEQ_ID}"
    assert captured["site"] == "lesswrong"


# ------------------------------------------------------------------------- #
# lw_list_feed
# ------------------------------------------------------------------------- #

FEED_MD = "# Latest\n\n- [A post](...) — karma: 30\n- [Another](...) — karma: 12\n"


def test_default_feed_is_latest_with_default_limit(markdown_stub, run):
    captured = markdown_stub(FEED_MD)
    out = run(m.lw_list_feed())
    assert out == FEED_MD
    assert captured["path"] == "/api/latest"
    assert captured["params"] == {"limit": 20}
    assert captured["site"] == "lesswrong"


def test_feed_limit_and_site_pass_through(markdown_stub, run):
    captured = markdown_stub(FEED_MD)
    run(m.lw_list_feed(feed=Feed.curated, limit=50, site=Site.alignmentforum))
    assert captured["path"] == "/api/curated"
    assert captured["params"] == {"limit": 50}
    assert captured["site"] == "alignmentforum"


# ------------------------------------------------------------------------- #
# lw_get_tag
# ------------------------------------------------------------------------- #

TAG_MD = "# Mesa-Optimization\n\n<wiki article>\n\n## Posts\n- ...\n"


def test_returns_tag_markdown(markdown_stub, run):
    markdown_stub(TAG_MD)
    out = run(m.lw_get_tag("mesa-optimization", site=Site.lesswrong))
    assert out == TAG_MD


def test_fetches_tag_route_and_honours_site(markdown_stub, run):
    captured = markdown_stub(TAG_MD)
    run(m.lw_get_tag("mesa-optimization", site=Site.alignmentforum))
    assert captured["path"] == "/api/tag/mesa-optimization"
    assert captured["site"] == "alignmentforum"


def test_tag_slug_is_url_escaped(markdown_stub, run):
    captured = markdown_stub(TAG_MD)
    run(m.lw_get_tag("ai safety", site=Site.lesswrong))
    assert captured["path"] == "/api/tag/ai%20safety"


def test_tag_accepts_url_and_path_forms(markdown_stub, run):
    # A pasted wiki URL or /w/<slug> (or /tag/<slug>) path is normalised to the bare slug,
    # matching what the post/comment/sequence tools already accept.
    for value in ("https://www.lesswrong.com/w/ai", "/w/ai", "/tag/ai", "ai"):
        captured = markdown_stub(TAG_MD)
        run(m.lw_get_tag(value))
        assert captured["path"] == "/api/tag/ai", value


# ------------------------------------------------------------------------- #
# lw_get_user
# ------------------------------------------------------------------------- #

USER_MD = "# Cleo Nardo\n\n- Karma: 4200 (AF: 1200)\n\n## Top posts\n- ...\n"


def test_returns_profile_markdown(markdown_stub, run):
    markdown_stub(USER_MD)
    out = run(m.lw_get_user("cleo-nardo", site=Site.lesswrong))
    assert out == USER_MD


def test_fetches_user_route_and_honours_site(markdown_stub, run):
    captured = markdown_stub(USER_MD)
    run(m.lw_get_user("cleo-nardo", site=Site.alignmentforum))
    assert captured["path"] == "/api/user/cleo-nardo"
    assert captured["site"] == "alignmentforum"


def test_user_slug_is_url_escaped(markdown_stub, run):
    # quote(slug, safe='') escapes anything path-unsafe, so a stray space can't split
    # the route or smuggle in extra path segments.
    captured = markdown_stub(USER_MD)
    run(m.lw_get_user("cleo nardo", site=Site.lesswrong))
    assert captured["path"] == "/api/user/cleo%20nardo"


def test_user_accepts_url_and_path_forms(markdown_stub, run):
    # A pasted profile URL or /users/<slug> path is normalised to the bare slug, matching
    # what the post/comment/sequence tools already accept.
    for value in ("https://www.lesswrong.com/users/cleo-nardo", "/users/cleo-nardo", "cleo-nardo"):
        captured = markdown_stub(USER_MD)
        run(m.lw_get_user(value))
        assert captured["path"] == "/api/user/cleo-nardo", value


def test_profile_count_passed_through_verbatim(markdown_stub, run):
    """The profile's "Posts:" figure is upstream's and is returned as-is — it legitimately
    differs from lw_filter_posts' row count (different backends, different inclusion
    rules), so the server must not adjust it. Confirmed live: the profile reports
    'Posts: 54' while lw_filter_posts(author=..., limit=100) returns 52."""
    profile = "# User: X\n\n*   Posts: 54\n"
    markdown_stub(profile)
    assert run(m.lw_get_user("x", site=Site.lesswrong)) == profile


# ------------------------------------------------------------------------- #
# lw_get_comments
# ------------------------------------------------------------------------- #

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
