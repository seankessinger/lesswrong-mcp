"""Each tool through a real in-process MCP client, on both protocol eras, against a fake forum:
the request it sends, what the client reads back, and how bad input and failures read."""
from __future__ import annotations

import json

import httpx

from lesswrong_mcp.server import FIND, INSTRUCTIONS, SHAPE

P1 = "post0000000000001"


def text(res) -> str:
    return res.content[0].text


def gql(data: dict):
    """A handler answering every GraphQL request with `data`."""
    return lambda request: httpx.Response(200, json={"data": data})


def body(request: httpx.Request) -> dict:
    return json.loads(request.read())


# --------------------------------------------------------------------------- server

def test_tools_are_read_only(listed_tool):
    annotations = listed_tool("lw_get_post").annotations
    assert annotations.read_only_hint is True and annotations.destructive_hint is False


def test_instructions_within_1000_chars():
    assert len(INSTRUCTIONS) <= 1000


def test_slug_refused_before_any_request_with_shape_advice(call_tool, fake_forum):
    seen = fake_forum(lambda r: httpx.Response(200, text="unused"))
    res = call_tool("lw_get_post", {"post_id": "some-slug"})
    assert res.is_error and SHAPE["post"] in text(res) and seen == []


def test_link_refused_with_shape_advice(call_tool, fake_forum):
    seen = fake_forum(lambda r: httpx.Response(200, text="unused"))
    res = call_tool("lw_get_post", {"post_id": f"https://www.lesswrong.com/posts/{P1}/t"})
    assert res.is_error and SHAPE["post"] in text(res) and seen == []


def test_shape_advice_names_what_the_value_is_not(call_tool, fake_forum):
    seen = fake_forum(lambda r: httpx.Response(200, text="unused"))
    for name, args, advice in [
        ("lw_get_post", {"post_id": "some-slug"}, "takes a bare 17-character post _id, not a link, name or slug."),
        ("lw_get_sequence", {"sequence_id": "Embedded Agency"}, "takes a bare 17-character sequence _id, not a link or name."),
        ("lw_filter_posts", {"author": "Ada Lovelace"}, "takes a bare user slug, not a link or name."),
        ("lw_filter_posts", {"tags": ["AI Safety"]}, "takes a bare tag slug, not a link or name."),
    ]:
        res = call_tool(name, args)
        assert res.is_error and advice in text(res), (name, args)
    assert seen == []


def test_429_and_500_read_as_forum_messages(call_tool, fake_forum):
    # A Retry-After past the cap ends the call at once, so the test never sleeps.
    fake_forum(lambda r: httpx.Response(429, headers={"Retry-After": "120"}))
    assert "Rate limited by the forum (429)" in text(call_tool("lw_get_post", {"post_id": P1}))
    fake_forum(lambda r: httpx.Response(500, headers={"Retry-After": "120"}))
    assert "server error (HTTP 500)" in text(call_tool("lw_get_post", {"post_id": P1}))


# --------------------------------------------------------------------------- lw_get_post

def test_get_post_requests_markdown_route_and_returns_it_as_is(call_tool, fake_forum):
    seen = fake_forum(lambda r: httpx.Response(200, text="# P\n\nbody"))
    res = call_tool("lw_get_post", {"post_id": P1})
    assert not res.is_error and text(res) == "# P\n\nbody"
    assert seen[0].url.path == f"/api/post/{P1}"


def test_get_post_404_is_miss_with_post_advice(call_tool, fake_forum):
    fake_forum(lambda r: httpx.Response(404, text="not found"))
    res = call_tool("lw_get_post", {"post_id": P1})
    assert res.is_error and f"no post found for '{P1}'" in text(res) and FIND["post"] in text(res)


def test_get_post_slices_at_max_chars_with_offset_footer(call_tool, fake_forum):
    fake_forum(lambda r: httpx.Response(200, text="x" * 1200))
    res = call_tool("lw_get_post", {"post_id": P1, "max_chars": 500})
    assert text(res).startswith("x" * 500) and "call again with offset=500" in text(res)


