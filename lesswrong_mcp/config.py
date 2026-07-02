"""Configuration, version derivation, enums, and the site -> base-URL helper.

The pure leaf of the package: everything else imports from here, and this imports nothing
from the package (only stdlib + httpx), so it can never introduce an import cycle.
"""
from __future__ import annotations

import importlib.metadata
import os
import re
from enum import Enum
from typing import Callable, TypeVar

import httpx

_T = TypeVar("_T")


def _env_num(env, name: str, default: _T, cast: Callable[[str], _T], *, positive: bool = False) -> _T:
    """Parse ``env[name]`` with ``cast``, falling back to ``default`` when the var is
    unset, blank, or malformed.

    The env mapping is passed in (rather than reaching for ``os.environ`` directly) so the
    parse is unit-testable in isolation, mirroring ``cli._configure_http``. A bad override
    degrades to the default instead of crashing the read-only server at import time — these
    are politeness/latency tuning knobs, not correctness-critical settings.

    ``positive=True`` also rejects a parsed value ``<= 0`` (falling back to the default): all
    four HTTP knobs are counts/durations for which a non-positive value is nonsensical *and*
    breaks the client (0 retries makes ``range(MAX_RETRIES)`` empty and trips the retry
    loop's "unreachable" guard; 0 concurrency deadlocks on ``Semaphore(0)``; a 0/negative
    timeout errors), so the "degrades to the default" guarantee must cover them too.
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

# Single source of truth for the version: read the installed package metadata, falling
# back to a literal when running from a source tree that isn't pip-installed (e.g. the
# hermetic test run). Keeps the User-Agent version in lock-step with pyproject.toml, so a
# bump updates both at once.
try:
    __version__ = importlib.metadata.version("lesswrong-mcp")
except importlib.metadata.PackageNotFoundError:  # running from a non-installed source tree
    __version__ = "1.0.0"

USER_AGENT = (
    f"lesswrong-mcp/{__version__} (read-only research client; "
    "https://modelcontextprotocol.io)"
)
# Four HTTP tuning knobs, each defaulting to the value below but overridable per deployment
# via an env var (an operator dialling politeness/latency without editing source); a
# malformed override falls back to the default. HTTP_TIMEOUT is per-operation
# (connect/read/write); HTTP_TOTAL_TIMEOUT caps the whole round-trip in _request, since httpx
# has no total-time bound; MAX_RETRIES bounds the retry loop.
HTTP_TIMEOUT = _env_num(os.environ, "LW_HTTP_TIMEOUT", 30.0, float, positive=True)
HTTP_TOTAL_TIMEOUT = _env_num(os.environ, "LW_HTTP_TOTAL_TIMEOUT", 60.0, float, positive=True)
MAX_RETRIES = _env_num(os.environ, "LW_MAX_RETRIES", 3, int, positive=True)
# Two backend-imposed pagination ceilings. Surfacing them as fast-failing bounds/guards at
# the tool boundary turns an opaque mid-call backend error into an actionable one and, for
# the search case, avoids wasting the _request retry budget on a deterministic 500. Both
# were pinned by binary search against the live API (2026-07-02):
#   - the GraphQL `posts` selector rejects skip > 2000 ("Exceeded maximum value for skip");
#   - the shared search index (Elasticsearch max_result_window) only serves the first
#     10,000 results (from + size <= 10000), returning HTTP 500 for anything past that.
MAX_GRAPHQL_SKIP = 2000       # lw_filter_posts `offset`: skip must be <= this
SEARCH_RESULT_WINDOW = 10000  # lw_search: page * limit must be <= this
SEARCH_PAGE_MAX = 1000        # lw_search: the `page` upper bound (so a next-page hint stays valid)
# 17-char alphanumeric = a ForumMagnum document _id; anything else is treated as a slug.
_ID_RE = re.compile(r"^[A-Za-z0-9]{17}$")
# Politeness: cap concurrent in-flight requests (the semaphore lives in _resources).
_CONCURRENCY_LIMIT = _env_num(os.environ, "LW_CONCURRENCY", 4, int, positive=True)
# SSRF guard: the client may only ever follow redirects that stay on one of the
# two forum hosts. This still allows the API's legitimate same-host slug -> canonical
# redirects, but refuses a cross-host Location (e.g. a link-local metadata address).
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
