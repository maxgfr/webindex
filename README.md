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

Three surfaces over one engine: **365 library exports**, **28 CLI commands**, **20 MCP
tools**. Nothing below needs an API key, and every optional helper degrades to a note
rather than an error.

| Area | What you get |
|---|---|
| **Discovery** | A cascade: a local SearXNG, then the keyless engines (DuckDuckGo, DDG Lite, **Mojeek** — its own index, not a reseller), then Firecrawl. Pagination that stops when a page adds nothing new, cross-page dedupe, and throttled-upstream detection. `search` · `webindex_search` |
| **Retrieval** | HTTP with retry, **streaming byte caps** (the transfer is cancelled at the cap, not trimmed after), **conditional GET** (a stale cache entry costs a 304, not a re-download), rate-limit and `Retry-After` semantics, and **encoding detection** — BOM, `Content-Type` charset, the XML declaration, `<meta charset>` (HTML, or a body served as a download type that turns out to be HTML), then a UTF-8 check that falls back to Windows-1252 when the bytes do not read as UTF-8 — so an undeclared Latin-1 page or feed is not silently mojibake, and one stray byte does not turn a UTF-8 page into it. `fetch` · `webindex_fetch` |
| **Extraction** | HTML→text — or HTML→CommonMark with absolute links, fenced code, nested lists and GFM tables (`--format markdown`), the shape Firecrawl returns — with main-content isolation and consent-banner stripping; the **PDF ladder** (`pdf-inspector` → `anydoc` → Firecrawl → `pdftotext` → native → **OCR**) with a length-independent garbage gate; the **office ladder** over 20 formats (`anydoc` → Firecrawl → a built-in OOXML/OpenDocument reader that needs no network); the **video ladder** for YouTube (manual subtitles → original auto-captions → local whisper), timestamped and chaptered; an explicit library primitive for Wayback rescue. `extract` · `webindex_extract` |
| **Ranking** | RRF fusion, **BM25F** with title/heading weighting and an off-topic floor, **SimHash** near-duplicate collapse, **MMR** diversification so the top of a list says several different things. Generic over your item type — the engine ranks, it never sees your evidence model. `rank` · `webindex_rank` |
| **Forges** | GitHub, GitLab and Gitea: issues, pull requests, releases, tags, and a repository's own record — stars, licence, last push, **archived**. Rename-following, GitHub Enterprise and self-hosted forges (`--forge`, `WEBINDEX_FORGE_HOSTS`), a token sent only to its own host, a quota reported rather than retried, and every failure named — no such repository, rejected token, quota and its reset, outage, network. `repo` `issues` `prs` `releases` `tags` · `webindex_repo` `webindex_issues` `webindex_releases` `webindex_tags` |
| **Registries** | A library **name** → its repository, homepage, docs, current version, licence and **deprecation**, through npm, PyPI or crates.io. Bounded registry requests instead of a web search and a guess. `package` · `webindex_package` |
| **Repositories** | Every identifier shape — any URL scheme (ssh remotes keep their transport), `git@host:…`, `owner/repo`, a URL copied from a browser, `file://`, a local directory — onto one ref with a stable slug that two repositories never share. Shallow blobless clones, one per branch, cloned once however many callers ask, deepened on demand. |
| **What a site publishes** | JSON-LD, OpenGraph and meta tags (author, dates, type, canonical); **robots.txt** read the way RFC 9309 says, with a linear-time wildcard matcher; **sitemaps** — XML, gzipped or plain text, up to the protocol's 50 MB — index-following bounded by your budget, naming the children it did not reach; **RSS, Atom and JSON Feed**, entry links made absolute, and their discovery. `meta` `robots` `sitemap` `feed` |
| **Cache** | On-disk, keyed by canonical URL + locale + extractor (and consent-stripped, full-page and Markdown reads apart), revalidating rather than re-downloading — a failing origin is asked once before the stale copy is served — with `stats` and eviction. `cache status\|clean` |
| **The container stack** | SearXNG, Firecrawl and the semantic pair, **embedded in the binary** — no checkout needed. `searxng` `firecrawl` `semantic` `stack` |
| **Semantic** | The other half of the stack this package already shipped. A local **Ollama** embedding client (no key, nothing leaves the machine), a **Qdrant** client, and `hybridSearch` — BM25F ⊕ dense, fused by RRF because the two fail in opposite directions and their scores share no scale. `embed` · `hybrid` · `webindex_embed` |
| **Crawling** | A per-host token bucket that finally *applies* the `Crawl-delay` robots.txt has always been parsed for, and `crawlSite` — a bounded BFS honouring robots at **every hop**. Following one citation is not crawling; enumerating a site is. `crawl` · `webindex_crawl` |
| **Change** | `fingerprint` and `hasChanged`: a 304 costs one round trip and no body, and the verdict says *how* it decided — etag and content-hash are different strengths of evidence, and once a body has been downloaded its hash (over the raw bytes, up to 64 MB) outranks the validators. "Could not tell" is never reported as "unchanged". `changed` |
| **Tables** | `<table>` as headers and rows with `colspan`/`rowspan` resolved. Plain extraction flattens a table into prose in which every figure has lost its row and column — invisibly, because the result still reads well. `tables` · `webindex_tables` |
| **The harness** | What every skill built on this engine was rewriting: the run directory, a validating CLI parser with a real exit-code taxonomy, the multi-agent **fan-out emitter**, and the mechanics of reading citations out of a report. |
| **Skill packaging** | `webindex skill vendor\|check\|bundle\|copy\|doctor\|init\|repin\|finish\|recall` — the ~600 lines of packaging scripts each skill repo used to carry, driven by one `skill.json`. Dev-time, so it needs no vendoring and serves a repo that does not vendor this engine at all. |
| **MCP** | The whole protocol: version negotiation, cancellation that stops the work (not only the answer), progress, schema validation, an error taxonomy, and both stdio and HTTP transports — with opt-in walls for a server others can reach: public addresses only, one directory, a bearer token. An oversized response is **withheld with advice**, never truncated. |

