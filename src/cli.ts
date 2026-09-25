#!/usr/bin/env node
import { checkArtifactRecall } from "./skillkit/recall.js";
import { finishRepin } from "./skillkit/finish.js";
import { repinSkill, releaseCommit } from "./skillkit/repin.js";
// The webindex command line.
//
// A SECOND tsup entry, deliberately not reachable from src/index.ts. The
// consumers vendor that bundle and inline it, so anything exported from there
// ends up inside three skills that cannot invoke it — and a module-scope
// configure() in a CLI would race the skill's own. The library and the command
// share src/ and ship as two separate files.
//
// What it offers is what the engine actually does today: discover candidate
// URLs through the local keyless stack, turn a URL or a local file into clean
// text, drive the containers, and serve all of that to an agent over MCP.
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configure, env, envName } from "./brand.js";
import { decodeLocal } from "./charset.js";
import { ENGINE_VERSION } from "./version.js";
import { DOC_EXTRACTORS, docFormatForUrl, extractDocument, enabledDocExtractors, sniffDocument } from "./doc.js";
import { enabledExtractors, extractPdf, ocrBudgetLeft, ocrTools, PDF_EXTRACTORS } from "./pdf.js";
import { ANYDOC_SPEC, PDF_INSPECTOR_SPEC } from "./pdf/exec.js";
import { npxCacheState } from "./pdf/npx.js";
import { have } from "./exec.js";
import { extractMainHtml, htmlToText, httpGet, looksLikePdfUrl, stripConsentBoilerplate } from "./fetch.js";
import { firecrawlBase, probeFirecrawl } from "./firecrawl.js";
import { embedModel, ensureComposeMaterialized, STACK_SERVICES, stackControl } from "./stack.js";
import { ollamaBase, probeOllama } from "./embed.js";
import { hybridSearch, probeQdrant, qdrantBase } from "./vector.js";
import { embed } from "./embed.js";
import { crawlSite } from "./crawl.js";
import { extractTables, tableToMarkdown } from "./tables.js";
import { fingerprint, hasChanged } from "./changed.js";
import { auditEngineUsage, auditSkillBundle, checkPins, readSkillConfig, scaffoldSkill, vendorEngine, type CliSurface } from "./skillkit/index.js";
import { isKeylessEngine, KEYLESS_ENGINES, type KeylessEngine } from "./engines.js";
import { probeSearxng, search, searxngBase } from "./search.js";
import { cacheClean, cacheDir, cachedFetchAndExtract, cacheStats, setCacheMode } from "./cache.js";
import { fetchRobots, isAllowed } from "./robots.js";
import { discoverFeeds, fetchFeed, fetchSitemap, parseFeed } from "./feed.js";
import { pageMetadata } from "./structured.js";
import { type RepoRef, resolveRepo } from "./repo.js";
import { type ForgeKind, forgeRef, listReleases, listTags, repoFactsResult, searchIssues } from "./forge.js";
import { type RegistryKind, resolvePackageResult } from "./registry.js";
import { bm25MatchedTerms, bm25Score, bm25Tokenize, buildBm25Index, dedupeNearDuplicates, diversify } from "./rank.js";
import {
  argBool,
  argInt,
  argValue,
  type CliSpec,
  type CommandArgs,
  EXIT_FAILURE,
  EXIT_USAGE,
  isInvokedDirectly,
  jsonLine,
  parseArgs,
  positionalText,
  UsageError,
} from "./cli-kit.js";
import { ensureDir, isNoWrite, writeArtifact } from "./no-write.js";
import type { JsonSchemaProp } from "./mcp/protocol.js";
import { InvalidParamsError, ToolError, type McpAdapter, type ToolDecl } from "./mcp/server.js";
import { runStdioServer } from "./mcp/stdio.js";
import { startHttpServer } from "./mcp/http.js";

configure({ name: "webindex", envPrefix: "WEBINDEX", cli: "webindex", contactUrl: "https://github.com/maxgfr/webindex" });

export const HELP = `webindex v${ENGINE_VERSION}
Find pages with a local keyless search stack, turn a URL or a file into clean,
citable text — HTML, PDFs through a six-rung ladder ending in OCR, and office
documents — and serve that to an agent over MCP. Zero dependencies, no API key.

USAGE
  webindex search <query> [--json] [--limit <n>] [--pages <n>] [--lang <tag>]
                          [--engine ddg|ddglite|mojeek|off] [--searxng <base>|off]
  webindex fetch <url> [--json] [--firecrawl <base>|off] [--lang <tag>] [--full-page]
                       [--cache] [--refresh] [--offline] [--timeout <ms>]
  webindex extract <file> [--json] [--full-page]
  webindex rank --query <q> [--docs <file.json|->] [--limit <n>] [--json]
  webindex repo <ref> [--forge github|gitlab|gitea] [--json]
  webindex issues <ref> [--terms "<words>"] [--limit <n>] [--forge <kind>] [--json]
  webindex prs <ref> [--terms "<words>"] [--limit <n>] [--forge <kind>] [--json]
  webindex releases <ref> [--limit <n>] [--forge <kind>] [--json]
  webindex tags <ref> [--limit <n>] [--forge <kind>] [--json]
  webindex package <name> [--registry npm|pypi|crates] [--version <semver>] [--json]
  webindex meta <url> [--json]
  webindex robots <url> [--json]
  webindex sitemap <url> [--max <n>] [--json]
  webindex feed <url> [--json]
  webindex mcp [--transport stdio|http] [--port <n>] [--bind <addr>] [--allow-remote]
  webindex searxng   up|down|status
  webindex firecrawl up|down|status
  webindex semantic  up|down|status
  webindex stack     up|down|status|path
  webindex cache     status|clean [--all] [--json]
  webindex crawl <url> --max <n> [--depth <n>] [--cross-origin] [--json]
  webindex tables <url> [--markdown] [--json]
  webindex embed <text> [--json]
  webindex hybrid --query <q> [--docs <file.json|->] [--limit <n>] [--json]
  webindex changed <url> [--etag <v>] [--last-modified <date>] [--hash <sha256>]
                         [--timeout <ms>] [--json]
  webindex skill     check|bundle|copy|doctor [--root <dir>] [--json]
  webindex skill     vendor [--engine <name>] --ref <tag> | --check
  webindex skill     init <name> [--root <dir>]
  webindex doctor
  webindex version

COMMANDS
  search     Find candidate URLs: a local SearXNG first, then the keyless
             engines (DuckDuckGo, DDG Lite, Mojeek — no key, no container),
             then Firecrawl. Prints what it found, or says which backend was
             missing and how to start it — those are different answers.
  fetch      Fetch a URL and print the extracted text. Routes PDFs and office
             documents to their ladders automatically — by URL, content-type,
             download filename or the bytes themselves; images, media and
             archives get a note, never their bytes. Uses Firecrawl when
             available, with built-in extraction as fallback. HTML is reduced
             to main content with consent banners dropped. Caching is opt-in:
             --cache reuses a fresh copy for the TTL (24 h) and revalidates a
             stale one with a conditional GET, so an unchanged page costs a
             304; --refresh re-fetches and rewrites the entry; --offline
             serves only what the cache holds. --json adds finalUrl (after
             redirects), canonical, documentType and cached.
  extract    Same extraction, on a file already on disk, recognised by its bytes
             when its name says otherwise. For both, --full-page keeps the
             whole HTML page through the built-in reader: navigation, footer
             and consent banners included.
  rank       Order candidate documents against a question — BM25F, then a
             near-duplicate collapse, then MMR so the top says several
             different things. Reads a JSON array of {url,title,text} from
             --docs or stdin. Deterministic; no model, no network.
  repo       A repository's own facts: stars, licence, default branch, last
             push, and whether it is archived — the record, not the README.
             A <ref> is owner/repo, any repository URL (one copied from a
             browser works), git@host:owner/repo, or a local checkout, read as
             its origin. --forge names what a self-hosted host runs when its
             name does not say (salsa.debian.org is a GitLab).
  issues     Search a repository's issues on GitHub, GitLab or Gitea. Every
             term must match; when together they match nothing, it searches
             once more with the most distinctive ones and says so on stderr.
  prs        The same, over pull or merge requests.
  releases   Its releases, newest first, with their notes.
  tags       Its tags — the versions of a project that tags without
             publishing releases.
  package    A library NAME resolved through npm, PyPI or crates.io to its
             repository, docs, current version, licence and deprecation.
             --version answers for that version (or an npm dist-tag) or not
             at all. A registry that cannot be reached stops the search, so
             another ecosystem's namesake never answers in its place.
  meta       What a page says about itself: JSON-LD, OpenGraph and meta tags —
             author, dates, type, canonical URL.
  robots     Whether robots.txt permits fetching that URL. Exits non-zero when
             it does not, so it composes in a shell.
  sitemap    The URLs a site lists in its sitemap, following the index at most
             --max documents deep (default 3).
  feed       A site's RSS/Atom feed, or the feeds the page advertises.
  mcp        Serve fetch/extract to an agent over MCP (stdio by default).
  searxng    Bring the keyless SearXNG container up or down, or show it.
  firecrawl  Same for Firecrawl, which cleans a page with a real browser. It
             delegates its own search to SearXNG, so this starts both.
  semantic   Qdrant and Ollama, and the embedding model pulled once they answer.
             The engine starts them; what to embed is the caller's business.
  stack      Everything at once; 'path' prints where the compose file was
             written. The stack is EMBEDDED in this binary — no checkout needed.
  cache      What the on-disk fetch cache holds, and how to evict it. 'clean'
             drops stale entries, '--all' drops every one. Both only ever
             count or remove files the cache itself wrote.
  crawl      Walk a site from a seed, breadth-first, honouring robots.txt at
             every hop. --max is REQUIRED: following one citation is not
             crawling and needs no permission, but enumerating a site is, and
             an unbounded walk is the one thing here that can inconvenience
             somebody else's server.
  tables     The tables on a page as headers and rows, with colspan and rowspan
             resolved. Plain extraction flattens a table into prose in which
             every figure has lost its row and column.
  embed      Vectors for a text, from the local Ollama. No key, and nothing
             leaves the machine. Needs \`webindex semantic up\`.
  hybrid     Rank documents against a question with BOTH retrievers, fused by
             RRF: BM25F cannot find a page that never uses your words, and a
             dense index cannot match an exact identifier. Degrades to the
             lexical half, with a note, when no embedding server answers.
  changed    Whether a URL changed since a fingerprint you already hold. A 304
             costs one round trip and no body; the answer says how it was
             decided, because etag and content-hash are different evidence.
             With no --etag, --last-modified or --hash it prints a baseline
             (etag, last-modified, hash of the raw bytes, status), and fails
             rather than print one it could not read.
  skill      The packaging toolchain for a repository built ON this engine,
             driven by its skill.json. 'vendor' pins an engine by tag and
             sha256 (--check re-verifies offline, and fails a pin older than
             the source needs); 'check' refuses any module that DECLARES a name
             the engine exports; 'bundle' proves \`skills add\` would install a
             working skill rather than a lone SKILL.md; 'copy' embeds the built
             engine in the package; 'init' scaffolds a new skill repository.
             Dev-time only — it reads a repo, it never runs inside one.
  doctor     Report which optional helpers are reachable, and what each
             extraction rung will do on this machine: installed, downloads on
             first use, not installed, built-in, or switched off (and by which
             variable). The npx rungs are checked against npm's cache, never
             installed.

ENVIRONMENT
  WEBINDEX_FIRECRAWL     Firecrawl base URL, or "off"  (default http://localhost:3002)
  WEBINDEX_PDF_ENGINE    the PDF rungs to run, in order: a comma list of
                         pdf-inspector|anydoc|firecrawl|pdftotext|native|ocr, or "none"
  WEBINDEX_DOC_ENGINE    the office rungs to run, in order: a comma list of
                         anydoc|firecrawl|builtin, or "none" to disable
                         (builtin reads OOXML and OpenDocument with no network)
  WEBINDEX_NO_NPX        skip the rungs that would install through npx
  WEBINDEX_NPX_TIMEOUT_MS  how long one npx rung may run, first download included
                         (default 90000)
  WEBINDEX_OCR_MAX       documents this process may OCR (default 3)
  WEBINDEX_ENGINES       keyless engines to try: a comma list, or "off"  (default all)
  WEBINDEX_OLLAMA        embedding server base URL, or "off"  (default http://localhost:11434)
  WEBINDEX_QDRANT        vector store base URL, or "off"      (default http://localhost:6333)
  WEBINDEX_EMBED_MODEL   the embedding model to ask for       (default nomic-embed-text)
  WEBINDEX_TIMEOUT_MS    how long a request may stay silent before it is abandoned,
                         not retried (default 20000; --timeout overrides it per call)
  WEBINDEX_CACHE_DIR     where the fetch cache lives (default <tmp>/webindex-<uid>/cache)
  WEBINDEX_CACHE_TTL_HOURS  how long a cached page stays fresh (default 24; fractions allowed)
  WEBINDEX_CRAWL_CONCURRENCY  pages a crawl keeps in flight, 1-16 (default 4); one host still departs single-file
  WEBINDEX_POLITE_DELAY_MS    floor between two requests to one host, in ms (default 400)
  WEBINDEX_UA            override the browser User-Agent
  GITHUB_TOKEN, GH_TOKEN, GITLAB_TOKEN, GITEA_TOKEN
                         optional forge tokens; each goes only to github.com, gitlab.com,
                         or a host listed in WEBINDEX_FORGE_HOSTS
  WEBINDEX_FORGE_HOSTS   self-hosted forges, e.g. "salsa.debian.org=gitlab,git.corp=github":
                         each is queried as that forge and receives that forge's token

Every optional helper degrades to a note. Nothing here needs an API key.`;

