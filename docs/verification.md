# Repository verification — 2026-09-07

## Live check — 2026-10-12

`pnpm live` (`scripts/live-check.mjs`) runs every CLI command, every MCP tool
and every ladder rung against the real web: real sites, real PDFs and office
files, real videos, Chrome and Brave, the Docker stack and whisper. It is not
part of CI — the network decides its outcome — and it writes `report.md` and
`report.json` to `.ultraeval/live/<date>/`, exiting non-zero when a case fails.

```sh
pnpm build                                          # the cases run scripts/webindex.mjs
node scripts/live-check.mjs                         # everything but Docker and the browser
node scripts/webindex.mjs stack up                  # then:
node scripts/live-check.mjs --with-docker --with-browser
node scripts/live-check.mjs --area fetch,feed --id wiki --jobs 2   # a subset
```

Each case runs the built CLI in a subprocess with its own cache, video and
browser directories in a temporary directory, removed afterwards (`--keep`
keeps it). SearXNG, Firecrawl and Ollama are off unless a Docker case turns
its backend on, so the default run measures the built-in path. Cases that hit
the keyless search engines run one at a time, four seconds apart: a burst from
one address is answered with an anti-bot page, which webindex reports as
"blocked, not empty" — correct, but not a measurement. `LIVE_OLLAMA` points the
Docker cases at the stack's Ollama elsewhere when another program holds
`:11434`.

### What the first campaign found

The first run (131 cases, no Docker, no browser) and the Docker and browser
runs that followed found these in webindex itself; each fix carries a
regression test cut down from the real page, and none of those tests touches
the network:

| Found live | Fix | Regression test |
|---|---|---|
| Every Wikipedia read (en, fr, de; text and Markdown) opened with "163 languages" and the 163 links | A block whose links are mostly `hreflang` is a language selector and is dropped, label and edit link included, never past a heading or a paragraph | `tests/extract.test.ts` (`fixtures/html/wiki-langs.html`) |
| Hacker News read "Hacker Newsnew": `</a></b><a>` | A closing inline tag right after `</a>` keeps the two links apart | `tests/extract.test.ts`, `tests/markdown.test.ts` |
| A GitHub `blob` page read "Copy path / Blame / More file actions…" before the file | The file is read from `raw.githubusercontent.com` and cited by the blob URL | `tests/fetch-http.test.ts` |
| An RFC served as `text/plain` opened with four blank lines | Blank lines before the first and after the last line of text are dropped | `tests/retrieval-integrity.test.ts` |
| `package npm:vitest` found nothing | `npm:` / `pypi:` / `crates:` name the registry | `tests/cli.test.ts` |
| `extract -` and `rank` failed with EAGAIN when the parent process wrote stdin a moment late — how an agent's harness spawns the CLI | stdin is read until end of file, waiting out EAGAIN | `tests/mcp-cli-process.test.ts` |
| A `.docx` Firecrawl returned as its ZIP bytes was refused as an "undecodable PDF stream" | The office ladder says the converter returned the file's bytes | `tests/doc-ladder.test.ts` |
| `fetch --markdown`, `sitemap --limit`, `mcp --port` on stdio, `search -x`, `--effort toString` all ran and ignored what they were given | Flags belong to their command; short flags, and `--port`/`--bind` without `--transport http`, are usage errors | `tests/cli-kit.test.ts`, `tests/cli.test.ts` |
| `{"id":null,"method":"ping"}` over MCP went unanswered (HTTP: 202) | `-32600`, as MCP forbids a null id | `tests/mcp-server.test.ts`, `tests/mcp-http.test.ts` |
| With the stack's ports on loopback, a desktop Ollama on `127.0.0.1:11434` made `stack up` fail with docker's words alone | A failed `up` names the ports it publishes and the variable that uses what already holds one | `tests/stack.test.ts` |

