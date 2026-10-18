"""Tests for the pure helper _md_inline in lesswrong_mcp.markdown, the error messages and the
advice table in lesswrong_mcp.errors, and the _tool_errors funnel that turns anticipated tool
failures into MCP tool errors.
"""
from __future__ import annotations

import logging
from typing import get_args

import httpx
import pytest
from mcp.server.mcpserver.exceptions import ToolError

import lesswrong_mcp as m
from lesswrong_mcp import errors, markdown


# ------------------------------------------------------------------------- #
# _md_inline — Markdown link-text escaping
# ------------------------------------------------------------------------- #

def test_md_inline_collapses_whitespace_and_escapes_brackets():
    assert markdown._md_inline("[AN #80] Foo\nbar") == r"\[AN #80\] Foo bar"


def test_md_inline_escapes_backslash_before_brackets():
    # Backslash is escaped first, so the escaped brackets aren't double-escaped.
    assert markdown._md_inline(r"a\b [c]") == r"a\\b \[c\]"


def test_md_inline_none_and_blank_and_runs():
    assert markdown._md_inline(None) == ""
    assert markdown._md_inline("   ") == ""
    assert markdown._md_inline("  multiple   spaces  ") == "multiple spaces"


# ------------------------------------------------------------------------- #
# _handle_error, the advice table and the _tool_errors funnel
# ------------------------------------------------------------------------- #

def _raise_status(patch_io, code):
    async def fake_get_markdown(site, path, params=None):
        req = httpx.Request("GET", "https://www.lesswrong.com" + path)
        raise httpx.HTTPStatusError(
            "err", request=req, response=httpx.Response(code, request=req)
        )

    patch_io("_get_markdown", fake_get_markdown)


def _raise(patch_io, exc):
    async def fake_get_markdown(site, path, params=None):
        raise exc

    patch_io("_get_markdown", fake_get_markdown)


# What each kind's advice carries, as the model acts on it: where to look the value up, and the
# link form that holds it. The post advice names both the search and the link it returns.
_FIND = {
    "post": ("lw_search", "/api/post/<id>"),
    "comment": ("/comment/", "?commentId="),
    "user": ("lw_search(query=<name>, content_type='users')",),
    "tag": ("lw_search(query=<name>, content_type='tags')",),
    "sequence": ("lw_search(query=<title>, content_type='sequences')",),
}


def test_advice_tables_cover_every_kind_and_stay_template_safe():
    # SHAPE text is handed to pydantic as a message template, so a brace would be read as a
    # format field. SHAPE is its lead, a space, then the same FIND advice a miss carries.
    assert set(errors.FIND) == set(errors.SHAPE) == set(get_args(errors.Kind)) == set(_FIND)
    for kind in _FIND:
        assert all(fragment in errors.FIND[kind] for fragment in _FIND[kind])
        assert errors.SHAPE[kind].endswith(" " + errors.FIND[kind])
        assert "not a link" in errors.SHAPE[kind].removesuffix(errors.FIND[kind])
        assert not set("{}") & set(errors.FIND[kind] + errors.SHAPE[kind])


@pytest.mark.parametrize(
    "tool_name, arg, subject, kind",
    [
        ("lw_get_post", "badid", "post", "post"),
        ("lw_get_comments", "badid", "post", "post"),
        ("lw_get_user", "no-such-user", "user", "user"),
        ("lw_get_tag", "no-such-tag", "tag", "tag"),
        ("lw_get_sequence", "no-such-seq", "sequence", "sequence"),
    ],
)
def test_404_names_subject_and_echoes_value(patch_io, run, tool_name, arg, subject, kind):
    # The message asks for what the tool's identifier parameter takes, then says where to find it.
    _raise_status(patch_io, 404)
    with pytest.raises(ToolError) as exc:
        run(getattr(m, tool_name)(arg))
    out = str(exc.value)
    assert out.startswith(f"no {subject} found for {arg!r} (404). Pass a ")
    for fragment in _FIND[kind]:
        assert fragment in out


@pytest.mark.parametrize("value", ["ScottAlexander", "jefftk", "CleoNardo"])
def test_404_user_points_to_user_search_and_guesses_no_slug(patch_io, run, value):
    # A user slug comes from the username, not the display name, and a popular name is held by
    # several accounts ('scott-alexander' is not Scott Alexander's main account), so a slug
    # derived from the name can name the wrong person. Every user miss points to the search
    # that lists each account's slug instead, even for a lowercase handle ('jefftk') that
    # isn't the account's slug. The message echoes the value as given, so a lowercased form
    # can only be a guess.
    _raise_status(patch_io, 404)
    with pytest.raises(ToolError) as exc:
        run(m.lw_get_user(value))
    out = str(exc.value)
    assert _FIND["user"][0] in out
    assert "scott-alexander" not in out
    assert "cleo-nardo" not in out
    if value != value.lower():
        assert value.lower() not in out