// The flag surface, declared rather than discovered.
//
// Exported because two gates read them: tests/cli.test.ts asserts HELP names
// every one of them (SKILL.md promises `--help` is the full surface), and the
// skill-bundle gate reads the same tables off the built artifact to check the
// docs never document a flag the CLI would reject.
//
// Declaring them is also what makes `--limt 5` an error. It used to be silently
// dropped, and the command then ran to completion with the default budget and
// reported success.
export const VALUE_FLAGS = [
  "root",
  "ref",
  "engine",
  "depth",
  "etag",
  "last-modified",
  "hash",
  "limit",
  "pages",
  "lang",
  "searxng",
  "firecrawl",
  "engine",
  "query",
  "docs",
  "transport",
  "port",
  "bind",
  "registry",
  "version",
  "terms",
  "max",
  "timeout",
  "forge",
];
export const BOOL_FLAGS = ["json", "allow-remote", "all", "check", "markdown", "cross-origin", "full-page", "cache", "refresh", "offline"];
export const COMMANDS = [
  "search",
  "fetch",
  "extract",
  "rank",
  "repo",
  "issues",
  "prs",
  "releases",
  "tags",
  "package",
  "meta",
  "robots",
  "sitemap",
  "feed",
  "mcp",
  "cache",
  "doctor",
  "skill",
  "crawl",
  "tables",
  "embed",
  "hybrid",
  "changed",
  ...STACK_SERVICES.filter((s) => s !== "all"),
  "stack",
];

const SPEC: CliSpec = { commands: COMMANDS, valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS };

function fail(msg: string): never {
  process.stderr.write(`webindex: ${msg}\n`);
  process.exit(EXIT_FAILURE);
}

/**
 * The invocation itself was wrong — a missing required argument, or an action
 * that is not one of the listed ones.
 *
 * Distinct from fail() because cli-kit.ts's taxonomy promises it is: 1 is "ran,
 * and the answer is a failure: nothing found, a gate refused", 2 is "the
 * invocation itself was wrong". Every one of these used to exit 1 while printing
 * the word "usage:", so a script branching on the code read "you called me
 * wrong" as "there is nothing there" — and the README's own composable idiom
 * (`webindex robots <url> && fetch it`) is exactly such a script.
 */
function usage(msg: string): never {
  process.stderr.write(`webindex: ${msg}\n`);
  process.exit(EXIT_USAGE);
}

/** `--timeout <ms>`: a positive whole number of milliseconds, or absent for the default. */
function argTimeout(args: CommandArgs): number | undefined {
  const ms = argInt(args, "timeout");
  if (ms !== undefined && ms < 1) throw new UsageError(`--timeout expects a positive number of milliseconds, got "${ms}"`);
  return ms;
}

/**
 * The MCP fetch tool's `timeoutMs`. Clamped rather than refused: an agent's
 * odd value should cost it a default, not the call — but never an unbounded
 * wait on a server other clients share.
 */
function toolTimeoutMs(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(300_000, Math.max(1, Math.round(n))) : undefined;
}

const FORGE_KINDS: readonly ForgeKind[] = ["github", "gitlab", "gitea"];
const isForgeKind = (v: string): v is ForgeKind => (FORGE_KINDS as readonly string[]).includes(v);
const isRegistryKind = (v: string): v is RegistryKind => v === "npm" || v === "pypi" || v === "crates";

// The optional `forge` argument the repository tools share.
const FORGE_ARG: JsonSchemaProp = {
  type: "string",
  description: "Which forge a self-hosted host runs when its name does not say (salsa.debian.org is gitlab). Omit for github.com, gitlab.com, Codeberg.",
  enum: [...FORGE_KINDS],
};

/** A repository argument as the forge commands read it: parsed, and a local checkout read as its origin. */
function forgeTarget(raw: string, kind: ForgeKind | undefined): RepoRef {
  const opts = kind ? { kind } : {};
  return forgeRef(resolveRepo(raw, opts), opts);
}

/** Extraction over bytes already in hand — the shared half of `extract`. */
async function extractLocal(path: string, fullPage = false): Promise<{ text: string; extractor: string; reason?: string; consentDropped: number }> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new ToolError(`cannot read ${path}: ${(e as Error).message}`);
  }
  const asUrl = pathToFileURL(path).href;

  // The bytes before the name: an extension-less download or a .docx saved as
  // .txt is still a document, and read by its name it came back as the ZIP's
  // bytes under extractor "plain".
  const sniffed = sniffDocument(bytes);
  if (sniffed === "pdf" || (!sniffed && looksLikePdfUrl(asUrl))) {
    const r = await extractPdf(bytes);
    return { text: r.text, extractor: r.via ?? "none", reason: r.reason, consentDropped: 0 };
  }
  const fmt = sniffed ?? docFormatForUrl(asUrl);
  if (fmt) {
    const r = await extractDocument(bytes, fmt);
    // A format that is already text (CSV) is read as text when nothing could
    // convert it, as fetchAndExtract does — refusing it helped no one.
    if (!r.text && fmt.textFallback) return { text: decodeLocal(bytes, { sniffHtmlCharset: false }), extractor: "plain", consentDropped: 0 };
    return { text: r.text, extractor: r.via ?? "none", reason: r.reason, consentDropped: 0 };
  }
  const extension = extname(path).toLowerCase();
  const explicitText = [".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".xml", ".yaml", ".yml"].includes(extension);
  // A Markdown file quoting `<meta charset="iso-8859-1">` as an example is not
  // declaring its own encoding: only a document that may be HTML gets sniffed.
  const raw = decodeLocal(bytes, { sniffHtmlCharset: !explicitText });
  // Decoded text keeps no NUL (a UTF-16 BOM is honoured above); binary data —
  // an image, an archive — always has one early. Never print its bytes.
  if (raw.slice(0, 1024).includes("\u0000")) return { text: "", extractor: "none", reason: "binary data, not a text document", consentDropped: 0 };
  const looksHtml = !explicitText && ([".html", ".htm", ".xhtml"].includes(extension) || /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(raw));
  const text = looksHtml ? htmlToText(fullPage ? raw : extractMainHtml(raw), { fullPage }) : raw;
  const consent = looksHtml && !fullPage ? stripConsentBoilerplate(text) : { text, dropped: 0 };
  return { text: consent.text, extractor: looksHtml ? "native" : "plain", consentDropped: consent.dropped };
}

