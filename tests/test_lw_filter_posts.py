"""Tests for lw_filter_posts: the GraphQL request it builds (above all the tag filter), its
paging signals, the Markdown and JSON it renders, and what its description tells the model
about karma, the Alignment Forum and `count`.

The selector builder and the paging maths are pure (`_posts_selector`, `_page_signal`), so
their edge cases are tested directly. The tool-level tests are hermetic: they stub `_graphql`
(via the shared `patch_io` seam) so nothing touches the network, and assert on the exact
GraphQL `selector` the tool sends — slugs resolved to _ids, a tag applied as a
`filterSettings` required-tag on the requested sort view — and on the site, offset and limit
it sends. The live-endpoint tests at the bottom are marked `live`: they exercise the real API
and are skipped unless LW_LIVE_TESTS=1, so the default `pytest` run stays offline and
deterministic.

Run:  pytest tests/test_lw_filter_posts.py
Live: LW_LIVE_TESTS=1 pytest tests/test_lw_filter_posts.py -m live
"""
from __future__ import annotations

import json
from datetime import date

import pytest
from mcp.server.mcpserver.exceptions import ToolError

import lesswrong_mcp as m
from lesswrong_mcp import config
from lesswrong_mcp.tools import _page_signal, _posts_selector

# Stable fixture ids used by the fake resolver below.
MESA_ID = "NZ67PZ8CkeS6xn27h"       # tag slug 'mesa-optimization' -> this _id
INNER_ID = "aBcDeFgHiJkLmNoP1"      # tag slug 'inner-alignment'   -> this _id
AI_ID = "sYm3HiWcfZvrGu3ui"         # tag slug 'ai'                -> this _id
EVHUB_ID = "EQNTWXLKMeWMp2FQS"      # user slug 'evhub' -> this _id
INTERP_ID = "interpid"              # tag slug 'interpretability' -> this _id
_CANNED_POST = {
    "_id": "FkgsxrGf3QxhfLWHG",
    "title": "Risks from Learned Optimization: Introduction",
    "slug": "risks-from-learned-optimization-introduction",
    "pageUrl": "https://www.lesswrong.com/posts/FkgsxrGf3QxhfLWHG/x",
    "postedAt": "2019-05-31T23:42:33.149Z",
    "baseScore": 188,
    "commentCount": 42,
    "user": {"displayName": "evhub", "slug": "evhub"},
}


def _install_fake_graphql(patch_io, post=_CANNED_POST):
    """Replace `_graphql` with a fake that records every call and returns canned data: the
    posts() query answers with the single row `post`.

    Returns the `calls` list of (query, variables). Tag/user slug resolution is
    faked so only the tags 'mesa-optimization' / 'inner-alignment' / 'ai' /
    'interpretability' / 'tag-0' … 'tag-9' and the user 'evhub' resolve; everything else
    comes back empty (so the not-found error paths are exercised for real).
    """
    calls: list[tuple[str, dict]] = []

    async def fake_graphql(site, query, variables=None):
        variables = variables or {}
        calls.append((query, variables))
        if "tags(" in query:
            slug = variables["s"]["tagBySlug"]["slug"]
            tag_ids = {
                "mesa-optimization": MESA_ID, "inner-alignment": INNER_ID, "ai": AI_ID,
                "interpretability": INTERP_ID,
                **{f"tag-{n}": f"tagid{n}" for n in range(10)},
            }
            results = [{"_id": tag_ids[slug]}] if slug in tag_ids else []
            return {"tags": {"results": results}}
        if "users(" in query:
            slug = variables["s"]["usersProfile"]["slug"]
            results = [{"_id": EVHUB_ID}] if slug == "evhub" else []
            return {"users": {"results": results}}
        if "posts(" in query:
            return {"posts": {"results": [dict(post)]}}
        raise AssertionError(f"unexpected GraphQL query: {query[:60]}")

    patch_io("_graphql", fake_graphql)
    return calls


def _install_paging_graphql(patch_io, score=None):
    """Replace `_graphql` with a fake whose posts() query returns as many rows as it asks
    for, so the tool's limit+1 probe always finds a surplus row. Row i is `_CANNED_POST`
    with `_id` 'p<i>' and, when `score` is given, baseScore score(i).

    Returns the list of (site, variables) each call sent.
    """
    sent: list[tuple[str, dict]] = []
    score = score or (lambda i: _CANNED_POST["baseScore"])

    async def fake_graphql(site, query, variables=None):
        sent.append((site, variables))
        rows = [
            {**_CANNED_POST, "_id": f"p{i}", "baseScore": score(i)}
            for i in range(variables["limit"])
        ]
        return {"posts": {"results": rows}}

    patch_io("_graphql", fake_graphql)
    return sent


