// webindex — the public surface.
//
// Everything a consuming skill can use must be re-exported HERE. The vendored
// artifact is a single bundle plus a single declaration file, so this module is
// the whole API: anything not named below simply does not exist downstream.
//
// The shape is deliberately a library of PRIMITIVES, not a pipeline. A consumer
// keeps its own evidence model, its own document layout and its own citation
// gate — those are product decisions, and folding them in here would dictate
// behaviour rather than share plumbing. webindex owns the part that is the same
// everywhere: turning a URL into clean text, discovering candidates, and
// ranking them.
//
// Layers land in order: retrieval, then text and ranking, then discovery. Each
// ships as its own release.

// ── Engine identity ─────────────────────────────────────────────────────────
export { ENGINE_VERSION } from "./version.js";

// ── Brand injection ─────────────────────────────────────────────────────────
// Consumers call configure() once at CLI and MCP startup. Read the lazy rule in
// brand.ts before adding any module-scope tunable anywhere in this package.
export { type Brand, brand, configure, env, envFlag, envInt, envName, resetBrand } from "./brand.js";

// ── Retrieval: PDF ──────────────────────────────────────────────────────────
// The ladder tries the strongest available extractor first: native reader →
// pdf-inspector → anydoc → Firecrawl → pdftotext → OCR.
export * from "./pdf.js";

// ── Retrieval: office documents ─────────────────────────────────────────────
// `docFormatForUrl` / `docFormatForContentType` decide whether a response is an
// office document; `extractDocument` converts it, or refuses rather than let
// the caller cite bytes nothing could read.
export * from "./doc.js";

// Running an external converter on stdin. Exported because the ladders' rungs
// are pinned npx specs that consumers surface in their `doctor` output.
export { ANYDOC_SPEC, PDF_INSPECTOR_SPEC, runWithInput } from "./pdf/exec.js";

// ── Retrieval: HTTP and extraction ──────────────────────────────────────────
// httpGet/httpJson are the retrying, byte-capped, never-throwing HTTP floor;
// fetchAndExtract is the whole decision tree from a URL to citable text
// (Firecrawl → PDF ladder → office ladder → built-in HTML extractor), with
// rescueViaWayback behind it for dead links.
export * from "./fetch.js";

// The Firecrawl CLIENT — probe, scrape, search. The discovery *backend* built
// on top of it stays with the consumer until the discovery layer moves.
export {
  apiPrefix,
  FIRECRAWL_DEFAULT_BASE,
  firecrawlBase,
  firecrawlIsExplicit,
  looksLikeFirecrawl,
  mapScrapeResponse,
  markFirecrawlDown,
  mapSearchResponse,
  probeFirecrawl,
  resetFirecrawlProbeCache,
  scrapeViaFirecrawl,
  searchViaFirecrawl,
  type FirecrawlHit,
  type FirecrawlOptions,
  type FirecrawlScrape,
  type ScrapeAttempt,
} from "./firecrawl.js";

// ── Text: keywords, matching, and excerpt windows ───────────────────────────
// `excerptWindows` is the scanning half of "turn a page into excerpts": score
// lines against the question, widen the best ones into readable passages, stop
// them overlapping. What an excerpt then IS — a citation, an evidence item —
// stays with the consumer, because that is its model and not this one's.
export * from "./text.js";

// ── URL identity ────────────────────────────────────────────────────────────
export * from "./url.js";

// ── Ranking ─────────────────────────────────────────────────────────────────
// Turning a pool of candidates into a reading order: RRF fusion, BM25F, SimHash
// near-duplicate collapse, MMR diversification, identity parsing. Every function
// is generic over the caller's item type — the engine ranks, it does not model
// evidence.
export * from "./rank.js";

// ── Is this URL worth citing, and where does its text live? ─────────────────
// Whether a URL addresses a specific document or is a bare API endpoint, and
// how to turn a landing page into the readable version of the same work.
export * from "./citable.js";
export * from "./providers.js";

// ── Locale ──────────────────────────────────────────────────────────────────
// Turning a language tag into the Accept-Language header and the region codes
// the keyless engines expect.
export * from "./locale.js";

// ── Running a local command ─────────────────────────────────────────────────
// `git`, `gh`, a converter — with the one distinction that matters kept: the
// command failed, or the command is not installed.
export * from "./exec.js";

// ── Naming a repository, and getting a working tree ─────────────────────────
// resolveRepo parses every identifier shape onto one ref; ensureClone gives it a
// shallow, blobless checkout, deepened on demand.
export * from "./repo.js";

// ── Forge APIs ──────────────────────────────────────────────────────────────
// GitHub, GitLab and Gitea: issues, pull requests, releases, tags, repo facts.
// Keyless by default; a token raises the quota rather than being required.
export * from "./forge.js";

// ── Package registries ──────────────────────────────────────────────────────
// A library's NAME → its repository, docs, current version, licence and whether
// it is deprecated. One request instead of a web search and a guess.
export * from "./registry.js";

// ── Character encoding ──────────────────────────────────────────────────────
// Bytes → text, honouring a BOM, the Content-Type charset and `<meta charset>`.
// httpGet uses this; it is exported because a caller holding bytes from
// somewhere else has the same problem.
export * from "./charset.js";

// ── robots.txt ──────────────────────────────────────────────────────────────
// Advisory, on purpose: it answers whether a URL is ours to fetch. It does not
// gate fetchAndExtract — following one citation is not crawling.
export * from "./robots.js";

// ── What a page says about itself ───────────────────────────────────────────
// JSON-LD, OpenGraph and the standard meta tags: author, dates, type, canonical.
export * from "./structured.js";

