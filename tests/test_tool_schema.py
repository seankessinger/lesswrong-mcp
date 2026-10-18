"""Schema-consistency checks across the tool surface, read from the server's advertised
inputSchema and descriptions (pure schema generation, no network): each description is its
tool's cleaned docstring, parameter names the descriptions cite, property titles, the
flattened nullable constraints and inline choice enums, that every advertised default is
valid against its own property schema, and that each bound a description states is the bound
the schema enforces. The flattening is also checked against parameter shapes Pydantic
renders that no tool declares yet (multi-type unions, typeless literals, named and nested
enums), so a new parameter can't break it unnoticed.
"""
from __future__ import annotations

import inspect
import re
from enum import Enum
from typing import Annotated, Literal

import pytest
from jsonschema import Draft202012Validator
from pydantic import Field, RootModel, create_model

import lesswrong_mcp as m
from lesswrong_mcp import config
from lesswrong_mcp.server import _flatten_parameters, _flatten_schema


def test_lw_search_uses_content_type_not_builtin_type(tool_schema):
    props = tool_schema("lw_search")["properties"]
    assert "content_type" in props
    assert "type" not in props


def test_lw_get_sequence_description_names_real_params(listed_tool):
    # The listing is what the model reads; its pointer to lw_search must cite the real parameter.
    tool = listed_tool("lw_get_sequence")
    listing = tool.description + tool.input_schema["properties"]["sequence_id"]["description"]
    assert "lw_search(content_type='sequences')" in listing
    assert "(type='sequences')" not in listing


@pytest.mark.parametrize("name, param", [("lw_get_user", "slug"), ("lw_filter_posts", "author")])
def test_user_slug_descriptions_send_a_display_name_to_user_search(name, param, tool_schema):
    # Several accounts can share a display name, and a slug guessed from it can name another
    # account that exists, so no miss advice would fire: the description says where it comes from.
    desc = tool_schema(name)["properties"][param]["description"]
    assert "differs from the display name" in desc
    assert "lw_search(content_type='users')" in desc


def test_profile_post_count_is_compared_with_a_full_listing(listed_tool):
    # lw_filter_posts' `count` is one page's size, so the profile note sets the "Posts:"
    # figure against the author's whole listing, paged to the end, never one response.
    desc = listed_tool("lw_get_user").description
    assert "lw_filter_posts lists for the same author when paged to the end" in desc


def test_every_description_is_its_docstring_cleaned(run):
    # Each description is the tool's docstring with its source indentation and surrounding
    # blank lines removed, so clients read the same text whichever Python the server runs on
    # (3.13+ dedents docstrings when compiling them; earlier versions keep the indentation).
    for tool in run(m.mcp.list_tools()):
        doc = getattr(m, tool.name).__doc__
        assert tool.description == inspect.cleandoc(doc), tool.name


def test_every_property_title_derives_from_its_parameter_name(run):
    # Pydantic titles a parameter after its name; a choice parameter must not advertise its
    # type's name ('PostSort') instead.
    mistitled = [
        (tool.name, name, prop.get("title"))
        for tool in run(m.mcp.list_tools())
        for name, prop in tool.input_schema["properties"].items()
        if prop.get("title") != name.replace("_", " ").title()
    ]
    assert mistitled == []


def test_filter_posts_sort_description_explains_each_sort(tool_schema):
    # The model picks a sort from the description, so every choice carries its meaning.
    sort = tool_schema("lw_filter_posts")["properties"]["sort"]
    unexplained = [v for v in sort["enum"] if f"'{v}' (" not in sort["description"]]
    assert unexplained == []


# --------------------------------------------------------------------------- #
# Schema flattening: nullable and choice params expose their constraints at the top level, so
# a client that reads only top-level JSON-Schema keywords still sees them.
# --------------------------------------------------------------------------- #

def test_nullable_numeric_hoists_constraints_and_folds_null_into_type(tool_schema):
    p = tool_schema("lw_filter_posts")["properties"]["min_karma"]
    assert p["minimum"] == -100 and p["maximum"] == 100000
    assert p["type"] == ["integer", "null"]      # not buried in an anyOf