def _sent_selector(calls):
    """Pull the `selector` variable from the (single) posts(...) query the tool sent."""
    posts_calls = [v for q, v in calls if "posts(" in q]
    assert len(posts_calls) == 1, f"expected exactly one posts() query, got {len(posts_calls)}"
    return posts_calls[0]["selector"]


# --------------------------------------------------------------------------- #
# offset upper bound — the GraphQL posts selector rejects skip > MAX_GRAPHQL_SKIP
# --------------------------------------------------------------------------- #

def test_offset_upper_bound_matches_graphql_skip_cap(tool_schema):
    # The advertised offset ceiling must match the backend's hard skip cap, so an over-limit
    # offset fails fast as a Pydantic validation error at the tool boundary instead of
    # surfacing an opaque 'Exceeded maximum value for skip' GraphQL error mid-call, and the
    # description tells the model what that ceiling is. `maximum` is inclusive: an offset of
    # exactly the cap is allowed.
    offset = tool_schema("lw_filter_posts")["properties"]["offset"]
    assert offset["maximum"] == config.MAX_GRAPHQL_SKIP
    assert offset["minimum"] == 0
    assert f"Max {config.MAX_GRAPHQL_SKIP}." in offset["description"]


# --------------------------------------------------------------------------- #
# What the description tells the model: which karma, the Alignment Forum scope, `count`
# --------------------------------------------------------------------------- #

def _described(listed_tool):
    """lw_filter_posts as listed: its description with each run of whitespace collapsed (so
    the prose checks don't depend on where the docstring wraps), and its schema properties."""
    tool = listed_tool("lw_filter_posts")
    return " ".join(tool.description.split()), tool.input_schema["properties"]


def test_karma_descriptions_name_lesswrong_karma_on_either_site(listed_tool):
    # The `karma` field, min_karma and sort='top' all use LessWrong's baseScore, on
    # site='alignmentforum' too, so the model must not read them as the Alignment Forum's
    # own score (afBaseScore).
    description, props = _described(listed_tool)
    assert "LessWrong karma (baseScore)" in props["min_karma"]["description"]
    assert "on either site" in props["min_karma"]["description"]
    assert "'top' (highest LessWrong karma)" in props["sort"]["description"]
    assert "Karma is LessWrong's score (baseScore) on either site" in description
    assert "never the separate Alignment Forum score (afBaseScore)" in description


def test_alignment_forum_only_is_described_as_redundant_on_the_alignment_forum(listed_tool):
    # site='alignmentforum' already returns only Alignment Forum posts.
    description, props = _described(listed_tool)
    assert "Redundant on site='alignmentforum'" in props["alignment_forum_only"]["description"]
    assert "alignment_forum_only changes nothing there" in description


def test_description_defines_count_as_the_size_of_this_page(listed_tool):
    # `count` is len(posts) after the min_karma trim: neither a total nor a figure to compare
    # with a profile's "Posts:".
    description, _ = _described(listed_tool)
    assert "`count` is the number of posts in this response" in description
    assert "not a total" in description


# --------------------------------------------------------------------------- #
# The selector the tool sends
# --------------------------------------------------------------------------- #

def test_tag_by_slug_applies_filter_settings_not_tag_relevance(patch_io, run):
    calls = _install_fake_graphql(patch_io)
    out = run(m.lw_filter_posts(tags=["mesa-optimization"], sort="top", limit=8))

    selector = _sent_selector(calls)
    # The view is the requested sort; the tag rides on it via filterSettings.
    assert set(selector) == {"top"}, selector
    inner = selector["top"]
    assert inner["filterSettings"] == {"tags": [{"tagId": MESA_ID, "filterMode": "Required"}]}
    # A bare `tagId` term is not used — the sort views don't accept one.
    assert "tagId" not in inner
    assert inner["sortedBy"] == "top"
    # Header truthfully reports the applied tag.
    assert "tags=mesa-optimization" in out.splitlines()[0]


