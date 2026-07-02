"""Configuration, version derivation, enums, and the site -> base-URL helper.

The pure leaf: imports nothing from the package, so it can never introduce a cycle.
"""
from __future__ import annotations

import importlib.metadata
import os
import re
from collections.abc import Callable
from enum import Enum
from typing import TypeVar

import httpx

_T = TypeVar("_T")


def _env_num(env, name: str, default: _T, cast: Callable[[str], _T], *, positive: bool = False) -> _T:
    """Parse ``env[name]`` with ``cast``, falling back to ``default`` when unset, blank, or
    malformed — these are tuning knobs, so a bad override must not crash the server at import.
    The mapping is passed in (not read from ``os.environ``) so the parse is unit-testable.

    ``positive=True`` also rejects ``<= 0``, which is nonsensical *and* breaks the client:
    0 retries empties ``range(MAX_RETRIES)`` and trips the retry loop's "unreachable" guard,
    0 concurrency deadlocks on ``Semaphore(0)``, and a non-positive timeout errors.
    """
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = cast(str(raw).strip())
    except (TypeError, ValueError):
        return default
    if positive and value <= 0:  # type: ignore[operator]
        return default
    return value

SITE_BASE_URLS: dict[str, str] = {
    "lesswrong": "https://www.lesswrong.com",
    "alignmentforum": "https://www.alignmentforum.org",
}
DEFAULT_SITE = "lesswrong"

# Read the installed package metadata, falling back to a literal for a non-installed source
# tree. Keeps the User-Agent in lock-step with pyproject.toml.
try:
    __version__ = importlib.metadata.version("lesswrong-mcp")
except importlib.metadata.PackageNotFoundError:  # running from a non-installed source tree
    __version__ = "1.0.0"

USER_AGENT = (
    f"lesswrong-mcp/{__version__} (read-only research client; "
    "https://modelcontextprotocol.io)"
)
# Four HTTP knobs, env-overridable so an operator can dial politeness/latency without editing
# source. HTTP_TIMEOUT is per-operation (connect/read/write); HTTP_TOTAL_TIMEOUT caps the whole
# round-trip in _request, since httpx has no total-time bound; MAX_RETRIES bounds the loop.
HTTP_TIMEOUT = _env_num(os.environ, "LW_HTTP_TIMEOUT", 30.0, float, positive=True)
HTTP_TOTAL_TIMEOUT = _env_num(os.environ, "LW_HTTP_TOTAL_TIMEOUT", 60.0, float, positive=True)
MAX_RETRIES = _env_num(os.environ, "LW_MAX_RETRIES", 3, int, positive=True)
# Two backend-imposed pagination ceilings, pinned by binary search against the live API
# (2026-07-02). Surfaced as fast-failing bounds at the tool boundary so an opaque mid-call
# backend error becomes an actionable one — and, for search, so a deterministic 500 doesn't
# burn the retry budget:
#   - the GraphQL `posts` selector rejects skip > 2000 ("Exceeded maximum value for skip");
#   - the shared search index (Elasticsearch max_result_window) serves only the first
#     10,000 results (from + size <= 10000), returning HTTP 500 past that.
MAX_GRAPHQL_SKIP = 2000       # lw_filter_posts `offset`: skip must be <= this
SEARCH_RESULT_WINDOW = 10000  # lw_search: page * limit must be <= this
SEARCH_PAGE_MAX = 1000        # lw_search: the `page` upper bound (so a next-page hint stays valid)
# 17-char alphanumeric = a ForumMagnum document _id; anything else is treated as a slug.
_ID_RE = re.compile(r"^[A-Za-z0-9]{17}$")
# Politeness: cap concurrent in-flight requests (the semaphore lives in _resources).
_CONCURRENCY_LIMIT = _env_num(os.environ, "LW_CONCURRENCY", 4, int, positive=True)
# SSRF guard: redirects may only stay on the two forum hosts. Allows the API's legitimate
# same-host slug -> canonical redirects; refuses a cross-host Location (e.g. link-local).
_ALLOWED_HOSTS = frozenset(httpx.URL(u).host for u in SITE_BASE_URLS.values())


class Site(str, Enum):
    """Which forum to query. Both share one backend; this switches the base URL."""
    lesswrong = "lesswrong"
    alignmentforum = "alignmentforum"


class ResponseFormat(str, Enum):
    markdown = "markdown"
    json = "json"


class SearchType(str, Enum):
    """A single content type to restrict lw_search to. Omit to search all of them."""
    posts = "posts"
    comments = "comments"
    tags = "tags"
    users = "users"
    sequences = "sequences"


class CommentSort(str, Enum):
    top = "top"
    new = "new"
    old = "old"


class Feed(str, Enum):
    latest = "latest"
    recent = "recent"
    curated = "curated"
    home = "home"


class PostSort(str, Enum):
    """Sort orders accepted by the GraphQL post views."""
    top = "top"                        # highest karma
    new = "new"                        # newest first
    old = "old"                        # oldest first
    magic = "magic"                    # the site's default "hot" ranking
    recentComments = "recentComments"  # recently-active discussions


def _base(site: str) -> str:
    return SITE_BASE_URLS.get(site, SITE_BASE_URLS[DEFAULT_SITE])