@pytest.mark.parametrize("value", ["MesaOptimization", "Mesa_Optimization"])
def test_404_tag_by_name_gets_no_derived_slug(patch_io, run, value):
    # A tag's slug is the forum's own, so a name is not turned into a guessed slug: the miss
    # points to the search that lists each tag with its slug.
    _raise_status(patch_io, 404)
    with pytest.raises(ToolError) as exc:
        run(m.lw_get_tag(value))
    out = str(exc.value)
    assert _FIND["tag"][0] in out
    assert "mesa-optimization" not in out
    if value != value.lower():
        assert value.lower() not in out


def test_non_lookup_tool_404_blames_the_route_not_the_input(patch_io, run):
    # lw_list_feed looks nothing up by id or slug, so a 404 can only mean the route is gone.
    _raise_status(patch_io, 404)
    with pytest.raises(ToolError) as exc:
        run(m.lw_list_feed())
    assert str(exc.value) == "The forum has no such page (404); its API may have changed."


def test_other_status_is_unaffected(patch_io, run):
    _raise_status(patch_io, 406)
    with pytest.raises(ToolError) as exc:
        run(m.lw_get_post("whatever"))
    assert str(exc.value) == "No Markdown version exists for that route (406)."


_REQ = httpx.Request("GET", "https://www.lesswrong.com/api/x")


def _status_error(code, headers=None):
    return httpx.HTTPStatusError(
        "err", request=_REQ, response=httpx.Response(code, headers=headers, request=_REQ)
    )


@pytest.mark.parametrize(
    "exc, expected",
    [
        # A Retry-After longer than the client waits ends the call after one attempt, so the
        # message makes no claim about retries.
        (_status_error(429, {"retry-after": "3600"}),
         ("Rate limited by the forum (429). The forum asked to wait 3600 "
          "seconds. Wait a bit and try again.")),
        (_status_error(429),
         "Rate limited by the forum (429). Wait a bit and try again."),
        # Only a delta-seconds Retry-After is echoed; an HTTP-date is left out.
        (_status_error(429, {"retry-after": "Wed, 21 Oct 2015 07:28:00 GMT"}),
         "Rate limited by the forum (429). Wait a bit and try again."),
        # A server error says to try later, and makes no claim about how often it was tried:
        # a 501 or a long Retry-After ends the call after one attempt.
        (_status_error(503), "The forum had a server error (HTTP 503). Try again later."),
        # 501 Not Implemented won't pass with time.
        (_status_error(501), "Forum API returned HTTP 501."),
        (_status_error(403), "Forum API returned HTTP 403."),
        (httpx.ReadTimeout("t", request=_REQ), "Request timed out. Try again."),
        (httpx.TooManyRedirects("r", request=_REQ), "The forum redirected too many times."),
        (httpx.DecodingError("d", request=_REQ),
         "The forum sent a response that could not be decoded."),
        # A non-timeout transport failure gets a generic message, never the httpx class name.
        (httpx.RemoteProtocolError("p", request=_REQ),
         "Could not reach the forum API (network error). Try again."),
        (httpx.InvalidURL("u"), "Could not build a valid forum URL."),
        (httpx.RequestError("q", request=_REQ), "Forum request failed (RequestError)."),
    ],
)
def test_handle_error_messages(exc, expected):
    # MCPServer prefixes every tool error with "Error executing tool <name>: ", so the
    # message itself must not carry a second "Error" lead-in.
    out = errors._handle_error(exc)
    assert out == expected
    assert not out.startswith("Error")


def test_handle_error_passes_forum_api_error_text_through():
    assert errors._handle_error(errors.ForumAPIError("GraphQL error: boom")) == "GraphQL error: boom"


def test_tool_error_text_has_single_prefix(patch_io, call_tool):
    # Through a real client session: an anticipated failure is a protocol-level tool error
    # (isError) whose text carries MCPServer's prefix exactly once.
    _raise_status(patch_io, 404)
    result = call_tool("lw_get_post", {"id_or_slug": "nope"})
    assert result.is_error is True
    text = result.content[0].text
    assert text.startswith("Error executing tool lw_get_post: no post found for 'nope' (404)")
    assert "Error: " not in text