def test_every_filter_reaches_the_selector(patch_io, run):
    # Each argument becomes its term on the requested sort's view, slugs resolved to _ids.
    calls = _install_fake_graphql(patch_io)
    run(m.lw_filter_posts(
        author="evhub", tags=["mesa-optimization"], after=date(2023, 1, 1),
        before=date(2023, 12, 31), min_karma=100, alignment_forum_only=True, sort="new",
    ))
    assert _sent_selector(calls) == {"new": {
        "sortedBy": "new",
        "userId": EVHUB_ID,
        "filterSettings": {"tags": [{"tagId": MESA_ID, "filterMode": "Required"}]},
        "after": "2023-01-01",
        "before": "2024-01-01",
        "karmaThreshold": 100,
        "af": True,
    }}


def test_unknown_tag_errors_and_never_queries_posts(patch_io, run):
    calls = _install_fake_graphql(patch_io)
    with pytest.raises(ToolError, match="no tag found"):
        run(m.lw_filter_posts(tags=["no-such-tag-xyz"], sort="top"))

    # An unresolved tag errors out; it must not run an unfiltered posts() query.
    assert not any("posts(" in q for q, _ in calls)


# --------------------------------------------------------------------------- #
# The selector builder on its own
# --------------------------------------------------------------------------- #

def test_selector_without_filters_is_the_bare_sort_view():
    assert _posts_selector("magic") == {"magic": {"sortedBy": "magic"}}


@pytest.mark.parametrize(
    "before, sent",
    [
        (date(2020, 1, 1), "2020-01-02"),
        (date(2024, 2, 28), "2024-02-29"),
        # The last representable date can't be advanced and nothing lies past it, so the
        # range is left open-ended.
        (date.max, None),
    ],
)
def test_selector_makes_before_inclusive(before, sent):
    # The selector treats `before` as an exclusive midnight bound, so it advances one day.
    assert _posts_selector("top", before=before)["top"].get("before") == sent


def test_selector_requires_each_distinct_tag_once():
    selector = _posts_selector("top", tag_ids=[MESA_ID, INNER_ID, MESA_ID])
    assert selector["top"]["filterSettings"]["tags"] == [
        {"tagId": MESA_ID, "filterMode": "Required"},
        {"tagId": INNER_ID, "filterMode": "Required"},
    ]


# --------------------------------------------------------------------------- #
# Multiple required tags — their intersection
# --------------------------------------------------------------------------- #

def test_multiple_tags_are_all_required(patch_io, run):
    calls = _install_fake_graphql(patch_io)
    run(m.lw_filter_posts(tags=["mesa-optimization", "inner-alignment"], sort="top"))
    inner = _sent_selector(calls)["top"]
    assert inner["filterSettings"] == {
        "tags": [
            {"tagId": MESA_ID, "filterMode": "Required"},
            {"tagId": INNER_ID, "filterMode": "Required"},
        ]
    }


def test_one_unresolvable_tag_in_a_list_errors_with_that_slug(patch_io, run):
    calls = _install_fake_graphql(patch_io)
    with pytest.raises(ToolError, match="not-a-real-tag"):
        run(m.lw_filter_posts(tags=["mesa-optimization", "not-a-real-tag"], sort="top"))
    # A bad tag anywhere in the list aborts before the posts() query runs.
    assert not any("posts(" in q for q, _ in calls)


def test_filter_posts_allows_tags_up_to_the_cap(patch_io, call_tool):
    # The argument model bounds the list, so only a call over MCP shows the cap itself passes.
    calls = _install_fake_graphql(patch_io)
    result = call_tool("lw_filter_posts", {"tags": [f"tag-{n}" for n in range(10)]})
    assert result.is_error is False
    tags = _sent_selector(calls)["top"]["filterSettings"]["tags"]
    assert [t["tagId"] for t in tags] == [f"tagid{n}" for n in range(10)]


def test_filter_posts_dedupes_tags(patch_io, run):
    # A repeated slug reaches the server once and the selector requires its tag once, in
    # first-seen order. The slug cache and the selector's own id dedupe give the same result
    # without the tool's dedupe, so this does not pin it: test_tags_keep_first_seen_order_once
    # does, through the header.
    calls = _install_fake_graphql(patch_io)
    run(m.lw_filter_posts(tags=["ai", "ai", "mesa-optimization"]))
    assert len([q for q, _ in calls if "tags(" in q]) == 2
    tags = _sent_selector(calls)["top"]["filterSettings"]["tags"]
    assert [t["tagId"] for t in tags] == [AI_ID, MESA_ID]