# --------------------------------------------------------------------------- lw_get_comments

C1 = "cmt00000000000001"


def comment(cid: str, parent: str | None = None, post: str = P1, **over) -> dict:
    c = {"_id": cid, "postId": post, "parentCommentId": parent, "answer": False, "af": False,
         "deleted": False, "baseScore": 1, "postedAt": "2022-01-01T00:00:00Z", "extendedScore": None,
         "user": {"displayName": "U", "slug": "u"}, "contents": {"markdown": f"body of {cid}"}}
    return {**c, **over}


def thread_data(answers=(), comments=(), *, question=False, post=True) -> dict:
    return {
        "post": {"result": {"_id": P1, "title": "T", "question": question, "commentCount": 0} if post else None},
        "answers": {"results": list(answers)},
        "comments": {"results": list(comments)},
    }


def test_thread_sends_one_graphql_request_with_both_views(call_tool, fake_forum):
    seen = fake_forum(gql(thread_data()))
    call_tool("lw_get_comments", {"post_id": P1, "sort": "new"})
    assert len(seen) == 1 and seen[0].url.path == "/graphql"
    variables = body(seen[0])["variables"]
    assert variables["answers"] == {"answersAndReplies": {"postId": P1}}
    assert variables["comments"] == {"postCommentsNew": {"postId": P1}}


def test_thread_renders_answers_then_comments(call_tool, fake_forum):
    fake_forum(gql(thread_data([comment("ans00000000000001", answer=True)], [comment(C1)], question=True)))
    out = text(call_tool("lw_get_comments", {"post_id": P1}))
    assert out.index("ans00000000000001") < out.index("## Comments") < out.index(C1)


def test_unknown_post_is_miss(call_tool, fake_forum):
    fake_forum(gql(thread_data(post=False)))
    res = call_tool("lw_get_comments", {"post_id": P1})
    assert res.is_error and f"no post found for '{P1}'" in text(res) and FIND["post"] in text(res)


def test_one_comment_renders_header_with_reply_to(call_tool, fake_forum):
    seen = fake_forum(gql({"comment": {"result": comment(C1, "cmt00000000000000")}}))
    out = text(call_tool("lw_get_comments", {"post_id": P1, "comment_id": C1}))
    assert out.startswith(f"### [{C1}](") and "reply to cmt00000000000000" in out
    assert body(seen[0])["variables"] == {"id": C1}


def test_comment_on_other_post_is_refused(call_tool, fake_forum):
    fake_forum(gql({"comment": {"result": comment(C1, post="post0000000000009")}}))
    res = call_tool("lw_get_comments", {"post_id": P1, "comment_id": C1})
    assert res.is_error and C1 in text(res) and P1 in text(res) and FIND["comment"] in text(res)


def test_comment_on_a_tag_page_is_refused_as_such(call_tool, fake_forum):
    # The forum keeps a tag page's discussion as comments with no post.
    fake_forum(gql({"comment": {"result": comment(C1, post=None)}}))
    res = call_tool("lw_get_comments", {"post_id": P1, "comment_id": C1})
    assert res.is_error and "None" not in text(res)
    assert f"comment '{C1}' is on a tag page, not a post; the tools read only comments on posts." in text(res)


def test_unknown_comment_is_miss(call_tool, fake_forum):
    fake_forum(gql({"comment": {"result": None}}))
    res = call_tool("lw_get_comments", {"post_id": P1, "comment_id": C1})
    assert res.is_error and f"no comment found for '{C1}'" in text(res)


def test_long_thread_slices_and_offset_reconstructs_it(call_tool, fake_forum):
    from lesswrong_mcp.render import thread

    many = [comment(f"cmt{n:014d}", contents={"markdown": "w" * 300}) for n in range(300)]
    data = thread_data(comments=many)
    fake_forum(gql(data))
    full = thread(data["post"]["result"], [], many, limit_hit=False)
    pages, offset = [], 0
    while True:
        page = text(call_tool("lw_get_comments", {"post_id": P1, "offset": offset}))
        cut = page.rfind("\n\n---\n[lw_get_comments:")
        pages.append(page if cut < 0 else page[:cut])
        if "call again with offset=" not in page:
            break
        offset = int(page.rsplit("offset=", 1)[1].split()[0])
    assert len(pages) > 1 and "".join(pages) == full


