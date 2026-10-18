"""Tests for the pure env -> value helpers (config._env_num and config._log_level) and for the
import-time values they produce, plus config's site table, which must name a base URL for
exactly the `site` choices.

The helpers take an env mapping as an argument rather than reading os.environ, so they are
exercised directly with plain dicts. The import-time values are checked in a fresh
interpreter, since they are set once, when the package is imported.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import get_args

import pytest

from lesswrong_mcp import config as cfg

_REPO_ROOT = Path(__file__).resolve().parent.parent


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
    # A zero timeout or LW_CONCURRENCY=0 (a Semaphore(0) deadlock) would break every request,
    # so _positive falls back to the default instead.
    assert cfg._env_num({"X": "0"}, "X", 3, int, valid=cfg._positive) == 3
    assert cfg._env_num({"X": "-2"}, "X", 3, int, valid=cfg._positive) == 3
    assert cfg._env_num({"X": "0"}, "X", 30.0, float, valid=cfg._positive) == 30.0
    assert cfg._env_num({"X": "-1.5"}, "X", 30.0, float, valid=cfg._positive) == 30.0
    assert cfg._env_num({"X": "1"}, "X", 3, int, valid=cfg._positive) == 1
    # With no predicate, zero/negative are accepted verbatim.
    assert cfg._env_num({"X": "0"}, "X", 3, int) == 0


def test_env_num_accepts_an_int_knob_too_large_for_a_float():
    # Finite, however long: a huge override is honoured rather than crashing the import.
    big = "9" * 400
    assert cfg._env_num({"X": big}, "X", 4, int, valid=cfg._positive) == int(big)
    assert cfg._env_num({"X": big}, "X", 2, int, valid=cfg._non_negative) == int(big)


def test_env_num_rejects_non_finite_and_warns(caplog):
    # float() parses these, and NaN slips past a plain `<= 0` check: a NaN deadline expires
    # at once, so every request would time out.
    for raw in ("nan", "inf", "-inf"):
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="lesswrong_mcp.config"):
            assert cfg._env_num({"LW_X": raw}, "LW_X", 60.0, float, valid=cfg._positive) == 60.0
        assert len(caplog.records) == 1, raw
        record = caplog.records[0]
        assert record.levelno == logging.WARNING
        assert "LW_X" in record.getMessage() and raw in record.getMessage()
        assert "60.0" in record.getMessage()

    # _non_negative accepts 0 (LW_MAX_RETRIES=0 disables retries) but not a negative.
    assert cfg._env_num({"LW_X": "0"}, "LW_X", 2, int, valid=cfg._non_negative) == 0
    assert cfg._env_num({"LW_X": "-1"}, "LW_X", 2, int, valid=cfg._non_negative) == 2

    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="lesswrong_mcp.config"):
        assert cfg._env_num({"LW_X": "abc"}, "LW_X", 30.0, float) == 30.0
    assert [r.levelno for r in caplog.records] == [logging.WARNING]
    assert "abc" in caplog.records[0].getMessage()

    # Unset or blank is the normal case, not a mistake: no warning.
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="lesswrong_mcp.config"):
        assert cfg._env_num({}, "LW_X", 30.0, float, valid=cfg._positive) == 30.0
        assert cfg._env_num({"LW_X": "  "}, "LW_X", 30.0, float, valid=cfg._positive) == 30.0
    assert caplog.records == []


@pytest.mark.parametrize(("overrides", "expected"), [
    ({}, ["30.0", "60.0", "2", "4"]),
    ({"LW_HTTP_TIMEOUT": "5", "LW_HTTP_TOTAL_TIMEOUT": "7", "LW_MAX_RETRIES": "0",
      "LW_CONCURRENCY": "1"}, ["5.0", "7.0", "0", "1"]),
], ids=["defaults", "overrides"])
def test_http_knobs_resolve_from_the_environment_at_import(overrides, expected):
    # The knobs are read once, at import, so each case runs a fresh interpreter whose only LW_*
    # variables are the overrides. They are read back from http_client, where they are used;
    # LW_MAX_RETRIES=0 is a real setting (no retries), not a value to reject.
    env = {k: v for k, v in os.environ.items() if not k.startswith("LW_")}
    out = subprocess.run(
        [sys.executable, "-c",
         "from lesswrong_mcp import http_client as h; "
         "print(h.HTTP_TIMEOUT, h.HTTP_TOTAL_TIMEOUT, h.MAX_RETRIES, h._CONCURRENCY_LIMIT)"],
        env={**env, **overrides}, cwd=_REPO_ROOT, capture_output=True, text=True, check=True,
    )
    assert out.stdout.split() == expected


# ------------------------------------------------------------------------- #
# config._log_level — LW_LOG_LEVEL, handed to the MCPServer constructor
# ------------------------------------------------------------------------- #

def test_log_level_reads_lw_log_level(caplog):
    assert cfg._log_level({}) == "INFO"
    assert cfg._log_level({"LW_LOG_LEVEL": " warning "}) == "WARNING"
    assert cfg._log_level({"LW_LOG_LEVEL": "DEBUG"}) == "DEBUG"
    # The server's own variable is the only one read.
    assert cfg._log_level({"FASTMCP_LOG_LEVEL": "DEBUG"}) == "INFO"
    with caplog.at_level(logging.WARNING, logger="lesswrong_mcp.config"):
        assert cfg._log_level({"LW_LOG_LEVEL": "loud"}) == "INFO"
    assert len(caplog.records) == 1
    message = caplog.records[0].getMessage()
    assert "LW_LOG_LEVEL" in message and "loud" in message


def test_server_honours_lw_log_level():
    # The SDK reads no environment variable for its log level, so LW_LOG_LEVEL takes effect
    # only because the server passes the value to the constructor.
    env = {**os.environ, "LW_LOG_LEVEL": "WARNING"}
    out = subprocess.run(
        [sys.executable, "-c",
         "import logging, lesswrong_mcp as m; "
         "print(m.mcp.settings.log_level, logging.getLevelName(logging.getLogger().level))"],
        env=env, cwd=_REPO_ROOT, capture_output=True, text=True, check=True,
    )
    assert out.stdout.split() == ["WARNING", "WARNING"]


# ------------------------------------------------------------------------- #
# config.SITE_BASE_URLS — the base URL each `site` choice switches to
# ------------------------------------------------------------------------- #

def test_site_base_urls_cover_exactly_the_site_choices():
    # The HTTP layer indexes this table with the `site` argument, so a choice without an entry
    # would pass argument validation and then fail the call as an unexpected fault; an entry
    # for no choice would still widen the redirect allow-list built from the table.
    assert set(cfg.SITE_BASE_URLS) == set(get_args(cfg.Site))