def test_tags_keep_first_seen_order_once(patch_io, call_tool):
    # Over MCP too: each distinct slug is looked up once, in the order first given, and the
    # header names each once in that order.
    calls = _install_fake_graphql(patch_io)
    result = call_tool("lw_filter_posts", {"tags": ["ai", "interpretability", "ai"]})
    assert result.is_error is False
    assert [v["s"]["tagBySlug"]["slug"] for q, v in calls if "tags(" in q] == ["ai", "interpretability"]
    tags = _sent_selector(calls)["top"]["filterSettings"]["tags"]
    assert [t["tagId"] for t in tags] == [AI_ID, INTERP_ID]
    header = result.content[0].text.splitlines()[0]
    assert header.split(" — ", 1)[1] == "tags=ai,interpretability, sort=top"


def test_tags_as_a_json_string_work_like_the_array(patch_io, call_tool):
    # Some clients send an array argument as its JSON text; MCPServer parses it back into the
    # list before validation, so the call filters by both tags.
    calls = _install_fake_graphql(patch_io)
    result = call_tool("lw_filter_posts", {"tags": '["ai","interpretability"]'})
    assert result.is_error is False
    tags = _sent_selector(calls)["top"]["filterSettings"]["tags"]
    assert [t["tagId"] for t in tags] == [AI_ID, INTERP_ID]


def test_filter_posts_advertises_author_and_tag_length_bounds(tool_schema):
    # The argument model enforces the author's length and the list's item count over MCP before
    # any lookup: see the out-of-range table in test_tool_contract.py.
    props = tool_schema("lw_filter_posts")["properties"]
    assert props["author"].get("maxLength") == 300
    assert props["tags"]["items"].get("maxLength") == 300
    assert props["tags"].get("maxItems") == 10


# --------------------------------------------------------------------------- #
# The advice on an unresolved author/tag
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("author", ["CleoNardo", "Cleo_Nardo"])
def test_unresolved_author_points_to_user_search(author, patch_io, run):
    # User slugs don't follow from display names, so no slug is guessed: the error points to
    # the search that lists each matching account's slug, whatever the value looks like. The
    # message echoes the value as given, so a lowercased form can only be a guess.
    _install_fake_graphql(patch_io)  # only 'evhub' resolves
    with pytest.raises(ToolError) as exc:
        run(m.lw_filter_posts(author=author))
    out = str(exc.value)
    assert out.startswith("no user found for author '")
    assert "lw_search(query=<name>, content_type='users')" in out
    assert "cleo-nardo" not in out
    if author != author.lower():
        assert author.lower() not in out


@pytest.mark.parametrize("tag", ["no-such-tag-xyz", "NoSuchTag", "No_Such_Tag"])
def test_unresolved_tag_carries_the_tag_advice(tag, patch_io, run):
    # The message echoes the value as given, so a lowercased or hyphenated form of a
    # mixed-case tag can only be a guess.
    _install_fake_graphql(patch_io)
    with pytest.raises(ToolError) as exc:
        run(m.lw_filter_posts(tags=[tag]))
    out = str(exc.value)
    assert out.startswith(f"no tag found for {tag!r}. Pass a tag slug. ")
    assert "lw_search(query=<name>, content_type='tags')" in out
    if tag != tag.lower():
        assert tag.lower() not in out
        assert "no-such-tag" not in out


@pytest.mark.parametrize(
    "kwargs, fragment",
    [
        pytest.param({"author": EVHUB_ID}, "content_type='users'", id="author"),
        pytest.param({"tags": [MESA_ID]}, "content_type='tags'", id="tags"),
    ],
)
def test_an_id_as_author_or_tag_gets_its_advice(patch_io, run, kwargs, fragment):
    # An _id is not a slug: it matches no slug, so it fails like any unknown value and carries
    # the search that finds the slug, rather than being used as an _id.
    calls = _install_fake_graphql(patch_io)
    with pytest.raises(ToolError) as exc:
        run(m.lw_filter_posts(**kwargs))
    assert fragment in str(exc.value)
    assert not any("posts(" in q for q, _ in calls)


# --------------------------------------------------------------------------- #
# Slug -> _id resolution cache
# --------------------------------------------------------------------------- #

