"""The MCP contract every registered tool keeps, checked through a real in-process client on
both protocol eras (the `call_tool` fixture) rather than by calling the coroutines directly:
that is the only view that sees what registration and the server's hooks do to each tool.
Every tool is annotated read-only, failures arrive as tool errors, results are plain text,
unknown and out-of-range arguments are rejected before any request, every identifier declares
one bare pattern and a value that misses it is refused with its kind's advice, an unknown tool
is reported by name, and explicit nulls, stringified numbers and plain-string dates and choices
are accepted. Each era is really negotiated, the server reports the package's own version, its
instructions and capabilities that hold nothing a client could subscribe to, and its protocol
handler serves the server's own tool listing (flattened schemas included) unchanged. The
package root exports no private helper.

Hermetic: the network-I/O seams are patched through the conftest fixtures.
"""
from __future__ import annotations

import json
import logging
import re

import httpx
import pytest
from mcp.client import Client
from mcp.server.mcpserver import MCPServer

import lesswrong_mcp as m
from lesswrong_mcp import config
from lesswrong_mcp.server import _flatten_parameters

# The smallest valid arguments for each tool. Keyed by every registered tool name (checked
# below), so a tool added without an entry here fails rather than skipping the contract.
MINIMAL_ARGS: dict[str, dict] = {
    "lw_search": {"query": "ab"},
    "lw_get_post": {"id_or_slug": "x"},
    "lw_get_comments": {"id_or_slug": "x"},
    "lw_get_user": {"slug": "x"},
    "lw_get_tag": {"slug": "x"},
    "lw_get_sequence": {"sequence_id": "x"},
    "lw_list_feed": {},
    "lw_filter_posts": {},
}


def test_contract_table_covers_every_registered_tool(run):
    assert {t.name for t in run(m.mcp.list_tools())} == set(MINIMAL_ARGS)


def test_every_tool_is_annotated_read_only_with_a_title(run):
    for tool in run(m.mcp.list_tools()):
        a = tool.annotations
        assert a is not None, tool.name
        hints = (a.read_only_hint, a.destructive_hint, a.idempotent_hint, a.open_world_hint)
        assert hints == (True, False, True, True), tool.name
        assert a.title, tool.name


@pytest.mark.parametrize("name", sorted(MINIMAL_ARGS))
def test_every_tool_reports_network_failure_as_tool_error(name, patch_io, call_tool):
    # The registered callable, not just the module-level one, must carry the error funnel:
    # without it the raw exception text ("down") reaches the client instead of the message.
    async def unreachable(method, url, **kwargs):
        raise httpx.ConnectError("down")

    patch_io("_request", unreachable)
    result = call_tool(name, MINIMAL_ARGS[name])
    assert result.is_error is True
    assert "network error" in result.content[0].text


def test_tools_return_plain_text_without_structured_content(run, markdown_stub, call_tool):
    assert [t.name for t in run(m.mcp.list_tools()) if t.output_schema is not None] == []
    body = "# cleo-nardo\n\n- Karma: 1234\n"
    markdown_stub(body)
    result = call_tool("lw_get_user", {"slug": "cleo-nardo"})
    assert result.is_error is False
    assert result.structured_content is None
    assert result.content[0].text == body


def test_unknown_argument_is_rejected(run, markdown_stub, call_tool):
    # `type` is not lw_search's parameter (`content_type` is): it must fail loudly rather than
    # be dropped, which would silently run an unfiltered all-types search.
    captured = markdown_stub("results")
    result = call_tool("lw_search", {"query": "ab", "type": "sequences"})
    assert result.is_error is True
    # Reported in the shape of every other argument error: a validation error naming the
    # tool's argument model and the offending argument.
    assert result.content[0].text.startswith(
        "Error executing tool lw_search: 1 validation error for lw_searchArguments\n"
        "type\n  Extra inputs are not permitted [type=extra_forbidden, input_value='sequences'"
    )
    assert captured["calls"] == []
    # The advertised schema says the same thing the server enforces.
    for tool in run(m.mcp.list_tools()):
        assert tool.input_schema["additionalProperties"] is False, tool.name


def test_every_unknown_argument_is_named(markdown_stub, call_tool):
    captured = markdown_stub("# Post")
    result = call_tool("lw_get_post", {"id_or_slug": "x", "maxchars": 1000, "bogus": 1})
    assert result.is_error is True
    text = result.content[0].text
    assert "2 validation errors for lw_get_postArguments" in text
    assert "\nmaxchars\n" in text and "\nbogus\n" in text
    assert captured["calls"] == []


