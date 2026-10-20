"""The pure renderers: rows, search hits, threads, sequences and slicing, on hand-written
fixtures shaped like the forum's responses."""
from __future__ import annotations

import re

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from lesswrong_mcp.render import comment_item, hit_line, post_row, sequence, slice_text, thread

P1 = "post0000000000001"
C1 = "cmt00000000000001"
S1 = "seq00000000000001"
SITE = "https://www.lesswrong.com"
POST_LINK = re.compile(r"/api/post/([^/)\s]+)")


def a_post(**over) -> dict:
    p = {"_id": P1, "title": "T", "postedAt": "2024-05-01T10:00:00Z", "baseScore": 12,
         "commentCount": 3, "af": True, "user": {"displayName": "A B", "slug": "a-b"}}
    return {**p, **over}


def hits() -> dict[str, dict]:
    snippet = {"body": {"value": "a <em>match</em> here"}}
    return {
        "posts": {"_id": P1, "title": "T", "authorDisplayName": "A B", "authorSlug": "a-b",
                  "baseScore": 5, "postedAt": "2020-01-02T00:00:00Z", "af": True, "_snippetResult": snippet},
        "comments": {"_id": C1, "postId": P1, "postTitle": "T", "authorDisplayName": "C D",
                     "authorSlug": "c-d", "baseScore": 2, "postedAt": "2021-03-04T00:00:00Z",
                     "af": False, "_snippetResult": snippet},
        "tags": {"_id": "tag00000000000001", "name": "AI", "slug": "ai",
                 "_snippetResult": {"description": {"value": "about <em>AI</em>"}}},
        "users": {"_id": "usr00000000000001", "displayName": "E F", "slug": "e-f", "karma": 900},
        "sequences": {"_id": S1, "title": "Series", "plaintextDescription": "a series"},
    }


# --------------------------------------------------------------------------- rows

def test_post_row_links_id_names_slug_and_marks_af():
    assert post_row(a_post()) == (
        "- [T](https://www.lesswrong.com/api/post/post0000000000001) — A B (a-b) · karma 12 · "
        "2024-05-01 · 3 comments · AF"
    )


def test_post_row_null_fields_do_not_raise():
    row = post_row(a_post(user=None, postedAt=None, af=None, title=None))
    assert "[deleted account]" in row and "undated" in row and "AF" not in row


def test_brackets_in_titles_and_names_are_escaped():
    row = post_row(a_post(title="[AN #80] x", user={"displayName": "a]b", "slug": "ab"}))
    assert "[\\[AN #80\\] x](" in row and "a\\]b (ab)" in row


# --------------------------------------------------------------------------- search hits

def test_hit_line_for_each_kind():
    h = hits()
    assert hit_line("posts", h["posts"]).startswith(
        f"- [T]({SITE}/api/post/{P1}) — A B (a-b) · karma 5 · 2020-01-02 · AF\n  snippet: a match here")
    assert hit_line("comments", h["comments"]).startswith(
        f"- Comment [{C1}]({SITE}/api/post/{P1}/comments/{C1}) by C D (c-d) on [T]({SITE}/api/post/{P1})"
        " · karma 2 · 2021-03-04\n")
    assert hit_line("tags", h["tags"]) == f"- [AI]({SITE}/w/ai)\n  snippet: about AI"
    assert hit_line("users", h["users"]) == f"- [E F]({SITE}/users/e-f) · karma 900"
    assert hit_line("sequences", h["sequences"]) == f"- [Series]({SITE}/s/{S1})\n  snippet: a series"


def test_comment_hit_on_tag_page_links_tag_not_post():
    hit = {**hits()["comments"], "postId": None, "postTitle": None, "tagSlug": "t"}
    line = hit_line("comments", hit)
    assert f"{SITE}/w/t" in line and "/api/post/" not in line and C1 in line


def test_hit_without_a_slug_is_named_unlinked_and_an_odd_date_reads_undated():
    h = hits()
    assert hit_line("users", {"_id": "usr00000000000001", "displayName": "E F", "karma": 3}) == "- E F · karma 3"
    assert hit_line("tags", {"_id": "tag00000000000001", "name": "AI"}) == "- AI"
    on_tag = hit_line("comments", {**h["comments"], "postId": None, "tagSlug": None})
    assert f"- Comment {C1} by C D (c-d) on a tag page · karma 2" in on_tag and "/w/" not in on_tag
    for posted in (None, 1714521600000):
        assert " · karma 5 · undated · AF" in hit_line("posts", {**h["posts"], "postedAt": posted})


