"""GraphQL slug -> _id resolution.

Turns a user/tag slug into a document _id via a single GraphQL lookup. Reaches `_graphql`
THROUGH the http_client module so the hermetic suite's monkeypatch is seen. Successful
resolutions are memoised in a bounded LRU (tag/user _ids are effectively immutable); misses
are never cached, so a typo doesn't stick.
"""
from __future__ import annotations

from collections import OrderedDict

from lesswrong_mcp import http_client
from lesswrong_mcp.config import Site

# (site, field, value) -> resolved _id. Bounded and LRU-evicted; reset in tests via the
# autouse fixture in tests/conftest.py so a cached hit can't leak across tests.
_ID_CACHE: OrderedDict[tuple[Site, str, str], str] = OrderedDict()
_ID_CACHE_MAX = 2048


async def _resolve_id(
    site: Site, value: str, *, field: str, selector_type: str, selector_key: str
) -> str | None:
    """Return the _id of the document whose slug is `value`, or None when no slug matches.

    `field` is the query collection ('users'/'tags'), `selector_type` its GraphQL selector
    type ('UserSelector!'), and `selector_key` the slug selector view.

    The value is looked up as a slug and as nothing else: it is not checked against the _id
    shape, so a document _id matches no slug and resolves to None like any other unknown
    value.
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
    resolved = results[0]["_id"] if results else None

    if resolved is not None:
        _ID_CACHE[key] = resolved
        if len(_ID_CACHE) > _ID_CACHE_MAX:
            _ID_CACHE.popitem(last=False)  # evict the least-recently-used entry
    return resolved


async def _resolve_user_id(site: Site, author: str) -> str | None:
    """Resolve a profile slug to a user's _id, or None."""
    return await _resolve_id(
        site, author, field="users", selector_type="UserSelector!", selector_key="usersProfile"
    )


async def _resolve_tag_id(site: Site, tag: str) -> str | None:
    """Resolve a tag slug to a tag's _id, or None."""
    return await _resolve_id(
        site, tag, field="tags", selector_type="TagSelector!", selector_key="tagBySlug"
    )
