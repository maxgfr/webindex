#!/usr/bin/env node
import { checkArtifactRecall, recallPolicy } from "./skillkit/recall.js";
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
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configure, env, envFlag, envInt, envName } from "./brand.js";
import { decodeLocal } from "./charset.js";
import { ENGINE_VERSION } from "./version.js";
import { DOC_EXTRACTORS, docFormatForUrl, extractDocument, enabledDocExtractors, sniffDocument } from "./doc.js";
import { enabledExtractors, extractPdf, ocrBudgetLeft, ocrTools, PDF_EXTRACTORS } from "./pdf.js";
import {
  enabledTranscribers,
  extractFrames,
  FRAME_EFFORT,
  type FrameEffort,
  fetchVideoRun,
  formatStamp,
  searchVideoRuns,
  VIDEO_TRANSCRIBERS,
  videoRoot,
  whisperBudgetLeft,
  whisperModel,
  ytdlpVersionAge,
  knownVideo,
  videoSource,
  youtubeListKind,
  fetchVideoCorpus,
} from "./video.js";
import { videoDeps } from "./video/ladder.js";
import { ANYDOC_SPEC, PDF_INSPECTOR_SPEC } from "./pdf/exec.js";
import { enginesFromEnv } from "./pdf/ladder.js";
import { npxCacheState } from "./pdf/npx.js";
import { have } from "./exec.js";
import { type ExtractResult, extractMainHtml, fetchAndExtract, htmlToText, httpGet, httpJson, looksLikePdfUrl, stripConsentBoilerplate } from "./fetch.js";
import { firecrawlBase, probeFirecrawl } from "./firecrawl.js";
import { embedModel, ensureComposeMaterialized, STACK_SERVICES, stackControl } from "./stack.js";
import { ollamaBase, probeOllama } from "./embed.js";
import { hybridSearch, probeQdrant, qdrantBase } from "./vector.js";
import { embed } from "./embed.js";
import { crawlSite } from "./crawl.js";
import { extractTables, tableToMarkdown } from "./tables.js";
import { documentBaseUrl, markdownAgainst } from "./markdown.js";
import { fingerprint, hasChanged } from "./changed.js";
import {
  auditEngineUsage,
  auditSkillBundle,
  checkPins,
  readSkillConfig,
  scaffoldSkill,
  skillNameProblem,
  vendorEngine,
  type CliSurface,
} from "./skillkit/index.js";
import { isKeylessEngine, KEYLESS_ENGINES, type KeylessEngine } from "./engines.js";
import { probeSearxng, search, searxngBase, searxngIsExplicit } from "./search.js";
import { cacheClean, cacheDir, cachedFetchAndExtract, cacheStats, setCacheMode } from "./cache.js";
import { fetchRobots, isAllowed } from "./robots.js";
import { discoverFeeds, fetchFeed, fetchSitemap, parseFeed } from "./feed.js";
import { pageMetadata } from "./structured.js";
import { type RepoRef, resolveRepo } from "./repo.js";
import { apiBase, type ForgeKind, forgeAuthHeaders, forgeRef, listReleases, listTags, repoFactsResult, searchIssues } from "./forge.js";
import { configuredForgeHosts, normalizeForgeHost } from "./forge-host.js";
import { type RegistryKind, resolvePackageResult } from "./registry.js";
import { bm25MatchedTerms, bm25Score, bm25Tokenize, buildBm25Index, dedupeNearDuplicates, diversify } from "./rank.js";
import {
  argBool,
  argInt,
  argValue,
  type CliSpec,
  type CommandArgs,
  EXIT_FAILURE,
  EXIT_HUMAN,
  EXIT_OK,
  EXIT_USAGE,
  isInvokedDirectly,
  jsonLine,
  parseArgs,
  positionalText,
  UsageError,
} from "./cli-kit.js";
import { ensureDir, isNoWrite, writeArtifact } from "./no-write.js";
import { mapLimit } from "./pool.js";
import type { JsonSchemaProp } from "./mcp/protocol.js";
import { InvalidParamsError, ToolError, type McpAdapter, type ToolDecl } from "./mcp/server.js";
import { runStdioServer } from "./mcp/stdio.js";
import { startHttpServer } from "./mcp/http.js";
import { browserDoctor } from "./browser/doctor.js";
import { BROWSER_CAP_ADVICE, browserToolDecls, createBrowserToolHost } from "./browser/mcp.js";
import { confinePath, publicUrlRefusal, publicUrlsOnly, toolTimeoutMs } from "./mcp/policy.js";

configure({ name: "webindex", envPrefix: "WEBINDEX", cli: "webindex", contactUrl: "https://github.com/maxgfr/webindex" });