/** One candidate as the CLI and the MCP tool accept it. */
interface RankInput {
  url: string;
  title?: string;
  headings?: string;
  text?: string;
  score?: number;
}

interface RankedOut {
  rank: number;
  url: string;
  title?: string;
  score: number;
  matched: string[];
}

/**
 * The shared ranking pipeline behind `webindex rank` and `webindex_rank`.
 *
 * BM25F for relevance, SimHash to collapse syndicated copies, MMR so the top of
 * the list is not four rewrites of one argument. Scores are normalised to the
 * pool max, so "0.7" means "70% as relevant as the best thing here" rather than
 * an uncalibrated BM25 magnitude nobody can compare across runs.
 */
function rankDocuments(question: string, docs: RankInput[], limit?: number): { ranked: RankedOut[]; collapsed: number; queryTerms: string[] } {
  const bm = docs.map((d, i) => ({ id: String(i), title: d.title ?? "", headings: d.headings ?? "", body: d.text ?? "" }));
  const index = buildBm25Index(question, bm);
  const raw = docs.map((_, i) => bm25Score(index, bm[i]!));
  const max = Math.max(...raw, 1e-9);

  const scored = docs.map((d, i) => ({
    url: d.url,
    title: d.title,
    text: d.text ?? "",
    score: (raw[i] ?? 0) / max,
    matched: bm25MatchedTerms(index, bm[i]!),
  }));
  // Code-unit tie-break: localeCompare reads LANG, and two machines disagreed.
  scored.sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  const { items: unique, dropped } = dedupeNearDuplicates(scored);
  const ordered = diversify(unique, (it) => new Set(bm25Tokenize(it.text)));

  const ranked = ordered.slice(0, limit && limit > 0 ? limit : undefined).map((it, i) => ({
    rank: i + 1,
    url: it.url,
    ...(it.title ? { title: it.title } : {}),
    score: Number(it.score.toFixed(4)),
    matched: it.matched,
  }));
  return { ranked, collapsed: dropped, queryTerms: index.queryTerms };
}

/** Parse and validate the `documents` payload both entry points accept. */
function parseRankDocs(value: unknown, where: string): RankInput[] {
  const arr = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(arr) || !arr.length) throw new Error(`${where} must be a non-empty JSON array of {url, text}`);
  return arr.map((d, i) => {
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(`${where}[${i}] is not an object`);
    const url = (d as RankInput).url;
    if (typeof url !== "string" || !url) throw new Error(`${where}[${i}] has no url`);
    for (const field of ["title", "headings", "text"] as const) {
      if (d[field] !== undefined && typeof d[field] !== "string") throw new Error(`${where}[${i}].${field} must be a string`);
    }
    if (d.score !== undefined && (typeof d.score !== "number" || !Number.isFinite(d.score))) {
      throw new Error(`${where}[${i}].score must be a finite number`);
    }
    return d as RankInput;
  });
}

/**
 * webindex's own MCP tools: fetch a URL, extract a file.
 *
 * Exported because it is a useful seam in both directions — the suite drives it
 * without a subprocess, and a host embedding several engines can mount these
 * tools inside its own server rather than spawning `webindex mcp`.
 */