def test_comments_description_names_the_cap_the_header_reports(listed_tool):
    from lesswrong_mcp.tools import THREAD_LIMIT
    description = " ".join(listed_tool("lw_get_comments").description.split())
    assert "always complete" not in description
    # Each section (answers, comments) is one read capped at THREAD_LIMIT.
    assert f"its answers or its comments, replies included, reach {THREAD_LIMIT:,}" in description
    assert '"showing the first N"' in description


def test_comments_schema_has_no_limit_or_site(tool_schema):
    props = tool_schema("lw_get_comments")["properties"]
    assert "limit" not in props and "site" not in props


# --------------------------------------------------------------------------- lw_search

def search_forum(fake_forum, n_hits: int = 1, hits_for: dict | None = None, slug: str = "the-slug"):
    """Answer search with one result per query (n_hits total, hits from `hits_for` by index
    kind), and GraphQL with a post whose slug is `slug`."""
    def handler(request):
        if request.url.path == "/graphql":
            return httpx.Response(200, json={"data": {"post": {"result": {"slug": slug}}}})
        queries = body(request)
        return httpx.Response(200, json=[
            {"nbHits": n_hits, "hits": (hits_for or {}).get(q["indexName"].split("_")[0], [])} for q in queries
        ])
    return fake_forum(handler)


def sent(seen) -> list[dict]:
    return next(body(r) for r in seen if r.url.path == "/api/search")


def test_search_one_post_carrying_all_kinds(call_tool, fake_forum):
    seen = search_forum(fake_forum)
    assert not call_tool("lw_search", {"query": "corrigibility"}).is_error
    queries = sent(seen)
    assert len(seen) == 1 and [q["indexName"] for q in queries] == ["posts", "comments", "tags", "users", "sequences"]
    assert queries[0]["params"] == {"query": "corrigibility", "hitsPerPage": 10, "page": 0}


def test_sort_suffix_applies_to_posts_and_comments_only(call_tool, fake_forum):
    seen = search_forum(fake_forum)
    call_tool("lw_search", {"query": "qq", "types": ["posts", "tags"], "sort": "oldest"})
    assert [q["indexName"] for q in sent(seen)] == ["posts_oldest_first", "tags"]


def test_single_day_range_includes_that_day(call_tool, fake_forum):
    seen = search_forum(fake_forum)
    call_tool("lw_search", {"query": "qq", "types": ["posts"], "after": "2024-05-01", "before": "2024-05-01"})
    # The index ORs filters on one field, so the two bounds sit on two date fields to be ANDed.
    assert sent(seen)[0]["params"]["numericFilters"] == ["publicDateMs>=1714521600000", "postedAt<1714608000000"]


def test_af_only_facet(call_tool, fake_forum):
    seen = search_forum(fake_forum)
    call_tool("lw_search", {"query": "qq", "types": ["comments", "users"], "af_only": True})
    comments, users = sent(seen)
    assert comments["params"]["facetFilters"] == [["af:true"]] and "facetFilters" not in users["params"]


def notes(page: str) -> list[str]:
    """The note lines under a search page's heading."""
    return page.split("\n\n## ", 1)[0].splitlines()[2:]


def test_search_filter_note_names_only_the_filters_given(call_tool, fake_forum):
    search_forum(fake_forum)
    assert notes(text(call_tool("lw_search", {"query": "qq", "af_only": True}))) == [
        "- Posts and comments only on the Alignment Forum."]
    assert notes(text(call_tool("lw_search", {"query": "qq", "before": "2024-05-01"}))) == [
        "- Posts and comments only from any day to 2024-05-01."]
    assert notes(text(call_tool("lw_search", {"query": "qq", "after": "2024-01-01", "af_only": True}))) == [
        "- Posts and comments only from 2024-01-01 to today and on the Alignment Forum."]
    assert notes(text(call_tool("lw_search", {"query": "qq"}))) == []


