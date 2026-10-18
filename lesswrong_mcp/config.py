"""Configuration, version derivation, the tools' choice types, and the site base URLs.

The pure leaf: imports nothing from the package, so it can never introduce a cycle.
"""
from __future__ import annotations

import importlib.metadata
import logging
import math
import os
from collections.abc import Callable, Mapping
from typing import Literal, TypeVar, get_args

log = logging.getLogger(__name__)

_T = TypeVar("_T")


# Plain comparisons: NaN fails them, and an int of any size compares exactly, with no
# conversion to float that could overflow.
def _positive(value: float) -> bool:
    """Finite and > 0: a zero or NaN timeout expires at once, and Semaphore(0) deadlocks."""
    return 0 < value < math.inf


def _non_negative(value: float) -> bool:
    """Finite and >= 0: zero is a meaningful setting (LW_MAX_RETRIES=0 disables retries)."""
    return 0 <= value < math.inf


def _env_num(
    env: Mapping[str, str],
    name: str,
    default: _T,
    cast: Callable[[str], _T],
    *,
    valid: Callable[[_T], bool] | None = None,
) -> _T:
    """Parse ``env[name]`` with ``cast``, falling back to ``default`` when unset, blank,
    malformed, or rejected by ``valid``. These are tuning knobs, so a bad override must not
    crash the server at import; a set-but-rejected value is logged at WARNING so it is not
    silently ignored. The mapping is passed in (not read from ``os.environ``) so the parse is
    unit-testable.
    """
    raw = env.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = cast(raw.strip())
    except (TypeError, ValueError):
        pass
    else:
        if valid is None or valid(value):
            return value
    log.warning("Ignoring %s=%r; using the default %r.", name, raw, default)
    return default


LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


def _log_level(env: Mapping[str, str]) -> LogLevel:
    """The LW_LOG_LEVEL setting, or INFO when unset or unrecognised. The SDK reads no
    environment variable for its log level, so the server reads this one and hands it to the
    MCPServer constructor."""
    raw = (env.get("LW_LOG_LEVEL") or "").strip()
    for level in get_args(LogLevel):
        if raw.upper() == level:
            return level
    if raw:
        log.warning("Ignoring LW_LOG_LEVEL=%r; using INFO.", raw)
    return "INFO"


# The closed choices the tools accept. As Literal aliases they render as inline JSON-Schema
# enums, and mypy checks every internal caller against them.
Site = Literal["lesswrong", "alignmentforum"]
ResponseFormat = Literal["markdown", "json"]
SearchType = Literal["posts", "comments", "tags", "users", "sequences"]
CommentSort = Literal["top", "new", "old"]
Feed = Literal["latest", "recent", "curated", "home"]
PostSort = Literal["top", "new", "old", "magic", "recentComments"]

# Both forums run one backend; the site only switches the base URL.
SITE_BASE_URLS: dict[Site, str] = {
    "lesswrong": "https://www.lesswrong.com",
    "alignmentforum": "https://www.alignmentforum.org",
}

# Read the installed package metadata, falling back to a literal for a non-installed source
# tree. Keeps the User-Agent in lock-step with pyproject.toml.
try:
    __version__ = importlib.metadata.version("lesswrong-mcp")
except importlib.metadata.PackageNotFoundError:  # running from a non-installed source tree
    __version__ = "2.0.0"

# The "+URL" names where the forum's operators can find this client and its maintainer.
USER_AGENT = (
    f"lesswrong-mcp/{__version__} "
    "(+https://github.com/seankessinger/lesswrong-mcp; read-only research client)"
)
LOG_LEVEL = _log_level(os.environ)
# Four HTTP knobs, env-overridable so an operator can dial politeness/latency without editing
# source. HTTP_TIMEOUT is per-operation (connect/read/write); HTTP_TOTAL_TIMEOUT caps each
# attempt's whole round-trip in _request, since httpx has no total-time bound (it is per
# attempt, not across retries); MAX_RETRIES is the number of retries after the first attempt.
HTTP_TIMEOUT = _env_num(os.environ, "LW_HTTP_TIMEOUT", 30.0, float, valid=_positive)
HTTP_TOTAL_TIMEOUT = _env_num(os.environ, "LW_HTTP_TOTAL_TIMEOUT", 60.0, float, valid=_positive)
MAX_RETRIES = _env_num(os.environ, "LW_MAX_RETRIES", 2, int, valid=_non_negative)
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
# Bounds the slug-resolution round-trips (one per distinct tag) a single call can trigger.
MAX_TAG_FILTERS = 10          # lw_filter_posts `tags`: items per call
# The longest slice lw_get_post / lw_get_comments return (a short paging footer follows it), and
# their default: hosts spill a larger tool result to a file and show the model only a preview
# (Claude Code does past 50,000 characters), so a long body is read by paging with the footer's
# offset instead.
MAX_CHARS = 40_000
# Politeness: cap concurrent in-flight requests (the semaphore lives in _resources).
_CONCURRENCY_LIMIT = _env_num(os.environ, "LW_CONCURRENCY", 4, int, valid=_positive)
