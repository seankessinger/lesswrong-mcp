"""W5: the four HTTP tuning knobs (HTTP_TIMEOUT, HTTP_TOTAL_TIMEOUT, MAX_RETRIES,
_CONCURRENCY_LIMIT) read from env via `config._env_num`, which defaults to the current value
when the var is unset/blank and degrades a malformed override to the default rather than
crashing the server at import time.

The parse takes an env mapping explicitly (like `cli._configure_http`), so it's unit-testable
without reimporting the module or mutating os.environ.
"""
from __future__ import annotations

from lesswrong_mcp import config as cfg


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
