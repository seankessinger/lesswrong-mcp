"""GraphQL slug -> _id resolution.

Sits between the HTTP layer and the tools: turns a user/tag slug into a document _id via a
single GraphQL lookup, falling back to a raw 17-char _id. Reaches `_graphql` THROUGH the
http_client module so the hermetic suite's monkeypatch on it is seen.

A small bounded LRU cache memoises successful resolutions (tag/user _ids are effectively
immutable), so a run of author/tag filters that share an author or tag — paging, refining —
pays the resolution round-trip once instead of on every call. Only hits are cached; a
non-resolving value is never stored, so a typo doesn't stick.
"""
from __future__ import annotations

from collections import OrderedDict

from lesswrong_mcp import http_client
from lesswrong_mcp.config import _ID_RE

# (site, field, value) -> resolved _id. Bounded and LRU-evicted; reset in tests via the
# autouse fixture in tests/conftest.py so a cached hit can't leak across tests.
_ID_CACHE: "OrderedDict[tuple[str, str, str], str]" = OrderedDict()
_ID_CACHE_MAX = 2048


async def _resolve_id(
    site: str, value: str, *, field: str, selector_type: str, selector_key: str
) -> str | None:
    """Return a document _id, accepting an _id directly or resolving a slug via GraphQL.

    `field` is the query collection ('users'/'tags'), `selector_type` its GraphQL
    selector type ('UserSelector!'), and `selector_key` the slug selector view.

    Resolution is by slug lookup first, falling back to treating the value as a raw
    _id only if no slug matches. Shape alone can't disambiguate: a real slug can be
    exactly 17 alphanumerics (a hyphen-free username) and so collide with the _id
    shape, and short-circuiting on that would send an unresolved slug downstream and
    silently match nothing. The cost is one extra GraphQL round-trip when a genuine
    _id is passed (uncommon — callers usually pass slugs, which need this lookup anyway).

    Deliberate trade-off: a 17-char _id that matches no slug is returned unverified, so
    a *post* _id passed as author/tag is accepted as a filter id and matches no posts
    ('No posts matched those filters.') rather than raising 'no user/tag found'. This is
    intentional — verifying every raw id would add a round-trip and, worse, would reject
    valid-but-unexposed ids (e.g. a deleted/merged user or tag whose document the single
    resolver won't return but whose posts the userId/tag filter still matches). The
    lenient path stays robust to those backend quirks; the terse empty result is the
    accepted cost, and the id/slug collision is called out in the tool docstrings.

    Successful resolutions are memoised in `_ID_CACHE` (keyed on site/field/value) so a
    repeat lookup skips the GraphQL round-trip; a value that doesn't resolve is not cached.
    """
    key = (site, field, value)
    cached = _ID_CACHE.get(key)
    if cached is not None:
        _ID_CACHE.move_to_end(key)  # LRU: mark as most-recently used
        return cached

    data = await http_client._graphql(
        site,
        f"query ($s: {selector_type}) {{ {field}(selector: $s, limit: 1) {{ results {{ _id }} }} }}",
        {"s": {selector_key: {"slug": value}}},
    )
    results = (data.get(field) or {}).get("results") or []
    resolved = results[0]["_id"] if results else (value if _ID_RE.match(value) else None)

    if resolved is not None:
        _ID_CACHE[key] = resolved
        if len(_ID_CACHE) > _ID_CACHE_MAX:
            _ID_CACHE.popitem(last=False)  # evict the least-recently-used entry
    return resolved


async def _resolve_user_id(site: str, author: str) -> str | None:
    """Return a user's _id. Accepts an _id directly or resolves a profile slug."""
    return await _resolve_id(
        site, author, field="users", selector_type="UserSelector!", selector_key="usersProfile"
    )


async def _resolve_tag_id(site: str, tag: str) -> str | None:
    """Return a tag's _id. Accepts an _id directly or resolves a tag slug."""
    return await _resolve_id(
        site, tag, field="tags", selector_type="TagSelector!", selector_key="tagBySlug"
    )
