"""Tests for lw_filter_posts, focused on the tag filter.

The unit tests are hermetic: they stub `_graphql` (via the shared `patch_io` seam) so
nothing touches the network, and assert on the exact GraphQL `selector` the tool builds —
that a tag is applied as a `filterSettings` required-tag on the requested sort view and
composes with the other filters. A single live-endpoint test at the bottom exercises the
real API and is skipped unless LW_LIVE_TESTS=1, so the default `pytest` run stays offline
and deterministic.

Run:  pytest test_lw_filter_posts.py
Live: LW_LIVE_TESTS=1 pytest test_lw_filter_posts.py -k live -s
"""
from __future__ import annotations

import json
import os

import pytest

import lesswrong_mcp as m
from lesswrong_mcp import PostSort, ResponseFormat

# Stable fixture ids used by the fake resolver below.
MESA_ID = "NZ67PZ8CkeS6xn27h"       # tag slug 'mesa-optimization' -> this _id
INNER_ID = "aBcDeFgHiJkLmNoP1"      # tag slug 'inner-alignment'   -> this _id
EVHUB_ID = "EQNTWXLKMeWMp2FQS"      # user slug 'evhub' -> this _id
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


def _install_fake_graphql(patch_io):
    """Replace `_graphql` with a fake that records every call and returns canned data.

    Returns the `calls` list of (query, variables). Tag/user slug resolution is
    faked so only 'mesa-optimization' / 'evhub' resolve; everything else comes back
    empty (so the tool's own _ID_RE fallback / not-found error paths are exercised
    for real).
    """
    calls: list[tuple[str, dict]] = []

    async def fake_graphql(site, query, variables=None):
        variables = variables or {}
        calls.append((query, variables))
        if "tags(" in query:
            slug = variables["s"]["tagBySlug"]["slug"]
            tag_ids = {"mesa-optimization": MESA_ID, "inner-alignment": INNER_ID}
            results = [{"_id": tag_ids[slug]}] if slug in tag_ids else []
            return {"tags": {"results": results}}
        if "users(" in query:
            slug = variables["s"]["usersProfile"]["slug"]
            results = [{"_id": EVHUB_ID}] if slug == "evhub" else []
            return {"users": {"results": results}}
        if "posts(" in query:
            return {"posts": {"results": [dict(_CANNED_POST)]}}
        raise AssertionError(f"unexpected GraphQL query: {query[:60]}")

    patch_io("_graphql", fake_graphql)
    return calls


def _posts_selector(calls):
    """Pull the `selector` variable from the (single) posts(...) query the tool sent."""
    posts_calls = [v for q, v in calls if "posts(" in q]
    assert len(posts_calls) == 1, f"expected exactly one posts() query, got {len(posts_calls)}"
    return posts_calls[0]["selector"]


def _tool_input_schema(run, name):
    """The JSON input schema FastMCP advertises for a tool (what the client validates
    against). Building it touches no network — it's pure schema generation."""
    tool = next(t for t in run(m.mcp.list_tools()) if t.name == name)
    return tool.inputSchema


# --------------------------------------------------------------------------- #
# offset upper bound — the GraphQL posts selector rejects skip > 2000
# --------------------------------------------------------------------------- #

def test_offset_upper_bound_matches_graphql_skip_cap(run):
    # The advertised offset ceiling must match the backend's hard skip cap (2000), so an
    # over-limit offset fails fast as a Pydantic validation error at the tool boundary
    # instead of surfacing an opaque 'Exceeded maximum value for skip' GraphQL error
    # mid-call. `maximum` is inclusive: offset=2000 is allowed, offset=2001 is rejected.
    assert m.MAX_GRAPHQL_SKIP == 2000
    offset = _tool_input_schema(run, "lw_filter_posts")["properties"]["offset"]
    assert offset["maximum"] == 2000
    assert offset["minimum"] == 0
    assert "Max 2000" in offset["description"]


# --------------------------------------------------------------------------- #
# Unit tests: assert on the selector the tool builds
# --------------------------------------------------------------------------- #

