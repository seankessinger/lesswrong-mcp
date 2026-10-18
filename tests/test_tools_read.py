"""Tests for the Markdown-API tools that fetch one /api/* route and return its Markdown as-is:
lw_get_post, lw_get_comments, lw_get_user, lw_get_tag, lw_get_sequence and lw_list_feed.

One route table pins, through a real MCP session, the request each tool sends (site, path,
query params) and that the body comes back untouched. The rest are the upstream quirks a tool
must pass through verbatim, and lw_get_comments' fetch of one comment: the thread options it
drops and how its failures read. lw_get_post's and lw_get_comments' shared size control
(max_chars/offset) lives in test_lw_get_post.py; lw_search and lw_filter_posts keep files of
their own.

Hermetic: `_get_markdown` is stubbed via the shared `markdown_stub` fixture, or the pooled
client's transport via `forum` (see conftest); nothing hits the network.
"""
from __future__ import annotations

import httpx
import pytest
from mcp.server.mcpserver.exceptions import ToolError

import lesswrong_mcp as m
from lesswrong_mcp import http_client

# ------------------------------------------------------------------------- #
# The request each tool sends, through MCP
# ------------------------------------------------------------------------- #

ROUTE_BODY = "# Title\n\nbody\n"


@pytest.mark.parametrize(
    "name, args, expected_call",
    [
        # Each value goes into its route as given; the non-default site must be the one fetched.
        pytest.param(
            "lw_get_post", {"id_or_slug": "a-b_1", "site": "alignmentforum"},
            ("alignmentforum", "/api/post/a-b_1", None), id="lw_get_post",
        ),
        pytest.param(
            "lw_get_comments", {"id_or_slug": "a-b_1", "sort": "new", "limit": 7, "site": "alignmentforum"},
            ("alignmentforum", "/api/post/a-b_1/comments", {"sort": "new", "limit": 7}), id="lw_get_comments",
        ),
        pytest.param(
            "lw_get_comments", {"id_or_slug": "a-b_1", "comment_id": "c_2", "site": "alignmentforum"},
            ("alignmentforum", "/api/post/a-b_1/comments/c_2", None), id="lw_get_comments-comment_id",
        ),
        pytest.param(
            "lw_get_user", {"slug": "a-b_1", "site": "alignmentforum"},
            ("alignmentforum", "/api/user/a-b_1", None), id="lw_get_user",
        ),
        pytest.param(
            "lw_get_tag", {"slug": "a-b_1", "site": "alignmentforum"},
            ("alignmentforum", "/api/tag/a-b_1", None), id="lw_get_tag",
        ),
        pytest.param(
            "lw_get_sequence", {"sequence_id": "a-b_1", "site": "alignmentforum"},
            ("alignmentforum", "/api/sequence/a-b_1", None), id="lw_get_sequence",
        ),
        pytest.param(
            "lw_list_feed", {"feed": "curated", "limit": 7, "site": "alignmentforum"},
            ("alignmentforum", "/api/curated", {"limit": 7}), id="lw_list_feed",
        ),
    ],
)
def test_tool_fetches_its_route_and_returns_the_body(name, args, expected_call, markdown_stub, call_tool):
    captured = markdown_stub(ROUTE_BODY)
    result = call_tool(name, args)
    assert result.is_error is False
    assert result.content[0].text == ROUTE_BODY
    assert captured["calls"] == [expected_call]


# ------------------------------------------------------------------------- #
# lw_list_feed
# ------------------------------------------------------------------------- #

FEED_MD = "# Latest\n\n- [A post](...) — karma: 30\n- [Another](...) — karma: 12\n"


def test_list_feed_defaults_to_latest_with_the_default_limit(markdown_stub, run):
    captured = markdown_stub(FEED_MD)
    out = run(m.lw_list_feed())
    assert out == FEED_MD
    assert captured["path"] == "/api/latest"
    assert captured["params"] == {"limit": 20}
    assert captured["site"] == "lesswrong"


# ------------------------------------------------------------------------- #
# lw_get_user
# ------------------------------------------------------------------------- #

def test_get_user_passes_the_profile_count_through_verbatim(markdown_stub, run):
    """The profile's "Posts:" figure is upstream's and is returned as-is — it legitimately
    differs from the number of posts lw_filter_posts lists for the same author when paged to
    the end (different backends, different inclusion rules), so the server must not adjust
    it. Confirmed live: a profile reporting 'Posts: 54' whose whole lw_filter_posts(author=...,
    limit=100) listing is 52."""
    profile = "# User: X\n\n*   Posts: 54\n"
    markdown_stub(profile)
    assert run(m.lw_get_user("x", site="lesswrong")) == profile


# ------------------------------------------------------------------------- #
# lw_get_comments
# ------------------------------------------------------------------------- #

