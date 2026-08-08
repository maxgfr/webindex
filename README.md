# webindex

Turn a URL into clean, citable text — HTML, PDFs through a six-rung ladder ending in OCR,
and office documents — and serve that to an agent over MCP.

Zero runtime dependencies. One ESM bundle plus one declaration file, plus a CLI. The
web-side companion to [codeindex](https://github.com/maxgfr/codeindex): codeindex indexes
the code you have locally, webindex fetches what is out there.

```bash
brew install maxgfr/tap/webindex
```

## The command line

| Command | What it does |
|---|---|
| `webindex fetch <url>` | Fetch a URL and print its readable text. Routes PDFs and office documents to their ladders, falls back through Firecrawl and the Wayback Machine when a page resists. `--json` adds the title, status, extractor and any note. `--lang fr-FR` sets Accept-Language, `--firecrawl <base>\|off` overrides the extractor. |
| `webindex extract <file>` | The same extraction on a file already on disk — PDF, office document, HTML or plain text. `--json` as above. |
| `webindex mcp` | Serve the two tools below to an agent. `--transport stdio` (default) or `http` with `--port`, `--bind`, `--allow-remote`. |
| `webindex searxng up\|down\|status` | Drive the keyless SearXNG container. |
| `webindex firecrawl up\|down\|status` | Drive Firecrawl, which cleans a page with a real headless browser. It delegates its own search to SearXNG, so this starts both. |
| `webindex stack up\|down\|status\|path` | Everything at once. `path` prints where the compose file was written. |
| `webindex doctor` | Which optional helpers answer, which extraction rungs exist on this machine. |
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

```bash
webindex firecrawl up      # searxng + firecrawl, detached, waits for health
webindex stack status
webindex stack path        # where the compose file landed, if you want to read it
```

## The MCP server

`webindex mcp` exposes two tools. Point any MCP client at it:

```bash
claude mcp add webindex -- webindex mcp                    # stdio
claude mcp add --transport http webindex http://127.0.0.1:7340/mcp
```

| Tool | Arguments | Returns |
|---|---|---|
| `webindex_fetch` | `url` (required), `lang` | The page's readable text plus the rung that produced it. Handles HTML, PDFs and office documents, and falls back through Firecrawl and the Wayback Machine. Never raw bytes. |
| `webindex_extract` | `path` (required) | The same for a file already on disk. |

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
