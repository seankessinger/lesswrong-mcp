"""Entry point: serve the tools over stdio.

Importing the package registers the tools, so main() can assume `mcp` is fully populated.
"""
from __future__ import annotations

from lesswrong_mcp.server import mcp


def main() -> None:
    """Serve the tools over stdio until the client closes stdin."""
    mcp.run()