def test_in_body_input_check_is_a_tool_error(patch_io, call_tool):
    # A tool's own input check reports the same way as a funnelled failure.
    async def unreachable_graphql(site, query, variables=None):
        raise AssertionError("the date-range check must fail before any GraphQL call")

    patch_io("_graphql", unreachable_graphql)
    result = call_tool("lw_filter_posts", {"after": "2025-02-01", "before": "2025-01-01"})
    assert result.is_error is True
    text = result.content[0].text
    assert text.startswith("Error executing tool lw_filter_posts: 'after' (2025-02-01) is later")
    assert "Error: " not in text


@pytest.mark.parametrize("exc_type", [NotImplementedError, RecursionError])
def test_funnel_does_not_mask_programming_errors(patch_io, run, exc_type):
    # Both are RuntimeError subclasses; a fault must propagate as itself, never be dressed
    # up as an anticipated forum failure.
    _raise(patch_io, exc_type("fault"))
    with pytest.raises(exc_type):
        run(m.lw_get_user("x"))


def test_programming_error_text_never_reaches_the_client(patch_io, call_tool):
    # A fault that escapes the funnel still ends the call as a tool error, but its text stays
    # on the server: the client learns which tool failed, not the server's internals.
    _raise(patch_io, NotImplementedError("internal detail"))
    result = call_tool("lw_get_user", {"slug": "x"})
    assert result.is_error is True
    assert [c.text for c in result.content] == ["Error executing tool lw_get_user"]


@pytest.mark.parametrize(
    "make_exc",
    [
        pytest.param(lambda: _status_error(429), id="429"),
        pytest.param(lambda: _status_error(503), id="503"),
        pytest.param(lambda: httpx.ReadTimeout("t", request=_REQ), id="timeout"),
        pytest.param(lambda: httpx.ConnectError("c", request=_REQ), id="connect"),
        pytest.param(lambda: httpx.TooManyRedirects("r", request=_REQ), id="redirects"),
        pytest.param(lambda: httpx.DecodingError("d", request=_REQ), id="decoding"),
        pytest.param(lambda: httpx.InvalidURL("u"), id="invalid-url"),
        # GraphQL errors[], a malformed body and a refused redirect all arrive as this.
        pytest.param(lambda: errors.ForumAPIError("GraphQL error: boom"), id="forum-api-error"),
    ],
)
def test_funnel_reports_each_anticipated_failure_as_its_message(patch_io, run, make_exc):
    # Every anticipated failure becomes a ToolError carrying _handle_error's message for it.
    # The tool is called directly, so the check is on the ToolError type MCPServer keys on,
    # not only on the text a client would read.
    async def failing_graphql(site, query, variables=None):
        raise make_exc()

    patch_io("_graphql", failing_graphql)
    with pytest.raises(ToolError) as exc:
        run(m.lw_filter_posts())
    assert str(exc.value) == errors._handle_error(make_exc())


def test_anticipated_failure_is_logged_once_by_the_sdk(patch_io, call_tool, caplog):
    # The SDK logs every anticipated tool failure (a ToolError) at INFO, naming the tool and
    # carrying its message, so the funnel adds no line of its own.
    _raise(patch_io, httpx.ConnectError("c"))
    with caplog.at_level(logging.INFO):
        result = call_tool("lw_get_user", {"slug": "x"})
    assert result.is_error is True
    [record] = [r for r in caplog.records if "lw_get_user" in r.getMessage()]
    assert (record.name, record.levelno) == ("mcp.server.mcpserver.server", logging.INFO)
    message = record.getMessage()
    assert message.startswith("Tool 'lw_get_user' failed: ")
    assert errors._handle_error(httpx.ConnectError("c")) in message
    assert [r for r in caplog.records if r.name.startswith("lesswrong_mcp")] == []
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


def test_unexpected_fault_is_logged_at_error_with_its_traceback(patch_io, call_tool, caplog):
    # A fault that escapes the funnel is the operator's to diagnose: the SDK logs it once at
    # ERROR with the exception attached, so the log carries the traceback the client never sees.
    _raise(patch_io, NotImplementedError("internal detail"))
    with caplog.at_level(logging.INFO):
        result = call_tool("lw_get_user", {"slug": "x"})
    assert result.is_error is True
    [record] = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert (record.name, record.levelno) == ("mcp.server.mcpserver.server", logging.ERROR)
    assert "lw_get_user" in record.getMessage()
    assert record.exc_info is not None
    assert "Traceback (most recent call last)" in caplog.text
    assert "NotImplementedError: internal detail" in caplog.text