@pytest.mark.parametrize("name", ["after", "before"])
def test_nullable_date_hoists_its_format(tool_schema, name):
    p = tool_schema("lw_filter_posts")["properties"][name]
    assert p["format"] == "date"
    assert "pattern" not in p
    assert p["type"] == ["string", "null"]


def test_choice_params_advertise_a_top_level_enum(tool_schema):
    p = tool_schema("lw_filter_posts")["properties"]
    assert set(p["sort"]["enum"]) == {"top", "new", "old", "magic", "recentComments"}
    assert p["sort"]["type"] == "string"
    assert set(p["site"]["enum"]) == {"lesswrong", "alignmentforum"}


def test_nullable_enum_becomes_enum_plus_null(tool_schema):
    # JSON Schema checks `enum` independently of `type`, so null must be a listed value too.
    ct = tool_schema("lw_search")["properties"]["content_type"]
    assert set(ct["enum"]) == {"posts", "comments", "tags", "users", "sequences", None}
    assert ct["type"] == ["string", "null"]


def test_plain_numeric_constraints_left_intact(tool_schema):
    # A non-nullable int already exposes top-level minimum/maximum; flatten must not disturb it.
    limit = tool_schema("lw_filter_posts")["properties"]["limit"]
    assert limit["minimum"] == 1 and limit["maximum"] == 100 and limit["type"] == "integer"


def test_no_dangling_defs_or_refs_in_any_tool_schema(run):
    for tool in run(m.mcp.list_tools()):
        assert "$defs" not in tool.input_schema, tool.name
        assert "$ref" not in repr(tool.input_schema), tool.name


def test_every_default_validates_against_its_property_schema(run):
    invalid = [
        (tool.name, name, prop["default"])
        for tool in run(m.mcp.list_tools())
        for name, prop in tool.input_schema["properties"].items()
        if "default" in prop and not Draft202012Validator(prop).is_valid(prop["default"])
    ]
    assert invalid == []


def test_flatten_parameters_returns_a_new_closed_schema_for_a_zero_argument_tool():
    schema = {"type": "object", "properties": {}}
    flat = _flatten_parameters(schema)
    assert flat is not schema
    assert flat == {"type": "object", "properties": {}, "additionalProperties": False}
    assert schema == {"type": "object", "properties": {}}  # the input is left untouched


class _Choice(str, Enum):
    """A str Enum, which Pydantic renders as a `$ref` into `$defs`."""

    a = "a"
    b = "b"


class _MaybeChoice(RootModel[_Choice | None]):
    """A nullable choice under its own name: a `$ref` to a definition that is itself a
    nullable `anyOf`."""


# Parameter shapes a tool could declare, as (annotation, default). Each is rendered on its own
# by Pydantic, as MCPServer renders a tool's arguments, so whether `$defs` survives depends on
# that shape alone.
_SHAPES = {
    "literal": (Annotated[Literal["a", "b"], Field(description="own description")], "a"),
    "nullable_literal": (Annotated[Literal["a", "b"] | None, Field(description="own description")], None),
    "enum": (Annotated[_Choice, Field(description="own description")], _Choice.a),
    "nullable_enum": (Annotated[_Choice | None, Field(description="own description")], None),
    "named_nullable_enum": (_MaybeChoice, None),
    "nullable_int": (Annotated[int | None, Field(ge=1)], None),
    "nullable_mixed_literal": (Literal["a", 1] | None, None),
    "multi_type": (str | int | None, None),
    "enum_or_int": (_Choice | int | None, None),
    "enum_list": (list[_Choice], []),
}
_SAMPLES = [None, "a", "b", "c", 0, 1, 2, ["a"], ["c"], []]


def _original_and_flat(shape):
    original = create_model("Args", p=_SHAPES[shape]).model_json_schema()
    return original, _flatten_parameters(original)


def _accepts(schema):
    """Which of _SAMPLES the schema's `p` property accepts."""
    v = Draft202012Validator({**schema["properties"]["p"], "$defs": schema.get("$defs", {})})
    return [v.is_valid(sample) for sample in _SAMPLES]


@pytest.mark.parametrize("shape", sorted(_SHAPES))
def test_flattening_accepts_exactly_what_the_original_schema_accepts(shape):
    original, flat = _original_and_flat(shape)
    assert _accepts(flat) == _accepts(original)


