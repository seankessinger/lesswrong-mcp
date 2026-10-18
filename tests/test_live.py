"""Opt-in smoke tests against the real forum, and the gate that decides when they run.

The smoke tests make one request per Markdown route, using the example ids the tool
descriptions advertise, and check the upstream wording the tools parse. They are marked
`live`, so they run only with LW_LIVE_TESTS=1; the gate test itself is hermetic.

Live: LW_LIVE_TESTS=1 pytest tests/test_live.py -m live
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

import lesswrong_mcp as m
from lesswrong_mcp import tools

pytest_plugins = ["pytester"]

# The post links the Markdown routes emit; the value after /api/post/ is what lw_get_post takes.
# Search results carry the 17-char _id; other pages, such as a user profile, link posts by slug.
_POST_ID_LINK = re.compile(r"/api/post/[A-Za-z0-9]{17}(?![\w-])")
_POST_LINK = re.compile(r"/api/post/[\w-]+")


# ------------------------------------------------------------------------- #
# The LW_LIVE_TESTS gate
# ------------------------------------------------------------------------- #

@pytest.mark.parametrize(("value", "outcome"), [
    (None, "skipped"), ("0", "skipped"), ("false", "skipped"),
    ("1", "passed"), ("true", "passed"), (" Yes ", "passed"),
])
def test_live_marker_runs_only_on_an_explicit_yes(pytester, monkeypatch, value, outcome):
    if value is None:
        monkeypatch.delenv("LW_LIVE_TESTS", raising=False)
    else:
        monkeypatch.setenv("LW_LIVE_TESTS", value)
    pytester.makeconftest(Path(__file__).with_name("conftest.py").read_text())
    pytester.makeini("[pytest]\nmarkers =\n    live: reaches the real forum API\n")
    pytester.makepyfile("import pytest\n\n@pytest.mark.live\ndef test_marked():\n    pass\n")
    # The gate is read when the conftest is imported, and each run imports its own copy.
    result = pytester.runpytest("-p", "no:cacheprovider")
    result.assert_outcomes(**{outcome: 1})


# ------------------------------------------------------------------------- #
# Smoke tests (network)
# ------------------------------------------------------------------------- #

@pytest.mark.live
@pytest.mark.parametrize("call", [
    lambda: m.lw_get_post("RuGZ5tMdqpnraJahJ", max_chars=2000),
    lambda: m.lw_get_comments("RuGZ5tMdqpnraJahJ", limit=3, max_chars=2000),
    lambda: m.lw_get_user("cleo-nardo"),
    lambda: m.lw_get_tag("mesa-optimization"),
    lambda: m.lw_list_feed(feed="curated", limit=3),
], ids=["post", "comments", "user", "tag", "feed"])
def test_live_route_answers(call, live_run):
    # A failure raises ToolError, so any returned text means the route answered.
    assert live_run(call()).strip()


@pytest.mark.live
def test_live_sequence_lists_post_links(live_run):
    # Each chapter post is linked under /api/post/; the segment after it is what lw_get_post takes.
    assert _POST_LINK.search(live_run(m.lw_get_sequence("r9tYkB2a8Fp4DN8yB")))


@pytest.mark.live
def test_live_comment_id_fetches_just_that_comment(live_run):
    # comment_id reaches the single-comment route, which renders the one comment under its
    # post's title and links it by its own id.
    out = live_run(m.lw_get_comments(
        "RuGZ5tMdqpnraJahJ", comment_id="gFNHPK6oXtcuZfSWm",
    ))
    assert out.startswith("# Comment on ")
    assert out.count("### Comment by ") == 1
    assert "/comments/gFNHPK6oXtcuZfSWm" in out


@pytest.mark.live
def test_live_user_search_links_each_account_by_slug(live_run):
    # A user miss sends the caller to this search for the slug, so each result must link it.
    out = live_run(m.lw_search("cleo nardo", content_type="users", limit=1))
    assert re.search(r"\]\(/api/user/[A-Za-z0-9_-]+\)", out), out[:500]


@pytest.mark.live
def test_live_typed_search_keeps_the_wording_the_tool_parses(live_run):
    out = live_run(m.lw_search("mesa optimization", content_type="posts", limit=1))
    assert "- Results for posts:" in out          # relabelled from "- Results across all types:"
    assert tools._SEARCH_TOTAL_RE.search(out)     # the per-type total behind the next-page hint
    assert _POST_ID_LINK.search(out)              # the post id lw_search promises


@pytest.mark.live
def test_live_search_links_name_values_the_tools_take(live_run):
    # The tag and sequence advice sends the caller to a search whose results link /api/tag/<slug>
    # and /api/sequence/<id>, and every link's value is what the tools' identifier pattern takes
    # once a ?query is dropped. A comment hit links /api/post/<slug>/comments/<cid>, which names
    # two values, each checked. Only a Markdown link target counts, so a snippet whose prose
    # mentions an /api/ path is not read as a link. The query is one whose first page of results
    # has a tag and a sequence section.
    query = "rationality"
    out = live_run(m.lw_search(query, limit=3))
    kinds = set()
    for kind, target in re.findall(r"\]\((?:https?://[^/)]+)?/api/(post|user|tag|sequence)/([^)\s]+)\)", out):
        values = target.split("?", 1)[0].split("/comments/")
        if kind != "post" and len(values) > 1:
            continue  # a comment on a tag page: no tool fetches it
        for value in values:
            assert re.fullmatch("^[A-Za-z0-9_-]+$", value), f"/api/{kind}/{target}"
        kinds.add(kind)
    assert {"tag", "sequence"} <= kinds, out[:1500]
