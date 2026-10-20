# lesswrong-mcp

[![CI](https://github.com/seankessinger/lesswrong-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/seankessinger/lesswrong-mcp/actions/workflows/ci.yml)

A read-only [MCP](https://modelcontextprotocol.io) server for LessWrong and the Alignment
Forum. Through it, Claude can:

- **search** posts, comments, tags, users and sequences, sorted by relevance, date or karma,
  within a date range, on the Alignment Forum only, or inside one post's discussion
- **read a post**, in full
- **read a post's whole discussion**, answers on question posts included, or one comment
- **list posts** by author, tag, date range and karma in a stated order, or the posts that link
  to a post
- **read a sequence** in order

Both forums run on one [ForumMagnum](https://github.com/ForumMagnum/ForumMagnum) deployment, so
one server reads both; Alignment Forum items are marked `AF`. It reads only public endpoints, so
there's no API key or login.

## Quick start

### Claude Desktop

Download
[lesswrong-mcp.mcpb](https://github.com/seankessinger/lesswrong-mcp/releases/latest/download/lesswrong-mcp.mcpb)
(always the newest release's bundle, also attached to the latest
[release](../../releases)) and double-click it, or install it from Settings → Extensions →
Advanced settings → Install Extension…. The bundle uses Desktop's `uv` runtime, which installs
Python and the dependencies for you.

To update, install the bundle from the latest release. If Settings → Extensions still shows the
older version afterwards, remove the LessWrong & Alignment Forum extension there and install the
new file again.

### Claude Code

With [uv](https://docs.astral.sh/uv/) installed:

```bash
claude mcp add --transport stdio --scope user lesswrong -- uvx --from git+https://github.com/seankessinger/lesswrong-mcp lesswrong-mcp
```

`--scope user` makes it available in every project; leave it out to add it to the current
project only. Any other client that launches stdio servers can run the same `uvx` command.

## What a call looks like

An illustrative listing, `lw_filter_posts(tags=["interpretability-ml-and-ai"],
after="2024-01-01", before="2024-12-31", af_only=true, limit=2)`:

```markdown
# Posts (2) — tags=interpretability-ml-and-ai; 2024-01-01 to 2024-12-31; Alignment Forum only; sort=top

- [An example post title](https://www.lesswrong.com/api/post/AbCdEfGhIjKlMnOpQ) — Author Name (author-name) · karma 210 · 2024-03-14 · 31 comments · AF
- [Another example](https://www.lesswrong.com/api/post/QpOnMlKjIhGfEdCbA) — Second Author (second-author) · karma 155 · 2024-08-02 · 12 comments · AF

---
[More: call again with offset=2.]
```

Each row links what the other tools take: the post's id for `lw_get_post`, the author's slug
for `lw_filter_posts(author=...)`.

## The tools

| Tool | Takes | Returns |
|---|---|---|
| `lw_search` | `query` (quoted phrases are exact; `-word` excludes); `types`; `sort` (`relevance`, `newest`, `oldest`, `karma`); `after`/`before`; `af_only`; `in_post`; `limit`; `page` | Hits per kind, with the forum's totals and snippets |
| `lw_get_post` | `post_id`; `max_chars` (≤40,000); `offset` | The post as the forum's Markdown, in slices with the offset to continue from |
| `lw_get_comments` | `post_id`; `comment_id`; `sort` (`top`, `new`, `old`); `max_chars`; `offset` | The whole discussion (answers first on question posts, replies under their parents), or one comment |
| `lw_filter_posts` | `author`; `tags`; `after`/`before`; `min_karma`; `af_only`; `sort` (`top`, `new`, `old`); `links_to`; `limit`; `offset` | Matching posts; with `links_to`, the posts linking to that post |
| `lw_get_sequence` | `sequence_id`; `max_chars`; `offset` | The sequence's description and its posts in order |

Posts, comments and sequences are named by their 17-character id, users and tags by slug. A
value of the wrong shape, such as a link or a display name, is refused before any request, with
advice on where the right value comes from.

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
  `claude.ai-web.log`. This bundle is named `LessWrong & Alignment Forum`; keep `/` out of
  `display_name` if you repackage it.

## Development

It needs Python 3.11 or newer.

```bash
pip install -e '.[dev]'              # pytest, ruff, mypy
python -m lesswrong_mcp              # serve over stdio
pytest                               # hermetic: fakes the forum, no network
LW_LIVE_TESTS=1 pytest -m live       # opt-in: one read-only call per forum route and view
ruff check . && mypy lesswrong_mcp   # lint and type-check
```

Logging goes to stderr, never stdout, which carries the protocol. Retries and refused redirects
are logged as warnings naming the request's path only.

## Building the bundle

```bash
mkdir -p dist
npx @anthropic-ai/mcpb@2.1.2 pack . dist/lesswrong-mcp.mcpb
```

`.mcpbignore` is an allowlist: the bundle holds only `manifest.json`, `pyproject.toml`,
`LICENSE` and the package.

The bundle ships **unsigned**. Don't run `mcpb sign --self-signed` on it: mcpb appends its
signature block after the zip's end-of-central-directory record without recording it as a zip
comment, so strict zip parsers, the desktop extension installer among them, reject the signed
file (`Invalid comment length … extra bytes at the end`). Self-signing also only yields an
"unverified publisher" bundle. For a trusted signature, use a CA-issued certificate
(`mcpb sign --cert/--key`) and confirm the result still installs.

## License

MIT