def test_slug_resolution_is_cached_across_calls(patch_io, run):
    # Two identical author filters resolve the author once; the second reuses the cache.
    calls = _install_fake_graphql(patch_io)
    run(m.lw_filter_posts(author="evhub", sort="top"))
    run(m.lw_filter_posts(author="evhub", sort="top"))
    user_resolutions = [q for q, _ in calls if "users(" in q]
    assert len(user_resolutions) == 1


# --------------------------------------------------------------------------- #
# The request the tool forwards and the Markdown it renders
# --------------------------------------------------------------------------- #

def test_filter_posts_forwards_site_offset_and_probe_limit(patch_io, run):
    # The posts query goes to the requested site with the caller's offset and the limit+1
    # probe, and each row links to that site's /api/post route. With no filter given, the
    # header names only the sort.
    sent = _install_paging_graphql(patch_io)
    out = run(m.lw_filter_posts(offset=40, limit=10, site="alignmentforum"))
    assert [(site, v["offset"], v["limit"]) for site, v in sent] == [("alignmentforum", 40, 11)]
    assert f"({config.SITE_BASE_URLS['alignmentforum']}/api/post/p0)" in out
    assert out.startswith("# Filtered posts (10) — sort=top\n")


def test_markdown_header_names_every_filter_and_rows_escape_names(patch_io, run):
    # The header names every applied filter, and a title or author carrying link syntax or a
    # newline is flattened and escaped so it can't break the row's Markdown link.
    post = {
        **_CANNED_POST,
        "title": "[AN #80] A\nB",
        "user": {"displayName": "Jane [AF]\nDoe", "slug": "jane"},
    }
    _install_fake_graphql(patch_io, post=post)
    out = run(m.lw_filter_posts(
        author="evhub", tags=["mesa-optimization"],
        after=date(2020, 1, 1), before=date(2021, 1, 1),
        min_karma=5, alignment_forum_only=True, sort="new",
    ))
    header, _, row = out.splitlines()[:3]
    assert set(header.split(" — ", 1)[1].split(", ")) == {
        "author=evhub", "tags=mesa-optimization", "after=2020-01-01", "before=2021-01-01",
        "min_karma=5", "alignment_forum_only=true", "sort=new",
    }
    assert row.startswith(r"- [\[AN #80\] A B](")
    assert r"author: [Jane \[AF\] Doe](https://www.lesswrong.com/api/user/jane) |" in row


_ROW_LINK = "- [Risks from Learned Optimization: Introduction](https://www.lesswrong.com/api/post/FkgsxrGf3QxhfLWHG)"


@pytest.mark.parametrize(
    ("user", "author"),
    [
        # The display name links to the profile route by slug, which differs from it here.
        ({"displayName": "jefftk", "slug": "jkaufman"}, "[jefftk](https://www.lesswrong.com/api/user/jkaufman)"),
        ({"displayName": None, "slug": "jkaufman"}, "[jkaufman](https://www.lesswrong.com/api/user/jkaufman)"),
        ({"displayName": "Jane", "slug": None}, "Jane"),
        ({"displayName": "  ", "slug": "jkaufman"}, "[jkaufman](https://www.lesswrong.com/api/user/jkaufman)"),
        (None, "unknown"),  # a deleted account's posts carry no user
    ],
    ids=["slug-differs", "no-display-name", "no-slug", "blank-display-name", "no-user"],
)
def test_markdown_row_carries_every_field_and_links_the_author(user, author, patch_io, run):
    _install_fake_graphql(patch_io, post={**_CANNED_POST, "user": user})
    row = run(m.lw_filter_posts()).splitlines()[2]
    assert row == f"{_ROW_LINK} — author: {author} | karma: 188 | 2019-05-31 | comments: 42"


# --------------------------------------------------------------------------- #
# The date range, client-side karma enforcement, and JSON output
# --------------------------------------------------------------------------- #

def test_filter_posts_rejects_inverted_date_range(patch_io, run):
    # No post can match, so it is reported as bad input, not as "No posts matched", and
    # costs neither the author lookup nor the posts query.
    calls = _install_fake_graphql(patch_io)
    with pytest.raises(ToolError) as exc:
        run(m.lw_filter_posts(author="evhub", after=date(2025, 2, 1), before=date(2025, 1, 1)))
    assert "2025-02-01" in str(exc.value) and "2025-01-01" in str(exc.value)
    assert calls == []


