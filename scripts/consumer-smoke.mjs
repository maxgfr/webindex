#!/usr/bin/env node
// Prove the engine stands on its own.
//
// Everything else in CI runs webindex from inside webindex: its own tests, its
// own tsconfig, its own node_modules. None of that answers the question this
// package actually has to answer — can a project with no relationship to this
// repo vendor two files and get a working engine?
//
// So this script builds a throwaway consumer somewhere else on disk, copies in
// nothing but scripts/engine.mjs, declares a brand no skill uses, and exercises
// the real surface. No package.json, no install, no tsconfig, no node_modules.
// If it passes, the engine stands on its own.
//
// It is deliberately offline: global fetch is stubbed, the PDF ladder is pinned
// to its built-in rung, and the office ladder is disabled. A smoke test that
// needs the network tells you about the network.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "webindex-consumer-"));

// A brand belonging to no real consumer. If anything in the engine still
// assumes a particular one, this is what surfaces it.
const PREFIX = "ACME";

const probe = `
import {
  ENGINE_VERSION, configure, brand, env, envInt,
  canonicalizeUrl, domainOf, fnv1a64, keywords, buildMatcher, isStopword,
  docFormatForUrl, looksLikePdfUrl, htmlToText, extractMainHtml,
  extractPdf, pdfToText, enabledExtractors,
  httpGet, fetchAndExtract,
  isNoWrite, setNoWrite, writeArtifact, takeArtifacts,
  createServer, runStdioServer, ToolError,
} from "./engine.mjs";

const fail = (m) => { console.error("consumer-smoke: " + m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); };

// ── The engine has no identity until a consumer gives it one ────────────────
configure({ name: "acme-research", envPrefix: "${PREFIX}", cli: "acme", contactUrl: "https://acme.test/bot" });
ok(brand().name === "acme-research", "configure() did not take");
process.env.${PREFIX}_UA = "acme-probe";
ok(env("UA") === "acme-probe", "env() did not read through the consumer's prefix");
ok(envInt("MISSING", 7) === 7, "envInt() default broken");
ok(/^\\d+\\.\\d+\\.\\d+/.test(ENGINE_VERSION), "bad ENGINE_VERSION: " + ENGINE_VERSION);

// ── Text and URL identity ───────────────────────────────────────────────────
ok(canonicalizeUrl("HTTPS://WWW.Acme.test/a/?utm_source=x#f") === "https://acme.test/a", "canonicalizeUrl");
ok(domainOf("https://www.acme.test/x") === "acme.test", "domainOf");
ok(fnv1a64("a") !== fnv1a64("b"), "fnv1a64");
ok(keywords("What is the default for maxRetries?").includes("maxRetries"), "keywords");
ok(isStopword("the") && !isStopword("maxRetries"), "isStopword");
ok(buildMatcher("télémétrie").matchLine("the telemetrie pipeline").size === 1, "buildMatcher accent folding");

// ── Content routing ─────────────────────────────────────────────────────────
ok(docFormatForUrl("https://acme.test/a.docx")?.textFallback === false, "docFormatForUrl");
ok(docFormatForUrl("https://acme.test/a.pdf") === undefined, "PDFs must not route to the office ladder");
ok(looksLikePdfUrl("https://acme.test/paper.pdf"), "looksLikePdfUrl");
ok(htmlToText("<h1>Title</h1><p>Body text.</p>").includes("Body text."), "htmlToText");
ok(typeof extractMainHtml("<html><body><article><p>x</p></article></body></html>") === "string", "extractMainHtml");

// ── The PDF ladder, pinned to its built-in rung (no npx, no network) ────────
process.env.${PREFIX}_PDF_ENGINE = "native";
process.env.${PREFIX}_DOC_ENGINE = "none";
process.env.${PREFIX}_OCR_MAX = "0";
ok(enabledExtractors().length === 1 && enabledExtractors()[0] === "native", "the consumer's PDF_ENGINE was ignored");
const notAPdf = await extractPdf(Buffer.from("not a pdf"), { engines: ["native"] });
ok(typeof notAPdf.text === "string" && typeof notAPdf.reason === "string", "extractPdf must refuse, never throw");
ok(typeof pdfToText(Buffer.from("%PDF-1.4\\n")) === "string", "pdfToText must not throw on a stub");

// ── HTTP, with fetch stubbed: offline but real code paths ───────────────────
globalThis.fetch = async () => new Response("<html><body><article><p>rate limiting explained</p></article></body></html>",
  { status: 200, headers: { "content-type": "text/html" } });
const r = await httpGet("https://acme.test/page");
ok(r.ok && r.body.includes("rate limiting"), "httpGet");
const ex = await fetchAndExtract("https://acme.test/page");
ok(ex.text.includes("rate limiting"), "fetchAndExtract did not reach clean text");

// ── The write gate ──────────────────────────────────────────────────────────
setNoWrite(true);
ok(isNoWrite(), "setNoWrite");
writeArtifact("/nonexistent/dir/REPORT.md", "body");   // must not touch disk, must not throw
ok(takeArtifacts().length === 1, "the write gate did not collect");
setNoWrite(false);

// ── MCP: the consumer supplies its own tools, the engine runs the protocol ──
const adapter = {
  version: "0.0.1",
  listTools: () => [{ name: "acme_echo", description: "Echo.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "what" } }, required: ["text"] } }],
  async callTool(name, args) {
    if (name !== "acme_echo") throw new ToolError("unknown tool");
    return { text: String(args.text).toUpperCase() };
  },
};
const server = createServer(adapter);
const say = async (msg) => { let out; await server.handle(msg, (m) => { out = m; }); return out; };
const init = await say({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
ok(init.result.serverInfo.name === "acme-research", "serverInfo must name the CONSUMER, got " + init.result.serverInfo.name);
ok(init.result.serverInfo.version === "0.0.1", "serverInfo version must come from the adapter");
const listed = await say({ jsonrpc: "2.0", id: 2, method: "tools/list" });
ok(listed.result.tools[0].name === "acme_echo", "the consumer's tool was not advertised");
const called = await say({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "acme_echo", arguments: { text: "hi" } } });
ok(called.result.content[0].text === "HI", "the consumer's tool did not run");
const bad = await say({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "acme_echo", arguments: {} } });
ok(bad.error?.code === -32602, "schema validation must reject a missing required argument");
ok(typeof runStdioServer === "function", "the stdio transport must be reachable");

// A consumer with no SKILL.md on disk must still serve its tools rather than crash.
const res = await say({ jsonrpc: "2.0", id: 5, method: "resources/list" });
ok(Array.isArray(res.result.resources), "resources/list must answer even with no payload on disk");

console.log("consumer-smoke: webindex " + ENGINE_VERSION + " works standalone, under an unknown brand.");
`;

