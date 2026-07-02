"""Tests for lw_get_tag: fetches the /api/tag/<slug> route and returns its Markdown,
honouring the `site` switch and URL-escaping the slug.

Hermetic: `_get_markdown` is stubbed via the shared `markdown_stub` fixture (see conftest);
nothing hits the network.
"""
from __future__ import annotations

import lesswrong_mcp as m
from lesswrong_mcp import Site

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


def test_slug_is_url_escaped(markdown_stub, run):
    captured = markdown_stub(TAG_MD)
    run(m.lw_get_tag("ai safety", site=Site.lesswrong))
    assert captured["path"] == "/api/tag/ai%20safety"


def test_accepts_url_and_path_forms(markdown_stub, run):
    # A pasted wiki URL or /w/<slug> (or /tag/<slug>) path is normalised to the bare slug,
    # matching what the post/comment/sequence tools already accept.
    for value in ("https://www.lesswrong.com/w/ai", "/w/ai", "/tag/ai", "ai"):
        captured = markdown_stub(TAG_MD)
        run(m.lw_get_tag(value))
        assert captured["path"] == "/api/tag/ai", value