def test_tag_by_slug_applies_filter_settings_not_tag_relevance(patch_io, run):
    calls = _install_fake_graphql(patch_io)
    out = run(m.lw_filter_posts(tag="mesa-optimization", sort=PostSort.top, limit=8))

    selector = _posts_selector(calls)
    # The view is the requested sort; the tag rides on it via filterSettings.
    assert set(selector) == {"top"}, selector
    inner = selector["top"]
    assert inner["filterSettings"] == {"tags": [{"tagId": MESA_ID, "filterMode": "Required"}]}
    # A bare `tagId` term is not used — the sort views don't accept one.
    assert "tagId" not in inner
    assert inner["sortedBy"] == "top"
    # Header truthfully reports the applied tag.
    assert "tag=mesa-optimization" in out.splitlines()[0]


def test_tag_by_raw_id_passes_through(patch_io, run):
    # A 17-char id doesn't resolve as a slug; the tool falls back to using it directly.
    calls = _install_fake_graphql(patch_io)
    run(m.lw_filter_posts(tag=MESA_ID, sort=PostSort.new, limit=5))

    inner = _posts_selector(calls)["new"]
    assert inner["filterSettings"] == {"tags": [{"tagId": MESA_ID, "filterMode": "Required"}]}


def test_unknown_tag_errors_and_never_queries_posts(patch_io, run):
    calls = _install_fake_graphql(patch_io)
    out = run(m.lw_filter_posts(tag="no-such-tag-xyz", sort=PostSort.top))

    assert out.startswith("Error:")
    assert "no tag found" in out
    # An unresolved tag errors out; it must not run an unfiltered posts() query.
    assert not any("posts(" in q for q, _ in calls)


def test_tag_composes_with_karma_and_after(patch_io, run):
    calls = _install_fake_graphql(patch_io)
    run(
        m.lw_filter_posts(
            tag="mesa-optimization",
            min_karma=100,
            after="2023-01-01",
            sort=PostSort.new,
            limit=20,
        )
    )
    inner = _posts_selector(calls)["new"]
    assert inner["filterSettings"] == {"tags": [{"tagId": MESA_ID, "filterMode": "Required"}]}
    assert inner["karmaThreshold"] == 100
    assert inner["after"] == "2023-01-01"
    assert inner["sortedBy"] == "new"


def test_tag_composes_with_author_and_af(patch_io, run):
    calls = _install_fake_graphql(patch_io)
    run(
        m.lw_filter_posts(
            tag="mesa-optimization",
            author="evhub",
            alignment_forum_only=True,
            sort=PostSort.top,
        )
    )
    inner = _posts_selector(calls)["top"]
    assert inner["filterSettings"] == {"tags": [{"tagId": MESA_ID, "filterMode": "Required"}]}
    assert inner["userId"] == EVHUB_ID
    assert inner["af"] is True


def test_no_tag_builds_plain_sort_view(patch_io, run):
    # Non-tag path: a plain sort view, with no filterSettings and no tag crumb.
    calls = _install_fake_graphql(patch_io)
    out = run(m.lw_filter_posts(sort=PostSort.top, limit=8))

    selector = _posts_selector(calls)
    assert set(selector) == {"top"}
    assert "filterSettings" not in selector["top"]
    assert "tagRelevance" not in selector
    assert "tag=" not in out.splitlines()[0]


def test_before_is_made_inclusive(patch_io, run):
    # `before` advances one day so the boundary date is included (the selector treats it
    # as an exclusive midnight bound).
    calls = _install_fake_graphql(patch_io)
    run(m.lw_filter_posts(tag="mesa-optimization", before="2020-01-01", sort=PostSort.top))
    inner = _posts_selector(calls)["top"]
    assert inner["before"] == "2020-01-02"


# --------------------------------------------------------------------------- #
# Multiple required tags (comma-separated) — their intersection (W7)
# --------------------------------------------------------------------------- #

def test_multiple_tags_are_all_required(patch_io, run):
    calls = _install_fake_graphql(patch_io)
    run(m.lw_filter_posts(tag="mesa-optimization,inner-alignment", sort=PostSort.top))
    inner = _posts_selector(calls)["top"]
    assert inner["filterSettings"] == {
        "tags": [
            {"tagId": MESA_ID, "filterMode": "Required"},
            {"tagId": INNER_ID, "filterMode": "Required"},
        ]
    }


