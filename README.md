# LessWrong and Alignment Forum Research

A read-only extension for Claude Desktop that lets Claude research LessWrong and the Alignment Forum.

## What it is

This extension gives Claude read-only research access to LessWrong (LW) and the Alignment Forum (AF) in Claude Desktop. It is shaped for research on AI-safety discussions: posts and whole discussions, people, wiki pages, sequences, links between posts, reactions, edit history and search.

- It only reads. It never writes, votes, posts or reacts. It shows only what a logged-out visitor sees on the site.
- It has 16 tools. The examples below show what you can ask and which tools Claude uses.
- It sends only two kinds of request, `POST /graphql` and `POST /api/search`, both to `www.lesswrong.com`; it never contacts the Alignment Forum's own host. How often and how much it asks is under "Politeness and privacy".
- It has no affiliation with the operators of LessWrong or the Alignment Forum.

## Install

1. Download the extension file `lesswrong-mcp-1.0.0.mcpb` from the [Releases page](https://github.com/seankessinger/lesswrong-mcp/releases), or build it yourself (see "Development").
2. Open `lesswrong-mcp-1.0.0.mcpb` in Claude Desktop (for example by double-clicking it) and confirm the installation.
3. Start a conversation. The 16 tools are available to Claude, and there is nothing to configure.

Claude Desktop shows this extension as unsigned; that is expected.

Requirements:

- Claude Desktop on macOS or Windows (the platforms for which it ships its own Node.js).
- The extension runs on the Node.js that Claude Desktop ships, so you need no separate installation. It declares Node.js 20 or later (`>=20.0.0` in the manifest); Node.js 22 or later is recommended, and the version in use is logged to stderr at startup.

## Using it: example questions

Claude chooses the calls itself; these are typical sequences. Where you already have a URL or an id, the `find` step is not needed.

1. "Summarize the main disagreements in the comments on AGI Ruin: A List of Lethalities."
   - `find {items: [{kind: "post", query: "AGI Ruin: A List of Lethalities"}]}` gives the best match, `post_id uMQ3cqWDPHhjtiesc`.
   - `get_comments {post: "uMQ3cqWDPHhjtiesc", sort: "contested", max_tokens: 40000}` gives the counts, a block of disagreement signals (disagree reactions, split agreement or karma votes, back-and-forth exchanges, each with its `comment_id` and `user_slug`), the crux and changed-mind marks, the most contested threads in full, and one line for each remaining thread.
   - Optionally `get_comments {post: "uMQ3cqWDPHhjtiesc", sort: "top", max_tokens: 40000}` for the most upvoted threads, or the cursor for more.
2. "Who replied to Paul Christiano's comment on AGI Ruin, and did he answer back?"
   - `find {items: [{kind: "post", query: "AGI Ruin: A List of Lethalities"}, {kind: "user", query: "Paul Christiano", commented_on: "item:1"}]}` finds the post and `paulfchristiano`, matched among that post's commenters.
   - `get_comments {post: "uMQ3cqWDPHhjtiesc", user: "paulfchristiano"}` gives a reply map: each of his comments, each direct reply with its ids, and whether he replied back; then the threads he is in, with his comments marked.
   - To read one reply in context: `get_comments {comment: "<comment_id from the map>"}`.
3. "What did an author post about interpretability in 2024, best-received first?"
   - `find {items: [{kind: "user", query: "<author name>"}, {kind: "tag", query: "interpretability"}]}` gives the author's `user_slug` and the tag candidates.
   - `list_posts {user: "<user_slug>", tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top", limit: 20, query: "interpretability"}` lists the tagged posts by karma, then up to 10 untagged posts that match the word. Add `af_only: true, sort: "af_top"` for the Alignment Forum view.
4. "Who first used the term 'mesa-optimizer' on LessWrong, and was it in the original version of that post?"
   - `first_use {forms: ["mesa optimizer", "mesa optimizers", "mesa optimization"], limit: 5}` searches oldest first, checks the edit history of the earliest candidates and names the earliest verified use, whether it was present at publication, and why earlier-looking hits were ruled out.
   - To quote it: `get_history {post: "<post_id>", revision: "original", match: "mesa optimizer"}`.
5. "What's on Axel Højmark's profile, and what have they been commenting on lately?"
   - `find {items: [{kind: "user", query: "Axel Højmark"}]}` gives `axel-hojmark`. Accents matter: "Axel Hojmark" without the ø finds someone else.
   - `get_user {user: "axel-hojmark"}` gives the profile, counts, bio, links, top and latest posts, the latest comments with their posts and who they reply to, sequences and recent wiki edits; each section ends with the call that continues it.
   - More comments: `list_comments {user: "axel-hojmark", cursor: "c_…"}` from that hand-off continues after the ten already shown.
6. "What does the Interpretability wiki page say, and what are its top posts?"
   - `find {items: [{kind: "tag", query: "interpretability"}]}` gives the tag candidates; wiki-only pages are labelled.
   - `get_tag {tag: "interpretability-ml-and-ai"}` gives the page type, parent and subtags, lenses, summaries, likes, the discussion count, the 10 highest-karma tagged posts, and the wiki text with an outline.
   - Optionally `get_tag {tag: "interpretability-ml-and-ai", sort: "tag_relevance"}` for the most strongly tagged posts, or `get_reactions {tag: "interpretability-ml-and-ai"}` for who liked the page.

## The 16 tools

The shared conventions after the last tool apply to all of them.

### find

Resolves names to exact identifiers, several in one call. `items` is required: 1 to 5 objects `{kind, query, commented_on?}`, resolved independently, where `kind` is `post` (a title), `user` (a display name), `tag` (a topic, tag or wiki page name) or `sequence` (a sequence, book or collection title), `query` is the name to resolve, and `commented_on` (only on `user` items) is a post identifier or `item:N`, the best match of item N of the same call counting from 1, so that post's commenters are matched first. `af_only` keeps Alignment Forum posts and sequences and, for user items, AF members. `limit` counts candidates per item; `cursor` and `max_tokens` are the shared paging parameters. Each candidate has its ids and enough detail to choose, labelled by how it matched (for example identifier, exact title, exact name, commenter on the post, slug, alias or search); "best match" is marked only when one candidate is clearly right, and otherwise you choose from the list. `find` also searches the long forms of common abbreviations (see the table under "Things the forums do that you should know").

### search

Full-text search of posts, comments, people, wiki pages and sequences. `kind` is `post` (the default), `comment`, `user`, `tag` or `sequence`. `query` is matched loosely; `phrases` are exact phrases that must all occur in the same item; `exclude` lists single words to leave out. Filters are `user` (the primary author), `tag`, `post` (comments on one post), `af_only`, and `date_from` and `date_to` (posts and comments only). `sort` is `relevance` (the default), `new`, `old` or `top`; sequences take every order but `top`, and wiki pages and tags only `relevance`. `limit` counts hits; `cursor` and `max_tokens` page the reply. Every hit is re-read from the forum and checked here against the phrases; the match count is the forum's loose count, results stop 10,000 deep, and one of `query` or `phrases` is required unless a filter is combined with `sort` new, old or top.

### get_post

Reads one post: metadata, status, structure and text. `post` is required (an id, a URL or the exact current slug). The header gives authors, dates, karma and votes, AF status, the comment count, status flags, tags with relevance, Annual Review results and review comments, the glossary, related questions, the best answer and the canonical sequence with neighbours. `section` reads one numbered section of the outline; `match` keeps only the paragraphs containing a text (not together with `section`); `include_body` (default true) set to false returns everything but the text; `cursor` and `max_tokens` page a long body. Interactive widget code is omitted, and dialogues show speaker names. There is no `limit`: the reply is one post.

### get_comments

Reads a discussion as ranked, labelled threads, ready for summarizing. Give exactly one of `post` (the whole discussion), `comment` (the thread containing it) or `tag` (a wiki page's discussion). `sort` is `top` (the default), `af_top`, `new`, `old`, `largest`, `contested` or `active`; `limit` counts threads (with `match`, matching comments); `user` keeps the threads that person wrote in, marks their comments and adds a reply map; `match` keeps only comments containing a text; `af_only` keeps threads with at least one AF comment, whole. The first page also lists the strongest disagreement signals and the comments readers marked as cruxes or as having changed their mind. `cursor` and `max_tokens` page the reply.

### list_posts

Lists posts with filters, best first or by date. `user` (their own and coauthored posts), `tag` (posts readers tagged with it), `date_from` and `date_to` (posting date), `af_only`, `curated_only`, `frontpage_only`, `questions_only` and `min_karma` are the filters. `sort` is `top` (the default when `tag` is given), `new` (the default otherwise), `old`, `active`, `tag_relevance` (needs `tag`), `curated_date` (needs `curated_only`) or `af_top` (needs `user` or `tag`). `query` (only with `tag`) adds, after the tagged posts, untagged posts that match those words. `limit` counts posts; `cursor` and `max_tokens` page the reply. Event and meetup posts are left out (see "What it does not offer").

### list_comments

Lists comments across the site or by one person: what someone has been commenting on, the latest comments site-wide, or quick takes. `user`, `date_from` and `date_to`, `af_only`, `quick_takes_only` (top-level quick takes only) and `min_karma` are the filters; `sort` is `new` (the default), `old` or `top`. Without `user`, `sort` top and `quick_takes_only` each need both dates, at most 31 days apart. `limit` counts comments; `cursor` and `max_tokens` page the reply. Each comment shows where it is, who it replies to, its karma, agreement, reactions and flags, and its text (cut at about 1,500 tokens; `get_comments` with `comment` shows it whole).

### get_user

A person's public profile and recent activity in one call. `user` is required (an id, a profile URL or an exact, case-sensitive slug). It returns display name, ids, karma and AF karma, AF membership, counts, bio, job, organization, links and pinned posts, and `limit` items in each of: top posts, latest posts, latest comments, sequences and recent wiki edits. `af_only` limits the post, comment and sequence sections to AF items. Each section ends with the call that continues it; `cursor` and `max_tokens` page the reply.

### get_tag

A tag or wiki page: its text and its top posts in one call. `tag` is required (an id, a `/w/…`, `/tag/…` or `/p/…` URL, or an exact slug; earlier slugs, Arbital ids and lens slugs work). It returns the page type, parent tag and subtags, likes, the wiki text as Markdown with an outline, lenses, summaries, related Arbital pages, the discussion count and, for a core tag, a preview of the tags grouped under it. `section` reads one numbered section and `match` keeps only paragraphs containing a text (not both). `sort` orders the posts: `top` (the default), `tag_relevance`, `new` or `old`; `limit` counts posts; `af_only` applies to the posts. `cursor` and `max_tokens` page the reply.

### get_sequence

A sequence (an ordered series of posts) or one of the five collections (`rationality`, `codex`, `hpmor`, `highlights`, `bestoflesswrong`). `sequence` is required (an id, a URL or a collection slug). It lists the sequence's posts chapter by chapter in the forum's chapter order; for a collection, its books and their sequences. `post` marks a post in the sequence, starts the first page at its chapter and shows its position with the previous and next posts. `limit` counts posts (for a collection, sequences); `af_only` keeps only AF posts; `cursor` and `max_tokens` page the reply.

### list_sequences

Lists sequences: every public sequence (the default), a person's (`user`), or the curated ones (`curated_only`). `af_only` keeps AF sequences. `sort` is `site_order` (the default), `new` or `old`; `limit` counts sequences; `cursor` and `max_tokens` page the reply. Each item shows its ids, title, author, post count (approximate), creation date, AF status and a description excerpt. Open one with `get_sequence`.

### get_history

Edit history of a post, a comment or a wiki page, or the wiki edits of a person. Give exactly one of `post`, `comment`, `tag` (a lens slug or summary id gives that part's own history) or `user` (wiki edits only). Without `revision`, it lists the publicly visible versions, newest first (`sort` is `new` or `old`; `limit` counts versions), with the original marked. `revision` (a revision id, `original` or `current`) returns that version's text, and `match` keeps only the paragraphs containing a text. `compare_to` (a revision id, `original`, `previous` or `current`; needs `revision`) returns the word-level changes between two versions. `phrases` checks each phrase in the original and current text and finds the first version that contains it. `cursor` and `max_tokens` page the reply.

### first_use

Who first used a phrase, and was it in the original text? `forms` is required: the phrase and up to 4 other forms of it (word endings are not matched, so give each inflection yourself). It searches posts, and comments unless `include_comments` is false, oldest first, keeps only hits that really contain a form, and checks the edit history of the earliest candidates. `af_only` searches AF items only; `limit` counts candidates per page; `cursor` and `max_tokens` page the reply. The answer means "the earliest public use that could be verified", not a guaranteed first use. The first page holds the oldest hits of every form; later pages add the next hits of each form, so a continuation's "Earliest verified on this page" is the earliest of that page only.

### get_links

Links between posts and wiki pages. Give exactly one of `post` (incoming links come from posts whose current text links to it; outgoing links are every link in its text, resolved) or `tag` (wiki pages linking to the page, and the links in its text). `direction` is `both` (the default), `incoming` or `outgoing`. `sort` (incoming posts only) is `top` (the default), `new` or `old`; `af_only` keeps AF posts and comments among the links; `limit` counts incoming items; `cursor` and `max_tokens` page the reply.

### get_reactions

Votes, agreement, likes and reactions on one post, comment or wiki page, in detail. Give exactly one of `post`, `comment` or `tag`. It returns karma and vote counts, AF karma for AF items, the agreement score (comments only), a wiki page's likes with who liked it, and every reaction the site shows, with who added, seconded or disputed it and the passage it is anchored to. `cursor` and `max_tokens` page the reply; there is no `limit`, because the reply is one item.

### get_feed

Site-level feeds. `feed` is required: `frontpage` (an approximation of the logged-out home page), `recent_discussion`, `popular_comments`, `quick_takes`, `this_week`, `wiki_activity`, `dialogues`, `best_of` or `spotlight`. `af_only` keeps AF items in the same order (not for `wiki_activity`). `date_from`, `date_to` and `sort` (`new`, the default, or `old`) apply to `best_of` only. `limit` counts items per page and is not accepted for `spotlight`; `cursor` and `max_tokens` page the reply. Each feed keeps the forum's own order and says how stale it can be.

### list_tags

Lists tags. Without `tag`: every tag that can be applied to posts (about 1,010), alphabetically. With `tag` set to one of the 7 core tags (`rationality`, `ai`, `world-modeling`, `world-optimization`, `practical`, `community`, `site-meta`): all the tags grouped under it, in the forum's order, including wiki-only pages (labelled). `limit` counts tags; `cursor` and `max_tokens` page the reply. There is no `af_only` and no `sort`. Open a tag with `get_tag`.

### Shared conventions

**Identifiers.** A parameter that takes an identifier is named after its entity (`post`, `comment`, `user`, `tag`, `sequence`, `revision`) and accepts the same forms in every tool: an id, a lesswrong.com or alignmentforum.org URL (comment permalinks work as post URLs), or an exact slug. Titles and display names are never accepted; `find` turns them into ids. Every result labels its ids (`post_id`, `comment_id`, `user_slug` and `user_id`, `tag_slug`, `tag_id`, `lens_slug` and `summary_id`, `sequence_id` and `collection_slug`, `revision_id`) so that they can be passed to the next call. Labels such as `T3.1` are positions inside one result, not identifiers.

**Dates.** Input is `YYYY`, `YYYY-MM`, `YYYY-MM-DD` or an ISO-8601 timestamp, always UTC. `date_from` is the first instant of the period it names and `date_to` includes the whole period, so `date_from: "2024", date_to: "2024"` is exactly calendar 2024. The parameters always filter the posting date.

**Alignment Forum.** Every post, comment and sequence shows its AF status (`AF` with AF karma, or `LW only`). `af_only` is a pure filter: it removes items and never reorders what remains. For people it keeps AF members; for tags, wiki pages and other items with no AF status it does not apply. Threads stay whole, with their non-AF comments labelled `not on AF`. AF items link to alignmentforum.org.

**Replies and cursors.** A reply is one block of text of about 15,000 tokens by default (`max_tokens` 2,000 to 40,000), and `limit` (10 by default, at most 50) sets how many items a page holds. A long result ends with a cursor, a short opaque token (`c_` plus 22 characters); call the same tool with it to continue, repeating nothing but, if you like, `max_tokens`. A tool can also print a complete hand-off call with a cursor for another tool, for example `get_user` to `list_comments`.

**Errors and empty results.** An error is a tool result whose text starts `Error (<category>): `, with the category `bad_input`, `bad_cursor`, `not_found`, `not_public`, `login_only`, `too_broad`, `rate_limited`, `politeness_cap`, `timeout`, `forum_error` or `internal`, followed by what is wrong and how to fix it. An empty result is not an error.

## Capabilities

What you can look up, which tool gives it, and what is missing or partial (the reasons are under "What it does not offer" and "Things the forums do that you should know"; paging depth is under "Politeness and privacy").

| What | Tools | Missing or partial |
|---|---|---|
| Post text | `get_post` (body, outline, sections, `match`, dialogues with speakers, debate turns); `get_history revision=` (any public version) | widget code (omitted, size noted) |
| Post metadata | `get_post` header (incl. Annual Review figures and review comments, glossary, related questions, best answer, canonical sequence); the post record in every list (authors and coauthors, dates, karma, votes, AF karma, comment counts, status, pinned, tags with relevance, Best of) | the date a post moved to AF; the forum's last-modified time as an edit date |
| Post edit history | `get_history` (versions, original, texts, diffs, phrase introduction); `first_use` | pre-2019 originals; a complete edit timeline |
| Comments | `get_comments` (one post, comment thread or wiki page), `list_comments` (a person, site-wide, quick takes), `search kind=comment`; reviews listed in `get_post` | — |
| Comment threads | `get_comments` (ranked threads, `comment=`, `user=` reply map with ids, `match=`) | — |
| Answers on question posts | `get_comments` (answer threads first, `A` labels); `get_post` (best answer, related questions) | — |
| User profiles | `get_user`; `find` user cards; `search kind=user` | — |
| Users' posts | `list_posts user=` (own + coauthored, incl. sub-questions and group posts, flagged); `get_user` (top and latest, with hand-off cursors) | — |
| Users' comments | `list_comments user=` (by date or by karma); `get_user` (latest, with a hand-off cursor) | — |
| Users' wiki edits | `get_user` (recent wiki edits); `get_history user=` (all, paged) | a person's post and comment edits (histories are read one post or comment at a time) |
| Users' karma | `get_user` (karma, AF karma, live); cards in `find` and `search` (re-read live) | karma leaderboards |
| Tags | `get_tag`; `list_tags` (all taggable tags; full core-tag groupings); `find kind=tag`; `list_posts tag=`; `search kind=tag`; tags with relevance on every post record | the order the site's tag page uses; posts linking to a tag; a list of all wiki-only pages |
| Wiki pages | `get_tag` (text, lenses, summaries with ids, parent and subtags, likes, Arbital relations, discussion count); `get_history tag=` (main text, lenses, summaries); `get_comments tag=` (discussion); `get_links tag=`; `get_reactions tag=` | the tag-history feed; contributor statistics |
| Sequences | `get_sequence` (chapters, posts in order, position and neighbours, stats); `list_sequences` (all public, a person's, curated); `find kind=sequence`; `get_post` (canonical sequence, previous/next) | "all sequences containing a post"; cross-sequence neighbours in collections with unnumbered books |
| Collections and books | `get_sequence` with the 5 collection slugs; `find` (alias table and listing) | the order of unnumbered books |
| Which posts link to which | `get_links` (incoming backlinks, outgoing links resolved, wiki-page and lens backlinks) | links from comments, wiki pages, sequences and profiles to posts; links from non-positive-karma posts |
| Votes | karma and vote counts on post and comment records; wiki-page likes in `get_tag`; `get_reactions` for posts, comments, wiki pages and lenses | — |
| Tag-relevance votes | the relevance number of each tag on post records; `sort: tag_relevance` in `list_posts` and `get_tag` | — |
| Agreement scores | every comment record; `get_comments` signals and `contested` sort; `get_reactions` | agreement on posts (not collected) |
| Reactions | net summaries on post and comment records; `get_comments` signals and cruxes; `get_reactions` (who, quotes; also on wiki pages and lenses) | current reactor karma |
| Curated status | `curated <date>` on every post; `list_posts curated_only` and `sort=curated_date`; `get_feed this_week`; `list_sequences curated_only` | — |
| Frontpage status | `frontpage` / `not frontpaged` and `pinned` on every post; `list_posts frontpage_only`; `get_feed frontpage` (labelled approximation) | the exact home page |
| Best of LessWrong / Annual Review | flag on records; `get_feed best_of`; `get_post` (review results and the post's review comments); `review (<year>)` flags on comments | a whole review year's comments as one list |
| Recent activity | `get_feed recent_discussion`, `popular_comments`, `quick_takes`, `this_week`, `wiki_activity`, `dialogues`, `spotlight`; `list_posts sort=new` and `sort=active` (with last-comment dates); `list_comments sort=new`; `get_user` latest sections | "last activity" from drifting fields (computed instead) |
| Feeds | `get_feed` (9 feeds, all paged) | login-only feeds; RSS |
| Search | `search` (5 kinds, phrases, exclusions, filters, sorts per kind); `find`; `list_posts query=`; `first_use` | punctuation inside phrases; synonyms; semantic search; deep paging; sequences by author (via `list_sequences`) |
| Alignment Forum | `AF`/`LW only` on every post, comment and sequence and every reference to one; AF karma and AF comment counts; `af_only` as a pure filter on every tool that lists posts, comments or sequences; `af_top`; AF links | "when it moved to AF" |

## What it does not offer

The extension does not offer the items below, or offers them only in the form stated.

- Event and meetup posts are left out of lists but can appear in search. They are left out of `list_posts`, the post sections of `get_user` and `get_tag`, and the `frontpage` and `this_week` feeds; they always open by id with `get_post`, and they are flagged `event` where they appear as evidence (search hits, backlinks, recent discussion, a sequence's chapters, a comment's post). Local groups are not offered.

### Not reliable enough to offer

| Not offered as such | Reason | Offered instead |
|---|---|---|
| When a post moved to AF | The forum records the date inconsistently; a missing date doesn't mean "never" | the post's AF status |
| A "last edited" or "last active" date from the forum's own fields | They mislead or drift | the date of each public version; activity computed from the comments fetched |
| "Everything that links to X" | Only post bodies create links, only posts with positive karma count, and links are recorded as of the linking post's last edit | `get_links`, with those limits stated |
| "All sequences containing this post" | The forum has no lookup from a post to its sequences | the canonical sequence (membership checked); any given sequence's contents and the post's position in it |
| The chapter order the site displays; previous and next as the site computes them | Chapters can share a number, which makes their order arbitrary, and the site's page may show them in another order | the forum's chapter-list order, and neighbours computed from it, stated as such |
| Previous and next across sequence boundaries in collections with unnumbered books (`bestoflesswrong`), and the order of those books | The forum orders books by number with no tie-break, and 3 of `bestoflesswrong`'s 4 books have none | books in the order the forum returns them, labelled; cross-sequence neighbours only in collections whose books all have distinct numbers |
| Finding old-style debates by search | The forum has no public filter for them | the built-in list of 6 (the feature is retired) |
| The post order of the site's tag page | The site's page code is not public | both `top` and `tag_relevance` |
| Earlier slugs of a post | Posts keep no record of them | the id in a post URL; `find` by title |
| Karma leaderboards | The forum's are approximate and count self-votes | — |
| Agreement on posts | Not collected | agreement on comments |
| The current karma of people who reacted | The forum shows a stored snapshot, not the current value | reactors' names only |
| Karma of old-style debate turns as a measure of reception | Only the post's authors may vote on turns | omitted from turns |
| The site's "hotness" score as a measure of quality | It decays with age and is recomputed only from time to time | never shown; only the front-page feed uses the site's ranking |
| Search: "tag A but not B" or two required tags; two bounds on one field; collections and books by name; semantic search | Limits of the forum's search | one `tag`; dates only on posts and comments; `find`'s collection names |
| `first_use` for phrases with accented letters or punctuation inside a word ("Gödel", "Löb's theorem", "GPT-4.5") | The forum's search deletes those characters inside quotes, so such phrases can't be searched in date order | refused, with a suggestion of ASCII spellings writers also use, which can be traced; `search` finds the accented form by relevance |
| Search for sequences by author | Search cannot reliably filter sequences by author | `list_sequences {user}` |
| Date and karma orders for wiki-page search hits | Imported pages carry creation dates from Arbital, and a page's karma is the likes on the page itself | relevance order only; other orders are refused with the reason |
| Feeds whose window the forum doesn't bound (`this_week`, `dialogues`) in full | No maximum and no paging, so a feed may hold more than is fetched | 300 and 100 items per fetch, paged here; the last page says when more may exist |
| GreaterWrong URLs; old Agent Foundations links (`/item?id=`) | Not every GreaterWrong URL form is recognised, and old Agent Foundations ids can't be looked up | ids in GreaterWrong URLs, read on a best-effort basis; an `/item?id=` link is refused with an explanation |

### Not offered

| Not offered | Reason |
|---|---|
| Anything that writes, votes, posts or reacts; anything that needs a login (messages, personalised feeds, the forum's own interfaces for AI agents) | The extension only reads and never logs in |
| Bulk downloading; a catalogue of every user | The request caps under "Politeness and privacy" prevent it; people are found with `find`, `search` and the commenters of a post |
| A list of every wiki-only page | Wiki-only pages grouped under a core tag are listed by `list_tags`; the others are found with `find` and `search kind=tag` (search knows 1,491 wiki-only pages) |
| A generic query tool, or a way to send your own forum queries | The extension sends only its own fixed queries, through the 16 tools above |
| The forum's agent document (`/SKILL.md`) | It contains instructions aimed at AI agents; it is never fetched or passed on |
| The forum's RSS feeds and Markdown pages | The tools above give the same content in more detail |
| The site's tag-history feed and wiki contributor statistics | The history of a page's main text, lenses and summaries is offered (`get_history tag=`), and so are a person's wiki edits |
| Edit history of bios and sequence descriptions | The post, comment and wiki histories are offered |
| A whole Annual Review year's review comments as one list | Each post's reviews are listed by `get_post`, and the year's winners by `get_feed best_of` |

## Things the forums do that you should know

- **Approximate counters.** Numbers marked `~` are the site's own counters and are approximate.
- **Search phrases.** The forum's search deletes every character outside letters, digits and spaces inside quotes. So hyphens and underscores count as spaces; a word with an apostrophe is searched without the part after the apostrophe and then checked here in its original form (a hit that has only the other form is labelled `matches without the possessive` or `matches only with a possessive`); a phrase with punctuation inside a word or with accented letters ("GPT-4.5", "R&D", "Gödel") is searched as plain words and checked exactly here, which works with `sort` relevance only and may miss some uses. Search matches each item's current text only, dated by its original posting date. Unquoted query words are matched loosely: with several words most but not all must match (two need only one), word endings match, typos barely, OR and AND are ignored. Abbreviations and synonyms are not expanded.
- **`exclude`.** It takes single words only, because the forum can't exclude a phrase. With `exclude` and no `phrases`, any one of the query words is enough; with `phrases`, query words only affect ranking; in both cases accented letters in query words are dropped.
- **AF numbers and LW numbers.** "karma" is LessWrong karma and "AF karma" is the Alignment Forum score, shown only for AF items; the forum also stores an AF score on non-AF items, where it means nothing. `top` always uses LW karma. Comment counts are the site's counters, and the AF comment count is a separate approximate number.
- **"original" before 2019.** Texts from before 13 February 2019 exist only as a February-2019 import snapshot dated to the original posting time; earlier wording and edits were not kept. For some later posts the public history starts after publication ("published text not available"), and a post's date can be later than its first public appearance. Version numbers repeat and have gaps, so versions are addressed by revision id, and a version list is never a complete edit timeline.
- **The front page.** `get_feed` with `feed: frontpage` is an approximation of the logged-out home page, because the site's own page code is not public.
- **The forum's change counts.** In edit histories, the counts of characters added and removed are the forum's own; images and links count as no text change.
- **Slugs.** They are exact and case-sensitive, and the request echo names the post, account or wiki page a slug resolved to.
- **Karma in search.** Search karma, counts and dates are snapshots as of the search index's last update; karma shown in results is re-read live.
- **Feeds.** The forum caches some feeds for several minutes, so `popular_comments`, `dialogues` and others can be a few minutes old; each says so.

For tag and sequence items, `find` also searches the long form of these abbreviations (matched against the whole query, case-insensitively, also with a trailing "s") and reports that it did:

| Abbreviation | Also searched as |
|---|---|
| LLM | large language models |
| RLHF | reinforcement learning from human feedback |
| AGI | artificial general intelligence |
| ML | machine learning |
| EA | effective altruism |
| FDT | functional decision theory |
| UDT | updateless decision theory |
| CEV | coherent extrapolated volition |
| ELK | eliciting latent knowledge |
| SAE | sparse autoencoders |
| IDA | iterated amplification |
| HPMOR | Harry Potter and the Methods of Rationality |
| mech interp | mechanistic interpretability |

`find` also matches collections and books by title, and these names for the five collections: `rationality` ("Rationality: A-Z", "The Sequences", "R:A-Z", "Rationality from AI to Zombies"), `hpmor` ("HPMOR", "Harry Potter and the Methods of Rationality"), `highlights` ("Sequence Highlights", "Highlights from the Sequences"), `codex` ("The Codex"), `bestoflesswrong` ("Best of LessWrong").

## Politeness and privacy

**Politeness.**

- Requests go out one at a time, process-wide (one queue shared by all tool calls), with at least 3 s between the starts of two requests.
- Session caps, in rolling windows: 150 requests and 100 MB per 10 minutes, and 1,500 requests and 500 MB per 24 hours. Reaching one ends the call with `politeness_cap` and the time the pause ends; this stops runaway loops of calls.
- Each tool call has a cap on forum requests (find 3, search 5, get_post 3, get_comments 4, list_posts 6, list_comments 5, get_user 4, get_tag 2, get_sequence 3, list_sequences 5, get_history 7, first_use 7, get_links 4, get_reactions 3, get_feed 2, list_tags 2), a deadline of 50 s per call (no new request starts after 40 s; the reply then ends `Stopped early (time limit)` with a cursor) and a download cap of 20 MB. A request that would pass its cap is not sent, and the page ends `Stopped early (request cap)` with a cursor. A retry of a request that got no usable answer (one per request after a dropped connection or an empty 5xx; at most two per call after a 429 or 503) is not counted against the call's cap; it is still spaced and counted in the session windows.
- Site-wide lists in date order (`new` or `old`) that no filter but `af_only` narrows stop after 500 items; other orders end at the forum's own limit of about 2,000 results.
- Answers are cached in memory (one LRU of at most 64 MB, with a time to live per kind of data), so paging through a discussion, re-sorting it or asking about a participant reuses one fetch.
- Every request carries this User-Agent: `lesswrong-mcp/1.0.0 (read-only research extension for Claude Desktop; single user; one request at a time)`.
- When the forum signals overload or rate-limiting, the spacing grows (up to 30 s) and all requests pause, for at most 15 minutes; during a pause every call answers `rate_limited` at once, naming the time the pause ends.

**Privacy.**

- No cookies are sent and nothing logs in.
- No cache or data files are written. The server logs one line per request to stderr (template label, status, time, size and whether the cache answered; no content, no titles and no ids), and Claude Desktop keeps the server's one-line request logs in its own log files. `LESSWRONG_MCP_DEBUG=1` adds diagnostic lines, never ids or text.
- Cursors expire after an hour and when the server restarts. A cursor is a random token; the state it names stays in the server's memory and is never shown.
- Warning: Forum text can try to make Claude send your conversation data to the forum as a search query. All text from the forums, titles and names included, is written by forum users and may address AI systems. The server's instructions tell Claude to treat forum text as material, never as instructions, and not to send your own information to the forum as a search query, and the server marks the boundaries of every block of forum text in a reply. These are measures, not guarantees: you should know that search queries go to the forum.

## Development

The project is TypeScript (strict) on Node.js 20 or later. The sources are in `src/`, the tests in `test/` and the build scripts in `scripts/`.

- `npm install` installs the pinned dependencies.
- `npm run typecheck` runs `tsc --noEmit`.
- `npm test` runs the whole test suite offline: every test talks to a fake forum built from hand-made fixtures, and a tripwire makes any real network access fail.
- `npm run build` bundles `src/index.ts` and its dependencies with esbuild into the one file `build/bundle/server/index.mjs` (ESM for Node 20, not minified, no `node_modules`).
- `npm run pack` builds, then stages `manifest.json`, `icon.png`, `README.md` and `LICENSE` in `build/bundle/`, runs `mcpb validate`, packs `build/lesswrong-mcp-1.0.0.mcpb` and runs `mcpb info` to confirm that the bundle is unsigned. It never signs. `build/` is not kept in git.
- `npm run smoke` starts the packed bundle over stdio with the network disabled, lists the tools and makes one deliberately wrong call; run `npm run pack` first.

## License

MIT, Copyright (c) 2026 Sean Kessinger (see `LICENSE`). Forum content belongs to its authors. This license covers the code of this extension only and gives no rights to what the forums host.