export const HELP = `webindex v${ENGINE_VERSION}
Find pages with a local keyless search stack, turn a URL or a file into clean,
citable text — HTML, PDFs through a six-rung ladder ending in OCR, and office
documents — and serve that to an agent over MCP. Zero dependencies, no API key.

USAGE
  webindex search <query> [--json] [--limit <n>] [--pages <n>] [--lang <tag>]
                          [--region <cc>|wt] [--engine ddg|ddglite|mojeek|off]
                          [--searxng <base>|off] [--firecrawl <base>|off]
                          [--timeout <ms>]
  webindex fetch <url> [<url> …] [--json] [--format text|markdown]
                       [--firecrawl <base>|off] [--lang <tag>] [--full-page] [--cache]
                       [--refresh] [--offline] [--timeout <ms>] [--browser]
  webindex extract <file|-> [--json] [--format text|markdown] [--full-page]
  webindex rank --query <q> [--docs <file.json|->] [--limit <n>] [--dense] [--json]
  webindex repo <ref> [--forge github|gitlab|gitea] [--json]
  webindex issues <ref> [--terms "<words>"] [--limit <n>] [--forge <kind>] [--json]
  webindex prs <ref> [--terms "<words>"] [--limit <n>] [--forge <kind>] [--json]
  webindex releases <ref> [--limit <n>] [--forge <kind>] [--json]
  webindex tags <ref> [--limit <n>] [--forge <kind>] [--json]
  webindex package <name> [--registry npm|pypi|crates] [--version <semver>] [--json]
  webindex meta <url|file|-> [--json]
  webindex robots <url> [--json]
  webindex sitemap <url> [--max <n>] [--json]
  webindex feed <url> [--json]
  webindex mcp [--transport stdio|http] [--port <n>] [--bind <addr>] [--allow-remote]
               [--public-only] [--allow-private] [--extract-root <dir>] [--browser]
  webindex searxng   up|down|status
  webindex firecrawl up|down|status
  webindex semantic  up|down|status
  webindex stack     up|down|status|path
  webindex cache     status|clean [--all] [--json]
  webindex crawl <url> --max <n> [--depth <n>] [--prefix <path>] [--no-sitemap]
                       [--cross-origin] [--json]
  webindex tables <url|file|-> [--markdown] [--json]
  webindex embed <text> | --docs <file.json|-> [--lines] [--json]
  webindex hybrid --query <q> [--docs <file.json|->] [--limit <n>] [--json]
  webindex changed <url> [--etag <v>] [--last-modified <date>] [--hash <sha256>]
                         [--timeout <ms>] [--json]
  webindex skill     check [--engine <name>] [--root <dir>] [--json]
  webindex skill     bundle|copy|doctor [--root <dir>] [--json]
  webindex skill     vendor [--engine <name>] --ref <tag> | --check
  webindex skill     repin [--root <dir>] [--json]
  webindex skill     finish [--root <dir>]
  webindex skill     recall [--ref <baseline>] [--root <dir>]
  webindex skill     init <name> [--root <dir>]
  webindex video     fetch <url> [--out <dir>] [--lang <tag>] [--refresh] [--json]
  webindex video     search <query> [--out <dir>] [--limit <n>] [--json]
  webindex video     frames <url|id|dir> [--effort low|med|high] [--out <dir>] [--json]
  webindex video     list <playlist|channel> [--limit <n>] [--out <dir>] [--refresh] [--json]
  webindex browser   open <url> [--new-tab] [--headless] [--profile <n>] [--cdp <port|url>]
                     [--browser-kind chrome|brave|chromium|edge]
                     [--capture] [--snapshot] [--timeout <ms>]
  webindex browser   attach <port|url> | status | close [--all] | eval <expr|->
  webindex browser   snapshot [<ref> | --selector <css>] [--interactive] [--max-chars <n>]
  webindex browser   text [<ref> | --selector <css>] [--markdown] [--max-chars <n>]
  webindex browser   click|hover <ref> [--confirm] | type <ref> <text> [--submit]
  webindex browser   fill <ref> <text> | select <ref> <val…> | press <key> [--confirm]
  webindex browser   upload <ref> <file…> | scroll <ref|up|down|top|bottom>
  webindex browser   wait --text|--gone|--selector|--url <s> | --idle | --load | --clear
                     | --ms <n> [--timeout <ms>]
  webindex browser   screenshot [<ref> | --selector <css>] [--full] [--out <file>]
  webindex browser   network [list|get <n>|clear] | tabs [list|new|select <tN>|close <tN>]
  webindex browser   back|forward|reload | dialog accept|dismiss (MCP only)
  webindex browser   profile import <kind|path> [--force] | reset | path
  webindex doctor [--json]
  webindex version

COMMANDS
  search     Find candidate URLs: a local SearXNG first, then the keyless
             engines (DuckDuckGo, DDG Lite, Mojeek — no key, no container),
             then Firecrawl. Prints what it found, or says which backend was
             missing and how to start it — those are different answers.
             --lang is the result language; --region a country overriding
             the one it implies (fr + ca is Canadian French), or wt for none.
             --timeout bounds the WHOLE cascade, every rung and page; the
             rungs it never reached are named. --json adds each rung's
             outcome (rungs) and whether anything answered (searched).
  fetch      Fetch a URL and print the extracted text. Routes PDFs and office
             documents to their ladders automatically — by URL, content-type,
             download filename or the bytes themselves; images, media and
             archives get a note, never their bytes. Uses Firecrawl when
             available, with built-in extraction as fallback. HTML is reduced
             to main content with consent banners dropped; --full-page keeps
             the whole page through the built-in reader, navigation, footer and
             consent banners included. --format markdown writes an HTML page as
             CommonMark — links and images absolute, code fenced, lists and
             tables kept — the shape Firecrawl returns (the default, text,
             flattens all but the headings); PDFs and office documents keep
             their text either way. Caching is opt-in: --cache reuses a fresh
             copy for the TTL (24 h) and revalidates a stale one with a
             conditional GET, so an unchanged page costs a 304; --refresh
             re-fetches and rewrites the entry; --offline serves only what the
             cache holds. --json adds finalUrl (after redirects), canonical,
             documentType and cached. Several URLs are read four at a time
             (WEBINDEX_FETCH_CONCURRENCY), each printed under a "==> <url> <=="
             header in the order given, or as one --json array; a URL with
             nothing readable is named on stderr, and the run fails only when
             every one of them did. A video URL — YouTube, Vimeo, Dailymotion,
             Twitch, TED, Loom, TikTok and the other common hosts — returns
             its transcript as Markdown, one [mm:ss] stamp per paragraph and
             a heading per chapter: manual subtitles, else the video's own
             auto-captions (never a machine translation), else a local
             whisper transcription — through yt-dlp, which has to be
             installed. A post on such a host with no video is read as a page.
             --browser renders the page in the dedicated browser (see browser),
             for a page only JavaScript fills; WEBINDEX_BROWSER_FETCH=fallback
             does it only when the plain read is refused, walled or near empty.
  extract    Same extraction, on a file already on disk (- reads stdin),
             recognised by its bytes when its name says otherwise. --full-page
             keeps the whole HTML page, navigation and consent banners included;
             --format markdown writes it as CommonMark, as fetch does. Plain
             text and documents keep their text either way.
  rank       Order candidate documents against a question — BM25F, then a
             near-duplicate collapse, then MMR so the top says several
             different things. Reads a JSON array of {url,title,text} from
             --docs or stdin; a document's own "score" (a search engine's
             relevance) is fused with BM25F by rank, but never lifts one that
             shares no term with the question. Each collapsed mirror is named
             on stderr (in "duplicates" with --json). MMR reorders the best
             max(5 × --limit, 100); the rest follow by relevance. Warns when no
             document contains any term of the question. Deterministic; no
             model, no network — unless --dense fuses in the local embedding
             lane first (as hybrid does), which degrades to BM25F with a note
             when no embedding server answers.
  repo       A repository's own facts: stars, licence, default branch, last
             push, and whether it is archived — the record, not the README.
             A <ref> is owner/repo, any repository URL (one copied from a
             browser works), git@host:owner/repo, or a local checkout, read as
             its origin. --forge names what a self-hosted host runs when its
             name does not say (salsa.debian.org is a GitLab).
  issues     Search a repository's issues on GitHub, GitLab or Gitea. Every
             term must match; when together they match nothing, it searches
             once more with the most distinctive ones and says so on stderr.
  prs        Search a repository's pull or merge requests, as issues searches
             its issues.
  releases   Its releases, newest first, with their notes.
  tags       Its tags — the versions of a project that tags without
             publishing releases.
  package    A library NAME resolved through npm, PyPI or crates.io to its
             repository, docs, current version, licence and deprecation.
             --version answers for that version (or an npm dist-tag) or not
             at all. A registry that cannot be reached stops the search, so
             another ecosystem's namesake never answers in its place.
  meta       What a page says about itself: JSON-LD, OpenGraph and meta tags —
             author, dates, type, canonical URL. A saved page on disk (- reads
             stdin) is decoded as extract decodes it.
  robots     Whether robots.txt permits fetching that URL. Exits non-zero when
             it does not, so it composes in a shell.
  sitemap    The URLs a site lists in its sitemap: the ones robots.txt names,
             and an index's children, reading at most --max documents
             (default 3); /sitemap.xml is guessed only when robots.txt names
             none. Gzipped and plain-text sitemaps too, up to the protocol's
             50 MB. The children --max did not reach are named on stderr.
  feed       A site's RSS, Atom or JSON Feed, or the feeds the page
             advertises. Relative entry links are resolved.
  mcp        Serve these commands to an agent as MCP tools — search, fetch,
             extract, rank, the forge, registry and site lookups, tables,
             embed and crawl (hybrid and skill stay here). stdio by default;
             --transport http binds loopback unless --allow-remote.
             --public-only refuses URLs that are, or resolve to, loopback,
             private, link-local or metadata addresses, checked again at
             every redirect; --extract-root <dir> confines webindex_extract
             to one directory (symlinks resolved). --allow-remote turns both
             walls on: no local file at all without --extract-root, and
             --allow-private lifts the address one. With WEBINDEX_MCP_TOKEN
             set, HTTP answers only requests carrying it as a bearer token.
             --browser adds the webindex_browser_* tools (see browser), for
             this machine only: never with --allow-remote or --public-only.
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
             somebody else's server. --max counts pages returned; a failed
             fetch costs none, but a crawl makes at most 3 x --max page
             requests. The walk stays on the origin the seed lands on (its
             http->https or www redirect included), seeds itself from the
             sitemap (--no-sitemap to skip it; a seed below the root takes only
             its own section's entries), and --prefix /docs/ keeps it under a
             path. Links to images, media and archives are not fetched. A
             robots.txt that errors, or a Crawl-delay over 60 s, stops it.
  tables     The tables on a page as headers and rows, with colspan and rowspan
             resolved. Plain extraction flattens a table into prose in which
             every figure has lost its row and column. A saved page on disk (-
             reads stdin) is decoded as extract decodes it.
  embed      Vectors for a text, from the local Ollama. No key, and nothing
             leaves the machine. Needs \`webindex semantic up\`. --docs embeds a
             JSON array of strings (--lines: one text per non-empty line) in
             one run, in input order.
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
             'repin', 'finish' and 'recall' are the steps of the reusable
             .github/workflows/skill-repin.yml: move every pin to the newest
             stable release, wait for CI and publication to complete, and check
             that regenerated artifacts kept every identity of the --ref
             baseline (HEAD by default).
             Dev-time only — it reads a repo, it never runs inside one.
  video      A video kept on disk, so a question about it never reads it
             twice — any page yt-dlp reads: YouTube, Vimeo, Dailymotion and
             hundreds more. 'fetch' writes <dir>/<key>/TRANSCRIPT.md (the key
             is the YouTube id, else site-id: vimeo-76979871; what fetch
             prints for a video), segments.json and meta.json, and reuses them
             on the next call — no yt-dlp at all — unless --refresh. 'search'
             ranks ~45 s passages of every video under --out (or of one video's
             own directory) against a question, each with its [mm:ss] stamp
             and a link that opens the video there. 'frames' takes what is
             on screen — a frame at every scene change and chapter start,
             near-duplicates dropped, at most 20, 50 or 100 by --effort (med
             by default) — into <id>/frames/, and FRAMES.md pairs each with
             what was said from 5 s before it to 10 s after; it needs ffmpeg,
             and fetches the video first when given a URL. 'list' reads the
             first --limit videos (default 10) of a playlist or channel on any
             site, two at a time, and writes CORPUS.md naming them V1…Vn;
             'search' on that directory then labels its hits V1…Vn. The directory is --out,
             else WEBINDEX_VIDEO_DIR, else <tmp>/webindex/video.
  browser    Drive a real Chrome, Brave, Chromium or Edge for an agent: a
             SEPARATE browser on a dedicated profile, never your own, launched
             on first use (headed unless --headless) and reused by every later
             call, its tab and refs included. attach <port|url> (or --cdp)
             drives one on a loopback port; close shuts down only a browser it
             launched. snapshot prints the accessibility tree with refs (e12)
             on controls and containers (table, figure…); a ref or --selector
             scopes snapshot, screenshot and text, and --selector an action's
             --snapshot. text reads the tab's main content, overlays gone. A
             ref from before a navigation is stale. An irreversible-looking
             click or Enter (pay, delete, send, a password) needs --confirm:
             ask the user first. A challenge is never bypassed: the human
             solves it, then wait --clear. --capture records the JSON fetched
             (network list|get|clear). A dialog is dismissed before the command
             ends; mcp --browser answers them. --json on every action. Exit 1:
             a stale ref, a timeout, a refusal; Exit 3: the page needs a human
             (a blocking challenge), the result printed as on success.
  doctor     Report which optional helpers are reachable, and what each
             extraction rung will do on this machine: installed, downloads on
             first use, not installed, built-in, or switched off (and by which
             variable). The npx rungs are checked against npm's cache, never
             installed. The video rungs show yt-dlp's age, flagged past 60
             days, and whether whisper has uvx and ffmpeg.

ENVIRONMENT
  WEBINDEX_SEARXNG       SearXNG base URL, or "off"   (default http://localhost:8888)
  WEBINDEX_ENGINES       keyless engines to try: a comma list, or "off"  (default all)
  WEBINDEX_FIRECRAWL     Firecrawl base URL, or "off"  (default http://localhost:3002)
  WEBINDEX_FIRECRAWL_KEY a bearer key, only for a hosted Firecrawl
  WEBINDEX_PAGE_DELAY_MS pause between two result pages of one engine (default 350)
  WEBINDEX_PDF_ENGINE    the PDF rungs to run, in order: a comma list of
                         pdf-inspector|anydoc|firecrawl|pdftotext|native|ocr, or "none"
  WEBINDEX_DOC_ENGINE    the office rungs to run, in order: a comma list of
                         anydoc|firecrawl|builtin, or "none" to disable
                         (builtin reads OOXML and OpenDocument with no network)
  WEBINDEX_NO_NPX        skip the rungs that would install through npx
  WEBINDEX_NPX_TIMEOUT_MS  how long one npx rung may run, first download included
                         (default 90000)
  WEBINDEX_OCR_MAX       documents this process may OCR (default 3)
  WEBINDEX_OCR_LANG, WEBINDEX_OCR_TIMEOUT_MS
                         tesseract's language (default eng), one document's budget (300000)
  WEBINDEX_VIDEO_ENGINES the transcript rungs to run, in order: a comma list of
                         manual-subs|auto-subs|whisper, or "none"
  WEBINDEX_WHISPER_MODEL, WEBINDEX_WHISPER_MAX, WEBINDEX_WHISPER_TIMEOUT_MS
                         whisper's model (default small), videos one process may
                         transcribe (3), one video's budget (1800000)
  WEBINDEX_YTDLP_ARGS    extra yt-dlp flags on every call: browser cookies, a proxy
  WEBINDEX_VIDEO_DIR     where \`video\` keeps its runs (default <tmp>/webindex/video)
  WEBINDEX_OLLAMA        embedding server base URL, or "off"  (default http://localhost:11434)
  WEBINDEX_QDRANT        vector store base URL, or "off"      (default http://localhost:6333)
  WEBINDEX_EMBED_MODEL   the embedding model to ask for       (default nomic-embed-text)
  WEBINDEX_EMBED_QUERY_PREFIX, WEBINDEX_EMBED_DOC_PREFIX
                         the task prefixes hybrid puts before the question and each
                         document ("none" for none); default from the model — nomic's
                         "search_query: " / "search_document: ", mxbai's, e5's
  WEBINDEX_EMBED_MAX_CHARS  characters of each document hybrid embeds (default 8000, 0 = all)
  WEBINDEX_EMBED_BATCH, WEBINDEX_EMBED_CONCURRENCY
                         texts per embedding request (16), requests in flight (4)
  WEBINDEX_QDRANT_UPSERT_BATCH  points per upsert request (default 256)
  WEBINDEX_RRF_K         the fusion constant rank and hybrid use (default 60)
  WEBINDEX_TIMEOUT_MS    how long a request may take, body download included, before
                         it is abandoned, not retried (default 20000; --timeout overrides it per call)
  WEBINDEX_MAX_ATTEMPTS, WEBINDEX_RETRY_MS
                         attempts per request (default 2, at most 5), back-off before a retry (600)
  WEBINDEX_CACHE_DIR     where the fetch cache lives, and the stack in compose/
                         (default <tmp>/webindex-<uid>/cache, private to you)
  WEBINDEX_CACHE_TTL_HOURS  how long a cached page stays fresh (default 24; fractions allowed)
  WEBINDEX_NO_WRITE      write nothing: no cache entry, no eviction
  WEBINDEX_NO_ROBOTS     robots and crawl do not consult robots.txt — only on a site you own
  WEBINDEX_ROBOTS_UA     the token robots.txt groups are matched against (default webindex)
  WEBINDEX_CRAWL_CONCURRENCY  pages a crawl keeps in flight, 1-16 (default 4); one host still departs single-file
  WEBINDEX_FETCH_CONCURRENCY  URLs one fetch keeps in flight, 1-16 (default 4), one host's included
  WEBINDEX_POLITE_DELAY_MS    floor between two requests a crawl makes to one host, in ms
                              (default 400); a robots.txt Crawl-delay wins
  WEBINDEX_MAX_CRAWL_DELAY_MS the longest robots.txt Crawl-delay a crawl waits out, in ms
                              (default 60000); a site asking for more is not crawled
  WEBINDEX_PUBLIC_ONLY   set to make every \`mcp\` run --public-only
  WEBINDEX_EXTRACT_ROOT  the directory \`mcp\` confines webindex_extract to (--extract-root)
  WEBINDEX_MCP_TOKEN     the bearer token \`mcp --transport http\` then requires
  WEBINDEX_UA            override the browser User-Agent
  WEBINDEX_BROWSER_DIR   where \`browser\` keeps its profiles and session (default ~/.webindex/browser)
  WEBINDEX_BROWSER_BIN   the browser it drives (default the first Chrome, Brave, Chromium or Edge found)
  WEBINDEX_BROWSER_KIND  the kind it launches when no binary is named: chrome, brave, chromium or edge
                         (brave blocks ads and trackers on its own); --browser-kind on open wins
  WEBINDEX_BROWSER_EXTENSIONS  unpacked extensions it loads when it launches the browser, absolute
                         paths, comma separated (an ad blocker); branded Chrome ≥ 137 ignores them
  WEBINDEX_BROWSER_FETCH fetch renders pages in that browser: always, fallback or off (default)
  GITHUB_TOKEN, GH_TOKEN, GITLAB_TOKEN, GITEA_TOKEN
                         optional forge tokens (WEBINDEX_GITHUB_TOKEN and its kin win over
                         them); each goes only to github.com, gitlab.com, or a host listed
                         in WEBINDEX_FORGE_HOSTS
  WEBINDEX_FORGE_HOSTS   self-hosted forges, e.g. "salsa.debian.org=gitlab,git.corp=github":
                         each is queried as that forge and receives that forge's token
  WEBINDEX_NO_GH         never reach for the gh CLI on github.com — plain HTTP only
  WEBINDEX_DOCKER_PULL_TIMEOUT_MS  the image-pull budget of up (default 1200000)

The README lists every variable, the library-only ones included.
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
  "region",
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
  "prefix",
  "extract-root",
  "format",
  "out",
  "effort",
  "profile",
  "cdp",
  "browser-kind",
  "max-chars",
  "text",
  "gone",
  "selector",
  "url",
  "ms",
];
export const BOOL_FLAGS = [
  "json",
  "allow-remote",
  "all",
  "check",
  "markdown",
  "cross-origin",
  "no-sitemap",
  "full-page",
  "cache",
  "refresh",
  "offline",
  "dense",
  "lines",
  "public-only",
  "allow-private",
  "new-tab",
  "headless",
  "capture",
  "snapshot",
  "interactive",
  "confirm",
  "submit",
  "idle",
  "load",
  "clear",
  "full",
  "browser",
  "force",
];
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
  "video",
  "browser",
  ...STACK_SERVICES.filter((s) => s !== "all"),
  "stack",
];

const SPEC: CliSpec = { commands: COMMANDS, valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS };

/** What `webindex skill` does. The last three are the repin workflow's steps (.github/workflows/skill-repin.yml). */
const SKILL_ACTIONS = ["check", "bundle", "vendor", "copy", "doctor", "init", "repin", "finish", "recall"];

/** What `webindex video` does. */
const VIDEO_ACTIONS = ["fetch", "search", "frames", "list"];

/** A yt-dlp release older than this is flagged by doctor: YouTube breaks old ones. */
const YTDLP_STALE_DAYS = 60;

/**
 * End with `code` once everything written is out. process.exit() ends the
 * process at once, and a write to a pipe (`webindex … | jq`) is asynchronous:
 * a result over the pipe's buffer (64 KiB) was cut off there, while a file or a
 * terminal got all of it. Every path that printed a result returns after this
 * instead; fail() and usage() print one line of their own.
 */
function exitAfterOutput(code: number): void {
  process.exitCode = code;
}

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

/** `--format text|markdown`: the shape of an HTML page's text, text by default. */
function argFormat(args: CommandArgs): "text" | "markdown" {
  const format = argValue(args, "format") ?? "text";
  if (format !== "text" && format !== "markdown") throw new UsageError(`--format expects text or markdown, got "${format}"`);
  return format;
}

/** `--timeout <ms>`: a positive whole number of milliseconds, or absent for the default. */
function argTimeout(args: CommandArgs): number | undefined {
  const ms = argInt(args, "timeout");
  if (ms !== undefined && ms < 1) throw new UsageError(`--timeout expects a positive number of milliseconds, got "${ms}"`);
  return ms;
}

/**
 * The walls `webindex mcp` puts round its tools, from the flags and the
 * environment.
 *
 * --allow-remote turns the two that matter on by default: a server others can
 * reach refuses private addresses (lifted by --allow-private) and reads no
 * local file (unless --extract-root names the one directory it may). Keyed on
 * the flag rather than on the bind address, because "others can reach this" is
 * what the flag says — a loopback server behind a reverse proxy is reachable
 * too, and its operator can say so. Exported for the suite.
 */
export function mcpPolicy(args: CommandArgs, allowRemote: boolean): WebindexToolPolicy {
  const allowPrivate = argBool(args, "allow-private");
  if (allowPrivate && argBool(args, "public-only")) usage("--public-only and --allow-private contradict each other");
  const publicOnly = !allowPrivate && (argBool(args, "public-only") || envFlag("PUBLIC_ONLY") || allowRemote);
  // The browser tools drive a real browser, logins included, that goes wherever
  // a page sends it: no address wall holds it, and it is not for others to use.
  const browser = argBool(args, "browser");
  if (browser && allowRemote)
    usage("--browser and --allow-remote contradict each other: the browser tools drive a logged-in browser on this machine, for it alone");
  if (browser && publicOnly) {
    usage(
      `--browser and --public-only (or ${envName("PUBLIC_ONLY")}) contradict each other: a browser follows any address a page leads it to, private ones included`,
    );
  }
  const rootArg = argValue(args, "extract-root") ?? env("EXTRACT_ROOT");
  let extractRoot: string | undefined;
  if (rootArg !== undefined) {
    extractRoot = resolve(rootArg);
    let isDir = false;
    try {
      isDir = statSync(extractRoot).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) usage(`--extract-root ${rootArg} is not a directory`);
  }
  return {
    publicOnly,
    ...(extractRoot !== undefined ? { extractRoot } : allowRemote ? { noLocalFiles: true } : {}),
    ...(browser ? { browser } : {}),
    ...(allowRemote ? { remote: true } : {}),
  };
}

/** What the policy is, said once at startup — nothing when there is none. */
function mcpPolicyNotice(policy: WebindexToolPolicy, allowRemote: boolean, allowPrivate: boolean): string[] {
  const lines: string[] = [];
  if (policy.publicOnly) lines.push(`fetches: public addresses only${allowRemote ? " (the --allow-remote default; --allow-private lifts it)" : ""}.`);
  else if (allowRemote && allowPrivate) lines.push("fetches: any address, this machine's own network included (--allow-private).");
  if (policy.extractRoot !== undefined) lines.push(`local files: only under ${policy.extractRoot}.`);
  else if (policy.noLocalFiles) lines.push("local files: none, and webindex_extract is off (--extract-root <dir> offers one directory).");
  if (policy.browser) lines.push("browser: the webindex_browser_* tools drive a separate browser on this machine; irreversible actions need confirm: true.");
  return lines;
}

// The whole webindex_search cascade's budget: every rung and page within it.
const SEARCH_TOOL_BUDGET_MS = 45_000;
// The most result pages webindex_search walks per engine.
const SEARCH_TOOL_MAX_PAGES = 5;

const FORGE_KINDS: readonly ForgeKind[] = ["github", "gitlab", "gitea"];
const isForgeKind = (v: string): v is ForgeKind => (FORGE_KINDS as readonly string[]).includes(v);
const isRegistryKind = (v: string): v is RegistryKind => v === "npm" || v === "pypi" || v === "crates";

// The optional `forge` argument the repository tools share.
const FORGE_ARG: JsonSchemaProp = {
  type: "string",
  description: "Which forge a self-hosted host runs when its name does not say (salsa.debian.org is gitlab). Omit for github.com, gitlab.com, Codeberg.",
  enum: [...FORGE_KINDS],
};

// The optional `format` argument webindex_fetch and webindex_extract share.
const FORMAT_ARG: JsonSchemaProp = {
  type: "string",
  description:
    "The shape of an HTML page's text: text (default; headings kept as #, the rest flattened) or markdown (CommonMark with absolute links, fenced code, lists and tables — the shape Firecrawl returns). PDFs and office documents keep their text either way.",
  enum: ["text", "markdown"],
};

/** Why an httpGet failed: the status a server gave, or — when none answered — what went wrong instead. */
const fetchFailure = (r: { status: number; error?: string }): string => (r.status ? `status ${r.status}` : (r.error ?? "no answer"));

/** A repository argument as the forge commands read it: parsed, and a local checkout read as its origin. */
function forgeTarget(raw: string, kind: ForgeKind | undefined): RepoRef {
  const opts = kind ? { kind } : {};
  return forgeRef(resolveRepo(raw, opts), opts);
}

/**
 * Extraction over a file on disk — the shared half of `extract` and
 * `webindex_extract`. `given` is bytes already in hand (the CLI's stdin), for
 * which `path` is only a name to route by.
 */
async function extractLocal(
  path: string,
  fullPage = false,
  given?: Buffer,
  format: "text" | "markdown" = "text",
): Promise<{ text: string; extractor: string; reason?: string; consentDropped: number }> {
  let bytes: Buffer;
  try {
    bytes = given ?? readFileSync(path);
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
  const markdown = format === "markdown";
  const main = looksHtml && !fullPage ? extractMainHtml(raw) : raw;
  // A file has no address of its own to resolve against — only the <base href>
  // a saved page may carry, and only when that one is absolute.
  const text = !looksHtml ? raw : markdown ? markdownAgainst(main, documentBaseUrl(raw), fullPage) : htmlToText(main, { fullPage });
  const consent = looksHtml && !fullPage ? stripConsentBoilerplate(text, { markdown }) : { text, dropped: 0 };
  return { text: consent.text, extractor: looksHtml ? "native" : "plain", consentDropped: consent.dropped };
}

/**
 * The commit a release tag names, for `skill vendor --ref`: the files are then
 * fetched by that immutable commit rather than by a tag that could move.
 *
 * Through the GitHub CLI when it is installed — the repin workflow's path, with
 * its authentication — else GitHub's REST API, keyless for a public repository.
 * It used to be gh or nothing, and a machine without gh got "spawnSync gh
 * ENOENT" for an answer.
 */
async function tagCommit(repo: string, tag: string): Promise<string> {
  let viaGh: string | undefined;
  if (have("gh")) {
    try {
      return releaseCommit(repo, tag);
    } catch (e) {
      viaGh = (e as Error).message.trim().split("\n")[0];
    }
  }
  const r = await httpJson("GET", `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(tag)}`, undefined, {
    accept: "application/vnd.github+json",
    headers: forgeAuthHeaders("github", "api.github.com"),
  });
  const sha = r.ok ? (r.data as { sha?: unknown } | undefined)?.sha : undefined;
  if (typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)) return sha;
  throw new ToolError(
    `could not resolve ${repo}@${tag} to a commit — GitHub answered ${r.status ? `HTTP ${r.status}` : (r.error ?? "nothing")}${viaGh ? `, and gh said: ${viaGh}` : ""}`,
  );
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

interface RankResult {
  ranked: RankedOut[];
  collapsed: number;
  duplicates: { url: string; of: string }[];
  queryTerms: string[];
  /** Why the order is less than it looks: no dense lane when one was asked for, or no document matched. */
  note?: string;
}

/**
 * Ranks that ties share ("1, 2, 2, 4"): two documents one lane cannot tell
 * apart are left for the other lanes to order, rather than ranked by whichever
 * happened to come first.
 */
function competitionRanks(values: readonly number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[b]! - values[a]!);
  const ranks = new Array<number>(values.length);
  order.forEach((i, p) => {
    const prev = order[p - 1];
    ranks[i] = prev !== undefined && values[prev] === values[i] ? ranks[prev]! : p + 1;
  });
  return ranks;
}

// MMR is quadratic in what it diversifies, and diversity is read at the top of
// a list: it reorders the best max(5 × limit, MMR_WINDOW) candidates and the
// rest follow in relevance order. At 2 000 documents that is milliseconds
// instead of seconds, and the top of the list barely moves.
const MMR_WINDOW = 100;

/**
 * The shared ranking pipeline behind `webindex rank` and `webindex_rank`.
 *
 * BM25F for relevance, SimHash to collapse syndicated copies, MMR so the top of
 * the list is not four rewrites of one argument. Scores are normalised to the
 * pool max, so "0.7" means "70% as relevant as the best thing here" rather than
 * an uncalibrated BM25 magnitude nobody can compare across runs.
 *
 * Two optional lanes are fused with BM25F by reciprocal rank, which needs no
 * calibration between a BM25 score, a cosine and a search engine's number: the
 * documents' own `score`, and with `dense` the embedding lane `hybridSearch`
 * computes. Without the dense lane nothing here reads meaning, so a document
 * sharing no term with the question stays at zero whatever its own score says.
 * A fused score is the fusion rescaled over the matching documents — 1 for the
 * best, 0.01 for the weakest — so it orders the pool but is not a ratio.
 */
async function rankDocuments(question: string, docs: RankInput[], opts: { limit?: number; dense?: boolean } = {}): Promise<RankResult> {
  const { limit } = opts;
  const bm = docs.map((d, i) => ({ id: String(i), title: d.title ?? "", headings: d.headings ?? "", body: d.text ?? "" }));
  // Each body is tokenised ONCE, and the tokens shared by the index, the
  // near-duplicate hash and the diversity pass — it used to be read three times.
  const bodyTokens = bm.map((d) => bm25Tokenize(d.body));
  const index = buildBm25Index(question, bm, { tokensOf: (d) => bodyTokens[Number(d.id)]! });
  const raw = bm.map((d) => bm25Score(index, d));

  const lanes: (number | undefined)[][] = [];
  // A document's own `score` — typically its search engine's relevance — was
  // validated and documented, then ignored: equal BM25 documents scored 0.01
  // and 0.99 were ordered by URL.
  if (docs.some((d) => d.score !== undefined)) {
    const ranks = competitionRanks(docs.map((d) => d.score ?? Number.NEGATIVE_INFINITY));
    lanes.push(docs.map((d, i) => (d.score === undefined ? undefined : ranks[i])));
  }
  const notes: string[] = [];
  let dense = false;
  if (opts.dense) {
    const h = await hybridSearch(question, bm);
    const ranks = new Array<number | undefined>(bm.length);
    for (const hit of h.hits) if (hit.denseRank !== undefined) ranks[Number(hit.doc.id)] = hit.denseRank;
    dense = ranks.some((r) => r !== undefined);
    if (dense) lanes.push(ranks);
    else notes.push(h.note ?? "the dense lane returned nothing — ranked with BM25F only.");
  }
  let relevance = raw;
  if (lanes.length) {
    const k = envInt("RRF_K", 60);
    const lexical = competitionRanks(raw);
    const fused = raw.map((s, i) => {
      if (!dense && !(s > 0)) return 0;
      let f = 1 / (k + lexical[i]!);
      for (const lane of lanes) if (lane[i] !== undefined) f += 1 / (k + lane[i]!);
      return f;
    });
    // A reciprocal-rank sum over n documents spans only (1 + lanes)/(k + n) to
    // (1 + lanes)/(k + 1). Divided by the pool max, every matching document
    // landed between ~0.86 and 1, the gap between the best and the worst was
    // smaller than MMR's diversity penalty, and a page last in every lane was
    // ranked second. Rescaled between the weakest and the best matching
    // document, the order is the same but the relevance spans the range MMR
    // weighs against similarity; the weakest keeps a sliver above zero, so it
    // still reads as matched and stays ahead of the documents that did not.
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (const f of fused) {
      if (f > 0 && f < lo) lo = f;
      if (f > hi) hi = f;
    }
    const floor = 0.01;
    relevance = fused.map((f) => (!(f > 0) ? 0 : hi > lo ? floor + ((1 - floor) * (f - lo)) / (hi - lo) : 1));
  }
  if (!dense && index.queryTerms.length && raw.every((s) => !(s > 0))) {
    notes.push("no document contains any term of the question — the order is not a relevance ranking.");
  }
  // A loop, not Math.max(...relevance): spreading a very large pool overflows the stack.
  let max = 1e-9;
  for (const r of relevance) if (r > max) max = r;

  const scored = docs.map((d, i) => ({
    url: d.url,
    title: d.title,
    text: d.text ?? "",
    score: (relevance[i] ?? 0) / max,
    matched: bm25MatchedTerms(index, bm[i]!),
    tokens: bodyTokens[i]!,
  }));
  // Code-unit tie-break: localeCompare reads LANG, and two machines disagreed.
  scored.sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  const { items: unique, dropped, duplicates } = dedupeNearDuplicates(scored, { tokensOf: (it) => it.tokens });
  const window = Math.max((limit && limit > 0 ? limit : 0) * 5, MMR_WINDOW);
  const ordered = diversify(unique, (it) => it.tokens, 0.75, { window });

  const ranked = ordered.slice(0, limit && limit > 0 ? limit : undefined).map((it, i) => ({
    rank: i + 1,
    url: it.url,
    ...(it.title ? { title: it.title } : {}),
    score: Number(it.score.toFixed(4)),
    matched: it.matched,
  }));
  return { ranked, collapsed: dropped, duplicates, queryTerms: index.queryTerms, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

/** JSON.parse that says which input was broken and what was expected, instead of the parser's bare message. */
function parseJsonInput(text: string, label: string, expected: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON (${(e as Error).message}) — ${expected}`);
  }
}