def test_get_comments_passes_the_count_header_through_verbatim(markdown_stub, run):
    """The upstream 'Showing X of Y' header is returned as-is — the server must not
    'reconcile' its two (nested-node vs. top-level) counts. Confirmed against the live
    API: the raw /api/post/<id>/comments body contains 'Showing 192 of 188 comments'
    verbatim, so the mismatch is upstream, not a transform this server applies."""
    thread = (
        "# Comments\n\nShowing 192 of 188 comments (sort=top).\n\n"
        "### Comment by [x](/users/x)\n\n\thi\n"
    )
    markdown_stub(thread)
    out = run(m.lw_get_comments("somepost", site="lesswrong"))
    assert out == thread  # byte-for-byte; count line untouched


def test_get_comments_forwards_the_reaction_flag_only_when_true(markdown_stub, run):
    """include_reaction_users forwards includeReactionUsers=1 iff true, and is absent
    otherwise — pinning the forwarding contract (the flag itself is verified working
    upstream: it appends reacting-user names to each emoji-reaction line)."""
    cap = markdown_stub("# Comments (0)\n")
    run(m.lw_get_comments("p", include_reaction_users=True, site="lesswrong"))
    assert cap["params"].get("includeReactionUsers") == 1

    cap = markdown_stub("# Comments (0)\n")
    run(m.lw_get_comments("p", include_reaction_users=False, site="lesswrong"))
    assert "includeReactionUsers" not in cap["params"]


def test_get_comments_passes_reaction_user_names_through_verbatim(markdown_stub, run):
    """With the flag on, upstream renders reacting-user names appended to each emoji-
    reaction line (e.g. 'agree: 1 (Dakara)', 'disagree: 1 (a, b, c)'); the server
    returns that body untouched. Documents the real rendered format."""
    thread = (
        "# Comments (1)\n\n### Comment by [a](/users/a)\n\n"
        "*   agree: 1 (Dakara)\n*   disagree: 1 (ryan_greenblatt, 1a3orn, MinusGix)\n"
    )
    markdown_stub(thread)
    out = run(m.lw_get_comments("p", include_reaction_users=True, site="lesswrong"))
    assert out == thread


# ------------------------------------------------------------------------- #
# lw_get_comments: one comment
# ------------------------------------------------------------------------- #

def test_get_comments_sends_no_thread_options_for_one_comment(markdown_stub, run):
    # The single-comment route reads no query parameters and always lists the reacting users,
    # so sort, limit and include_reaction_users stay off the wire.
    captured = markdown_stub(ROUTE_BODY)
    run(m.lw_get_comments("abc", comment_id="c1", sort="new", limit=3, include_reaction_users=True))
    assert captured["calls"] == [("lesswrong", "/api/post/abc/comments/c1", None)]


def _comment_route_fails(patch_io, code):
    async def fake_get_markdown(site, path, params=None):
        req = httpx.Request("GET", "https://www.lesswrong.com" + path)
        raise httpx.HTTPStatusError("err", request=req, response=httpx.Response(code, request=req))

    patch_io("_get_markdown", fake_get_markdown)


def test_comment_404_names_the_comment_and_its_post(patch_io, run):
    # The route answers 404 both for a post it can't find and for a comment that isn't on that
    # post, so the message names both.
    _comment_route_fails(patch_io, 404)
    with pytest.raises(ToolError) as exc:
        run(m.lw_get_comments("abc", comment_id="c1"))
    assert str(exc.value) == (
        "no comment 'c1' found on post 'abc' (404). "
        "Pass the post's _id or slug and the _id of one of its comments."
    )


def test_comment_500_is_retried_then_named_as_the_comment_lookup(forum, patch_sleep, patch_io, run):
    # The route answers a comment id the forum doesn't have with a bare HTTP 500 (checked live,
    # 2026-10-16). That reads as transient, so it costs the usual retries before the tool
    # reports it as the comment lookup it most likely is.
    patch_io("MAX_RETRIES", 2)
    seen = forum(lambda request: httpx.Response(500))

    async def scenario():
        try:
            return await m.lw_get_comments("abc", comment_id="c1")
        finally:
            await http_client._aclose_client()

    with pytest.raises(ToolError) as exc:
        run(scenario())
    assert str(exc.value) == (
        "the forum answered HTTP 500 for comment 'c1' on post 'abc', as it does for a comment "
        "id it doesn't have. Check the comment _id; if it is right, try again later."
    )
    assert [r.url.path for r in seen] == ["/api/post/abc/comments/c1"] * 3


@pytest.mark.parametrize(
    "comment_id, code, expected",
    [
        # A thread's 500 is no comment lookup.
        (None, 500, "The forum had a server error (HTTP 500). Try again later."),
        ("c1", 503, "The forum had a server error (HTTP 503). Try again later."),
        ("c1", 406, "No Markdown version exists for that route (406)."),
    ],
)
def test_other_comment_failures_keep_the_funnels_message(comment_id, code, expected, patch_io, run):
    _comment_route_fails(patch_io, code)
    with pytest.raises(ToolError) as exc:
        run(m.lw_get_comments("abc", comment_id=comment_id))
    assert str(exc.value) == expected
