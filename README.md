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

Three surfaces over one engine: **308 library exports**, **27 CLI commands**, **16 MCP
tools**. Nothing below needs an API key, and every optional helper degrades to a note
rather than an error.

| Area | What you get |
|---|---|
| **Discovery** | A cascade: a local SearXNG, then the keyless engines (DuckDuckGo, DDG Lite, **Mojeek** — its own index, not a reseller), then Firecrawl. Pagination that stops when a page adds nothing new, cross-page dedupe, and throttled-upstream detection. `search` · `webindex_search` |
| **Retrieval** | HTTP with retry, **streaming byte caps** (the transfer is cancelled at the cap, not trimmed after), **conditional GET** (a stale cache entry costs a 304, not a re-download), rate-limit and `Retry-After` semantics, and **encoding detection** — BOM, `Content-Type` charset, the XML declaration, `<meta charset>` (HTML only), then a UTF-8 validity check that falls back to Windows-1252 — so an undeclared Latin-1 page or feed is not silently mojibake. `fetch` · `webindex_fetch` |
| **Extraction** | HTML→text with main-content isolation and consent-banner stripping; the **PDF ladder** (`pdf-inspector` → `anydoc` → Firecrawl → `pdftotext` → native → **OCR**) with a length-independent garbage gate; the **office ladder** over 20 formats (`anydoc` → Firecrawl → a built-in OOXML/OpenDocument reader that needs no network); an explicit library primitive for Wayback rescue. `extract` · `webindex_extract` |
| **Ranking** | RRF fusion, **BM25F** with title/heading weighting and an off-topic floor, **SimHash** near-duplicate collapse, **MMR** diversification so the top of a list says several different things. Generic over your item type — the engine ranks, it never sees your evidence model. `rank` · `webindex_rank` |
| **Forges** | GitHub, GitLab and Gitea: issues, pull requests, releases, tags, and a repository's own record — stars, licence, last push, **archived**. Rename-following, GitHub Enterprise and self-hosted forges (`--forge`, `WEBINDEX_FORGE_HOSTS`), a token sent only to its own host, a quota reported rather than retried, and every failure named — no such repository, rejected token, quota and its reset, outage, network. `repo` `issues` `prs` `releases` `tags` · `webindex_repo` `webindex_issues` `webindex_releases` `webindex_tags` |
| **Registries** | A library **name** → its repository, homepage, docs, current version, licence and **deprecation**, through npm, PyPI or crates.io. Bounded registry requests instead of a web search and a guess. `package` · `webindex_package` |
| **Repositories** | Every identifier shape — any URL scheme (ssh remotes keep their transport), `git@host:…`, `owner/repo`, a URL copied from a browser, `file://`, a local directory — onto one ref with a stable slug that two repositories never share. Shallow blobless clones, one per branch, cloned once however many callers ask, deepened on demand. |
| **What a site publishes** | JSON-LD, OpenGraph and meta tags (author, dates, type, canonical); **robots.txt** read the way RFC 9309 says, with a linear-time wildcard matcher; **sitemaps** — XML, gzipped or plain text, up to the protocol's 50 MB — index-following bounded by your budget, naming the children it did not reach; **RSS, Atom and JSON Feed**, entry links made absolute, and their discovery. `meta` `robots` `sitemap` `feed` |
| **Cache** | On-disk, keyed by canonical URL + locale + extractor (and consent-stripped or full-page reads apart), revalidating rather than re-downloading — a failing origin is asked once before the stale copy is served — with `stats` and eviction. `cache status\|clean` |
| **The container stack** | SearXNG, Firecrawl and the semantic pair, **embedded in the binary** — no checkout needed. `searxng` `firecrawl` `semantic` `stack` |
| **Semantic** | The other half of the stack this package already shipped. A local **Ollama** embedding client (no key, nothing leaves the machine), a **Qdrant** client, and `hybridSearch` — BM25F ⊕ dense, fused by RRF because the two fail in opposite directions and their scores share no scale. `embed` · `hybrid` · `webindex_embed` |
| **Crawling** | A per-host token bucket that finally *applies* the `Crawl-delay` robots.txt has always been parsed for, and `crawlSite` — a bounded BFS honouring robots at **every hop**. Following one citation is not crawling; enumerating a site is. `crawl` · `webindex_crawl` |
| **Change** | `fingerprint` and `hasChanged`: a 304 costs one round trip and no body, and the verdict says *how* it decided — etag and content-hash are different strengths of evidence, and once a body has been downloaded its hash (over the raw bytes, up to 64 MB) outranks the validators. "Could not tell" is never reported as "unchanged". `changed` |
| **Tables** | `<table>` as headers and rows with `colspan`/`rowspan` resolved. Plain extraction flattens a table into prose in which every figure has lost its row and column — invisibly, because the result still reads well. `tables` · `webindex_tables` |
| **The harness** | What every skill built on this engine was rewriting: the run directory, a validating CLI parser with a real exit-code taxonomy, the multi-agent **fan-out emitter**, and the mechanics of reading citations out of a report. |
| **Skill packaging** | `webindex skill vendor\|check\|bundle\|copy\|doctor\|init` — the ~600 lines of packaging scripts each skill repo used to carry, driven by one `skill.json`. Dev-time, so it needs no vendoring and serves a repo that does not vendor this engine at all. |
| **MCP** | The whole protocol: version negotiation, cancellation, schema validation, an error taxonomy, and both stdio and HTTP transports. An oversized response is **withheld with advice**, never truncated. |

