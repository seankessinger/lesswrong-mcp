"""Schema-consistency checks across the tool surface: the id/slug identifier params share
one length bound, and lw_search's content-type param doesn't shadow the builtin `type`.
Both are pure schema generation (no network) via FastMCP's advertised inputSchema.
"""
from __future__ import annotations

import lesswrong_mcp as m


def _schema(run, name):
    tool = next(t for t in run(m.mcp.list_tools()) if t.name == name)
    return tool.inputSchema


def test_id_and_slug_params_share_one_length_bound(run):
    # Every id/slug identifier param caps at the same max_length (300), not a 300/200 mix.
    cases = [
        ("lw_get_post", "id_or_slug"),
        ("lw_get_comments", "id_or_slug"),
        ("lw_get_user", "slug"),
        ("lw_get_tag", "slug"),
        ("lw_get_sequence", "id_or_slug"),
    ]
    for tool_name, param in cases:
        prop = _schema(run, tool_name)["properties"][param]
        assert prop["maxLength"] == 300, (tool_name, param, prop.get("maxLength"))
        assert prop["minLength"] == 1


def test_lw_search_uses_content_type_not_builtin_type(run):
    props = _schema(run, "lw_search")["properties"]
    assert "content_type" in props
    assert "type" not in props


# --------------------------------------------------------------------------- #
# Schema flattening: nullable/enum params expose their constraints at the top level, so a
# client that reads only top-level JSON-Schema keywords still sees them (W1).
# --------------------------------------------------------------------------- #

def test_nullable_numeric_hoists_constraints_and_folds_null_into_type(run):
    p = _schema(run, "lw_filter_posts")["properties"]["min_karma"]
    assert p["minimum"] == -100 and p["maximum"] == 100000
    assert p["type"] == ["integer", "null"]      # not buried in an anyOf


def test_nullable_string_hoists_pattern(run):
    for name in ("after", "before"):
        p = _schema(run, "lw_filter_posts")["properties"][name]
        assert p["pattern"] == r"^\d{4}-\d{2}-\d{2}$"
        assert p["type"] == ["string", "null"]


def test_enum_ref_is_inlined(run):
    p = _schema(run, "lw_filter_posts")["properties"]
    assert set(p["sort"]["enum"]) == {"top", "new", "old", "magic", "recentComments"}
    assert p["sort"]["type"] == "string"
    assert set(p["site"]["enum"]) == {"lesswrong", "alignmentforum"}


def test_nullable_enum_becomes_enum_plus_null(run):
    ct = _schema(run, "lw_search")["properties"]["content_type"]
    assert set(ct["enum"]) == {"posts", "comments", "tags", "users", "sequences"}
    assert ct["type"] == ["string", "null"]


def test_plain_numeric_constraints_left_intact(run):
    # A non-nullable int already exposes top-level minimum/maximum; flatten must not disturb it.
    limit = _schema(run, "lw_filter_posts")["properties"]["limit"]
    assert limit["minimum"] == 1 and limit["maximum"] == 100 and limit["type"] == "integer"


def test_no_dangling_defs_or_refs_in_any_tool_schema(run):
    import lesswrong_mcp as m
    for tool in run(m.mcp.list_tools()):
        assert "$defs" not in tool.inputSchema, tool.name
        assert "$ref" not in repr(tool.inputSchema), tool.name


def test_apply_flat_schemas_preserves_a_zero_argument_tool_schema(run):
    # A tool with no parameters has a `properties`-less (empty) schema, for which
    # _flatten_parameters returns the SAME object; the in-place rewrite must detect that and
    # leave it alone rather than clear it to {} (which would drop type/title).
    from mcp.server.fastmcp import FastMCP

    from lesswrong_mcp.server import _apply_flat_schemas

    tmp = FastMCP("tmp")

    @tmp.tool(name="noop")
    def noop() -> str:
        return "ok"

    _apply_flat_schemas(tmp)
    schema = next(t for t in run(tmp.list_tools()) if t.name == "noop").inputSchema
    assert schema.get("type") == "object"  # preserved, not emptied to {}