def test_a_misspelt_required_argument_is_reported_with_the_one_it_stands_for(markdown_stub, call_tool):
    # The unknown name alone would leave the caller guessing which argument it meant.
    captured = markdown_stub("# Post")
    result = call_tool("lw_get_post", {"id_or_slg": "x"})
    assert result.is_error is True
    text = result.content[0].text
    assert "2 validation errors for lw_get_postArguments" in text
    assert "\nid_or_slug\n  Field required" in text
    assert "\nid_or_slg\n  Extra inputs are not permitted" in text
    assert captured["calls"] == []


def test_unknown_argument_is_reported_before_an_invalid_one(markdown_stub, call_tool):
    # Unknown names are refused before the known arguments are validated, so a call that also
    # carries an out-of-range value learns about the misspelling first.
    captured = markdown_stub("results")
    result = call_tool("lw_search", {"query": "a", "type": "sequences"})
    assert result.is_error is True
    text = result.content[0].text
    assert text.startswith(
        "Error executing tool lw_search: 1 validation error for lw_searchArguments\ntype\n"
    )
    assert "query" not in text
    assert captured["calls"] == []


def test_unknown_argument_is_logged_by_name_only(markdown_stub, call_tool, caplog):
    # The server logs which arguments it refused, never their values: those are the caller's.
    markdown_stub("results")
    with caplog.at_level(logging.INFO, logger="mcp"):
        call_tool("lw_search", {"query": "ab", "type": "secret-value"})
    assert "rejected arguments: ['type']" in caplog.text
    assert "secret-value" not in caplog.text


def test_unknown_tool_is_reported_by_name(call_tool):
    result = call_tool("lw_nope", {"x": 1})
    assert result.is_error is True
    assert [c.text for c in result.content] == ["Unknown tool: lw_nope"]


@pytest.mark.parametrize(
    "name, args, field",
    [
        ("lw_filter_posts", {"offset": config.MAX_GRAPHQL_SKIP + 1}, "offset"),
        # Not ISO-shaped, or ISO-shaped but not a calendar day.
        ("lw_filter_posts", {"after": "2025/01/01"}, "after"),
        ("lw_filter_posts", {"after": "2025-02-30"}, "after"),
        ("lw_filter_posts", {"before": "2025-13-01"}, "before"),
        # A number (which MCPServer may pre-parse from a numeric string) is not read as a Unix
        # timestamp, and a partial date or a datetime is not widened to a day.
        ("lw_filter_posts", {"after": "0"}, "after"),
        ("lw_filter_posts", {"before": "1672531200"}, "before"),
        ("lw_filter_posts", {"after": 1672531200}, "after"),
        ("lw_filter_posts", {"after": "2023"}, "after"),
        ("lw_filter_posts", {"after": "2023-01"}, "after"),
        ("lw_filter_posts", {"before": "2023-01-01T00:00:00"}, "before"),
        ("lw_filter_posts", {"author": "a" * 301}, "author"),
        ("lw_filter_posts", {"tags": ["a"] * 11}, "tags"),
        ("lw_search", {"query": "a"}, "query"),
        # limit=1 keeps page × limit inside the result window, so only the page bound refuses it.
        ("lw_search", {"query": "ab", "page": config.SEARCH_PAGE_MAX + 1, "limit": 1}, "page"),
        ("lw_search", {"query": "ab", "limit": 21}, "limit"),
        ("lw_get_user", {"slug": ""}, "slug"),
        ("lw_get_sequence", {"sequence_id": "a" * 301}, "sequence_id"),
        ("lw_get_post", {"id_or_slug": "x", "max_chars": 499}, "max_chars"),
        ("lw_get_post", {"id_or_slug": "x", "max_chars": config.MAX_CHARS + 1}, "max_chars"),
        ("lw_get_post", {"id_or_slug": "x", "max_chars": None}, "max_chars"),
        ("lw_get_comments", {"id_or_slug": "x", "max_chars": 499}, "max_chars"),
        ("lw_get_comments", {"id_or_slug": "x", "max_chars": config.MAX_CHARS + 1}, "max_chars"),
        ("lw_get_comments", {"id_or_slug": "x", "max_chars": None}, "max_chars"),
        ("lw_get_comments", {"id_or_slug": "x", "limit": 2001}, "limit"),
        ("lw_get_comments", {"id_or_slug": "x", "comment_id": ""}, "comment_id"),
        ("lw_list_feed", {"limit": 101}, "limit"),
    ],
)
def test_out_of_range_argument_is_rejected_before_any_request(name, args, field, patch_io, call_tool):
    # The argument model refuses the value: a request that slips past it is recorded, and
    # fails with a network error rather than a validation error.
    reached = _record_requests(patch_io)
    result = call_tool(name, args)
    assert result.is_error is True
    text = result.content[0].text
    assert "validation error" in text and field in text
    assert reached == []


