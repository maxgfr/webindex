---
name: webindex
description: Extract, rank, and inspect web or local documents and query forge, package, or site metadata.
disable-model-invocation: true
metadata:
  opencode/autoinvoke: 'false'
---

# webindex

A library of **primitives**, not a pipeline. It is vendored by other tools as a
single file, and it also runs as a CLI and an MCP server so an agent can use it
directly.

This document is served over MCP as `skill://SKILL.md`, alongside
`skill://references/*.md` — so `webindex mcp` documents its own engine.

## What this is not

The calling agent owns the research question, source selection, evidence checks
and final citations. webindex supplies discovery, extraction and ranking. Read
the source passages before writing a conclusion; search snippets and relevance
scores alone do not establish a claim.

So it is also **not meant to compete for implicit skill selection**. The
`agents/openai.yaml` policy disables implicit invocation while keeping explicit
`$webindex` use available. It is a library, a command and an MCP server.

> The root `SKILL.md` used to be the second half of that argument — the
> installer was said to early-return on it and install that file alone. That is
> no longer true: `skills add maxgfr/webindex` installs the repository whole,
> `scripts/` and `references/` included. The versioned package links under
> `skills/webindex` and `.agents/skills/webindex` expose the same canonical files
> to Codex without editable copies.

Route by what you actually want:

| You want | Use |
|---|---|
| a cited recap of what the web says | `ultrasearch` |
| a precise answer about a named open-source project | `ultradoc` |
| a cited summary of, or answer about, videos (YouTube, Vimeo…) | `ultrawatch` |
| an idea turned into a buildable spec | `construct` |
| one URL turned into clean text, or a pool ranked | this, directly |

## Combine with the host's search

When ChatGPT or Claude already provides native web search, use it to discover
sources for broad or current questions, then send useful URLs to
`webindex_fetch`. Use `webindex_search` to supplement missing coverage or when
native search is unavailable. A supplied URL can go straight to extraction.

Rank the fetched `{url,title,text}` documents with `webindex_rank`, keeping
the original URLs and discovery provenance in the caller's records. Inspect
the relevant passages and cite their sources. For a blocked or unreadable page,
try the host's reader or another source and report the gap if it remains.

Read `references/host-search.md` for the ChatGPT/Claude workflow, connection
boundaries and a concrete MCP example.

## The commands

