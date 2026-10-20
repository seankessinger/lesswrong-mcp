# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A strictly read-only MCP server for **LessWrong** and the **Alignment Forum**, which are one
[ForumMagnum](https://github.com/ForumMagnum/ForumMagnum) deployment, so one server reads both.
It ships as a Claude Desktop extension (`.mcpb`) and runs over stdio (`python -m lesswrong_mcp`,
or the `lesswrong-mcp` script). Five tools:

- `lw_search`: search posts, comments, tags, users and sequences, with sort, date, Alignment
  Forum and one-discussion filters
- `lw_get_post`: read a post, as the forum's own Markdown
- `lw_get_comments`: read a post's whole discussion, answers first on question posts, or one
  comment
- `lw_filter_posts`: list posts by author, tag, date and karma, or a post's backlinks
- `lw_get_sequence`: read a series in order

## Commands

```bash
pip install -e '.[dev]'                 # pytest, ruff, mypy; tests run against the installed package
pytest                                  # hermetic: no network
LW_LIVE_TESTS=1 pytest -m live          # the opt-in live tests, one call per forum route and view
ruff check . && mypy lesswrong_mcp      # both must stay green
npx @anthropic-ai/mcpb@2.1.2 pack . dist/lesswrong-mcp.mcpb   # the bundle
```

CI tests two corners: Python 3.11 with the lowest dependency versions the ranges allow, and the
newest Python with the newest. Reproduce the low corner before relying on a dependency floor:

```bash
uv venv -p 3.11 <dir>
uv pip install --python <dir> --resolution lowest-direct -e '.[dev]'
<dir>/bin/pytest -q
```

## Architecture

Four modules:

| Module | Owns |
|---|---|
| `forum.py` | All network I/O: one pooled httpx client per event loop, retries on 429/5xx and transport errors (honouring `Retry-After` up to 60s), a concurrency cap of 4, and a redirect guard (https on the two forum hosts only). It has `markdown()`, `graphql()`, `search()` and `close()`, and `ForumError`. |
| `render.py` | Pure renderers, forum JSON to Markdown: listing rows, search hits, threads, sequences, slicing. No I/O. |
| `server.py` | The `MCPServer`, its instructions, the identifier types with per-kind advice (`FIND`, `SHAPE`, `miss`), the error funnel, and `@tool`, the only way a tool is registered. |
| `tools.py` | The five tools, each doing check input → fetch through `forum` → render. |

Import order: `tools` → `server`, `forum`, `render`; `server` → `forum`; `forum` and `render`
import nothing from the package. Only `__main__` and `__init__` import `tools`.

Backends:
- **Markdown API:** `lw_get_post` returns the forum's Markdown as-is.
- **GraphQL:** threads, listings, backlinks and sequences.
- **`POST /api/search`:** search.

## Conventions

- **Read-only.** GET, `POST /api/search` and GraphQL queries only. Never wrap the draft-editing
  or feedback endpoints.
- **Bare identifiers, no guessing.** Posts, comments and sequences are taken by their
  17-character `_id`, users and tags by slug, each checked by a pattern before any request. A
  miss explains where the value comes from (`FIND`). Never reduce a link, or derive a slug from
  a display name.
- **Rendered output links what it mentions by the value the tools take,** names users
  `Name (slug)`, and marks Alignment Forum items `AF`.
- **Network through `forum`.** Tools call `forum.graphql(...)`, never an imported copy, so the
  tests fake the transport in one place (`fake_forum` in `tests/conftest.py`).
- **Every GraphQL view has a live test.** The schema is internal and unversioned.
  Single-document lookups pass `allowNull: true`; without it an unknown id is a GraphQL error.
- **Tests stay hermetic.** The autouse `_offline` guard fails any unmocked network call; live
  tests are marked `live`. Fixtures are hand-written: no forum text, and nothing from the
  private eval, goes in this repo.
- **Version** is in `pyproject.toml` and `manifest.json` only; `test_package.py` checks they
  match, and that the manifest's tool list matches the registered tools.

## Gotchas

- `manifest.json`'s `display_name` must never contain a `/`. Desktop builds a log path from it
  and then refuses to connect. README's Troubleshooting has both Desktop "Could not connect"
  diagnoses.
- Ship the `.mcpb` **unsigned**. `mcpb sign` appends bytes that strict zip parsers, the Desktop
  installer among them, reject.

## Releases

- **Work:** directly on `main`, in local checkpoint commits, squashed into one commit per
  release on top of the previous one. SemVer, with a `vX.Y.Z` tag per release.
- **Release steps:**
  1. bump both version fields
  2. push the release commit
  3. wait for green CI, plus one dispatched `live` run
  4. tag
  5. publish a GitHub Release with `dist/lesswrong-mcp.mcpb` attached under exactly that name
     (README's latest-download link relies on it)
