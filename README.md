# webindex

Turn a URL into clean, citable text — HTML, PDFs through a six-rung ladder ending in OCR,
and office documents — and serve that to an agent over MCP.

Zero runtime dependencies. One ESM bundle plus one declaration file, plus a CLI. The
web-side companion to [codeindex](https://github.com/maxgfr/codeindex): codeindex indexes
the code you have locally, webindex fetches what is out there.

```bash
brew install maxgfr/tap/webindex

webindex fetch https://example.com     # URL -> clean text
webindex extract report.pdf            # a file already on disk
webindex mcp                           # serve fetch/extract over MCP
webindex doctor                        # which rungs and helpers are available
```

## What is in scope

A library of **primitives**, not a pipeline.

| Layer | What it owns |
|---|---|
| Retrieval | HTTP with retry and byte caps, HTML→text, main-content extraction, Firecrawl, the PDF ladder (native → `pdf-inspector` → `anydoc` → Firecrawl → `pdftotext` → OCR), the office-document ladder, Wayback rescue, the fetch cache |
| Text | keyword extraction, accent- and plural-folded matching, camelCase splitting, excerpting, URL canonicalisation and identity |
| MCP | the whole protocol — negotiation, cancellation, schema validation, response capping, the error taxonomy — plus the stdio and HTTP transports |

Ranking (BM25, RRF fusion, near-duplicate collapse, diversification) and discovery (the
keyless search backends) are **not here yet**. They are the next layers to land; until they
do, this is a retrieval engine, not a search engine.

## What is deliberately out of scope

Evidence models, document layouts and citation gates. Those are product decisions: how a
tool numbers its sources, where it writes them and what it considers grounded is the tool's
business, and baking one choice in here would dictate behaviour rather than share plumbing.

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
- **Node 18 is the floor.** A dedicated CI job runs the committed bundle on Node 18 with
  no install, because the dev toolchain needs ≥20.19 and so cannot prove it.
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