export function webindexAdapter(): McpAdapter {
  return {
    version: ENGINE_VERSION,
    listTools: (): ToolDecl[] => [
      {
        name: "webindex_search",
        title: "Search for candidate URLs",
        description:
          "Find candidate URLs: a locally-running SearXNG first, then the keyless engines (DuckDuckGo, DuckDuckGo Lite, Mojeek — no key, no container), then Firecrawl. " +
          "Returns title, URL and snippet — not page text; follow up with webindex_fetch on the ones worth reading. " +
          "When nothing answers it says which piece was missing rather than returning an empty result that reads like 'nothing exists'.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for." },
            limit: { type: "number", description: "How many hits to aim for (default 10)." },
            lang: { type: "string", description: "BCP-47 language tag, e.g. fr-FR." },
            engine: {
              type: "string",
              description: "Pin one keyless engine: ddg | ddglite | mojeek. Omit to let the cascade choose.",
              enum: [...KEYLESS_ENGINES],
            },
          },
          required: ["query"],
        },
      },
      {
        name: "webindex_fetch",
        title: "Fetch a URL as clean text",
        description:
          "Fetch a URL and return its readable text. Handles HTML, PDFs (pdf-inspector → anydoc → Firecrawl → pdftotext → native → OCR) and office documents (anydoc → Firecrawl → a built-in OOXML/OpenDocument reader), " +
          "and uses Firecrawl when available, with built-in extraction as fallback. Returns the extracted text, then a trailer with the final URL after redirects, the page's canonical URL and title, any note, and which rung produced it — never raw bytes. " +
          "Accepts URLs from the host's native search (including ChatGPT or Claude) or supplied directly; webindex_search is optional.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The http(s) URL to fetch." },
            lang: { type: "string", description: "Accept-Language tag, e.g. fr-FR." },
            fullPage: { type: "boolean", description: "Keep the whole page: no main-content isolation, no consent-banner filter." },
            timeoutMs: { type: "number", description: "Give up on a silent host after this many ms (default 20000). A timed-out request is not retried." },
            cache: {
              type: "boolean",
              description: "Use the on-disk cache: a fresh copy is reused for its TTL (24 h by default), a stale one revalidated with a conditional GET.",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "webindex_extract",
        title: "Extract text from a local file",
        description: "Read a PDF, office document or HTML file already on disk and return its text, using the same extraction ladders as webindex_fetch.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the file." },
            fullPage: { type: "boolean", description: "Keep the whole page: no main-content isolation, no consent-banner filter." },
          },
          required: ["path"],
        },
      },
      {
        name: "webindex_rank",
        title: "Rank candidate documents against a question",
        description:
          "Order a pool of documents by relevance to a question: BM25F (title and headings weighted above body), then SimHash collapse of near-duplicates, then MMR so the top of the list says several different things rather than restating one. " +
          "Returns the ranking with a score, the matched query terms, and what was collapsed — deterministic, no model, no network. Use it after gathering pages from any search provider to decide what to actually read. Scores measure relevance within this pool, not factual accuracy.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "What the ranking is for." },
            documents: {
              type: "array",
              description:
                'The pool. Each item is {url, text} plus optional {title, headings, score}. Passed as JSON, e.g. [{"url":"…","title":"…","text":"…"}].',
            },
            limit: { type: "number", description: "How many ranked entries to return (default all)." },
          },
          required: ["question", "documents"],
        },
      },
      {
        name: "webindex_repo",
        title: "A repository's own facts",
        description:
          "Read a repository's record from GitHub, GitLab or Gitea: description, stars, licence, default branch, last push, topics, and whether it is ARCHIVED. " +
          "Answers 'is this maintained' from the forge rather than from a README that says it is. Keyless; a token only raises the quota.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/repo, a URL (a browser URL works), git@host:owner/repo, or a local checkout (read as its origin)." },
            forge: FORGE_ARG,
          },
          required: ["repo"],
        },
      },
      {
        name: "webindex_issues",
        title: "Search a repository's issues or pull requests",
        description:
          "Search issues (or pull/merge requests) in one repository across GitHub, GitLab and Gitea. Returns number, title, state, labels and body. " +
          "GitHub results for `terms` are relevance-ranked and carry a score; GitLab and Gitea have no search endpoint, so theirs are recency-ordered and carry none — deliberately, rather than inventing one. " +
          "Every term must match; when all of them together match nothing, it searches once more with the most distinctive ones and says so in `note`.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/repo, or a repository URL." },
            terms: { type: "string", description: "What to look for." },
            kind: { type: "string", description: "issue (default) or pr.", enum: ["issue", "pr"] },
            limit: { type: "number", description: "How many to return (default 10)." },
            forge: FORGE_ARG,
          },
          required: ["repo"],
        },
      },
      {
        name: "webindex_releases",
        title: "A repository's releases",
        description:
          "List releases newest-first with their notes and dates — the authoritative answer to 'what changed', and to 'when was X added'. " +
          "A project that tags versions without publishing releases has none: use webindex_tags for it.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/repo, or a repository URL." },
            limit: { type: "number", description: "How many (default 20)." },
            forge: FORGE_ARG,
          },
          required: ["repo"],
        },
      },
      {
        name: "webindex_tags",
        title: "A repository's tags",
        description:
          "List a repository's tags with a link to each — the versions of a project that tags without publishing forge releases, where webindex_releases finds nothing.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/repo, or a repository URL." },
            limit: { type: "number", description: "How many (default 50)." },
            forge: FORGE_ARG,
          },
          required: ["repo"],
        },
      },
      {
        name: "webindex_package",
        title: "Resolve a library name to its real coordinates",
        description:
          "Look a package up in npm, PyPI or crates.io and return its repository, homepage, documentation URL, current version, licence and any DEPRECATION notice. " +
          "Use this before searching the web for a library: it uses bounded registry requests, and it is the registry's own answer rather than whatever ranks for '<name> official documentation'.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The package name." },
            registry: { type: "string", description: "Skip the guessing when you know the ecosystem.", enum: ["npm", "pypi", "crates"] },
            version: { type: "string", description: "A specific version, instead of the latest." },
          },
          required: ["name"],
        },
      },
      {
        name: "webindex_meta",
        title: "What a page says about itself",
        description:
          "Read a page's own structured metadata — JSON-LD, OpenGraph and meta tags — and return author, publication and modification dates, type, site name and canonical URL. " +
          "Far cheaper and far more reliable than inferring a publication date from body text, and it does not need the page's prose at all.",
        inputSchema: { type: "object", properties: { url: { type: "string", description: "The page to inspect." } }, required: ["url"] },
      },
      {
        name: "webindex_robots",
        title: "Is this URL ours to fetch?",
        description:
          "Check the site's robots.txt for this URL: whether it is allowed, any crawl-delay, and the sitemaps the file advertises. " +
          "Advisory — webindex_fetch does not consult it, because following one citation is not crawling. Ask before enumerating a site.",
        inputSchema: { type: "object", properties: { url: { type: "string", description: "The URL to check." } }, required: ["url"] },
      },
      {
        name: "webindex_sitemap",
        title: "What pages does this site list?",
        description:
          "Fetch and parse the site's sitemap (following the ones robots.txt names first), returning page URLs with their last-modified dates. " +
          "A sitemap index is followed at most `max` documents deep — enumerating a site is a budget you set, not something this does on its own.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Any URL on the site." },
            max: { type: "number", description: "Sitemap documents to fetch (default 3)." },
          },
          required: ["url"],
        },
      },
      {
        name: "webindex_feed",
        title: "A site's RSS or Atom feed",
        description:
          "Parse a feed URL, or discover and parse the feeds a page advertises. Returns dated, ordered entries — the site telling you what it published and when, " +
          "instead of a web search guessing.",
        inputSchema: { type: "object", properties: { url: { type: "string", description: "A feed URL, or a page that links to one." } }, required: ["url"] },
      },
      {
        name: "webindex_tables",
        title: "The tables on a page, as data",
        description:
          "Extract every <table> as headers and rows, with colspan and rowspan resolved. Plain extraction flattens a table into a run of cell text, which reads " +
          "plausibly while every figure has lost the row and column it belonged to — use this whenever the answer is IN a table.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The page holding the table(s)." },
            markdown: { type: "boolean", description: "Render as markdown instead of JSON rows." },
          },
          required: ["url"],
        },
      },
      {
        name: "webindex_embed",
        title: "Embed text with the local model",
        description:
          "Turn text into vectors with the local Ollama, which needs no key and sends nothing off the machine. Returns one vector per input, in input order. " +
          "Answers with a note rather than an error when the service is not running.",
        inputSchema: {
          type: "object",
          properties: { texts: { type: "array", items: { type: "string" }, description: "The texts to embed." } },
          required: ["texts"],
        },
      },
      {
        name: "webindex_crawl",
        title: "Walk a site, within a budget",
        description:
          "Follow links from a seed page, breadth-first, honouring robots.txt at EVERY hop and staying on the seed's origin. `max` pages is required — enumerating " +
          "someone else's site is the one operation here that can inconvenience them, so the budget is not optional. Returns each page's URL, title and text.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The seed page." },
            max: { type: "number", description: "Hard ceiling on pages fetched. Required." },
            depth: { type: "number", description: "How many links deep to follow (default 2)." },
          },
          required: ["url", "max"],
        },
      },
    ],
    capAdvice: {
      webindex_search: "lower `limit`",
      webindex_repo: "this repository's record is unusually large; ask for what you need instead",
      webindex_issues: "lower `limit`, or narrow `terms`",
      webindex_releases: "lower `limit` — release notes are long",
      webindex_tags: "lower `limit`",
      webindex_package: "this package's registry record is unusually large; pin a `version`",
      webindex_meta: "the page is very large; this reads only its head, so a cap here means the document itself is enormous",
      webindex_robots: "this site's robots.txt is unusually large; read it directly",
      webindex_sitemap: "lower `max`, or read one child sitemap at a time",
      webindex_feed: "the feed is very large; fetch it and read the file instead of inlining it",
      webindex_fetch: "the page is very large; fetch it and read the file instead of inlining it",
      webindex_extract: "the document is very large; read it in pieces",
      webindex_rank: "lower `limit`, or send shorter `text` per document — the ranking only needs enough to score",
      webindex_tables: "this page's tables are enormous; fetch it and read the file instead of inlining them",
      webindex_embed: "send fewer `texts` — a vector per input is large, and they are rarely worth reading inline",
      webindex_crawl: "lower `max`, or `depth` — a crawl's whole output is the sum of its pages",
    },
    async callTool(name, args) {
      if (name === "webindex_fetch") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        const fullPage = args.fullPage === true;
        const r = await cachedFetchAndExtract(
          url,
          { acceptLanguage: args.lang ? String(args.lang) : undefined, fullPage, stripConsent: !fullPage, timeoutMs: toolTimeoutMs(args.timeoutMs) },
          args.cache === true,
        );
        if (!r.text) throw new ToolError(`Nothing readable at ${url}${r.note ? ` — ${r.note}` : ""}.`);
        // Provenance a citation needs — where the text came from after
        // redirects, what the page calls itself — plus anything the fetch had
        // to say. The extractor stays the last line, as it always was.
        const trailer = [
          `url: ${r.finalUrl}`,
          ...(r.canonical && r.canonical !== r.finalUrl ? [`canonical: ${r.canonical}`] : []),
          ...(r.title ? [`title: ${r.title}`] : []),
          ...(r.documentType ? [`document: ${r.documentType}`] : []),
          ...(r.cached ? ["cached: true"] : []),
          ...(r.note ? [`note: ${r.note}`] : []),
          `extractor: ${r.extractor ?? "native"}`,
        ];
        return { text: `${r.text}\n\n---\n${trailer.join("\n")}` };
      }
      if (name === "webindex_search") {
        const q = String(args.query ?? "").trim();
        if (!q) throw new ToolError("`query` is required.");
        const raw = args.engine ? String(args.engine) : undefined;
        if (raw !== undefined && !isKeylessEngine(raw)) throw new ToolError(`unknown engine "${raw}" — expected one of ${KEYLESS_ENGINES.join(", ")}`);
        const engines: KeylessEngine[] | undefined = raw === undefined ? undefined : [raw];
        const r = await search(q, {
          limit: typeof args.limit === "number" ? args.limit : undefined,
          lang: args.lang ? String(args.lang) : undefined,
          ...(engines ? { engines } : {}),
        });
        if (!r.hits.length) throw new ToolError(r.notes.join(" ") || "No results.");
        const body = r.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`).join("\n\n");
        return { text: r.notes.length ? `${body}\n\n---\n${r.notes.join("\n")}` : body };
      }
      if (name === "webindex_extract") {
        const r = await extractLocal(String(args.path ?? ""), args.fullPage === true);
        if (!r.text) throw new ToolError(`Nothing readable in that file${r.reason ? ` — ${r.reason}` : ""}.`);
        return { text: `${r.text}\n\n---\nextractor: ${r.extractor}` };
      }
      if (name === "webindex_rank") {
        const question = String(args.question ?? "").trim();
        if (!question) throw new ToolError("`question` is required.");
        let docs: RankInput[];
        try {
          docs = parseRankDocs(args.documents, "`documents`");
        } catch (e) {
          throw new InvalidParamsError((e as Error).message);
        }
        const r = rankDocuments(question, docs, typeof args.limit === "number" ? args.limit : undefined);
        if (!r.queryTerms.length) {
          throw new ToolError("`question` has no rankable terms once stopwords are removed — nothing to score against.");
        }
        return { text: JSON.stringify(r, null, 2) };
      }
      if (name === "webindex_package") {
        const pkg = String(args.name ?? "").trim();
        if (!pkg) throw new ToolError("`name` is required.");
        const reg = args.registry === undefined ? undefined : String(args.registry);
        if (reg !== undefined && !isRegistryKind(reg)) throw new InvalidParamsError("`registry` must be one of: npm, pypi, crates");
        const { facts: p, note } = await resolvePackageResult(pkg, {
          ...(reg ? { registry: reg } : {}),
          ...(args.version ? { version: String(args.version) } : {}),
        });
        if (!p) throw new ToolError(note ?? `No registry knows a package called "${pkg}".`);
        return { text: JSON.stringify(p, null, 2) };
      }
      if (name === "webindex_repo" || name === "webindex_issues" || name === "webindex_releases" || name === "webindex_tags") {
        const forge = args.forge === undefined ? undefined : String(args.forge);
        if (forge !== undefined && !isForgeKind(forge)) throw new InvalidParamsError(`\`forge\` must be one of: ${FORGE_KINDS.join(", ")}`);
        const ref = forgeTarget(String(args.repo ?? ""), forge);
        if (ref.host === "generic") throw new ToolError(`"${String(args.repo ?? "")}" does not name a repository.`);
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const opts = { ...(limit ? { limit } : {}), ...(forge ? { kind: forge } : {}) };
        if (name === "webindex_repo") {
          const { facts: f, note } = await repoFactsResult(ref, opts);
          if (!f) throw new ToolError(note ?? `Could not read ${ref.webUrl ?? ref.raw}.`);
          return { text: JSON.stringify({ ref, ...f }, null, 2) };
        }
        const r =
          name === "webindex_releases"
            ? await listReleases(ref, opts)
            : name === "webindex_tags"
              ? await listTags(ref, opts)
              : await searchIssues(
                  ref,
                  String(args.terms ?? "")
                    .split(/\s+/)
                    .filter(Boolean),
                  args.kind === "pr" ? "pr" : "issue",
                  opts,
                );
        // A quota answer is not "nothing exists" — say which it was.
        if (!r.items.length) {
          if (!r.note && name === "webindex_releases")
            throw new ToolError(`No releases published for ${ref.raw} — its versions may only be tags: try webindex_tags.`);
          throw new ToolError(r.note ?? `Nothing found for ${ref.raw}.`);
        }
        return { text: JSON.stringify(r, null, 2) };
      }
      if (name === "webindex_meta" || name === "webindex_robots" || name === "webindex_sitemap" || name === "webindex_feed") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");

        if (name === "webindex_robots") {
          const r = await fetchRobots(url);
          return { text: JSON.stringify({ url, allowed: isAllowed(r, url), ...r }, null, 2) };
        }
        if (name === "webindex_sitemap") {
          const robots = await fetchRobots(url);
          const s = await fetchSitemap(url, { sitemaps: robots.sitemaps, max: typeof args.max === "number" ? args.max : undefined });
          if (!s.urls.length && !s.sitemaps.length) throw new ToolError(`No sitemap found for ${url}.`);
          return { text: JSON.stringify(s, null, 2) };
        }
        const page = await httpGet(url, { accept: "text/html,application/xml,*/*" });
        if (!page.ok) throw new ToolError(`Could not fetch ${url} (status ${page.status}).`);
        if (name === "webindex_meta") return { text: JSON.stringify(pageMetadata(page.body, { baseUrl: page.url }), null, 2) };

        const direct = parseFeed(page.body);
        if (direct) return { text: JSON.stringify(direct, null, 2) };
        const found = discoverFeeds(page.body, page.url);
        if (!found.length) throw new ToolError(`${url} is not a feed and advertises none.`);
        const feeds = [];
        for (const f of found) {
          const parsed = await fetchFeed(f);
          if (parsed) feeds.push({ url: f, ...parsed });
        }
        if (!feeds.length) throw new ToolError(`${url} advertises ${found.length} feed(s), none of which parsed.`);
        return { text: JSON.stringify(feeds, null, 2) };
      }
      if (name === "webindex_tables") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        const page = await httpGet(url, { accept: "text/html,*/*" });
        if (!page.ok) throw new ToolError(`could not fetch ${url} (status ${page.status})`);
        const tables = extractTables(page.body);
        if (!tables.length) throw new ToolError(`${url} has no tables — use webindex_fetch for its text.`);
        return { text: args.markdown ? tables.map(tableToMarkdown).join("\n\n") : JSON.stringify(tables, null, 2) };
      }
      if (name === "webindex_embed") {
        const texts = Array.isArray(args.texts) ? args.texts.map(String) : [];
        if (!texts.length) throw new ToolError("`texts` must be a non-empty array of strings.");
        const r = await embed(texts);
        if (!r.vectors.length) throw new ToolError(r.note ?? "the embedding server returned nothing.");
        return { text: JSON.stringify({ model: r.model, dimensions: r.vectors[0]?.length ?? 0, vectors: r.vectors }, null, 2) };
      }
      if (name === "webindex_crawl") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        const max = Number(args.max);
        if (!Number.isInteger(max) || max < 1)
          throw new ToolError("`max` is required and must be a positive whole number — a crawl without a budget is not one.");
        const r = await crawlSite(url, { maxPages: max, ...(args.depth !== undefined ? { maxDepth: Number(args.depth) } : {}) });
        if (!r.pages.length) throw new ToolError(`nothing readable from ${url}${r.notes.length ? ` — ${r.notes[0]}` : ""}`);
        return {
          text: JSON.stringify(
            {
              pages: r.pages.map((p) => ({ url: p.url, depth: p.depth, title: p.title, text: p.text })),
              disallowed: r.disallowed,
              pending: r.pending.length,
              notes: r.notes,
            },
            null,
            2,
          ),
        };
      }
      throw new ToolError(`unknown tool: ${name}`);
    },
  };
}