def test_single_tag_still_one_required_entry(patch_io, run):
    # The multi-tag path must not change the lone-tag case: exactly one Required entry.
    calls = _install_fake_graphql(patch_io)
    run(m.lw_filter_posts(tag="mesa-optimization", sort=PostSort.top))
    inner = _posts_selector(calls)["top"]
    assert inner["filterSettings"] == {"tags": [{"tagId": MESA_ID, "filterMode": "Required"}]}


def test_one_unresolvable_tag_in_a_list_errors_with_that_slug(patch_io, run):
    calls = _install_fake_graphql(patch_io)
    out = run(m.lw_filter_posts(tag="mesa-optimization,not-a-real-tag", sort=PostSort.top))
    assert out.startswith("Error:") and "not-a-real-tag" in out
    # A bad tag anywhere in the list aborts before the posts() query runs.
    assert not any("posts(" in q for q, _ in calls)


def test_blank_tag_segments_are_ignored(patch_io, run):
    # Stray commas / surrounding whitespace don't create empty Required entries.
    calls = _install_fake_graphql(patch_io)
    run(m.lw_filter_posts(tag=" mesa-optimization , ", sort=PostSort.top))
    inner = _posts_selector(calls)["top"]
    assert inner["filterSettings"] == {"tags": [{"tagId": MESA_ID, "filterMode": "Required"}]}


@pytest.mark.parametrize("blank", [",", " , ", ",,", "  ", " ,, "])
def test_all_blank_tag_errors_instead_of_running_unfiltered(patch_io, run, blank):
    # A `tag` made entirely of commas/whitespace previously fell through to a query with NO
    # filterSettings (silently unfiltered, under a false `tag=,` header). It must fail fast.
    calls = _install_fake_graphql(patch_io)
    out = run(m.lw_filter_posts(tag=blank, sort=PostSort.top))
    assert out.startswith("Error:") and "no tag found" in out
    assert not any("posts(" in q for q, _ in calls)  # never runs the unfiltered posts() query


# --------------------------------------------------------------------------- #
# Display-name hint on an unresolved author/tag (W2b)
# --------------------------------------------------------------------------- #

def test_display_name_author_hints_the_slug(patch_io, run):
    _install_fake_graphql(patch_io)  # only 'evhub' resolves, so 'Cleo Nardo' won't
    out = run(m.lw_filter_posts(author="Cleo Nardo"))
    assert out.startswith("Error:")
    assert "display name" in out and "cleo-nardo" in out


def test_display_name_tag_hints_the_slug(patch_io, run):
    _install_fake_graphql(patch_io)
    out = run(m.lw_filter_posts(tag="Mesa Optimization"))
    assert out.startswith("Error:")
    assert "display name" in out and "mesa-optimization" in out


def test_clean_but_unknown_slug_gets_no_display_name_hint(patch_io, run):
    _install_fake_graphql(patch_io)
    out = run(m.lw_filter_posts(author="no-such-user-xyz"))
    assert out.startswith("Error:") and "display name" not in out


# --------------------------------------------------------------------------- #
# Slug -> _id resolution cache (W3)
# --------------------------------------------------------------------------- #

def test_slug_resolution_is_cached_across_calls(patch_io, run):
    # Two identical author filters resolve the author once; the second reuses the cache.
    calls = _install_fake_graphql(patch_io)
    run(m.lw_filter_posts(author="evhub", sort=PostSort.top))
    run(m.lw_filter_posts(author="evhub", sort=PostSort.top))
    user_resolutions = [q for q, _ in calls if "users(" in q]
    assert len(user_resolutions) == 1


# --------------------------------------------------------------------------- #
# Date validation, client-side karma enforcement, and JSON output
# --------------------------------------------------------------------------- #

def test_shape_valid_but_impossible_after_date_errors_before_any_query(patch_io, run):
    # The Field regex only checks shape, so a non-date like 2025-02-30 reaches the body;
    # it must be rejected cleanly, up front, without a GraphQL round-trip.
    calls = _install_fake_graphql(patch_io)
    out = run(m.lw_filter_posts(after="2025-02-30", sort=PostSort.top))
    assert out.startswith("Error:") and "invalid 'after' date" in out
    assert calls == []