def test_snippet_highlight_stripped_and_trimmed_to_300():
    hit = {**hits()["posts"], "_snippetResult": {"body": {"value": "<em>x</em> " + "y" * 500}}}
    snippet = hit_line("posts", hit).split("\n  snippet: ", 1)[1]
    assert "<em>" not in snippet and len(snippet) <= 301


def test_snippet_drops_highlight_tags_in_place_and_unescapes_entities():
    # The index marks matches with <em> inside the text, even mid-word or mid-entity; any other
    # angle bracket is the text's own, and so is an ampersand that ends no entity.
    raw = ("AT&<em>T</em> and&<em>nbsp</em>;so &amp; &#8212; &#x2014; on, where $i < 10 > 2 and <p> stays:"
           " ?a=1&region=us&copy=2, p = &params;")
    hit = {**hits()["posts"], "_snippetResult": {"body": {"value": raw}}}
    assert hit_line("posts", hit).split("\n  snippet: ", 1)[1] == (
        "AT&T and so & \u2014 \u2014 on, where $i < 10 > 2 and <p> stays: ?a=1&region=us&copy=2, p = &params;")


def test_every_api_post_link_carries_an_id():
    lines = [post_row(a_post())] + [hit_line(kind, hit) for kind, hit in hits().items()]
    for value in POST_LINK.findall("\n".join(lines)):
        assert re.fullmatch(r"[A-Za-z0-9]{17}", value), value


# --------------------------------------------------------------------------- slicing

def test_slice_footer_and_offset_past_end():
    text = "x" * 1200
    first = slice_text(text, 0, 500, label="lw_get_post")
    assert first.startswith("x" * 500) and "call again with offset=500" in first
    assert slice_text(text, 1000, 500, label="lw_get_post").startswith("x" * 200)
    with pytest.raises(ToolError):
        slice_text(text, 1200, 500, label="lw_get_post")


# --------------------------------------------------------------------------- threads

def a_comment(cid: str, parent: str | None = None, **over) -> dict:
    c = {"_id": cid, "postId": P1, "parentCommentId": parent, "answer": False, "af": False,
         "deleted": False, "baseScore": 1, "postedAt": "2022-01-01T00:00:00Z",
         "extendedScore": None, "user": {"displayName": "U", "slug": "u"},
         "contents": {"markdown": f"body of {cid}"}}
    return {**c, **over}


QUESTION = {"_id": P1, "title": "Q?", "question": True, "commentCount": 5}
ORDINARY = {"_id": P1, "title": "T", "question": False, "commentCount": 0}


def order(text: str) -> list[str]:
    return re.findall(r"^### \[(\w+)\]", text, re.M)


def test_thread_answers_first_then_comments_depth_first():
    answers = [a_comment("a1", answer=True), a_comment("r1", "a1")]
    comments = [a_comment("c1"), a_comment("c2"), a_comment("r2", "c1")]
    text = thread(QUESTION, answers, comments, limit_hit=False)
    assert order(text) == ["a1", "r1", "c1", "r2", "c2"]
    assert text.index("## Answers") < text.index("## Comments")


def test_orphan_reply_rendered_as_root_with_reply_to():
    text = thread(ORDINARY, [], [a_comment("c1"), a_comment("r9", "hidden")], limit_hit=False)
    assert order(text) == ["c1", "r9"] and "reply to hidden" in text


def test_thread_counts_include_every_item_once():
    answers = [a_comment("a1", answer=True), a_comment("r1", "a1")]
    comments = [a_comment("c1"), a_comment("r2", "c1"), a_comment("o1", "gone")]
    text = thread(QUESTION, answers, comments, limit_hit=False)
    assert sorted(order(text)) == ["a1", "c1", "o1", "r1", "r2"]
    assert "Answers: 1 (+1 replies) · Comments: 3 · complete" in text


def test_question_with_answers_only_has_no_empty_comments_section():
    text = thread(QUESTION, [a_comment("a1", answer=True)], [], limit_hit=False)
    assert "## Answers" in text and "## Comments" not in text


def test_empty_thread_says_no_comments_yet():
    assert "No comments yet." in thread(ORDINARY, [], [], limit_hit=False)