def _record_requests(patch_io) -> list[str]:
    """Patch `_request` to record each URL it is asked for and fail it as unreachable, and
    return the list it records into."""
    reached: list[str] = []

    async def record(method, url, **kwargs):
        reached.append(url)
        raise httpx.ConnectError("unreachable")

    patch_io("_request", record)
    return reached


# --------------------------------------------------------------------------- #
# Identifier parameters: one bare shape, refused with the kind's advice
# --------------------------------------------------------------------------- #

REF = "^[A-Za-z0-9_-]+$"
# Every identifier a tool takes: (tool, param, a fragment of that kind's advice).
IDENTIFIERS = [
    ("lw_get_post", "id_or_slug", "/api/post/<id>"), ("lw_get_comments", "id_or_slug", "/api/post/<id>"),
    ("lw_get_comments", "comment_id", "?commentId="), ("lw_get_user", "slug", "content_type='users'"),
    ("lw_get_tag", "slug", "content_type='tags'"), ("lw_get_sequence", "sequence_id", "content_type='sequences'"),
    ("lw_filter_posts", "author", "content_type='users'"),
]
NOT_BARE = ["https://www.lesswrong.com/posts/abc/x", "/api/post/abc", "abc?compact=1", "abc#x",
            "a b", "abc\n", "..", "", " ai", "ai ", "Zoë", "é", "ａｉ"]
FREE_TEXT = {("lw_search", "query")}


def test_identifier_params_declare_the_pattern(tool_schema):
    # A client can see the shape before calling: each identifier is one bare value of at most
    # 300 characters, and `tags` is a list of one to 10 of them.
    for tool, param, _ in IDENTIFIERS:
        prop = tool_schema(tool)["properties"][param]
        assert (prop.get("pattern"), prop.get("maxLength")) == (REF, 300), (tool, param)
    tags = tool_schema("lw_filter_posts")["properties"]["tags"]
    assert (tags["items"].get("pattern"), tags.get("minItems"), tags.get("maxItems")) == (REF, 1, 10)


@pytest.mark.parametrize("value", NOT_BARE)
@pytest.mark.parametrize("tool, param, fragment", IDENTIFIERS)
def test_identifier_params_refuse_a_value_that_is_not_bare(tool, param, fragment, value, patch_io, call_tool):
    # A link, a path, a query or fragment, whitespace, a dot segment, an empty value or a
    # look-alike letter is refused by the argument model with the advice for its kind, before
    # any request.
    reached = _record_requests(patch_io)
    result = call_tool(tool, {**MINIMAL_ARGS[tool], param: value})
    assert result.is_error is True
    text = result.content[0].text
    assert "not a link" in text and fragment in text
    assert reached == []


@pytest.mark.parametrize("value", NOT_BARE)
def test_tag_items_refuse_a_value_that_is_not_bare(value, patch_io, call_tool):
    # Each item of `tags` is a tag slug, refused like `lw_get_tag`'s, and the error names the
    # item at fault.
    reached = _record_requests(patch_io)
    result = call_tool("lw_filter_posts", {"tags": ["ai", value]})
    assert result.is_error is True
    text = result.content[0].text
    assert "not a link" in text and "content_type='tags'" in text
    assert "\ntags.1\n" in text
    assert reached == []


@pytest.mark.parametrize(
    "tags, expected",
    [
        ([], "at least 1 item"),
        (["a"] * 11, "at most 10 items"),
        (["ai, x"], "content_type='tags'"),
        (["/w/ai"], "content_type='tags'"),
        ([""], "content_type='tags'"),
        ("ai", "valid list"),
    ],
)
def test_tags_refuse_a_malformed_list(tags, expected, patch_io, call_tool):
    # An empty or over-long list, a comma-joined, path-like or blank item, and a lone string in
    # place of the array are all refused before any slug lookup.
    lookups: list[str] = []

    async def fake_graphql(site, query, variables=None):
        lookups.append(query)
        return {}

    patch_io("_graphql", fake_graphql)
    result = call_tool("lw_filter_posts", {"tags": tags})
    assert result.is_error is True
    text = result.content[0].text
    assert expected in text
    # Only an item that misses the pattern carries the tag advice; a length or type error
    # keeps pydantic's own text.
    assert ("ref_shape" in text) == (expected == "content_type='tags'")
    assert lookups == []