## The command line

| Command | What it does |
|---|---|
| `webindex search <query>` | Candidate URLs, through a cascade: a local SearXNG, then the keyless engines (DuckDuckGo, DDG Lite, Mojeek — no key, no container), then Firecrawl. Prints title, URL and snippet; `--json` returns them structured with the notes, each rung's outcome (`rungs`: hits, empty, blocked, throttled, unreachable…) and `searched` — false when no rung answered, so an empty result there is not a finding. `--limit <n>`, `--pages <n>` walk further, `--lang fr-FR` sets the result language, `--region ca` the country (overriding the one the language implies; `wt` for none), `--engine ddg\|ddglite\|mojeek\|off` narrows the keyless rung to one engine or disables it. `--timeout <ms>` bounds the whole cascade — every rung and page — and names the rungs it never reached. Exits non-zero when it found nothing, and says on stderr which backend was missing. |
| `webindex rank --query <q>` | Order candidate documents against a question — BM25F with title and heading weighting, a SimHash collapse of near-duplicates, then MMR so the top of the list says several different things rather than restating one — over the best max(5 × `--limit`, 100), the rest following by relevance. Reads a JSON array of `{url,title,text}` from `--docs <file>` or stdin; a document's own `score` (its search engine's relevance) is fused with BM25F by rank, but never lifts one that shares no term with the question. Warns when no document matched at all. Deterministic: no model, no network — unless `--dense` fuses in the local embedding lane first, which degrades to BM25F with a note when no embedding server answers. |
| `webindex fetch <url>` | Fetch a URL and print its readable text. Routes PDFs and office documents to their ladders — by URL, content-type, download filename or the bytes themselves; images, media and archives get a note, never their bytes. HTML uses Firecrawl when available, then the built-in extractor, reducing the page to main content with consent banners dropped. `--full-page` keeps all page text through the built-in reader, including navigation and consent banners. `--json` adds `finalUrl` (where the text came from, after redirects), `canonical`, the title, status, extractor, `documentType`, `cached`, any note, `fullPage` and `consentDropped` (lines removed by the consent filter; 0 when skipped). Caching is opt-in: `--cache` reuses a fresh copy for the TTL (24 h) and revalidates a stale one with a conditional GET, so an unchanged page costs a 304; `--refresh` re-fetches and rewrites the entry; `--offline` serves only what the cache holds. `--lang fr-FR` sets Accept-Language, `--firecrawl <base>\|off` overrides the extractor. `--timeout <ms>` abandons a host that stays silent that long (default 20000, or `WEBINDEX_TIMEOUT_MS`); a timed-out request is not retried, so that is the real worst case. A failure names its cause — a refused connection, an unknown host, a redirect loop, a timeout — and one that cannot change on a second try is not retried. |
| `webindex extract <file>` | The same extraction on a file already on disk — PDF, office document, HTML or plain text, recognised by its bytes when its name says otherwise; a CSV nothing can convert is read as its text, and a binary file is refused rather than printed. HTML is reduced to main content with consent banners dropped; `--full-page` keeps all page text, including navigation and consent banners. `--json` includes `fullPage` and `consentDropped` as above (0 for non-HTML). |
| `webindex repo\|issues\|prs\|releases\|tags <ref>` | What GitHub, GitLab or Gitea records about a repository: its facts (stars, licence, last push, archived), an issue or PR search (`--terms`; relaxed once to the most distinctive terms, and said so, when all of them match nothing), releases, tags. `<ref>` is `owner/repo`, any repository URL — one copied from a browser works — `git@host:owner/repo`, or a local checkout, read as its origin. `--forge github\|gitlab\|gitea` names what a self-hosted host runs; `WEBINDEX_FORGE_HOSTS` declares it once, and is also what lets a token go there. A failure says which one it was. |
| `webindex mcp` | Serve the tools below to an agent. `--transport stdio` (default) or `http` with `--port`, `--bind`, `--allow-remote`. |
| `webindex searxng up\|down\|status` | Drive the keyless SearXNG container. |
| `webindex semantic up\|down\|status` | Drive Qdrant and Ollama, and pull the embedding model once they answer. |
| `webindex firecrawl up\|down\|status` | Drive Firecrawl, which cleans a page with a real headless browser. It delegates its own search to SearXNG, so this starts both. |
| `webindex stack up\|down\|status\|path` | Everything at once. `path` prints where the compose file was written. |
| `webindex cache status\|clean` | What the on-disk fetch cache holds — entries, size, how many are still fresh. `clean` drops the stale ones, `--all` drops every one, and either sweeps the cache's own orphaned bodies and temp files. Both count and remove only files the cache wrote, never anything else in the directory. The directory is `WEBINDEX_CACHE_DIR`, else per user under the temp dir (`webindex-<uid>/cache`); `WEBINDEX_CACHE_TTL_HOURS` (fractions allowed) sets how long an entry stays fresh. |
| `webindex crawl <url> --max <n>` | Walk a site from a seed, breadth-first, consulting robots.txt at **every hop** (and per origin with `--cross-origin`). `--max` is required: following one citation needs no permission, enumerating a site does, and an unbounded walk is the one thing here that can inconvenience somebody else's server. `--max` counts pages returned: a failed fetch costs none, but a crawl makes at most **3 × `--max` page requests**, so a sitemap full of dead links cannot run it on. The walk stays on the origin the seed lands on — its own `http`→`https` or `www` redirect included — and seeds itself from the sitemap (`--no-sitemap` skips it; a seed below the root, `/docs/`, takes only its own section's entries, after its own links). `--prefix /docs/` keeps links and sitemap entries under a path; `--depth`, `--cross-origin`. Links to images, media, fonts and archives are not fetched, and a page reached through two redirects is read once. A robots.txt that answers 5xx or not at all stops the crawl (RFC 9309), as does a `Crawl-delay` over `WEBINDEX_MAX_CRAWL_DELAY_MS` (default 60 s). Each depth is fetched as one wave, `WEBINDEX_CRAWL_CONCURRENCY` pages in flight (default 4), while one host still departs single-file, and a `Retry-After` holds the whole host. |
| `webindex tables <url>` | The page's tables as headers and rows, `colspan` and `rowspan` resolved. `--json` for the rows, otherwise markdown. |
| `webindex embed <text>` | A vector from the local Ollama — no key, nothing leaves the machine. Needs `webindex semantic up`. `--docs <file.json\|->` embeds a JSON array of strings (`--lines`: one text per line) in one run, in input order. |
| `webindex hybrid --query <q>` | Rank documents with BM25F **and** a dense lane, fused by RRF. Each hit reports its rank in each lane. The dense lane sends the model its task prefixes — nomic's `search_query:` / `search_document:`, mxbai's, e5's; `WEBINDEX_EMBED_QUERY_PREFIX` / `WEBINDEX_EMBED_DOC_PREFIX` override them — and at most `WEBINDEX_EMBED_MAX_CHARS` (8000) of each document. Degrades to the lexical half, with a note on stderr, when no embedding server answers. |
| `webindex changed <url>` | Fingerprint a URL, or — given `--etag` / `--last-modified` / `--hash` — say whether it changed and how it was decided. A baseline prints `etag`, `last-modified`, `hash` (SHA-256 of the raw bytes, what `sha256sum` of the download gives) and `status`, and exits non-zero instead of printing one it could not read. `--timeout <ms>` bounds the request. Exits non-zero on "could not tell", so a watcher never reads an error as "nothing to do". |
| `webindex skill <action>` | Packaging gates for a repo built on this engine, driven by its `skill.json`: `vendor` (pin by tag + sha256, `--check` for the offline drift/staleness gate), `check` (no module may re-declare an engine export), `bundle` (`skills add` would install a working skill), `copy`, `doctor`, `init`. |
| `webindex doctor` | Which optional helpers answer — SearXNG, Firecrawl, Ollama, Qdrant — and what each extraction rung will do on this machine: installed, downloads on first use, not installed, built-in, or switched off and by which variable. The npx rungs are checked against npm's cache, never installed. |
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

