# webindex

The web-retrieval engine behind [ultrasearch](https://github.com/maxgfr/ultrasearch),
[ultradoc](https://github.com/maxgfr/ultradoc) and [construct](https://github.com/maxgfr/construct).

Zero runtime dependencies. One ESM bundle plus one declaration file. **Vendored, not
installed.**

It is the web-side companion to [codeindex](https://github.com/maxgfr/codeindex):
codeindex indexes the code you have locally, webindex fetches and ranks what is out there.

## Why it exists

Three skills grew the same machinery independently. Before this package, they shared
**1 485 lines that were byte-identical** apart from an environment-variable prefix — the
PDF and office-document extraction ladders, and the MCP transport — plus divergent forks
of the same fetcher, the same Firecrawl client, the same cache and the same ranking
helpers. Three consecutive releases of all three repos were the same commit, hand-copied:

```
feat(pdf): read scanned PDFs with copyable-pdf, the ladder's OCR rung
fix(pdf,doc): pin the npx extractor rungs instead of floating on latest
feat(doc): read office documents instead of quoting their bytes
```

Now that fix is one commit here, and the three skills pick it up on their own.

## What is in scope

A library of **primitives**, not a pipeline.

| Layer | What it owns |
|---|---|
| Retrieval | HTTP with retry and byte caps, HTML→text, Firecrawl, the PDF ladder (native → `pdf-inspector`/`anydoc` → Firecrawl → OCR), the office-document ladder, the page cache |
| Text + ranking | keyword extraction and matching, RRF fusion, BM25, simhash near-duplicate collapse, diversification, URL canonicalisation, excerpting |
| Discovery | the backend registry and its keyless engines (SearXNG, DuckDuckGo, Mojeek, Marginalia, Wikipedia, Hacker News, StackExchange, GitHub, arXiv/Crossref/OpenAlex/PubMed…), the harness-WebSearch lane, and the git-host providers |
| MCP transport | protocol, stdio, HTTP, resources |

## What is deliberately out of scope

Each consumer keeps its own evidence model, dossier layout and citation gate. construct
and ultradoc number sources `E#` and write `evidence.json`; ultrasearch numbers them `S#`
and writes `sources/S#.md`. Their `check` commands re-validate against different things —
a pinned clone, an SRD, a report. Those differences are real, so unifying them would
change three skills' behaviour rather than share their plumbing.

## The vendoring contract

Consumers do **not** `npm install webindex`. They copy the two published files into
`src/vendor/`, pinned by tag and SHA-256, and their own `tsup` inlines them — so each
skill still ships as a single file that runs under `node` with no install:

```bash
node scripts/sync-engine.mjs --ref v1.2.0   # fetch + pin
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

configure({ name: "ultradoc", envPrefix: "ULTRADOC", cli: "ultradoc" });
```

Everything the user already exports keeps working unchanged — `ULTRADOC_SEARXNG`,
`CONSTRUCT_FIRECRAWL`, `ULTRASEARCH_PDF_ENGINE` — because the engine reads
`env("SEARXNG")` and resolves the prefix at call time. Notes that name a command take it
from `brand().cli`, so ultradoc's output says `ultradoc web --url`, not `webindex`.

**The lazy rule.** A vendored bundle is imported by the consumer's entry module, so this
package's top-level code runs *before* the consumer's first statement — before
`configure()` can possibly have been called. A module-scope
`const UA = env("UA") ?? "…"` would therefore capture the default brand forever and
silently ignore the real prefix. Keep every tunable behind a function. `src/brand.ts`
documents this at length; it is the one invariant that makes sharing possible at all.

## Development

```bash
pnpm install
pnpm run typecheck && pnpm run lint
pnpm test
pnpm run build        # tsup + rename the declaration output to .d.mts
pnpm run check:build  # asserts the committed bundle is reproducible
```

Releases are Conventional-Commit-driven via semantic-release. The built bundle is
committed on every release, because consumers fetch it from the repository tree at the
pinned tag.

## License

MIT