```
webindex search <query> [--engine ddg|ddglite|mojeek|off] [--limit n] [--lang tag] [--region cc] [--timeout ms]
webindex fetch <url> [--full-page]    # HTML main content, consent banners dropped; --full-page keeps all page text via the built-in reader
webindex fetch <url> --format markdown # CommonMark: absolute links, fenced code, lists, tables — Firecrawl's shape, whichever extractor ran
webindex fetch <url> --cache          # reuse a fresh copy for the TTL, revalidate a stale one (a 304 when unchanged); --refresh, --offline
webindex fetch <url> <url> …         # several at once, each under a ==> <url> <== header (--json: an array); fails only if all did
webindex fetch <video-url>           # YouTube, Vimeo, Dailymotion…: a timestamped, chaptered transcript: manual subs → own auto-captions → local whisper
webindex fetch <url> --browser       # render the page in the dedicated browser first (a page only JavaScript fills)
webindex video fetch|search|frames|list …  # keep a video on disk, search it, its frames aligned with speech, a playlist as V1…Vn
webindex extract <file|-> [--full-page] # the same on disk (- reads stdin); --full-page keeps navigation and consent banners too; --format markdown
webindex rank --query <q> --docs <f> # BM25F + near-dup collapse + MMR; --dense adds the embedding lane
webindex repo|issues|prs|releases|tags <ref> [--forge github|gitlab|gitea]  # a browser URL or a local checkout works
webindex package <name> [--registry npm|pypi|crates]
webindex meta|robots|sitemap|feed <url> # meta also reads a saved page: <file|->
webindex crawl <url> --max <n>       # bounded site walk, robots at every hop; --prefix /docs/, --no-sitemap
webindex tables <url|file|->         # tables as data, not flattened prose
webindex embed <text> | --docs <f>   # local vectors, no key; a JSON array of texts in one run
webindex hybrid --query <q>          # BM25F + dense, fused by RRF
webindex changed <url> [--etag <v>] [--last-modified <d>]  # a 304 costs one round trip
webindex cache status|clean [--all]
webindex searxng|firecrawl|semantic|stack up|down|status
webindex skill check|bundle|vendor|copy|doctor|init|repin|finish|recall
webindex mcp [--transport http]       # the webindex_* tools over MCP; --public-only, --extract-root <dir> wall it in; --browser adds the browser tools
webindex doctor [--json]
webindex browser open <url> --snapshot  # a separate browser on a dedicated profile; the page as a tree with refs (e12)
webindex browser open <url> --snapshot --interactive  # the same, only the controls: much shorter
webindex browser snapshot [<ref>|--selector <css>] --max-chars <n>  # one element's subtree; --max-chars cuts snapshot and text (20000 by default)
webindex browser text [<ref>|--selector <css>] [--markdown]  # the current tab's main content as fetch reads it (overlays stripped), or one element's text
webindex browser click|fill|select|type|upload|scroll <ref> …  # act on a ref; --snapshot returns the new tree, --selector <css> scopes that tree
webindex browser press <key>         # Enter, Escape, Control+A… on the focused element
webindex browser wait --text <s>|--url <p>|--clear  # check the result; --clear waits for the human to solve a challenge
webindex browser network list|get <n>  # the JSON fetched during each command given --capture; the log grows until network clear
webindex browser screenshot [<ref>|--selector <css>]  # an element by ref (a table, a figure…) or by CSS selector
webindex browser eval|tabs|back|status|close  # close shuts down only a browser webindex launched
```

Every command that answers with data takes `--json` — all but the container
commands, which print docker's own report, and `mcp`. Human output goes to
stdout and degradation notes to stderr, so `webindex search q | head` stays a
clean URL list. `webindex <command> --help` prints that command's usage alone.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | The command did what was asked. |
| 1 | It ran and the answer is a failure: nothing found, a page unreadable, robots.txt saying no, a gate refusing, a stale ref. |
| 2 | The invocation itself was wrong: an unknown command or flag, a missing or out-of-range value, a stray argument. |
| 3 | `browser` only: done, but a human is needed. `open`, `back`, `forward`, `reload`, a `click`, `press` or `type --submit` landed on a blocking challenge (captcha, bot check). The result is printed as on success, `challenge` in its JSON. |

## What it will and will not do

**In scope.** Discovery (SearXNG, the keyless engines, Firecrawl), retrieval
(streaming byte caps, conditional GET, HTML→text or Markdown, main-content extraction, the
PDF and office ladders, video transcripts and frames (YouTube and any site
yt-dlp reads), Wayback rescue, a
revalidating cache), text (keyword
matching, URL identity), ranking (RRF, BM25F, SimHash, MMR), forges and package
registries, and the whole MCP protocol.

Plus the harness every skill built on this engine was rewriting: the run
directory, a validating command-line parser, the multi-agent fan-out emitter,
and the mechanics of reading citations out of a report.

**Out of scope, deliberately — and the line runs through the middle.** The
distinction is **mechanics versus policy**, not subject matter.

Reading a report is mechanics: which bracketed tokens are citations and which
are markdown links, that a `[S1]` inside backticks or a code fence or a
"## Sources" appendix grounds nothing, what a claim unit is. Six skills had
their own regex for that, and the subtle cases are exactly where independent
copies disagree.

The verdict is policy, and stays with the tool. Nothing in `src/cite.ts` returns
a pass or a fail — there is no `runCheck`, no `ok: boolean`, no threshold and no
severity, and a test asserts there never will be. What counts as grounded, what
coverage is sufficient, whether an uncited claim is an error or a warning, how
sources are numbered and where they are written: those are the sentences a
tool's users argue about, and answering them here would dictate behaviour rather
than share plumbing.