@pytest.mark.parametrize(
    "shape", ["literal", "nullable_literal", "nullable_int", "nullable_mixed_literal"]
)
def test_flattening_hoists_a_single_variant_to_the_top_level(shape):
    _, flat = _original_and_flat(shape)
    prop = flat["properties"]["p"]
    assert "anyOf" not in prop and "$ref" not in prop
    assert "$defs" not in flat
    assert _flatten_schema(prop) == prop  # already flat: a second pass changes nothing


@pytest.mark.parametrize("shape", ["multi_type", "enum_or_int"])
def test_flattening_leaves_a_multi_type_union_as_an_any_of(shape):
    original, flat = _original_and_flat(shape)
    assert flat["properties"]["p"]["anyOf"] == original["properties"]["p"]["anyOf"]


@pytest.mark.parametrize("shape", ["literal", "nullable_literal"])
def test_flattening_keeps_a_parameters_own_description(shape):
    _, flat = _original_and_flat(shape)
    assert flat["properties"]["p"]["description"] == "own description"


@pytest.mark.parametrize(
    "shape", ["enum", "nullable_enum", "named_nullable_enum", "enum_list", "enum_or_int"]
)
def test_flattening_leaves_a_ref_and_its_defs_alone(shape):
    # An Enum or model parameter keeps its `$ref` (nullable or not, bare, under `items` or
    # inside a kept `anyOf`); test_no_dangling_defs_or_refs_in_any_tool_schema keeps every
    # tool free of one.
    original, flat = _original_and_flat(shape)
    assert flat["properties"]["p"] == original["properties"]["p"]
    assert flat["$defs"] == original["$defs"]


# --------------------------------------------------------------------------- #
# Bounds the descriptions state: the prose is hand-written, so it must agree with the bound
# the schema enforces, and cite the package's current caps.
# --------------------------------------------------------------------------- #

def test_described_bounds_match_the_schema_bounds(run):
    checked, mismatched = set(), []
    for tool in run(m.mcp.list_tools()):
        for name, prop in tool.input_schema["properties"].items():
            desc = prop.get("description", "")
            stated = [("maximum", int(n)) for n in re.findall(r"\bMax (\d+)\b", desc)]
            stated += [("minimum", int(n)) for n in re.findall(r"\bMinimum (\d+)\b", desc)]
            for low, high in re.findall(r"\bRange (-?\d+) to (-?\d+)\b", desc):
                stated += [("minimum", int(low)), ("maximum", int(high))]
            if stated:
                checked.add((tool.name, name))
            mismatched += [(tool.name, name, k, v) for k, v in stated if prop.get(k) != v]
    # The comparison reads these descriptions; without them it would pass vacuously.
    assert {("lw_filter_posts", "offset"), ("lw_search", "page"), ("lw_get_comments", "limit"),
            ("lw_get_post", "max_chars"), ("lw_get_comments", "max_chars")} <= checked
    assert mismatched == []


def test_search_page_description_cites_the_result_window(tool_schema):
    page = tool_schema("lw_search")["properties"]["page"]["description"]
    assert f"≤ {config.SEARCH_RESULT_WINDOW}" in page
    assert f"{config.SEARCH_RESULT_WINDOW:,}" in page


def test_tool_descriptions_cite_the_current_caps(run):
    # Tool descriptions are docstrings, which can't interpolate the constants. Matched as whole
    # numbers, so a cap of 200 is not found inside a stale 2000.
    descriptions = {t.name: t.description for t in run(m.mcp.list_tools())}
    assert re.search(rf"\b{config.MAX_GRAPHQL_SKIP}\b", descriptions["lw_filter_posts"])
    assert re.search(rf"\b{config.MAX_CHARS}\b", descriptions["lw_get_post"])
    assert re.search(rf"\b{config.MAX_CHARS}\b", descriptions["lw_get_comments"])


@pytest.mark.parametrize("name", ["lw_get_post", "lw_get_comments"])
def test_max_chars_is_capped_at_its_default(name, tool_schema):
    # A larger slice is more than a host reliably shows inline, so the default is also the
    # most one call returns, and there is no null for "everything at once".
    prop = tool_schema(name)["properties"]["max_chars"]
    assert prop["maximum"] == prop["default"] == config.MAX_CHARS
    assert prop["type"] == "integer"