@pytest.mark.parametrize("value", ["2023", "1672531200", "01/02/2023"])
def test_a_date_that_is_not_iso_says_which_form_to_use(value, call_tool):
    result = call_tool("lw_filter_posts", {"after": value})
    assert result.is_error is True
    assert "use an ISO date 'YYYY-MM-DD'" in result.content[0].text


def test_filter_posts_allows_a_single_day_range(patch_io, call_tool):
    # Over MCP the dates arrive as ISO strings and go out as the selector's ISO bounds.
    calls = _install_fake_graphql(patch_io)
    assert call_tool("lw_filter_posts", {"after": "2025-01-01", "before": "2025-01-01"}).is_error is False
    inner = _sent_selector(calls)["top"]
    assert (inner["after"], inner["before"]) == ("2025-01-01", "2025-01-02")


@pytest.mark.parametrize("min_karma", [0, 50])
def test_min_karma_keeps_posts_at_or_above_the_threshold(patch_io, run, min_karma):
    # The server no-ops karmaThreshold == 0, so the tool enforces ">= min_karma" itself for
    # every value, 0 included: a post just below the threshold is dropped, one exactly at it
    # is kept.
    rows = [
        {**_CANNED_POST, "_id": name, "baseScore": min_karma + delta}
        for name, delta in (("below", -1), ("at", 0), ("above", 1))
    ]

    async def fake_graphql(site, query, variables=None):
        return {"posts": {"results": [dict(p) for p in rows]}}

    patch_io("_graphql", fake_graphql)
    data = json.loads(run(m.lw_filter_posts(min_karma=min_karma, response_format="json")))
    assert [p["_id"] for p in data["posts"]] == ["at", "above"]


def test_markdown_author_links_the_requested_site_and_escapes_the_slug(patch_io, run):
    _install_fake_graphql(patch_io, post={**_CANNED_POST, "user": {"displayName": "Jane", "slug": "a b"}})
    row = run(m.lw_filter_posts(site="alignmentforum")).splitlines()[2]
    assert "— author: [Jane](https://www.alignmentforum.org/api/user/a%20b) |" in row


def test_json_response_format_shape(patch_io, run):
    # One canned row with limit 20: no further page, no depth wall, and every row field mapped
    # from its GraphQL source (baseScore -> karma, user.displayName -> author, ...).
    _install_fake_graphql(patch_io, post={**_CANNED_POST, "user": {"displayName": "jefftk", "slug": "jkaufman"}})
    data = json.loads(run(m.lw_filter_posts(author="evhub", response_format="json")))
    assert data == {
        "count": 1,
        "has_more": False,
        "next_offset": None,
        "depth_limited": False,
        "posts": [{
            "_id": "FkgsxrGf3QxhfLWHG",
            "title": "Risks from Learned Optimization: Introduction",
            "slug": "risks-from-learned-optimization-introduction",
            "url": "https://www.lesswrong.com/posts/FkgsxrGf3QxhfLWHG/x",
            "postedAt": "2019-05-31T23:42:33.149Z",
            "karma": 188,
            "commentCount": 42,
            "author": "jefftk",
            "authorSlug": "jkaufman",
        }],
    }


def test_json_keeps_non_ascii_text_literal(patch_io, run):
    # MCP text content is UTF-8, so escaping an em dash or an emoji only costs the model tokens.
    _install_fake_graphql(patch_io, post={**_CANNED_POST, "title": "Gödel — 🤖", "user": {"displayName": "Zoë", "slug": "zoe"}})
    out = run(m.lw_filter_posts(response_format="json"))
    assert '"title": "Gödel — 🤖"' in out and '"author": "Zoë"' in out


def test_json_row_without_an_author_has_null_author_fields(patch_io, run):
    _install_fake_graphql(patch_io, post={**_CANNED_POST, "user": None})
    [row] = json.loads(run(m.lw_filter_posts(response_format="json")))["posts"]
    assert (row["author"], row["authorSlug"]) == (None, None)


@pytest.mark.parametrize("data", [{}, {"posts": None}, {"posts": {"results": None}}])
def test_an_absent_posts_collection_reads_as_no_matches(data, patch_io, run):
    async def fake_graphql(site, query, variables=None):
        return data

    patch_io("_graphql", fake_graphql)
    assert run(m.lw_filter_posts()) == "No posts matched those filters."


