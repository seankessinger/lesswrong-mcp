"""Tests for `_configure_http` — the pure env -> (host, port, TransportSecuritySettings)
resolver extracted from main(), so the DNS-rebinding-protection decision is unit-testable
without starting a server. Pins PORT/MCP_PORT precedence and the loopback / non-loopback /
explicit-allow-list branches (previously entirely untested).
"""
from __future__ import annotations

import lesswrong_mcp as m


def test_port_precedence_port_beats_mcp_port():
    _, port, _ = m._configure_http({"PORT": "9001", "MCP_PORT": "1234"})
    assert port == 9001


def test_port_falls_back_to_mcp_port_then_default():
    _, port, _ = m._configure_http({"MCP_PORT": "1234"})
    assert port == 1234
    _, port_default, _ = m._configure_http({})
    assert port_default == 8000


def test_loopback_default_keeps_protection_on_scoped_to_port():
    host, port, ts = m._configure_http({})
    assert host == "127.0.0.1"
    assert ts.enable_dns_rebinding_protection is True
    assert f"127.0.0.1:{port}" in ts.allowed_hosts
    assert f"http://127.0.0.1:{port}" in ts.allowed_origins


def test_non_loopback_bind_disables_protection():
    host, _, ts = m._configure_http({"MCP_HOST": "0.0.0.0"})
    assert host == "0.0.0.0"
    assert ts.enable_dns_rebinding_protection is False


def test_explicit_allowlist_scopes_protection_even_on_non_loopback():
    _, _, ts = m._configure_http(
        {"MCP_HOST": "0.0.0.0", "MCP_ALLOWED_HOSTS": "example.com, api.example.com"}
    )
    assert ts.enable_dns_rebinding_protection is True
    # Comma-split, trimmed, blanks dropped.
    assert ts.allowed_hosts == ["example.com", "api.example.com"]