def test_impossible_before_date_errors(patch_io, run):
    _install_fake_graphql(patch_io)
    out = run(m.lw_filter_posts(before="2025-13-01", sort=PostSort.top))
    assert out.startswith("Error:") and "invalid 'before' date" in out


def test_min_karma_zero_still_drops_negative_karma_posts(patch_io, run):
    # The server no-ops karmaThreshold == 0, so the tool enforces ">= min_karma" itself
    # for every value — min_karma=0 must still exclude a negative-karma post.
    mixed = [
        {**_CANNED_POST, "_id": "neg", "baseScore": -5},
        {**_CANNED_POST, "_id": "pos", "baseScore": 10},
    ]

    async def fake_graphql(site, query, variables=None):
        return {"posts": {"results": [dict(p) for p in mixed]}}

    patch_io("_graphql", fake_graphql)
    data = json.loads(run(m.lw_filter_posts(min_karma=0, response_format=ResponseFormat.json)))
    assert data["count"] == 1
    assert [p["_id"] for p in data["posts"]] == ["pos"]


def test_json_response_format_shape(patch_io, run):
    _install_fake_graphql(patch_io)
    data = json.loads(run(m.lw_filter_posts(author="evhub", response_format=ResponseFormat.json)))
    assert data["count"] == 1
    p = data["posts"][0]
    assert p["_id"] == _CANNED_POST["_id"]
    assert p["title"] == _CANNED_POST["title"]
    assert p["url"] == _CANNED_POST["pageUrl"]
    assert p["karma"] == 188                 # baseScore -> karma
    assert p["author"] == "evhub"            # user.displayName -> author
    assert p["authorSlug"] == "evhub"        # user.slug -> authorSlug
    assert data["has_more"] is False         # one canned row, limit 20 -> no further page
    assert data["depth_limited"] is False    # and not depth-capped either
    assert data["next_offset"] is None       # no next page to point at


def test_json_has_more_true_over_fetches_and_trims(patch_io, run):
    # The tool over-fetches limit+1; when that many rows come back, has_more is true and
    # the surplus row is trimmed so the page holds exactly `limit`.
    captured: dict = {}

    async def fake_graphql(site, query, variables=None):
        captured["limit"] = variables["limit"]
        rows = [{**_CANNED_POST, "_id": f"p{i}"} for i in range(variables["limit"])]
        return {"posts": {"results": rows}}

    patch_io("_graphql", fake_graphql)
    data = json.loads(run(m.lw_filter_posts(limit=5, response_format=ResponseFormat.json)))
    assert captured["limit"] == 6            # requested limit+1, not limit
    assert data["has_more"] is True
    assert data["next_offset"] == 5          # offset 0 + limit 5
    assert data["depth_limited"] is False    # reachable next page, not a depth wall
    assert data["count"] == 5                # extra row trimmed back to the page size
    assert len(data["posts"]) == 5


def test_json_has_more_false_when_short_page(patch_io, run):
    # Fewer rows than limit+1 come back -> this is genuinely the last page (not a wall).
    async def fake_graphql(site, query, variables=None):
        return {"posts": {"results": [{**_CANNED_POST, "_id": "only"}]}}

    patch_io("_graphql", fake_graphql)
    data = json.loads(run(m.lw_filter_posts(limit=5, response_format=ResponseFormat.json)))
    assert data["has_more"] is False
    assert data["depth_limited"] is False
    assert data["next_offset"] is None
    assert data["count"] == 1