The same line runs through orchestration. The engine owns the emission, the
batching and the harness constraints; the skill owns the phase table, the
contract prose and the schemas its subagents must satisfy.

## The browser

`webindex browser` drives a **separate** Chrome, Brave, Chromium or Edge over
the DevTools Protocol, on a dedicated profile under `~/.webindex/browser`, with
no automation flags. It never touches the user's own browser or profile. You see
each page as an accessibility snapshot with refs, act on a ref, and look again.
It does not solve captchas, does not bypass anti-bot systems and does not log in
for the user: the human does those in its window, then `wait --clear` or
`wait --url` takes over. A click or Enter that looks irreversible (pay, order,
delete, publish, send, validate) is refused until `--confirm`, which you pass
only after the user said yes to that very action; so is a click on a frame,
whose content (a payment button) cannot be inspected. Enter in a textarea, a
contenteditable or a formless chat box, and a `select` that submits on change,
are not guarded: ask first. Refs go to the controls and to containers (a
table, a figure, an article, `main`, a form), so `screenshot e40` can capture an
infobox; `--interactive` lists only the controls. A ref holds while its element
lives: a widget the page re-renders gets new refs, so snapshot again after
acting on one. A form control with no name, or a name another one shares, shows
its `type`, `name` and `placeholder` after its ref. To read a page, `browser
text` gives its main content without the cookie wall over it; `eval` is not
needed for that. `wait --clear` needs a human and can hold the browser for up to
5 minutes: when nobody is watching, pass a short `--timeout` and tell the user
the page needs them. A consent wall needs no one: `browser text` and `fetch
--browser` read the page behind it. Read `references/browser.md` before driving
it.

## Three rules that constrain every change

- **No runtime dependencies, ever.** Consumers vendor `scripts/engine.mjs` and
  inline it; a bare specifier cannot resolve there. CI fails on any non-builtin
  import.
- **Node 18 is the runtime floor.** A dedicated job runs the committed bundle on 18
  with no install. Development uses Node ≥22.22.2 and pnpm 11 because the release
  toolchain requires it.
- **No module-scope environment reads.** The engine is imported before a consumer
  can call `configure()`, so a `const X = envInt(…)` would freeze webindex's own
  prefix and never see theirs. Every tunable is behind a function.

## Politeness and the network

`robots` is **advisory**: it answers whether a URL is yours to fetch, and
`fetch` does not consult it. Following one citation is not crawling; enumerating
a site is, and a caller that enumerates should ask first.

The keyless engines are the only rung that reaches the public internet without
being asked to — the rest is localhost by default. `WEBINDEX_ENGINES=off` turns
them off for sandboxes, test suites and air-gapped runs.

The MCP server fetches whatever URL it is handed and reads whatever file it is
named. Exposed with `--allow-remote`, it refuses private and metadata addresses
(at every redirect; `--allow-private` lifts it) and reads no local file unless
`--extract-root <dir>` names the one directory it may; `WEBINDEX_MCP_TOKEN`
makes HTTP require a bearer token. `--public-only` and `--extract-root` work
without `--allow-remote` too.

## References

- `references/host-search.md` — combining ChatGPT or Claude search with extraction and ranking.
- `references/web-discovery.md` — the discovery cascade, and what each rung costs.
- `references/provider-apis.md` — forges and package registries, and their quotas.
- `references/ranking.md` — how a candidate pool becomes a reading order.
- `references/semantic.md` — embeddings, the vector store, and why the two lanes are fused rather than chosen between.
- `references/orchestration.md` — declaring phases, and the two constraints the emitted workflow must obey.
- `references/skill-kit.md` — `skill.json`, the packaging gates, and the two ways a vendored engine goes wrong.
- `references/video.md` — the transcript ladder, runs, frames and corpora, and what each yt-dlp failure means.
- `references/browser.md` — the snapshot-and-ref loop, the safety rules, profiles, network capture, and the MCP browser tools.