def test_search_notes_with_mixed_types_and_the_other_kinds_unfiltered(call_tool, fake_forum):
    seen = search_forum(fake_forum)
    out = text(call_tool("lw_search", {"query": "qq", "types": ["users", "posts"], "sort": "newest",
                                       "after": "2024-01-01", "af_only": True}))
    assert notes(out) == ["- Sort: newest (posts and comments).",
                          "- Posts and comments only from 2024-01-01 to today and on the Alignment Forum."]
    posts, users = sent(seen)
    assert posts["indexName"] == "posts_newest_first" and posts["params"]["facetFilters"] == [["af:true"]]
    assert users == {"indexName": "users", "params": {"query": "qq", "hitsPerPage": 10, "page": 0}}
    assert "## Posts (1 total)" in out and "## Users (1 total)" in out


def test_in_post_resolves_slug_filters_hits_and_forces_comments(call_tool, fake_forum):
    mine = {"_id": "cmt00000000000001", "postId": P1, "postTitle": "T"}
    other = {"_id": "cmt00000000000002", "postId": "post0000000000009", "postTitle": "Other"}
    seen = search_forum(fake_forum, hits_for={"comments": [mine, other]})
    out = text(call_tool("lw_search", {"query": "qq", "in_post": P1}))
    queries = sent(seen)
    assert [q["indexName"] for q in queries] == ["comments"]
    assert queries[0]["params"]["facetFilters"] == [["postSlug:the-slug"]]
    assert "cmt00000000000001" in out and "cmt00000000000002" not in out


def test_in_post_with_posts_type_refused(call_tool, fake_forum):
    seen = search_forum(fake_forum)
    res = call_tool("lw_search", {"query": "qq", "in_post": P1, "types": ["posts"]})
    assert res.is_error and "in_post" in text(res) and seen == []


def test_filters_without_posts_or_comments_refused(call_tool, fake_forum):
    seen = search_forum(fake_forum)
    res = call_tool("lw_search", {"query": "qq", "types": ["users"], "sort": "newest"})
    assert res.is_error and "posts or comments" in text(res) and seen == []


def test_window_guard_refuses_before_request(call_tool, fake_forum):
    seen = search_forum(fake_forum)
    res = call_tool("lw_search", {"query": "qq", "page": 501, "limit": 20})
    assert res.is_error and "10,000" in text(res) and seen == []


def test_after_later_than_before_refused(call_tool, fake_forum):
    seen = search_forum(fake_forum)
    res = call_tool("lw_search", {"query": "qq", "after": "2024-05-02", "before": "2024-05-01"})
    assert res.is_error and "after" in text(res) and seen == []


def test_next_page_footer_only_while_results_remain(call_tool, fake_forum):
    search_forum(fake_forum, n_hits=25)
    assert "call again with page=2" in text(call_tool("lw_search", {"query": "qq", "types": ["posts"]}))
    search_forum(fake_forum, n_hits=5)
    assert "Next page" not in text(call_tool("lw_search", {"query": "qq", "types": ["posts"]}))


# --------------------------------------------------------------------------- lw_filter_posts

def row(n: int, karma: int = 10) -> dict:
    return {"_id": f"post{n:013d}", "title": f"Post {n}", "postedAt": "2024-05-01T00:00:00Z",
            "baseScore": karma, "commentCount": 0, "af": False, "user": {"displayName": "A", "slug": "a"}}


def filter_forum(fake_forum, rows=(), total=None, users=None, tags=None, target=True):
    """Answer slug lookups from `users`/`tags` (slug -> id) and the posts query with `rows`."""
    def handler(request):
        b = body(request)
        query, variables = b["query"], b["variables"]
        if "users(" in query:
            slug = variables["s"]["usersProfile"]["slug"]
            return httpx.Response(200, json={"data": {"users": {"results": [{"_id": users[slug]}] if slug in (users or {}) else []}}})
        if "tags(" in query:
            slug = variables["s"]["tagBySlug"]["slug"]
            return httpx.Response(200, json={"data": {"tags": {"results": [{"_id": tags[slug]}] if slug in (tags or {}) else []}}})
        data = {"posts": {"totalCount": len(rows) if total is None else total, "results": list(rows)}}
        if "target" in query:
            data["target"] = {"result": {"_id": variables["target"]} if target else None}
        return httpx.Response(200, json={"data": data})
    return fake_forum(handler)