def test_json_paging_signals_near_skip_cap(patch_io, run):
    # The backend caps skip at MAX_GRAPHQL_SKIP on the offset value ALONE (not offset+limit),
    # so a next page is fetchable iff offset < the cap, whatever the limit. Near the cap the
    # next offset clamps to the cap (an overlapping final page); only AT the cap is the
    # surplus genuinely unreachable (depth_limited).
    async def fake_graphql(site, query, variables=None):
        rows = [{**_CANNED_POST, "_id": f"p{i}"} for i in range(variables["limit"])]
        return {"posts": {"results": rows}}

    patch_io("_graphql", fake_graphql)

    # In the band (2000-limit, 2000): offset+limit would exceed the cap, but offset < 2000 so
    # a (clamped, overlapping) next page at offset=2000 is still reachable — NOT depth_limited.
    band = json.loads(run(m.lw_filter_posts(offset=1990, limit=20, response_format=ResponseFormat.json)))
    assert band["count"] == 20
    assert band["has_more"] is True
    assert band["depth_limited"] is False
    assert band["next_offset"] == 2000        # clamped to the cap, not 2010

    # Exactly at the cap: no higher offset exists, so surplus rows are unreachable.
    wall = json.loads(run(m.lw_filter_posts(offset=2000, limit=20, response_format=ResponseFormat.json)))
    assert wall["has_more"] is False
    assert wall["depth_limited"] is True
    assert wall["next_offset"] is None

    # A limit that does not divide the cap still points at the reachable final page.
    odd = json.loads(run(m.lw_filter_posts(offset=1995, limit=30, response_format=ResponseFormat.json)))
    assert odd["has_more"] is True
    assert odd["next_offset"] == 2000


def test_markdown_footer_mirrors_paging_signal(patch_io, run):
    # The Markdown branch surfaces the same signal the JSON branch does, via a footer.
    async def fake_graphql(site, query, variables=None):
        rows = [{**_CANNED_POST, "_id": f"p{i}"} for i in range(variables["limit"])]
        return {"posts": {"results": rows}}

    patch_io("_graphql", fake_graphql)
    # has_more -> a "call again with offset=N" footer naming the next offset.
    more = run(m.lw_filter_posts(limit=5, offset=0))
    assert "call again with offset=5" in more
    # depth_limited (at the cap) -> a "narrow the filters" footer, not a next-offset hint.
    walled = run(m.lw_filter_posts(limit=20, offset=2000))
    assert "narrow the filters" in walled
    assert "call again with offset=" not in walled


def test_json_has_more_independent_of_min_karma_trim(patch_io, run):
    # has_more is the server-side paging signal, computed before the client-side min_karma
    # safety-net filter — so a page can be trimmed below `limit` yet still report
    # has_more=true. Pins that ordering (i.e. count < limit does NOT imply the last page).
    async def fake_graphql(site, query, variables=None):
        rows = [
            {**_CANNED_POST, "_id": f"p{i}", "baseScore": (10 if i % 2 == 0 else -10)}
            for i in range(variables["limit"])
        ]
        return {"posts": {"results": rows}}

    patch_io("_graphql", fake_graphql)
    data = json.loads(run(m.lw_filter_posts(min_karma=0, limit=4, response_format=ResponseFormat.json)))
    assert data["has_more"] is True                     # surplus row present server-side
    assert data["next_offset"] == 4
    assert data["count"] < 4                            # min_karma trimmed this page
    assert all(p["karma"] >= 0 for p in data["posts"])


def test_markdown_empty_page_with_more_is_not_contradictory(patch_io, run):
    # When min_karma trims the whole page but the server had surplus rows, the lead line must
    # not flatly claim "No posts matched" while the footer says more results exist.
    async def fake_graphql(site, query, variables=None):
        rows = [{**_CANNED_POST, "_id": f"p{i}", "baseScore": -10} for i in range(variables["limit"])]
        return {"posts": {"results": rows}}

    patch_io("_graphql", fake_graphql)
    out = run(m.lw_filter_posts(min_karma=0, limit=5, offset=0))
    assert "on this page" in out              # scoped, not a flat "nothing matched"
    assert "call again with offset=5" in out  # and the paging hint is present

    # The genuinely-empty case (server returns nothing) keeps the plain terminal message.
    async def empty_graphql(site, query, variables=None):
        return {"posts": {"results": []}}

    patch_io("_graphql", empty_graphql)
    assert run(m.lw_filter_posts(limit=5, offset=0)) == "No posts matched those filters."


# --------------------------------------------------------------------------- #
# Live integration test (network) — opt-in via LW_LIVE_TESTS=1
# --------------------------------------------------------------------------- #