def test_limit_hit_header_says_showing_first():
    text = thread(ORDINARY, [], [a_comment("c1")], limit_hit=True)
    assert "showing the first 1" in text and "complete" not in text


def test_comment_item_header_fields_and_omissions():
    agreed = comment_item(a_comment(C1, "cmt00000000000000", af=True, extendedScore={"agreement": 4}), P1)
    assert agreed.startswith(
        f"### [{C1}]({SITE}/api/post/{P1}/comments/{C1}) U (u) · 2022-01-01 · karma 1 · agree 4 · AF"
        " · reply to cmt00000000000000\n\nbody of")
    plain = comment_item(a_comment(C1, contents=None, user=None), P1)
    assert "agree" not in plain and "[deleted account]" in plain and plain.endswith("[deleted]")


def test_agreement_shown_only_when_the_score_has_one():
    header = comment_item(a_comment(C1, extendedScore={"approvalVoteCount": 3}), P1).splitlines()[0]
    assert header.endswith(" · karma 1")
    assert comment_item(a_comment(C1, extendedScore={"agreement": 0}), P1).splitlines()[0].endswith(" · agree 0")


# --------------------------------------------------------------------------- sequences

def test_sequence_renders_chapters_with_id_rows():
    seq = {"_id": S1, "title": "Series", "user": {"displayName": "A B", "slug": "a-b"},
           "contents": {"markdown": "What it covers."},
           "chapters": [{"title": "Part 1", "number": 1, "posts": [a_post(), a_post(_id="post0000000000002")]},
                        {"title": None, "number": 2, "posts": [a_post(_id="post0000000000003")]}]}
    text = sequence(seq)
    assert text.startswith("# Series\n\nby A B (a-b)\n\nWhat it covers.")
    assert "## Part 1" in text and text.count("## ") == 1
    assert f"1. [T]({SITE}/api/post/{P1})" in text and f"3. [T]({SITE}/api/post/post0000000000003)" in text


def test_sequence_chapters_follow_their_number_not_the_response_order():
    seq = {"_id": S1, "title": "Series", "user": None, "contents": None,
           "chapters": [{"title": "Second", "number": 2, "posts": [a_post(_id="post0000000000002")]},
                        {"title": "First", "number": 1, "posts": [a_post()]}]}
    text = sequence(seq)
    assert text.index("## First") < text.index("## Second")
    assert f"1. [T]({SITE}/api/post/{P1})" in text and f"2. [T]({SITE}/api/post/post0000000000002)" in text


def test_sequence_with_null_fields_renders_what_it_has():
    assert sequence({"_id": S1, "title": None, "user": None, "contents": None, "chapters": None}) == (
        "# (untitled)\n\nby [deleted account]")
    p2 = "post0000000000002"
    seq = {"_id": S1, "title": "Series", "user": None, "contents": {"markdown": None},
           "chapters": [None,
                        {"title": None, "number": 0, "posts": [a_post()]},
                        {"title": None, "number": None, "posts": [None, a_post(_id=p2)]},
                        {"title": "Part 1", "number": 1, "posts": None}]}
    text = sequence(seq)
    # A chapter without a number comes first, as on the forum (an untitled preface), then the
    # numbered ones in order.
    assert text.count("## ") == 1
    assert (text.index(f"1. [T]({SITE}/api/post/{p2})") < text.index(f"2. [T]({SITE}/api/post/{P1})")
            < text.index("## Part 1"))


# --------------------------------------------------------------------------- search page

def test_search_page_sections_counts_and_footer():
    from lesswrong_mcp.render import search_page
    h = hits()
    text = search_page("q", ["sort: oldest"], [("posts", 25, [h["posts"]]), ("tags", 0, [])], next_page=2)
    assert text.startswith("# Search: q\n\n- sort: oldest\n")
    assert "## Posts (25 total)" in text and "## Tags (0 total)\n\n_No results._" in text
    assert text.endswith("[Next page: call again with page=2.]")
    assert "Next page" not in search_page("q", [], [("posts", 1, [h["posts"]])], next_page=None)


def test_deleted_comment_hides_its_body_and_author_even_when_returned():
    shown = comment_item(a_comment(C1, deleted=True, contents={"markdown": "secret text"}), P1)
    assert shown.endswith("[deleted]") and "secret text" not in shown
    gone = comment_item(a_comment(C1, deleted=True, user=None, contents=None), P1)
    assert "[deleted account]" not in gone and " [deleted] · " in gone.splitlines()[0]
