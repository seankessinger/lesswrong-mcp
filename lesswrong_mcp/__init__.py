"""lesswrong_mcp — a read-only MCP server exposing LessWrong and the Alignment Forum as tools.

Both sites are the same open-source ForumMagnum app sharing one database, so a single server
covers both by switching the base URL; no authentication is required for reads. It wraps the
agent-oriented Markdown REST API under /api/* (search, posts, comments, users, tags, sequences,
feeds) and the GraphQL endpoint (structured author/tag/date/karma filtering). All tools are
strictly read-only — the forum's draft-editing POST endpoints are intentionally not wrapped.

Package layout: config (constants/enums), markdown (pure text helpers), http_client (all I/O +
lifecycle), graphql_resolve (slug -> _id), server (the `mcp` singleton + tool machinery), tools
(the 8 @mcp.tool handlers + /health), cli (the entry point). This __init__ re-exports each name
from its home module and imports `tools` so a bare `import lesswrong_mcp` yields a fully
registered server; the hermetic suite patches the real homes via tests/conftest.py's IO_HOME.
"""
# Each name is imported from the submodule that now owns it, so `m.<name>` resolves to the
# real home — which is also where the hermetic suite patches it (tests/conftest.py IO_HOME).
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
# Importing tools registers the 8 @mcp.tool handlers + the /health route on `mcp`, so a bare
# `import lesswrong_mcp` yields a fully-populated server.
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
