# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this is

A **strictly read-only** MCP server exposing **LessWrong** and the **Alignment Forum** as 8
tools. Both sites run the same open-source [ForumMagnum](https://github.com/ForumMagnum/ForumMagnum)
app against one shared database, so a single server covers both by switching the base URL
(`SITE_BASE_URLS`); no auth is needed for reads, and search spans both at once. The forum's
draft-editing POST endpoints are intentionally **not** wrapped — keep it that way.

`MCPServer` (MCP Python SDK 2.x), Python ≥3.11, launched via `python -m lesswrong_mcp` or the
`lesswrong-mcp` console script (both call `cli.main()`, which serves stdio, the only transport:
the server ships as a Claude Desktop extension, and Claude Code and other stdio clients run the
same one). It speaks both protocol eras: the 2025-11-25 `initialize` handshake and the
2026-07-28 per-request path.

## Commands

```bash
pip install -e '.[dev]'              # pytest + ruff + mypy
pytest                               # hermetic: no network
pytest tests/test_lw_search.py       # one file
pytest -k 404                        # one test / pattern
LW_LIVE_TESTS=1 pytest -m live       # just the 19 opt-in live-network tests
ruff check . && mypy lesswrong_mcp   # must both stay green (separate CI `lint` job)
```

CI (`.github/workflows/ci.yml`) runs four jobs on every push to `main`, dispatch and weekly run
(Mondays 06:17 UTC), plus a fifth, `live`, which runs the opt-in live tests on the weekly
schedule and on demand only, so a push never depends on the forum. There is no `pull_request`
trigger, since work lands directly on `main`. The weekly run exists because nothing is locked:
every install resolves the newest dependencies in the declared ranges, so between releases a new
`mcp` minor or a forum API change would otherwise go untested. GitHub disables a repository's
schedules after 60 days without activity; re-enable them in the Actions tab. Each job gets a
read-only token and a 10-minute timeout, and a newer run of the same kind (push, dispatch or
schedule) cancels one still in progress on the same branch, so a push never cancels, or is
cancelled by, a run that carries `live`. `test` runs the suite on the 3.11–3.15 matrix, which
ends at the newest CPython because that is the one uv downloads for a Claude Desktop user with
no compatible Python. `lint` runs once, on 3.11: ruff and mypy take their target version from
`pyproject.toml` (`target-version = "py311"`, `python_version = "3.11"`), not from the
interpreter, so a matrix would repeat one check. `bundle` validates and packs the `.mcpb` (see
"Building the bundle"). `test` and `lint` resolve the newest dependencies, so `test-lowest`
keeps the declared floors honest: on Python 3.11 it resolves each direct dependency to the
lowest version the whole set allows (`uv pip install --resolution lowest-direct -e '.[dev]'`)
and runs the suite, which puts `mcp`, `httpx` and `pydantic` each on the floor
`[project].dependencies` declares. The pydantic floor is `mcp`'s own. Reproduce the job locally
before raising or relying on a floor:

```bash
uv venv -p 3.11 <dir>
uv pip install --python <dir> --resolution lowest-direct -e '.[dev]'
<dir>/bin/pytest -q
```

The `mcp` floor is load-bearing: it is the oldest release that honours
`MCPServer(subscriptions=False)` on the 2026-07-28 era (no `listChanged`/`subscribe`) and sends
no empty `experimental` capability on the 2025-11-25 one, which
`test_capabilities_advertise_a_fixed_tool_set` pins, and it clears every published 2.x
advisory. `[project].dependencies` is the only dependency list.

**CI installs the newest `ruff`/`mypy` every run** (the dev extras carry lower bounds only), so
lint locally against current versions — an old local ruff can pass code that CI rejects.

### Building the bundle

```bash
mkdir -p dist
npx @anthropic-ai/mcpb@2.1.2 pack . dist/lesswrong-mcp.mcpb
```

The mcpb version is pinned to the one CI's `bundle` job runs (its `MCPB` env), and README's
build command pins it too; bump all three together (`test_packaging.py` fails while README's or
this file's pin differs from CI's). That job validates `manifest.json`, packs the bundle the same
way, and fails unless the archive holds exactly the tracked `LICENSE`, `manifest.json`,
`pyproject.toml` and `lesswrong_mcp/` files, the manifest's `entry_point` among them: `mcpb pack`
itself exits 0 when `.mcpbignore` drops the package or `entry_point` names a missing file.

`.mcpbignore` is an allowlist: the bundle holds `manifest.json`, `pyproject.toml`, `LICENSE`
and `lesswrong_mcp/`, so a stray file in the checkout never ships. A new file the bundle needs
at run time goes on that list and also into the `bundle` job's `git ls-files` list.

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
   since validation errors arrive as HTTP 400 with a useful body. Every distinct tag costs one
   slug-resolution round-trip, so its `tags` array is deduplicated before any lookup, and its
   argument model bounds the array to 1–`MAX_TAG_FILTERS` (10) items. The argument model takes
   a date only as `YYYY-MM-DD` (`_iso_date`: no Unix timestamp, partial date or datetime) and
   rejects an impossible one, and the in-body input check (the date order) runs before the
   first network call.

### Package layers

Each module imports only from lower layers (leaf → root), behind an
[`__init__.py`](lesswrong_mcp/__init__.py) that exports the public surface:

| Module | Owns |
|---|---|
| [`config.py`](lesswrong_mcp/config.py) | Constants, the six `Literal` choice types (`Site`, `PostSort`, …), `SITE_BASE_URLS` (keyed by `Site`), version/`USER_AGENT`, `_env_num` (+ its `_positive`/`_non_negative` predicates), `LOG_LEVEL`. Pure leaf — imports nothing from the package. |
| [`markdown.py`](lesswrong_mcp/markdown.py) | Pure text helpers: `_md_inline`, `_slice_markdown`. Imports nothing from the package. |
| [`errors.py`](lesswrong_mcp/errors.py) | `ForumAPIError` (an anticipated forum/API failure: GraphQL `errors[]`, a malformed GraphQL body, a refused redirect), `_handle_error`, the user-facing message for each anticipated failure, and the advice every lookup miss carries (`Kind`, `FIND`, `SHAPE`). |
| [`http_client.py`](lesswrong_mcp/http_client.py) | All network I/O + per-loop lifecycle: `_request` (+ `_backoff`), `_get_markdown`, `_graphql`, `_resources`/`_aclose_client`, the SSRF guard `_block_offsite_redirect` and its `_ALLOWED_HOSTS`. |
| [`graphql_resolve.py`](lesswrong_mcp/graphql_resolve.py) | `_resolve_id` / `_resolve_user_id` / `_resolve_tag_id` (slug → `_id`). |
| [`server.py`](lesswrong_mcp/server.py) | `LessWrongServer` and the `mcp` singleton built from it (with `_INSTRUCTIONS`, `config.LOG_LEVEL`, the package version, `_lifespan` and no subscriptions), `_READONLY`, the shared parameter aliases (`SiteParam`, `MaxCharsParam`, `OffsetParam`, and the identifier types `PostRef`, `CommentRef`, `UserRef`, `TagRef`, `SequenceRef` and `TagsParam`, each checked against `_REF` with `_shape_error` swapping a pattern miss for its kind's `SHAPE` text), the `_tool_errors` funnel, `_flatten_parameters`, and `lw_tool`, the one tool-registration helper. Must **NOT** import `tools`. |
| [`tools.py`](lesswrong_mcp/tools.py) | The 8 `@lw_tool` handlers; importing it registers them on `mcp`. `lw_get_comments` fetches one comment through `_get_comment`. `lw_filter_posts` only orchestrates (input checks, slug resolution, the request; its dates go through `_iso_date`); the pure pieces kept beside it build the selector (`_posts_selector`, sent with `_POSTS_QUERY`), work out the paging signal (`_page_signal`, a `_Page`) and shape and render the rows (`_post_row`, `_render_posts`, which links each author through `_author_md`). |
| [`cli.py`](lesswrong_mcp/cli.py) | `main()`, which serves stdio with `mcp.run()` until the client closes stdin; `__main__.py` delegates here. |

`__init__.py` exports only the public surface (`__all__`: `__version__`, the six choice types,
`mcp`, the 8 tools, `main`). Importing the tools from `tools` registers them, so a bare
`import lesswrong_mcp` yields a fully-registered server. Everything else is imported from its
home module.

**Callers must reach the network-I/O functions THROUGH `http_client`** (e.g.
`http_client._get_markdown(...)`), never by importing them by value — that indirection is what
the hermetic suite's monkeypatch hooks into (see Tests).

### Shared internals

- **`_request`** — the single choke point for all network I/O. Retries the statuses in
  `_RETRYABLE_STATUS` (429, 500, 502, 503, 504) and transient transport errors up to
  `MAX_RETRIES` times after the first attempt, sleeping the forum's
  `Retry-After` as given or else `_backoff(attempt)` (capped exponential with jitter, so
  concurrent calls don't retry in lockstep). A `Retry-After` above `_MAX_RETRY_AFTER` (60s)
  stops retrying and returns that response: retrying sooner would land inside the window the
  forum asked to be left alone. It caps concurrency with a per-loop semaphore
  (`_CONCURRENCY_LIMIT`) and enforces a per-attempt round-trip deadline (`HTTP_TOTAL_TIMEOUT`)
  that httpx alone can't express — per attempt, not across retries, so backoff and
  `Retry-After` sleeps can stretch one call past it, deliberately: politeness to the forum wins
  over latency. A concurrency slot is held only for the round-trip, not across backoff sleeps,
  and `_resources()` is fetched per attempt. Each retry, give-up and over-cap `Retry-After` is
  logged at WARNING on `lesswrong_mcp.http_client` with the URL path only (never the query
  string, which carries search text); importing `http_client` also raises the `httpx` logger
  to WARNING, since httpx logs each full request URL at INFO. These four knobs default to
  `30/60/2/4` and are env-overridable (`LW_HTTP_TIMEOUT`, `LW_HTTP_TOTAL_TIMEOUT`,
  `LW_MAX_RETRIES`, `LW_CONCURRENCY`) via `config._env_num`, which falls back to the default on
  a blank, malformed, or rejected value and logs a WARNING for any value that was set. The
  timeouts and concurrency take `valid=_positive` (finite and > 0: a NaN deadline expires at
  once, `Semaphore(0)` deadlocks); `LW_MAX_RETRIES` takes `_non_negative`, so `0` disables
  retries. `config._log_level` reads `LW_LOG_LEVEL` into `config.LOG_LEVEL` (INFO, with a
  WARNING, for an unknown value), which `server.py` hands to the `MCPServer` constructor: the
  SDK reads no environment variable for its log level.
- **Client lifecycle** — `_resources()` creates the pooled client and semaphore lazily per event
  loop and replaces a client found closed (keeping the semaphore). The server's lifespan
  (`server._lifespan`) closes it with `_aclose_client()` in a `finally` when serving stops.
  MCPServer enters the lifespan once per `mcp.run()` (the stdio session) and once per
  in-process client connection, so each test's `Client` closes the client its loop opened. Two
  in-process clients open at once on one loop would share that client, and the first to exit
  would close it under the other; the stdio server `cli` runs never does that.
- **`_block_offsite_redirect`** — the SSRF guard, a response hook httpx runs before following
  each redirect hop. It refuses any target that isn't `https` on one of the two allow-listed
  forum hosts at the default port (a plaintext hop would let an on-path attacker rewrite the
  Markdown the model reads), comparing hosts as httpx's normalised raw bytes so a host that
  isn't valid IDNA is refused rather than raised, and turns a Location that won't parse into a
  `ForumAPIError` rather than a raw `httpx.InvalidURL`.
- **`_slice_markdown`** — inline char-slice paging for long bodies; appends a
  `call again with offset=N` footer naming the calling tool (its required `label`), and an
  offset past the end is a `ToolError`. Used by `lw_get_post` / `lw_get_comments`, whose
  `max_chars` defaults to `MAX_CHARS` (40,000) and accepts nothing larger (and no `null`): a host
  spills a bigger tool result to a file and shows the model only a preview (Claude Code does past
  50,000 characters), and a model handed a preview of a long post can summarise it without
  reading it. A long body is read by following the footer's offset instead.
- **`_resolve_id`** (+ `_resolve_user_id` / `_resolve_tag_id`) — slug → `_id` via GraphQL. The
  value is looked up as a slug and as nothing else, so a slug that matches nothing (a document
  `_id` among them) is `None`. Successful resolutions are memoised in a bounded LRU (`_ID_CACHE`,
  cap `_ID_CACHE_MAX`); misses are never cached.
- **Identifier parameters** — every id or slug a tool takes is a bare value: `PostRef`,
  `CommentRef`, `UserRef`, `TagRef` and `SequenceRef` in `server.py` each carry
  `Field(pattern=_REF, max_length=300)` with `_REF = ^[A-Za-z0-9_-]+$`, and `TagsParam` is a list
  of one to `MAX_TAG_FILTERS` `TagRef`s. ForumMagnum `_id`s are 17 alphanumerics, and every post,
  author and tag slug checked live on 2026-10-17 fits the pattern (only user slugs use `_`), so a
  link, a path or a display name is refused; nothing is reduced or guessed. The schema advertises
  the pattern and MCPServer's argument model refuses a miss before the tool body runs;
  `_shape_error(kind)` swaps pydantic's regex text for that kind's `SHAPE` text (a length or type
  error keeps pydantic's own wording). Nothing the pattern accepts holds `/`, `.`, `?`, `#`, `%`,
  whitespace or a newline, so a value goes into its route as given (`f"/api/post/{id_or_slug}"`),
  with no escaping step. Validation happens at the MCP boundary, so a test refuses a value
  through `call_tool`: a direct call of the coroutine skips it.
- **`FIND` / `SHAPE`** — the advice on where each kind of identifier (`Kind`: post, comment,
  user, tag, sequence) comes from, written once. `FIND[kind]` is one sentence naming the search
  or link that shows the value; `SHAPE[kind]` is that kind's lead on what a bare value looks
  like, a space, then `FIND[kind]`. Every miss message ends with `FIND[kind]`: a 404 from a
  lookup tool (`no <kind> found for '<value>' (404). Pass a <what>. <FIND>`, which
  `_handle_error` builds from `not_found` and `bad_value`, the latter taken by the funnel from
  the tool's `id_param` argument), a value that misses the identifier pattern, and an unresolved
  `lw_filter_posts` author or tag. Only `_get_comment`'s two messages for a comment the forum
  doesn't have (a 404 and a bare 500) carry their own text, which names the post and the comment
  `_id`. Nothing is guessed from the value: a user slug comes from the username, not the display
  name, and popular names are held by several accounts (`scott-alexander` is not Scott
  Alexander's main account, `scottalexander` is), so a slug derived from a name can name the
  wrong person. The user and tag advice point to `lw_search` with `content_type='users'` or
  `'tags'` instead, whose results link the real slug. A slug that names another real account
  resolves, though, so no miss fires: `lw_get_user`'s `slug` and `lw_filter_posts`' `author`
  descriptions therefore say up front that a user slug often differs from the display name and
  where to find it. Neither table may contain `{` or `}`, so `SHAPE` can serve as a pydantic
  message template.
- **`lw_tool`** — the only way a tool is registered (`@lw_tool(name, title, not_found=…,
  id_param=…)`). It wraps the coroutine in the `_tool_errors` funnel *before* registering it
  (MCPServer registers exactly the callable it is handed) and registers it through the public
  `mcp.tool(...)` with the read-only annotations, the docstring through `inspect.cleandoc` as its
  description (identical on every Python: 3.13+ dedents docstrings when compiling them, earlier
  versions keep the source indentation), and `structured_output=False` (the tools return
  Markdown text, so MCPServer's auto `{result: str}` structuredContent would only duplicate it).
- **`LessWrongServer`** — the `MCPServer` subclass `mcp` is built from. It closes and flattens the
  tool surface through the two public methods the protocol handlers call, on both eras, for a
  stdio client and an in-process one alike. `list_tools` advertises each schema through
  `_flatten_parameters`. `call_tool` refuses any argument the tool's schema does not declare,
  before validation: MCPServer validates with a model that ignores unknown keys, so a misspelled
  argument would otherwise be dropped silently. The refusal is a `ToolError` caused by a pydantic
  `ValidationError` (`extra_forbidden`, or `missing`, titled after the tool's argument model), the
  shape of MCPServer's own argument errors, so the client reads the same text and the server logs
  only the refused names. A call with both an unknown and an invalid argument reports the unknown
  ones, together with any required argument it lacks, so a misspelt name comes back next to the
  one it stands for; an unknown tool name falls through to MCPServer's `Unknown tool: <name>`.
  `mcp` is built with `subscriptions=False`: the tool set is fixed and there are no resources or
  prompts, so neither era advertises `listChanged` or `subscribe`. It is also built with
  `_INSTRUCTIONS`, a short when-to-use text (start with `lw_search`, fetch with `lw_get_post`,
  filter precisely with `lw_filter_posts`, one backend for both forums) followed by a
  one-paragraph link-to-value summary for hosts that show the instructions but not each
  parameter's description (results link `/api/post/<id>`, `/users/<slug>`, `/w/<slug>`,
  `/s/<id>`; pass that value alone; the comment-link rule). Both eras serve the whole text as the
  server's `instructions`; `test_tool_contract.py` keeps it to at most 1,000 characters, holding
  each link form and naming only registered tools.
- **`_flatten_parameters`** — applied to each listed tool by `LessWrongServer.list_tools`; returns
  a new schema (never mutates its input) with `Optional` constraints at the top level (collapse a
  nullable `anyOf`, list `null` in a nullable `enum`) for schema-shallow clients, and
  `additionalProperties: false` to advertise the closed shape. A `$ref` is left alone: the choice
  types are `Literal`s, which render as inline enums. The Pydantic models remain the runtime
  safety net, and the stored schema MCPServer checks 2026-era `Mcp-Param-*` headers against stays
  the generated one (no parameter declares a header, so both agree).
- **Error funnel** — every failure reaches the client as an MCP tool error (`isError: true`),
  never as success text. `_tool_errors` wraps each tool and catches exactly the anticipated
  failures — httpx's `HTTPError` family, `httpx.InvalidURL` (which sits outside it) and
  `ForumAPIError` — and re-raises each as the SDK's `ToolError`
  (`mcp.server.mcpserver.exceptions`) carrying `_handle_error`'s message. `InvalidURL` stays
  among them although no tool input can raise it (an identifier is checked against its pattern
  and a query parameter is encoded): it comes only from a proxy or `NO_PROXY` variable httpx
  can't parse when it builds the client, and catching it keeps httpx's text, which can quote the
  start of a proxy password, out of the client's message (`Could not build a valid forum URL.`)
  and the logs. A tool body's own input checks raise `ToolError` directly, and so does
  `lw_get_comments`' `_get_comment` for the two statuses its route gives a missing comment: 404
  (no such post, or the comment isn't on it) and a bare 500 (a comment id the forum doesn't
  have, checked live 2026-10-16, and retried like any 5xx before the tool reports it).
  MCPServer renders both as `Error executing tool <name>: <message>`, so a message never starts
  with "Error", and logs each once at INFO on `mcp.server.mcpserver.server`
  (`Tool '<name>' failed: …`), so the funnel logs nothing of its own. Anything else, a library
  `RuntimeError` included, is a fault and propagates untouched: MCPServer logs its traceback at
  ERROR and the client reads only `Error executing tool <name>`. `lw_tool` applies the funnel,
  so every registered tool carries it (`functools.wraps` preserves the real signature so
  MCPServer still sees the `Annotated` params).

### Backend pagination caps

Two hard limits imposed by the backend, surfaced as fast-failing bounds/guards at the tool
boundary and named as constants in `config.py` (both pinned by binary search against the live
API, 2026-07-02):

- **`MAX_GRAPHQL_SKIP = 2000`** — the GraphQL `posts` selector rejects `skip > 2000` ("Exceeded
  maximum value for skip"). Bounds `lw_filter_posts`' `offset` (`le=MAX_GRAPHQL_SKIP`), so an
  over-limit value fails as a clean Pydantic error instead of an opaque mid-call GraphQL error.
  The cap applies to `offset` itself, not `offset+limit` — which is why `lw_filter_posts` reports
  `has_more` and `depth_limited` separately. Neither is set once the posts left can't match:
  the server doesn't apply `min_karma=0` (it ignores a zero `karmaThreshold`), but `top` sorts by
  descending baseScore, so a surplus row below `min_karma` ends the listing (`_page_signal`'s
  `exhausted`).
- **`SEARCH_RESULT_WINDOW = 10000`** — the shared search index (Elasticsearch
  `max_result_window`) only serves the first 10,000 results (`from + size ≤ 10000`). `lw_search`'s
  `page` and `limit` are independent, so `page * limit` can exceed it; a pre-flight guard raises
  an actionable tool error before the network call (a deeper request is a deterministic HTTP 500
  that would otherwise also burn the retry budget). The next-page hint is offered only for a page
  that clears both bounds and only while results remain: `limit` applies per type, so the
  largest per-type `## <Type> (N total)` header decides, and with no header parsed the hint is
  offered.

## Version

`__version__` derives from `importlib.metadata.version("lesswrong-mcp")`, falling back to a
literal in `config.py` when running from a non-installed source tree; `USER_AGENT` is built from
it, so the UA can't drift from `pyproject.toml`, and `server.py` passes it as
`MCPServer(version=...)`, the `serverInfo` version both protocol eras report.
`manifest.json` is a separate bundle format — **bump its `version` by hand on release**,
alongside `pyproject.toml` and the `config.py` fallback. `tests/test_packaging.py` fails while
those three disagree, and while the manifest's tool list, Python range, license, author,
homepage, repository or keywords drift from the registered tools and `pyproject.toml`.
Versions follow SemVer, and each release gets its own `vX.Y.Z` tag (see the Git workflow
convention).

## Tests

13 `test_*.py` files in `tests/`, plus shared scaffolding in
[`tests/conftest.py`](tests/conftest.py). Pytest config lives in `pyproject.toml`'s
`[tool.pytest.ini_options]` (`testpaths` + `pythonpath = ["."]`, so `import lesswrong_mcp`
resolves with or without an install; `--strict-markers` and the registered `live` marker, so a
misspelt marker is an error).

Files are grouped by the layer under test, not one-per-tool: `test_config.py` (the pure env → value
helpers `_env_num` and `_log_level`, the HTTP knobs they resolve at import, the server handing
`LW_LOG_LEVEL` to the SDK, and `SITE_BASE_URLS` covering exactly the `site` choices), `test_cli.py`
(the lifespan closing the pooled client when an in-process connection ends (on both eras, an error
included) and when the real stdio server reaches EOF, and the `python -m` launcher answering an
`initialize` line over stdio and exiting at end of input), `test_http_client.py` (`_request`'s retry
set, `Retry-After` handling, per-attempt deadline, concurrency cap and slot release,
`_get_markdown`, the SSRF guard, the loop lifecycle, a proxy URL httpx can't parse, the request each
backend puts on the wire from a tool call through the real pooled client — headers, query string,
JSON body, a pattern-valid slug unchanged in the path, redirects — and the suite's own network
guard), `test_markdown_helpers.py` (`_md_inline`, `_handle_error`'s messages, the `FIND`/`SHAPE`
tables and the advice each kind's 404 carries, the `_tool_errors` funnel reporting each anticipated
failure as that message, logged once by the SDK, and a fault's text withheld from the client but
logged at ERROR with its traceback), `test_tools_read.py` (the request each Markdown-API tool other
than `lw_search` sends through a real MCP session — site, path with the value as given, query
params, body returned as-is — the upstream quirks passed through verbatim, and `lw_get_comments`'
single-comment fetch: the thread options it drops, and how its 404 and 500 read), and `test_live.py`
(the opt-in smoke tests against the real forum, one request per Markdown route plus the search
wording the tools parse, the user-search links the user-miss advice points to, and an all-types
search whose every link carries a value the identifier pattern accepts and which links the tag and
sequence forms their advice promises; and the hermetic test of the `LW_LIVE_TESTS` gate). The three
tools with substantial logic of their own keep their own files: `test_lw_get_post.py`
(`_slice_markdown` and the max_chars/offset size control `lw_get_post` and `lw_get_comments` share:
the default slice, sized from `MAX_CHARS`, and a long body read whole by following the footer),
`test_lw_search.py` (the request it sends, the relabel, the next-page hint, the fail-fast window
guard and query trimming) and `test_lw_filter_posts.py` (`_posts_selector` and `_page_signal`
directly, then the selector, site/offset/limit+1 the tool sends, the `tags` list (each distinct slug
looked up once, in first-seen order), the advice on an unresolved author or tag, the paging signal
in both formats, the karma and date boundaries, the rendered header and rows, and the karma,
Alignment Forum and `count` facts its description states). So do `test_graphql.py` (`_graphql`'s
error surfacing, slug→`_id` resolution and the bounded LRU cache of resolutions),
`test_tool_schema.py` (the advertised schemas and descriptions, each bound a description states
matched to the bound the schema enforces, `max_chars` capped at its default, both user-slug
descriptions warning that a slug differs from the display name, and the flattening checked against
parameter shapes no tool declares yet: unions, typeless literals, named and nested enums, and each
description being its cleaned docstring), `test_tool_contract.py` (what every registered tool does
over a real MCP session: read-only annotations, failures as tool errors, plain-text results, unknown
and out-of-range arguments rejected before any request, every identifier parameter declaring the
bare pattern and refusing a value that is not a bare id or slug with its kind's advice (each `tags`
item and the shape of the list included), explicit nulls, stringified numbers and plain-string dates
and choices accepted, an unknown tool reported by name, the negotiated era, the reported server
version, instructions and capabilities, each era's client receiving the server's own tool listing
with no nullable `anyOf` left in it, and no private helper re-exported from the package root) and
`test_packaging.py` (`manifest.json`, `pyproject.toml`, `ci.yml` and the docs read as files: the
manifest's version, Python range, license, author, homepage, repository, keywords and tool list
against `pyproject.toml` and the registered tools, no `/` in `display_name`, the User-Agent's
contact URL, the mcpb version README's and CLAUDE.md's build commands pin against the one CI packs
with, and the version an uninstalled source tree reports). Section banners inside each file mark its
groupings.

Keep new tests **hermetic**. `conftest.py` provides the `run` fixture (there is no
pytest-asyncio — it just wraps `asyncio.run`), the monkeypatch seams `patch_io` / `patch_sleep`
/ `spy_sleep` / `markdown_stub` / `forum`, `call_tool` (calls a tool through a real in-process
`mcp.client.Client` once per protocol era — the `protocol_era` fixture: `legacy`, the 2025-11-25
handshake over in-memory JSON-RPC streams, and `auto`, the 2026-07-28 per-request path — for
assertions on what the client receives, such as `is_error`), `listed_tool` / `tool_schema` (one
tool as the server lists it, and its advertised input schema), and an autouse
`_clear_id_cache` fixture that resets the slug→`_id` cache around every test. `patch_sleep`
records each backoff sleep instead of sleeping; `spy_sleep` runs a probe at that moment (to check,
say, that no concurrency slot is held). Both replace the global `asyncio.sleep`, so a test that
needs real event-loop yields takes neither. `forum(handler)` serves the real pooled client's
traffic from `handler` over `httpx.MockTransport` and returns the requests it received, so
`_resources()`' User-Agent, redirect following, SSRF hook and semaphore stay under test. All the
seams key off **`IO_HOME`** — the module owning the patched network-I/O functions (currently
`lesswrong_mcp.http_client`). Patch through those fixtures, not a bare `monkeypatch.setattr`.
Tests import an internal from its home module (`http_client._request`, `errors._handle_error`)
and reach only the public surface through `lesswrong_mcp`. If the I/O layer ever moves modules,
repoint `IO_HOME` alone. (The cache tests shrink `graphql_resolve._ID_CACHE_MAX` with
`monkeypatch`: a module constant read on every call, not an I/O seam.) The repo has no
pytest-timeout, so a test that would hang under a broken change (a deadlock, a leaked
concurrency slot, a missing deadline) runs under an outer `asyncio.wait_for(..., 5)`.

The autouse `_offline` guard enforces this: in every test not marked `live`, a request that
reaches httpx's real transport, or a `socket.connect` to an address off the machine, fails the
test at once with `unstubbed network call: …` (`pytest.fail` raises past `_request`'s retries
and the `_tool_errors` funnel), and the proxy and CA-bundle variables httpx reads are unset, so
a developer's environment can't decide the outcome. A test that must reach the forum is marked
`@pytest.mark.live`: conftest skips it unless `LW_LIVE_TESTS` is `1`, `true` or `yes` (any
case), and its `live_run` fixture runs the coroutine and then closes the pooled client. A full
live run makes 37 read-only requests, one at a time: one for each of the 10 smoke tests in
`test_live.py`, 25 for the 7 `lw_filter_posts` tag checks, which resolve their tag slugs
again in each test because the slug cache is reset per test, and two for the check, on each
site, that `top` orders posts by descending karma, which `lw_filter_posts` relies on to end a
`min_karma` listing.

## Lint / type-check

`ruff check .` and `mypy lesswrong_mcp` (`disallow_untyped_defs`, but not `--strict`;
`ignore_missing_imports`) must stay green.

`[tool.ruff.lint] select` is pinned to `["E4", "E7", "E9", "F"]` **deliberately** — do not drop
it to inherit ruff's defaults. Ruff 0.16 widened its default selection to ~400 rules, which
switches on checks this repo rejects on purpose:

- **`I` (import ordering)** — the import blocks are grouped by meaning, not alphabetised.
- **`TRY004`** — wants a `TypeError` after an `isinstance` check, but the shape checks in
  `http_client._graphql` must raise `ForumAPIError` to reach the `_tool_errors` funnel (a
  `TypeError` would surface as a fault). Ruff accepts a package exception there, so the rule
  stays quiet unless one of those raises becomes a builtin.
- **`E501`** — the tool docstrings and `Field` descriptions are intentionally long single lines,
  so `line-length` is set for a formatter's benefit but not enforced as a lint error.

## Bundle manifest gotcha

**`manifest.json`'s `display_name` must never contain a `/`.** Claude Desktop builds a
per-server log path from that string (`~/Library/Logs/Claude/mcp-server-<display_name>.log`).
Before app 1.24012.9 a slash silently splits it into a directory
(`~/Library/Logs/Claude/mcp-server-LessWrong /` holding ` Alignment Forum.log`); since then a
path-escape guard rejects it outright:

```
[MCP] Could not connect to MCP server LessWrong / Alignment Forum
  Error invoking remote method 'connect-to-mcp-server': Error: path escape: "LessWrong / Alignment Forum"
```

The tell is that `main.log` reports a healthy `Connected to … (8 tools)` and the uv child is
alive — Claude Code sessions work fine — while only the renderer's `connect-to-mcp-server` IPC
(the Desktop chat UI) throws, so the symptom is "chat says disconnected while the server is
demonstrably healthy" and reinstalling never helps. The real error appears only in
`~/Library/Logs/Claude/claude.ai-web.log`, not `main.log`. Hence `display_name` is
`LessWrong & Alignment Forum` — keep the `&`; `test_packaging.py` fails on a `/`.

Note this is a *different* failure from a `type: uv` extension not finding `uv` on the bare GUI
launchd PATH, which is the other common "Could not connect" cause; check which one before acting.
README's Troubleshooting section gives users both diagnoses; keep it in step with this one.

## Conventions when editing

- Keep every tool **read-only**; register every tool with `@lw_tool`, never `@mcp.tool`
  directly (`test_tool_contract.py`'s table must list every registered tool).
- Never put a `/` in `manifest.json`'s `display_name` (see Bundle manifest gotcha).
- Reach network I/O through `http_client`; keep the layer ordering (leaf → root) intact.
- New hermetic tests only.
- **Git workflow**: work directly on `main` with ordinary checkpoint commits, then squash them
  into one commit per release on top of the previous release — no feature branches, no PRs.
  Checkpoint commits stay local until that squash. A release bumps the version in all three
  places (see Version), pushes the release commit, waits for CI to pass on it, then tags it
  with the new version and publishes a GitHub Release of that tag with the freshly built
  `dist/lesswrong-mcp.mcpb` attached under exactly that name (README's latest-download link
  relies on it). To fold later work into the current release instead, squash it into that
  release commit, force-push with lease, let CI pass, then move the tag and replace the
  release's bundle and notes.
