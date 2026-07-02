"""Tests for lw_get_sequence and the shared reference extraction it uses.

Hermetic: `_get_markdown` is stubbed via the shared `markdown_stub` fixture (see conftest);
nothing hits the network.
"""
from __future__ import annotations

import lesswrong_mcp as m
from lesswrong_mcp import Site

SEQ_ID = "r9tYkB2a8Fp4DN8yB"
SEQ_MD = "# Sequence: Risks from Learned Optimization\n\n*   Posts: 5\n"


def test_ref_extraction_forms():
    # A bare id, a full /s/<id> URL, and an /api/sequence/<id> path all reduce to the id.
    assert m._extract_sequence_ref(SEQ_ID) == SEQ_ID
    assert m._extract_sequence_ref(f"https://www.lesswrong.com/s/{SEQ_ID}") == SEQ_ID
    assert m._extract_sequence_ref(f"/api/sequence/{SEQ_ID}") == SEQ_ID
    assert m._extract_sequence_ref(f"/s/{SEQ_ID}/some-slug") == SEQ_ID


def test_get_sequence_fetches_sequence_route(markdown_stub, run):
    captured = markdown_stub(SEQ_MD)
    out = run(m.lw_get_sequence(f"https://www.lesswrong.com/s/{SEQ_ID}", site=Site.lesswrong))
    assert out == SEQ_MD
    assert captured["path"] == f"/api/sequence/{SEQ_ID}"
    assert captured["site"] == "lesswrong"
