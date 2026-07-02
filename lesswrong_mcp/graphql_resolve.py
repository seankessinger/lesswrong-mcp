"""GraphQL slug -> _id resolution.

Turns a user/tag slug into a document _id via a single GraphQL lookup. Reaches `_graphql`
THROUGH the http_client module so the hermetic suite's monkeypatch is seen. Successful
resolutions are memoised in a bounded LRU (tag/user _ids are effectively immutable); misses
are never cached, so a typo doesn't stick.
"""
from __future__ import annotations

from collections import OrderedDict

from lesswrong_mcp import http_client
from lesswrong_mcp.config import _ID_RE

# (site, field, value) -> resolved _id. Bounded and LRU-evicted; reset in tests via the
# autouse fixture in tests/conftest.py so a cached hit can't leak across tests.
_ID_CACHE: OrderedDict[tuple[str, str, str], str] = OrderedDict()
_ID_CACHE_MAX = 2048


async def _resolve_id(
    site: str, value: str, *, field: str, selector_type: str, selector_key: str
) -> str | None:
    """Return a document _id, accepting an _id directly or resolving a slug via GraphQL.

    `field` is the query collection ('users'/'tags'), `selector_type` its GraphQL selector
    type ('UserSelector!'), and `selector_key` the slug selector view.

    Slug lookup comes first, falling back to a raw _id only if no slug matches: shape alone
    can't disambiguate, since a hyphen-free username can be exactly 17 alphanumerics and so
    collide with the _id shape. Short-circuiting on shape would send an unresolved slug
    downstream to match nothing.

    A 17-char _id that matches no slug is returned *unverified* — deliberately. Verifying
    every raw id would cost a round-trip and would reject valid-but-unexposed ids (a
    deleted/merged user or tag the resolver won't return but whose posts the filter still
    matches). The cost is that a wrong-collection id yields 'No posts matched those filters.'
    rather than 'no user/tag found'.
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