`webindex mcp` exposes sixteen tools — primitives only. Point any MCP client at it:

```bash
claude mcp add webindex -- webindex mcp                    # stdio
claude mcp add --transport http webindex http://127.0.0.1:7340/mcp
```

| Tool | Arguments | Returns |
|---|---|---|
| `webindex_search` | `query` (required), `limit`, `lang`, `region`, `pages` (at most 5), `engine` | Candidate URLs with titles and snippets, through the same cascade as the CLI. Not page text — follow up with `webindex_fetch` on the ones worth reading. When nothing answers it fails loudly with which piece was missing, rather than returning an empty list that reads like "nothing exists". Its last line names each rung's outcome (`rungs: searxng=unreachable ddg=blocked …`). |
| `webindex_fetch` | `url` (required), `lang`, `fullPage`, `timeoutMs`, `cache` | The page's readable text, then a trailer naming the final URL after redirects, its canonical URL and title, any note, and the rung that produced it. Handles HTML, PDFs and office documents, using Firecrawl when available and local extraction as fallback. `fullPage: true` keeps all HTML page text through the built-in reader, including navigation and consent banners. `timeoutMs` shortens the wait on a silent host. `cache: true` uses the revalidating on-disk cache (off by default): a fresh copy is reused for its TTL, a stale one costs a 304 when unchanged. Never raw bytes. |
| `webindex_extract` | `path` (required), `fullPage` | The same for a file already on disk; `fullPage: true` keeps navigation and consent banners too. |
| `webindex_rank` | `question` (required), `documents` (required), `limit`, `dense` | The reading order for a pool of candidates: BM25F, near-duplicate collapse, then MMR. A document's own `score` is fused with BM25F by rank; `dense: true` fuses in the local embedding lane too (a `note` says when there is none). Returns each entry's score and matched query terms, plus how many duplicates were collapsed and, in `duplicates`, each dropped mirror's URL with the URL it duplicated. The brick an agent otherwise re-implements — deterministic, no model, no network unless `dense` asks for one. |

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
| Retrieval | HTTP with retry, **streaming** byte caps and conditional GET, HTML→text, main-content extraction, consent-banner stripping, Firecrawl, the PDF ladder (`pdf-inspector` → `anydoc` → Firecrawl → `pdftotext` → native → OCR), the office-document ladder (`anydoc` → Firecrawl → built-in), explicit Wayback rescue, the revalidating fetch cache |
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