The same pass fixed what a code audit found and the tests reproduced: a
self-closing `<svg/>` swallowing the text after it, a `<title>` read as body
text when `</head>` is omitted, xlsx cells without an `r` attribute and empty
shared-string cells, quadratic regexes on hostile input (`url`, `registry`,
`video/vtt`, `cite`), timeouts past 2³¹−1 ms firing at once (`exec`, `repo`,
the OCR and npx rungs), a conditional revalidation sent through Firecrawl,
`hammingDistance` looping on a negative bigint, the Docker stack published on
every interface, unbounded concurrent tool calls over MCP HTTP and an uncapped
`webindex_crawl.max`, shared (not per-user) screenshot, video and clone
directories, a non-atomic takeover of a stale browser lock, ffmpeg 4 rejecting
`-fps_mode`, prefixed Atom feeds, `skill.json` `files` escaping the vendor
directory, and a failed `ensureHistoryDepth` memoised. And four
optimisations, behaviour unchanged: the CDP WebSocket joins a frame's chunks
once (a 4 MB frame copied 8 MB instead of 543 MB), a retried 429/503 body is
cancelled unread and `httpJson` takes a cancel signal (so an MCP cancel stops
Ollama, Qdrant and Wayback requests), a page's title, canonical and
description are read off one cleaned copy (`pageMetadata` on the 2.2 MB bench
page: 139 → 384 ops/s), and a cache read reads every candidate's metadata but
only the served body.

### Final campaign

On the rebuilt bundle, `--with-docker --with-browser` ran 222 cases: 214
passed, every browser case among them on both Chrome and Brave (open, an
interactive snapshot, type, fill, click with `--confirm`, select, upload,
scroll, wait, a full-page screenshot, tabs, network capture, `text
--markdown`, eval, back and reload, a stale ref, `fetch --browser` on a
JavaScript-only page, profile import, and no browser process left behind).
Of the eight failures, three were the harness's own (a site that answers a
script with 403, a JSON key, UTF-8 split across pipe chunks) and pass rerun.
The other five are the keyless engines refusing this address after a day of
queries — DuckDuckGo, DuckDuckGo Lite and Mojeek served anti-bot pages, and
SearXNG's own upstreams reported CAPTCHAs — which a plain `curl` with a
browser User-Agent reproduced, and which webindex reported as "blocked, not
empty". Search itself was exercised live: the first campaign's keyless
searches (English, French, `--region`) passed, and Firecrawl's search rung
returned hits in the final one.

The Docker cases ran against the stack brought up from the rebuilt bundle,
SearXNG, Qdrant and Firecrawl bound to `127.0.0.1` only; a desktop Ollama
held `127.0.0.1:11434`, so the stack's Ollama image ran as an audit
container on `:11435` over the stack's own volume (`LIVE_OLLAMA`). Afterwards
the stack was taken down with its volumes (the pulled embedding model
included) and the audit container removed; the images stay in Docker's cache.

### Limits seen, not fixed

- The native PDF rung has no font tables, as `src/pdf/native.ts` says: on a
  TeX paper (arXiv 1706.03762) it refuses the text, whose ligatures are
  control codes, and on a simple PDF it can read the `fi` ligature as `Þ`.
  The default ladder reads both papers through pdf-inspector or pdftotext.
- yt-dlp 2026.08.19's TED extractor fails on talk pages; webindex reports
  its error. The video rungs were exercised on YouTube (manual subtitles,
  auto-captions, whisper), Vimeo and a playlist.
- Self-hosted Firecrawl returns an `application/octet-stream` `.docx` as its
  ZIP bytes; the office ladder refuses that rung and says why.
- Chrome computes doubled accessible names for the controls inside
  `<input type="time">` ("Heures Heures"); snapshots show Chrome's name as is.
- The keyless engines block an address after a burst of queries; a run that
  searches too often measures that, not webindex.

The corrected workspace passes the automated matrix and the live retrieval,
Docker and ChatGPT-search-to-MCP scenarios below. These checks support using
webindex as discovery, extraction and ranking primitives. They do not establish
complete web coverage or guarantee that every third-party page is readable.

## Corrections

