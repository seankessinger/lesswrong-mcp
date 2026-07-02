"""Tests for lw_get_user: fetches the /api/user/<slug> route and returns its Markdown,
honouring the `site` switch and URL-escaping the slug.

Hermetic: `_get_markdown` is stubbed via the shared `markdown_stub` fixture (see conftest);
nothing hits the network.
"""
from __future__ import annotations

import lesswrong_mcp as m
from lesswrong_mcp import Site

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


def test_slug_is_url_escaped(markdown_stub, run):
    # quote(slug, safe='') escapes anything path-unsafe, so a stray space can't split
    # the route or smuggle in extra path segments.
    captured = markdown_stub(USER_MD)
    run(m.lw_get_user("cleo nardo", site=Site.lesswrong))
    assert captured["path"] == "/api/user/cleo%20nardo"


def test_accepts_url_and_path_forms(markdown_stub, run):
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