`httpGet` reports `bytesRead` and `truncated` for capped responses. A text body
over the cap is read as its capped prefix whether or not the server declared its
length — only a document, or the answer to a Range request, declared over its
cap is refused unread — and `fetchAndExtract` marks such a prefix with
`truncated: true` and a note. A truncated body cannot establish a complete
content fingerprint; `hasChanged` returns an unknown verdict in that case. Document MIME types receive the 16 MB extraction
budget even when the URL has no file extension, and explicit HTTP byte limits
remain authoritative.

`fetchAndExtract` routes on what the bytes are, not only on what the URL and the
headers claim. A body behind a type that says nothing — `application/octet-stream`,
`application/zip`, a download type, or none at all — is sniffed with `sniffDocument`
(a PDF header, an OOXML or OpenDocument package, an OLE or RTF signature), and a
`Content-Disposition` filename counts as a claim too (`httpGet` reports it as
`filename`). Such a body gets the document budget and is never decoded into a
string nobody reads. A `.pdf` or office URL that answers with HTML is read as the
web page it is, with a note saying so; images, audio, video, fonts and archives
return no text and a note, never their bytes. `webindex extract` sniffs the same
way, so an extension-less or misnamed file is read for what it is.

The extraction ladders tell a tool that cannot run here from one that rejected a
document. A rung is set aside for the rest of the process only when its binary or
npx is missing, npm could not install its package, or its first run never finished
— never because one truncated PDF or one scan made it exit 1 — and a refusal names
what the tool itself said. The npx rungs run with a fail-fast npm network policy
(`npm_config_fetch_retries=1`, a 1–2 s back-off, a 30 s fetch timeout) unless those
keys are already set in the environment, so an offline machine falls through in
seconds rather than ~70 s per rung; once the registry proved unreachable the other
npx rung is not asked, and the note says `WEBINDEX_NO_NPX=1` skips them.
`WEBINDEX_NPX_TIMEOUT_MS` bounds one npx run (default 90000, first download included).
Each package's executable is located once per process and then run directly, so
npm's start-up (~0.6 s) is paid once rather than per document; on Windows the rungs
keep running through `npx`.

