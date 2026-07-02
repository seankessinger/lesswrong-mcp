# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **strictly read-only** MCP server exposing **LessWrong** and the **Alignment Forum** as 8
tools. Both sites run the same open-source [ForumMagnum](https://github.com/ForumMagnum/ForumMagnum)
app against one shared database, so a single server covers both by switching the base URL
(`SITE_BASE_URLS`); no auth is needed for reads, and search spans both at once. The forum's
draft-editing POST endpoints are intentionally **not** wrapped — keep it that way.

`FastMCP`, Python ≥3.10, launched via `python -m lesswrong_mcp` or the `lesswrong-mcp`
console script (both call `cli.main()`).

## Commands

```bash
pip install -e '.[dev]'              # pytest + ruff + mypy
pytest                               # hermetic: no network, ~144 tests
pytest tests/test_lw_search.py       # one file
pytest -k slug_hint                  # one test / pattern
LW_LIVE_TESTS=1 pytest               # also runs the 7 opt-in live-network tests
ruff check . && mypy lesswrong_mcp   # must both stay green (separate CI `lint` job)
```

CI (`.github/workflows/ci.yml`) runs `test` and `lint` on the 3.10–3.13 matrix, on pushes to
`main` and on demand — there is no `pull_request` trigger, since work lands directly on `main`.

**CI installs the newest `ruff`/`mypy` every run** (the dev extras carry lower bounds only), so
lint locally against current versions — an old local ruff can pass code that CI rejects.

### Building the bundle

```bash
mkdir -p dist
npx @anthropic-ai/mcpb pack . dist/lesswrong-mcp.mcpb
```

Ships **unsigned** via GitHub Releases (`dist/` is git-ignored). Do **not**
`mcpb sign --self-signed`: mcpb 2.1.2 appends its `MCPB_SIG_V1` PKCS#7 block after the zip's
end-of-central-directory record without declaring it as a zip comment, so strict zip parsers —
including the desktop extension installer — reject the signed file ("Invalid comment length …
extra bytes at the end"). Self-signing also only yields an "unverified publisher" bundle (the
cert is a generic throwaway inside mcpb's own package dir, and `mcpb verify` reports
self-signed as "not signed"), so it buys nothing. Only a CA-issued cert via
`mcpb sign --cert/--key` would be worth it — and even then, confirm the signed file still
installs before publishing.

## Architecture

### Two backends

1. **Markdown REST API** under `/api/*` → 7 tools (`lw_search`, `lw_get_post`,
   `lw_get_comments`, `lw_get_user`, `lw_get_tag`, `lw_get_sequence`, `lw_list_feed`). The site
   advertises these as agent-friendly; responses are already clean Markdown and are returned
   **as-is**. Fetched via `_get_markdown`.
2. **GraphQL** at `/graphql` → only `lw_filter_posts`, for the one thing the Markdown API can't
   do precisely: structured filtering by author + tag + date range + karma with an explicit
   sort. Fetched via `_graphql`, which surfaces GraphQL `errors[]` *before* `raise_for_status`,
   since validation errors arrive as HTTP 400 with a useful body.

### Package layers

Each module imports only from lower layers (leaf → root), behind a re-exporting
[`__init__.py`](lesswrong_mcp/__init__.py) facade:

| Module | Owns |
|---|---|
| [`config.py`](lesswrong_mcp/config.py) | Constants, the six enums, version/`USER_AGENT`, `_env_num`, `_base()`. Pure leaf — imports nothing from the package. |
| [`markdown.py`](lesswrong_mcp/markdown.py) | Pure text/reference helpers: `_handle_error`, `_slug_hint`, `_md_inline`, `_slice_markdown`, `_extract_*_ref`, `_seg`. |
| [`http_client.py`](lesswrong_mcp/http_client.py) | All network I/O + per-loop lifecycle: `_request`, `_get_markdown`, `_graphql`, `_resources`/`_aclose_client`/`_lifespan`, the SSRF guard `_block_offsite_redirect`. |
| [`graphql_resolve.py`](lesswrong_mcp/graphql_resolve.py) | `_resolve_id` / `_resolve_user_id` / `_resolve_tag_id` (slug → `_id`). |
| [`server.py`](lesswrong_mcp/server.py) | The `mcp` singleton (wired to the http_client lifespan), `_READONLY`, `SiteParam`, the `_tool_errors` funnel, `_apply_flat_schemas`. Must **NOT** import `tools`. |
| [`tools.py`](lesswrong_mcp/tools.py) | The 8 `@mcp.tool` handlers + the `/health` route; importing it registers them on `mcp`. |
| [`cli.py`](lesswrong_mcp/cli.py) | `main()` + `_configure_http`; `__main__.py` delegates here. |

`__init__.py` re-exports each name from its home module **and** imports `tools`, so a bare
`import lesswrong_mcp` yields a fully-registered server.

**Callers must reach the network-I/O functions THROUGH `http_client`** (e.g.
`http_client._get_markdown(...)`), never by importing them by value — that indirection is what
the hermetic suite's monkeypatch hooks into (see Tests).

### Shared internals

- **`_request`** — the single choke point for all network I/O. Retries 429/5xx and transient
  transport errors (`MAX_RETRIES`, exponential backoff honouring `Retry-After`), caps
  concurrency with a per-loop semaphore (`_CONCURRENCY_LIMIT`), and enforces a total deadline
  (`HTTP_TOTAL_TIMEOUT`) that httpx alone can't express. A concurrency slot is held only for
  the round-trip, not across backoff sleeps. These four knobs default to `30/60/3/4` and are
  env-overridable (`LW_HTTP_TIMEOUT`, `LW_HTTP_TOTAL_TIMEOUT`, `LW_MAX_RETRIES`,
  `LW_CONCURRENCY`) via `config._env_num`, which falls back to the default on a blank,
  malformed, or non-positive value (`positive=True`) — a `0`/negative retry count or
  concurrency cap would otherwise break every request. `_block_offsite_redirect` refuses any
  redirect off the two allow-listed forum hosts (SSRF guard).
- **`_slice_markdown`** — inline char-slice paging for long bodies; appends a
  `call again with offset=N` footer. Used by `lw_get_post` / `lw_get_comments`.
- **`_resolve_id`** (+ `_resolve_user_id` / `_resolve_tag_id`) — slug→`_id` via GraphQL, falling
  back to a raw 17-char `_id` only if no slug matches (a real slug can *be* 17 alphanumerics, so
  shape alone can't disambiguate). Successful resolutions are memoised in a bounded LRU
  (`_ID_CACHE`, cap `_ID_CACHE_MAX`); misses are never cached.
- **`_extract_*_ref`** — forgivingly reduce a pasted URL/path to the bare id/slug a route expects
  (post/comment/sequence **and** tag/user).
- **`_slug_hint`** — appended to an unresolved author/tag error (and a tag/user 404): when a value
  looks like a display name (a space or uppercase, not a raw `_id`, and not a URL/path — those the
  `_extract_*_ref` helpers already handle) it nudges toward the lowercase-hyphenated slug.
- **`_apply_flat_schemas`** — run once after tool registration (bottom of `tools.py`); rewrites
  each tool's advertised `inputSchema` in place so `Optional`/`Enum` constraints sit at the top
  level (collapse a nullable `anyOf`, inline `$ref` enums) for schema-shallow clients. The
  Pydantic models are untouched and remain the runtime safety net.
- **Error funnel** — the `_tool_errors` decorator wraps each tool so anticipated network/API
  failures become uniform `Error: …` strings via `_handle_error`; unexpected exceptions propagate
  so FastMCP marks the result `isError=True`. `@mcp.tool` must stay the **outermost** decorator
  (`functools.wraps` preserves the real signature/docstring so FastMCP still sees the `Annotated`
  params).

### Backend pagination caps

Two hard limits imposed by the backend, surfaced as fast-failing bounds/guards at the tool
boundary and named as constants in `config.py` (both pinned by binary search against the live
API, 2026-07-02):

- **`MAX_GRAPHQL_SKIP = 2000`** — the GraphQL `posts` selector rejects `skip > 2000` ("Exceeded
  maximum value for skip"). Bounds `lw_filter_posts`' `offset` (`le=MAX_GRAPHQL_SKIP`), so an
  over-limit value fails as a clean Pydantic error instead of an opaque mid-call GraphQL error.
  The cap applies to `offset` itself, not `offset+limit` — which is why `lw_filter_posts` reports
  `has_more` and `depth_limited` separately.
- **`SEARCH_RESULT_WINDOW = 10000`** — the shared search index (Elasticsearch
  `max_result_window`) only serves the first 10,000 results (`from + size ≤ 10000`). `lw_search`'s
  `page` and `limit` are independent, so `page * limit` can exceed it; a pre-flight guard returns
  an actionable error before the network call (a deeper request is a deterministic HTTP 500 that
  would otherwise also burn the retry budget).

## Version

`__version__` derives from `importlib.metadata.version("lesswrong-mcp")`, falling back to a
literal in `config.py` when running from a non-installed source tree; `USER_AGENT` is built from
it, so the UA can't drift from `pyproject.toml`. `manifest.json` is a separate bundle format —
**bump its `version` by hand on release**, alongside `pyproject.toml` and the `config.py`
fallback.

## Tests

9 `test_*.py` files in `tests/`, plus shared scaffolding in
[`tests/conftest.py`](tests/conftest.py). Pytest config lives in `pyproject.toml`'s
`[tool.pytest.ini_options]` (`testpaths` + `pythonpath = ["."]`, so `import lesswrong_mcp`
resolves with or without an install).

Files are grouped by the layer under test, not one-per-tool: `test_config.py` (the two pure
env → value helpers), `test_http_client.py` (`_request`, `_get_markdown`, the SSRF guard, the
loop lifecycle), `test_markdown_helpers.py` (the pure helpers + the `_tool_errors` funnel), and
`test_tools_read.py` (the five straight-through Markdown-API tools). The three tools with
substantial logic of their own — `lw_get_post`, `lw_search`, `lw_filter_posts` — plus
`test_graphql.py` and `test_tool_schema.py` keep their own files. Section banners inside each
merged file mark the original groupings.

Keep new tests **hermetic**. `conftest.py` provides the `run` fixture (there is no
pytest-asyncio — it just wraps `asyncio.run`), the monkeypatch seams `patch_io` / `patch_sleep`
/ `markdown_stub`, and an autouse `_clear_id_cache` fixture that resets the slug→`_id` cache
around every test. All the seams key off **`IO_HOME`** — the module owning the patched
network-I/O functions (currently `lesswrong_mcp.http_client`). Patch through those fixtures, not
a bare `monkeypatch.setattr(m, …)`, and add no live network unless gated on `LW_LIVE_TESTS=1`.
If the I/O layer ever moves modules, repoint `IO_HOME` alone.

## Lint / type-check

`ruff check .` and `mypy lesswrong_mcp` (non-strict, `ignore_missing_imports`) must stay green.

`[tool.ruff.lint] select` is pinned to `["E4", "E7", "E9", "F"]` **deliberately** — do not drop
it to inherit ruff's defaults. Ruff 0.16 widened its default selection to ~400 rules, which
switches on checks this repo rejects on purpose:

- **`I` (import ordering)** — the import blocks are grouped by meaning, not alphabetised.
- **`TRY004`** — a false positive on the intentional `RuntimeError` in `http_client._graphql`,
  which must stay a `RuntimeError` to reach the `_tool_errors` funnel.
- **`E501`** — the tool docstrings and `Field` descriptions are intentionally long single lines,
  so `line-length` is set for a formatter's benefit but not enforced as a lint error.

`__init__.py` is `F401`-exempt as a re-export facade.

## Bundle manifest gotcha

**`manifest.json`'s `display_name` must never contain a `/`.** Claude Desktop builds a
per-server log path from that string (`~/Library/Logs/Claude/mcp-server-<display_name>.log`),
so a slash used to silently split it into a directory (the leftover proof on this machine:
`~/Library/Logs/Claude/mcp-server-LessWrong /` containing ` Alignment Forum.log`). Since app
1.24012.9 a path-escape guard rejects it outright:

```
[MCP] Could not connect to MCP server LessWrong / Alignment Forum
  Error invoking remote method 'connect-to-mcp-server': Error: path escape: "LessWrong / Alignment Forum"
```

The tell is that `main.log` reports a healthy `Connected to … (8 tools)` and the uv child is
alive — Claude Code sessions work fine — while only the renderer's `connect-to-mcp-server` IPC
(the Desktop chat UI) throws, so the symptom is "chat says disconnected while the server is
demonstrably healthy" and reinstalling never helps. The real error appears only in
`~/Library/Logs/Claude/claude.ai-web.log`, not `main.log`. Hence `display_name` is
`LessWrong & Alignment Forum` — keep the `&`.

Note this is a *different* failure from a `type: uv` extension not finding `uv` on the bare GUI
launchd PATH, which is the other common "Could not connect" cause; check which one before acting.

## Conventions when editing

- Keep every tool **read-only**; keep `@mcp.tool` the outermost decorator.
- Never put a `/` in `manifest.json`'s `display_name` (see Bundle manifest gotcha).
- Reach network I/O through `http_client`; keep the layer ordering (leaf → root) intact.
- New hermetic tests only.
- **Git workflow**: work directly on `main` with ordinary checkpoint commits, then squash into
  one commit — no feature branches, no PRs. The `v1.0.0` release tag tracks the tip; after a
  squash, force-move it (`git tag -f v1.0.0 && git push -f origin v1.0.0`) so the release and
  `main` don't diverge.
