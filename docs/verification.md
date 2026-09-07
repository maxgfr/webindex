# Repository verification — 2026-09-07

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
