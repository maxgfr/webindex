#!/usr/bin/env node
// The live check: every command, every MCP tool and every ladder rung, run
// against the real web — real sites, real PDFs and office files, real videos,
// a real browser and the real Docker stack.
//
// Nothing here runs in CI, and that is the point: vitest never touches the
// network, so a site that changed its markup, a registry that moved an
// endpoint or a browser release that renamed a CDP field is invisible to it.
// This is where those surface. A bug found here gets a fixture cut down from
// the real page and a vitest case; this script only says where to look.
//
//   node scripts/live-check.mjs                     every case but docker and browser
//   node scripts/live-check.mjs --area fetch,feed   only those areas
//   node scripts/live-check.mjs --with-docker       the SearXNG/Firecrawl/Ollama cases too
//                                                   (`webindex stack up` first)
//   node scripts/live-check.mjs --with-browser      the Chrome and Brave sequences too
//   node scripts/live-check.mjs --id wiki --jobs 2  cases whose id contains "wiki", two at a time
//
// Each run writes report.md and report.json to .ultraeval/live/<date>/ (or
// --out) and exits non-zero when a case failed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(root, "scripts", "webindex.mjs");

// ── Arguments ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const AREAS = value("area")?.split(",").filter(Boolean);
const ID = value("id");
const WITH_DOCKER = flag("with-docker");
const WITH_BROWSER = flag("with-browser");
const JOBS = Math.max(1, Number(value("jobs") ?? 6));
const KEEP = flag("keep");
const OUT = value("out") ?? join(root, ".ultraeval", "live", new Date().toISOString().slice(0, 10));

// ── Sandbox: nothing this run writes outlives it ─────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "webindex-live-"));
const FIX = join(tmp, "fixtures");
mkdirSync(FIX, { recursive: true });

// Every case starts from the built-in path: no SearXNG, no Firecrawl, no
// Ollama, whatever happens to run on this machine. A docker case turns its
// own backend back on.
const BASE_ENV = {
  ...process.env,
  WEBINDEX_CACHE_DIR: join(tmp, "cache"),
  WEBINDEX_VIDEO_DIR: join(tmp, "video"),
  WEBINDEX_BROWSER_DIR: join(tmp, "browser"),
  WEBINDEX_SEARXNG: "off",
  WEBINDEX_FIRECRAWL: "off",
  WEBINDEX_OLLAMA: "off",
  WEBINDEX_QDRANT: "off",
  NO_COLOR: "1",
};
const STACK_ENV = {
  WEBINDEX_SEARXNG: "http://localhost:8888",
  WEBINDEX_FIRECRAWL: "http://localhost:3002",
  // LIVE_OLLAMA: the stack's Ollama somewhere else, when another program holds :11434.
  WEBINDEX_OLLAMA: process.env.LIVE_OLLAMA ?? "http://localhost:11434",
  WEBINDEX_QDRANT: "http://localhost:6333",
};

// ── Running the CLI ─────────────────────────────────────────────────────────
function run(cmd, argv, { stdin, env, timeout = 60_000, cwd = tmp } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, argv, { cwd, env: { ...BASE_ENV, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Decoded as a stream: a character split across two pipe chunks, each
    // decoded on its own, came out as replacement characters.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? "timeout" : (code ?? signal), stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.on("error", () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
const cli = (argv, opts) => run(process.execPath, [CLI, ...argv], opts);

// ── MCP over stdio: one server, a script of messages, every answer by id ─────
const INIT = (version = "2025-06-18") => ({
  jsonrpc: "2.0",
  id: "init",
  method: "initialize",
  params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "live-check", version: "0" } },
});
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

// Sends `messages` in order; an entry {waitMs} pauses, {waitFor: id} waits for
// that answer. Resolves once every id in `expect` answered, or at the timeout.
function mcpStdio(steps, { expectIds, timeout = 60_000, argv = [], env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [CLI, "mcp", ...argv], { cwd: tmp, env: { ...BASE_ENV, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const answers = new Map();
    const waiters = new Map();
    let buf = "";
    let stderr = "";
    let done = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.stdout.on("data", (d) => {
      buf += d;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          answers.set(`unparsable:${answers.size}`, line);
          continue;
        }
        for (const m of Array.isArray(msg) ? msg : [msg]) {
          if (m.id === undefined) continue;
          answers.set(String(m.id), m);
          waiters.get(String(m.id))?.();
        }
        if (expectIds.every((id) => answers.has(String(id)))) finish();
      }
    });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const alive = child.exitCode === null;
      child.stdin.end();
      child.kill();
      resolve({ answers, stderr, alive, ms: Date.now() - t0 });
    };
    const timer = setTimeout(finish, timeout);
    (async () => {
      for (const s of steps) {
        if (done) return;
        if (s.waitMs) await new Promise((r) => setTimeout(r, s.waitMs));
        else if (s.waitFor !== undefined) {
          if (!answers.has(String(s.waitFor))) await new Promise((r) => waiters.set(String(s.waitFor), r));
        } else child.stdin.write(`${typeof s === "string" ? s : JSON.stringify(s)}\n`);
      }
    })();
  });
}