@pytest.mark.parametrize(
    "slug, expected",
    [("a b", "not a link"), ("a" * 301, "at most 300 characters"), (5, "valid string")],
)
def test_the_shape_text_replaces_only_a_pattern_miss(slug, expected, patch_io, call_tool):
    # The kind's advice stands in for pydantic's regex text, and only for that: a value too
    # long or of the wrong type reads as pydantic says it.
    reached = _record_requests(patch_io)
    result = call_tool("lw_get_user", {"slug": slug})
    assert result.is_error is True
    text = result.content[0].text
    assert expected in text
    assert ("not a link" in text) == (expected == "not a link")
    assert reached == []


def test_every_string_parameter_is_patterned_enumerated_or_free_text(run):
    # A string that reaches a route or a lookup carries the identifier pattern, and every other
    # string is a choice (enum) or a date (format); only free text is left open, and it is
    # named here. A list is checked by its items.
    open_strings = set()
    for tool in run(m.mcp.list_tools()):
        for name, prop in tool.input_schema["properties"].items():
            for node in (prop, prop.get("items") or {}):
                types = node.get("type") or []
                types = [types] if isinstance(types, str) else types
                if "string" in types and not {"pattern", "enum", "format"} & node.keys():
                    open_strings.add((tool.name, name))
    assert open_strings == FREE_TEXT


def test_explicit_nulls_are_accepted_over_mcp(markdown_stub, call_tool):
    markdown_stub("ok")
    assert call_tool("lw_search", {"query": "ab", "content_type": None}).is_error is False
    assert call_tool("lw_get_comments", {"id_or_slug": "x", "comment_id": None}).is_error is False


def test_stringified_number_args_coerce(markdown_stub, call_tool):
    # Some clients send numbers as JSON strings; forbidding extras must not make the
    # argument model strict about types.
    captured = markdown_stub("feed")
    result = call_tool("lw_list_feed", {"limit": "20"})
    assert result.is_error is False
    assert captured["params"] == {"limit": 20}


def test_date_and_choice_params_accept_plain_strings_over_mcp(patch_io, markdown_stub, call_tool):
    # Over MCP a date or a choice arrives as a JSON string, and a client such as Claude Desktop
    # stringifies numbers and booleans too; each is accepted and sent upstream as the forum
    # expects it.
    sent: list[tuple[str, dict]] = []

    async def fake_graphql(site, query, variables=None):
        sent.append((site, variables))
        return {"posts": {"results": []}}

    patch_io("_graphql", fake_graphql)
    result = call_tool("lw_filter_posts", {
        "after": "2025-01-01", "before": "2025-01-31", "sort": "recentComments",
        "response_format": "json", "site": "alignmentforum",
        "min_karma": "5", "alignment_forum_only": "true", "limit": "3",
    })
    assert result.is_error is False
    assert json.loads(result.content[0].text)["count"] == 0
    assert sent == [("alignmentforum", {
        "selector": {"recentComments": {
            "sortedBy": "recentComments", "after": "2025-01-01", "before": "2025-02-01",
            "karmaThreshold": 5, "af": True,
        }},
        "limit": 4, "offset": 0,
    })]

    captured = markdown_stub("results")
    assert call_tool("lw_search", {"query": "ab", "content_type": "sequences"}).is_error is False
    assert captured["params"]["type"] == "sequences"


def _connect(run, era: str):
    """What a client learns on connecting in `era`: the negotiated protocol version, the
    server's identity and its capabilities."""
    async def connect():
        async with Client(m.mcp, mode=era) as client:
            return client.protocol_version, client.server_info, client.server_capabilities

    return run(connect())


def test_each_protocol_era_is_negotiated(run, protocol_era):
    # "auto" must really reach the 2026-07-28 era rather than fall back to the handshake, or
    # every through-MCP test would run the 2025-11-25 path twice.
    version, _, _ = _connect(run, protocol_era)
    assert version == {"legacy": "2025-11-25", "auto": "2026-07-28"}[protocol_era]