/**
 * A malformed invocation exits 2, a failed one exits 1.
 *
 * The distinction is the reason the taxonomy exists: a caller scripting this
 * engine has to tell "your query had no results" from "you spelled the flag
 * wrong", and collapsing both onto 1 makes a typo look like an empty web.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    await dispatch(argv);
  } catch (e) {
    if (!(e instanceof UsageError) && !(e instanceof ToolError)) throw e;
    process.stderr.write(`webindex: ${e.message}\n`);
    process.exit(e instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE);
  }
}

async function dispatch(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, SPEC);
  if (parsed.kind === "help") {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(ENGINE_VERSION + "\n");
    return;
  }
  const args: CommandArgs = parsed;
  const cmd = args.command;

  if (cmd === "search") {
    const q = positionalText(args);
    if (!q) usage("usage: webindex search <query>");
    const engine = argValue(args, "engine");
    if (engine && engine !== "off" && !isKeylessEngine(engine)) fail(`unknown --engine "${engine}" — expected one of ${KEYLESS_ENGINES.join(", ")}, or off`);
    const r = await search(q, {
      limit: argInt(args, "limit"),
      pages: argInt(args, "pages"),
      lang: argValue(args, "lang"),
      searxng: argValue(args, "searxng"),
      firecrawl: argValue(args, "firecrawl"),
      ...(engine ? { engines: engine === "off" ? [] : [engine as KeylessEngine] } : {}),
    });
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(r));
    } else {
      for (const h of r.hits) {
        process.stdout.write(`${h.title}\n  ${h.url}${h.snippet ? `\n  ${h.snippet.slice(0, 160)}` : ""}\n\n`);
      }
      // Notes stay off stdout so pipelines retain clean results.
      for (const n of r.notes) process.stderr.write(`  ${n}\n`);
    }
    if (!r.hits.length) process.exit(EXIT_FAILURE);
    return;
  }

  if (cmd === "fetch") {
    const url = args.positional[0];
    if (!url) usage("usage: webindex fetch <url>");
    if (!/^https?:\/\//i.test(url)) fail("fetch needs an http(s) URL");
    const fullPage = argBool(args, "full-page");
    const refresh = argBool(args, "refresh");
    const offline = argBool(args, "offline");
    if (refresh && offline) usage("--refresh and --offline contradict each other: one always fetches, the other never does");
    // Set both switches every time, so a value from an earlier call in the same
    // process can never leak into this one.
    setCacheMode({ refresh, offline });
    const r = await cachedFetchAndExtract(
      url,
      {
        acceptLanguage: argValue(args, "lang"),
        firecrawl: argValue(args, "firecrawl"),
        fullPage,
        stripConsent: !fullPage,
        timeoutMs: argTimeout(args),
      },
      argBool(args, "cache") || refresh,
    );
    if (argBool(args, "json")) {
      process.stdout.write(
        JSON.stringify(
          {
            url,
            // Where the text actually came from — after redirects — and the
            // address the page gives for itself: what a citation needs.
            finalUrl: r.finalUrl,
            canonical: r.canonical,
            title: r.title,
            extractor: r.extractor,
            documentType: r.documentType,
            status: r.status,
            cached: r.cached === true,
            chars: r.text.length,
            note: r.note,
            text: r.text,
            fullPage,
            consentDropped: r.consentDropped ?? 0,
          },
          null,
          2,
        ) + "\n",
      );
    } else if (r.text) {
      process.stdout.write(r.text + "\n");
    }
    if (!r.text) fail(`nothing readable at ${url}${r.note ? ` — ${r.note}` : ""}`);
    return;
  }

  if (cmd === "extract") {
    const path = args.positional[0];
    if (!path) usage("usage: webindex extract <file>");
    const fullPage = argBool(args, "full-page");
    const r = await extractLocal(path, fullPage);
    if (argBool(args, "json")) {
      process.stdout.write(
        JSON.stringify(
          { file: basename(path), extractor: r.extractor, chars: r.text.length, reason: r.reason, text: r.text, fullPage, consentDropped: r.consentDropped },
          null,
          2,
        ) + "\n",
      );
    } else if (r.text) {
      process.stdout.write(r.text + "\n");
    }
    if (!r.text) fail(`nothing readable in ${path}${r.reason ? ` — ${r.reason}` : ""}`);
    return;
  }

  if (cmd === "mcp") {
    const transport = argValue(args, "transport") ?? "stdio";
    if (transport === "stdio") {
      await runStdioServer(webindexAdapter());
      return;
    }
    if (transport !== "http") fail(`unknown transport "${transport}" — expected stdio or http`);
    const port = argInt(args, "port") ?? 7340;
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail("invalid --port");
    let running: Awaited<ReturnType<typeof startHttpServer>>;
    try {
      running = await startHttpServer(webindexAdapter(), { port, bind: argValue(args, "bind"), allowRemote: argBool(args, "allow-remote") });
    } catch (e) {
      fail((e as Error).message);
    }
    // stderr, not stdout: an HTTP server's stdout is not a protocol stream, but
    // keeping the two transports identical here means no one has to remember
    // which is which.
    process.stderr.write(`webindex: MCP server listening on ${running.url}\n`);
    process.stderr.write(`  client: claude mcp add --transport http webindex ${running.url}\n`);
    return;
  }

  // Every service in STACK_SERVICES gets a route, rather than a hand-written
  // list: `semantic` was in the table, in the README and in `stackControl` for
  // four releases while the dispatch only knew three names, so the documented
  // command simply did not exist. Deriving the routes from the engine's own
  // table means the next service added there is reachable the same day.
  // `all` is excluded because the CLI already spells it `stack`; two spellings
  // of one action is how a help text starts lying.
  if ((STACK_SERVICES.includes(cmd) && cmd !== "all") || cmd === "stack") {
    const action = args.positional[0] ?? "status";
    if (cmd === "stack" && action === "path") {
      process.stdout.write(ensureComposeMaterialized() + "\n");
      return;
    }
    // The engine guards this too, for library callers. Doing it here as well is
    // what lets the message name `path`, which only `stack` accepts.
    const valid = cmd === "stack" ? ["up", "down", "status", "path"] : ["up", "down", "status"];
    if (!valid.includes(action)) usage(`usage: webindex ${cmd} ${valid.join("|")}`);

    const r = stackControl(cmd === "stack" ? "all" : cmd, action);
    // stdout for the report, so `webindex stack status` is pipeable; the engine
    // already streamed docker's own progress to the terminal.
    (r.code === 0 ? process.stdout : process.stderr).write(r.message + "\n");
    if (r.code !== 0) process.exit(r.code);
    return;
  }

  if (cmd === "rank") {
    const question = argValue(args, "query");
    if (!question) usage("usage: webindex rank --query <question> --docs <file.json|-> [--limit <n>] [--json]");
    const src = argValue(args, "docs") ?? "-";
    let payload: string;
    try {
      payload = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
    } catch (e) {
      fail(`cannot read ${src === "-" ? "stdin" : src}: ${(e as Error).message}`);
    }
    let docs: RankInput[];
    try {
      docs = parseRankDocs(payload, "--docs");
    } catch (e) {
      fail((e as Error).message);
    }
    const limit = argInt(args, "limit");
    const r = rankDocuments(question, docs, limit);
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(r));
    } else {
      // Human form on stdout, the collapse note on stderr — so pipelines
      // retain a clean ranked list.
      process.stdout.write(
        r.ranked
          .map((x) => `${x.rank}. [${x.score.toFixed(3)}] ${x.title ?? x.url}\n   ${x.url}${x.matched.length ? `\n   matched: ${x.matched.join(", ")}` : ""}`)
          .join("\n\n") + "\n",
      );
      if (r.collapsed) process.stderr.write(`${r.collapsed} near-duplicate(s) collapsed.\n`);
    }
    if (!r.queryTerms.length) {
      process.stderr.write("The question has no rankable terms once stopwords are removed — the order is arbitrary.\n");
      process.exit(1);
    }
    return;
  }

  // What a code host and a package registry say about a project. Read-only,
  // keyless, and answering from the record rather than from a README.
  if (cmd === "repo" || cmd === "issues" || cmd === "prs" || cmd === "releases" || cmd === "tags" || cmd === "package") {
    const target = positionalText(args);
    if (!target) usage(`usage: webindex ${cmd} <${cmd === "package" ? "name" : "repo"}> [--json]`);
    const asJson = argBool(args, "json");
    const limit = argInt(args, "limit");
    const emit = (obj: unknown, human: string[]) => process.stdout.write(asJson ? jsonLine(obj) : `${human.join("\n")}\n`);

    if (cmd === "package") {
      const reg = argValue(args, "registry");
      if (reg !== undefined && !isRegistryKind(reg)) usage(`--registry expects npm, pypi or crates, got "${reg}"`);
      const { facts: p, note } = await resolvePackageResult(target, {
        ...(reg ? { registry: reg } : {}),
        ...(argValue(args, "version") ? { version: argValue(args, "version") } : {}),
      });
      if (!p) fail(note ?? `no registry knows a package called "${target}"`);
      // The name and what it is come first: without --registry the answer may
      // be another ecosystem's namesake, and that must be visible at a glance.
      emit(p, [
        `  name        ${p.name}`,
        `  registry    ${p.registry}`,
        `  description ${p.description ?? "—"}`,
        `  version     ${p.version ?? "—"}`,
        `  repository  ${p.repository ?? "—"}`,
        `  homepage    ${p.homepage ?? "—"}`,
        `  docs        ${p.documentation ?? "—"}`,
        `  license     ${p.license ?? "—"}`,
        ...(p.deprecated ? [`  DEPRECATED  ${p.deprecated}`] : []),
      ]);
      return;
    }

    const forge = argValue(args, "forge");
    if (forge !== undefined && !isForgeKind(forge)) usage(`--forge expects github, gitlab or gitea, got "${forge}"`);
    const ref = forgeTarget(target, forge);
    if (ref.host === "generic") fail(`"${target}" does not name a repository`);
    const opts = { ...(limit ? { limit } : {}), ...(forge ? { kind: forge } : {}) };

    if (cmd === "repo") {
      const { facts: f, note } = await repoFactsResult(ref, opts);
      if (!f) fail(note ?? `could not read ${ref.webUrl ?? target}`);
      emit({ ref, ...f }, [
        `  name        ${f.fullName ?? `${ref.owner}/${ref.repo}`}`,
        `  description ${f.description ?? "—"}`,
        `  stars       ${f.stars ?? "—"}`,
        `  license     ${f.license ?? "—"}`,
        `  branch      ${f.defaultBranch ?? "—"}`,
        `  last push   ${f.pushedAt ?? "—"}`,
        ...(f.archived ? ["  ARCHIVED    this repository is read-only upstream"] : []),
      ]);
      return;
    }

    const r =
      cmd === "releases"
        ? await listReleases(ref, opts)
        : cmd === "tags"
          ? await listTags(ref, opts)
          : await searchIssues(ref, (argValue(args, "terms") ?? "").split(/\s+/).filter(Boolean), cmd === "prs" ? "pr" : "issue", opts);
    if (!r.items.length) {
      // Plenty of projects tag every version and never publish a release.
      if (!r.note && cmd === "releases") fail(`no releases published for ${target} — try \`webindex tags ${target}\``);
      fail(r.note ?? `nothing found for ${target}`);
    }
    emit(
      r,
      r.items.map((i) => `${i.number ? `#${i.number} ` : ""}${i.title}${i.state ? ` [${i.state}]` : ""}\n  ${i.url}`),
    );
    if (r.note) process.stderr.write(`${r.note}\n`);
    return;
  }

  // What a page or a site says about itself — the three read-only lookups that
  // answer "who published this, when" and "what else is here" without paying for
  // a full extraction.
  if (cmd === "meta" || cmd === "robots" || cmd === "sitemap" || cmd === "feed") {
    const target = positionalText(args);
    if (!target) usage(`usage: webindex ${cmd} <url>`);
    if (!/^https?:\/\//i.test(target)) fail("expected an http(s) URL");
    const asJson = argBool(args, "json");
    const emit = (obj: unknown, human: string[]) => process.stdout.write(asJson ? jsonLine(obj) : `${human.join("\n")}\n`);

    if (cmd === "robots") {
      const r = await fetchRobots(target);
      const allowed = isAllowed(r, target);
      emit({ url: target, allowed, ...r }, [
        `  allowed   ${allowed ? "yes" : "no"}`,
        `  rules     ${r.absent ? "none (no robots.txt)" : r.rules.length}`,
        ...(r.crawlDelayMs ? [`  delay     ${r.crawlDelayMs}ms`] : []),
        ...(r.sitemaps.length ? [`  sitemaps  ${r.sitemaps.join("\n            ")}`] : []),
      ]);
      if (!allowed) process.exit(1); // scriptable: `webindex robots <url> && fetch it`
      return;
    }
    if (cmd === "sitemap") {
      const robots = await fetchRobots(target);
      const s = await fetchSitemap(target, { sitemaps: robots.sitemaps, max: argInt(args, "max") });
      if (!s.urls.length && !s.sitemaps.length) fail(`no sitemap found for ${target}`);
      emit(
        s,
        s.urls.map((u) => u.loc),
      );
      return;
    }
    const page = await httpGet(target, { accept: "text/html,application/xml,*/*" });
    if (!page.ok) fail(`could not fetch ${target} (status ${page.status})`);
    if (cmd === "feed") {
      const direct = parseFeed(page.body);
      if (direct) {
        emit(
          direct,
          direct.items.map((i) => `${i.published ? `${i.published}  ` : ""}${i.title ?? ""}\n  ${i.url ?? ""}`),
        );
        return;
      }
      const found = discoverFeeds(page.body, page.url);
      if (!found.length) fail(`${target} advertises no feed`);
      const feeds = [];
      for (const f of found) {
        const parsed = await fetchFeed(f);
        if (parsed) feeds.push({ url: f, ...parsed });
      }
      if (!feeds.length) fail(`${target} advertises ${found.length} feed(s), none of which parsed`);
      emit(
        feeds,
        feeds.flatMap((f) => [`# ${f.title ?? f.url}`, ...f.items.map((i) => `${i.published ? `${i.published}  ` : ""}${i.title ?? ""}\n  ${i.url ?? ""}`)]),
      );
      return;
    }
    const m = pageMetadata(page.body, { baseUrl: page.url });
    emit(m, [
      `  title      ${m.title ?? "—"}`,
      `  type       ${m.type ?? "—"}`,
      `  site       ${m.siteName ?? "—"}`,
      `  published  ${m.publishedAt ?? "—"}`,
      `  modified   ${m.modifiedAt ?? "—"}`,
      `  authors    ${m.authors.join(", ") || "—"}`,
      `  canonical  ${m.canonicalUrl ?? "—"}`,
    ]);
    return;
  }

  if (cmd === "cache") {
    const action = args.positional[0] ?? "status";
    if (action !== "status" && action !== "clean") usage("usage: webindex cache status|clean [--all]");
    if (action === "clean") {
      const all = argBool(args, "all");
      // "0 entries removed" would read as an empty cache, not a blocked clean.
      if (isNoWrite()) {
        process.stdout.write(`no-write mode: nothing removed from ${cacheDir()}\n`);
        return;
      }
      const removed = cacheClean(all);
      process.stdout.write(`${removed} entr${removed === 1 ? "y" : "ies"} removed (${all ? "all" : "stale only"}) from ${cacheDir()}\n`);
      return;
    }
    const s = cacheStats();
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(s));
      return;
    }
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
    process.stdout.write(
      [
        `  dir      ${s.dir}`,
        `  entries  ${s.entries} (${s.fresh} fresh, ${s.stale} stale)`,
        `  size     ${mb(s.bytes)}`,
        `  ttl      ${Math.round(s.ttlMs / 1000)}s`,
        ...(s.oldest ? [`  oldest   ${s.oldest}`, `  newest   ${s.newest}`] : []),
      ].join("\n") + "\n",
    );
    return;
  }

  if (cmd === "crawl") {
    const seed = positionalText(args);
    if (!seed) usage("usage: webindex crawl <url> --max <n>");
    if (!/^https?:\/\//i.test(seed)) fail("crawl needs an http(s) URL");
    const max = argInt(args, "max");
    // Required, not defaulted. Enumerating someone else's site is the one
    // operation here that can inconvenience them, so the budget is a decision
    // the caller makes rather than one this command makes for them.
    if (max === undefined) usage("crawl needs --max <n> — an unbounded walk of somebody else's site is not something to do by accident");
    const r = await crawlSite(seed, {
      maxPages: max,
      ...(argInt(args, "depth") !== undefined ? { maxDepth: argInt(args, "depth") as number } : {}),
      crossOrigin: argBool(args, "cross-origin"),
    });
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(r));
    } else {
      for (const p of r.pages) process.stdout.write(`${p.url}${p.title ? `\n  ${p.title}` : ""}\n`);
      for (const d of r.disallowed) process.stderr.write(`  disallowed: ${d}\n`);
      for (const n of r.notes) process.stderr.write(`  ${n}\n`);
    }
    if (!r.pages.length) process.exit(EXIT_FAILURE);
    return;
  }

  if (cmd === "tables") {
    const url = positionalText(args);
    if (!url) usage("usage: webindex tables <url>");
    if (!/^https?:\/\//i.test(url)) fail("tables needs an http(s) URL");
    const page = await httpGet(url, { accept: "text/html,*/*" });
    if (!page.ok) fail(`could not fetch ${url} (status ${page.status})`);
    const tables = extractTables(page.body);
    if (!tables.length) fail(`no tables on ${url}`);
    process.stdout.write(argBool(args, "json") ? jsonLine(tables) : `${tables.map(tableToMarkdown).join("\n\n")}\n`);
    return;
  }

  if (cmd === "embed") {
    const text = positionalText(args);
    if (!text) usage("usage: webindex embed <text>");
    const r = await embed([text]);
    if (!r.vectors.length) fail(r.note ?? "the embedding server returned nothing");
    process.stdout.write(
      argBool(args, "json") ? jsonLine({ model: r.model, dimensions: r.vectors[0]?.length ?? 0, vector: r.vectors[0] }) : `${(r.vectors[0] ?? []).join(" ")}\n`,
    );
    return;
  }

  if (cmd === "hybrid") {
    const question = argValue(args, "query");
    if (!question) usage("usage: webindex hybrid --query <question> --docs <file.json|->");
    const src = argValue(args, "docs") ?? "-";
    let payload: string;
    try {
      payload = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
    } catch (e) {
      fail(`cannot read ${src === "-" ? "stdin" : src}: ${(e as Error).message}`);
    }
    let docs: RankInput[];
    try {
      docs = parseRankDocs(payload, "--docs");
    } catch (e) {
      fail((e as Error).message);
    }
    const r = await hybridSearch(
      question,
      docs.map((d, i) => ({ id: d.url ?? String(i), title: d.title ?? "", headings: "", body: d.text ?? "" })),
      { ...(argInt(args, "limit") !== undefined ? { limit: argInt(args, "limit") as number } : {}) },
    );
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(r));
      return;
    }
    process.stdout.write(
      `${r.hits.map((h, i) => `${i + 1}. [${h.score.toFixed(4)}] ${h.doc.title || h.doc.id}\n   ${h.doc.id}   lexical#${h.lexicalRank ?? "-"} dense#${h.denseRank ?? "-"}`).join("\n")}\n`,
    );
    // The note goes to stderr, so the reason a run ranked lexically is visible
    // without landing in the middle of the ranking.
    if (r.note) process.stderr.write(`  ${r.note}\n`);
    return;
  }

  if (cmd === "changed") {
    const url = positionalText(args);
    if (!url) usage("usage: webindex changed <url> [--etag <v>] [--last-modified <date>] [--hash <sha256>]");
    if (!/^https?:\/\//i.test(url)) fail("changed needs an http(s) URL");
    const etag = argValue(args, "etag");
    const lastModified = argValue(args, "last-modified");
    const hash = argValue(args, "hash");
    const timeoutMs = argTimeout(args);
    if (!etag && !lastModified && !hash) {
      const f = await fingerprint(url, { timeoutMs });
      if (argBool(args, "json")) process.stdout.write(jsonLine(f));
      else if (!f.error) {
        const lines = [`etag ${f.etag ?? "-"}`, `last-modified ${f.lastModified ?? "-"}`, `hash ${f.contentHash ?? "-"}`, `status ${f.status}`];
        process.stdout.write(lines.join("\n") + "\n");
      }
      // A baseline with no hash is no baseline: a watcher that stores it
      // learns the page was unreadable only on its next run.
      if (f.error) fail(`could not read ${url}: ${f.error}`);
      return;
    }
    const v = await hasChanged(
      url,
      { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}), ...(hash ? { contentHash: hash } : {}) },
      { timeoutMs },
    );
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(v));
    } else {
      process.stdout.write(`${v.changed === undefined ? "unknown" : v.changed ? "changed" : "unchanged"} (via ${v.via})\n`);
      if (v.note) process.stderr.write(`  ${v.note}\n`);
    }
    // Exit 1 on "could not tell", so a watcher script never reads an error as
    // "nothing to do". `changed` itself is not a failure.
    if (v.changed === undefined) process.exit(EXIT_FAILURE);
    return;
  }

  // The packaging toolchain for a repo built ON this engine. Dev-time: it reads
  // a repository, it never runs inside one — which is exactly why it can serve
  // the skills that do not vendor this engine at all.
  if (cmd === "skill") {
    const action = args.positional[0] ?? "";
    const root = resolve(argValue(args, "root") ?? process.cwd());
    const asJson = argBool(args, "json");

    if (action === "init") {
      const name = args.positional[1];
      if (!name) usage("usage: webindex skill init <name> [--root <dir>]");
      const r = scaffoldSkill(root, name, { exists: existsSync });
      for (const e of r.errors) process.stderr.write(`  ${e}\n`);
      process.stdout.write(asJson ? jsonLine(r) : `${r.written.map((p) => `  wrote ${relative(root, p)}`).join("\n")}\n`);
      if (!r.written.length) process.exit(EXIT_FAILURE);
      return;
    }

    const { config, errors: configErrors } = readSkillConfig(root);
    if (!config) {
      for (const e of configErrors) process.stderr.write(`webindex: ${e}\n`);
      process.exit(EXIT_FAILURE);
    }

    if (action === "recall") {
      const lost = checkArtifactRecall(root, argValue(args, "ref") ?? "HEAD");
      if (lost.length) fail(lost.join("\n"));
      process.stdout.write("Artifact identities and evidence preserved\n");
      return;
    }
    if (action === "finish") {
      await finishRepin(root);
      return;
    }

    if (action === "repin") {
      const changes = await repinSkill(root, config);
      process.stdout.write(asJson ? jsonLine({ changes }) : `${changes.join("\n") || "All pins are current"}\n`);
      return;
    }

    if (action === "vendor") {
      if (argBool(args, "list")) {
        for (const [name, pin] of Object.entries(config.engines)) {
          const meta = JSON.parse(readFileSync(join(root, config.vendorDir, pin.meta), "utf8"));
          process.stdout.write(`${name} ${pin.repo} ${meta.tag}\n`);
        }
        return;
      }
      // `--check` is offline on purpose: this runs in CI on every commit, and a
      // gate that needs the network goes red when GitHub does.
      if (argBool(args, "check")) {
        const statuses = checkPins(root, config);
        if (asJson) process.stdout.write(jsonLine(statuses));
        else
          for (const s of statuses) {
            if (s.ok) process.stdout.write(`  ok   ${s.engine} matches the ${s.tag} pin (${s.engineVersion})\n`);
            else for (const p of s.problems) process.stderr.write(`  FAIL ${p}\n`);
          }
        if (statuses.some((s) => !s.ok)) process.exit(EXIT_FAILURE);
        return;
      }
      const ref = argValue(args, "ref");
      if (!ref) usage("usage: webindex skill vendor [--engine <name>] --ref <tag>   |   webindex skill vendor --check");
      const only = argValue(args, "engine");
      const names = only ? [only] : Object.keys(config.engines);
      const fetchFile = async (url: string) => {
        const res = await httpGet(url, { binary: true, maxBytes: 64 * 1024 * 1024 });
        return res.ok ? res.bytes : undefined;
      };
      for (const n of names) {
        const pin = config.engines[n];
        const r = await vendorEngine(root, config, n, ref, fetchFile, pin ? releaseCommit(pin.repo, ref) : undefined);
        for (const w of r.written) process.stdout.write(`  wrote ${relative(root, w)}\n`);
        if (r.errors.length) {
          for (const e of r.errors) process.stderr.write(`webindex: ${e}\n`);
          process.exit(EXIT_FAILURE);
        }
        process.stdout.write(`  pinned ${n} ${r.tag} (${r.engineVersion})\n`);
      }
      return;
    }

    if (action === "check") {
      const only = argValue(args, "engine");
      const engineNames = only ? [only] : Object.keys(config.engines);
      let failedAny = false;
      for (const engineName of engineNames) {
        const pin = config.engines[engineName];
        if (!pin) fail(`unknown engine ${engineName}`);
        const usageConfig = { ...config, usageFloor: pin.usageFloor ?? config.usageFloor, forks: pin.forks ?? config.forks };
        const dtsFile = pin?.files?.find((f) => f.local.endsWith(".d.mts"))?.local;
        let dts = "";
        try {
          dts = readFileSync(join(root, config.vendorDir, dtsFile ?? ""), "utf8");
        } catch {
          fail(`cannot read the vendored declarations for "${engineName}" — run \`webindex skill vendor --ref <tag>\` first`);
        }
        const report = auditEngineUsage(root, usageConfig, dts, engineName);
        if (asJson) {
          process.stdout.write(jsonLine(report));
        } else {
          for (const c of report.collisions) process.stderr.write(`  FAIL ${c.file} declares ${c.name}, which the engine already exports\n`);
          if (report.collisions.length)
            process.stderr.write('\n  Re-export it from ./engine.js instead. (`export { X } from "./engine.js"` is fine and is not flagged.)\n');
          for (const s of report.stale) process.stderr.write(`  FAIL forks entry "${s}" no longer matches anything — delete it\n`);
          if (report.imported.length < usageConfig.usageFloor) {
            process.stderr.write(`  FAIL only ${report.imported.length} distinct engine symbols are imported, floor is ${usageConfig.usageFloor}.\n`);
            process.stderr.write("       A layer stopped being used. If that was deliberate, lower the floor in the same commit.\n");
          }
        }
        const failed = report.collisions.length > 0 || report.stale.length > 0 || report.imported.length < usageConfig.usageFloor;
        failedAny ||= failed;
        if (!asJson) {
          const forks = report.tolerated.length ? `, ${report.tolerated.length} known fork(s) still to adopt` : ", no local re-declarations";
          process.stdout.write(
            `  ok   ${report.imported.length} engine symbols in use (floor ${usageConfig.usageFloor})${forks}, of a ${report.surface}-symbol surface.\n`,
          );
        }
      }
      if (failedAny) process.exit(EXIT_FAILURE);
      return;
    }

    if (action === "bundle") {
      // Importing the built CLI is how the gate learns the flag surface without
      // inferring it: the bundle's own isInvokedDirectly() keeps main() from
      // firing, so reading it is not running it.
      const built = join(root, "scripts", `${config.name}.mjs`);
      let surface: CliSurface | undefined;
      let surfaceProblem: string | undefined;
      // A flag table is a Set in the consuming skills and an array in this one.
      // `Array.isArray` refused the Set, so the drift half went quiet against
      // exactly the repos it exists to police. Take any iterable.
      const flagList = (v: unknown): string[] | undefined =>
        v == null || typeof v === "string" || typeof (v as Iterable<string>)[Symbol.iterator] !== "function" ? undefined : [...(v as Iterable<string>)];
      if (existsSync(built)) {
        try {
          const mod = (await import(pathToFileURL(built).href)) as Record<string, unknown>;
          const valueFlags = flagList(mod.VALUE_FLAGS);
          const boolFlags = flagList(mod.BOOL_FLAGS);
          const commands = flagList(mod.COMMANDS);
          if (typeof mod.HELP === "string" && valueFlags && boolFlags) {
            surface = { help: mod.HELP, valueFlags, boolFlags, ...(commands ? { commands } : {}) };
          } else {
            surfaceProblem =
              "the built CLI exports no usable HELP/VALUE_FLAGS/BOOL_FLAGS — export them from the CLI entry so the docs↔CLI drift gate can read the real surface";
          }
        } catch (e) {
          surfaceProblem = `could not import ${relative(root, built)} for the drift gate: ${(e as Error).message}`;
        }
      }
      const checks = auditSkillBundle(root, config, surface);
      // A gate that cannot do half its job must not certify the other half.
      // Reporting this as a note on stderr let a skill documenting a flag the
      // engine rejects pass green — the same silent-disarm that `usageFloor`
      // is refused rather than defaulted to zero to prevent.
      if (surfaceProblem) checks.push({ ok: false, message: surfaceProblem });
      if (asJson) process.stdout.write(jsonLine(checks));
      else for (const c of checks) (c.ok ? process.stdout : process.stderr).write(`  ${c.ok ? "ok  " : "FAIL"} ${c.message}\n`);
      const bad = checks.filter((c) => !c.ok).length;
      if (bad) {
        process.stderr.write(`\nwebindex: ${bad} problem(s) — the published skill would not install correctly.\n`);
        process.exit(EXIT_FAILURE);
      }
      if (!asJson) process.stdout.write(`\n  skills/${config.name}/ installs as a complete skill.\n`);
      return;
    }

    if (action === "copy") {
      const from = join(root, "scripts", `${config.name}.mjs`);
      if (!existsSync(from)) fail(`missing ${relative(root, from)} — run the build first`);
      const to = join(root, "skills", config.name, "scripts", `${config.name}.mjs`);
      ensureDir(join(to, ".."));
      writeArtifact(to, readFileSync(from, "utf8"));
      process.stdout.write(`  copied ${relative(root, from)} -> ${relative(root, to)}\n`);
      return;
    }

    if (action === "doctor") {
      const statuses = checkPins(root, config);
      const rows = statuses.map((s) => ({
        engine: s.engine,
        tag: s.tag ?? "-",
        minRef: config.engines[s.engine]?.minRef ?? "-",
        ok: s.ok,
        problems: s.problems,
      }));
      if (asJson) process.stdout.write(jsonLine({ name: config.name, usageFloor: config.usageFloor, forks: Object.keys(config.forks).length, engines: rows }));
      else {
        process.stdout.write(`${config.name}\n`);
        for (const r of rows) process.stdout.write(`  ${r.engine.padEnd(12)}${r.tag} (needs >= ${r.minRef})${r.ok ? "" : ` — ${r.problems[0]}`}\n`);
        process.stdout.write(`  forks       ${Object.keys(config.forks).length} still to adopt\n`);
      }
      return;
    }

    usage("usage: webindex skill check|bundle|vendor|copy|doctor|init");
  }

  if (cmd === "doctor") {
    const base = firecrawlBase();
    const sx = searxngBase();
    const ol = ollamaBase();
    const qd = qdrantBase();
    const pdfRungs = enabledExtractors();
    const docRungs = enabledDocExtractors();
    // The npx rungs are asked whether npm already holds them, never told to
    // install: doctor must not download 10 MB to say what a run would do.
    const cacheState = (id: string, spec: string) =>
      (pdfRungs as string[]).includes(id) || (docRungs as string[]).includes(id) ? npxCacheState(spec) : undefined;
    const [fc, sxUp, olUp, qdUp, inspectorCache, anydocCache, ocr] = await Promise.all([
      base ? probeFirecrawl(base) : false,
      sx ? probeSearxng(sx) : false,
      probeOllama(ol),
      probeQdrant(qd),
      cacheState("pdf-inspector", PDF_INSPECTOR_SPEC),
      cacheState("anydoc", ANYDOC_SPEC),
      ocrTools(),
    ]);
    const off = (s: string) => s.toLowerCase() === "off";
    const npxRung = (state: Awaited<ReturnType<typeof npxCacheState>> | undefined) =>
      state === "cached"
        ? "installed (npx cache)"
        : state === "not cached"
          ? "downloads on first use (npx)"
          : state === "no npx"
            ? "npx not found"
            : "runs through npx";
    // What each rung will actually do here — not merely that it is enabled.
    const rungState = (id: string): string => {
      if (id === "pdf-inspector") return npxRung(inspectorCache);
      if (id === "anydoc") return npxRung(anydocCache);
      if (id === "firecrawl") return base ? (fc ? `answering at ${base}` : `not reachable at ${base}`) : "disabled";
      if (id === "pdftotext") return have("pdftotext") ? "installed" : "not installed";
      if (id === "ocr") {
        if (ocrBudgetLeft() <= 0) return `off (${envName("OCR_MAX")}=${env("OCR_MAX")})`;
        return ocr.copyablePdf && ocr.tesseract
          ? "available"
          : `unavailable (copyable-pdf: ${ocr.copyablePdf ? "yes" : "no"}, tesseract: ${ocr.tesseract ? "yes" : "no"})`;
      }
      if (id === "builtin") return "built-in (OOXML and OpenDocument)";
      return "built-in";
    };
    // The ladder in the order it runs, then the rungs the environment switched
    // off, with the variable that did it.
    const rungLines = (label: string, all: readonly string[], enabled: readonly string[], engineVar: string) => {
      const why = env(engineVar)?.trim() ? `${envName(engineVar)}=${env(engineVar)!.trim()}` : envName("NO_NPX");
      const rows = [...enabled.map((id) => [id, rungState(id)]), ...all.filter((id) => !enabled.includes(id)).map((id) => [id, `off (${why})`])];
      return rows.map(([id, state], i) => `  ${(i ? "" : label).padEnd(12)}${id!.padEnd(15)}${state}`);
    };
    const lines = [
      `webindex ${ENGINE_VERSION}`,
      `  searxng     ${sx ? (sxUp ? `answering at ${sx}` : `not reachable at ${sx} — \`webindex searxng up\` starts it`) : "disabled"}`,
      `  firecrawl   ${base ? (fc ? `answering at ${base}` : `not reachable at ${base} — the built-in extractor is used instead`) : "disabled"}`,
      `  ollama      ${off(ol) ? "disabled" : olUp ? `answering at ${ol} (model ${embedModel()})` : `not reachable at ${ol} — \`webindex semantic up\` starts it`}`,
      `  qdrant      ${off(qd) ? "disabled" : qdUp ? `answering at ${qd}` : `not reachable at ${qd} — \`webindex semantic up\` starts it`}`,
      ...rungLines("pdf rungs", PDF_EXTRACTORS, pdfRungs, "PDF_ENGINE"),
      ...rungLines("doc rungs", DOC_EXTRACTORS, docRungs, "DOC_ENGINE"),
      "",
      "  Everything optional degrades to a note — nothing above is required, and none of it needs a key.",
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  fail(`unknown command "${cmd}" — run \`webindex --help\``);
}

// Only when run as a program. Importing this module must not start anything —
// the skill-bundle gate imports the built artifact to read its flag tables.
if (isInvokedDirectly()) {
  main().catch((e) => {
    process.stderr.write(`webindex: ${(e as Error).message}\n`);
    process.exit(EXIT_FAILURE);
  });
}
