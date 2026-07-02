"""Characterization tests for `_md_inline` — the single-line label/link escaper used when
lw_filter_posts builds its Markdown, so titles like '[AN #80] ...' or ones with newlines
can't break the generated links. Pure; pins the escaping before it moves to markdown.py.
"""
from __future__ import annotations

import lesswrong_mcp as m


def test_md_inline_collapses_whitespace_and_escapes_brackets():
    assert m._md_inline("[AN #80] Foo\nbar") == r"\[AN #80\] Foo bar"


def test_md_inline_escapes_backslash_before_brackets():
    # Backslash is escaped first, so the escaped brackets aren't double-escaped.
    assert m._md_inline(r"a\b [c]") == r"a\\b \[c\]"


def test_md_inline_none_and_blank_and_runs():
    assert m._md_inline(None) == ""
    assert m._md_inline("   ") == ""
    assert m._md_inline("  multiple   spaces  ") == "multiple spaces"


def test_seg_encodes_a_single_path_segment():
    assert m._seg("cleo nardo") == "cleo%20nardo"              # space escaped
    assert m._seg("a/b") == "a%2Fb"                            # slash escaped, can't add a segment
    assert m._seg("RuGZ5tMdqpnraJahJ") == "RuGZ5tMdqpnraJahJ"  # bare id untouched
