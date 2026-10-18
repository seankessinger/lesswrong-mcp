"""lesswrong_mcp — a read-only MCP server exposing LessWrong and the Alignment Forum as tools.

Both sites are the same open-source ForumMagnum app sharing one database, so a single server
covers both by switching the base URL; no auth is required for reads. Wraps the agent-oriented
Markdown REST API under /api/* and the GraphQL endpoint (author/tag/date/karma filtering).
Strictly read-only — the draft-editing POST endpoints are intentionally not wrapped.

The public surface (`__all__`) is the server `mcp`, its eight tools, the choice types the tools
accept, the package `__version__` and the `main` entry point.
Importing `tools` registers the handlers on `mcp`, so a bare `import lesswrong_mcp` yields a
fully registered server. Everything else lives in its submodule and is imported from there.
"""
from lesswrong_mcp.config import (
    __version__,
    CommentSort,
    Feed,
    PostSort,
    ResponseFormat,
    SearchType,
    Site,
)
from lesswrong_mcp.server import mcp
from lesswrong_mcp.tools import (
    lw_filter_posts,
    lw_get_comments,
    lw_get_post,
    lw_get_sequence,
    lw_get_tag,
    lw_get_user,
    lw_list_feed,
    lw_search,
)
from lesswrong_mcp.cli import main

__all__ = [
    "__version__",
    "CommentSort", "Feed", "PostSort", "ResponseFormat", "SearchType", "Site",
    "mcp",
    "lw_search", "lw_get_post", "lw_get_comments", "lw_get_user", "lw_get_tag",
    "lw_get_sequence", "lw_list_feed", "lw_filter_posts",
    "main",
]
