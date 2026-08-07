// webindex — the public surface.
//
// Everything a consuming skill can use must be re-exported HERE. The vendored
// artifact is a single bundle plus a single declaration file, so this module is
// the whole API: anything not named below simply does not exist downstream.
//
// The shape is deliberately a library of PRIMITIVES, not a pipeline. Each skill
// keeps its own evidence model (construct and ultradoc number sources `E#`,
// ultrasearch numbers them `S#`), its own dossier layout, and its own citation
// gate — those genuinely differ, and folding them in here would change three
// skills' behaviour rather than share their plumbing. webindex owns the part
// that is provably the same everywhere: turning a URL into clean text,
// discovering candidates, and ranking them.
//
// Layers land in order (see the migration plan): retrieval, then text+ranking,
// then discovery. Each layer ships as its own release and each consumer re-pins
// before the next one starts.

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
