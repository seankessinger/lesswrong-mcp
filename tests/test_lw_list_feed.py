"""Tests for lw_list_feed: fetches the /api/<feed> route with a `limit`, defaulting to
the 'latest' feed and passing the feed choice, limit, and site straight through.

Hermetic: `_get_markdown` is stubbed via the shared `markdown_stub` fixture (see conftest);
nothing hits the network.
"""
from __future__ import annotations

import lesswrong_mcp as m
from lesswrong_mcp import Feed, Site

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
