"""Entry point: transport selection and DNS-rebinding hardening for the HTTP server.

Importing the package registers the tools, so main() can assume `mcp` is fully populated.
"""
from __future__ import annotations

from mcp.server.transport_security import TransportSecuritySettings

from lesswrong_mcp import http_client
from lesswrong_mcp.server import mcp


def _configure_http(env) -> tuple[str, int, TransportSecuritySettings]:
    """Resolve the HTTP bind host/port and DNS-rebinding settings from an env mapping.

    Pure — no mcp.settings mutation, no I/O — so the hardening decision is unit-testable;
    main() only applies the result. `env` is any mapping with .get.
    """
    host = env.get("MCP_HOST", "127.0.0.1")
    port = int(env.get("PORT") or env.get("MCP_PORT") or "8000")

    def _csv(name: str) -> list[str]:
        return [v.strip() for v in env.get(name, "").split(",") if v.strip()]

    allowed_hosts = _csv("MCP_ALLOWED_HOSTS")
    allowed_origins = _csv("MCP_ALLOWED_ORIGINS")
    if allowed_hosts or allowed_origins:
        # Explicit allow-list: protection scoped to these values.
        transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=allowed_hosts,
            allowed_origins=allowed_origins,
        )
    elif host in ("127.0.0.1", "localhost", "::1"):
        # Loopback with no allow-list: keep protection on, scoped to loopback, so a
        # web page can't DNS-rebind to this port and drive the tools.
        transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"],
            allowed_origins=[
                f"http://127.0.0.1:{port}",
                f"http://localhost:{port}",
                f"http://[::1]:{port}",
            ],
        )
    else:
        # Non-loopback bind (e.g. 0.0.0.0 on a PaaS) with no allow-list: the public
        # hostname is deploy-time and unknown here, so protection is left off (set
        # MCP_ALLOWED_HOSTS for a known hostname).
        transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        )
    return host, port, transport_security


def main() -> None:
    """Run the server over the transport named by MCP_TRANSPORT.

    "stdio" (default) serves Claude Desktop / Claude Code / MCP Inspector; "http" (or
    "streamable-http") serves a remote custom connector at /mcp. See the README for the
    host/port and allow-list env vars.
    """
    import os

    transport = os.environ.get("MCP_TRANSPORT", "stdio").strip().lower()
    if transport in ("http", "streamable-http", "streamable_http"):
        host, port, transport_security = _configure_http(os.environ)
        mcp.settings.host = host
        mcp.settings.port = port

        # Every tool is a stateless read, so run streamable-HTTP in stateless mode:
        # this drops the per-session in-memory affinity requirement, letting any
        # replica serve any request (multi-instance / scale-to-zero PaaS friendly).
        mcp.settings.stateless_http = True
        mcp.settings.json_response = True
        # Flag the http_client module (where _lifespan lives) so it leaves the
        # process-scoped pooled client alone in HTTP mode. Set it on its home module,
        # NOT via a local `global`: a `global _STATELESS_HTTP` here would rebind a dead
        # cli name that http_client._lifespan never reads.
        http_client._STATELESS_HTTP = True

        mcp.settings.transport_security = transport_security
        mcp.run(transport="streamable-http")
    else:
        mcp.run()
