# lesswrong-mcp

[![CI](https://github.com/seankessinger/lesswrong-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/seankessinger/lesswrong-mcp/actions/workflows/ci.yml)

A read-only [MCP](https://modelcontextprotocol.io) server that lets Claude, or any MCP client,
search and read LessWrong and the Alignment Forum: a post, its comment thread or one comment,
a user's profile, a tag's wiki page, a sequence's ordered posts, a front-page feed, or a
precise slice of posts by author, tag, date and karma. It only reads the sites' public
endpoints, so there's no API key and no login.

LessWrong and the Alignment Forum run on the same
[ForumMagnum](https://github.com/ForumMagnum/ForumMagnum) codebase and share a database, so
this one server covers both, and search spans both at once. The Alignment Forum is really a
curated slice of LessWrong rather than a separate site, so everything on it is on LessWrong
too. Every tool but `lw_search` takes an optional `site` (`lesswrong` by default, or
`alignmentforum`): on `alignmentforum` the feeds, comment threads and `lw_filter_posts` cover
only Alignment Forum content. Post karma is LessWrong's score on either site.

## Quick start

### Claude Desktop

Download
[lesswrong-mcp.mcpb](https://github.com/seankessinger/lesswrong-mcp/releases/latest/download/lesswrong-mcp.mcpb)
(always the newest release's bundle, also attached to the latest
[release](../../releases)) and double-click it, or install it from Settings → Extensions →
Advanced settings → Install Extension…. All eight tools show up right away. Everything runs
locally: the bundle uses Desktop's `uv` runtime, which installs Python and the dependencies
for you.

To update, download the bundle from the latest release and install it. If Settings →
Extensions still shows the older version afterwards, remove the LessWrong & Alignment Forum
extension there and install the new file again. Editing or rebuilding a checkout doesn't
touch the copy Claude Desktop runs.

### Claude Code

With [uv](https://docs.astral.sh/uv/) installed:

```bash
claude mcp add --transport stdio --scope user lesswrong -- \
  uvx --from git+https://github.com/seankessinger/lesswrong-mcp lesswrong-mcp
```

`--scope user` makes it available in every project; leave it out to add it to the current
project only.

### Any other MCP client

Any client that launches stdio servers can run it the same way:

```json
{
  "mcpServers": {
    "lesswrong": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/seankessinger/lesswrong-mcp", "lesswrong-mcp"]
    }
  }
}
```

From a checkout, `python -m lesswrong_mcp` serves the same thing over stdio (see
[Running it locally](#running-it-locally)).

## What a call looks like

Asked for the Alignment Forum's 2023 interpretability posts with the highest LessWrong karma,
Claude can answer with a single `lw_filter_posts` call:

```json
{"tags": ["interpretability-ml-and-ai"], "after": "2023-01-01", "before": "2023-12-31",
 "alignment_forum_only": true, "sort": "top", "limit": 3}
```

```markdown
# Filtered posts (3) — tags=interpretability-ml-and-ai, after=2023-01-01, before=2023-12-31, alignment_forum_only=true, sort=top

- [SolidGoldMagikarp (plus, prompt generation)](https://www.lesswrong.com/api/post/aPeJE8bSo6rAFoLqg) — author: [Jessica Rumbelow](https://www.lesswrong.com/api/user/jessica-rumbelow) | karma: 682 | 2023-02-05 | comments: 208
- [Steering GPT-2-XL by adding an activation vector](https://www.lesswrong.com/api/post/5spBue2z2tw4JuDCx) — author: [TurnTrout](https://www.lesswrong.com/api/user/turntrout) | karma: 443 | 2023-05-13 | comments: 98
- [Against Almost Every Theory of Impact of Interpretability](https://www.lesswrong.com/api/post/LNA8mubrByG7SFacm) — author: [Charbel-Raphaël](https://www.lesswrong.com/api/user/charbel-raphael) | karma: 337 | 2023-08-17 | comments: 93

---
[More results — call again with offset=3 to continue.]
```

Each title links the post's Markdown route and each author their profile's, so the next step is
`lw_get_post` on one of those ids, `lw_get_comments` for its discussion, or `lw_get_user` (or
`lw_filter_posts(author=…)`) on an author's slug.

## The tools

| Tool | What it does |
|---|---|
| `lw_search` | Full-text search over posts, comments, tags, users, and sequences, across both forums (pass `content_type` to search just one kind) |
| `lw_get_post` | A post's body and metadata, by id or slug |
| `lw_get_comments` | A post's comment thread, sorted by top, new, or old, or one comment by `comment_id` |
| `lw_get_user` | Someone's profile and their best posts |
| `lw_get_tag` | A tag or wiki page and the posts filed under it |
| `lw_get_sequence` | A sequence's intro and its ordered list of posts |
| `lw_list_feed` | A front-page feed: latest, recent, curated, or home |
| `lw_filter_posts` | Posts filtered by author, tags (all required at once), date range, and karma, with a sort order (Markdown or JSON) |

Most of these just wrap the forum's Markdown API, which the site publishes for exactly
this kind of use, so the responses come back as clean Markdown already. `lw_filter_posts`
is the one exception: it goes through GraphQL, because that's the only way to get the
precise author + tag + date + karma filtering.

## A few things worth knowing

- It's read-only. The forum API can also create and edit drafts, but those endpoints are
  deliberately left out here.
- Every tool takes bare values: a post `_id` or slug, a comment `_id`, a user or tag slug, a
  sequence `_id`, each the segment that follows its kind in the link a result carries for it:
  `/api/post/<x>`, `/users/<slug>`, `/w/<slug>`, `/s/<id>`, and `/comments/<cid>` for a comment
  (in `/posts/<id>/<slug>`, the `<id>`). A link, path or `?query` is refused with a message
  saying which part to pass.
- Pagination works a little differently per tool: `lw_search` takes `page` and `limit` (and
  ends with a next-page hint while results remain), `lw_filter_posts` takes `limit` and
  `offset`, and `lw_get_comments` takes `limit` (a comment count, up to 2000, since some
  threads run to hundreds of comments). `lw_get_post` and `lw_get_comments` return at most
  40,000 characters of Markdown per call (`max_chars` can lower that, not raise it), since a
  client may hide a larger result from the model; a long one is paged with `offset` — when a
  slice stops short, a footer gives the exact `offset` to pass next. `lw_filter_posts`
  signals paging the same way: its JSON reports `has_more` with the `next_offset` to pass
  next, or `depth_limited` once results run past the backend's ~2000-deep cap (narrow the
  filters to go further), and it mirrors that as a one-line footer in Markdown. Its `count`
  is the number of posts on that page, not a total. The `home` feed is the one feed that
  ignores `limit`: it's a fixed composite page, so reach for `latest`/`recent`/`curated` when
  you want a set count.
- Comments come back most complete from the default `lesswrong` site, which returns the
  whole thread. The `alignmentforum` view of a post only shows the comments promoted to
  the Alignment Forum, so it's a subset. For a single comment, pass `lw_get_comments` its
  `comment_id`: it comes back on its own, without its replies.
- Search always covers both forums and can't be narrowed to one, since they share a
  single index. For Alignment-Forum-promoted posts, reach for `lw_filter_posts` with
  `alignment_forum_only: true` (or `site: "alignmentforum"`, which returns only those).
  Its karma, `min_karma` and `sort: "top"` use LessWrong's score on either site, not the
  Alignment Forum's own.
- It tries not to be rude to the forum: in-flight requests are capped, and it backs off
  and retries on rate limits (429), transient server errors and network failures.
- What you ask goes to the forum and nowhere else: search text, ids and slugs are sent to
  lesswrong.com or alignmentforum.org, and the server has no telemetry. `manifest.json`
  lists [LessWrong's privacy policy](https://intelligence.org/files/PrivacyandTerms-Lesswrong.com.pdf),
  the one LessWrong's FAQ links to.

## Troubleshooting

**Claude Desktop says "Could not connect to MCP server".** There are two known causes, and on
macOS the logs under `~/Library/Logs/Claude/` tell them apart:

- **Desktop can't find `uv`.** It runs this extension through `uv`, and `main.log` records the
  launch (look for the `[UV Discovery]` and `[UV Runtime]` lines). On macOS an app opened from
  the Dock or Finder gets the system's bare `PATH`, without `~/.local/bin` or Homebrew, so a
  `uv` installed there can be invisible to it. Adding that directory to the PATH GUI apps
  inherit fixes it, e.g. `sudo launchctl config user path
  "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"` and a
  reboot.
- **The extension's display name contains a `/`.** Desktop builds a log-file path from that
  name and refuses to connect a server whose name would escape it. `main.log` then reports a
  healthy connection, and the real error (`path escape: "…"`) appears only in
  `claude.ai-web.log`. This bundle is named `LessWrong & Alignment Forum`; if yours shows a
  slash, remove it and install the current bundle, and keep `/` out of `display_name` if you
  repackage it.

## Running it locally

It needs Python 3.11 or newer.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e .

python -m lesswrong_mcp   # stdio (any MCP client, or the MCP Inspector)
```

It serves stdio only. The install also provides a `lesswrong-mcp` command that does the same
as `python -m lesswrong_mcp`. These optional environment variables tune it:

| Variable | Default | Effect |
|---|---|---|
| `LW_HTTP_TIMEOUT` | `30` | Per-operation timeout for requests to the forum, in seconds |
| `LW_HTTP_TOTAL_TIMEOUT` | `60` | Deadline for each attempt's whole round trip, in seconds |
| `LW_MAX_RETRIES` | `2` | Retries after the first attempt, on a 429, 500, 502, 503 or 504, a network error or a missed deadline; `0` disables them |
| `LW_CONCURRENCY` | `4` | Maximum concurrent requests to the forum |
| `LW_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` or `CRITICAL` |

A malformed or out-of-range `LW_*` value falls back to its default, with a warning on stderr.

Logging goes to stderr, never stdout, which carries the protocol stream. Retries, giving
up, a `Retry-After` over 60 seconds (the server stops retrying rather than wait that long) and
refused redirects are logged as warnings that name the request's path only. A failed tool call
is logged once at INFO, naming the tool and, for arguments the schema rejects, only their
names, never their values. An unexpected fault is logged at ERROR with its traceback, and the
client is told only which tool failed. httpx's own per-request lines are kept out at every
level, since their full URLs carry search queries.

## Development

```bash
pip install -e '.[dev]'              # pytest + ruff + mypy
pytest                               # hermetic: mocks the HTTP/GraphQL layer, no network
LW_LIVE_TESTS=1 pytest -m live       # just the opt-in live-endpoint tests, against the real API
ruff check . && mypy lesswrong_mcp   # lint + type-check (also run in CI)
```

The suite lives in `tests/` and is hermetic — it stubs the HTTP/GraphQL layer and drives
the async tool handlers directly, so it runs offline and fast. A guard fails any test that
reaches the network unless it is marked `live`, and only `LW_LIVE_TESTS=1` (or
`true`/`yes`) runs those. It covers the shared HTTP layer (retry/backoff, `Retry-After`,
the concurrency cap, the per-attempt deadline, the SSRF redirect guard, and the headers
and query each request carries on the wire), the GraphQL plumbing (error surfacing and
slug→id resolution), each tool's routing and paging, and the `selector` that
`lw_filter_posts` builds — in particular that a tag rides on the requested sort view as a
`filterSettings` "Required" tag, composing with any sort order and the other filters.
Through an in-process MCP client, on both protocol eras the server speaks (the 2025-11-25
handshake and 2026-07-28), it also checks the contract every registered tool keeps: each
sends its own route and parameters to the requested site, failures arrive as tool errors,
results are plain text, unknown or out-of-range arguments are rejected before any request,
and every identifier parameter takes only a bare id or slug, so a link, path or display name
is refused with advice for that kind of value. It also runs `python -m lesswrong_mcp` as a real
stdio server in a subprocess, which answers an `initialize` request and exits at end of input,
and checks `manifest.json`'s hand-kept copies (version, tool list, Python range, license,
author, homepage) against `pyproject.toml` and the registered tools. The opt-in live tests make
one request per Markdown route, check the upstream wording `lw_search` parses, check that its
results link the ids and slugs the tools take, check that the tag filter of `lw_filter_posts`
restricts every sort order, and check that `top` orders posts by karma. CI runs them weekly and
on demand, next to a weekly re-run of the whole suite against the newest dependencies.

## Building the bundle

```bash
mkdir -p dist
npx @anthropic-ai/mcpb@2.1.2 pack . dist/lesswrong-mcp.mcpb
```

`manifest.json` and `pyproject.toml` describe the bundle, and `.mcpbignore` keeps everything
it doesn't run (the tests, the docs, and so on) out of it.

The bundle ships **unsigned**. Don't run `mcpb sign --self-signed` on it: mcpb appends its
signature block *after* the zip's end-of-central-directory record without recording it as a
zip comment, so strict zip parsers — including the desktop extension installer — reject the
signed file (`Invalid comment length … extra bytes at the end`). Self-signing also only
yields an "unverified publisher" bundle, so it buys nothing here. If you ever need a
genuinely trusted signature, use a CA-issued certificate (`mcpb sign --cert/--key`) and
confirm the result still installs.

## License

MIT