/**
 * The text a command reads from `--docs <file>` or, without it, stdin. A
 * terminal on stdin with no --docs is a usage error, not a silent wait for
 * input that is not coming.
 */
function readDocsInput(args: CommandArgs, usageLine: string): { text: string; label: string } {
  const src = argValue(args, "docs");
  if (src === undefined && process.stdin.isTTY) usage(usageLine);
  const label = `--docs ${src === undefined || src === "-" ? "(stdin)" : src}`;
  try {
    return { text: readFileSync(src === undefined || src === "-" ? 0 : src, "utf8"), label };
  } catch (e) {
    fail(`cannot read ${src === undefined || src === "-" ? "stdin" : src}: ${(e as Error).message}`);
  }
}

/** Stdin's bytes, for a `-` argument. A terminal would never send any, so it is a usage error. */
function readStdin(usageLine: string): Buffer {
  if (process.stdin.isTTY) usage(usageLine);
  try {
    return readFileSync(0);
  } catch (e) {
    fail(`cannot read stdin: ${(e as Error).message}`);
  }
}

/**
 * The HTML a page-level command reads: an http(s) URL fetched, or a file on
 * disk (stdin for `-`) decoded exactly as `extract` decodes one — BOM, then the
 * declared charset, then UTF-8 with a Windows-1252 fallback.
 *
 * A saved page, or one only a logged-in browser could fetch, used to be refused
 * with "needs an http(s) URL", though reading its tables or its metadata needs
 * no network at all. `url` is set only for a fetched page: resolving a relative
 * canonical against a file:// address would invent a URL the page never had.
 */