def test_server_reports_package_version(run, protocol_era):
    # What a client reads from the handshake (serverInfo) is the package's own version.
    _, info, _ = _connect(run, protocol_era)
    assert info is not None
    assert (info.name, info.version) == ("lesswrong_mcp", m.__version__)


def test_capabilities_advertise_a_fixed_tool_set(run, protocol_era):
    # The tool set is fixed and there are no resources or prompts, so nothing advertises a
    # list that can change or a subscription a client could hold.
    _, _, caps = _connect(run, protocol_era)
    assert caps.model_dump(by_alias=True, exclude_none=True, mode="json") == {
        "prompts": {"listChanged": False},
        "resources": {"listChanged": False, "subscribe": False},
        "tools": {"listChanged": False},
    }


def test_clients_receive_the_server_instructions_on_each_era(run, protocol_era):
    # Hosts read the instructions to decide when to reach for this server: they name the tool to
    # start with, the one that fetches a post and the precise filter, in that order, say that
    # one backend serves both forums, give the link-to-value summary a host without the
    # per-parameter descriptions still needs (each link form and the comment-link rule), stay
    # short, and cite only tools the server registers.
    async def instructions():
        async with Client(m.mcp, mode=protocol_era) as client:
            return client.instructions

    text = run(instructions())
    assert text is not None and text == m.mcp.instructions
    assert text.index("lw_search") < text.index("lw_get_post") < text.index("lw_filter_posts")
    assert "LessWrong" in text and "Alignment Forum" in text and "one backend" in text
    for fragment in (
        "/api/post/<id>", "/users/<slug>", "/w/<slug>", "/s/<id>", "/s/<seq>/p/<id>",
        "?commentId=<cid>", "17-character",
        "lw_get_comments(id_or_slug=<post>, comment_id=<cid>)",
    ):
        assert fragment in text, fragment
    assert len(text) <= 1000
    assert set(re.findall(r"\blw_\w+", text)) <= set(MINIMAL_ARGS)


def test_clients_receive_the_listed_tools_on_each_era(run, protocol_era):
    # The schema and description assertions elsewhere read `m.mcp.list_tools()`; this pins
    # that the protocol handler serves exactly that listing on each era, and that each schema
    # in it is the generated one through `_flatten_parameters`, so the flattened, closed
    # schemas and cleaned descriptions are what a client actually receives.
    async def listed():
        async with Client(m.mcp, mode=protocol_era) as client:
            return (await client.list_tools()).tools

    served = run(listed())
    expected = run(m.mcp.list_tools())
    assert [t.model_dump() for t in served] == [t.model_dump() for t in expected]
    # The base class's listing carries the schemas as generated, before the server's hook.
    generated = {t.name: t.input_schema for t in run(MCPServer.list_tools(m.mcp))}
    for tool in served:
        assert tool.input_schema == _flatten_parameters(generated[tool.name]), tool.name


def test_no_nullable_any_of_reaches_a_client(run, protocol_era):
    # The property the flattening exists for: every optional parameter a client receives keeps
    # its constraints at the top level, with null folded into its `type`, never a level down
    # in a nullable `anyOf`.
    async def listed():
        async with Client(m.mcp, mode=protocol_era) as client:
            return (await client.list_tools()).tools

    buried = [
        (tool.name, name)
        for tool in run(listed())
        for name, prop in tool.input_schema["properties"].items()
        if any(variant.get("type") == "null" for variant in prop.get("anyOf", []))
    ]
    assert buried == []
    nullable = {
        (tool.name, name)
        for tool in run(listed())
        for name, prop in tool.input_schema["properties"].items()
        if "null" in (prop.get("type") or [])
    }
    # The check reads these optional parameters; without them it would pass vacuously.
    assert {("lw_filter_posts", "min_karma"), ("lw_get_comments", "comment_id")} <= nullable


def test_private_helpers_are_not_reexported():
    # A private helper re-exported from the package root would be a copy the IO_HOME patch
    # never reaches: `m._get_markdown(...)` would bypass a stub and try the network. Reaching
    # one through the root is an AttributeError instead; internals are imported from their
    # home module.
    for name in ("_request", "_get_markdown", "_graphql"):
        assert not hasattr(m, name), name
    assert [n for n in vars(m) if n.startswith("_") and not n.endswith("__")] == []