| Area | Corrected behavior | Regression coverage |
|---|---|---|
| MCP recovery | An unreadable local file returns a tool error; the process still answers the next request | `tests/mcp-cli-process.test.ts` builds a temporary CLI and sends extract followed by ping |
| MCP boundaries | Reject opaque/empty HTTP origins, normalize validated numeric strings, report malformed rank fields as invalid parameters, and cancel only active requests with the same typed ID | `tests/mcp-http.test.ts`, `tests/mcp-protocol.test.ts`, `tests/mcp-server.test.ts`, `tests/cli.test.ts` |
| CLI outcomes | Failed search, fetch, extract and unrankable queries keep a nonzero exit code in JSON mode | `tests/cli.test.ts` |
| Document integrity | MIME-identified PDF/office downloads get the document budget, explicit caps win, oversized documents fail, and CSV respects its encoding | `tests/retrieval-integrity.test.ts` |
| Text fidelity | Preserve literal markup in plain text/Markdown; read descriptions and hrefs with opposite quotes and entities correctly | `tests/retrieval-integrity.test.ts`, `tests/cli.test.ts`, `tests/crawl-redirect.test.ts` |
| Change detection | Track bytes before decoding, hash complete empty bodies, and never report a truncated prefix as unchanged | `tests/changed.test.ts`, `tests/retrieval-integrity.test.ts` |
| Cache | Reuse MIME-detected document entries, including legacy extractor namespaces and offline reads | `tests/cache.test.ts` |
| Crawl | Authorize every page/sitemap redirect, enforce the origin boundary on robots.txt redirects, strip cross-origin credentials, and resolve links against the final URL | Real HTTP fixtures in `tests/crawl-redirect.test.ts`; transport tests in `tests/retrieval-integrity.test.ts` |
| Timeouts | Exclude authorization/politeness waits while keeping a cumulative network budget across redirects | Fake-timer tests in `tests/retrieval-integrity.test.ts`, including blocked fetch/body and cumulative redirect time |
| Test reliability | Verify subprocess overlap with a shared readiness barrier, replacing a load-sensitive wall-clock assertion | `tests/exec-repo.test.ts` |

README, skill and MCP descriptions now explain native host search followed by
webindex extraction/ranking, the actual PDF ladder order, and the explicit
library-only Wayback rescue. Distributed bundles were regenerated.

## Automated matrix

| Check | Result |
|---|---|
| Node 22.23.2, complete Vitest suite | 1,115 passed, 48 files |
| Node 24.20.0, complete suite with coverage | 1,115 passed, 48 files |
| Coverage: statements / branches / functions / lines | 91.91% / 82.11% / 95.36% / 94.16%; all configured thresholds passed |
| Biome and TypeScript | Passed |
| Component benchmarks | Completed: charset decoding, HTML extraction, hashing and 300-document ranking; results are local measurements, not production latency guarantees |
| Bundle/docs consistency | 122 checks passed |
| Vendorability | Only Node built-in imports; declaration file self-contained |
| Standalone consumer | Library under an unknown brand and CLI MCP passed, without package installation |
| Node 18.20.8 in Docker, Linux amd64 on arm64 host | Standalone library/CLI/MCP smoke passed |
| Reproducibility | Fresh temporary build matches all three distributed files byte for byte |

Reproduce the main gates with:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run lint
pnpm run typecheck
pnpm dlx --allow-build=node node@22 node_modules/vitest/vitest.mjs run
pnpm dlx --allow-build=node node@24 node_modules/vitest/vitest.mjs run --coverage
pnpm run build
pnpm run verify:vendorable
pnpm run verify:bundle
pnpm run verify:standalone
pnpm run bench
docker run --rm --platform linux/amd64 -v "$PWD:/workspace:ro" -w /workspace node:18.20.8-bookworm node scripts/consumer-smoke.mjs
```

`check:build` also compares bundles to Git HEAD. During this uncommitted repair,
that final comparison naturally reports the changed bundles; reproducibility
was instead checked against a separate fresh build, without staging files or
weakening the CI gate.

## Real Docker and extraction trials

An isolated Compose project started eight healthy containers using the repo's
embedded stack, private volumes and random loopback ports. Actual operations:

- SearXNG returned search results including official documentation; two upstreams reported CAPTCHA.
- Firecrawl extracted a static page and rendered `https://quotes.toscrape.com/js/`: 1,574 readable characters versus 24 with native extraction alone.
- Firecrawl refused a private local fixture under its existing network policy; the public JavaScript fixture succeeded.
- Ollama produced two finite 768-dimensional vectors with `nomic-embed-text`; self cosine was 1. Hybrid ranking placed an HTTP 429 document before an unrelated recipe in both lanes.
- Qdrant collection creation, upsert, search, update and deletion passed; deletion was followed by a 404 check.
- Explicitly disabled and unreachable services returned useful notes; hybrid ranking retained its lexical fallback.

