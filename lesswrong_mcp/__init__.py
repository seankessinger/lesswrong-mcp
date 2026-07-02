"""lesswrong_mcp — a read-only MCP server exposing LessWrong and the Alignment Forum as tools.

Both sites are the same open-source ForumMagnum app sharing one database, so a single server
covers both by switching the base URL; no auth is required for reads. Wraps the agent-oriented
Markdown REST API under /api/* and the GraphQL endpoint (author/tag/date/karma filtering).
Strictly read-only — the draft-editing POST endpoints are intentionally not wrapped.

This module re-exports each name from its home submodule and imports `tools`, so a bare
`import lesswrong_mcp` yields a fully registered server. Importing from the real home is what
lets the hermetic suite patch it (tests/conftest.py's IO_HOME).
"""
from lesswrong_mcp.config import (
    __version__,
    USER_AGENT,
    SITE_BASE_URLS,
    DEFAULT_SITE,
    HTTP_TIMEOUT,
    HTTP_TOTAL_TIMEOUT,
    MAX_RETRIES,
    MAX_GRAPHQL_SKIP,
    SEARCH_RESULT_WINDOW,
    SEARCH_PAGE_MAX,
    _ID_RE,
    _CONCURRENCY_LIMIT,
    _ALLOWED_HOSTS,
    Site,
    ResponseFormat,
    SearchType,
    CommentSort,
    Feed,
    PostSort,
    _base,
)
from lesswrong_mcp.markdown import (
    _handle_error,
    _md_inline,
    _seg,
    _slice_markdown,
    _slug_hint,
    _extract_ref,
    _extract_post_ref,
    _extract_sequence_ref,
    _extract_tag_ref,
    _extract_user_ref,
)
from lesswrong_mcp.http_client import (
    _LOOP_RESOURCES,
    _STATELESS_HTTP,
    _resources,
    _aclose_client,
    _block_offsite_redirect,
    _lifespan,
    _parse_retry_after,
    _request,
    _get_markdown,
    _graphql,
)
from lesswrong_mcp.graphql_resolve import (
    _resolve_id,
    _resolve_user_id,
    _resolve_tag_id,
)
from lesswrong_mcp.server import (
    mcp,
    _READONLY,
    SiteParam,
    _tool_errors,
)
# Importing tools registers the 8 handlers + the /health route on `mcp`.
from lesswrong_mcp.tools import (
    lw_search,
    lw_get_post,
    lw_get_comments,
    lw_get_user,
    lw_get_tag,
    lw_get_sequence,
    lw_list_feed,
    lw_filter_posts,
    health_check,
)
from lesswrong_mcp.cli import _configure_http, main