The office ladder ends in a built-in reader (`officeToText`) for OOXML (`.docx`,
`.xlsx`, `.pptx`) and OpenDocument (`.odt`, `.ods`, `.odp`): no subprocess, no
network, so an offline or `WEBINDEX_NO_NPX` run still reads them —
`WEBINDEX_DOC_ENGINE=builtin` forces it. It returns headings, lists, tables, each
sheet as a table and each slide with its speaker notes, and it is strict about
the ZIP it opens: ZIP64, encrypted entries and unknown compression methods are
refused, and every entry, the whole archive and the text it produces are capped,
so a decompression bomb costs 64 MB of work, not its full size. Its output passes
the same garbage gate as every other rung. Legacy `.doc`/`.xls`/`.ppt` and RTF
still need `anydoc` or Firecrawl.

A `Retry-After` of up to 5 s is waited out and retried once; a longer one is
not slept through and not retried early — the call returns at once with the
server's own `retryAfterMs` (and `rateLimited`), which `fetchAndExtract` carries
on its result and `crawlSite` turns into a back-off for the whole host. The short
wait does too: `httpGet`'s `onBackOff` reports it before sleeping, so a crawl's
other requests to that host wait with it instead of going out inside the window.

The crawler checks its origin and robots restrictions before each redirected
request, including sitemap requests, and resolves links against the final URL.
The origin is the one the seed's own redirect lands on — `http://example.com`
that answers from `https://www.example.com` is crawled there. The origin
boundary also applies to robots.txt redirects, which may move only within their
own site (`https`, `www`).
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
