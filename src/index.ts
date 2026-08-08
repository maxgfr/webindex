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

// ── Text: keywords and matching ─────────────────────────────────────────────
export * from "./text.js";

// ── URL identity ────────────────────────────────────────────────────────────
export * from "./url.js";

// ── Is this URL worth citing, and where does its text live? ─────────────────
// Whether a URL addresses a specific document or is a bare API endpoint, and
// how to turn a landing page into the readable version of the same work.
export * from "./citable.js";
export * from "./providers.js";

// ── Locale ──────────────────────────────────────────────────────────────────
// Turning a language tag into the Accept-Language header and the region codes
// the keyless engines expect.
export * from "./locale.js";

// ── Discovery ───────────────────────────────────────────────────────────────
// Turning a question into candidate URLs, using the local keyless stack. A
// primitive, not a pipeline: no backend fan-out, no fusion, no ranking.
export * from "./search.js";

// ── The optional local container stack ──────────────────────────────────────
// SearXNG, Firecrawl and the semantic pair, embedded so they can be driven from
// any install rather than only from a checkout. Everything here is optional:
// each service degrades to a note when absent.
export * from "./stack.js";

// ── Serialising work per key ────────────────────────────────────────────────
// A per-key promise chain, so two concurrent calls touching the same directory
// or repository queue instead of racing.
export * from "./run-lock.js";

// ── The on-disk fetch cache ─────────────────────────────────────────────────
export * from "./cache.js";

// ── The write gate ──────────────────────────────────────────────────────────
// One switch every write passes through, so read-only operation is a property
// of this module rather than a promise each command has to keep individually.
export { type Artifact, ensureDir, isNoWrite, resetNoWrite, setNoWrite, takeArtifacts, writeArtifact } from "./no-write.js";

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