async function readPage(target: string, accept: string, usageLine: string): Promise<{ body: string; url?: string }> {
  if (/^https?:\/\//i.test(target)) {
    const page = await httpGet(target, { accept });
    if (!page.ok) fail(`could not fetch ${target} (status ${page.status})`);
    return { body: page.body, url: page.url };
  }
  let bytes: Buffer;
  if (target === "-") bytes = readStdin(usageLine);
  else {
    try {
      bytes = readFileSync(target.startsWith("file:") ? fileURLToPath(target) : target);
    } catch (e) {
      fail(`${target} is neither an http(s) URL nor a readable file (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
  }
  const body = decodeLocal(bytes, { sniffHtmlCharset: true });
  // Decoded text keeps no NUL; an image or an archive has one early.
  if (body.slice(0, 1024).includes("\u0000")) fail(`${target === "-" ? "stdin" : target} is binary data, not an HTML page`);
  return { body };
}

const RANK_DOCS_SHAPE = "pass a JSON array of {url, text} via --docs <file> or stdin";

/** Parse and validate the `documents` payload both entry points accept. */
function parseRankDocs(value: unknown, where: string): RankInput[] {
  const arr = typeof value === "string" ? parseJsonInput(value, where, "pass a JSON array of {url, text}") : value;
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

// The tools that stay on this machine: a file on disk, a pool the caller sent,
// the local embedding server. Every other one reaches the open web or a public
// API, whose answers no one here controls.
const CLOSED_WORLD_TOOLS = new Set(["webindex_extract", "webindex_rank", "webindex_embed", "webindex_video_search"]);

/** A tool's count argument: a whole number from 1 to `max`, else the default. */
function toolLimit(raw: unknown, def: number, max = 50): number {
  const n = typeof raw === "number" ? Math.trunc(raw) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : def;
}

// The tools that write: each video tool keeps its run on disk, under the video root.
const WRITING_TOOLS = new Set(["webindex_video_fetch", "webindex_video_frames", "webindex_video_list"]);
// ...and of those, the ones that replace what an earlier call wrote.
const REPLACING_TOOLS = new Set(["webindex_video_frames", "webindex_video_list"]);

/**
 * The hints a client reads before calling. Without them it must assume any
 * tool may be destructive and ask before every call — and none of these writes,
 * deletes or changes anything it reaches (the fetch cache is this engine's own
 * bookkeeping, not the caller's environment), so a repeat call is harmless too.
 */
function withHints(tools: ToolDecl[]): ToolDecl[] {
  return tools.map((t) => ({
    ...t,
    // A tool that brings its own hints keeps them: the browser tools act on a page, and say how.
    annotations: t.annotations ?? {
      // The video tools write their run directory. A transcript is only ever
      // added; frames replace the video's earlier frames, and a corpus the
      // directory's earlier CORPUS.md — so those two say they may destroy.
      readOnlyHint: !WRITING_TOOLS.has(t.name),
      destructiveHint: REPLACING_TOOLS.has(t.name),
      idempotentHint: true,
      openWorldHint: !CLOSED_WORLD_TOOLS.has(t.name) || WRITING_TOOLS.has(t.name),
    },
  }));
}

/**
 * The declarations as this server's policy shapes them. A tool that could only
 * fail is not offered — the model would spend a call learning that — and an
 * argument the policy constrains says so where the model reads it.
 */
function withPolicy(policy: WebindexToolPolicy, tools: ToolDecl[]): ToolDecl[] {
  const root = policy.extractRoot;
  const offered = root === undefined && policy.noLocalFiles ? tools.filter((t) => t.name !== "webindex_extract") : tools;
  const withArg = (t: ToolDecl, name: string, prop: JsonSchemaProp): ToolDecl => ({
    ...t,
    inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, [name]: prop } },
  });
  return withHints(
    offered.map((t) => {
      if (t.name === "webindex_extract" && root !== undefined) {
        return withArg(t, "path", {
          type: "string",
          description: `Path to the file, under ${root} — the only directory this server reads; a relative path is read from there.`,
        });
      }
      if (t.name === "webindex_fetch" && policy.publicOnly) {
        return withArg(t, "cache", {
          type: "boolean",
          description: "Ignored here: this server fetches public addresses only, and never reads the on-disk cache, which unguarded runs share.",
        });
      }
      return t;
    }),
  );
}

/**
 * The walls an operator can put round the tools (`webindex mcp` flags).
 *
 * Off by default: on a developer's own machine, fetching any URL and reading
 * any file is the point. Exposed with --allow-remote, the first two are on
 * unless lifted, because a fetch that reaches 169.254.169.254 hands out cloud
 * credentials and a file tool reads ~/.ssh.
 */
export interface WebindexToolPolicy {
  /** Refuse URLs that are, or resolve to, non-public addresses — checked again at every redirect. */
  publicOnly?: boolean;
  /** Read local files (webindex_extract, a repository named by its path) only under this directory. */
  extractRoot?: string;
  /** Read no local file at all: webindex_extract is not offered. `extractRoot` wins over it. */
  noLocalFiles?: boolean;
  /** Offer the webindex_browser_* tools (`mcp --browser`), over one browser session kept for the adapter's life. */
  browser?: boolean;
  /**
   * Reachable beyond this machine (`mcp --allow-remote`). webindex_fetch then
   * never renders in the browser, whatever `<PREFIX>_BROWSER_FETCH` says: that
   * browser is this machine's, logins included, and not for others to drive.
   */
  remote?: boolean;
}

// The host name a public-only check had to resolve, or undefined when it
// needed no resolver: a URL that is not http(s), or a literal address.
function resolvedHost(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  return isIP(host) ? undefined : host;
}

/**
 * webindex's own MCP tools: fetch a URL, extract a file.
 *
 * Exported because it is a useful seam in both directions — the suite drives it
 * without a subprocess, and a host embedding several engines can mount these
 * tools inside its own server rather than spawning `webindex mcp`.
 */
export function webindexAdapter(policy: WebindexToolPolicy = {}): McpAdapter & { close(): Promise<void> } {
  // Nothing starts until a browser tool is called.
  const browserHost = policy.browser ? createBrowserToolHost({ policy }) : undefined;
  // One authorizer for the adapter's life: fetchRobots keys its cache by it.
  const guard = policy.publicOnly ? publicUrlsOnly() : undefined;
  const refuseUrl = async (url: string): Promise<void> => {
    if (!guard) return;
    const why = await publicUrlRefusal(url);
    if (!why) return;
    // What a name resolved to, or how resolving it failed, is the view of this
    // machine's network the wall exists to hide: told "resolves to 10.2.3.4",
    // any caller could map internal names. So a refusal that needed the
    // resolver says only that the name is not public; one that did not (a
    // literal address, a scheme) keeps its reason, which tells nothing new.
    const host = resolvedHost(url);
    throw new ToolError(`Refused ${url}: ${host ? `${host} is not a public address, or did not resolve` : why} — this server fetches public addresses only.`);
  };
  const root = policy.extractRoot;
  const localFiles = root !== undefined || !policy.noLocalFiles;
  // A local path, as the policy allows it: under the root, or not at all.
  const localPath = (requested: string): string => {
    if (!localFiles) throw new ToolError(`${requested} is a path on this machine, and this server reads no local files.`);
    if (root === undefined) return requested;
    try {
      return confinePath(root, requested);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
  };
  // The ref a forge tool was named, with the file policy applied BEFORE the
  // filesystem is asked anything. resolveRepo asks first whether the string
  // is a directory, and the wall ran only when it was: an existing directory
  // got the wall's refusal, a missing one "does not name a repository", and a
  // caller could map the machine. Under a policy, a path (absolute, `./`,
  // `../`, `~`) goes to the wall whether or not it exists; anything else is a
  // checkout only when the root holds it, and otherwise a remote, read without
  // a probe. A relative name is the root's, as it is for webindex_extract.
  const repoRef = (raw: string, kind: { kind?: ForgeKind }): RepoRef => {
    if (root === undefined && localFiles) return resolveRepo(raw, kind);
    const named = raw.trim();
    if (isAbsolute(named) || /^(?:\.{1,2}|~)(?:[\\/]|$)/.test(named)) return resolveRepo(localPath(named), kind);
    if (named && root !== undefined) {
      try {
        const under = confinePath(root, named);
        if (statSync(under).isDirectory()) return resolveRepo(under, kind);
      } catch {
        /* not a checkout under the root: a remote */
      }
    }
    return resolveRepo(named, { ...kind, local: false });
  };
  // A forge host a caller named, where the operator did not: under the
  // public-only policy it must resolve publicly like any URL. Checked here on
  // the API base, for a refusal that says why before anything is sent.
  const refuseForgeHost = async (ref: RepoRef, kind: ForgeKind | undefined): Promise<void> => {
    if (!guard || configuredForgeHosts().has(normalizeForgeHost(ref.host))) return;
    await refuseUrl(apiBase(ref, kind ? { kind } : {}));
  };
  // ...and at every redirect after it, which the forge client follows by hand,
  // out of `fetch`'s sight: a public host answering 302 → 169.254.169.254 was
  // otherwise followed, and the metadata answer's fields came back to the
  // caller. A host the operator declared is trusted on its own origin — a
  // renamed repository redirects there — and nowhere else.
  const forgeGuard = (ref: RepoRef, kind: ForgeKind | undefined): ((url: string) => Promise<boolean>) | undefined => {
    if (!guard) return undefined;
    if (!configuredForgeHosts().has(normalizeForgeHost(ref.host))) return guard;
    const own = new URL(apiBase(ref, kind ? { kind } : {})).origin;
    return async (url) => new URL(url).origin === own || (await guard(url));
  };
  // Where a video tool keeps its runs. With no policy, any directory the
  // caller names; under one, only a directory NAME inside the video root —
  // a path would let a caller write, or list, anywhere on the machine.
  const guarded = guard !== undefined || root !== undefined || policy.noLocalFiles === true;
  const videoDir = (raw: unknown): string => {
    const base = videoRoot();
    if (raw === undefined || raw === null || raw === "") return base;
    const named = String(raw);
    // A relative name belongs under the video root, never under wherever the
    // server happened to start: "animals" once landed in the caller's cwd.
    if (!guarded) return isAbsolute(named) ? named : resolve(base, named);
    if (!/^[A-Za-z0-9._-]+$/.test(named) || named === "." || named === "..") {
      throw new ToolError(`\`dir\` must be the name of a directory inside ${base} on this server, not a path.`);
    }
    mkdirSync(base, { recursive: true });
    const target = join(base, named);
    if (existsSync(target) && relative(realpathSync(base), realpathSync(target)).startsWith("..")) {
      throw new ToolError(`${named} leads outside ${base}, the only directory this server writes videos to.`);
    }
    return target;
  };
  // Which pages a video tool may hand yt-dlp. With no policy, any http(s)
  // URL: yt-dlp reads hundreds of sites. Under one, only the hosts knownVideo
  // recognises (and YouTube's lists): yt-dlp follows its own redirects, out of
  // the public-address check's sight, so an arbitrary page is not handed to it.
  const videoUrl = async (raw: unknown, what: "video" | "list"): Promise<string> => {
    const url = String(raw ?? "");
    const ok =
      what === "video"
        ? videoSource(url, { anySite: !guarded })
        : guarded
          ? youtubeListKind(url)
          : youtubeListKind(url) || (/^https?:\/\//i.test(url) && !knownVideo(url));
    if (!ok) {
      throw new ToolError(
        what === "video"
          ? guarded
            ? "`url` must be a video on a host this server reads (YouTube, Vimeo, Dailymotion, Twitch, TED, Loom, TikTok…)."
            : "`url` must be an http(s) URL of a video."
          : guarded
            ? "`url` must be a YouTube playlist or channel URL."
            : "`url` must be the http(s) URL of a playlist or channel.",
      );
    }
    await refuseUrl(url);
    return url;
  };
  return {
    version: ENGINE_VERSION,
    listTools: (): ToolDecl[] =>
      withPolicy(policy, [
        {
          name: "webindex_search",
          title: "Search for candidate URLs",
          description:
            "Find candidate URLs: a locally-running SearXNG first, then the keyless engines (DuckDuckGo, DuckDuckGo Lite, Mojeek — no key, no container), then Firecrawl. " +
            "Returns title, URL and snippet — not page text; follow up with webindex_fetch on the ones worth reading. " +
            "When nothing answers it says which piece was missing rather than returning an empty result that reads like 'nothing exists'. " +
            `The whole cascade is bounded at ${SEARCH_TOOL_BUDGET_MS / 1000} s; the last line names each rung's outcome (rungs: searxng=unreachable ddg=hits(8) …).`,
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "What to search for." },
              limit: { type: "number", description: "How many hits to aim for (default 10)." },
              lang: { type: "string", description: "BCP-47 language tag, e.g. fr-FR." },
              region: { type: "string", description: "Country code overriding the one `lang` implies, e.g. ca for fr + Canada; wt asks for no region." },
              pages: { type: "number", description: `Result pages to walk per engine (default 1, at most ${SEARCH_TOOL_MAX_PAGES}).` },
              engine: {
                type: "string",
                description:
                  "Restrict the keyless rung to one engine: ddg | ddglite | mojeek (SearXNG and Firecrawl still run around it). Omit to try all three in turn.",
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
            "videos on YouTube, Vimeo, Dailymotion, Twitch, TED, Loom, TikTok and the other common hosts (a timestamped, chaptered transcript: manual subtitles → the video's own auto-captions → a local whisper transcription, which can take minutes for a long video with no subtitles), " +
            "and uses Firecrawl when available, with built-in extraction as fallback. Returns the extracted text, then a trailer with the final URL after redirects, the page's canonical URL and title, any note, and which rung produced it — never raw bytes. " +
            "Accepts URLs from the host's native search (including ChatGPT or Claude) or supplied directly; webindex_search is optional.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "The http(s) URL to fetch." },
              lang: { type: "string", description: "Accept-Language tag, e.g. fr-FR." },
              fullPage: { type: "boolean", description: "Keep the whole page: no main-content isolation, no consent-banner filter." },
              format: FORMAT_ARG,
              timeoutMs: {
                type: "number",
                description:
                  "How long the request may take, connection and body download included, before it is abandoned, in ms (default 20000, at most 300000). A timed-out request is not retried.",
              },
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
              format: FORMAT_ARG,
            },
            required: ["path"],
          },
        },
        {
          name: "webindex_rank",
          title: "Rank candidate documents against a question",
          description:
            "Order a pool of documents by relevance to a question: BM25F (title and headings weighted above body), then SimHash collapse of near-duplicates, then MMR so the top of the list says several different things rather than restating one. " +
            "Returns the ranking with a score, the matched query terms, and what was collapsed (each dropped mirror's URL and the URL it duplicated), plus a `note` when no document matched or the dense lane was missing — deterministic, no model, no network unless `dense` asks for the local embedding lane. " +
            "Use it after gathering pages from any search provider to decide what to actually read. Scores measure relevance within this pool, not factual accuracy.",
          inputSchema: {
            type: "object",
            properties: {
              question: { type: "string", description: "What the ranking is for." },
              documents: {
                type: "array",
                description:
                  'The pool. Each item is {url, text} plus optional {title, headings, score}. A `score` (e.g. the search engine\'s own relevance) is fused with BM25F by rank; it never lifts a document sharing no term with the question. Passed as JSON, e.g. [{"url":"…","title":"…","text":"…"}].',
              },
              limit: { type: "number", description: "How many ranked entries to return (default all)." },
              dense: {
                type: "boolean",
                description:
                  "Fuse the local embedding lane (Ollama) with BM25F before the collapse and MMR, so a page that never uses the question's words can still rank. Falls back to BM25F with a `note` when no embedding server answers. Default false: deterministic and offline.",
              },
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
            "Fetch and parse the site's sitemap (the ones robots.txt names, else /sitemap.xml; gzipped and plain-text ones too), returning page URLs with their last-modified dates. " +
            "At most `max` documents are read — enumerating a site is a budget you set, not something this does on its own — and the child sitemaps it did not reach come back in `unfetched`.",
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
          title: "A site's RSS, Atom or JSON feed",
          description:
            "Parse a feed URL (RSS, Atom or JSON Feed), or discover and parse the feeds a page advertises. Returns dated, ordered entries with absolute URLs — the site telling you what it published and when, " +
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
            "Fails with a note naming the command that starts the service when it is not running.",
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
            "Follow links from a seed page, breadth-first, honouring robots.txt at EVERY hop and staying on the origin the seed lands on. `max` pages is required — enumerating " +
            "someone else's site is the one operation here that can inconvenience them, so the budget is not optional. Returns each page's URL, title and text, " +
            "the URLs robots.txt refused (`disallowed`), how many in-scope URLs the budget did not reach (`pending`), and `notes`.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "The seed page." },
              max: {
                type: "number",
                description:
                  "Pages to return. Required. A failed fetch costs no page, but the crawl makes at most 3 × `max` page requests in all. " +
                  "Every page's text comes back inline and an answer over 1 MB is withheld, so ask for the tens of pages you will read, not hundreds.",
              },
              depth: { type: "number", description: "How many links deep to follow (default 2)." },
              prefix: { type: "string", description: "Only follow URLs whose path starts with this, e.g. `/docs/`." },
              sitemap: {
                type: "boolean",
                description: "Seed the walk from the site's sitemap too (default true; a seed below the root takes only its own section's entries).",
              },
            },
            required: ["url", "max"],
          },
        },
        {
          name: "webindex_video_fetch",
          title: "Read a video, and keep it",
          description:
            "Read a video — YouTube, Vimeo, Dailymotion or any page yt-dlp reads (only the known video hosts under this server's public-only policy) — into a run directory and return its transcript as Markdown: a header (title, channel, date, duration, which track), a heading per chapter, and a [mm:ss] stamp on every paragraph — cite by stamp. " +
            "Manual subtitles first, then the video's own auto-captions, then a local whisper transcription (minutes for a long video). The run is kept: a second call, and webindex_video_search, read it without touching the site.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "The video's URL: YouTube (watch, youtu.be, shorts, embed, live), Vimeo, Dailymotion, or any page yt-dlp reads.",
              },
              lang: {
                type: "string",
                description: "Preferred subtitle language, e.g. fr. Defaults to the video's own; another language's track is marked as a translation.",
              },
              refresh: { type: "boolean", description: "Read the video again even when its run is on disk." },
              dir: { type: "string", description: "The directory runs are kept in (default: the server's video root)." },
            },
            required: ["url"],
          },
        },
        {
          name: "webindex_video_search",
          title: "Search the videos already read",
          description:
            "Rank ~45 s passages of the videos kept in a directory (every one, or a corpus from webindex_video_list, labelled V1…Vn) against a question, with BM25F. " +
            "Each hit has its video, [mm:ss] stamp, chapter, a link that opens the video there, and the passage — for answering a follow-up question without reading the video again.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "The question, or its key words." },
              limit: { type: "number", description: "How many passages (default 10)." },
              dir: { type: "string", description: "The directory to search (default: the server's video root)." },
            },
            required: ["query"],
          },
        },
        {
          name: "webindex_video_frames",
          title: "What is on screen in a video",
          description:
            "Take a frame at every scene change and chapter start of a video, drop near-duplicates, keep at most 20/50/100 by `effort`, and pair each frame with what was said from 5 s before to 10 s after. " +
            "Returns FRAMES.md's path and each frame's image path, stamp and aligned transcript; read the images to see slides, code or diagrams. Downloads the video (720p at most) and needs ffmpeg — expect tens of seconds.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "The video's URL; read first when it is not kept yet." },
              effort: { type: "string", enum: ["low", "med", "high"], description: "At most 20, 50 or 100 frames (default med)." },
              dir: { type: "string", description: "The directory runs are kept in (default: the server's video root)." },
            },
            required: ["url"],
          },
        },
        {
          name: "webindex_video_list",
          title: "Read a playlist or a channel",
          description:
            "Read the first `limit` videos of a playlist or channel — YouTube, or any site yt-dlp lists (YouTube only under a public-only policy) — two at a time, each kept as its own run, and write CORPUS.md naming them V1…Vn in listing order — the labels to cite across videos. " +
            "A video that cannot be read keeps its label, with the reason. Returns the corpus rows; webindex_video_search on the same `dir` then searches them all.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "A playlist or channel URL: YouTube (list=, /@handle, /channel/, /c/, /user/), a Vimeo showcase, a Dailymotion playlist…",
              },
              limit: { type: "number", description: "How many videos (default 10)." },
              dir: { type: "string", description: "The directory the corpus is kept in (default: the server's video root)." },
            },
            required: ["url"],
          },
        },
        ...(policy.browser ? browserToolDecls() : []),
      ]),
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
      webindex_video_fetch: "the transcript is very long; read TRANSCRIPT.md from the run directory, or ask webindex_video_search",
      webindex_video_search: "lower `limit`",
      webindex_video_frames: "lower `effort`",
      webindex_video_list: "lower `limit`",
      ...(policy.browser ? BROWSER_CAP_ADVICE : {}),
    },
    async callTool(name, args, ctx) {
      // What the server hands every call: the client's cancel, and a way to
      // report progress. Passed on to whatever takes it — a cancelled call must
      // stop fetching, not only have its answer dropped.
      const signal = ctx?.signal;
      if (browserHost && name.startsWith("webindex_browser_")) return browserHost.call(name, args, ctx);
      if (name === "webindex_fetch") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        await refuseUrl(url);
        const fullPage = args.fullPage === true;
        const fetchOpts = {
          acceptLanguage: args.lang ? String(args.lang) : undefined,
          fullPage,
          stripConsent: !fullPage,
          format: args.format === "markdown" ? ("markdown" as const) : ("text" as const),
          timeoutMs: toolTimeoutMs(args.timeoutMs),
          signal,
          // The same wall that refuses --browser: a browser follows any address
          // a page leads it to, in a profile that may be logged in.
          ...(policy.remote || policy.publicOnly ? { browser: "off" as const } : {}),
        };
        // Guarded, every hop is checked (which also keeps Firecrawl — a fetcher
        // no hook reaches — out of it), and the cache is not read: it holds what
        // unguarded runs fetched, a private page among them.
        const r: ExtractResult & { cached?: boolean } = guard
          ? await fetchAndExtract(url, { ...fetchOpts, authorizeUrl: guard })
          : await cachedFetchAndExtract(url, fetchOpts, args.cache === true);
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
          region: args.region ? String(args.region) : undefined,
          // Clamped, not refused: every page is another request to an engine
          // that rations them, and an agent's 50 should cost it a few pages,
          // not the call.
          pages:
            typeof args.pages === "number" && Number.isFinite(args.pages) ? Math.min(SEARCH_TOOL_MAX_PAGES, Math.max(1, Math.trunc(args.pages))) : undefined,
          // An MCP host gives up on a tool call long before a cascade of
          // timeouts would: better a partial answer that says where it
          // stopped than none at all.
          timeoutMs: SEARCH_TOOL_BUDGET_MS,
          signal,
          ...(engines ? { engines } : {}),
        });
        // The notes are prose; this line is the same facts in a form an agent
        // can act on without parsing English — "blocked" is not "empty".
        const rungs = r.rungs?.length ? `rungs: ${r.rungs.map((x) => `${x.rung}=${x.outcome}${x.hits ? `(${x.hits})` : ""}`).join(" ")}` : "";
        if (!r.hits.length) throw new ToolError([r.notes.join(" ") || "No results.", rungs].filter(Boolean).join("\n"));
        const body = r.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`).join("\n\n");
        const trailer = [...r.notes, rungs].filter(Boolean);
        return { text: trailer.length ? `${body}\n\n---\n${trailer.join("\n")}` : body };
      }
      if (name === "webindex_extract") {
        const r = await extractLocal(localPath(String(args.path ?? "")), args.fullPage === true, undefined, args.format === "markdown" ? "markdown" : "text");
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
        const r = await rankDocuments(question, docs, { limit: typeof args.limit === "number" ? args.limit : undefined, dense: args.dense === true });
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
        const raw = String(args.repo ?? "");
        const kind = forge ? { kind: forge } : {};
        // A local checkout is read (its origin remote) before anything else, so
        // the file policy is applied before forgeRef runs git in it.
        const ref = forgeRef(repoRef(raw, kind), kind);
        if (ref.host === "generic") throw new ToolError(`"${raw}" does not name a repository.`);
        await refuseForgeHost(ref, forge);
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const authorizeUrl = forgeGuard(ref, forge);
        const opts = { ...(limit ? { limit } : {}), ...(forge ? { kind: forge } : {}), ...(authorizeUrl ? { authorizeUrl } : {}) };
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
        await refuseUrl(url);
        const robotsOpts = guard ? { authorizeUrl: guard } : {};

        if (name === "webindex_robots") {
          const r = await fetchRobots(url, robotsOpts);
          return { text: JSON.stringify({ url, allowed: isAllowed(r, url), ...r }, null, 2) };
        }
        if (name === "webindex_sitemap") {
          const robots = await fetchRobots(url, robotsOpts);
          const max = typeof args.max === "number" ? args.max : undefined;
          const s = await fetchSitemap(url, {
            sitemaps: robots.sitemaps,
            max,
            signal,
            authorizeUrl: guard,
            onDocument: (doc, fetched) => ctx?.progress(fetched, max ?? 3, doc),
          });
          if (!s.urls.length && !s.sitemaps.length) throw new ToolError(`No sitemap found for ${url}.${s.notes?.length ? ` ${s.notes.join(" ")}` : ""}`);
          return { text: JSON.stringify(s, null, 2) };
        }
        const page = await httpGet(url, { accept: "text/html,application/xml,application/feed+json,*/*", signal, authorizeUrl: guard });
        if (!page.ok) throw new ToolError(`Could not fetch ${url} (${fetchFailure(page)}).`);
        if (name === "webindex_meta") return { text: JSON.stringify(pageMetadata(page.body, { baseUrl: page.url }), null, 2) };

        const direct = parseFeed(page.body, page.url);
        // A feed with no entries may still point at the one that has them.
        const found = direct?.items.length ? [] : discoverFeeds(page.body, page.url);
        if (direct && !found.length) return { text: JSON.stringify(direct, null, 2) };
        if (!found.length) throw new ToolError(`${url} is not a feed and advertises none.`);
        const feeds = [];
        for (const f of found) {
          const parsed = await fetchFeed(f, { signal, authorizeUrl: guard });
          if (parsed) feeds.push({ url: f, ...parsed });
        }
        if (!feeds.length) throw new ToolError(`${url} advertises ${found.length} feed(s), none of which parsed.`);
        return { text: JSON.stringify(feeds, null, 2) };
      }
      if (name === "webindex_tables") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        await refuseUrl(url);
        const page = await httpGet(url, { accept: "text/html,*/*", signal, authorizeUrl: guard });
        if (!page.ok) throw new ToolError(`could not fetch ${url} (${fetchFailure(page)})`);
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
        await refuseUrl(url);
        let read = 0;
        const r = await crawlSite(url, {
          maxPages: max,
          signal,
          ...(guard ? { authorizeUrl: guard } : {}),
          onPage: (page) => ctx?.progress(++read, max, page.url),
          ...(args.depth !== undefined ? { maxDepth: Number(args.depth) } : {}),
          ...(typeof args.prefix === "string" && args.prefix ? { prefix: args.prefix } : {}),
          ...(args.sitemap === false ? { useSitemap: false } : {}),
        });
        if (!r.pages.length) throw new ToolError(`nothing readable from ${url}${r.notes.length ? ` — ${r.notes.join(" ")}` : ""}`);
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
      if (name === "webindex_video_fetch") {
        const url = await videoUrl(args.url, "video");
        const dir = videoDir(args.dir);
        const r = await fetchVideoRun(url, dir, {
          refresh: args.refresh === true,
          lang: args.lang ? String(args.lang) : undefined,
          signal,
          knownHostsOnly: guarded,
        });
        if (!r.ok) throw new ToolError(`No transcript for ${url}: ${r.reason}.`);
        const text = r.markdown ?? readFileSync(r.transcript, "utf8");
        return { text: `${text}\n---\nrun: ${r.dir}\nvia: ${r.meta.via}${r.reused ? " (already on disk)" : ""}` };
      }
      if (name === "webindex_video_search") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new ToolError("`query` is required.");
        const dir = videoDir(args.dir);
        const hits = searchVideoRuns(dir, query, { limit: toolLimit(args.limit, 10) });
        if (!hits.length) throw new ToolError(`Nothing kept under ${dir} matches "${query}" — read a video first with webindex_video_fetch.`);
        return { text: JSON.stringify({ dir, hits }, null, 2) };
      }
      if (name === "webindex_video_frames") {
        const url = await videoUrl(args.url, "video");
        const effort = args.effort === undefined ? "med" : String(args.effort);
        if (!(effort in FRAME_EFFORT)) throw new ToolError("`effort` must be low, med or high.");
        const run = await fetchVideoRun(url, videoDir(args.dir), { signal, knownHostsOnly: guarded });
        if (!run.ok) throw new ToolError(`No transcript for ${url}: ${run.reason}.`);
        const r = await extractFrames(run.dir, { effort: effort as FrameEffort, signal, url, knownHostsOnly: guarded });
        if (!r.ok) throw new ToolError(r.reason);
        const frames = r.frames.map((f) => ({ image: join(run.dir, f.file), stamp: f.stamp, chapter: f.chapter, kind: f.kind, said: f.text }));
        return { text: JSON.stringify({ markdown: r.markdown, candidates: r.candidates, duplicates: r.duplicates, frames }, null, 2) };
      }
      if (name === "webindex_video_list") {
        const url = await videoUrl(args.url, "list");
        const dir = videoDir(args.dir);
        const limit = toolLimit(args.limit, 10);
        const r = await fetchVideoCorpus(url, dir, {
          limit,
          signal,
          knownHostsOnly: guarded,
          onVideo: (done, total, title) => ctx?.progress(done, total, title),
        });
        if (!r.ok) throw new ToolError(r.reason);
        return { text: JSON.stringify({ corpus: r.corpus, title: r.title, videos: r.videos }, null, 2) };
      }
      throw new ToolError(`unknown tool: ${name}`);
    },
    /** Let go of the browser session, if one was opened; the browser keeps running. */
    close: async () => browserHost?.close(),
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

/**
 * `webindex <cmd> --help`: that command's lines from USAGE and its paragraph
 * from COMMANDS, cut out of HELP rather than written a second time — a second
 * copy is a second thing to drift. Falls back to the whole of HELP for a
 * command it cannot find there.
 */
function commandHelp(cmd: string): string {
  const section = (title: string) => {
    const lines = HELP.split("\n");
    const start = lines.indexOf(title);
    const end = lines.indexOf("", start);
    return start === -1 ? [] : lines.slice(start + 1, end === -1 ? undefined : end);
  };
  // An entry is its first line and the deeper-indented lines that continue it.
  const entries = (lines: string[], head: RegExp) => {
    const out: { name: string; lines: string[] }[] = [];
    for (const line of lines) {
      const m = head.exec(line);
      if (m) out.push({ name: m[1] as string, lines: [line] });
      else out.at(-1)?.lines.push(line);
    }
    return out.filter((e) => e.name === cmd).flatMap((e) => e.lines);
  };
  const usageLines = entries(section("USAGE"), /^ {2}webindex ([a-z-]+)/);
  const described = entries(section("COMMANDS"), /^ {2}([a-z-]+) /);
  if (!usageLines.length) return HELP;
  return [
    `webindex v${ENGINE_VERSION}`,
    "",
    "USAGE",
    ...usageLines,
    "",
    ...described,
    ...(cmd === "mcp" ? ["", ...browserToolsHelp()] : []),
    "",
    "Run `webindex --help` for every command and the environment variables.",
  ].join("\n");
}

/** `mcp --help`: the names of the tools --browser adds, wrapped, and where their arguments are told. */
function browserToolsHelp(): string[] {
  const lines = ["BROWSER TOOLS (--browser): each one's arguments are in references/browser.md", "  (skill://references/browser.md over MCP)"];
  let line = " ";
  for (const t of browserToolDecls()) {
    if (line.length + t.name.length + 1 > 78) {
      lines.push(line);
      line = " ";
    }
    line += ` ${t.name}`;
  }
  return [...lines, line];
}

/**
 * `fetch` over several URLs: at most `<PREFIX>_FETCH_CONCURRENCY` in flight
 * (default 4), each page printed under a `==> <url> <==` header as soon as
 * every page before it is out — in the order given, however they finish — or,
 * with --json, one array in that order. A URL that yields nothing is named on
 * stderr; the run fails only when every one of them did, since one dead link
 * in a reading list is not a failed reading list.
 */
async function fetchSeveral<R>(
  urls: readonly string[],
  fetchOne: (url: string) => Promise<ExtractResult & { cached?: boolean }>,
  json: boolean,
  record: (url: string, r: ExtractResult & { cached?: boolean }) => R,
): Promise<void> {
  const results: (ExtractResult & { cached?: boolean })[] = [];
  let next = 0;
  let wrote = false;
  const report = (i: number): void => {
    const r = results[i]!;
    if (!r.text) {
      process.stderr.write(`webindex: nothing readable at ${urls[i]}${r.note ? ` — ${r.note}` : ""}\n`);
      return;
    }
    if (json) return;
    process.stdout.write(`${wrote ? "\n" : ""}==> ${urls[i]} <==\n${r.text}\n`);
    wrote = true;
    if (r.note) process.stderr.write(`  ${r.note}\n`);
  };
  await mapLimit(urls, envInt("FETCH_CONCURRENCY", 4, 1, 16), async (url, i) => {
    results[i] = await fetchOne(url);
    while (next < urls.length && results[next]) report(next++);
  });
  if (json) {
    const records = results.map((r, i) => record(urls[i]!, r));
    process.stdout.write(JSON.stringify(records, null, 2) + "\n");
  }
  if (results.every((r) => !r.text)) fail(`none of the ${urls.length} URLs had anything readable`);
}

/**
 * How many bare words a command takes: a query or a text any number, the URLs
 * `fetch` reads any number, `rank`, `hybrid`, `doctor` and `mcp` none,
 * everything else one — a URL, a file, a reference, an action. A second one
 * used to be dropped (`fetch a b` fetched a, before it took a list) or glued
 * onto the first (`tables a b` fetched the URL "a b"), and the command then
 * succeeded at something other than what was typed.
 */
function positionalLimit(args: CommandArgs): { max: number; hint?: string } {
  const cmd = args.command;
  if (cmd === "search" || cmd === "embed" || cmd === "fetch") return { max: Number.POSITIVE_INFINITY };
  if (cmd === "rank" || cmd === "hybrid") return { max: 0, hint: 'the question goes in --query "<q>"' };
  if (cmd === "doctor" || cmd === "mcp") return { max: 0 };
  if (cmd === "skill") return { max: args.positional[0] === "init" ? 2 : 1 };
  if (cmd === "video") return args.positional[0] === "search" ? { max: Number.POSITIVE_INFINITY } : { max: 2 };
  // Each action checks its own arguments: type and fill take a text, select and upload a list.
  if (cmd === "browser") return { max: Number.POSITIVE_INFINITY };
  if (cmd === "issues" || cmd === "prs") return { max: 1, hint: 'search words go in --terms "<words>"' };
  if (cmd === "repo" || cmd === "releases" || cmd === "tags") return { max: 1, hint: "quote a path that contains spaces" };
  return { max: 1 };
}

async function dispatch(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, SPEC);
  if (parsed.kind === "help") {
    process.stdout.write((parsed.command ? commandHelp(parsed.command) : HELP) + "\n");
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(ENGINE_VERSION + "\n");
    return;
  }
  const args: CommandArgs = parsed;
  const cmd = args.command;
  const arity = positionalLimit(args);
  if (args.positional.length > arity.max) {
    const extra = args.positional[arity.max] as string;
    const takes = arity.max === 0 ? "no arguments" : arity.max === 1 ? "one argument" : `${arity.max} arguments`;
    usage(`unexpected argument "${extra}" — \`webindex ${cmd}\` takes ${takes}${arity.hint ? `; ${arity.hint}` : ""} (see \`webindex ${cmd} --help\`)`);
  }

  if (cmd === "search") {
    const q = positionalText(args);
    if (!q) usage("usage: webindex search <query>");
    const engine = argValue(args, "engine");
    if (engine && engine !== "off" && !isKeylessEngine(engine)) usage(`unknown --engine "${engine}" — expected one of ${KEYLESS_ENGINES.join(", ")}, or off`);
    const r = await search(q, {
      limit: argInt(args, "limit", { min: 1 }),
      pages: argInt(args, "pages", { min: 1 }),
      lang: argValue(args, "lang"),
      region: argValue(args, "region"),
      searxng: argValue(args, "searxng"),
      firecrawl: argValue(args, "firecrawl"),
      // The budget for the whole cascade, not one request.
      timeoutMs: argTimeout(args),
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
    if (!r.hits.length) exitAfterOutput(EXIT_FAILURE);
    return;
  }

  if (cmd === "fetch") {
    const urls = args.positional;
    if (!urls.length) usage("usage: webindex fetch <url> [<url> …]");
    // Every argument is checked before anything is fetched: a typo in the
    // tenth URL should not cost the first nine requests and then fail.
    const bad = urls.find((u) => !/^https?:\/\//i.test(u));
    if (bad !== undefined) {
      fail(
        `fetch needs an http(s) URL${urls.length > 1 ? `, got "${bad}"` : ""}${existsSync(bad) ? ` — for a file on disk, \`webindex extract ${bad}\`` : ""}`,
      );
    }
    const fullPage = argBool(args, "full-page");
    const format = argFormat(args);
    const refresh = argBool(args, "refresh");
    const offline = argBool(args, "offline");
    if (refresh && offline) usage("--refresh and --offline contradict each other: one always fetches, the other never does");
    // Set both switches every time, so a value from an earlier call in the same
    // process can never leak into this one.
    setCacheMode({ refresh, offline });
    const fetchOpts = {
      acceptLanguage: argValue(args, "lang"),
      firecrawl: argValue(args, "firecrawl"),
      fullPage,
      stripConsent: !fullPage,
      format,
      timeoutMs: argTimeout(args),
      // A flag, not a value: `--browser` is a switch on mcp too. Fallback mode is WEBINDEX_BROWSER_FETCH's.
      ...(argBool(args, "browser") ? { browser: "always" as const } : {}),
    };
    const cache = argBool(args, "cache") || refresh;
    const json = argBool(args, "json");
    const record = (url: string, r: ExtractResult & { cached?: boolean }) => ({
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
    });
    if (urls.length > 1) {
      await fetchSeveral(urls, (url) => cachedFetchAndExtract(url, fetchOpts, cache), json, record);
      return;
    }
    const url = urls[0] as string;
    const r = await cachedFetchAndExtract(url, fetchOpts, cache);
    if (json) {
      process.stdout.write(JSON.stringify(record(url, r), null, 2) + "\n");
    } else if (r.text) {
      process.stdout.write(r.text + "\n");
      // A prefix cut at the size cap, a document link that served a web page,
      // a Firecrawl fallback: said beside the text, as search says its notes,
      // rather than only when there is no text at all.
      if (r.note) process.stderr.write(`  ${r.note}\n`);
    }
    if (!r.text) fail(`nothing readable at ${url}${r.note ? ` — ${r.note}` : ""}`);
    return;
  }

  if (cmd === "extract") {
    const EXTRACT_USAGE = "usage: webindex extract <file|-> [--format text|markdown] [--full-page] [--json]";
    const path = args.positional[0];
    if (!path) usage(EXTRACT_USAGE);
    const fullPage = argBool(args, "full-page");
    const format = argFormat(args);
    // `-` reads stdin, so another tool's output can be extracted without a
    // temp file; its bytes are routed by what they are, having no name.
    const r = await extractLocal(path, fullPage, path === "-" ? readStdin(EXTRACT_USAGE) : undefined, format);
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
    const allowRemote = argBool(args, "allow-remote");
    const policy = mcpPolicy(args, allowRemote);
    // stderr, not stdout: stdio's stdout is the protocol stream, and keeping
    // the two transports identical here means no one has to remember which is
    // which.
    const notice = mcpPolicyNotice(policy, allowRemote, argBool(args, "allow-private"));
    if (transport === "stdio") {
      for (const line of notice) process.stderr.write(`webindex: ${line}\n`);
      const adapter = webindexAdapter(policy);
      await runStdioServer(adapter);
      // A browser session's socket would keep the process alive once stdin has closed.
      await adapter.close();
      return;
    }
    if (transport !== "http") usage(`unknown transport "${transport}" — expected stdio or http`);
    const port = argInt(args, "port", { min: 0, max: 65535 }) ?? 7340;
    const token = env("MCP_TOKEN");
    let running: Awaited<ReturnType<typeof startHttpServer>>;
    try {
      running = await startHttpServer(webindexAdapter(policy), {
        port,
        bind: argValue(args, "bind"),
        allowRemote,
        ...(token ? { bearerToken: token } : {}),
      });
    } catch (e) {
      fail((e as Error).message);
    }
    process.stderr.write(`webindex: MCP server listening on ${running.url}\n`);
    const header = token ? ` --header "Authorization: Bearer $${envName("MCP_TOKEN")}"` : "";
    process.stderr.write(`  client: claude mcp add --transport http webindex ${running.url}${header}\n`);
    if (allowRemote) {
      process.stderr.write(
        token
          ? "  exposed beyond this machine (--allow-remote); every request needs the bearer token.\n"
          : `  exposed beyond this machine (--allow-remote) with no authentication: anyone who can reach the port can use it. Set ${envName("MCP_TOKEN")} to require a bearer token.\n`,
      );
    }
    for (const line of notice) process.stderr.write(`  ${line}\n`);
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
    if (r.code !== 0) exitAfterOutput(r.code);
    return;
  }

  if (cmd === "rank") {
    const RANK_USAGE = "usage: webindex rank --query <question> --docs <file.json|-> [--limit <n>] [--dense] [--json]";
    const question = argValue(args, "query");
    if (!question) usage(RANK_USAGE);
    // Flags first: a bad --limit is worth saying before a large pool is read.
    const limit = argInt(args, "limit", { min: 1 });
    const input = readDocsInput(args, RANK_USAGE);
    let docs: RankInput[];
    try {
      docs = parseRankDocs(parseJsonInput(input.text, input.label, RANK_DOCS_SHAPE), "--docs");
    } catch (e) {
      fail((e as Error).message);
    }
    const r = await rankDocuments(question, docs, { limit, dense: argBool(args, "dense") });
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
      if (r.collapsed) {
        process.stderr.write(`${r.collapsed} near-duplicate(s) collapsed.\n`);
        for (const d of r.duplicates) process.stderr.write(`  ${d.url} duplicates ${d.of}\n`);
      }
    }
    if (r.note) process.stderr.write(`  ${r.note}\n`);
    if (!r.queryTerms.length) {
      process.stderr.write("The question has no rankable terms once stopwords are removed — the order is arbitrary.\n");
      exitAfterOutput(EXIT_FAILURE);
    }
    return;
  }

  // What a code host and a package registry say about a project. Read-only,
  // keyless, and answering from the record rather than from a README.
  if (cmd === "repo" || cmd === "issues" || cmd === "prs" || cmd === "releases" || cmd === "tags" || cmd === "package") {
    const target = positionalText(args);
    if (!target) usage(`usage: webindex ${cmd} <${cmd === "package" ? "name" : "repo"}> [--json]`);
    const asJson = argBool(args, "json");
    const limit = argInt(args, "limit", { min: 1 });
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
    const usageLine = `usage: webindex ${cmd} <url${cmd === "meta" ? "|file|-" : ""}>`;
    if (!target) usage(usageLine);
    // A page's own metadata is in its HTML, wherever that came from; robots,
    // sitemaps and feeds are things a SITE serves.
    if (cmd !== "meta" && !/^https?:\/\//i.test(target)) fail("expected an http(s) URL");
    const asJson = argBool(args, "json");
    const emit = (obj: unknown, human: string[]) => process.stdout.write(asJson ? jsonLine(obj) : `${human.join("\n")}\n`);

    if (cmd === "robots") {
      const r = await fetchRobots(target);
      const allowed = isAllowed(r, target);
      emit({ url: target, allowed, ...r }, [
        `  allowed   ${allowed ? "yes" : "no"}`,
        `  rules     ${
          envFlag("NO_ROBOTS")
            ? `not consulted (${envName("NO_ROBOTS")})`
            : r.unreachable
              ? `none readable (${r.status ? `HTTP ${r.status}` : "no answer"}) — RFC 9309 says to assume nothing may be crawled`
              : r.absent
                ? `none (no robots.txt${r.status ? `, HTTP ${r.status}` : ""})`
                : r.rules.length
        }`,
        ...(r.crawlDelayMs ? [`  delay     ${r.crawlDelayMs}ms`] : []),
        ...(r.sitemaps.length ? [`  sitemaps  ${r.sitemaps.join("\n            ")}`] : []),
      ]);
      if (!allowed) exitAfterOutput(EXIT_FAILURE); // scriptable: `webindex robots <url> && fetch it`
      return;
    }
    if (cmd === "sitemap") {
      const robots = await fetchRobots(target);
      const s = await fetchSitemap(target, { sitemaps: robots.sitemaps, max: argInt(args, "max", { min: 1 }) });
      if (!asJson) for (const n of s.notes ?? []) process.stderr.write(`${n}\n`);
      if (!s.urls.length && !s.sitemaps.length) fail(`no sitemap found for ${target}`);
      // An index whose children the budget did not reach is not an empty
      // site: say which documents are left, and what reads them.
      const unread = s.unfetched ?? [];
      if (!asJson && unread.length)
        process.stderr.write(`${unread.length} child sitemap(s) not read — raise --max to follow them:\n  ${unread.join("\n  ")}\n`);
      if (!s.urls.length && !asJson) fail(`no page URLs in the ${s.sitemaps.length ? "sitemap index" : "sitemap"} read so far`);
      emit(
        s,
        s.urls.map((u) => u.loc),
      );
      return;
    }
    if (cmd === "meta") {
      const page = await readPage(target, "text/html,*/*", usageLine);
      const m = pageMetadata(page.body, page.url ? { baseUrl: page.url } : {});
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
    const page = await httpGet(target, { accept: "text/html,application/xml,application/feed+json,*/*" });
    if (!page.ok) fail(`could not fetch ${target} (status ${page.status})`);
    // What is left is `feed`.
    const direct = parseFeed(page.body, page.url);
    // A feed with no entries may still point at the one that has them.
    const found = direct?.items.length ? [] : discoverFeeds(page.body, page.url);
    if (direct && !found.length) {
      emit(
        direct,
        direct.items.map((i) => `${i.published ? `${i.published}  ` : ""}${i.title ?? ""}\n  ${i.url ?? ""}`),
      );
      return;
    }
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

  if (cmd === "cache") {
    const action = args.positional[0] ?? "status";
    if (action !== "status" && action !== "clean") usage("usage: webindex cache status|clean [--all]");
    if (action === "clean") {
      const all = argBool(args, "all");
      const noWrite = isNoWrite();
      const removed = noWrite ? 0 : cacheClean(all);
      if (argBool(args, "json")) process.stdout.write(jsonLine({ dir: cacheDir(), removed, all, noWrite }));
      // "0 entries removed" would read as an empty cache, not a blocked clean.
      else if (noWrite) process.stdout.write(`no-write mode: nothing removed from ${cacheDir()}\n`);
      else process.stdout.write(`${removed} entr${removed === 1 ? "y" : "ies"} removed (${all ? "all" : "stale only"}) from ${cacheDir()}\n`);
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
        // Otherwise a refused directory reads as an empty cache that never fills.
        ...(s.refused ? [`  unused   ${s.refused}: remove it, or set ${envName("CACHE_DIR")} to a directory only you can write`] : []),
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
    // The same answer the MCP tool gives: a budget of nothing is not a budget.
    if (max < 1) usage("--max must be a positive whole number — a crawl without a budget is not one");
    const prefix = argValue(args, "prefix");
    const depth = argInt(args, "depth", { min: 0 });
    const r = await crawlSite(seed, {
      maxPages: max,
      ...(depth !== undefined ? { maxDepth: depth } : {}),
      crossOrigin: argBool(args, "cross-origin"),
      useSitemap: !argBool(args, "no-sitemap"),
      ...(prefix ? { prefix } : {}),
    });
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(r));
    } else {
      for (const p of r.pages) process.stdout.write(`${p.url}${p.title ? `\n  ${p.title}` : ""}\n`);
      for (const d of r.disallowed) process.stderr.write(`  disallowed: ${d}\n`);
      for (const n of r.notes) process.stderr.write(`  ${n}\n`);
    }
    if (!r.pages.length) exitAfterOutput(EXIT_FAILURE);
    return;
  }

  if (cmd === "tables") {
    const TABLES_USAGE = "usage: webindex tables <url|file|-> [--json]";
    const url = positionalText(args);
    if (!url) usage(TABLES_USAGE);
    const page = await readPage(url, "text/html,*/*", TABLES_USAGE);
    const tables = extractTables(page.body);
    if (!tables.length) fail(`no tables on ${url}`);
    process.stdout.write(argBool(args, "json") ? jsonLine(tables) : `${tables.map(tableToMarkdown).join("\n\n")}\n`);
    return;
  }

  if (cmd === "embed") {
    const EMBED_USAGE = "usage: webindex embed <text> | --docs <file.json|-> [--lines] [--json]";
    const text = positionalText(args);
    if (argValue(args, "docs") !== undefined || argBool(args, "lines")) {
      // A file of passages in one run: one probe, the batching embed() already
      // does, and the vectors in input order.
      if (text) usage(EMBED_USAGE);
      const input = readDocsInput(args, EMBED_USAGE);
      const shape = "a non-empty JSON array of strings (or one text per line with --lines)";
      let texts: string[];
      if (argBool(args, "lines")) texts = input.text.split(/\r?\n/).filter((l) => l.trim());
      else {
        let arr: unknown;
        try {
          arr = parseJsonInput(input.text, input.label, `pass ${shape}`);
        } catch (e) {
          fail((e as Error).message);
        }
        texts = Array.isArray(arr) && arr.every((t) => typeof t === "string") ? (arr as string[]) : [];
      }
      if (!texts.length) fail(`${input.label} must be ${shape}`);
      const r = await embed(texts);
      if (!r.vectors.length) fail(r.note ?? "the embedding server returned nothing");
      process.stdout.write(
        argBool(args, "json")
          ? jsonLine({ model: r.model, dimensions: r.vectors[0]?.length ?? 0, vectors: r.vectors })
          : `${r.vectors.map((v) => v.join(" ")).join("\n")}\n`,
      );
      return;
    }
    if (!text) usage(EMBED_USAGE);
    const r = await embed([text]);
    if (!r.vectors.length) fail(r.note ?? "the embedding server returned nothing");
    process.stdout.write(
      argBool(args, "json") ? jsonLine({ model: r.model, dimensions: r.vectors[0]?.length ?? 0, vector: r.vectors[0] }) : `${(r.vectors[0] ?? []).join(" ")}\n`,
    );
    return;
  }

  if (cmd === "hybrid") {
    const HYBRID_USAGE = "usage: webindex hybrid --query <question> --docs <file.json|->";
    const question = argValue(args, "query");
    if (!question) usage(HYBRID_USAGE);
    const limit = argInt(args, "limit", { min: 1 });
    const input = readDocsInput(args, HYBRID_USAGE);
    let docs: RankInput[];
    try {
      docs = parseRankDocs(parseJsonInput(input.text, input.label, RANK_DOCS_SHAPE), "--docs");
    } catch (e) {
      fail((e as Error).message);
    }
    const r = await hybridSearch(
      question,
      docs.map((d, i) => ({ id: d.url ?? String(i), title: d.title ?? "", headings: "", body: d.text ?? "" })),
      limit !== undefined ? { limit } : {},
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
    if (v.changed === undefined) exitAfterOutput(EXIT_FAILURE);
    return;
  }

  // A video read once and kept on disk; see src/video/run.ts.
  if (cmd === "video") {
    const action = args.positional[0] ?? "";
    if (!VIDEO_ACTIONS.includes(action)) usage(`usage: webindex video ${VIDEO_ACTIONS.join("|")}`);
    const root = videoRoot(argValue(args, "out"));
    const asJson = argBool(args, "json");

    if (action === "fetch") {
      const url = args.positional[1];
      if (!url) usage("usage: webindex video fetch <url> [--out <dir>] [--lang <tag>] [--refresh] [--json]");
      const r = await fetchVideoRun(url, root, { refresh: argBool(args, "refresh"), lang: argValue(args, "lang") });
      if (!r.ok) {
        if (asJson) process.stdout.write(jsonLine(r));
        fail(`no transcript for ${url}: ${r.reason}`);
      }
      const summary = { ...r, title: r.meta.title, via: r.meta.via, duration: r.meta.duration };
      if (asJson) process.stdout.write(jsonLine(summary));
      else if (isNoWrite()) {
        // Nothing may be written: the transcript itself is the answer, from
        // the run already on disk or from the fetch that just read it.
        process.stdout.write(r.markdown ?? readFileSync(r.transcript, "utf8"));
      } else {
        const m = r.meta;
        const facts = [m.channel, m.duration !== undefined ? formatStamp(m.duration) : undefined, m.via, `${r.segments} segment${r.segments === 1 ? "" : "s"}`]
          .filter(Boolean)
          .join(" · ");
        process.stdout.write(`${r.transcript}\n  ${m.title} — ${facts}${r.reused ? " (already on disk)" : ""}\n`);
      }
      return;
    }

    if (action === "list") {
      const url = args.positional[1];
      if (!url) usage("usage: webindex video list <playlist|channel> [--limit <n>] [--out <dir>] [--refresh] [--json]");
      const r = await fetchVideoCorpus(url, root, {
        limit: argInt(args, "limit", { min: 1 }) ?? 10,
        refresh: argBool(args, "refresh"),
        lang: argValue(args, "lang"),
        onVideo: (done, total, title) => process.stderr.write(`  [${done}/${total}] ${title}\n`),
      });
      if (!r.ok) fail(r.reason);
      if (asJson) process.stdout.write(jsonLine(r));
      else {
        const rows = r.videos.map((v) => `  ${v.label.padEnd(4)}${v.dir ? `${v.via?.padEnd(12)}${v.title}` : `not read — ${v.reason}`}`);
        process.stdout.write(`${r.corpus}\n${rows.join("\n")}\n`);
      }
      if (!r.videos.some((v) => v.dir)) fail("none of the listed videos had a transcript");
      return;
    }

    if (action === "frames") {
      const target = args.positional[1];
      const frameUsage = "usage: webindex video frames <url|id|dir> [--effort low|med|high] [--out <dir>] [--json]";
      if (!target) usage(frameUsage);
      const effort = argValue(args, "effort") ?? "med";
      if (!(effort in FRAME_EFFORT)) usage(`--effort must be low, med or high, not "${effort}"`);
      // A URL is fetched first (or found already on disk); an id names a run
      // under the directory; anything else is a run directory itself.
      let runDir: string;
      if (/^https?:\/\//i.test(target)) {
        const r = await fetchVideoRun(target, root, { lang: argValue(args, "lang") });
        if (!r.ok) fail(`no transcript for ${target}: ${r.reason}`);
        runDir = r.dir;
      } else runDir = existsSync(join(root, target, "meta.json")) ? join(root, target) : resolve(target);
      const r = await extractFrames(runDir, { effort: effort as FrameEffort });
      if (!r.ok) {
        if (asJson) process.stdout.write(jsonLine(r));
        fail(r.reason);
      }
      if (asJson) process.stdout.write(jsonLine(r));
      else {
        const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
        process.stdout.write(
          `${r.markdown}\n  ${n(r.frames.length, "frame")} in ${r.dir} (${n(r.candidates, "candidate")}, ${n(r.duplicates, "near-duplicate")} dropped, effort ${r.effort})\n`,
        );
      }
      return;
    }

    const query = args.positional.slice(1).join(" ").trim();
    if (!query) usage("usage: webindex video search <query> [--out <dir>] [--limit <n>] [--json]");
    const hits = searchVideoRuns(root, query, { limit: argInt(args, "limit", { min: 1 }) ?? 10 });
    if (asJson) process.stdout.write(jsonLine({ dir: root, query, hits }));
    else for (const h of hits) process.stdout.write(`[${h.label} ${h.stamp}] ${h.title}${h.chapter ? ` — ${h.chapter}` : ""}\n  ${h.url}\n  ${h.text}\n\n`);
    if (!hits.length) fail(`nothing under ${root} matches "${query}" — \`webindex video fetch <url>\` reads a video first`);
    return;
  }

  // A real browser, driven one action per call; see src/browser/cli.ts.
  if (cmd === "browser") {
    const action = args.positional[0] ?? "";
    const asJson = argBool(args, "json");
    const { runBrowserCommand } = await import("./browser/cli.js");
    const r = await runBrowserCommand(
      action,
      args.positional.slice(1),
      {
        json: asJson,
        newTab: argBool(args, "new-tab"),
        headless: argBool(args, "headless"),
        profile: argValue(args, "profile"),
        cdp: argValue(args, "cdp"),
        browserKind: argValue(args, "browser-kind"),
        capture: argBool(args, "capture"),
        snapshot: argBool(args, "snapshot"),
        markdown: argBool(args, "markdown"),
        interactive: argBool(args, "interactive"),
        maxChars: argInt(args, "max-chars", { min: 1 }),
        confirm: argBool(args, "confirm"),
        submit: argBool(args, "submit"),
        text: argValue(args, "text"),
        gone: argValue(args, "gone"),
        selector: argValue(args, "selector"),
        url: argValue(args, "url"),
        idle: argBool(args, "idle"),
        load: argBool(args, "load"),
        clear: argBool(args, "clear"),
        ms: argInt(args, "ms", { min: 0 }),
        timeout: argTimeout(args),
        full: argBool(args, "full"),
        out: argValue(args, "out"),
        all: argBool(args, "all"),
        force: argBool(args, "force"),
      },
      {
        // A UsageError, not usage(): runBrowserCommand turns it into exit 2 with its JSON.
        stdin: () => {
          if (process.stdin.isTTY) throw new UsageError("usage: webindex browser eval <expr|-> — `-` reads the expression from a pipe, not a terminal");
          return readFileSync(0, "utf8");
        },
      },
    );
    if (r.exitCode === 0 || r.exitCode === EXIT_HUMAN) {
      process.stdout.write(asJson ? jsonLine(r.json) : `${r.text}\n`);
      // Done, and the page is a blocking challenge: the result is printed as on success, the code says a human is needed.
      if (r.exitCode === EXIT_HUMAN) exitAfterOutput(EXIT_HUMAN);
      return;
    }
    if (asJson) process.stdout.write(jsonLine(r.json));
    process.stderr.write(`webindex: ${r.text}\n`);
    exitAfterOutput(r.exitCode === EXIT_USAGE ? EXIT_USAGE : EXIT_FAILURE);
    return;
  }

  // The packaging toolchain for a repo built ON this engine. Dev-time: it reads
  // a repository, it never runs inside one — which is exactly why it can serve
  // the skills that do not vendor this engine at all.
  if (cmd === "skill") {
    const action = args.positional[0] ?? "";
    const root = resolve(argValue(args, "root") ?? process.cwd());
    const asJson = argBool(args, "json");
    // Before skill.json is read: with none on disk, a missing or misspelt
    // action was answered "no readable skill.json" — the wrong problem, exit 1.
    if (!SKILL_ACTIONS.includes(action)) usage(`usage: webindex skill ${SKILL_ACTIONS.join("|")}`);

    if (action === "init") {
      const name = args.positional[1];
      if (!name) usage("usage: webindex skill init <name> [--root <dir>]");
      const badName = skillNameProblem(name);
      if (badName) usage(badName);
      const r = scaffoldSkill(root, name, { exists: existsSync });
      for (const e of r.errors) process.stderr.write(`  ${e}\n`);
      if (asJson) process.stdout.write(jsonLine(r));
      else if (r.written.length) process.stdout.write(`${r.written.map((p) => `  wrote ${relative(root, p)}`).join("\n")}\n`);
      if (!r.written.length) exitAfterOutput(EXIT_FAILURE);
      return;
    }

    const { config, errors: configErrors } = readSkillConfig(root);
    if (!config) {
      for (const e of configErrors) process.stderr.write(`webindex: ${e}\n`);
      process.exit(EXIT_FAILURE);
    }

    if (action === "recall") {
      // With no policy nothing is compared, and "preserved" would claim a
      // check that never ran.
      if (!recallPolicy(root)) {
        process.stdout.write("No repin.recall policy in skill.json — no artifact was compared.\n");
        return;
      }
      const lost = checkArtifactRecall(root, argValue(args, "ref") ?? "HEAD");
      if (lost.length) fail(lost.join("\n"));
      process.stdout.write("Artifact identities and evidence preserved\n");
      return;
    }
    // Both drive `gh` throughout; without it they died on "spawnSync gh ENOENT".
    if ((action === "finish" || action === "repin") && !have("gh")) {
      fail(`skill ${action} drives the GitHub CLI (gh), which is not installed — install it and authenticate (gh auth login, or GH_TOKEN in CI).`);
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
        if (statuses.some((s) => !s.ok)) exitAfterOutput(EXIT_FAILURE);
        return;
      }
      const ref = argValue(args, "ref");
      if (!ref) usage("usage: webindex skill vendor [--engine <name>] --ref <tag>   |   webindex skill vendor --check");
      // vendorEngine refuses this too, but only after the tag was resolved —
      // which asked GitHub about a ref that could never be pinned.
      if (!/^v\d+\.\d+\.\d+$/.test(ref)) usage(`--ref expects a stable release tag like v1.2.3, got "${ref}"`);
      const only = argValue(args, "engine");
      const names = only ? [only] : Object.keys(config.engines);
      const fetchFile = async (url: string) => {
        const res = await httpGet(url, { binary: true, maxBytes: 64 * 1024 * 1024 });
        return res.ok ? res.bytes : undefined;
      };
      for (const n of names) {
        const pin = config.engines[n];
        const r = await vendorEngine(root, config, n, ref, fetchFile, pin ? await tagCommit(pin.repo, ref) : undefined);
        for (const w of r.written) process.stdout.write(`  wrote ${relative(root, w)}\n`);
        if (r.errors.length) {
          for (const e of r.errors) process.stderr.write(`webindex: ${e}\n`);
          exitAfterOutput(EXIT_FAILURE);
          return;
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
      if (failedAny) exitAfterOutput(EXIT_FAILURE);
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
        exitAfterOutput(EXIT_FAILURE);
        return;
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
    const [fc, sxUp, olUp, qdUp, inspectorCache, anydocCache, ocr, ytdlp] = await Promise.all([
      base ? probeFirecrawl(base) : false,
      sx ? probeSearxng(sx, searxngIsExplicit()) : false,
      probeOllama(ol),
      probeQdrant(qd),
      cacheState("pdf-inspector", PDF_INSPECTOR_SPEC),
      cacheState("anydoc", ANYDOC_SPEC),
      ocrTools(),
      ytdlpVersionAge(videoDeps().run),
    ]);
    const off = (s: string) => s.toLowerCase() === "off";
    // yt-dlp breaks when YouTube changes and is fixed within days, so its age
    // is the first thing to check when videos stop reading.
    const ytdlpStale = (ytdlp?.ageDays ?? 0) > YTDLP_STALE_DAYS;
    const ytdlpState = ytdlp
      ? `yt-dlp ${ytdlp.version}${ytdlp.ageDays !== undefined ? ` (${ytdlp.ageDays} days old${ytdlpStale ? " — update it: `yt-dlp -U`, or your package manager" : ""})` : ""}`
      : "";
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
      if (id === "manual-subs" || id === "auto-subs") return ytdlp ? ytdlpState : "yt-dlp not installed";
      if (id === "whisper") {
        if (!ytdlp) return "yt-dlp not installed";
        if (whisperBudgetLeft() <= 0) return `off (${envName("WHISPER_MAX")}=${env("WHISPER_MAX")})`;
        const tools = { uvx: videoDeps().have("uvx"), ffmpeg: videoDeps().have("ffmpeg") };
        return tools.uvx && tools.ffmpeg
          ? `available (model ${whisperModel()})`
          : `unavailable (uvx: ${tools.uvx ? "yes" : "no"}, ffmpeg: ${tools.ffmpeg ? "yes" : "no"})`;
      }
      return "built-in";
    };
    // The ladder in the order it runs, then the rungs the environment switched
    // off, with the variable that did it. An engine list is to blame only when
    // the ladder honoured it: one naming no known rung is warned about and
    // ignored, and then NO_NPX is what took the npx rungs away.
    const rungRows = (all: readonly string[], enabled: readonly string[], engineVar: string) => {
      const honoured = enginesFromEnv(engineVar, all) !== undefined;
      const why = honoured ? `${envName(engineVar)}=${env(engineVar)!.trim()}` : envName("NO_NPX");
      return [
        ...enabled.map((id) => ({ id, enabled: true, state: rungState(id) })),
        ...all.filter((id) => !enabled.includes(id)).map((id) => ({ id, enabled: false, state: `off (${why})` })),
      ];
    };
    const pdf = rungRows(PDF_EXTRACTORS, pdfRungs, "PDF_ENGINE");
    const doc = rungRows(DOC_EXTRACTORS, docRungs, "DOC_ENGINE");
    const video = rungRows(VIDEO_TRANSCRIBERS, enabledTranscribers(), "VIDEO_ENGINES");
    const browser = await browserDoctor();
    if (argBool(args, "json")) {
      const service = (base: string | null | undefined, up: boolean, extra: Record<string, string> = {}) =>
        base ? { state: up ? "answering" : "unreachable", base, ...(up ? extra : {}) } : { state: "disabled" };
      process.stdout.write(
        jsonLine({
          version: ENGINE_VERSION,
          services: {
            searxng: service(sx, sxUp),
            firecrawl: service(base, fc),
            ollama: service(off(ol) ? undefined : ol, olUp, { model: embedModel() }),
            qdrant: service(off(qd) ? undefined : qd, qdUp),
          },
          rungs: { pdf, doc, video },
          ytdlp: ytdlp ? { ...ytdlp, stale: ytdlpStale } : { state: "not installed" },
          browser,
        }),
      );
      return;
    }
    const rungLines = (label: string, rows: { id: string; state: string }[]) =>
      rows.map(({ id, state }, i) => `  ${(i ? "" : label).padEnd(12)}${id.padEnd(15)}${state}`);
    const bin = browser.binary;
    const sess = browser.session;
    const browserLines = [
      `  browser     ${bin.state === "found" ? `${bin.kind} at ${bin.path}` : bin.state === "error" ? bin.error : `not found — ${bin.hint}`}`,
      `              home ${browser.home}${browser.profiles.length ? ` (profiles: ${browser.profiles.join(", ")})` : ""}`,
      `              session ${sess.state === "none" ? "none" : `port ${sess.port}, profile ${sess.profile}, ${sess.launchedByUs ? "launched by webindex" : "attached"}, ${sess.state === "alive" ? "answering" : "not answering"}`}`,
      `              fetch ${browser.fetch.mode === "off" ? `off (${envName("BROWSER_FETCH")}=always|fallback turns it on)` : browser.fetch.mode}, concurrency ${browser.fetch.concurrency}`,
      ...(browser.kind
        ? [
            `              ${browser.kind.error ? `${envName("BROWSER_KIND")}=${browser.kind.value} is invalid: ${browser.kind.error}` : `launches ${browser.kind.value} (${envName("BROWSER_KIND")})`}`,
          ]
        : []),
      ...(browser.extensions
        ? [
            `              extensions ${browser.extensions.error ?? browser.extensions.paths.join(", ")}`,
            ...(browser.extensions.note ? [`              note: ${browser.extensions.note}`] : []),
          ]
        : []),
    ];
    const lines = [
      `webindex ${ENGINE_VERSION}`,
      `  searxng     ${sx ? (sxUp ? `answering at ${sx}` : `not reachable at ${sx} — \`webindex searxng up\` starts it`) : "disabled"}`,
      `  firecrawl   ${base ? (fc ? `answering at ${base}` : `not reachable at ${base} — the built-in extractor is used instead`) : "disabled"}`,
      `  ollama      ${off(ol) ? "disabled" : olUp ? `answering at ${ol} (model ${embedModel()})` : `not reachable at ${ol} — \`webindex semantic up\` starts it`}`,
      `  qdrant      ${off(qd) ? "disabled" : qdUp ? `answering at ${qd}` : `not reachable at ${qd} — \`webindex semantic up\` starts it`}`,
      ...rungLines("pdf rungs", pdf),
      ...rungLines("doc rungs", doc),
      ...rungLines("video rungs", video),
      ...browserLines,
      "",
      "  Everything optional degrades to a note — nothing above is required, and none of it needs a key.",
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  fail(`unknown command "${cmd}" — run \`webindex --help\``);
}

/**
 * Whether node was started with THIS file, under whatever name it has.
 *
 * isInvokedDirectly() matches the basename against the brand, which covers the
 * installed `webindex`, a Homebrew symlink and an npm shim — but a release
 * asset saved as `webindex-1.20.0.mjs` matched nothing, and running it printed
 * nothing and exited 0. The module's own URL against the started file's real
 * path answers for any name, and is still false when the file is imported.
 */
function isStartedFile(): boolean {
  try {
    return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

// Only when run as a program. Importing this module must not start anything —
// the skill-bundle gate imports the built artifact to read its flag tables.
if (isInvokedDirectly() || isStartedFile()) {
  // A reader that stops early — `webindex extract big.pdf | head -1` — closes
  // the pipe, and the next write fails with EPIPE. That is the reader's answer,
  // not a failure of ours: stop quietly, as `cat` does, rather than end in a
  // Node stack trace printed over the output that was asked for.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e: NodeJS.ErrnoException) => {
      // The code a printed result already set (3, a challenge; 1, no hits) still stands.
      if (e.code === "EPIPE") process.exit(Number(process.exitCode ?? EXIT_OK));
      throw e;
    });
  }
  main().catch((e) => {
    process.stderr.write(`webindex: ${(e as Error).message}\n`);
    process.exit(EXIT_FAILURE);
  });
}
