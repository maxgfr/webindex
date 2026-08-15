---
name: webindex
description: "Use when something on the web has to become text you can quote — read a URL, extract a PDF or an office document, search without an API key, or ask a forge or package registry about a project. Triggers: 'read this page', 'what does this PDF say', 'extract the text from this URL', 'search the web without a key', 'get the README of this package', 'scrape this article', 'OCR this scanned PDF'. The web-side engine: finds pages with a local keyless stack, turns a URL or a file into clean citable text (HTML, PDFs through a six-rung ladder ending in OCR, office documents), ranks a candidate pool, and reads what a site publishes about itself. Zero dependencies, no API key."
---

# webindex

A library of **primitives**, not a pipeline. It is vendored by other tools as a
single file, and it also runs as a CLI and an MCP server so an agent can use it
directly.

This document is served over MCP as `skill://SKILL.md`, alongside
`skill://references/*.md` — so `webindex mcp` documents its own engine.

## What this is not

**It is not the tool that answers a research question.** It has no evidence
model, no dossier, no citation gate and no report — deliberately, because those
are the product decisions it exists to stay out of. An agent that reaches for
`search` → `crawl` → `fetch` and writes a summary from what comes back has
produced exactly the ungrounded answer the tools below exist to prevent.

So it is also **not meant to be an installed skill**: there is no `Use when…` in
the description above, which is what keeps it from matching in a pool. It is a
library, a command and an MCP server.

> The root `SKILL.md` used to be the second half of that argument — the
> installer was said to early-return on it and install that file alone. That is
> no longer true: `skills add maxgfr/webindex` (CLI v1.5.22) installs the
> repository whole, `scripts/` and `references/` included, and from a local path
> it copies `node_modules` too. The description is the only thing still keeping
> this out of a skill pool, so treat it as load-bearing.

Route by what you actually want:

| You want | Use |
|---|---|
| a cited recap of what the web says | `ultrasearch` |
| a precise answer about a named open-source project | `ultradoc` |
| an idea turned into a buildable spec | `construct` |
| one URL turned into clean text, or a pool ranked | this, directly |

## The commands

```
webindex search <query> [--engine ddg|ddglite|mojeek|off] [--limit n] [--lang tag]
webindex fetch <url>                 # → clean text, whatever the format
webindex extract <file>              # the same, on disk
webindex rank --query <q> --docs <f> # BM25F + near-dup collapse + MMR
webindex repo|issues|prs|releases <ref>
webindex package <name> [--registry npm|pypi|crates]
webindex meta|robots|sitemap|feed <url>
webindex crawl <url> --max <n>       # bounded site walk, robots at every hop
webindex tables <url>                # tables as data, not flattened prose
webindex embed <text>                # local vectors, no key
webindex hybrid --query <q>          # BM25F + dense, fused by RRF
webindex changed <url> [--etag <v>]  # a 304 costs one round trip
webindex cache status|clean [--all]
webindex searxng|firecrawl|semantic|stack up|down|status
webindex skill check|bundle|vendor|copy|doctor|init
webindex doctor
```

Every command takes `--json`. Human output goes to stdout and degradation notes
to stderr, so `webindex search q | head` stays a clean URL list.

## What it will and will not do

**In scope.** Discovery (SearXNG, the keyless engines, Firecrawl), retrieval
(streaming byte caps, conditional GET, HTML→text, main-content extraction, the
PDF and office ladders, Wayback rescue, a revalidating cache), text (keyword
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

## Three rules that constrain every change

- **No runtime dependencies, ever.** Consumers vendor `scripts/engine.mjs` and
  inline it; a bare specifier cannot resolve there. CI fails on any non-builtin
  import.
- **Node 18 is the floor.** A dedicated job runs the committed bundle on 18 with
  no install, because the dev toolchain needs ≥20.19 and so cannot prove it.
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

## References

- `references/web-discovery.md` — the discovery cascade, and what each rung costs.
- `references/provider-apis.md` — forges and package registries, and their quotas.
- `references/ranking.md` — how a candidate pool becomes a reading order.
- `references/semantic.md` — embeddings, the vector store, and why the two lanes are fused rather than chosen between.
- `references/orchestration.md` — declaring phases, and the two constraints the emitted workflow must obey.
- `references/skill-kit.md` — `skill.json`, the packaging gates, and the two ways a vendored engine goes wrong.
