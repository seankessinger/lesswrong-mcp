"""Tests for the two pure env -> value helpers: config._env_num and cli._configure_http.

Both take an env mapping as an argument rather than reading os.environ, so they are exercised
directly with plain dicts and need no monkeypatching.
"""
from __future__ import annotations

import lesswrong_mcp as m
from lesswrong_mcp import config as cfg


# ------------------------------------------------------------------------- #
# config._env_num — env parsing for the four HTTP knobs
# ------------------------------------------------------------------------- #

def test_env_num_returns_default_when_unset_or_blank():
    assert cfg._env_num({}, "X", 30.0, float) == 30.0
    assert cfg._env_num({"X": ""}, "X", 30.0, float) == 30.0
    assert cfg._env_num({"X": "   "}, "X", 3, int) == 3


def test_env_num_parses_a_valid_override():
    assert cfg._env_num({"X": "45"}, "X", 30.0, float) == 45.0
    assert cfg._env_num({"X": "10"}, "X", 4, int) == 10
    assert cfg._env_num({"X": " 7 "}, "X", 4, int) == 7  # surrounding whitespace tolerated


def test_env_num_falls_back_on_malformed_value():
    assert cfg._env_num({"X": "abc"}, "X", 30.0, float) == 30.0
    assert cfg._env_num({"X": "4.5"}, "X", 3, int) == 3  # not an int -> default, no crash


def test_env_num_positive_rejects_non_positive_values():
    # positive=True (used by all four knobs) treats 0 / negative as malformed, so a
    # nonsensical LW_MAX_RETRIES=0 (empty retry loop) or LW_CONCURRENCY=0 (Semaphore deadlock)
    # falls back to the default instead of breaking every request.
    assert cfg._env_num({"X": "0"}, "X", 3, int, positive=True) == 3
    assert cfg._env_num({"X": "-2"}, "X", 3, int, positive=True) == 3
    assert cfg._env_num({"X": "0"}, "X", 30.0, float, positive=True) == 30.0
    assert cfg._env_num({"X": "-1.5"}, "X", 30.0, float, positive=True) == 30.0
    assert cfg._env_num({"X": "1"}, "X", 3, int, positive=True) == 1  # a positive value passes
    # Without positive=, zero/negative are accepted verbatim (the generic parse is unchanged).
    assert cfg._env_num({"X": "0"}, "X", 3, int) == 0


def test_module_defaults_reproduce_previous_hardcoded_values():
    # With no env override the effective knobs equal the values they replaced.
    assert cfg.HTTP_TIMEOUT == 30.0
    assert cfg.HTTP_TOTAL_TIMEOUT == 60.0
    assert cfg.MAX_RETRIES == 3
    assert cfg._CONCURRENCY_LIMIT == 4


# ------------------------------------------------------------------------- #
# cli._configure_http — bind host/port + DNS-rebinding settings
# ------------------------------------------------------------------------- #

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