const toolText = (answer) => (answer?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
const toolOk = (answer) => answer?.result && !answer.result.isError;

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// An HTTP MCP server for the length of `fn`.
async function withHttpServer(argv, fn, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, "mcp", "--transport", "http", "--port", String(port), ...argv], {
    cwd: tmp,
    env: { ...BASE_ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  for (let i = 0; i < 100 && !stderr.includes("listening"); i++) await new Promise((r) => setTimeout(r, 100));
  try {
    return await fn(
      url,
      () => stderr,
      () => child.exitCode === null,
    );
  } finally {
    child.kill();
  }
}
async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

// ── Fixtures fetched once, kept on disk for extract ─────────────────────────
const FIXTURES = {
  "sample.docx": "https://raw.githubusercontent.com/apache/poi/trunk/test-data/document/SampleDoc.docx",
  "sample.xlsx": "https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/SampleSS.xlsx",
  "sample.xls": "https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/SampleSS.xls",
  "sample.pptx": "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/SampleShow.pptx",
  "sample.odt":
    "https://raw.githubusercontent.com/apache/tika/main/tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-miscoffice-module/src/test/resources/test-documents/testODFwithOOo3.odt",
  "sample.csv": "https://raw.githubusercontent.com/datasets/country-codes/main/data/country-codes.csv",
  "scanned.pdf": "https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/skew.pdf",
  "attention.pdf": "https://arxiv.org/pdf/1706.03762",
};
const fixtureErrors = {};
async function loadFixtures(names) {
  await Promise.all(
    names.map(async (name) => {
      const dest = join(FIX, name);
      if (existsSync(dest)) return;
      try {
        const res = await fetch(FIXTURES[name], { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      } catch (e) {
        fixtureErrors[name] = `${FIXTURES[name]}: ${e.message}`;
      }
    }),
  );
}
const fx = (name) => join(FIX, name);

// ── Expectations ────────────────────────────────────────────────────────────
// expect: { code, minChars, mustContain, mustNotContain, startsWith, maxMs, json, check }
// Strings match the combined stdout unless `stream: "stderr"` or "all".
function judge(c, r) {
  const e = c.expect ?? {};
  const why = [];
  const out = e.stream === "stderr" ? r.stderr : e.stream === "all" ? `${r.stdout}\n${r.stderr}` : r.stdout;
  const codes = e.code === undefined ? [0] : [e.code].flat();
  if (r.code !== undefined && !codes.includes(r.code)) why.push(`exit ${r.code}, expected ${codes.join("|")}`);
  if (e.minChars && out.trim().length < e.minChars) why.push(`${out.trim().length} chars, expected ≥ ${e.minChars}`);
  for (const m of [e.mustContain ?? []].flat()) {
    if (!(m instanceof RegExp ? m.test(out) : out.includes(m))) why.push(`missing ${m}`);
  }
  for (const m of [e.mustNotContain ?? []].flat()) {
    if (m instanceof RegExp ? m.test(out) : out.includes(m)) why.push(`unwanted ${m}`);
  }
  if (e.startsWith) {
    const head = out.trimStart();
    const ok = e.startsWith instanceof RegExp ? e.startsWith.test(head.slice(0, 400)) : head.startsWith(e.startsWith);
    if (!ok) why.push(`starts ${JSON.stringify(head.slice(0, 60))}, expected ${e.startsWith}`);
  }
  if (e.maxMs && r.ms > e.maxMs) why.push(`${r.ms} ms, expected ≤ ${e.maxMs}`);
  let parsed;
  if (e.json) {
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      why.push("stdout is not JSON");
    }
  }
  if (e.check) {
    try {
      const msg = e.check(r, parsed);
      if (msg) why.push(msg);
    } catch (err) {
      why.push(`check threw: ${err.message}`);
    }
  }
  if (r.why) why.push(...[r.why].flat());
  return why;
}

// ── The cases ───────────────────────────────────────────────────────────────
const A = (area, id, argv, expect, extra = {}) => ({ area, id, argv, expect, ...extra });
// The TRANSCRIPT.md a `video fetch` names on its first line: stamped, and long enough.
const transcript = (minChars) => (r) => {
  const path = r.stdout.split("\n")[0].trim();
  if (!path.endsWith("TRANSCRIPT.md") || !existsSync(path)) return `no TRANSCRIPT.md named: ${path.slice(0, 120)}`;
  const t = readFileSync(path, "utf8");
  if (!/\[\d\d:\d\d\]/.test(t)) return "transcript has no [mm:ss] stamp";
  if (t.length < minChars) return `transcript ${t.length} chars, expected ≥ ${minChars}`;
};
// Where a U+FFFD sits, so a decoding bug is visible from the report alone.
const noReplacement = (r) => {
  const i = r.stdout.indexOf("\uFFFD");
  return i < 0 ? undefined : `U+FFFD at ${i}: ${JSON.stringify(r.stdout.slice(Math.max(0, i - 40), i + 10))}`;
};

const CASES = [
  // smoke: the binary and its help
  A("smoke", "version", ["version"], { mustContain: /\d+\.\d+\.\d+/ }),
  A("smoke", "help", ["--help"], { mustContain: ["USAGE", "COMMANDS", "ENVIRONMENT"] }),
  A("smoke", "doctor", ["doctor"], { minChars: 200 }),
  A("smoke", "doctor-json", ["doctor", "--json"], { json: true }),
  A("smoke", "unknown-command", ["frobnicate"], { code: 2, stream: "stderr", minChars: 5 }),

  // search: keyless engines
  A("search", "search-en", ["search", "rust borrow checker", "--limit", "5"], { minChars: 200, mustContain: "http" }, { timeout: 90_000 }),
  A(
    "search",
    "search-fr",
    ["search", "impôt sur le revenu barème", "--lang", "fr", "--limit", "5"],
    { minChars: 200, mustContain: "http" },
    { timeout: 90_000 },
  ),
  A(
    "search",
    "search-region",
    ["search", "élections municipales", "--lang", "fr", "--region", "ca", "--limit", "5", "--json"],
    {
      json: true,
      check: (_, j) => (j?.hits?.length ? undefined : "no hits"),
    },
    { timeout: 90_000 },
  ),
  A("search", "search-engine-mojeek", ["search", "postgresql vacuum", "--engine", "mojeek", "--limit", "3"], { mustContain: "http" }, { timeout: 90_000 }),
  A("search", "search-engine-ddglite", ["search", "postgresql vacuum", "--engine", "ddglite", "--limit", "3"], { mustContain: "http" }, { timeout: 90_000 }),
  A("search", "search-short-timeout", ["search", "kubernetes operator pattern", "--timeout", "1", "--json"], {
    code: [0, 1],
    stream: "all",
    mustContain: /reached|timeout|time/i,
  }),
  A(
    "search",
    "search-json-rungs",
    ["search", "sqlite wal mode", "--json", "--limit", "3"],
    {
      json: true,
      check: (_, j) => (j?.hits?.length && "rungs" in j && "searched" in j ? undefined : `hits ${j?.hits?.length}, keys ${Object.keys(j ?? {})}`),
    },
    { timeout: 90_000 },
  ),

  // fetch: HTML pages
  A("fetch", "wiki-en-text", ["fetch", "https://en.wikipedia.org/wiki/Alan_Turing"], {
    minChars: 5000,
    startsWith: /Alan Turing/,
    mustContain: "Bletchley",
    mustNotContain: [/\d+ languages/, "Jump to content"],
  }),
  A("fetch", "wiki-en-md", ["fetch", "https://en.wikipedia.org/wiki/Alan_Turing", "--format", "markdown"], {
    minChars: 5000,
    startsWith: /#|Alan Turing/,
    mustContain: "Bletchley",
    mustNotContain: [/\d+ languages/, "[Afrikaans]"],
  }),
  A("fetch", "wiki-fr-text", ["fetch", "https://fr.wikipedia.org/wiki/Victor_Hugo"], {
    minChars: 5000,
    mustContain: "Misérables",
    mustNotContain: [/\d+ langues/, /\d+ languages/],
  }),
  A("fetch", "wiki-fr-md", ["fetch", "https://fr.wikipedia.org/wiki/Victor_Hugo", "--format", "markdown"], {
    minChars: 5000,
    mustContain: "Misérables",
    mustNotContain: [/\d+ langues/, "[English]"],
  }),
  A("fetch", "mdn", ["fetch", "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map"], {
    minChars: 1500,
    mustContain: ["callbackFn", "map()"],
  }),
  A("fetch", "bbc", ["fetch", "https://www.bbc.com/news"], { minChars: 500 }),
  A("fetch", "lemonde", ["fetch", "https://www.lemonde.fr/"], { minChars: 500 }),
  A("fetch", "hn", ["fetch", "https://news.ycombinator.com/"], {
    minChars: 1000,
    mustNotContain: [/Hacker Newsnew/, /newpast/, /pastcomments/],
  }),
  A("fetch", "hn-md", ["fetch", "https://news.ycombinator.com/", "--format", "markdown"], {
    minChars: 1000,
    mustNotContain: [/\)\[/],
  }),
  A("fetch", "github-readme", ["fetch", "https://github.com/maxgfr/webindex"], { minChars: 1000, mustContain: "webindex" }),
  A("fetch", "github-blob", ["fetch", "https://github.com/maxgfr/webindex/blob/main/README.md"], {
    minChars: 1000,
    mustContain: "webindex",
    mustNotContain: ["Copy path", "More file actions", "Blame"],
  }),
  A("fetch", "github-blob-code", ["fetch", "https://github.com/maxgfr/webindex/blob/main/src/brand.ts"], {
    minChars: 200,
    mustContain: "export",
    mustNotContain: ["Copy path", "More file actions"],
  }),
  A(
    "fetch",
    "shift-jis",
    ["fetch", "https://www.aozora.gr.jp/cards/000148/files/773_14560.html"],
    {
      minChars: 1000,
      mustContain: "こころ",
      check: noReplacement,
    },
    { timeout: 90_000 },
  ),
  A("fetch", "rfc-txt", ["fetch", "https://www.rfc-editor.org/rfc/rfc9110.txt"], {
    minChars: 10000,
    startsWith: /^[^\n]/,
    mustContain: "HTTP Semantics",
    check: (r) => (/^\s*\n/.test(r.stdout) ? "leading blank lines" : undefined),
  }),
  A("fetch", "redirect", ["fetch", "http://github.com/maxgfr/webindex", "--json"], {
    json: true,
    check: (_, j) => {
      const d = Array.isArray(j) ? j[0] : j;
      return d?.finalUrl?.startsWith("https://") ? undefined : `finalUrl ${d?.finalUrl}`;
    },
  }),
  A("fetch", "404", ["fetch", "https://httpbin.org/status/404"], { code: 1, stream: "stderr", mustContain: "404" }),
  A("fetch", "429", ["fetch", "https://httpbin.org/status/429"], { code: 1, stream: "stderr", mustContain: "429" }),
  A("fetch", "multi", ["fetch", "https://example.com/", "https://www.iana.org/help/example-domains"], {
    mustContain: ["==> https://example.com/ <==", "==> https://www.iana.org/help/example-domains <=="],
  }),
  A("fetch", "multi-json", ["fetch", "https://example.com/", "https://www.iana.org/help/example-domains", "--json"], {
    json: true,
    check: (_, j) => (Array.isArray(j) && j.length === 2 ? undefined : "expected a 2-item array"),
  }),
  A("fetch", "multi-one-bad", ["fetch", "https://example.com/", "https://httpbin.org/status/404"], {
    code: 0,
    mustContain: "documentation examples",
  }),
  A("fetch", "full-page", ["fetch", "https://example.com/", "--full-page"], { mustContain: "documentation examples" }),
  A("fetch", "fetch-lang", ["fetch", "https://www.wikipedia.org/", "--lang", "fr"], { minChars: 200 }),
  A("fetch", "fetch-timeout", ["fetch", "https://httpbin.org/delay/10", "--timeout", "1500"], {
    code: 1,
    maxMs: 8000,
    stream: "stderr",
    minChars: 5,
  }),
  A("fetch", "feed-as-page", ["fetch", "https://hnrss.org/frontpage"], { minChars: 200 }),
  A("fetch", "image-note", ["fetch", "https://www.w3.org/Icons/w3c_home.png"], { code: [0, 1], stream: "all", mustContain: /image/i }),

  // fetch: the cache
  {
    area: "cache",
    id: "cache-roundtrip",
    timeout: 120_000,
    run: async () => {
      const env = { WEBINDEX_CACHE_DIR: join(tmp, "cache-rt") };
      const url = "https://www.rfc-editor.org/rfc/rfc2616.txt";
      const a = await cli(["fetch", url, "--cache", "--json"], { env });
      const b = await cli(["fetch", url, "--cache", "--json"], { env });
      const off = await cli(["fetch", url, "--offline", "--json"], { env });
      // Stale on purpose: a zero TTL forces the conditional GET.
      const reval = await cli(["fetch", url, "--cache", "--json"], { env: { ...env, WEBINDEX_CACHE_TTL_HOURS: "0" } });
      const refresh = await cli(["fetch", url, "--refresh", "--json"], { env });
      const miss = await cli(["fetch", "https://example.org/never-cached", "--offline"], { env });
      const status = await cli(["cache", "status", "--json"], { env });
      const clean = await cli(["cache", "clean", "--all", "--json"], { env });
      const parse = (r) => {
        try {
          const j = JSON.parse(r.stdout);
          return Array.isArray(j) ? j[0] : j;
        } catch {
          return undefined;
        }
      };
      const why = [];
      if (parse(a)?.cached) why.push("first read claims cached");
      if (!parse(b)?.cached) why.push("second read not cached");
      if (!parse(off)?.cached) why.push(`offline read failed: ${off.stderr.slice(0, 200)}`);
      if (reval.code !== 0) why.push(`revalidation exit ${reval.code}: ${reval.stderr.slice(0, 200)}`);
      if (parse(refresh)?.cached) why.push("refresh served the cache");
      if (miss.code === 0) why.push("offline miss succeeded");
      if (status.code !== 0) why.push("cache status failed");
      if (clean.code !== 0) why.push("cache clean failed");
      return {
        code: 0,
        stdout: [a, b, off, reval, refresh, status, clean].map((r) => r.stdout.slice(0, 200)).join("\n---\n"),
        stderr: [reval.stderr, miss.stderr].join("\n"),
        ms: 0,
        why,
      };
    },
  },

  // documents: PDF ladder rung by rung, office formats, local files, stdin
  // The built-in rung has no font tables: on a TeX paper its ligatures are
  // control codes, and it must say so rather than print them.
  A(
    "pdf",
    "pdf-native-honest",
    ["fetch", "https://arxiv.org/pdf/1706.03762"],
    { code: 1, stream: "stderr", mustContain: /could not extract|undecodable/ },
    { env: { WEBINDEX_PDF_ENGINE: "native" } },
  ),
  A(
    "pdf",
    "pdf-native-simple",
    // (w3.org's dummy.pdf answers a browser User-Agent from a script with 403.)
    ["fetch", "https://pdfobject.com/pdf/sample.pdf"],
    { mustContain: "simple PDF" },
    { env: { WEBINDEX_PDF_ENGINE: "native" } },
  ),
  ...["pdf-inspector", "anydoc", "pdftotext"].map((rung) =>
    A(
      "pdf",
      `pdf-${rung}`,
      ["fetch", "https://arxiv.org/pdf/1706.03762", "--json"],
      {
        json: true,
        check: (_, j) => {
          const d = Array.isArray(j) ? j[0] : j;
          if (!d?.text || d.text.length < 20000) return `text ${d?.text?.length ?? 0} chars`;
          if (!/attention/i.test(d.text)) return "no 'attention' in text";
        },
      },
      { env: { WEBINDEX_PDF_ENGINE: rung }, timeout: 240_000 },
    ),
  ),
  A(
    "pdf",
    "pdf-ocr-scanned",
    ["extract", "{fx:scanned.pdf}"],
    { minChars: 200 },
    { env: { WEBINDEX_PDF_ENGINE: "native,ocr" }, timeout: 400_000, fixtures: ["scanned.pdf"] },
  ),
  A(
    "pdf",
    "pdf-local",
    ["extract", "{fx:attention.pdf}"],
    { minChars: 20000, mustContain: /attention/i },
    { env: { WEBINDEX_PDF_ENGINE: "pdftotext" }, fixtures: ["attention.pdf"] },
  ),
  A(
    "pdf",
    "pdf-stdin",
    ["extract", "-"],
    { minChars: 20000 },
    { env: { WEBINDEX_PDF_ENGINE: "pdftotext" }, stdinFixture: "attention.pdf", fixtures: ["attention.pdf"] },
  ),
  A("pdf", "pdf-default-ladder", ["fetch", "https://arxiv.org/pdf/1706.03762"], { minChars: 20000, mustContain: /attention/i }, { timeout: 240_000 }),
  ...[
    ["docx", /\w{4}/],
    ["xlsx", /\w{4}/],
    ["xls", /\w{3}/],
    ["pptx", /\w{4}/],
    ["odt", /\w{4}/],
  ].map(([ext, re]) =>
    A("docs", `extract-${ext}`, ["extract", `{fx:sample.${ext}}`], { minChars: 20, mustContain: re }, { fixtures: [`sample.${ext}`], timeout: 180_000 }),
  ),
  ...["docx", "xlsx", "pptx"].map((ext) =>
    A("docs", `builtin-${ext}`, ["extract", `{fx:sample.${ext}}`], { minChars: 20 }, { env: { WEBINDEX_DOC_ENGINE: "builtin" }, fixtures: [`sample.${ext}`] }),
  ),
  A("docs", "extract-csv", ["extract", "{fx:sample.csv}"], { minChars: 1000, mustContain: "France" }, { fixtures: ["sample.csv"] }),
  A("docs", "fetch-docx-url", ["fetch", FIXTURES["sample.docx"]], { minChars: 20 }, { env: { WEBINDEX_DOC_ENGINE: "builtin" } }),
  A("docs", "fetch-xlsx-url", ["fetch", FIXTURES["sample.xlsx"]], { minChars: 20 }, { env: { WEBINDEX_DOC_ENGINE: "builtin" } }),
  A(
    "docs",
    "extract-html-stdin",
    ["extract", "-"],
    { mustContain: "Hello world" },
    { stdin: "<html><head><title>T</title></head><body><main><h1>Hello world</h1><p>Some prose here.</p></main></body></html>" },
  ),
  A(
    "docs",
    "extract-html-md-stdin",
    ["extract", "-", "--format", "markdown"],
    { mustContain: "# Hello world" },
    { stdin: "<html><body><main><h1>Hello world</h1><p>Some <a href='https://a.test/x'>link</a>.</p></main></body></html>" },
  ),
  A("docs", "extract-missing", ["extract", "/nonexistent/file.pdf"], { code: 1, stream: "stderr", minChars: 5 }),

  // code hosts and registries
  A("forge", "repo-github", ["repo", "maxgfr/webindex"], { mustContain: ["maxgfr/webindex", /MIT/i] }),
  A("forge", "repo-github-url", ["repo", "https://github.com/nodejs/node"], { mustContain: "node" }),
  A("forge", "repo-gitlab", ["repo", "https://gitlab.com/gitlab-org/gitlab-runner"], { mustContain: "gitlab-runner" }),
  A("forge", "repo-codeberg", ["repo", "https://codeberg.org/forgejo/forgejo", "--forge", "gitea"], { mustContain: "forgejo" }),
  A("forge", "issues-github", ["issues", "nodejs/node", "--terms", "fetch timeout", "--limit", "3"], { minChars: 50 }),
  A("forge", "prs-github", ["prs", "nodejs/node", "--terms", "stream", "--limit", "3"], { minChars: 50 }),
  A("forge", "issues-gitlab", ["issues", "https://gitlab.com/gitlab-org/gitlab-runner", "--terms", "docker", "--limit", "3"], { minChars: 50 }),
  A("forge", "issues-codeberg", ["issues", "https://codeberg.org/forgejo/forgejo", "--forge", "gitea", "--terms", "migration", "--limit", "3"], {
    minChars: 50,
  }),
  A("forge", "releases-github", ["releases", "nodejs/node", "--limit", "2"], { mustContain: /v\d+/ }),
  A("forge", "releases-gitlab", ["releases", "https://gitlab.com/gitlab-org/gitlab-runner", "--limit", "2"], { mustContain: /v?\d+\.\d+/ }),
  A("forge", "releases-codeberg", ["releases", "https://codeberg.org/forgejo/forgejo", "--forge", "gitea", "--limit", "2"], { mustContain: /v?\d+\.\d+/ }),
  A("forge", "tags-github", ["tags", "maxgfr/webindex", "--limit", "3"], { mustContain: /v?\d+\.\d+/ }),
  A("forge", "tags-gitlab", ["tags", "https://gitlab.com/gitlab-org/gitlab-runner", "--limit", "3"], { mustContain: /v?\d+\.\d+/ }),
  A("forge", "repo-json", ["repo", "maxgfr/webindex", "--json"], { json: true }),
  A("registry", "package-npm", ["package", "vitest"], { mustContain: ["vitest", /\d+\.\d+\.\d+/] }),
  A("registry", "package-npm-version", ["package", "vitest", "--version", "1.0.0"], { mustContain: "1.0.0" }),
  A("registry", "package-npm-prefix", ["package", "npm:vitest"], { mustContain: "vitest" }),
  A("registry", "package-pypi", ["package", "requests", "--registry", "pypi"], { mustContain: "requests" }),
  A("registry", "package-pypi-prefix", ["package", "pypi:requests"], { mustContain: "requests" }),
  A("registry", "package-pypi-version", ["package", "requests", "--registry", "pypi", "--version", "2.31.0"], { mustContain: "2.31.0" }),
  A("registry", "package-crates", ["package", "serde", "--registry", "crates"], { mustContain: "serde" }),
  A("registry", "package-crates-prefix", ["package", "crates:serde"], { mustContain: "serde" }),
  A("registry", "package-crates-version", ["package", "serde", "--registry", "crates", "--version", "1.0.100"], { mustContain: "1.0.100" }),
  A("registry", "package-prefix-conflict", ["package", "npm:vitest", "--registry", "pypi"], { code: 2, stream: "stderr", minChars: 5 }),
  A("registry", "package-missing", ["package", "this-package-does-not-exist-xyz-123"], { code: 1, stream: "all", minChars: 5 }),

  // what the web says about itself
  A("web", "meta", ["meta", "https://www.bbc.com/news", "--json"], { json: true, mustContain: /og|title/i }),
  A("web", "meta-wiki", ["meta", "https://en.wikipedia.org/wiki/Alan_Turing"], { mustContain: "Turing" }),
  A("web", "robots-allowed", ["robots", "https://en.wikipedia.org/wiki/Alan_Turing"], { code: 0 }),
  A("web", "robots-denied", ["robots", "https://www.google.com/search?q=x"], { code: 1 }),
  A("web", "sitemap-index", ["sitemap", "https://developer.mozilla.org/", "--max", "2"], { minChars: 200, mustContain: "https://" }, { timeout: 120_000 }),
  A("web", "sitemap-json", ["sitemap", "https://www.sitemaps.org/", "--json"], { json: true, mustContain: "protocol.html" }),
  A("web", "feed-rss", ["feed", "https://hnrss.org/frontpage"], { minChars: 200, mustContain: "http" }),
  A("web", "feed-atom", ["feed", "https://github.com/nodejs/node/releases.atom"], { minChars: 100, mustContain: /v\d+/ }),
  A("web", "feed-json", ["feed", "https://www.jsonfeed.org/feed.json"], { minChars: 100, mustContain: "http" }),
  A("web", "feed-discover", ["feed", "https://blog.rust-lang.org/"], { minChars: 100, mustContain: "http" }),
  A("web", "tables", ["tables", "https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population", "--json"], {
    json: true,
    check: (_, j) => (JSON.stringify(j).includes("India") ? undefined : "no India in tables"),
  }),
  A("web", "tables-md", ["tables", "https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population", "--markdown"], { mustContain: "| " }),
  {
    area: "web",
    id: "changed-roundtrip",
    run: async () => {
      const url = "https://www.rfc-editor.org/rfc/rfc9110.txt";
      const base = await cli(["changed", url, "--json"]);
      let fp;
      try {
        fp = JSON.parse(base.stdout);
      } catch {}
      const f = fp?.fingerprint ?? fp;
      const why = [];
      if (!f?.contentHash) why.push(`no baseline hash: ${base.stdout.slice(0, 200)} ${base.stderr.slice(0, 200)}`);
      const byHash = f?.contentHash ? await cli(["changed", url, "--hash", f.contentHash, "--json"]) : undefined;
      const byEtag = f?.etag ? await cli(["changed", url, "--etag", f.etag, "--json"]) : undefined;
      const stale = await cli(["changed", url, "--hash", "0".repeat(64), "--json"]);
      const verdict = (r) => {
        try {
          return JSON.parse(r.stdout);
        } catch {
          return undefined;
        }
      };
      if (byHash && verdict(byHash)?.changed !== false) why.push(`same hash reported changed: ${byHash.stdout.slice(0, 200)}`);
      if (byEtag && verdict(byEtag)?.changed !== false) why.push(`same etag reported changed: ${byEtag.stdout.slice(0, 200)}`);
      if (verdict(stale)?.changed !== true) why.push(`other hash not reported changed: ${stale.stdout.slice(0, 200)}`);
      return { code: 0, stdout: [base, byHash, byEtag, stale].map((r) => r?.stdout.slice(0, 300) ?? "").join("\n---\n"), stderr: "", ms: 0, why };
    },
  },

  // crawl
  A(
    "crawl",
    "crawl-max",
    ["crawl", "https://quotes.toscrape.com/", "--max", "4", "--json"],
    {
      json: true,
      check: (_, j) => {
        const pages = j?.pages ?? j;
        return Array.isArray(pages) && pages.length >= 1 && pages.length <= 4 ? undefined : `pages ${pages?.length}`;
      },
    },
    { timeout: 120_000 },
  ),
  A(
    "crawl",
    "crawl-depth0",
    ["crawl", "https://quotes.toscrape.com/", "--max", "5", "--depth", "0", "--no-sitemap", "--json"],
    {
      json: true,
      check: (_, j) => {
        const pages = j?.pages ?? j;
        return Array.isArray(pages) && pages.length === 1 ? undefined : `depth 0 gave ${pages?.length} pages`;
      },
    },
    { timeout: 120_000 },
  ),
  A(
    "crawl",
    "crawl-prefix",
    ["crawl", "https://quotes.toscrape.com/", "--max", "3", "--prefix", "/tag/", "--no-sitemap"],
    { code: [0, 1], stream: "all", minChars: 10 },
    { timeout: 120_000 },
  ),
  A(
    "crawl",
    "crawl-robots",
    ["crawl", "https://www.google.com/search?q=x", "--max", "2"],
    { code: [0, 1], stream: "all", mustContain: /robots|disallow/i },
    { timeout: 60_000 },
  ),
  A("crawl", "crawl-no-max", ["crawl", "https://quotes.toscrape.com/"], { code: 2, stream: "stderr", mustContain: "--max" }),

  // ranking on documents really fetched
  {
    area: "rank",
    id: "rank-real",
    timeout: 120_000,
    run: async () => {
      const urls = ["https://en.wikipedia.org/wiki/Alan_Turing", "https://en.wikipedia.org/wiki/Enigma_machine", "https://en.wikipedia.org/wiki/Banana"];
      const f = await cli(["fetch", ...urls, "--json"], { timeout: 90_000 });
      let docs;
      try {
        docs = JSON.parse(f.stdout).map((d) => ({ url: d.url, title: d.title, text: d.text }));
      } catch {
        return { code: 1, stdout: f.stdout, stderr: f.stderr, ms: f.ms, why: "fetch --json failed" };
      }
      const r = await cli(["rank", "--query", "who broke the enigma cipher", "--json"], { stdin: JSON.stringify(docs) });
      let top;
      try {
        const j = JSON.parse(r.stdout);
        top = j.ranked?.[0]?.url;
      } catch {}
      const why = /Enigma|Turing/.test(top ?? "") ? [] : [`top result ${top}`];
      const plain = await cli(["rank", "--query", "banana plantation", "--limit", "1"], { stdin: JSON.stringify(docs) });
      if (!plain.stdout.includes("Banana")) why.push("banana query did not rank Banana first");
      return { code: r.code, stdout: `${r.stdout.slice(0, 400)}\n---\n${plain.stdout.slice(0, 200)}`, stderr: r.stderr, ms: r.ms, why };
    },
  },
  A(
    "rank",
    "rank-no-terms",
    ["rank", "--query", "zzzqqq xxyyzz"],
    { code: [0, 1], stream: "all", mustContain: /no document|term/i },
    { stdin: JSON.stringify([{ url: "https://a.test", title: "A", text: "hello world" }]) },
  ),
  A(
    "rank",
    "hybrid-no-ollama",
    ["hybrid", "--query", "hello"],
    { code: [0], stream: "all", mustContain: /lexical|embedding|BM25/i },
    { stdin: JSON.stringify([{ url: "https://a.test", title: "A", text: "hello world" }]) },
  ),
  A("rank", "embed-no-ollama", ["embed", "hello"], { code: 1, stream: "stderr", mustContain: /semantic up|Ollama|embedding/i }),

  // video: `video fetch` prints where TRANSCRIPT.md is and which rung made it
  A(
    "video",
    "yt-manual-subs",
    ["video", "fetch", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    { mustContain: "manual-subs", check: transcript(400) },
    { env: { WEBINDEX_VIDEO_ENGINES: "manual-subs" }, timeout: 180_000 },
  ),
  A(
    "video",
    "yt-auto-subs",
    ["video", "fetch", "https://www.youtube.com/watch?v=aircAruvnKk", "--refresh"],
    { mustContain: "auto-subs", check: transcript(2000) },
    { env: { WEBINDEX_VIDEO_ENGINES: "auto-subs" }, timeout: 180_000 },
  ),
  A("video", "yt-fetch-cmd", ["fetch", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"], { minChars: 400, mustContain: /\[\d\d:\d\d\]/ }, { timeout: 180_000 }),
  A("video", "vimeo", ["video", "fetch", "https://vimeo.com/76979871"], { stream: "all", check: transcript(200) }, { timeout: 240_000 }),
  A(
    "video",
    "dailymotion",
    ["video", "fetch", "https://www.dailymotion.com/video/x8j7y6k"],
    { code: [0, 1], stream: "all", minChars: 20 },
    { timeout: 240_000 },
  ),
  // yt-dlp's own TED extractor fails on this page (an upstream bug, reproduced
  // with yt-dlp alone): the run must say so, not hang or print nothing.
  A(
    "video",
    "ted",
    ["video", "fetch", "https://www.ted.com/talks/ken_robinson_do_schools_kill_creativity"],
    { code: [0, 1], stream: "all", mustContain: /TRANSCRIPT\.md|yt-dlp failed/ },
    { timeout: 240_000 },
  ),
  A(
    "video",
    "whisper",
    ["video", "fetch", "https://www.youtube.com/watch?v=jNQXAC9IVRw", "--refresh", "--out", "{tmp}/video-whisper"],
    { mustContain: "whisper", check: transcript(20) },
    {
      env: { WEBINDEX_VIDEO_ENGINES: "whisper", WEBINDEX_WHISPER_MODEL: "tiny" },
      timeout: 900_000,
    },
  ),
  A(
    "video",
    "list-playlist",
    ["video", "list", "https://www.youtube.com/playlist?list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi", "--limit", "2", "--out", "{tmp}/video-list"],
    { mustContain: ["V1", "V2"] },
    { timeout: 400_000 },
  ),
  {
    area: "video",
    id: "video-search-frames",
    timeout: 900_000,
    run: async () => {
      const out = join(tmp, "video-frames");
      const url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
      const f = await cli(["video", "fetch", url, "--out", out], { timeout: 300_000, env: { WEBINDEX_WHISPER_MODEL: "tiny" } });
      const s = await cli(["video", "search", "elephants", "--out", out, "--json"]);
      const why = [];
      if (f.code !== 0) why.push(`fetch exit ${f.code}: ${f.stderr.slice(-300)}`);
      if (s.code !== 0 || !/elephant/i.test(s.stdout)) why.push(`search: ${s.stdout.slice(0, 200)} ${s.stderr.slice(-200)}`);
      const frames = {};
      for (const effort of ["low", "med", "high"]) {
        const r = await cli(["video", "frames", url, "--effort", effort, "--out", out, "--json"], { timeout: 300_000 });
        frames[effort] = r;
        if (r.code !== 0) why.push(`frames ${effort} exit ${r.code}: ${r.stderr.slice(-300)}`);
      }
      const leftovers = existsSync(join(out, "jNQXAC9IVRw", "frames.new"));
      if (leftovers) why.push("frames.new left behind");
      return { code: 0, stdout: [f, s, frames.low, frames.med, frames.high].map((r) => r.stdout.slice(0, 200)).join("\n---\n"), stderr: "", ms: 0, why };
    },
  },
  A("video", "video-bad-effort", ["video", "frames", "x", "--effort", "toString"], { code: 2, stream: "stderr", minChars: 5 }),

  // CLI usage errors
  A("cli", "fetch-no-url", ["fetch"], { code: 2, stream: "stderr", minChars: 5 }),
  A("cli", "fetch-foreign-flag", ["fetch", "https://example.com/", "--markdown"], { code: 2, stream: "stderr", mustContain: "--markdown" }),
  A("cli", "sitemap-foreign-flag", ["sitemap", "https://example.com/", "--limit", "3"], { code: 2, stream: "stderr", mustContain: "--limit" }),
  A("cli", "mcp-port-stdio", ["mcp", "--port", "9999"], { code: 2, stream: "stderr", mustContain: "--transport http" }),
  A("cli", "search-short-flag", ["search", "-x", "rust"], { code: 2, stream: "stderr", minChars: 5 }),
  A("cli", "search-dashdash", ["search", "--limit", "2", "--", "-x rust"], { code: [0, 1], stream: "all", minChars: 5 }, { timeout: 90_000 }),
  A("cli", "unknown-flag", ["fetch", "https://example.com/", "--frobnicate"], { code: 2, stream: "stderr", mustContain: "--frobnicate" }),

  // tooling
  A(
    "tooling",
    "skill-init-check-bundle",
    null,
    {},
    {
      run: async () => {
        const dir = join(tmp, "skill-repo");
        mkdirSync(dir, { recursive: true });
        const init = await cli(["skill", "init", "demo-skill", "--root", dir]);
        const check = await cli(["skill", "check", "--root", join(dir, "demo-skill")]);
        const doctor = await cli(["skill", "doctor", "--root", join(dir, "demo-skill")]);
        const bundle = await cli(["skill", "bundle", "--root", join(dir, "demo-skill"), "--json"]);
        const why = [];
        if (init.code !== 0) why.push(`init exit ${init.code}: ${init.stderr.slice(0, 300)}`);
        for (const [n, r] of Object.entries({ check, doctor, bundle })) if (typeof r.code !== "number") why.push(`${n} ${r.code}`);
        return {
          code: 0,
          stdout: [init, check, doctor, bundle].map((r) => `exit ${r.code}\n${r.stdout.slice(0, 300)}\n${r.stderr.slice(0, 300)}`).join("\n---\n"),
          stderr: "",
          ms: 0,
          why,
        };
      },
    },
  ),
  A("tooling", "cache-status", ["cache", "status"], { minChars: 5 }),
  A("tooling", "stack-path", ["stack", "path"], { mustContain: /compose/ }),

  // library
  {
    area: "lib",
    id: "lib-fetch-search",
    timeout: 120_000,
    run: async () => {
      const code = `
        import { fetchAndExtract, search } from ${JSON.stringify(join(root, "scripts", "engine.mjs"))};
        const d = await fetchAndExtract("https://example.com/");
        const s = await search("example domain iana", { limit: 3 });
        console.log(JSON.stringify({ title: d.title, chars: d.text.length, results: s.hits.length }));
      `;
      const file = join(tmp, "lib-probe.mjs");
      writeFileSync(file, code);
      const r = await run(process.execPath, [file], { timeout: 110_000 });
      let j;
      try {
        j = JSON.parse(r.stdout.trim().split("\n").pop());
      } catch {}
      const why = [];
      if (!j || j.chars < 50) why.push("fetchAndExtract returned nothing");
      if (!j || j.results < 1) why.push("search returned nothing");
      return { ...r, why };
    },
  },

  // MCP over stdio: every tool once
  {
    area: "mcp",
    id: "mcp-stdio-all-tools",
    timeout: 400_000,
    run: async () => {
      const docs = [
        { url: "https://a.test/1", title: "Turing", text: "Alan Turing broke the Enigma cipher at Bletchley Park." },
        { url: "https://a.test/2", title: "Banana", text: "Bananas grow in tropical plantations." },
      ];
      const html = join(tmp, "mcp-page.html");
      writeFileSync(html, "<html><body><main><h1>Local page</h1><p>Read through MCP.</p></main></body></html>");
      const vdir = join(tmp, "mcp-video");
      const tools = [
        ["webindex_search", { query: "sqlite wal", limit: 3 }],
        ["webindex_fetch", { url: "https://example.com/" }],
        ["webindex_extract", { path: html }],
        ["webindex_rank", { question: "who broke enigma", documents: docs }],
        ["webindex_repo", { repo: "maxgfr/webindex" }],
        ["webindex_issues", { repo: "nodejs/node", terms: "fetch", limit: 2 }],
        ["webindex_releases", { repo: "nodejs/node", limit: 1 }],
        ["webindex_tags", { repo: "maxgfr/webindex", limit: 2 }],
        ["webindex_package", { name: "vitest" }],
        ["webindex_meta", { url: "https://en.wikipedia.org/wiki/Alan_Turing" }],
        ["webindex_robots", { url: "https://en.wikipedia.org/wiki/Alan_Turing" }],
        ["webindex_sitemap", { url: "https://www.sitemaps.org/", max: 1 }],
        ["webindex_feed", { url: "https://hnrss.org/frontpage" }],
        ["webindex_tables", { url: "https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population" }],
        ["webindex_embed", { texts: ["hello"] }],
        ["webindex_crawl", { url: "https://quotes.toscrape.com/", max: 2 }],
        ["webindex_video_fetch", { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", dir: vdir }],
        ["webindex_video_search", { query: "elephants", dir: vdir }],
        ["webindex_video_frames", { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", effort: "low", dir: vdir }],
        [
          "webindex_video_list",
          { url: "https://www.youtube.com/playlist?list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi", limit: 1, dir: join(tmp, "mcp-video-list") },
        ],
      ];
      // The video tools depend on each other; the rest run concurrently.
      const steps = [INIT(), INITIALIZED, { jsonrpc: "2.0", id: "list", method: "tools/list" }];
      for (const [name, a] of tools.slice(0, 16)) steps.push(call(name, name, a));
      steps.push(call("webindex_video_fetch", ...tools[16]), { waitFor: "webindex_video_fetch" });
      steps.push(call("webindex_video_search", ...tools[17]), call("webindex_video_frames", ...tools[18]), call("webindex_video_list", ...tools[19]));
      const r = await mcpStdio(steps, { expectIds: ["init", "list", ...tools.map((t) => t[0])], timeout: 390_000, env: { WEBINDEX_WHISPER_MODEL: "tiny" } });
      const why = [];
      const listed = r.answers.get("list")?.result?.tools?.length;
      if (listed !== 20) why.push(`tools/list has ${listed} tools`);
      const lines = [];
      for (const [name] of tools) {
        const a = r.answers.get(name);
        const text = toolText(a);
        // webindex_embed with no Ollama is a tool error that says so; every other tool must succeed.
        const expectedError = name === "webindex_embed";
        if (!a) why.push(`${name}: no answer`);
        else if (expectedError ? !/semantic|ollama|embedding/i.test(text) : !toolOk(a)) why.push(`${name}: ${a.error?.message ?? text.slice(0, 200)}`);
        else if (!expectedError && text.trim().length < 5) why.push(`${name}: empty result`);
        lines.push(`${name}: ${a ? (toolOk(a) ? "ok" : "error") : "none"} ${text.slice(0, 120).replace(/\n/g, " ")}`);
      }
      if (!r.alive) why.push("server exited");
      return { code: 0, stdout: lines.join("\n"), stderr: r.stderr.slice(-2000), ms: r.ms, why };
    },
  },
  {
    area: "mcp",
    id: "mcp-stdio-protocol",
    timeout: 60_000,
    run: async () => {
      const steps = [
        INIT(),
        INITIALIZED,
        call("slow", "webindex_fetch", { url: "https://httpbin.org/delay/10" }),
        { waitMs: 500 },
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow", reason: "live-check" } },
        { jsonrpc: "2.0", id: "ping1", method: "ping" },
        call("bad-tool", "webindex_nope", {}),
        call("bad-args", "webindex_fetch", {}),
        call("bad-file", "webindex_extract", { path: "/nonexistent/x.pdf" }),
        "{not json",
        { jsonrpc: "2.0", id: null, method: "ping" },
        { jsonrpc: "2.0", id: "ping2", method: "ping" },
        { waitMs: 11_000 },
        { jsonrpc: "2.0", id: "ping3", method: "ping" },
      ];
      const r = await mcpStdio(steps, { expectIds: ["init", "ping1", "bad-tool", "bad-args", "bad-file", "ping2", "ping3"], timeout: 30_000 });
      const why = [];
      if (!r.answers.get("ping1")?.result) why.push("no ping after cancel");
      if (r.answers.has("slow") && !r.answers.get("slow").error) why.push("cancelled request still answered with a result");
      if (!r.answers.get("bad-tool")?.error && toolOk(r.answers.get("bad-tool"))) why.push("unknown tool succeeded");
      if (toolOk(r.answers.get("bad-args"))) why.push("missing url succeeded");
      if (toolOk(r.answers.get("bad-file"))) why.push("missing file succeeded");
      if (!r.answers.get("null")?.error) why.push("id:null request got no -32600 answer");
      if (!r.answers.get("ping3")?.result) why.push("server dead after errors");
      return {
        code: 0,
        stdout: [...r.answers].map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 160)}`).join("\n"),
        stderr: r.stderr.slice(-1000),
        ms: r.ms,
        why,
      };
    },
  },
  {
    area: "mcp",
    id: "mcp-http",
    timeout: 120_000,
    run: async () =>
      withHttpServer([], async (url, stderr, alive) => {
        const why = [];
        const log = [];
        const init = await post(url, INIT());
        log.push(`init ${init.status}`);
        if (init.status !== 200 || !init.json?.result) why.push(`initialize ${init.status} ${init.text.slice(0, 200)}`);
        const list = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
        if (list.json?.result?.tools?.length !== 20) why.push(`tools/list ${list.json?.result?.tools?.length}`);
        const fetchCall = await post(url, call(3, "webindex_fetch", { url: "https://example.com/" }));
        if (!toolText(fetchCall.json).includes("Example Domain")) why.push(`fetch over http: ${fetchCall.text.slice(0, 200)}`);
        const evil = await post(url, { jsonrpc: "2.0", id: 4, method: "ping" }, { origin: "https://evil.test" });
        log.push(`evil origin ${evil.status}`);
        if (evil.status !== 403) why.push(`foreign origin got ${evil.status}`);
        const batchNew = await post(url, [{ jsonrpc: "2.0", id: 5, method: "ping" }], { "mcp-protocol-version": "2025-06-18" });
        log.push(`batch 2025-06-18 ${batchNew.status} ${batchNew.text.slice(0, 120)}`);
        if (!/batch/i.test(batchNew.text)) why.push("batch under 2025-06-18 not refused");
        const batchOld = await post(
          url,
          [
            { jsonrpc: "2.0", id: 6, method: "ping" },
            { jsonrpc: "2.0", id: 7, method: "ping" },
          ],
          { "mcp-protocol-version": "2025-03-26" },
        );
        log.push(`batch 2025-03-26 ${batchOld.status} ${batchOld.text.slice(0, 120)}`);
        if (!Array.isArray(batchOld.json) || batchOld.json.length !== 2) why.push("batch under 2025-03-26 not answered as a batch");
        const nullId = await post(url, { jsonrpc: "2.0", id: null, method: "ping" });
        log.push(`id null ${nullId.status} ${nullId.text.slice(0, 120)}`);
        if (nullId.json?.error?.code !== -32600) why.push(`id:null answered ${nullId.status} ${nullId.text.slice(0, 100)}`);
        const garbage = await post(url, "{oops");
        if (garbage.json?.error?.code !== -32700) why.push(`parse error answered ${garbage.text.slice(0, 100)}`);
        const badFile = await post(url, call(8, "webindex_extract", { path: "/nonexistent" }));
        if (toolOk(badFile.json)) why.push("missing file succeeded over http");
        const after = await post(url, { jsonrpc: "2.0", id: 9, method: "ping" });
        if (!after.json?.result) why.push("server not answering after errors");
        if (!alive()) why.push("server exited");
        return { code: 0, stdout: log.join("\n"), stderr: stderr().slice(-1000), ms: 0, why };
      }),
  },
  {
    area: "mcp",
    id: "mcp-http-token",
    timeout: 30_000,
    run: async () =>
      withHttpServer(
        [],
        async (url) => {
          const no = await post(url, INIT());
          const yes = await post(url, INIT(), { authorization: "Bearer s3cret" });
          const why = [];
          if (no.status !== 401) why.push(`no token got ${no.status}`);
          if (yes.status !== 200) why.push(`token got ${yes.status}`);
          return { code: 0, stdout: `${no.status} ${yes.status}`, stderr: "", ms: 0, why };
        },
        { WEBINDEX_MCP_TOKEN: "s3cret" },
      ),
  },
  {
    area: "mcp",
    id: "mcp-public-only",
    timeout: 30_000,
    run: async () => {
      const r = await mcpStdio(
        [
          INIT(),
          INITIALIZED,
          call("local", "webindex_fetch", { url: "http://127.0.0.1:1/" }),
          call("meta", "webindex_fetch", { url: "http://169.254.169.254/latest/meta-data/" }),
        ],
        {
          expectIds: ["init", "local", "meta"],
          argv: ["--public-only"],
          timeout: 25_000,
        },
      );
      const why = [];
      for (const id of ["local", "meta"]) {
        const t = toolText(r.answers.get(id));
        if (toolOk(r.answers.get(id))) why.push(`${id} allowed`);
        else if (!/public|private|loopback|link-local|refus/i.test(t + JSON.stringify(r.answers.get(id)?.error ?? ""))) why.push(`${id}: ${t.slice(0, 100)}`);
      }
      return { code: 0, stdout: [...r.answers].map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 200)}`).join("\n"), stderr: "", ms: r.ms, why };
    },
  },
];

// ── Docker cases: the stack has to be up (`webindex stack up`) ──────────────
const DOCKER_CASES = [
  A("docker", "stack-status", ["stack", "status"], { mustContain: /searxng/i }),
  A("docker", "searxng-status", ["searxng", "status"], { stream: "all", mustContain: /up|running|answer/i }),
  A("docker", "firecrawl-status", ["firecrawl", "status"], { stream: "all", mustContain: /up|running|answer/i }),
  A("docker", "semantic-status", ["semantic", "status"], { stream: "all", mustContain: /up|running|answer/i }),
  A(
    "docker",
    "search-searxng",
    ["search", "rust borrow checker", "--engine", "off", "--firecrawl", "off", "--json"],
    {
      json: true,
      check: (_, j) => (j?.hits?.length ? undefined : `no hits; rungs ${JSON.stringify(j?.rungs)}`),
    },
    { env: { WEBINDEX_SEARXNG: STACK_ENV.WEBINDEX_SEARXNG }, timeout: 90_000 },
  ),
  A(
    "docker",
    "search-firecrawl",
    ["search", "rust borrow checker", "--engine", "off", "--searxng", "off", "--json"],
    {
      json: true,
      check: (_, j) => (j?.hits?.length ? undefined : `no hits; rungs ${JSON.stringify(j?.rungs)}`),
    },
    { env: { WEBINDEX_FIRECRAWL: STACK_ENV.WEBINDEX_FIRECRAWL }, timeout: 120_000 },
  ),
  A(
    "docker",
    "fetch-firecrawl",
    ["fetch", "https://en.wikipedia.org/wiki/Alan_Turing", "--json"],
    {
      json: true,
      check: (_, j) => {
        const d = Array.isArray(j) ? j[0] : j;
        return d?.text?.includes("Bletchley") ? undefined : `text ${d?.text?.slice(0, 100)}`;
      },
    },
    { env: { WEBINDEX_FIRECRAWL: STACK_ENV.WEBINDEX_FIRECRAWL }, timeout: 120_000 },
  ),
  A(
    "docker",
    "pdf-firecrawl",
    ["fetch", "https://arxiv.org/pdf/1706.03762"],
    { minChars: 20000 },
    {
      env: { WEBINDEX_FIRECRAWL: STACK_ENV.WEBINDEX_FIRECRAWL, WEBINDEX_PDF_ENGINE: "firecrawl" },
      timeout: 240_000,
    },
  ),
  A(
    "docker",
    "docx-firecrawl",
    ["fetch", FIXTURES["sample.docx"]],
    // Self-hosted Firecrawl hands an octet-stream .docx back as its ZIP bytes:
    // the rung must be refused with that reason, never cited.
    {
      code: [0, 1],
      check: (r) =>
        r.code === 0
          ? r.stdout.trim().length >= 20
            ? undefined
            : "empty read"
          : /returned the file's bytes/.test(r.stderr)
            ? undefined
            : `reason: ${r.stderr.slice(0, 200)}`,
    },
    {
      env: { WEBINDEX_FIRECRAWL: STACK_ENV.WEBINDEX_FIRECRAWL, WEBINDEX_DOC_ENGINE: "firecrawl" },
      timeout: 240_000,
    },
  ),
  A(
    "docker",
    "embed",
    ["embed", "hello world", "--json"],
    { json: true, mustContain: /\d\.\d+/ },
    { env: { WEBINDEX_OLLAMA: STACK_ENV.WEBINDEX_OLLAMA }, timeout: 120_000 },
  ),
  A(
    "docker",
    "embed-docs",
    ["embed", "--docs", "-", "--lines", "--json"],
    { json: true },
    { env: { WEBINDEX_OLLAMA: STACK_ENV.WEBINDEX_OLLAMA }, stdin: "first line\nsecond line\n", timeout: 120_000 },
  ),
  {
    area: "docker",
    id: "hybrid-dense",
    timeout: 240_000,
    run: async () => {
      const env = { WEBINDEX_OLLAMA: STACK_ENV.WEBINDEX_OLLAMA, WEBINDEX_QDRANT: STACK_ENV.WEBINDEX_QDRANT };
      const urls = ["https://en.wikipedia.org/wiki/Alan_Turing", "https://en.wikipedia.org/wiki/Banana"];
      const f = await cli(["fetch", ...urls, "--json"], { timeout: 90_000 });
      let docs;
      try {
        docs = JSON.parse(f.stdout).map((d) => ({ url: d.url, title: d.title, text: d.text }));
      } catch {
        return { ...f, why: "fetch failed" };
      }
      const h = await cli(["hybrid", "--query", "codebreaker of the second world war", "--json"], { env, stdin: JSON.stringify(docs), timeout: 200_000 });
      const d = await cli(["rank", "--query", "yellow tropical fruit", "--dense", "--json"], { env, stdin: JSON.stringify(docs), timeout: 200_000 });
      const why = [];
      if (/degrad|lexical half|no embedding/i.test(h.stderr)) why.push(`hybrid degraded: ${h.stderr.slice(0, 200)}`);
      if (!/Turing/.test(h.stdout.slice(0, 600))) why.push("hybrid did not rank Turing first");
      if (!/Banana/.test(d.stdout.slice(0, 600))) why.push("dense rank did not rank Banana first");
      return { code: h.code, stdout: `${h.stdout.slice(0, 400)}\n---\n${d.stdout.slice(0, 400)}`, stderr: `${h.stderr}\n${d.stderr}`, ms: h.ms, why };
    },
  },
  {
    area: "docker",
    id: "mcp-embed",
    timeout: 120_000,
    run: async () => {
      const r = await mcpStdio([INIT(), INITIALIZED, call("e", "webindex_embed", { texts: ["hello", "world"] })], {
        expectIds: ["init", "e"],
        env: { WEBINDEX_OLLAMA: STACK_ENV.WEBINDEX_OLLAMA },
        timeout: 110_000,
      });
      const a = r.answers.get("e");
      return { code: 0, stdout: toolText(a).slice(0, 300), stderr: "", ms: r.ms, why: toolOk(a) ? [] : [`embed: ${toolText(a).slice(0, 200)}`] };
    },
  },
  A("docker", "doctor-stack", ["doctor"], { mustContain: /searxng/i }, { env: STACK_ENV }),
];

// ── Browser cases: Chrome and Brave each drive the same sequence ────────────
function browserCases(kind) {
  const env = { WEBINDEX_BROWSER_DIR: join(tmp, `browser-${kind}`), WEBINDEX_BROWSER_KIND: kind };
  const group = `browser-${kind}`;
  const B = (id, argv, expect, extra = {}) => ({
    area: "browser",
    id: `${kind}-${id}`,
    argv: ["browser", ...argv],
    expect,
    env,
    serial: group,
    timeout: 60_000,
    ...extra,
  });
  const refs = {};
  const refOf = (snapshot, role, name) => {
    const line = snapshot.split("\n").find((l) => l.includes(`- ${role}`) && (!name || l.toLowerCase().includes(name.toLowerCase())));
    return line?.match(/\[ref=(e\d+)\]/)?.[1];
  };
  const withRef = (key, argv) => ({ dynamicArgv: () => ["browser", ...argv.map((a) => (a === "@ref" ? (refs[key] ?? "e0") : a))] });
  return [
    B("open", ["open", "https://httpbin.org/forms/post", "--headless", "--browser-kind", kind], { stream: "all", minChars: 5 }),
    B("status", ["status"], { stream: "all", mustContain: /httpbin|running|tab/i }),
    B("snapshot", ["snapshot", "--interactive"], {
      mustContain: "[ref=",
      check: (r) => {
        refs.name = refOf(r.stdout, "textbox", "Customer name");
        refs.tel = refOf(r.stdout, "textbox", "Telephone");
        refs.comments = refOf(r.stdout, "textbox", "Delivery instructions");
        refs.large = refOf(r.stdout, "radio", "Large");
        refs.submit = refOf(r.stdout, "button", "Submit");
        return refs.name && refs.submit ? undefined : `refs not found: ${JSON.stringify(refs)}`;
      },
    }),
    B("type", ["type", "@ref", "Ada Lovelace"], { stream: "all", minChars: 1 }, withRef("name", ["type", "@ref", "Ada Lovelace"])),
    B("fill", ["fill", "@ref", "0123456789"], { stream: "all", minChars: 1 }, withRef("tel", ["fill", "@ref", "0123456789"])),
    B("click-radio", ["click", "@ref"], { stream: "all", minChars: 1 }, withRef("large", ["click", "@ref"])),
    B(
      "type-submit",
      ["type", "@ref", "ring twice", "--submit"],
      { stream: "all", minChars: 1 },
      withRef("comments", ["type", "@ref", "ring twice", "--submit"]),
    ),
    // "Submit order" looks irreversible: the human said yes, which is what --confirm records.
    B("click-submit", ["click", "@ref", "--confirm"], { stream: "all", minChars: 1 }, withRef("submit", ["click", "@ref", "--confirm"])),
    B("wait-url", ["wait", "--url", "httpbin.org/post", "--timeout", "15000"], { stream: "all", minChars: 1 }),
    B("text-after-submit", ["text"], { mustContain: ["Ada Lovelace", "0123456789"] }),
    B("open-dropdown", ["open", "https://the-internet.herokuapp.com/dropdown"], { stream: "all", minChars: 1 }),
    B("snapshot-dropdown", ["snapshot", "--interactive"], {
      check: (r) => {
        refs.select = refOf(r.stdout, "combobox");
        return refs.select ? undefined : "no combobox";
      },
    }),
    B("select", ["select", "@ref", "Option 2"], { stream: "all", minChars: 1 }, withRef("select", ["select", "@ref", "Option 2"])),
    B("eval-select", ["eval", "document.querySelector('#dropdown').value"], { mustContain: "2" }),
    B("open-upload", ["open", "https://the-internet.herokuapp.com/upload"], { stream: "all", minChars: 1 }),
    B("snapshot-upload", ["snapshot", "--interactive"], {
      check: (r) => {
        // The file input renders as a button named in the browser's own
        // language ("Choose File", "Choisir un fichier"): the one just before Upload.
        const buttons = r.stdout.split("\n").filter((l) => l.includes("- button"));
        const at = buttons.findIndex((l) => l.includes('"Upload"'));
        refs.file = at > 0 ? buttons[at - 1].match(/\[ref=(e\d+)\]/)?.[1] : undefined;
        refs.uploadBtn = refOf(r.stdout, "button", "Upload");
        return refs.file ? undefined : "no file input";
      },
    }),
    B("upload", ["upload", "@ref", "{tmp}/upload-me.txt"], { stream: "all", minChars: 1 }, withRef("file", ["upload", "@ref", join(tmp, "upload-me.txt")])),
    B("upload-submit", ["click", "@ref"], { stream: "all", minChars: 1 }, withRef("uploadBtn", ["click", "@ref"])),
    B("upload-result", ["text"], { mustContain: "upload-me.txt" }),
    B("open-spa", ["open", "https://quotes.toscrape.com/js/"], { stream: "all", minChars: 1 }),
    B("wait-text", ["wait", "--text", "Einstein", "--timeout", "15000"], { stream: "all", minChars: 1 }),
    B("text-md", ["text", "--markdown"], { mustContain: "Einstein" }),
    B("scroll", ["scroll", "bottom"], { stream: "all", minChars: 1 }),
    B("screenshot", ["screenshot", "--full", "--out", join(tmp, `${kind}-shot.png`)], {
      stream: "all",
      check: () => (existsSync(join(tmp, `${kind}-shot.png`)) ? undefined : "no screenshot file"),
    }),
    B("tabs-new", ["tabs", "new"], { stream: "all", minChars: 1 }),
    B("tabs-list", ["tabs", "list"], { mustContain: /t\d/ }),
    B("open-capture", ["open", "https://httpbin.org/json", "--capture"], { stream: "all", minChars: 1 }),
    B("network-list", ["network", "list"], { stream: "all", minChars: 1 }),
    B("wait-idle", ["wait", "--idle", "--timeout", "10000"], { stream: "all", minChars: 1 }),
    B("back", ["back"], { stream: "all", minChars: 1 }),
    B("reload", ["reload"], { stream: "all", minChars: 1 }),
    B("stale-ref", ["click", "e9999"], { code: 1, stream: "stderr", minChars: 5 }),
    B("close", ["close", "--all"], { stream: "all", minChars: 1 }),
    {
      area: "browser",
      id: `${kind}-fetch-browser`,
      serial: group,
      timeout: 90_000,
      env,
      argv: ["fetch", "https://quotes.toscrape.com/js/", "--browser"],
      expect: { mustContain: "Einstein" },
    },
    B("close-after-fetch", ["close", "--all"], { stream: "all", minChars: 1 }),
    {
      area: "browser",
      id: `${kind}-profile-import`,
      serial: group,
      env,
      run: async () => {
        // A browser dir of its own: the sequence above already made the default
        // profile in the shared one, and refusing to overwrite it is correct.
        const env = { WEBINDEX_BROWSER_DIR: join(tmp, `browser-${kind}-import`), WEBINDEX_BROWSER_KIND: kind };
        const src = join(tmp, `${kind}-fake-profile`);
        mkdirSync(join(src, "Default"), { recursive: true });
        writeFileSync(join(src, "Local State"), "{}");
        writeFileSync(join(src, "Default", "Preferences"), "{}");
        const a = await cli(["browser", "profile", "import", src], { env });
        const again = await cli(["browser", "profile", "import", src], { env });
        const forced = await cli(["browser", "profile", "import", src, "--force"], { env });
        const p = await cli(["browser", "profile", "path"], { env });
        const reset = await cli(["browser", "profile", "reset"], { env });
        const why = [];
        if (a.code !== 0) why.push(`import ${a.code}: ${a.stderr.slice(0, 200)}`);
        if (again.code === 0) why.push("second import without --force succeeded");
        if (forced.code !== 0) why.push(`--force ${forced.code}: ${forced.stderr.slice(0, 200)}`);
        if (p.code !== 0) why.push("profile path failed");
        if (reset.code !== 0) why.push(`reset ${reset.code}`);
        return {
          code: 0,
          stdout: [a, again, forced, p, reset].map((r) => `${r.code} ${r.stdout.slice(0, 100)} ${r.stderr.slice(0, 100)}`).join("\n"),
          stderr: "",
          ms: 0,
          why,
        };
      },
    },
    {
      area: "browser",
      id: `${kind}-no-orphans`,
      serial: group,
      run: async () => {
        const r = await run("pgrep", ["-fl", join(tmp, `browser-${kind}`)]);
        return { code: 0, stdout: r.stdout, stderr: "", ms: 0, why: r.stdout.trim() ? [`processes left: ${r.stdout.slice(0, 300)}`] : [] };
      },
    },
  ];
}
const BROWSER_CASES = [...browserCases("chrome"), ...browserCases("brave")];

// ── The run ─────────────────────────────────────────────────────────────────
let cases = [...CASES, ...(WITH_DOCKER ? DOCKER_CASES : []), ...(WITH_BROWSER ? BROWSER_CASES : [])];
if (AREAS) cases = cases.filter((c) => AREAS.includes(c.area));
if (ID) cases = cases.filter((c) => c.id.includes(ID));
if (!cases.length) {
  console.error("live-check: no case matches");
  process.exit(2);
}
writeFileSync(join(tmp, "upload-me.txt"), "uploaded by the live check\n");
await loadFixtures([...new Set(cases.flatMap((c) => [...(c.fixtures ?? []), ...(c.stdinFixture ? [c.stdinFixture] : [])]))]);

const subst = (a) => a.replace(/\{fx:([^}]+)\}/g, (_, n) => fx(n)).replace(/\{tmp\}/g, tmp);
async function runCase(c) {
  const missing = (c.fixtures ?? []).filter((n) => fixtureErrors[n]);
  if (missing.length) return { status: "fail", ms: 0, why: missing.map((n) => `fixture ${fixtureErrors[n]}`), stdout: "", stderr: "" };
  let r;
  try {
    if (c.run) r = await c.run();
    else {
      const argv = (c.dynamicArgv ? c.dynamicArgv() : c.argv).map(subst);
      const stdin = c.stdinFixture ? readFileSync(fx(c.stdinFixture)) : c.stdin;
      r = await cli(argv, { stdin, env: c.env, timeout: c.timeout ?? 60_000 });
    }
  } catch (e) {
    r = { code: "crash", stdout: "", stderr: e.stack ?? String(e), ms: 0 };
  }
  const why = judge(c, r);
  return { status: why.length ? "fail" : "pass", ms: r.ms, why, stdout: r.stdout, stderr: r.stderr, code: r.code };
}

// The keyless engines answer an anti-bot page to a burst of queries from one
// address, which is their right and not a bug here: every case that searches
// them runs in one line, a few seconds apart.
const SEARCHES = new Set(["mcp-stdio-all-tools", "lib-fetch-search", "search-dashdash"]);
const PAUSE_MS = { engines: 4000 };
for (const c of cases) if ((c.area === "search" || SEARCHES.has(c.id)) && !c.serial) c.serial = "engines";

const results = new Map();
const queue = [];
const groups = new Map();
for (const c of cases) {
  if (!c.serial) queue.push([c]);
  else if (groups.has(c.serial)) groups.get(c.serial).push(c);
  else {
    const g = [c];
    groups.set(c.serial, g);
    queue.push(g);
  }
}
let done = 0;
async function worker() {
  for (let g = queue.shift(); g; g = queue.shift()) {
    for (const [i, c] of g.entries()) {
      if (i > 0 && PAUSE_MS[c.serial]) await new Promise((r) => setTimeout(r, PAUSE_MS[c.serial]));
      const res = await runCase(c);
      results.set(c.id, { ...res, area: c.area, id: c.id });
      done++;
      const mark = res.status === "pass" ? "ok  " : "FAIL";
      process.stderr.write(
        `[${String(done).padStart(3)}/${cases.length}] ${mark} ${c.area}/${c.id} (${res.ms ?? 0} ms)${res.why.length ? ` — ${res.why.join("; ").slice(0, 300)}` : ""}\n`,
      );
    }
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: JOBS }, worker));

// Whatever happens to the cases, the browsers they launched do not outlive the run.
if (WITH_BROWSER) {
  for (const kind of ["chrome", "brave"])
    await cli(["browser", "close", "--all"], { env: { WEBINDEX_BROWSER_DIR: join(tmp, `browser-${kind}`) }, timeout: 20_000 });
}

// ── Report ──────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const ordered = cases.map((c) => results.get(c.id));
const failed = ordered.filter((r) => r.status === "fail");
const excerpt = (s, n = 600) => (s ?? "").trim().slice(0, n);
writeFileSync(
  join(OUT, "report.json"),
  `${JSON.stringify({ date: new Date().toISOString(), ms: Date.now() - t0, withDocker: WITH_DOCKER, withBrowser: WITH_BROWSER, results: ordered.map((r) => ({ ...r, stdout: excerpt(r.stdout, 2000), stderr: excerpt(r.stderr, 2000) })) }, null, 2)}\n`,
);
const md = [
  `# webindex live check — ${new Date().toISOString()}`,
  "",
  `${ordered.length - failed.length}/${ordered.length} passed in ${Math.round((Date.now() - t0) / 1000)} s${WITH_DOCKER ? ", docker" : ""}${WITH_BROWSER ? ", browser" : ""}.`,
  "",
  "| Area | Case | Status | ms | Why |",
  "|---|---|---|---|---|",
  ...ordered.map((r) => `| ${r.area} | ${r.id} | ${r.status} | ${r.ms ?? ""} | ${r.why.join("; ").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300)} |`),
  "",
  ...failed.flatMap((r) => [`## ${r.area}/${r.id}`, "", `exit ${r.code}`, "", "```", excerpt(r.stdout), "```", "", "```", excerpt(r.stderr), "```", ""]),
].join("\n");
writeFileSync(join(OUT, "report.md"), md);
process.stderr.write(`\n${ordered.length - failed.length}/${ordered.length} passed — ${join(OUT, "report.md")}\n`);
if (!KEEP) rmSync(tmp, { recursive: true, force: true });
else process.stderr.write(`kept ${tmp}\n`);
process.exit(failed.length ? 1 : 0);