## The command line

| Command | What it does |
|---|---|
| `webindex search <query>` | Candidate URLs, through a cascade: a local SearXNG, then the keyless engines (DuckDuckGo, DDG Lite, Mojeek — no key, no container), then Firecrawl. Prints title, URL and snippet; `--json` returns them structured with the notes, each rung's outcome (`rungs`: hits, empty, blocked, throttled, unreachable…) and `searched` — false when no rung answered, so an empty result there is not a finding. `--limit <n>`, `--pages <n>` walk further, `--lang fr-FR` sets the result language, `--region ca` the country (overriding the one the language implies; `wt` for none), `--engine ddg\|ddglite\|mojeek\|off` narrows the keyless rung to one engine or disables it. `--timeout <ms>` bounds the whole cascade — every rung and page — and names the rungs it never reached. Exits non-zero when it found nothing, and says on stderr which backend was missing. |
| `webindex rank --query <q>` | Order candidate documents against a question — BM25F with title and heading weighting, a SimHash collapse of near-duplicates, then MMR so the top of the list says several different things rather than restating one — over the best max(5 × `--limit`, 100), the rest following by relevance. Reads a JSON array of `{url,title,text}` from `--docs <file>` or stdin; a document's own `score` (its search engine's relevance) is fused with BM25F by rank, but never lifts one that shares no term with the question. Warns when no document matched at all. Deterministic: no model, no network — unless `--dense` fuses in the local embedding lane first, which degrades to BM25F with a note when no embedding server answers. |
| `webindex fetch <url> [<url> …]` | Fetch a URL and print its readable text. Routes PDFs and office documents to their ladders — by URL, content-type, download filename or the bytes themselves; images, media and archives get a note, never their bytes. HTML uses Firecrawl when available, then the built-in extractor, reducing the page to main content with consent banners dropped. `--full-page` keeps all page text through the built-in reader, including navigation and consent banners. `--format markdown` writes the page as CommonMark — headings, links and images with absolute URLs (resolved against the final URL, or the page's `<base href>`), emphasis, inline and fenced code (with the language a `language-x` class names), nested lists, blockquotes and GFM tables — the shape a Firecrawl fetch returns, so the answer no longer depends on which extractor ran; the default, `text`, keeps headings as `#` lines and flattens the rest. Firecrawl's Markdown is used as it comes either way, PDFs and office documents keep their text, and the cache keeps the two formats apart. `--json` adds `finalUrl` (where the text came from, after redirects), `canonical`, the title, status, extractor, `documentType`, `cached`, any note, `fullPage` and `consentDropped` (lines removed by the consent filter; 0 when skipped). Caching is opt-in: `--cache` reuses a fresh copy for the TTL (24 h) and revalidates a stale one with a conditional GET, so an unchanged page costs a 304; `--refresh` re-fetches and rewrites the entry; `--offline` serves only what the cache holds. `--lang fr-FR` sets Accept-Language, `--firecrawl <base>\|off` overrides the extractor. `--timeout <ms>` is how long one attempt may take, connection and body download included, before it is abandoned (default 20000, or `WEBINDEX_TIMEOUT_MS`); a timed-out request is not retried, so that is the real worst case. A failure names its cause — a refused connection, an unknown host, a redirect loop, a timeout — and one that cannot change on a second try is not retried. Given several URLs, it reads `WEBINDEX_FETCH_CONCURRENCY` of them at a time (default 4) and prints each page under a `==> <url> <==` header in the order given (`--json`: an array of the objects above, in that order, failures included); a URL with nothing readable is named on stderr, and the command fails only when every one of them did. One URL prints exactly as it always has. A **video** URL — YouTube (`watch?v=`, `youtu.be`, `/shorts/`, `/embed/`, `/live/`), Vimeo (read through its player, which needs no login), Dailymotion, Twitch, TED, Loom, TikTok, Instagram reels, Facebook videos, X posts, Bilibili, Rumble — returns its transcript instead of the watch page (a post there with no video is read as the page it is): Markdown with the title, channel, date, duration and source, a `##` heading per chapter and a `[mm:ss]` stamp on every paragraph — from the manual subtitles (WebVTT or SRT), else the video's own auto-captions (never one of YouTube's machine translations; rolling captions de-duplicated), else a local **whisper** transcription (`uvx whisper-ctranslate2`, budgeted by `WEBINDEX_WHISPER_MAX`), each behind a words-per-minute gate. It needs [yt-dlp](https://github.com/yt-dlp/yt-dlp); `--lang` picks the subtitle language, `extractor` names the rung, `documentType` is `video`, the header names the subtitle track and flags one in another language than the video's as a translation, a live stream is left until it has ended, and a private, members-only, age-restricted or removed video — or a YouTube refusal — comes back as a note saying which. |
| `webindex extract <file>` | The same extraction on a file already on disk (`-` reads stdin) — PDF, office document, HTML or plain text, recognised by its bytes when its name says otherwise; a CSV nothing can convert is read as its text, and a binary file is refused rather than printed. HTML is reduced to main content with consent banners dropped; `--full-page` keeps all page text, including navigation and consent banners, and `--format markdown` writes it as CommonMark as `fetch` does (relative links resolve only against a saved page's absolute `<base href>`). `--json` includes `fullPage` and `consentDropped` as above (0 for non-HTML). |
| `webindex repo\|issues\|prs\|releases\|tags <ref>` | What GitHub, GitLab or Gitea records about a repository: its facts (stars, licence, last push, archived), an issue or PR search (`--terms`; relaxed once to the most distinctive terms, and said so, when all of them match nothing), releases, tags. `<ref>` is `owner/repo`, any repository URL — one copied from a browser works — `git@host:owner/repo`, or a local checkout, read as its origin. `--forge github\|gitlab\|gitea` names what a self-hosted host runs; `WEBINDEX_FORGE_HOSTS` declares it once, and is also what lets a token go there. A failure says which one it was. |
| `webindex package <name>` | A library name resolved through npm, PyPI or crates.io to its repository, homepage, docs, current version, licence and deprecation. `--registry npm\|pypi\|crates` skips the guessing; `--version` answers for that version (or an npm dist-tag) or not at all. A registry that cannot be reached stops the search, so another ecosystem's namesake never answers in its place. |
| `webindex meta <url\|file>` | What a page says about itself — JSON-LD, OpenGraph and meta tags: title, type, site, author, publication and modification dates, canonical URL. A saved page on disk (`-` reads stdin) is decoded the way `extract` decodes it. |
| `webindex robots <url>` | Whether robots.txt lets that URL be fetched, any `Crawl-delay`, and the sitemaps it names. Exits 1 when it does not allow it, so `webindex robots <url> && …` composes; a robots.txt that errors is read as RFC 9309 says — nothing may be crawled. |
| `webindex sitemap <url>` | The page URLs a site lists: the sitemaps robots.txt names (else `/sitemap.xml`), index children followed up to `--max` documents (default 3) — XML, gzipped or plain text — and the children it did not reach named on stderr (`unfetched` in `--json`). |
| `webindex feed <url>` | A site's RSS, Atom or JSON Feed — or the feeds a page advertises, each parsed — with dated entries and absolute links. |
| `webindex mcp` | Serve the tools below to an agent. `--transport stdio` (default) or `http` with `--port`, `--bind`, `--allow-remote`. `--public-only`, `--allow-private` and `--extract-root <dir>` set the walls an exposed server needs — see [Exposing it](#exposing-it). |
| `webindex searxng up\|down\|status` | Drive the keyless SearXNG container. |
| `webindex semantic up\|down\|status` | Drive Qdrant and Ollama, and pull the embedding model once they answer. |
| `webindex firecrawl up\|down\|status` | Drive Firecrawl, which cleans a page with a real headless browser. It delegates its own search to SearXNG, so this starts both. |
| `webindex stack up\|down\|status\|path` | Everything at once. `path` prints where the compose file was written. |
| `webindex cache status\|clean` | What the on-disk fetch cache holds — entries, size, how many are still fresh. `clean` drops the stale ones, `--all` drops every one, and either sweeps the cache's own orphaned bodies and temp files. Both count and remove only files the cache wrote, never anything else in the directory. The directory is `WEBINDEX_CACHE_DIR`, else per user under the temp dir (`webindex-<uid>/cache`, created private to you; one another user created first, or may write, is not used, and `status` says why); `WEBINDEX_CACHE_TTL_HOURS` (fractions allowed) sets how long an entry stays fresh. |
| `webindex crawl <url> --max <n>` | Walk a site from a seed, breadth-first, consulting robots.txt at **every hop** (and per origin with `--cross-origin`). `--max` is required: following one citation needs no permission, enumerating a site does, and an unbounded walk is the one thing here that can inconvenience somebody else's server. `--max` counts pages returned: a failed fetch costs none, but a crawl makes at most **3 × `--max` page requests**, so a sitemap full of dead links cannot run it on. The walk stays on the origin the seed lands on — its own `http`→`https` or `www` redirect included — and seeds itself from the sitemap (`--no-sitemap` skips it; a seed below the root, `/docs/`, takes only its own section's entries, after its own links). `--prefix /docs/` keeps links and sitemap entries under a path; `--depth`, `--cross-origin`. Links to images, media, fonts and archives are not fetched, and a page reached through two redirects is read once. A robots.txt that answers 5xx or not at all stops the crawl (RFC 9309), as does a `Crawl-delay` over `WEBINDEX_MAX_CRAWL_DELAY_MS` (default 60 s). Each depth is fetched as one wave, `WEBINDEX_CRAWL_CONCURRENCY` pages in flight (default 4), while one host still departs single-file, and a `Retry-After` holds the whole host. |
| `webindex tables <url\|file>` | The page's tables as headers and rows, `colspan` and `rowspan` resolved. `--json` for the rows, otherwise markdown. A saved page on disk (`-` reads stdin) is decoded the way `extract` decodes it. |
| `webindex embed <text>` | A vector from the local Ollama — no key, nothing leaves the machine. Needs `webindex semantic up`. `--docs <file.json\|->` embeds a JSON array of strings (`--lines`: one text per line) in one run, in input order. |
| `webindex hybrid --query <q>` | Rank documents with BM25F **and** a dense lane, fused by RRF. Each hit reports its rank in each lane. The dense lane sends the model its task prefixes — nomic's `search_query:` / `search_document:`, mxbai's, e5's; `WEBINDEX_EMBED_QUERY_PREFIX` / `WEBINDEX_EMBED_DOC_PREFIX` override them — and at most `WEBINDEX_EMBED_MAX_CHARS` (8000) of each document. Degrades to the lexical half, with a note on stderr, when no embedding server answers. |
| `webindex changed <url>` | Fingerprint a URL, or — given `--etag` / `--last-modified` / `--hash` — say whether it changed and how it was decided. A baseline prints `etag`, `last-modified`, `hash` (SHA-256 of the raw bytes, what `sha256sum` of the download gives) and `status`, and exits non-zero instead of printing one it could not read. `--timeout <ms>` bounds the request. Exits non-zero on "could not tell", so a watcher never reads an error as "nothing to do". |
| `webindex skill <action>` | Packaging gates for a repo built on this engine, driven by its `skill.json`: `vendor` (pin by tag + sha256, `--check` for the offline drift/staleness gate), `check` (no module may re-declare an engine export), `bundle` (`skills add` would install a working skill), `copy`, `doctor`, `init`, and the repin workflow's three steps — `repin`, `finish`, `recall` (see below). |
| `webindex video fetch\|search\|frames\|list` | A video kept on disk, so a question about it never reads it twice — YouTube, Vimeo, Dailymotion or any page yt-dlp reads. `fetch <url>` writes `<dir>/<key>/TRANSCRIPT.md` (the key is the YouTube id, else `site-id`, e.g. `vimeo-76979871`) (the Markdown `fetch` prints for a video), `segments.json` (every timed segment) and `meta.json` (title, channel, date, duration, chapters, tracks, the rung that read it and when), then reuses them on the next call without running yt-dlp at all — `--refresh` reads the video again, `--lang` picks the subtitle language. `search <query>` ranks ~45 s passages of every video under the directory (or of one video's own directory) with BM25F, chapter titles weighted as headings, and prints each with its `[mm:ss]` stamp and a link that opens the video there (`--limit`, default 10; `--json` for the hits). The directory is `--out <dir>`, else `WEBINDEX_VIDEO_DIR`, else `<tmp>/webindex/video`; under `WEBINDEX_NO_WRITE` nothing is written and `fetch` prints the transcript. `frames <url|id|dir>` takes what is on screen: the video at 720p at most into a temp directory (removed afterwards), a frame at every scene change (ffmpeg's scene score above 0.3) and just after every chapter start — evenly spaced ones when a video has neither — near-duplicates dropped by dHash (64 bits, Hamming distance ≤ 6), and at most 20, 50 or 100 kept by `--effort low\|med\|high` (`med` by default), the most widely spaced first. They land in `<id>/frames/NNNN_mm-ss.jpg`, with `FRAMES.md` pairing each frame with what was said from 5 s before it to 10 s after, and `frames.json` the same as data. It needs ffmpeg, and fetches the video first when given a URL. `list <playlist\|channel>` reads the first `--limit` videos (default 10) two at a time — a channel's `/videos` tab when the URL names none — each kept as its own run (an existing one reused), and writes `CORPUS.md` and `corpus.json` naming them `V1`…`Vn` in listing order; a video that cannot be read keeps its label with the reason, so the numbering never shifts. `search` on a corpus directory labels its hits `V1`…`Vn`. |
| `webindex doctor` | Which optional helpers answer — SearXNG, Firecrawl, Ollama, Qdrant — and what each extraction rung will do on this machine: installed, downloads on first use, not installed, built-in, or switched off and by which variable. The npx rungs are checked against npm's cache, never installed. The video rungs show yt-dlp's version and age (flagged past 60 days — YouTube breaks old releases) and whether whisper has `uvx` and `ffmpeg`. `--json` returns each service's state and each rung as data (`rungs.pdf`, `rungs.doc`, `rungs.video`, and `ytdlp`). |
| `webindex version` | The engine version. |

Nothing above needs an API key, and nothing is required: every optional helper
degrades to a note rather than an error.

Exit codes: `0` when the command did what was asked; `1` when it ran and the answer
is a failure — nothing found, a page unreadable, robots.txt saying no, a gate
refusing; `2` when the invocation itself was wrong — an unknown command or flag, a
missing or out-of-range value, a stray argument. `webindex <command> --help` prints
that command's usage alone.

### Environment

Every variable is read when it is used, never at start-up, and a consumer that
vendors the engine reads the same ones under its own prefix (`READER_SEARXNG`, …).
A blank value counts as unset; a number that does not parse falls back to the
default, and one out of range is clamped to it.

| Variable | What it sets |
|---|---|
| `WEBINDEX_SEARXNG` | SearXNG base URL, or `off` (default `http://localhost:8888`) |
| `WEBINDEX_ENGINES` | the keyless engines to try: a comma list of `ddg`, `ddglite`, `mojeek`, or `off` (default all three) |
| `WEBINDEX_FIRECRAWL` | Firecrawl base URL, or `off` (default `http://localhost:3002`) |
| `WEBINDEX_FIRECRAWL_KEY` | a bearer key, only for a hosted Firecrawl — the local one is keyless |
| `WEBINDEX_PAGE_DELAY_MS` | pause between two result pages of one engine (default 350) |
| `WEBINDEX_TIMEOUT_MS` | how long a request may take, connection and body download included, before it is abandoned, not retried (default 20000; `--timeout` overrides it) |
| `WEBINDEX_MAX_ATTEMPTS`, `WEBINDEX_RETRY_MS` | attempts per request (default 2, at most 5) and the back-off before a retry (default 600 ms) |
| `WEBINDEX_POLITE_DELAY_MS` | floor between two requests a `crawl` makes to one host (default 400); a robots.txt `Crawl-delay` wins. `fetch` does not pace a host |
| `WEBINDEX_UA` | the browser User-Agent sent to sites |
| `WEBINDEX_CACHE_DIR` | where the fetch cache — and the materialised container stack, in `compose/` — live (default `<tmp>/webindex-<uid>/cache`, private to you) |
| `WEBINDEX_CACHE_TTL_HOURS`, `WEBINDEX_CACHE_TTL_MS` | how long a cached page stays fresh (default 24 h; hours may be fractional) |
| `WEBINDEX_NO_WRITE` | write nothing: no cache entry, no eviction, no artifact |
| `WEBINDEX_NO_WAYBACK` | `rescueViaWayback` never asks the Internet Archive (library only; the CLI never does) |
| `WEBINDEX_PDF_ENGINE` | the PDF rungs to run, in order: a comma list of `pdf-inspector`, `anydoc`, `firecrawl`, `pdftotext`, `native`, `ocr`, or `none` |
| `WEBINDEX_DOC_ENGINE` | the office rungs to run, in order: `anydoc`, `firecrawl`, `builtin`, or `none` |
| `WEBINDEX_NO_NPX` | skip the rungs that would install through npx |
| `WEBINDEX_NPX_TIMEOUT_MS` | how long one npx rung may run, first download included (default 90000) |
| `WEBINDEX_OCR_MAX`, `WEBINDEX_OCR_LANG`, `WEBINDEX_OCR_TIMEOUT_MS` | documents one process may OCR (default 3), tesseract's language (default `eng`), and one document's budget (default 300000) |
| `WEBINDEX_VIDEO_ENGINES` | the video transcript rungs to run, in order: a comma list of `manual-subs`, `auto-subs`, `whisper`, or `none` |
| `WEBINDEX_WHISPER_MODEL`, `WEBINDEX_WHISPER_MAX`, `WEBINDEX_WHISPER_TIMEOUT_MS` | the whisper model (default `small`, about 500 MB on first use), videos one process may transcribe locally (default 3), and one video's budget (default 1800000) |
| `WEBINDEX_VIDEO_DIR` | where `video` keeps its runs (default `<tmp>/webindex/video`, under the consumer's own name when vendored) |
| `WEBINDEX_YTDLP_ARGS` | extra flags appended to every yt-dlp call, split on whitespace — yt-dlp's browser-cookies option when YouTube or another site asks to sign in, or a proxy |
| `WEBINDEX_NO_ROBOTS` | `robots` and `crawl` do not consult robots.txt — only right on a site you own |
| `WEBINDEX_ROBOTS_UA` | the user-agent token robots.txt groups are matched against (default `webindex`) |
| `WEBINDEX_CRAWL_CONCURRENCY` | pages a crawl keeps in flight, 1–16 (default 4); one host still departs single-file |
| `WEBINDEX_FETCH_CONCURRENCY` | URLs one `fetch` keeps in flight when it is given several, 1–16 (default 4) — several on one host included |
| `WEBINDEX_MAX_CRAWL_DELAY_MS` | the longest robots.txt `Crawl-delay` a crawl waits out (default 60000); a site asking for more is not crawled |
| `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `GITEA_TOKEN` | optional forge tokens (`WEBINDEX_GITHUB_TOKEN`, `WEBINDEX_GITLAB_TOKEN`, `WEBINDEX_GITEA_TOKEN` win over them); each goes only to its own forge's host |
| `WEBINDEX_FORGE_HOSTS` | self-hosted forges, e.g. `salsa.debian.org=gitlab,git.corp=github`: each is queried as that forge and receives that forge's token |
| `WEBINDEX_NO_GH` | never reach for the `gh` CLI on github.com — plain HTTP only |
| `WEBINDEX_REPO_DIR` | where `ensureClone` keeps working trees (library; default `<tmp>/webindex/repos`) |
| `WEBINDEX_BROWSER_DIR` | where the dedicated browser keeps its profiles and session (default `~/.webindex/browser`, under the consumer's own name when vendored; private to you, and under the home dir on purpose so a tmp sweeper never logs you out) |
| `WEBINDEX_BROWSER_BIN` | the Chrome, Brave, Chromium or Edge binary to drive, instead of the first one found |
| `WEBINDEX_GIT_CLONE_TIMEOUT_MS`, `WEBINDEX_GIT_FETCH_TIMEOUT_MS`, `WEBINDEX_GIT_HISTORY_TIMEOUT_MS` | budgets for a clone (300000), a fetch (120000) and deepening history (300000) |
| `WEBINDEX_SH_TIMEOUT_MS` | the default budget of a local command run through `sh` (60000) |
| `WEBINDEX_OLLAMA`, `WEBINDEX_QDRANT` | embedding server and vector store base URLs, or `off` (defaults `http://localhost:11434`, `http://localhost:6333`) |
| `WEBINDEX_EMBED_MODEL` | the embedding model to ask for, and to pull on `semantic up` (default `nomic-embed-text`) |
| `WEBINDEX_EMBED_QUERY_PREFIX`, `WEBINDEX_EMBED_DOC_PREFIX` | the task prefixes put before a question and each document (`none` for none; default from the model) |
| `WEBINDEX_EMBED_MAX_CHARS` | characters of each document embedded (default 8000, 0 = all) |
| `WEBINDEX_EMBED_BATCH`, `WEBINDEX_EMBED_CONCURRENCY` | texts per embedding request (default 16) and requests in flight (default 4) |
| `WEBINDEX_QDRANT_UPSERT_BATCH` | points per upsert request (default 256) |
| `WEBINDEX_RRF_K` | the reciprocal-rank-fusion constant for `rank` and `hybrid` (default 60) |
| `WEBINDEX_DOCKER_PULL_TIMEOUT_MS` | the image-pull budget of `up` (default 1200000) |

### The container stack is embedded

`searxng`, `firecrawl` and `stack` do not need a checkout. The compose file, the
SearXNG settings and the Firecrawl env are compiled into the binary and written
out on first use, into `compose/` beside the fetch cache — so they work from a
Homebrew cellar, a global npm install or a vendored bundle alike.

A compose file is something docker runs with root's rights, so before each
action the written files are read back, and every directory from the cache root
down (for the default cache, from the per-user `<tmp>/webindex-<uid>` down) must
be yours, no symbolic link, and not writable by anyone else; otherwise the
command refuses and says which path failed. With the docker client installed
but no daemon answering, every action says so and exits 1 rather than reporting
a status or blaming the image pull.

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

`webindex mcp` exposes twenty tools — primitives only. Point any MCP client at it:

```bash
claude mcp add webindex -- webindex mcp                    # stdio
claude mcp add --transport http webindex http://127.0.0.1:7340/mcp
```

| Tool | Arguments | Returns |
|---|---|---|
| `webindex_search` | `query` (required), `limit`, `lang`, `region`, `pages` (at most 5), `engine` | Candidate URLs with titles and snippets, through the same cascade as the CLI. Not page text — follow up with `webindex_fetch` on the ones worth reading. When nothing answers it fails loudly with which piece was missing, rather than returning an empty list that reads like "nothing exists". Its last line names each rung's outcome (`rungs: searxng=unreachable ddg=blocked …`). |
| `webindex_fetch` | `url` (required), `lang`, `fullPage`, `format`, `timeoutMs`, `cache` | The page's readable text, then a trailer naming the final URL after redirects, its canonical URL and title, any note, and the rung that produced it. Handles HTML, PDFs and office documents, using Firecrawl when available and local extraction as fallback. `fullPage: true` keeps all HTML page text through the built-in reader, including navigation and consent banners. `format: "markdown"` returns an HTML page as CommonMark with absolute links, as `--format markdown` does. `timeoutMs` bounds how long the request may take, body download included. `cache: true` uses the revalidating on-disk cache (off by default): a fresh copy is reused for its TTL, a stale one costs a 304 when unchanged. Never raw bytes. |
| `webindex_extract` | `path` (required), `fullPage`, `format` | The same for a file already on disk; `fullPage: true` keeps navigation and consent banners too, `format: "markdown"` writes CommonMark. |
| `webindex_rank` | `question` (required), `documents` (required), `limit`, `dense` | The reading order for a pool of candidates: BM25F, near-duplicate collapse, then MMR. A document's own `score` is fused with BM25F by rank; `dense: true` fuses in the local embedding lane too (a `note` says when there is none). Returns each entry's score and matched query terms, plus how many duplicates were collapsed and, in `duplicates`, each dropped mirror's URL with the URL it duplicated. The brick an agent otherwise re-implements — deterministic, no model, no network unless `dense` asks for one. |
| `webindex_repo` | `repo` (required), `forge` | A repository's record from GitHub, GitLab or Gitea: description, stars, licence, default branch, last push, topics, and whether it is archived — "is this maintained" from the forge, not from a README. |
| `webindex_issues` | `repo` (required), `terms`, `kind` (`issue` or `pr`), `limit`, `forge` | Issues or pull/merge requests with number, title, state, labels and body. GitHub ranks by relevance and scores; GitLab and Gitea order by recency and score nothing. When all the terms together match nothing it searches once more with the most distinctive ones and says so in `note`. |
| `webindex_releases` | `repo` (required), `limit`, `forge` | Releases, newest first, with their notes and dates. A project that only tags gets pointed at `webindex_tags`. |
| `webindex_tags` | `repo` (required), `limit`, `forge` | Tags with a link to each — the versions of a project that publishes no releases. |
| `webindex_package` | `name` (required), `registry`, `version` | The registry's own record: repository, homepage, docs, current version, licence and any deprecation. |
| `webindex_meta` | `url` (required) | The page's JSON-LD, OpenGraph and meta tags: author, dates, type, site name, canonical URL. |
| `webindex_robots` | `url` (required) | Whether robots.txt allows the URL, any crawl-delay, and the sitemaps it advertises. Advisory: `webindex_fetch` does not consult it. |
| `webindex_sitemap` | `url` (required), `max` | Page URLs with their last-modified dates, reading at most `max` sitemap documents (default 3); the children it did not reach come back in `unfetched`. |
| `webindex_feed` | `url` (required) | A feed parsed — RSS, Atom or JSON Feed — or the feeds a page advertises, with dated entries and absolute links. |
| `webindex_tables` | `url` (required), `markdown` | Every `<table>` as headers and rows with `colspan`/`rowspan` resolved, or as markdown. |
| `webindex_embed` | `texts` (required) | One vector per text from the local Ollama, in input order. Fails with a note naming the command that starts it when no embedding server answers. |
| `webindex_crawl` | `url` (required), `max` (required), `depth`, `prefix`, `sitemap` | A bounded breadth-first walk honouring robots.txt at every hop and staying on the origin the seed lands on: each page's URL, title and text, what robots.txt refused, and what was left pending. Every page comes back inline, and an answer over 1 MB is withheld — ask for tens of pages, not hundreds. |
| `webindex_video_fetch` | `url` (required), `lang`, `refresh`, `dir` | A video's transcript — YouTube, Vimeo, Dailymotion, or any page yt-dlp reads (only the known video hosts under a policy, since yt-dlp's own redirects escape the address check) — as Markdown — header, a heading per chapter, a `[mm:ss]` stamp per paragraph — read from manual subtitles, else the video's own auto-captions, else a local whisper transcription, and kept as a run so a second call (and `webindex_video_search`) never reads the video again. The trailer names the run directory and the rung. |
| `webindex_video_search` | `query` (required), `limit`, `dir` | ~45 s passages of the videos kept in `dir` ranked against the question, each with its video (`V1`… in a corpus), stamp, chapter, a link that opens the video there, and the passage. Stays on this machine. |
| `webindex_video_frames` | `url` (required), `effort`, `dir` | What is on screen: a frame at every scene change and chapter start, near-duplicates dropped, at most 20/50/100 by `effort`, each with its image path, stamp and the transcript from 5 s before to 10 s after — read the images to see slides or code. Needs ffmpeg. |
| `webindex_video_list` | `url` (required), `limit`, `dir` | The first `limit` videos of a playlist or channel, each kept as a run, and `CORPUS.md` naming them `V1`…`Vn`; a video that cannot be read keeps its label with the reason. Reports progress per video. |

Every tool is annotated `idempotentHint`. All but the three video tools that keep a
run on disk — `webindex_video_fetch`, `webindex_video_frames` and
`webindex_video_list`, which write only under the video root and reuse what is
there — are `readOnlyHint`, and only `webindex_video_frames` (which replaces the
video's earlier frames) and `webindex_video_list` (the directory's earlier
`CORPUS.md`) are `destructiveHint`; all but
`webindex_extract`, `webindex_rank`, `webindex_embed` and `webindex_video_search`
are `openWorldHint`. Under `--public-only`, `--extract-root` or `--allow-remote`,
a video tool's `dir` is a directory *name* inside the video root, never a path.

The server implements `initialize`, `ping`, `tools/list`, `tools/call`,
`resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`,
`prompts/get`, `notifications/cancelled` and `notifications/progress`. It
negotiates protocol revisions from `2024-11-05` to `2025-11-25` (an unknown one
gets the newest), sends each revision only the tool fields it defines, serves
JSON-RPC batches only to a client on a revision that has them (before
`2025-06-18`), validates arguments against each tool's declared schema,
withholds an oversized response rather than sending a truncated one, and
distinguishes a tool that failed (a readable `isError` result) from a client
that asked wrongly (a JSON-RPC error). A cancelled call stops its work — the
fetch in flight is aborted, a crawl or a sitemap walk goes no further — rather
than only having its answer dropped, and `webindex_crawl` and `webindex_sitemap`
report each page or document as progress to a call that asked with a
`progressToken`. Resources are `SKILL.md` and `references/*.md`, and nothing
else under the payload.

Over HTTP it binds loopback only unless `--allow-remote`, checks the `Origin`
header against DNS rebinding, and answers each request statelessly: plain
JSON, or — for a request that asked for progress, from a client that accepts
`text/event-stream` — an SSE stream of its progress and then its answer. A
POSTed notification or response gets a 202. With no session to name a
request by, a client hanging up is what cancels it there.

### Exposing it

On your own machine, fetching any URL and reading any file is the point.
Reachable by anyone else, it is a proxy into your network — the cloud metadata
endpoint at `169.254.169.254` hands out credentials to whoever asks — and a
reader of `~/.ssh`. So there are walls, each opt-in:

| Flag or variable | What it does |
|---|---|
| `--public-only` (`WEBINDEX_PUBLIC_ONLY=1`) | Every URL tool refuses a target that is, or resolves to, a loopback, private, link-local, CGNAT, unique-local or reserved address — IPv4 carried inside IPv6 included — and checks again at every redirect, robots.txt, sitemap and crawl hop. A guarded fetch skips Firecrawl (which fetches on its own) and the on-disk cache (which unguarded runs share). A self-hosted forge must resolve publicly unless it is declared in `WEBINDEX_FORGE_HOSTS`, and a forge's redirects are checked like any other's — a declared forge's once they leave its own origin. It does not stop a resolver that answers this check and the fetch differently (DNS rebinding). |
| `--extract-root <dir>` (`WEBINDEX_EXTRACT_ROOT`) | `webindex_extract`, and a repository named by a local path, read only under `<dir>`; a relative path, a file's or a checkout's, is read from it, and symlinks are resolved before the check. A path outside is refused the same way whether or not it exists. |
| `WEBINDEX_MCP_TOKEN` | Over HTTP, answer only requests carrying `Authorization: Bearer <token>` — configure the client to send that header; the startup message prints the `claude mcp add` line that does. |

`--allow-remote` turns the first two on by default: public addresses only
(`--allow-private` lifts that), and no local file at all — `webindex_extract`
is not even listed — unless `--extract-root` names a directory. The startup
message says which walls are up and whether there is a token.

```bash
WEBINDEX_MCP_TOKEN=$(openssl rand -hex 32) \
  webindex mcp --transport http --bind 0.0.0.0 --allow-remote --extract-root ~/shared-docs
```


## What is in scope

A library of **primitives**, not a pipeline.

| Layer | What it owns |
|---|---|
| Discovery | the SearXNG JSON API and Firecrawl's `/search`, with pagination, cross-page dedupe, and throttled-upstream detection |
| Retrieval | HTTP with retry, **streaming** byte caps and conditional GET, HTML→text, HTML→Markdown (`htmlToMarkdown`), main-content extraction, consent-banner stripping, Firecrawl, the PDF ladder (`pdf-inspector` → `anydoc` → Firecrawl → `pdftotext` → native → OCR), the office-document ladder (`anydoc` → Firecrawl → built-in), explicit Wayback rescue, the revalidating fetch cache |
| Text | keyword extraction, accent- and plural-folded matching, camelCase splitting, excerpting, URL canonicalisation and identity |
| Ranking | RRF fusion, BM25F with field weighting and a relevance floor, SimHash near-duplicate collapse, MMR diversification, DOI/arXiv identity, pool-relative recency |
| MCP | the whole protocol — negotiation, cancellation, progress, schema validation, response capping, the error taxonomy — plus the stdio and HTTP transports |

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
`WEBINDEX_DOC_ENGINE=builtin` forces it. It returns headings, lists, tables (a
run of empty rows as one), each sheet as a table and each slide with its speaker
notes, and it is strict about the ZIP it opens: ZIP64, encrypted entries and
unknown compression methods are refused, and every entry, the whole archive and
the text it produces, table rules included, are capped, so a decompression bomb
costs 64 MB of work, not its full size. Its output passes the same garbage gate
as every other rung. Legacy `.doc`/`.xls`/`.ppt` and RTF still need `anydoc` or
Firecrawl.

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
and politeness waits do not consume the HTTP network timeout budget. The forge
calls take it too, as `ForgeOptions.authorizeUrl`: it approves the API URL and
every redirect the forge client follows, inside that call's one timeout.

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

Consumers call the reusable workflow as `skill-repin.yml@v1`. GitHub's default
automation token cannot modify workflow definitions, so `skill repin` updates runtime
engines and the maintenance dependency without editing `.github/workflows`; instead the
release workflow moves the `v1` major tag onto every stable release, and every consumer
runs the current shell with no edit. A breaking change to the workflow contract ships as
a new major, which consumers adopt deliberately.

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