def posts_request(seen) -> dict:
    return next(body(r) for r in seen if "posts(" in body(r)["query"])


def test_listing_selector_for_each_sort(call_tool, fake_forum):
    seen = filter_forum(fake_forum)
    call_tool("lw_filter_posts", {"sort": "new"})
    assert posts_request(seen)["variables"] == {"s": {"new": {"sortedBy": "new"}}, "limit": 21, "offset": 0}
    seen = filter_forum(fake_forum)
    call_tool("lw_filter_posts", {})
    assert posts_request(seen)["variables"]["s"] == {"top": {"sortedBy": "top"}}


def test_single_day_range_sends_before_plus_one_day(call_tool, fake_forum):
    seen = filter_forum(fake_forum)
    call_tool("lw_filter_posts", {"after": "2024-05-01", "before": "2024-05-01"})
    terms = posts_request(seen)["variables"]["s"]["top"]
    assert terms["after"] == "2024-05-01" and terms["before"] == "2024-05-02"


def test_author_and_tags_resolved_once_each_in_order(call_tool, fake_forum):
    seen = filter_forum(fake_forum, users={"a-b": "usr1"}, tags={"t1": "tag1", "t2": "tag2"})
    call_tool("lw_filter_posts", {"author": "a-b", "tags": ["t1", "t2", "t1"]})
    asked = [body(r)["variables"].get("s") for r in seen]
    assert asked[:3] == [{"usersProfile": {"slug": "a-b"}}, {"tagBySlug": {"slug": "t1"}}, {"tagBySlug": {"slug": "t2"}}]
    terms = posts_request(seen)["variables"]["s"]["top"]
    assert terms["userId"] == "usr1"
    assert terms["filterSettings"] == {"tags": [{"tagId": "tag1", "filterMode": "Required"}, {"tagId": "tag2", "filterMode": "Required"}]}


def test_unresolved_author_is_miss_with_user_advice(call_tool, fake_forum):
    filter_forum(fake_forum)
    res = call_tool("lw_filter_posts", {"author": "nobody"})
    assert res.is_error and "no user found for 'nobody'" in text(res) and FIND["user"] in text(res)


def test_links_to_uses_pingback_view_with_filters(call_tool, fake_forum):
    seen = filter_forum(fake_forum)
    call_tool("lw_filter_posts", {"links_to": P1, "af_only": True, "after": "2024-01-01"})
    variables = posts_request(seen)["variables"]
    assert variables["s"] == {"pingbackPosts": {"postId": P1, "af": True, "after": "2024-01-01"}}
    assert variables["target"] == P1


def test_links_to_with_sort_new_refused(call_tool, fake_forum):
    seen = filter_forum(fake_forum)
    res = call_tool("lw_filter_posts", {"links_to": P1, "sort": "new"})
    assert res.is_error and "backlinks come in karma order only" in text(res) and seen == []


def test_links_to_unknown_post_is_miss(call_tool, fake_forum):
    filter_forum(fake_forum, target=False)
    res = call_tool("lw_filter_posts", {"links_to": P1})
    assert res.is_error and f"no post found for '{P1}'" in text(res)


def test_backlink_total_only_trusted_on_full_page(call_tool, fake_forum):
    filter_forum(fake_forum, rows=[row(n) for n in range(3)], total=3)
    assert "43 total" in text(call_tool("lw_filter_posts", {"links_to": P1, "offset": 40}))
    filter_forum(fake_forum, rows=[row(n) for n in range(21)], total=500)
    assert "500 total" in text(call_tool("lw_filter_posts", {"links_to": P1}))


