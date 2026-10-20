"""lesswrong_mcp: a read-only MCP server for LessWrong and the Alignment Forum.

Both forums are one ForumMagnum deployment, so one server reads both. The public surface is the
server `mcp`, its tools, `main` and `__version__`; importing the package registers the tools.
"""
from lesswrong_mcp.forum import VERSION as __version__
from lesswrong_mcp.server import mcp
from lesswrong_mcp.tools import lw_filter_posts, lw_get_comments, lw_get_post, lw_get_sequence, lw_search

__all__ = ["__version__", "mcp", "lw_search", "lw_get_post", "lw_get_comments", "lw_filter_posts", "lw_get_sequence", "main"]


def main() -> None:
    """Serve the tools over stdio until the client closes stdin."""
    mcp.run()
