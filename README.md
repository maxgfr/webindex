# webindex

Find pages, turn them into clean citable text, rank what you found, and ask a code host or a
package registry about a project — from a library, from a command line, or over MCP.

Zero runtime dependencies. One ESM bundle plus one declaration file, plus a CLI. The
web-side companion to [codeindex](https://github.com/maxgfr/codeindex): codeindex indexes
the code you have locally, webindex fetches what is out there.

```bash
brew install maxgfr/tap/webindex
```

## Everything it does

Three surfaces over one engine: **308 library exports**, **26 CLI commands**, **15 MCP
tools**. Nothing below needs an API key, and every optional helper degrades to a note
rather than an error.

| Area | What you get |
|---|---|
| **Discovery** | A cascade: a local SearXNG, then the keyless engines (DuckDuckGo, DDG Lite, **Mojeek** — its own index, not a reseller), then Firecrawl. Pagination that stops when a page adds nothing new, cross-page dedupe, and throttled-upstream detection. `search` · `webindex_search` |
| **Retrieval** | HTTP with retry, **streaming byte caps** (the transfer is cancelled at the cap, not trimmed after), **conditional GET** (a stale cache entry costs a 304, not a re-download), rate-limit and `Retry-After` semantics, and **encoding detection** — BOM, `Content-Type` charset, `<meta charset>` — so a Windows-1252 page is not silently mojibake. `fetch` · `webindex_fetch` |
| **Extraction** | HTML→text with main-content isolation and consent-banner stripping; the **PDF ladder** (`pdf-inspector` → `anydoc` → Firecrawl → `pdftotext` → native → **OCR**) with a length-independent garbage gate; the **office ladder** over 20 formats; an explicit library primitive for Wayback rescue. `extract` · `webindex_extract` |
| **Ranking** | RRF fusion, **BM25F** with title/heading weighting and an off-topic floor, **SimHash** near-duplicate collapse, **MMR** diversification so the top of a list says several different things. Generic over your item type — the engine ranks, it never sees your evidence model. `rank` · `webindex_rank` |
| **Forges** | GitHub, GitLab and Gitea: issues, pull requests, releases, tags, and a repository's own record — stars, licence, last push, **archived**. Rename-following, GitHub Enterprise bases, and a quota reported rather than retried. `repo` `issues` `prs` `releases` |
| **Registries** | A library **name** → its repository, homepage, docs, current version, licence and **deprecation**, through npm, PyPI or crates.io. Bounded registry requests instead of a web search and a guess. `package` · `webindex_package` |
| **Repositories** | Every identifier shape — any URL scheme, `git@host:…`, `owner/repo`, `file://`, a local directory — onto one ref with a stable slug. Shallow blobless clones, deepened on demand. |
| **What a site publishes** | JSON-LD, OpenGraph and meta tags (author, dates, type, canonical); **robots.txt** with a real prefix-matcher; **sitemaps**, index-following bounded by your budget; **RSS/Atom** feeds and their discovery. `meta` `robots` `sitemap` `feed` |
| **Cache** | On-disk, keyed by canonical URL + locale + extractor, revalidating rather than re-downloading, with `stats` and eviction. `cache status\|clean` |
| **The container stack** | SearXNG, Firecrawl and the semantic pair, **embedded in the binary** — no checkout needed. `searxng` `firecrawl` `semantic` `stack` |
| **Semantic** | The other half of the stack this package already shipped. A local **Ollama** embedding client (no key, nothing leaves the machine), a **Qdrant** client, and `hybridSearch` — BM25F ⊕ dense, fused by RRF because the two fail in opposite directions and their scores share no scale. `embed` · `hybrid` · `webindex_embed` |
| **Crawling** | A per-host token bucket that finally *applies* the `Crawl-delay` robots.txt has always been parsed for, and `crawlSite` — a bounded BFS honouring robots at **every hop**. Following one citation is not crawling; enumerating a site is. `crawl` · `webindex_crawl` |
| **Change** | `fingerprint` and `hasChanged`: a 304 costs one round trip and no body, and the verdict says *how* it decided — etag and content-hash are different strengths of evidence. "Could not tell" is never reported as "unchanged". `changed` |
| **Tables** | `<table>` as headers and rows with `colspan`/`rowspan` resolved. Plain extraction flattens a table into prose in which every figure has lost its row and column — invisibly, because the result still reads well. `tables` · `webindex_tables` |
| **The harness** | What every skill built on this engine was rewriting: the run directory, a validating CLI parser with a real exit-code taxonomy, the multi-agent **fan-out emitter**, and the mechanics of reading citations out of a report. |
| **Skill packaging** | `webindex skill vendor\|check\|bundle\|copy\|doctor\|init` — the ~600 lines of packaging scripts each skill repo used to carry, driven by one `skill.json`. Dev-time, so it needs no vendoring and serves a repo that does not vendor this engine at all. |
| **MCP** | The whole protocol: version negotiation, cancellation, schema validation, an error taxonomy, and both stdio and HTTP transports. An oversized response is **withheld with advice**, never truncated. |

## The command line

| Command | What it does |
|---|---|
| `webindex search <query>` | Candidate URLs, through a cascade: a local SearXNG, then the keyless engines (DuckDuckGo, DDG Lite, Mojeek — no key, no container), then Firecrawl. Prints title, URL and snippet; `--json` returns them structured with the notes. `--limit <n>`, `--pages <n>` walk further, `--lang fr-FR` sets the result language, `--engine ddg\|ddglite\|mojeek\|off` pins or disables the keyless rung. Exits non-zero when it found nothing, and says on stderr which backend was missing. |
| `webindex rank --query <q>` | Order candidate documents against a question — BM25F with title and heading weighting, a SimHash collapse of near-duplicates, then MMR so the top of the list says several different things rather than restating one. Reads a JSON array of `{url,title,text}` from `--docs <file>` or stdin. Deterministic: no model, no network. |
| `webindex fetch <url>` | Fetch a URL and print its readable text. Routes PDFs and office documents to their ladders; HTML uses Firecrawl when available, then the built-in extractor, reducing the page to main content with consent banners dropped. `--full-page` keeps all page text through the built-in reader, including navigation and consent banners. `--json` adds the title, status, extractor, any note, `fullPage` and `consentDropped` (lines removed by the consent filter; 0 when skipped). `--lang fr-FR` sets Accept-Language, `--firecrawl <base>\|off` overrides the extractor. |
| `webindex extract <file>` | The same extraction on a file already on disk — PDF, office document, HTML or plain text. HTML is reduced to main content with consent banners dropped; `--full-page` keeps all page text, including navigation and consent banners. `--json` includes `fullPage` and `consentDropped` as above (0 for non-HTML). |
| `webindex mcp` | Serve the tools below to an agent. `--transport stdio` (default) or `http` with `--port`, `--bind`, `--allow-remote`. |
| `webindex searxng up\|down\|status` | Drive the keyless SearXNG container. |
| `webindex semantic up\|down\|status` | Drive Qdrant and Ollama, and pull the embedding model once they answer. |
| `webindex firecrawl up\|down\|status` | Drive Firecrawl, which cleans a page with a real headless browser. It delegates its own search to SearXNG, so this starts both. |
| `webindex stack up\|down\|status\|path` | Everything at once. `path` prints where the compose file was written. |
| `webindex cache status\|clean` | What the on-disk fetch cache holds — entries, size, how many are still fresh. `clean` drops the stale ones, `--all` drops every one. |
| `webindex crawl <url> --max <n>` | Walk a site from a seed, breadth-first, consulting robots.txt at **every hop** (and per origin with `--cross-origin`). `--max` is required: following one citation needs no permission, enumerating a site does, and an unbounded walk is the one thing here that can inconvenience somebody else's server. `--depth`, `--cross-origin`. Each depth is fetched as one wave, `WEBINDEX_CRAWL_CONCURRENCY` pages in flight (default 4), while one host still departs single-file. |
| `webindex tables <url>` | The page's tables as headers and rows, `colspan` and `rowspan` resolved. `--json` for the rows, otherwise markdown. |
| `webindex embed <text>` | A vector from the local Ollama — no key, nothing leaves the machine. Needs `webindex semantic up`. |
| `webindex hybrid --query <q>` | Rank documents with BM25F **and** a dense lane, fused by RRF. Each hit reports its rank in each lane. Degrades to the lexical half, with a note on stderr, when no embedding server answers. |
| `webindex changed <url>` | Fingerprint a URL, or — given `--etag` / `--hash` — say whether it changed and how it was decided. Exits non-zero on "could not tell", so a watcher never reads an error as "nothing to do". |
| `webindex skill <action>` | Packaging gates for a repo built on this engine, driven by its `skill.json`: `vendor` (pin by tag + sha256, `--check` for the offline drift/staleness gate), `check` (no module may re-declare an engine export), `bundle` (`skills add` would install a working skill), `copy`, `doctor`, `init`. |
| `webindex doctor` | Which optional helpers answer — SearXNG, Firecrawl, Ollama, Qdrant, the extraction rungs, OCR — on this machine. |
| `webindex version` | The engine version. |

Nothing above needs an API key, and nothing is required: every optional helper
degrades to a note rather than an error.

### The container stack is embedded

`searxng`, `firecrawl` and `stack` do not need a checkout. The compose file, the
SearXNG settings and the Firecrawl env are compiled into the binary and written
out on first use — so they work from a Homebrew cellar, a global npm install or a
vendored bundle alike.

The stack uses one fixed project name and one set of container names, so several
tools on the same machine share a single set of containers instead of fighting
over the same host ports.

`up` pulls the images first, on a budget of its own (`WEBINDEX_DOCKER_PULL_TIMEOUT_MS`,
20 minutes by default) — the Ollama image alone is over 1.6 GB, and letting `up`'s
shorter deadline cover the download turns a slow network into a failed start. It then
waits for every healthcheck, so a green `up` means the endpoints actually answer.

```bash
webindex firecrawl up      # searxng + firecrawl, detached, waits for health
webindex stack status
webindex stack path        # where the compose file landed, if you want to read it
```

## Combine with ChatGPT or Claude search

Use the host's native search to discover current sources, pass their URLs to
`webindex_fetch`, then rank the extracted `{url,title,text}` pool with
`webindex_rank`. Keep the source URLs for citations and inspect the passages
before answering. `webindex_search` can supplement the pool or take over when
native search is unavailable. Already have the URL? Fetch it directly.

This workflow uses the tools available in the calling host; webindex does not
call a ChatGPT or Claude search API itself. See the
[host search guide](references/host-search.md) for connection details and the
[verification report](docs/verification.md) for the actual trials and limits.

## The MCP server

`webindex mcp` exposes fifteen tools — primitives only. Point any MCP client at it:

```bash
claude mcp add webindex -- webindex mcp                    # stdio
claude mcp add --transport http webindex http://127.0.0.1:7340/mcp
```

| Tool | Arguments | Returns |
|---|---|---|
| `webindex_search` | `query` (required), `limit`, `lang`, `engine` | Candidate URLs with titles and snippets, through the same cascade as the CLI. Not page text — follow up with `webindex_fetch` on the ones worth reading. When nothing answers it fails loudly with which piece was missing, rather than returning an empty list that reads like "nothing exists". |
| `webindex_fetch` | `url` (required), `lang`, `fullPage` | The page's readable text plus the rung that produced it. Handles HTML, PDFs and office documents, using Firecrawl when available and local extraction as fallback. `fullPage: true` keeps all HTML page text through the built-in reader, including navigation and consent banners. Never raw bytes. |
| `webindex_extract` | `path` (required), `fullPage` | The same for a file already on disk; `fullPage: true` keeps navigation and consent banners too. |
| `webindex_rank` | `question` (required), `documents` (required), `limit` | The reading order for a pool of candidates: BM25F, near-duplicate collapse, then MMR. Returns each entry's score and matched query terms, plus how many duplicates were collapsed. The brick an agent otherwise re-implements — deterministic, no model, no network. |

The server implements `initialize`, `ping`, `tools/list`, `tools/call`,
`resources/list`, `resources/read`, `prompts/list`, `prompts/get`, and
`notifications/cancelled`. It negotiates protocol revisions from `2024-11-05` to
`2025-11-25`, validates arguments against each tool's declared schema, withholds
an oversized response rather than sending a truncated one, and distinguishes a
tool that failed (a readable `isError` result) from a client that asked wrongly
(a JSON-RPC error).

Over HTTP it binds loopback only unless `--allow-remote`, checks the `Origin`
header against DNS rebinding, and answers each request statelessly.


## What is in scope

A library of **primitives**, not a pipeline.

| Layer | What it owns |
|---|---|
| Discovery | the SearXNG JSON API and Firecrawl's `/search`, with pagination, cross-page dedupe, and throttled-upstream detection |
| Retrieval | HTTP with retry, **streaming** byte caps and conditional GET, HTML→text, main-content extraction, consent-banner stripping, Firecrawl, the PDF ladder (`pdf-inspector` → `anydoc` → Firecrawl → `pdftotext` → native → OCR), the office-document ladder, explicit Wayback rescue, the revalidating fetch cache |
| Text | keyword extraction, accent- and plural-folded matching, camelCase splitting, excerpting, URL canonicalisation and identity |
| Ranking | RRF fusion, BM25F with field weighting and a relevance floor, SimHash near-duplicate collapse, MMR diversification, DOI/arXiv identity, pool-relative recency |
| MCP | the whole protocol — negotiation, cancellation, schema validation, response capping, the error taxonomy — plus the stdio and HTTP transports |

Discovery is deliberately thin: one query to the local stack, candidates back. There is no
backend registry and no fan-out across twenty engines — a tool that wants its own cascade of
scholarly or vertical APIs builds it on these primitives.

Ranking is generic over the caller's item type: anything with a `url` and a `score` satisfies
it. The engine decides reading order; it never sees an evidence model.

`rescueViaWayback` is a library primitive callers invoke explicitly for a dead link.
The CLI and MCP fetch tool do not automatically substitute an archived page.

`httpGet` reports `bytesRead` and `truncated` for capped responses. A truncated
body cannot establish a complete content fingerprint; `hasChanged` returns an
unknown verdict in that case. Document MIME types receive the 16 MB extraction
budget even when the URL has no file extension, and explicit HTTP byte limits
remain authoritative.

The crawler checks its origin and robots restrictions before each redirected
request, including sitemap requests, and resolves links against the final URL.
The origin boundary also applies to robots.txt redirects.
It uses local extraction so a remote browser cannot bypass those checks.
Library callers can supply the same asynchronous `authorizeUrl` check to
`httpGet`, `fetchAndExtract`, `fetchSitemap`, and `fetchRobots`. Authorization
and politeness waits do not consume the HTTP network timeout budget.

## What is deliberately out of scope

The line is **mechanics versus policy**, not subject matter — and it runs through the middle
of citation gates rather than around them.

Reading a report is mechanics, and the engine owns it: which bracketed tokens are citations
and which are markdown links, that a `[S1]` inside backticks or a code fence or a
`## Sources` appendix grounds nothing, what a claim unit is, which figures a claim asserts.
Six skills had their own regex for that, and the subtle cases are exactly where independent
copies disagree.

The verdict is policy, and stays with the tool. Nothing in `src/cite.ts` returns a pass or a
fail — no `runCheck`, no `ok: boolean`, no threshold, no severity, and a test asserts there
never will be one. What counts as grounded, what coverage is sufficient, whether an uncited
claim is an error or a warning, how sources are numbered and where they are written: those
are the sentences a tool's users argue about, and answering them here would dictate behaviour
rather than share plumbing.

Evidence models and document layouts stay out entirely, for the same reason.

## The vendoring contract

A consumer does **not** `npm install webindex`. It copies the two published files into
`src/vendor/`, pinned by tag and SHA-256, and lets its own bundler inline them — so it
still ships as a single file that runs under `node` with no install:

```bash
node scripts/sync-engine.mjs --ref v1.7.2   # fetch + pin
node scripts/sync-engine.mjs --check        # offline drift/tamper gate, runs in CI
```

The fetched bytes are written unmodified; `engine.meta.json` records the tag, version and
per-file SHA-256, and `--check` re-hashes the vendored files against it. `ENGINE_VERSION`
is embedded in the bundle, and a pin whose tag disagrees with those bytes is refused.

Three consequences constrain every change here:

- **No runtime dependencies, ever.** A vendored file cannot resolve bare specifiers. CI
  fails the build if any import is not a `node:` builtin.
- **Node 18 is the runtime floor.** A dedicated CI job runs the committed bundle on Node 18
  with no install. Development uses Node ≥22.22.2 and pnpm 11 because the release toolchain
  requires it.
- **No module-scope environment reads.** See below.

## Brand injection

The engine has no identity of its own at runtime. Each consumer declares one, once:

```ts
import { configure } from "./vendor/webindex-engine.mjs";

configure({ name: "reader", envPrefix: "READER", cli: "reader" });
```

Everything the user already exports keeps working unchanged — `READER_SEARXNG`,
`READER_FIRECRAWL`, `READER_PDF_ENGINE` — because the engine reads `env("SEARXNG")` and
resolves the prefix at call time. Notes that name a command take it from `brand().cli`, so
the output says `reader fetch --url`, not `webindex`.

**The lazy rule.** A vendored bundle is imported by the consumer's entry module, so this
package's top-level code runs *before* the consumer's first statement — before
`configure()` can possibly have been called. A module-scope
`const UA = env("UA") ?? "…"` would therefore capture the default brand forever and
silently ignore the real prefix. Keep every tunable behind a function. `src/brand.ts`
documents this at length; it is the one invariant that makes vendoring possible at all.

## Development

```bash
pnpm install
pnpm run typecheck && pnpm run lint
pnpm test
pnpm run bench              # micro-benchmarks of the hot paths (bench/*.bench.ts), offline
pnpm run build              # tsup + rename the declaration output to .d.mts
pnpm run check:build        # the committed artifacts are reproducible
pnpm run verify:vendorable  # nothing but Node builtins, declarations self-contained
pnpm run verify:standalone  # a third-party consumer, built elsewhere on disk, works
```

Releases are Conventional-Commit-driven via semantic-release. The built artifacts are
committed on every release, because consumers fetch them from the repository tree at the
pinned tag.

## License

MIT

### Shared consumer maintenance

Consumer repositories declare engines, minimum versions, usage exceptions and their
validation hooks in `skill.json`. The development-only CLI is installed from an
immutable GitHub release archive; its runtime engine is vendored only when the skill
actually needs web retrieval. `skill vendor --check` remains fully offline.

`webindex skill repin` compares all stable releases numerically, resolves each tag
to a commit, verifies the downloaded version before replacing files, and updates
the maintenance CLI as an exact development dependency. `skill finish` waits for CI and
publication, resuming interrupted dispatches even when no pin changed. The reusable
workflow is `.github/workflows/skill-repin.yml`; consumers implement `engine:prepare`
and `engine:gate` and declare the paths allowed into its candidate commit.

`skill recall` compares regenerated JSON to baseline elements and their evidence;
added fields and members are allowed, replaced identities are not. Numeric direction
and volatile fields are explicit consumer policy. Changed prose and unsupported
snapshot formats require review instead of being approved by line counts. A changed
baseline is committed deliberately after its semantic difference is validated.

The reusable workflow reference is pinned separately from the development CLI.
GitHub's default automation token cannot modify workflow definitions, so `skill repin`
updates runtime engines and the maintenance dependency without editing `.github/workflows`.
A maintainer can advance the immutable workflow reference after reviewing a workflow change.
The stable shell continues to execute the consumer's prepare/gate scripts and the current CLI.

## Manual skill invocation

These skills run when explicitly invoked: `webindex`. Use `$name` in Codex or `/name` in Claude Code and OpenCode (with the plugin namespace when installed as a Claude plugin).

The skill bundle disables implicit selection in Codex and Claude Code. OpenCode V2 reads `metadata.opencode/autoinvoke: "false"`. For OpenCode V1, merge these entries into `permission.skill` in `~/.config/opencode/opencode.json` or the project configuration; retain unrelated permissions:

```json
{
  "permission": {
    "skill": {
      "webindex": "deny"
    }
  }
}
```

On OpenCode 1.18.30, these rules hide the skills from the agent and reject skill-tool loading, while explicit `/name` commands remain available. Installation with `skills add` does not apply this OpenCode V1 configuration.