def test_min_karma_zero_drops_negative_rows(call_tool, fake_forum):
    seen = filter_forum(fake_forum, rows=[row(1, karma=5), row(2, karma=-2)])
    out = text(call_tool("lw_filter_posts", {"min_karma": 0}))
    assert "post0000000000001" in out and "post0000000000002" not in out
    assert posts_request(seen)["variables"]["s"]["top"]["karmaThreshold"] == 0


def test_min_karma_in_karma_order_offers_no_page_that_cannot_match(call_tool, fake_forum):
    # In karma order, a next post below min_karma means every later post is below it too.
    filter_forum(fake_forum, rows=[row(n, karma=10) for n in range(5)] + [row(n, karma=-1) for n in range(5, 21)])
    out = text(call_tool("lw_filter_posts", {"min_karma": 0}))
    assert out.startswith("# Posts (5)") and "More" not in out
    # The next post decides, not this page's last one.
    filter_forum(fake_forum, rows=[row(n, karma=10) for n in range(20)] + [row(20, karma=-1)])
    out = text(call_tool("lw_filter_posts", {"min_karma": 0}))
    assert out.startswith("# Posts (20)") and "More" not in out
    filter_forum(fake_forum, rows=[row(n, karma=10) for n in range(21)])
    assert text(call_tool("lw_filter_posts", {"min_karma": 0})).endswith("[More: call again with offset=20.]")
    filter_forum(fake_forum, rows=[row(n, karma=-1) for n in range(21)])
    assert text(call_tool("lw_filter_posts", {"min_karma": 0, "offset": 20})) == "No posts matched those filters."
    assert text(call_tool("lw_filter_posts", {"links_to": P1, "min_karma": 0})) == "No posts matched those filters."


def test_min_karma_in_date_order_says_a_filtered_page_is_not_the_end(call_tool, fake_forum):
    filter_forum(fake_forum, rows=[row(n, karma=-1) for n in range(21)])
    out = text(call_tool("lw_filter_posts", {"min_karma": 0, "sort": "new"}))
    assert out.startswith("No posts on this page matched those filters.") and "call again with offset=20" in out


def test_footer_more_and_cap(call_tool, fake_forum):
    filter_forum(fake_forum, rows=[row(n) for n in range(21)])
    assert "call again with offset=20" in text(call_tool("lw_filter_posts", {}))
    assert "call again with offset=2000" in text(call_tool("lw_filter_posts", {"offset": 1990}))
    assert "past the paging cap" in text(call_tool("lw_filter_posts", {"offset": 2000}))
    filter_forum(fake_forum)
    assert "No posts matched those filters." in text(call_tool("lw_filter_posts", {}))


def test_footer_says_the_next_page_repeats_rows_when_the_cap_moves_it_back(call_tool, fake_forum):
    filter_forum(fake_forum, rows=[row(n) for n in range(21)])
    assert text(call_tool("lw_filter_posts", {"offset": 1990})).endswith(
        "[More: call again with offset=2000. Offset stops at 2000, so that page starts with this page's"
        " last 10 posts.]")
    assert text(call_tool("lw_filter_posts", {"offset": 1981})).endswith("starts with this page's last post.]")
    assert text(call_tool("lw_filter_posts", {"offset": 1980})).endswith("[More: call again with offset=2000.]")
    assert text(call_tool("lw_filter_posts", {})).endswith("[More: call again with offset=20.]")
    # Only rows this page shows can repeat: min_karma hides two of the ten that overlap.
    filter_forum(fake_forum, rows=[row(n, karma=-1 if n in (12, 13) else 10) for n in range(21)])
    assert text(call_tool("lw_filter_posts", {"offset": 1990, "sort": "new", "min_karma": 0})).endswith(
        "starts with this page's last 8 posts.]")


# --------------------------------------------------------------------------- lw_get_sequence

S1 = "seq00000000000001"
FIVE = {"lw_search", "lw_get_post", "lw_get_comments", "lw_filter_posts", "lw_get_sequence"}


