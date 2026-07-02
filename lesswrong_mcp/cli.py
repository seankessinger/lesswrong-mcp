"""Entry point: transport selection and DNS-rebinding hardening for the HTTP server.

`python -m lesswrong_mcp` (via __main__.py) and the `lesswrong-mcp` console script both call
main(). `_configure_http` is the pure env -> (host, port, TransportSecuritySettings) helper it
applies. The tools are registered by importing the package (its __init__ imports the tools
module for its side effect), so main() can assume `mcp` is fully populated before mcp.run().
"""
from __future__ import annotations

from mcp.server.transport_security import TransportSecuritySettings

from lesswrong_mcp import http_client
from lesswrong_mcp.server import mcp


def _configure_http(env) -> tuple[str, int, TransportSecuritySettings]:
    """Resolve the HTTP bind host/port and the DNS-rebinding TransportSecuritySettings
    from an environment mapping. Pure — no mcp.settings mutation, no I/O — so the
    transport-hardening decision is unit-testable in isolation; main() only applies the
    result. `env` is any mapping with .get (os.environ in production, a dict in tests).

    - host: MCP_HOST, else 127.0.0.1.
    - port: PORT, else MCP_PORT, else 8000.
    - transport_security: with MCP_ALLOWED_HOSTS / MCP_ALLOWED_ORIGINS set, protection is
      enabled scoped to those; else for a loopback bind protection stays on scoped to
      loopback:<port>; else (a non-loopback bind whose public hostname is deploy-time and
      unknown here) protection is disabled.
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
    """Entry point.

    Transport is chosen by the MCP_TRANSPORT env var:
      - "stdio" (default) — for classic Claude Desktop, Claude Code, MCP Inspector.
      - "http" / "streamable-http" — for use as a Cowork / claude.ai *remote custom
        connector*. Cowork does NOT run local stdio servers; it reaches your server
        over public HTTPS, so run in HTTP mode and expose it (see README).

    HTTP host/port come from MCP_HOST (default 127.0.0.1) and MCP_PORT / PORT
    (default 8000). Many cloud hosts require binding 0.0.0.0 and set $PORT.
    The MCP endpoint is served at path /mcp.

    Two more optional env vars harden the HTTP transport:
      - MCP_ALLOWED_HOSTS / MCP_ALLOWED_ORIGINS — comma-separated allow-lists. When
        either is set, DNS-rebinding (Host/Origin) protection is enabled and scoped
        to those values. With neither set, protection stays ON for a loopback bind
        (auto-scoped to localhost:<port>) so a local run isn't reachable via DNS
        rebinding, and is only disabled for a non-loopback bind (e.g. 0.0.0.0 on a
        PaaS) whose public hostname is assigned at deploy time and unknown here.
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
