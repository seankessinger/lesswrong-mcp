"""Opt-in live checks against the real forum (LW_LIVE_TESTS=1): one call per route and GraphQL
view the tools use, since the GraphQL schema is internal and unversioned. Each asserts the
shape of what comes back, and that every post link the server renders carries an id.
Read-only, one request at a time."""
from __future__ import annotations

import re
from datetime import date

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from lesswrong_mcp import forum, tools

pytestmark = pytest.mark.live

POST = "HBxe6wdjxK239zajf"       # Paul Christiano, "What failure looks like" (2019)
COMMENT = "CB8ieALcHfSSuAYYJ"    # Wei Dai's top-level comment on that post
QUESTION = "dKTh9Td3KaJ8QW6gw"   # "why assume AGIs will optimize for fixed goals?", a question post
SEQUENCE = "Rm6oQRJJmhGCcLvxh"   # "Embedded Agency"
PREFACED = "4dHMdK5TLN6xcqtyc"   # "Value Learning": an untitled chapter with no number, then numbered ones
TAG_COMMENT = "yfZg6HRKe8pWnRdgG"  # a discussion comment on the DeepMind tag page


def links_carry_ids(text: str) -> None:
    for value in re.findall(r"/api/post/([^/)\s]+)", text):
        assert re.fullmatch(r"[A-Za-z0-9]{17}", value), value


def in_karma_order(text: str) -> bool:
    """The rows' karma never rises: lw_filter_posts ends a min_karma listing on that."""
    karmas = [int(k) for k in re.findall(r" · karma (-?\d+) · ", text)]
    return bool(karmas) and karmas == sorted(karmas, reverse=True)


def test_markdown_post_route(live_run):
    text = live_run(tools.lw_get_post(POST))
    assert "What failure looks like" in text and len(text) > 1000


@pytest.mark.parametrize("sort", ["top", "new", "old"])
def test_posts_views(live_run, sort):
    text = live_run(tools.lw_filter_posts(author="paulfchristiano", sort=sort, limit=3))
    assert text.startswith("# Posts (3)") and f"sort={sort}" in text
    assert sort != "top" or in_karma_order(text)
    links_carry_ids(text)


def test_pingback_view_with_date_filter(live_run):
    text = live_run(tools.lw_filter_posts(links_to=POST, after=date(2020, 1, 1), limit=5))
    assert f"links to {POST} — " in text and text.count("\n- [") == 5 and in_karma_order(text)
    links_carry_ids(text)


@pytest.mark.parametrize("sort", ["top", "new", "old"])
def test_thread_views(live_run, sort):
    async def whole_thread() -> str:
        pages, offset = [], 0
        while True:
            page = await tools.lw_get_comments(POST, sort=sort, offset=offset)
            pages.append(page)
            match = re.search(r"call again with offset=(\d+)", page)
            if not match:
                return "\n".join(pages)
            offset = int(match.group(1))

    text = live_run(whole_thread())
    assert text.startswith("# Comments on [What failure looks like]") and "complete" in text.splitlines()[2]
    assert COMMENT in text
    links_carry_ids(text)


def test_answers_and_replies_on_question_post(live_run):
    text = live_run(tools.lw_get_comments(QUESTION))
    assert "## Answers" in text and "Answers: " in text
    links_carry_ids(text)


def test_comment_by_id(live_run):
    text = live_run(tools.lw_get_comments(POST, comment_id=COMMENT))
    assert text.startswith(f"### [{COMMENT}](https://www.lesswrong.com/api/post/{POST}/comments/{COMMENT})")
    assert "(wei-dai)" in text.splitlines()[0]


def test_tag_page_comment_has_no_post(live_run):
    with pytest.raises(ToolError, match="is on a tag page, not a post"):
        live_run(tools.lw_get_comments(POST, comment_id=TAG_COMMENT))


def test_post_by_id_and_unknown_id_is_null(live_run):
    query = "query ($id: String) { post(input: {selector: {_id: $id}, allowNull: true}) { result { _id slug } } }"
    found = live_run(forum.graphql(query, {"id": POST}))
    missing = live_run(forum.graphql(query, {"id": "AAAAAAAAAAAAAAAAA"}))
    assert found["post"]["result"]["_id"] == POST and missing["post"]["result"] is None


def test_sequence_with_chapters(live_run):
    text = live_run(tools.lw_get_sequence(SEQUENCE))
    assert text.startswith("# Embedded Agency") and "\n1. [" in text
    links_carry_ids(text)


def test_chapter_without_a_number_comes_first(live_run):
    text = live_run(tools.lw_get_sequence(PREFACED))
    assert "\n## " in text and text.index("\n1. [") < text.index("\n## ")


def test_user_and_tag_slug_lookups(live_run):
    assert re.fullmatch(r"[A-Za-z0-9]{17}", live_run(tools._resolve("user", "paulfchristiano")))
    assert re.fullmatch(r"[A-Za-z0-9]{17}", live_run(tools._resolve("tag", "inner-alignment")))


def test_search_oldest_first(live_run):
    text = live_run(tools.lw_search('"embedded agency"', types=["posts"], sort="oldest", limit=3))
    days = re.findall(r"· (\d{4}-\d{2}-\d{2})", text)
    assert "## Posts (" in text and days == sorted(days) and len(days) == 3
    links_carry_ids(text)


def test_search_in_one_post(live_run):
    text = live_run(tools.lw_search("influence", in_post=POST))
    assert "## Comments (" in text and f"/api/post/{POST}/comments/" in text
    links_carry_ids(text)


def test_search_all_kinds(live_run):
    text = live_run(tools.lw_search("embedded agency", limit=2))
    for section in ("Posts", "Comments", "Tags", "Users", "Sequences"):
        assert f"## {section} (" in text
    links_carry_ids(text)


def test_search_date_and_alignment_forum_filters_apply(live_run):
    day = date(2023, 3, 14)
    text = live_run(tools.lw_search("alignment", types=["posts"], after=day, before=day, limit=10))
    days = re.findall(r"^- \[.*· (\d{4}-\d{2}-\d{2})(?: · AF)?$", text, re.M)
    assert days and set(days) == {"2023-03-14"}
    text = live_run(tools.lw_search("interpretability", types=["posts"], af_only=True, limit=10))
    rows = [line for line in text.splitlines() if line.startswith("- [")]
    assert rows and all(line.endswith(" · AF") for line in rows)