def test_sequence_renders_chapters(call_tool, fake_forum):
    seq = {"_id": S1, "title": "Series", "user": {"displayName": "A", "slug": "a"}, "contents": {"markdown": "About."},
           "chapters": [{"title": "Part 1", "number": 1, "posts": [row(1), row(2)]}]}
    seen = fake_forum(gql({"sequence": {"result": seq}}))
    out = text(call_tool("lw_get_sequence", {"sequence_id": S1}))
    assert out.startswith("# Series") and "## Part 1" in out and "2. [Post 2](https://www.lesswrong.com/api/post/post0000000000002)" in out
    assert body(seen[0])["variables"] == {"id": S1}


def test_unknown_sequence_is_miss(call_tool, fake_forum):
    fake_forum(gql({"sequence": {"result": None}}))
    res = call_tool("lw_get_sequence", {"sequence_id": S1})
    assert res.is_error and f"no sequence found for '{S1}'" in text(res) and FIND["sequence"] in text(res)


# --------------------------------------------------------------------------- the whole surface

def test_exactly_the_five_tools_are_registered(run):
    import lesswrong_mcp
    assert {t.name for t in run(lesswrong_mcp.mcp.list_tools())} == FIVE


def test_every_tool_read_only_and_none_takes_site(tool_schema, listed_tool):
    for name in FIVE:
        assert listed_tool(name).annotations.read_only_hint is True
        assert "site" not in tool_schema(name)["properties"]


def test_instructions_name_only_registered_tools():
    import re
    assert set(re.findall(r"lw_\w+", INSTRUCTIONS)) == FIVE


def test_unknown_tool_reported_by_name(call_tool):
    res = call_tool("lw_get_user", {"slug": "a"})
    assert res.is_error and "Unknown tool" in text(res)


# --------------------------------------------------------------------------- review fixes

def test_one_comment_is_sliced_and_honours_offset(call_tool, fake_forum):
    fake_forum(gql({"comment": {"result": comment(C1, contents={"markdown": "z" * 2000})}}))
    first = text(call_tool("lw_get_comments", {"post_id": P1, "comment_id": C1, "max_chars": 500}))
    assert "call again with offset=500" in first
    later = text(call_tool("lw_get_comments", {"post_id": P1, "comment_id": C1, "max_chars": 500, "offset": 500}))
    assert later.startswith("z" * 500) and "continues from character 500" in later


def test_answers_follow_sort(call_tool, fake_forum):
    import re as _re
    answers = [
        comment("ans00000000000002", answer=True, postedAt="2023-01-01T00:00:00Z", baseScore=50),
        comment("ans00000000000001", answer=True, postedAt="2020-01-01T00:00:00Z", baseScore=1),
        comment("rep00000000000001", "ans00000000000001", postedAt="2024-01-01T00:00:00Z"),
        comment("ans00000000000003", answer=True, postedAt="2021-01-01T00:00:00Z", baseScore=100),
    ]
    fake_forum(gql(thread_data(answers, question=True)))
    order = {}
    for sort in ("old", "new", "top"):
        out = text(call_tool("lw_get_comments", {"post_id": P1, "sort": sort}))
        order[sort] = _re.findall(r"^### \[(\w+)\]", out, _re.M)
    assert order["old"] == ["ans00000000000001", "rep00000000000001", "ans00000000000003", "ans00000000000002"]
    assert order["new"] == ["ans00000000000002", "ans00000000000003", "ans00000000000001", "rep00000000000001"]
    assert order["top"] == ["ans00000000000003", "ans00000000000002", "ans00000000000001", "rep00000000000001"]


def test_last_representable_day_bounds_nothing(call_tool, fake_forum):
    seen = filter_forum(fake_forum)
    assert not call_tool("lw_filter_posts", {"before": "9999-12-31"}).is_error
    assert "before" not in posts_request(seen)["variables"]["s"]["top"]
    seen = search_forum(fake_forum)
    assert not call_tool("lw_search", {"query": "qq", "types": ["posts"], "before": "9999-12-31"}).is_error
    assert "numericFilters" not in sent(seen)[0]["params"]
