# CLAUDE.md — lesswrong-mcp

Guidance for Claude Code working in this repo. Read this first; it captures the
architecture, the two backends, the test command, and the backend caps that aren't
obvious from any single function.

## What this is

A read-only MCP server exposing **LessWrong** and the **Alignment Forum** as tools. Both
sites are the same open-source [ForumMagnum](https://github.com/ForumMagnum/ForumMagnum)
app sharing one database, so a single server covers both by switching the base URL
(`SITE_BASE_URLS`). No auth is needed for reads. Everything is **strictly read-only** —
the forum's draft-editing POST endpoints are intentionally not wrapped.

## Layout

The server is a small package — [`lesswrong_mcp/`](lesswrong_mcp), `FastMCP`, Python ≥3.10,
8 tools, launched via `python -m lesswrong_mcp`. It was split from a single module into
focused submodules, each importing only from lower layers (leaf → root), behind a
re-exporting [`__init__.py`](lesswrong_mcp/__init__.py) facade:

- [`config.py`](lesswrong_mcp/config.py) — constants, the six enums, version/`USER_AGENT`,
  `_base()`. Pure leaf; imports nothing from the package.
- [`markdown.py`](lesswrong_mcp/markdown.py) — pure text/reference helpers: `_handle_error`,
  `_md_inline`, `_slice_markdown`, `_extract_*_ref`, `_seg`.
- [`http_client.py`](lesswrong_mcp/http_client.py) — all network I/O + per-loop lifecycle:
  `_request`, `_get_markdown`, `_graphql`, `_resources`/`_aclose_client`/`_lifespan`, the SSRF
  guard `_block_offsite_redirect`.
- [`graphql_resolve.py`](lesswrong_mcp/graphql_resolve.py) — `_resolve_id` /
  `_resolve_user_id` / `_resolve_tag_id` (slug → _id).
- [`server.py`](lesswrong_mcp/server.py) — the `mcp` singleton (wired to the http_client
  lifespan), `_READONLY`, `SiteParam`, the `_tool_errors` funnel. Must NOT import `tools`.
- [`tools.py`](lesswrong_mcp/tools.py) — the 8 `@mcp.tool` handlers + the `/health` route;
  importing it registers them on `mcp`.
- [`cli.py`](lesswrong_mcp/cli.py) — `main()` + `_configure_http`; `__main__.py` delegates here.

`__init__.py` re-exports each name from its home module and imports `tools` (so a bare
`import lesswrong_mcp` yields a fully-registered server). Callers reach the network-I/O
functions THROUGH `http_client` (e.g. `http_client._get_markdown(...)`) so the hermetic
suite's monkeypatch is seen (see Tests). Supporting files: `pyproject.toml` /
`requirements.txt` (deps), `manifest.json` (`.mcpb` bundle metadata), `Dockerfile` (remote
HTTP deploy), `tests/` (hermetic `test_*.py` suite + shared `conftest.py`),
`.github/workflows/ci.yml` (CI).

## The two backends

1. **Markdown REST API** under `/api/*` → 7 tools (`lw_search`, `lw_get_post`,
   `lw_get_comments`, `lw_get_user`, `lw_get_tag`, `lw_get_sequence`, `lw_list_feed`).
   The site advertises these as agent-friendly; responses are already clean Markdown and
   are returned **as-is**. Fetched via `_get_markdown`.
2. **GraphQL** at `/graphql` → only `lw_filter_posts`, for the one thing the Markdown API
   can't do precisely: structured filtering by author + tag + date range + karma with an
   explicit sort. Fetched via `_graphql` (which surfaces GraphQL `errors[]` before
   `raise_for_status`, since validation errors come back as HTTP 400 with a useful body).

## Shared internals

- **`_request`** — the single choke point for all network I/O. Retries 429/5xx and
  transient transport errors (`MAX_RETRIES`, exp backoff honouring `Retry-After`), caps
  concurrency with a per-loop semaphore (`_CONCURRENCY_LIMIT`), and enforces a total
  deadline (`HTTP_TOTAL_TIMEOUT`) that httpx alone can't. These four knobs default to
  `30/60/3/4` but are env-overridable (`LW_HTTP_TIMEOUT`, `LW_HTTP_TOTAL_TIMEOUT`,
  `LW_MAX_RETRIES`, `LW_CONCURRENCY`) via `config._env_num`, which falls back to the default
  on a blank, malformed, or non-positive value (`positive=True`) — a `0`/negative retry count
  or concurrency cap would otherwise break every request. An SSRF guard
  (`_block_offsite_redirect`) refuses any redirect off the two allow-listed forum hosts.
- **`_slice_markdown`** — inline char-slice paging for long bodies; appends a
  `call again with offset=N` footer. Used by `lw_get_post` / `lw_get_comments`.
- **`_resolve_id`** (+ `_resolve_user_id` / `_resolve_tag_id`) — slug→_id via GraphQL,
  falling back to a raw 17-char `_id` only if no slug matches. Successful resolutions are
  memoised in a bounded LRU (`_ID_CACHE`, cap `_ID_CACHE_MAX`); the hermetic suite clears it
  via an autouse `conftest` fixture so a cached hit never leaks across tests.
- **`_extract_*_ref`** — forgivingly reduce a pasted URL / path to the bare id/slug a
  route expects (post/comment/sequence **and** tag/user).
- **`_slug_hint`** — appended to an unresolved author/tag error (and a tag/user 404): when a
  value looks like a display name (a space or uppercase, not a raw `_id`, and not a URL/path —
  those the `_extract_*_ref` helpers already handle) it nudges toward the lowercase-hyphenated
  slug, deriving the example from the value.
- **`_apply_flat_schemas`** (server) — run once after tool registration (bottom of
  `tools.py`); rewrites each tool's advertised `inputSchema` in place so `Optional`/`Enum`
  constraints sit at the top level (collapse a nullable `anyOf`, inline `$ref` enums) for
  schema-shallow clients. The Pydantic models are untouched and remain the runtime safety net.
- **Error funnel** — the `_tool_errors` decorator wraps each tool so anticipated
  network/API failures become uniform `Error: …` strings via `_handle_error`; unexpected
  exceptions propagate so FastMCP marks the result `isError=True`. `@mcp.tool` must stay
  the **outermost** decorator (`functools.wraps` preserves the real signature/docstring so
  FastMCP still sees the `Annotated` params).

## Backend pagination caps (measured against the live API)

Two hard limits are imposed by the backend and surfaced as fast-failing bounds/guards at
the tool boundary, named as constants in `config.py`:

- **`MAX_GRAPHQL_SKIP = 2000`** — the GraphQL `posts` selector rejects `skip > 2000`
  (`Exceeded maximum value for skip`). It bounds `lw_filter_posts`' `offset`
  (`le=MAX_GRAPHQL_SKIP`), so an over-limit value fails as a clean Pydantic error instead
  of an opaque mid-call GraphQL error.
- **`SEARCH_RESULT_WINDOW = 10000`** — the shared search index (Elasticsearch
  `max_result_window`) only serves the first 10,000 results (`from + size ≤ 10000`).
  `lw_search`'s `page` and `limit` are independent, so `page * limit` can exceed it;
  a pre-flight guard returns an actionable error before the network call (a deeper request
  is a deterministic HTTP 500 that would otherwise also burn the retry budget).

## Version

`__version__` derives from `importlib.metadata.version("lesswrong-mcp")` (falling back to
a literal from source), and `USER_AGENT` is built from it — so the UA can't drift from
`pyproject.toml`. `manifest.json` is a separate bundle format; **bump it by hand on
release** alongside `pyproject.toml`.

## Tests

```bash
pip install -e '.[dev]'   # pytest + ruff + mypy; the suite drives async handlers with asyncio.run
pytest                    # hermetic: monkeypatches _get_markdown / _graphql, no network
LW_LIVE_TESTS=1 pytest    # also runs the one opt-in live-endpoint test
ruff check . && mypy lesswrong_mcp   # lint + type-check (a separate CI `lint` job runs both)
```

Tests live in `tests/` (pytest config in `pyproject.toml`'s `[tool.pytest.ini_options]`
sets `testpaths` + `pythonpath = ["."]`, so `import lesswrong_mcp` resolves with or without
an install). Shared scaffolding is in [`tests/conftest.py`](tests/conftest.py): the `run`
fixture (there is no pytest-asyncio — it just wraps `asyncio.run`), the monkeypatch seams
`patch_io` / `patch_sleep` / `markdown_stub`, all keyed off `IO_HOME` — the module that owns
the patched network-I/O functions (currently `lesswrong_mcp.http_client`) — and an autouse
`_clear_id_cache` fixture that resets the slug→_id resolution cache around every test. Keep
new tests **hermetic**: patch through those fixtures (not a bare `monkeypatch.setattr(m, …)`),
and no live network unless `LW_LIVE_TESTS=1`. Because callers reach I/O through `http_client`,
a patch on `IO_HOME` intercepts them; if that layer ever moves modules, repoint `IO_HOME` alone.

Lint/type-check bar: `ruff check .` (default rules; import-order and line-length off — the
Field descriptions are intentionally long; `__init__.py` is `F401`-exempt as a re-export
facade) and `mypy lesswrong_mcp` (non-strict, `ignore_missing_imports`) must stay green.

## Building the bundle

```bash
mkdir -p dist
npx @anthropic-ai/mcpb pack . dist/lesswrong-mcp.mcpb
```

The `.mcpb` ships **unsigned** via GitHub Releases (`dist/` is git-ignored). Do **not**
`mcpb sign --self-signed` it: mcpb 2.1.2 appends the `MCPB_SIG_V1` PKCS#7 block after the
zip's end-of-central-directory record without declaring it as a zip comment, so strict zip
parsers — including the desktop extension installer — reject the signed file ("Invalid
comment length … extra bytes at the end", i.e. the ~2264-byte signature is undeclared
trailing data). Self-signing also only yields an "unverified publisher" bundle (its cert is
a generic throwaway inside mcpb's own package dir, and `mcpb verify` reports self-signed as
"not signed"), so it buys nothing. Only a CA-issued cert via `mcpb sign --cert/--key` would
be worth it — and even then, confirm the signed file still installs before publishing.

## Conventions when editing

- Keep every tool **read-only**; keep `@mcp.tool` the outermost decorator.
- New hermetic tests only (see above).
- **Git workflow**: work directly on `main` with ordinary checkpoint commits, then squash
  into one commit — no feature branches, no PRs. The `v1.0.0` release tag tracks the tip;
  after a squash, force-move it (`git tag -f v1.0.0 && git push -f origin v1.0.0`) so the
  release and `main` don't diverge.
