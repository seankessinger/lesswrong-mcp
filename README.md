# lesswrong-mcp

[![CI](https://github.com/seankessinger/lesswrong-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/seankessinger/lesswrong-mcp/actions/workflows/ci.yml)

A read-only MCP server for LessWrong and the Alignment Forum. It lets a model search
the two forums and read what's there: a post and its comment thread, a user's profile,
a tag's wiki page, a sequence's ordered posts, a front-page feed, or a filtered slice of
posts by author, karma, and date. There's no API key and no login involved, since it only
reads the sites' public endpoints.

LessWrong and the Alignment Forum run on the same
[ForumMagnum](https://github.com/ForumMagnum/ForumMagnum) codebase and share a database,
so this one server covers both, and search spans both at once. The Alignment Forum is
really a curated slice of LessWrong rather than a separate site, so everything on it is
on LessWrong too. The other tools take an optional `site` (`lesswrong` by default, or
`alignmentforum`), which mostly changes the feeds and the karma you see.

## The tools

| Tool | What it does |
|---|---|
| `lw_search` | Full-text search over posts, comments, tags, users, and sequences, across both forums (pass `type` to search just one kind) |
| `lw_get_post` | A post's body and metadata, by id or slug |
| `lw_get_comments` | A post's comment thread, sorted by top, new, or old |
| `lw_get_user` | Someone's profile and their best posts |
| `lw_get_tag` | A tag or wiki page and the posts filed under it |
| `lw_get_sequence` | A sequence's intro and its ordered list of posts |
| `lw_list_feed` | A front-page feed: latest, recent, curated, or home |
| `lw_filter_posts` | Posts filtered by author, tag, date range, and karma, with a sort order |

Most of these just wrap the forum's Markdown API, which the site publishes for exactly
this kind of use, so the responses come back as clean Markdown already. `lw_filter_posts`
is the one exception: it goes through GraphQL, because that's the only way to get the
precise author + tag + date + karma filtering.

## Installing it

Two ways to run it, depending on where you use Claude.

### In the desktop app

Grab the bundle:
[lesswrong-mcp.mcpb](https://github.com/seankessinger/lesswrong-mcp/releases/latest/download/lesswrong-mcp.mcpb).
That link always points at the newest build, or you can pick it up from the latest
[release](../../releases).

In Claude Desktop, go to Settings → Extensions → Advanced settings → Install Extension,
and choose the file. All eight tools show up right away. Everything runs locally, and the
bundle uses the `uv` runtime, so Claude Desktop takes care of Python and the dependencies
for you.

Updating it later means reinstalling. The installer copies the code into the app, so a
newer build won't take effect until you download the bundle again and, in Settings →
Extensions, **remove** the existing `lesswrong-mcp` and then install the new file. (Remove
it first — the version stays `1.0.0`, so the app won't treat the new file as an upgrade on
its own.) Rebuilding the repo or editing the source in a checkout doesn't touch the copy
Claude Desktop is running.

### As a remote connector

This part is optional: you only need it to use the server *outside* Claude Desktop —
claude.ai on the web or mobile, Cowork, or the API — including sharing a hosted instance
with other people. For those, you host the server yourself and add it as a custom
connector. There's a `Dockerfile` in the repo, so you can
deploy it wherever you like: Render, Fly.io, Railway, a plain VPS, or an MCP host such as
[Manufact](https://manufact.com). Run it in HTTP mode with `MCP_TRANSPORT=http` and
`MCP_HOST=0.0.0.0`, and it'll use whatever `$PORT` the platform gives it. The MCP endpoint
is at `/mcp`.

Then, in claude.ai, go to Customize → Connectors → Add custom connector, paste
`https://<your-host>/mcp`, and add it. No OAuth needed.

## Running it locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python -m lesswrong_mcp                                  # stdio (Claude Desktop / MCP Inspector)
MCP_TRANSPORT=http MCP_PORT=8000 python -m lesswrong_mcp # HTTP, endpoint at /mcp
```

The environment variables it reads: `MCP_TRANSPORT` (`stdio` or `http`), `MCP_HOST`
(`127.0.0.1` by default, `0.0.0.0` when you're hosting it), and `MCP_PORT` / `PORT`
(`8000` by default). Two optional ones harden the HTTP transport: set
`MCP_ALLOWED_HOSTS` and/or `MCP_ALLOWED_ORIGINS` (comma-separated) to turn on
DNS-rebinding (Host/Origin) protection scoped to those values — useful for a
deployment with a known hostname. Without them, protection is still on automatically
for a loopback bind (scoped to `localhost:<port>`, covering the local HTTP example
above); it's only disabled for a non-loopback bind like `0.0.0.0`, whose public
hostname a PaaS assigns at deploy time. In HTTP mode the server runs statelessly (no
per-session affinity), so it works behind a load balancer or a scale-to-zero host.

Four more optional vars tune the outbound HTTP client to the forum (default in
parentheses): `LW_HTTP_TIMEOUT` (`30`, per-operation seconds), `LW_HTTP_TOTAL_TIMEOUT`
(`60`, whole-round-trip deadline in seconds), `LW_MAX_RETRIES` (`3`), and `LW_CONCURRENCY`
(`4`, max concurrent in-flight requests). A malformed value falls back to its default.

## Tests

```bash
pip install -e '.[dev]'   # pytest + ruff + mypy
pytest                    # hermetic: mocks the HTTP/GraphQL layer, no network
LW_LIVE_TESTS=1 pytest    # also runs the one live-endpoint test against the real API
ruff check . && mypy lesswrong_mcp   # lint + type-check (also run in CI)
```

The suite lives in `tests/` and is hermetic — it stubs the HTTP/GraphQL layer and drives
the async tool handlers directly, so it runs offline and fast. It covers the shared HTTP
layer (retry/backoff, `Retry-After`, the overall deadline, and the SSRF redirect guard),
the GraphQL plumbing (error surfacing and slug→id resolution), each tool's routing and
paging, and the `selector` that `lw_filter_posts` builds — in particular that a tag rides
on the requested sort view as a `filterSettings` "Required" tag, composing with any sort
order and the other filters.

## Building the bundle

```bash
mkdir -p dist
npx @anthropic-ai/mcpb pack . dist/lesswrong-mcp.mcpb
```

`manifest.json` and `pyproject.toml` describe the bundle, and `.mcpbignore` keeps the
remote-only files (the `Dockerfile`, `requirements.txt`, and so on) out of it.

The bundle ships **unsigned**. Don't run `mcpb sign --self-signed` on it: mcpb appends its
signature block *after* the zip's end-of-central-directory record without recording it as a
zip comment, so strict zip parsers — including the desktop extension installer — reject the
signed file (`Invalid comment length … extra bytes at the end`). Self-signing also only
yields an "unverified publisher" bundle, so it buys nothing here. If you ever need a
genuinely trusted signature, use a CA-issued certificate (`mcpb sign --cert/--key`) and
confirm the result still installs.

## A few things worth knowing

- It's read-only. The forum API can also create and edit drafts, but those endpoints are
  deliberately left out here.
- Pagination works a little differently per tool: `lw_search` takes `page` and `limit`,
  `lw_filter_posts` takes `limit` and `offset`, and `lw_get_comments` takes `limit` (a
  comment count, up to 2000, since some threads run to hundreds of comments). `lw_get_post`
  and `lw_get_comments` both return everything by default, but a long one can be capped with
  `max_chars` and paged with `offset` — when a slice stops short, the response ends with the
  exact `offset` to pass next. `lw_filter_posts` signals paging the same way: its JSON reports
  `has_more` with the `next_offset` to pass next, or `depth_limited` once results run past the
  backend's ~2000-deep cap (narrow the filters to go further), and it mirrors that as a one-line
  footer in Markdown. The `home` feed is the one feed that ignores `limit`: it's a
  fixed composite page, so reach for `latest`/`recent`/`curated` when you want a set count.
- Comments come back most complete from the default `lesswrong` site, which returns the
  whole thread. The `alignmentforum` view of a post only shows the comments promoted to
  the Alignment Forum, so it's a subset.
- Search always covers both forums and can't be narrowed to one, since they share a
  single index. If you specifically want Alignment-Forum-promoted posts, reach for
  `lw_filter_posts` with `alignment_forum_only: true`.
- It tries not to be rude to the forum: in-flight requests are capped, and it backs off
  and retries on 429s and 5xx errors.
- The remote version only ever touches public data and can't write anything, but if you
  put it on a public URL you can still limit inbound traffic to
  [Anthropic's IP ranges](https://platform.claude.com/docs/en/api/ip-addresses) or add
  OAuth in front of it.

## License

MIT