@pytest.mark.skipif(
    not os.environ.get("LW_LIVE_TESTS"),
    reason="network test; set LW_LIVE_TESTS=1 to run",
)
def test_live_tag_filter_restricts_and_differs(run):
    async def scenario():
        try:
            def titles(js):
                return [p["title"] for p in json.loads(js)["posts"]]

            mesa = titles(await m.lw_filter_posts(
                tag="mesa-optimization", sort=PostSort.top, limit=8,
                response_format=ResponseFormat.json))
            inner = titles(await m.lw_filter_posts(
                tag="inner-alignment", sort=PostSort.top, limit=8,
                response_format=ResponseFormat.json))
            no_tag = titles(await m.lw_filter_posts(
                sort=PostSort.top, limit=8, response_format=ResponseFormat.json))

            assert mesa and inner and no_tag
            # Two different tags -> different lists, and neither equals the unfiltered list.
            assert mesa != no_tag
            assert inner != no_tag
            assert mesa != inner
            # The tag actually restricts: a canonical mesa post surfaces for that tag.
            assert any("Learned Optimization" in t for t in mesa)
            # Unknown tag errors loudly instead of returning an unfiltered list.
            err = await m.lw_filter_posts(tag="zzz-definitely-not-a-tag", sort=PostSort.top)
            assert err.startswith("Error:")
        finally:
            await m._aclose_client()

    run(scenario())


# --------------------------------------------------------------------------- #
# P1 regression guards (network) — the required-tag filterSettings must be honoured
# under sort='top' with NO date bound. A black-box pass once alleged the `top` view
# silently dropped the tag and returned the site-wide all-time top list unless a date
# bound was present; that is NOT reproducible (the ForumMagnum `defaultView` applies
# `filterSettings.tags` independently of `after`/`before`), so these pin the correct
# behaviour and would fail loudly if the backend ever regressed. Opt-in via
# LW_LIVE_TESTS=1 so the default run stays offline.
# --------------------------------------------------------------------------- #

_LIVE = pytest.mark.skipif(
    not os.environ.get("LW_LIVE_TESTS"),
    reason="network test; set LW_LIVE_TESTS=1 to run",
)

# Two topically-disjoint tags with a canonical anchor post for the first.
_TAG_A, _TAG_B, _ANCHOR = "mesa-optimization", "rationality", "Learned Optimization"


async def _live_titles(**kw):
    out = await m.lw_filter_posts(response_format=ResponseFormat.json, **kw)
    assert not out.startswith("Error:"), out
    return [p["title"] for p in json.loads(out)["posts"]]


@_LIVE
def test_live_top_without_date_restricts_by_tag(run):
    # The P1 case exactly: sort='top', a tag, and NO after/before. The tag must restrict.
    async def scenario():
        try:
            a = await _live_titles(tag=_TAG_A, sort=PostSort.top, limit=10)
            b = await _live_titles(tag=_TAG_B, sort=PostSort.top, limit=10)
            untagged = await _live_titles(sort=PostSort.top, limit=10)
            assert a and b and untagged
            assert any(_ANCHOR in t for t in a), a       # canonical mesa post present
            assert a != untagged and b != untagged       # the tag actually restricts
            assert a != b                                # disjoint tags -> different lists
        finally:
            await m._aclose_client()

    run(scenario())


@_LIVE
def test_live_top_date_floor_is_a_noop(run):
    # Guards against anyone re-introducing a synthetic date-floor "fix" for the phantom P1
    # bug: a wide `after` floor must NOT change a tagged `top` list, because the tag filter
    # is already applied without it. `top` and `top + after=2000-01-01` are byte-identical.
    async def scenario():
        try:
            plain = await _live_titles(tag=_TAG_A, sort=PostSort.top, limit=10)
            floored = await _live_titles(tag=_TAG_A, sort=PostSort.top, after="2000-01-01", limit=10)
            assert plain == floored, (plain, floored)
        finally:
            await m._aclose_client()

    run(scenario())


@_LIVE
@pytest.mark.parametrize(
    "sort", [PostSort.new, PostSort.old, PostSort.magic, PostSort.recentComments]
)
def test_live_nontop_sorts_restrict_by_tag(sort, run):
    # Every non-top sort honours the tag too — disjoint tags yield different lists.
    async def scenario():
        try:
            a = await _live_titles(tag=_TAG_A, sort=sort, limit=10)
            b = await _live_titles(tag=_TAG_B, sort=sort, limit=10)
            assert a and b and a != b
        finally:
            await m._aclose_client()

    run(scenario())