// ── Feeds and sitemaps ──────────────────────────────────────────────────────
// The two machine-readable indexes a site publishes about its own content.
export * from "./feed.js";

// ── Keyless web engines ─────────────────────────────────────────────────────
// The HTML endpoints that answer with no key, no container and no account:
// result-block parsers, pagination shapes, and the throttled-vs-unreachable
// distinction. Provider shape rots on somebody else's schedule, so it deserves
// exactly one maintained copy rather than one per tool.
export * from "./engines.js";

// ── Discovery ───────────────────────────────────────────────────────────────
// Turning a question into candidate URLs: the local stack, then the keyless
// engines, then Firecrawl. A cascade, not a fan-out — the first rung with hits
// wins, because pooling several engines and fusing them is a ranking decision
// and ranking is the caller's to make (with ./rank.js, if it wants).
export * from "./search.js";

// ── The optional local container stack ──────────────────────────────────────
// SearXNG, Firecrawl and the semantic pair, embedded so they can be driven from
// any install rather than only from a checkout. Everything here is optional:
// each service degrades to a note when absent.
export * from "./stack.js";

// ── Bounded concurrency ─────────────────────────────────────────────────────
// Retrieval is latency-bound, so N pages should overlap — but not all of them,
// or a keyless engine starts answering 429 to everything.
export * from "./pool.js";

// ── Serialising work per key ────────────────────────────────────────────────
// A per-key promise chain, so two concurrent calls touching the same directory
// or repository queue instead of racing.
export * from "./run-lock.js";

// ── The on-disk fetch cache ─────────────────────────────────────────────────
export * from "./cache.js";

// ── The write gate ──────────────────────────────────────────────────────────
// One switch every write passes through, so read-only operation is a property
// of this module rather than a promise each command has to keep individually.
// `writeArtifact` is atomic; `writeFileAtomic` is the ungated primitive under it.
export { type Artifact, ensureDir, isNoWrite, resetNoWrite, setNoWrite, takeArtifacts, writeArtifact, writeFileAtomic } from "./no-write.js";

// ── The run directory ───────────────────────────────────────────────────────
// Naming a run, reading what is in it without throwing, and writing back
// safely. The manifest's SHAPE stays with the consumer — this knows a run
// directory holds JSON, not what the JSON means.
export * from "./run.js";

// ── Has this page changed? ──────────────────────────────────────────────────
// The conditional GET was already here; the ANSWER was not. A 304 costs one
// round trip and no body, and the verdict says how it was decided — "unchanged
// by etag" and "unchanged by hash" are different strengths of evidence.
export * from "./changed.js";

// ── Tables, read as tables ──────────────────────────────────────────────────
// htmlToText flattens a <table> into a run of cell text, which for prose is
// right and for data is destructive: every figure loses the row and column it
// belonged to, invisibly, because the result still reads plausibly.
export * from "./tables.js";

// ── Politeness, and walking a site on purpose ───────────────────────────────
// A per-host token bucket that finally APPLIES the Crawl-delay robots.ts has
// always parsed, and the bounded BFS that is the one caller robots.txt was
// written for. `fetch` follows a URL it was handed and does not ask; this
// enumerates, so it asks at every hop.
export * from "./crawl.js";

// ── Embeddings and vectors ──────────────────────────────────────────────────
// The other half of the container stack this package already ships. `semantic
// up` has started Ollama and Qdrant and pulled the model since v1.11, and until
// now nothing here could call either. Optional like every service: absent means
// a note and a lexical-only ranking, never an exception.
export * from "./embed.js";
export * from "./vector.js";

// ── Reading citations out of a report ───────────────────────────────────────
// The MECHANICS only: which bracketed tokens are citations, what a claim unit
// is, and which regions of a document cannot ground one. Nothing here returns
// a pass or a fail — what counts as grounded stays with the consumer, because
// that is the sentence its users argue about.
export * from "./cite.js";

// ── The multi-agent fan-out ─────────────────────────────────────────────────
// Worklists → one Workflow script per phase, the dispatch contracts it
// references, and a sequential runbook. The skill declares its phases and
// writes its contracts; the engine owns the emission, the batching, the
// one-writer footer and the harness constraints the emitted script must obey.
export * from "./orchestrate.js";

// ── The command-line harness ────────────────────────────────────────────────
// A validating argv parser driven by the caller's own flag tables, the exit-code
// taxonomy, and the matchers a docs↔CLI drift gate reads. Used BY command lines;
// it is not one itself, so nothing here touches process.argv at module scope.
export * from "./cli-kit.js";

// ── MCP transport ───────────────────────────────────────────────────────────
// The whole protocol: version negotiation, notification vs request,
// cancellation, schema validation, response capping, the error taxonomy, and
// both transports. The consumer supplies an McpAdapter naming ITS tools — the
// one thing the engine cannot know — and keeps its tools/handlers/prompts.
export * from "./mcp/protocol.js";
export {
  createServer,
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  PromptError,
  ToolError,
  type JsonRpcMessage,
  type McpAdapter,
  type McpServer,
  type PromptDecl,
  type PromptResult,
  type ServerOptions,
  type ToolDecl,
  type ToolOutcome,
} from "./mcp/server.js";
export { runStdioServer, type StdioOptions } from "./mcp/stdio.js";
export { startHttpServer, type HttpOptions, type RunningHttpServer } from "./mcp/http.js";
export {
  listResources,
  readResource,
  resolveSkillRoot,
  ResourceError,
  skillName,
  type ResourceContents,
  type ResourceDecl,
} from "./mcp/resources.js";