Audit containers, volumes, downloaded audit model, network and temporary stack
configuration were removed. Existing PostgreSQL containers were left running.
The integration trial preceded the final crawl timeout/robots corrections;
stack and semantic code did not change afterward. Final Node 18 smoke used the
final rebuilt bundle.

Real local helpers also extracted a text PDF through native, pdftotext,
pdf-inspector and anydoc, a DOCX through anydoc, and an image-only PDF through
OCR. This verifies representative fixtures, not every advertised office format
or arbitrary scanned document. Firecrawl's PDF-specific path was not exercised
live.

## Does combining host search and webindex help?

The session's actual ChatGPT web-search tool discovered primary sources for
three questions. Separately, webindex's keyless DDG search returned three hits
per question with SearXNG and Firecrawl disabled. The relevant primary source
appeared within those three hits each time; this is a small convenience sample,
not a search-engine benchmark.

Four actual source pages were then fetched through the rebuilt MCP stdio
server: the three primary reference pages and the browser AbortSignal page
that DDG ranked above Node.js documentation. All four succeeded. The complete
extracted documents, with caller-retained URLs and titles, were ranked through
`webindex_rank` for each question:

| Question | Top result from the mixed four-document pool | Evidence inspected |
|---|---|---|
| Can an HTTP 304 response contain a body? | [MDN 304](https://developer.mozilla.org/fr/docs/Web/HTTP/Reference/Status/304) | The response must have no body |
| When was Node.js AbortSignal.timeout added? | [Node.js globals](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay) | The method section names v17.3.0 and v16.14.0 |
| How does Qdrant handle cosine vectors? | [Qdrant collections](https://qdrant.tech/documentation/manage-data/collections/) | The docs describe normalization during upload |

The Node.js search snippet described a neighboring method and version. Fetching
the source let the agent inspect the correct section. This is the concrete
benefit demonstrated here: discovery followed by reusable full-text extraction
and reading order. It does not prove an accuracy or speed advantage over the
host's own page reader. MCP fetches ranged from roughly 0.3 to 16.7 seconds in
this run; latency varied substantially between trials.

Lower-ranked results included zero-score documents. A returned rank alone does
not make a source relevant or substantiate a claim; inspect matched terms and
the underlying text. The calling agent retains responsibility for citations.

**Claude Code:** an actual bounded attempt connected the webindex MCP server
with native `WebSearch`, `webindex_fetch` and `webindex_rank` as the available
tools. The account session quota stopped execution before any tool call.
Connection succeeded; the complete Claude hybrid workflow remains unverified.
No credential inspection or quota workaround was attempted. Setup and usage
are documented in [the host-search guide](../references/host-search.md).

## Evidence and limits

Local raw logs are under the ignored `.ultraeval/` directory:
`final-node22.log`, `final-node24-coverage.log`, `final-bench.log`,
`live-integrations.md`, `live-extraction/results.json`,
`websearch-comparison.json`, `host-search-flow.json`, and `claude-hybrid.md`.

The initial commit `c51ed7a` was audited separately using an immutable archive.
Fifteen reproduced findings were mapped to repairs and current regression
tests in `.ultraeval/REMEDIATION-STATUS.md`. Its independent judge score concerns
that initial archive, not this corrected workspace. No fresh post-repair
quality score is claimed. This report records measured behavior rather than
certifying that no further defect exists.