try {
  copyFileSync(join(root, "scripts", "engine.mjs"), join(dir, "engine.mjs"));
  writeFileSync(join(dir, "probe.mjs"), probe);
  const out = execFileSync(process.execPath, ["probe.mjs"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  process.stdout.write(out);

  // The CLI is a separate artifact, and its two server-startup paths are the
  // part the in-process suite cannot reach — they need a real subprocess. Drive
  // the built binary over stdio, which is exactly how an agent host runs it.
  const cli = join(root, "scripts", "webindex.mjs");
  const rpc = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const reply = execFileSync(process.execPath, [cli, "mcp"], {
    input: [rpc(1, "initialize", { protocolVersion: "2025-06-18" }), rpc(2, "tools/list", {})].join("\n") + "\n",
    encoding: "utf8",
    timeout: 30_000,
  });
  const frames = reply.trim().split("\n").map((l) => JSON.parse(l));
  if (frames[0].result?.serverInfo?.name !== "webindex") throw new Error("the CLI's MCP server did not identify itself");
  const names = frames[1].result.tools.map((t) => t.name).join(", ");
  if (!names.includes("webindex_fetch")) throw new Error("the CLI's MCP server advertised no fetch tool");
  console.log(`consumer-smoke: the CLI serves MCP over stdio — ${names}.`);
} catch (e) {
  process.stderr.write(String(e.stdout ?? "") + String(e.stderr ?? "") + String(e.message ?? "") + "\n");
  console.error("consumer-smoke: FAILED — the engine does not stand alone.");
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