def test_json_has_more_true_over_fetches_and_trims(patch_io, run):
    # The tool over-fetches limit+1; when that many rows come back, has_more is true and
    # the surplus row is trimmed so the page holds exactly `limit`.
    sent = _install_paging_graphql(patch_io)
    data = json.loads(run(m.lw_filter_posts(limit=5, response_format="json")))
    assert sent[0][1]["limit"] == 6          # requested limit+1, not limit
    assert data["has_more"] is True
    assert data["next_offset"] == 5          # offset 0 + limit 5
    assert data["depth_limited"] is False    # reachable next page, not a depth wall
    assert data["count"] == 5                # extra row trimmed back to the page size
    assert len(data["posts"]) == 5


@pytest.mark.parametrize(
    "fetched, limit, offset, signal",
    [
        (0, 5, 0, (False, None, False)),       # nothing came back
        (5, 5, 0, (False, None, False)),       # a full page but no surplus row: the last page
        (6, 5, 0, (True, 5, False)),           # a surplus row: the next page is offset+limit
        # The cap is on offset alone (not offset+limit): below it a next page is reachable and
        # its offset clamps to the cap, an overlapping final page, whatever the limit.
        (21, 20, 1990, (True, 2000, False)),
        (31, 30, 1995, (True, 2000, False)),
        # At the cap no higher offset exists, so a surplus is unreachable rather than "more".
        (21, 20, 2000, (False, None, True)),
        (20, 20, 2000, (False, None, False)),
    ],
)
def test_page_signal(fetched, limit, offset, signal):
    # (has_more, next_offset, depth_limited) for a page whose limit+1 probe got `fetched` rows.
    assert _page_signal(fetched, limit, offset) == signal


def test_markdown_footer_mirrors_paging_signal(patch_io, run):
    # The Markdown branch surfaces the same signal the JSON branch reports, via a footer.
    _install_paging_graphql(patch_io)
    # has_more -> a "call again with offset=N" footer naming the next offset.
    more = run(m.lw_filter_posts(limit=5, offset=0))
    assert "call again with offset=5" in more
    # depth_limited (at the cap) -> a "narrow the filters" footer, not a next-offset hint.
    walled = run(m.lw_filter_posts(limit=20, offset=2000))
    assert "narrow the filters" in walled
    assert "call again with offset=" not in walled
    wall = json.loads(run(m.lw_filter_posts(limit=20, offset=2000, response_format="json")))
    assert (wall["has_more"], wall["next_offset"], wall["depth_limited"]) == (False, None, True)


def test_json_has_more_independent_of_min_karma_trim(patch_io, run):
    # has_more is the server-side paging signal, computed before the client-side min_karma
    # safety-net filter — so a page can be trimmed below `limit` yet still report
    # has_more=true. Pins that ordering (i.e. count < limit does NOT imply the last page), and
    # that count is the size of the page returned, not a count of the server's rows. Under a
    # sort other than 'top', qualifying rows can follow ones below the threshold.
    _install_paging_graphql(patch_io, score=lambda i: 10 if i % 2 == 0 else -10)
    data = json.loads(run(m.lw_filter_posts(min_karma=0, limit=4, sort="new", response_format="json")))
    assert data["has_more"] is True                     # surplus row present server-side
    assert data["next_offset"] == 4
    assert data["count"] < 4                            # min_karma trimmed this page
    assert data["count"] == len(data["posts"])          # count is this page's size
    assert all(p["karma"] >= 0 for p in data["posts"])


@pytest.mark.parametrize(
    ("sort", "surplus", "has_more"),
    [
        ("top", -1, False),  # descending karma: past the surplus row nothing can reach min_karma
        ("top", 0, True),    # a surplus row at min_karma still qualifies, so paging goes on
        ("new", -1, True),   # any order but karma's: a later row may still qualify
    ],
)
def test_top_sort_ends_once_karma_falls_below_min_karma(sort, surplus, has_more, patch_io, run):
    # Rows score 3, 2, 1, 0 and then the surplus row, against min_karma=0 (a threshold the
    # server does not apply itself).
    _install_paging_graphql(patch_io, score=lambda i: 3 - i if i < 4 else surplus)
    data = json.loads(run(m.lw_filter_posts(min_karma=0, limit=4, sort=sort, response_format="json")))
    assert [p["karma"] for p in data["posts"]] == [3, 2, 1, 0]
    assert (data["has_more"], data["next_offset"], data["depth_limited"]) == (
        (True, 4, False) if has_more else (False, None, False))


