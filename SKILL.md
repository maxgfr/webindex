---
name: webindex
description: The web-side engine — find pages with a local keyless stack or the keyless engines, turn a URL or a file into clean citable text (HTML, PDFs through a six-rung ladder ending in OCR, office documents), rank a candidate pool, ask a forge or a package registry about a project, and read what a site publishes about itself. Zero dependencies, no API key.
---

# webindex

A library of **primitives**, not a pipeline. It is vendored by other tools as a
single file, and it also runs as a CLI and an MCP server so an agent can use it
directly.

This document is served over MCP as `skill://SKILL.md`, alongside
`skill://references/*.md` — so `webindex mcp` documents its own engine.

## The commands

```
webindex search <query> [--engine ddg|ddglite|mojeek|off] [--limit n] [--lang tag]
webindex fetch <url>                 # → clean text, whatever the format
webindex extract <file>              # the same, on disk
webindex rank --query <q> --docs <f> # BM25F + near-dup collapse + MMR
webindex repo|issues|prs|releases <ref>
webindex package <name> [--registry npm|pypi|crates]
webindex meta|robots|sitemap|feed <url>
webindex cache status|clean [--all]
webindex searxng|firecrawl|semantic|stack up|down|status
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

**Out of scope, deliberately.** Evidence models, document layouts and citation
gates. How a tool numbers its sources, where it writes them and what it counts as
grounded are product decisions — baking one choice in here would dictate
behaviour rather than share plumbing.

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