def test_top_sort_at_the_depth_cap_below_min_karma_is_not_depth_limited(patch_io, run):
    _install_paging_graphql(patch_io, score=lambda i: 3 - i)
    data = json.loads(run(m.lw_filter_posts(min_karma=0, limit=4, offset=2000, response_format="json")))
    assert (data["has_more"], data["depth_limited"]) == (False, False)


def test_markdown_empty_page_with_more_is_not_contradictory(patch_io, run):
    # When min_karma trims the whole page but the server had surplus rows, the lead line must
    # not flatly claim "No posts matched" while the footer says more results exist.
    _install_paging_graphql(patch_io, score=lambda i: -10)
    out = run(m.lw_filter_posts(min_karma=0, limit=5, offset=0, sort="new"))
    assert "on this page" in out              # scoped, not a flat "nothing matched"
    assert "call again with offset=5" in out  # and the paging hint is present

    # The genuinely-empty case (server returns nothing) keeps the plain terminal message.
    async def empty_graphql(site, query, variables=None):
        return {"posts": {"results": []}}

    patch_io("_graphql", empty_graphql)
    assert run(m.lw_filter_posts(limit=5, offset=0)) == "No posts matched those filters."


# --------------------------------------------------------------------------- #
# Live (network): marked `live`, so they run only with LW_LIVE_TESTS=1. The required-tag
# filterSettings is honoured on every sort view, including `top` with no date bound: the
# ForumMagnum defaultView applies filterSettings.tags independently of after/before.
# --------------------------------------------------------------------------- #

# Two topically-disjoint tags with a canonical anchor post for the first.
_TAG_A, _TAG_B, _ANCHOR = "mesa-optimization", "rationality", "Learned Optimization"


async def _live_titles(**kw):
    out = await m.lw_filter_posts(response_format="json", **kw)
    return [p["title"] for p in json.loads(out)["posts"]]


@pytest.mark.live
def test_live_top_without_date_restricts_by_tag(live_run):
    async def scenario():
        a = await _live_titles(tags=[_TAG_A], sort="top", limit=10)
        b = await _live_titles(tags=[_TAG_B], sort="top", limit=10)
        untagged = await _live_titles(sort="top", limit=10)
        assert a and b and untagged
        assert any(_ANCHOR in t for t in a), a       # canonical mesa post present
        assert a != untagged and b != untagged       # the tag actually restricts
        assert a != b                                # disjoint tags -> different lists

    live_run(scenario())


@pytest.mark.live
def test_live_unknown_tag_is_a_tool_error(live_run):
    # An unknown tag fails loudly instead of returning the unfiltered list.
    with pytest.raises(ToolError, match="no tag found"):
        live_run(m.lw_filter_posts(tags=["zzz-definitely-not-a-tag"], sort="top"))


@pytest.mark.live
def test_live_top_date_floor_is_a_noop(live_run):
    # A wide `after` floor leaves a tagged `top` list unchanged: the tag filter applies without
    # a date bound, so `top` needs no date floor to honour it.
    async def scenario():
        plain = await _live_titles(tags=[_TAG_A], sort="top", limit=10)
        floored = await _live_titles(tags=[_TAG_A], sort="top", after=date(2000, 1, 1), limit=10)
        assert plain == floored, (plain, floored)

    live_run(scenario())


@pytest.mark.live
@pytest.mark.parametrize(
    "sort", ["new", "old", "magic", "recentComments"]
)
def test_live_nontop_sorts_restrict_by_tag(sort, live_run):
    # Every non-top sort honours the tag too: disjoint tags yield different lists.
    async def scenario():
        a = await _live_titles(tags=[_TAG_A], sort=sort, limit=10)
        b = await _live_titles(tags=[_TAG_B], sort=sort, limit=10)
        assert a and b and a != b

    live_run(scenario())


@pytest.mark.live
@pytest.mark.parametrize("site", ["lesswrong", "alignmentforum"])
def test_live_top_sort_is_descending_karma(site, live_run):
    # The tool ends a 'top' listing once karma falls below min_karma, which holds only if the
    # view orders rows by descending baseScore with nothing pinned ahead of them, on each site.
    async def scenario():
        out = await m.lw_filter_posts(sort="top", min_karma=0, limit=50, site=site, response_format="json")
        karma = [p["karma"] for p in json.loads(out)["posts"]]
        assert len(karma) == 50 and karma == sorted(karma, reverse=True), karma

    live_run(scenario())
