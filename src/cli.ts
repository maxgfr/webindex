#!/usr/bin/env node
// The webindex command line.
//
// A SECOND tsup entry, deliberately not reachable from src/index.ts. The
// consumers vendor that bundle and inline it, so anything exported from there
// ends up inside three skills that cannot invoke it — and a module-scope
// configure() in a CLI would race the skill's own. The library and the command
// share src/ and ship as two separate files.
//
// What it offers is what the engine actually does today: turn a URL or a local
// file into clean text, and serve that ability over MCP. There is deliberately
// no `search` — the discovery layer has not landed, and a command that promised
// it would be lying.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { configure } from "./brand.js";
import { ENGINE_VERSION } from "./version.js";
import { docFormatForContentType, docFormatForUrl, extractDocument, enabledDocExtractors } from "./doc.js";
import { enabledExtractors, extractPdf, ocrTools } from "./pdf.js";
import { fetchAndExtract, htmlToText, looksLikePdfUrl } from "./fetch.js";
import { firecrawlBase, probeFirecrawl } from "./firecrawl.js";
import { composeControl, ensureComposeMaterialized, STACK_SERVICES, type StackAction } from "./stack.js";
import { ToolError, type McpAdapter, type ToolDecl } from "./mcp/server.js";
import { runStdioServer } from "./mcp/stdio.js";
import { startHttpServer } from "./mcp/http.js";

configure({ name: "webindex", envPrefix: "WEBINDEX", cli: "webindex", contactUrl: "https://github.com/maxgfr/webindex" });

const HELP = `webindex v${ENGINE_VERSION}
Turn a URL or a file into clean, citable text — HTML, PDFs through a six-rung
ladder ending in OCR, and office documents — and serve that to an agent over
MCP. Zero dependencies, no API key.

USAGE
  webindex fetch <url> [--json] [--firecrawl <base>|off] [--lang <tag>]
  webindex extract <file> [--json]
  webindex mcp [--transport stdio|http] [--port <n>] [--bind <addr>]
  webindex searxng   up|down|status
  webindex firecrawl up|down|status
  webindex stack     up|down|status|path
  webindex doctor
  webindex version

COMMANDS
  fetch      Fetch a URL and print the extracted text. Routes PDFs and office
             documents to their ladders automatically, and falls back through
             Firecrawl and the Wayback Machine when a page resists.
  extract    Same extraction, on a file already on disk.
  mcp        Serve fetch/extract to an agent over MCP (stdio by default).
  searxng    Bring the keyless SearXNG container up or down, or show it.
  firecrawl  Same for Firecrawl, which cleans a page with a real browser. It
             delegates its own search to SearXNG, so this starts both.
  stack      Everything at once; 'path' prints where the compose file was
             written. The stack is EMBEDDED in this binary — no checkout needed.
  doctor     Report which optional helpers are reachable and which extraction
             rungs are available on this machine.

ENVIRONMENT
  WEBINDEX_FIRECRAWL     Firecrawl base URL, or "off"  (default http://localhost:3002)
  WEBINDEX_PDF_ENGINE    force one PDF rung: native|pdf-inspector|anydoc|firecrawl|pdftotext|ocr
  WEBINDEX_DOC_ENGINE    force one office rung, or "none" to disable
  WEBINDEX_NO_NPX        skip the rungs that would install through npx
  WEBINDEX_OCR_MAX       documents this process may OCR (default 3)
  WEBINDEX_CACHE_DIR     where the fetch cache lives
  WEBINDEX_UA            override the browser User-Agent

Every optional helper degrades to a note. Nothing here needs an API key.`;

function fail(msg: string): never {
  process.stderr.write(`webindex: ${msg}\n`);
  process.exit(1);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
}

/** Extraction over bytes already in hand — the shared half of `extract`. */
async function extractLocal(path: string): Promise<{ text: string; extractor: string; reason?: string }> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    fail(`cannot read ${path}: ${(e as Error).message}`);
  }
  const asUrl = pathToFileURL(path).href;

  if (looksLikePdfUrl(asUrl) || bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    const r = await extractPdf(bytes);
    return { text: r.text, extractor: r.via ?? "none", reason: r.reason };
  }
  const fmt = docFormatForUrl(asUrl);
  if (fmt) {
    const r = await extractDocument(bytes, fmt);
    return { text: r.text, extractor: r.via ?? "none", reason: r.reason };
  }
  const raw = bytes.toString("utf8");
  const looksHtml = /^\s*<(?:!doctype|html|head|body)\b/i.test(raw);
  return { text: looksHtml ? htmlToText(raw) : raw, extractor: looksHtml ? "native" : "plain" };
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
        name: "webindex_fetch",
        title: "Fetch a URL as clean text",
        description:
          "Fetch a URL and return its readable text. Handles HTML, PDFs (native reader → pdf-inspector → anydoc → Firecrawl → pdftotext → OCR) and office documents, " +
          "and falls back through Firecrawl and the Wayback Machine for pages that resist. Returns the extracted text plus which rung produced it — never raw bytes.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The http(s) URL to fetch." },
            lang: { type: "string", description: "Accept-Language tag, e.g. fr-FR." },
          },
          required: ["url"],
        },
      },
      {
        name: "webindex_extract",
        title: "Extract text from a local file",
        description: "Read a PDF, office document or HTML file already on disk and return its text, using the same extraction ladders as webindex_fetch.",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute path to the file." } }, required: ["path"] },
      },
    ],
    capAdvice: {
      webindex_fetch: "the page is very large; fetch it and read the file instead of inlining it",
      webindex_extract: "the document is very large; read it in pieces",
    },
    async callTool(name, args) {
      if (name === "webindex_fetch") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        const r = await fetchAndExtract(url, { acceptLanguage: args.lang ? String(args.lang) : undefined });
        if (!r.text) throw new ToolError(`Nothing readable at ${url}${r.note ? ` — ${r.note}` : ""}.`);
        return { text: `${r.text}\n\n---\nextractor: ${r.extractor ?? "native"}` };
      }
      if (name === "webindex_extract") {
        const r = await extractLocal(String(args.path ?? ""));
        if (!r.text) throw new ToolError(`Nothing readable in that file${r.reason ? ` — ${r.reason}` : ""}.`);
        return { text: `${r.text}\n\n---\nextractor: ${r.extractor}` };
      }
      throw new ToolError(`unknown tool: ${name}`);
    },
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cmd = argv[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    process.stdout.write(ENGINE_VERSION + "\n");
    return;
  }

  if (cmd === "fetch") {
    const url = argv[1];
    if (!url || url.startsWith("--")) fail("usage: webindex fetch <url>");
    if (!/^https?:\/\//i.test(url)) fail("fetch needs an http(s) URL");
    const r = await fetchAndExtract(url, { acceptLanguage: flag(argv, "lang"), firecrawl: flag(argv, "firecrawl") });
    if (argv.includes("--json")) {
      process.stdout.write(
        JSON.stringify({ url, title: r.title, extractor: r.extractor, status: r.status, chars: r.text.length, note: r.note, text: r.text }, null, 2) + "\n",
      );
      return;
    }
    if (!r.text) fail(`nothing readable at ${url}${r.note ? ` — ${r.note}` : ""}`);
    process.stdout.write(r.text + "\n");
    return;
  }

  if (cmd === "extract") {
    const path = argv[1];
    if (!path || path.startsWith("--")) fail("usage: webindex extract <file>");
    const r = await extractLocal(path);
    if (argv.includes("--json")) {
      process.stdout.write(
        JSON.stringify({ file: basename(path), extractor: r.extractor, chars: r.text.length, reason: r.reason, text: r.text }, null, 2) + "\n",
      );
      return;
    }
    if (!r.text) fail(`nothing readable in ${path}${r.reason ? ` — ${r.reason}` : ""}`);
    process.stdout.write(r.text + "\n");
    return;
  }

  if (cmd === "mcp") {
    const transport = flag(argv, "transport") ?? "stdio";
    if (transport === "stdio") {
      await runStdioServer(webindexAdapter());
      return;
    }
    if (transport !== "http") fail(`unknown transport "${transport}" — expected stdio or http`);
    const port = Number(flag(argv, "port") ?? 7340);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail("invalid --port");
    let running: Awaited<ReturnType<typeof startHttpServer>>;
    try {
      running = await startHttpServer(webindexAdapter(), { port, bind: flag(argv, "bind"), allowRemote: argv.includes("--allow-remote") });
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

  if (cmd === "searxng" || cmd === "firecrawl" || cmd === "stack") {
    const action = argv[1] ?? "status";
    if (cmd === "stack" && action === "path") {
      process.stdout.write(ensureComposeMaterialized() + "\n");
      return;
    }
    if (action !== "up" && action !== "down" && action !== "status") {
      fail(`usage: webindex ${cmd} up|down|status${cmd === "stack" ? "|path" : ""}`);
    }
    const code = await composeControl(cmd === "stack" ? "all" : cmd, action as StackAction);
    if (code !== 0) process.exit(code);
    return;
  }

  if (cmd === "doctor") {
    const base = firecrawlBase();
    const fc = base ? await probeFirecrawl(base) : false;
    const ocr = await ocrTools();
    const lines = [
      `webindex ${ENGINE_VERSION}`,
      `  firecrawl   ${base ? (fc ? `answering at ${base}` : `not reachable at ${base} — the built-in extractor is used instead`) : "disabled"}`,
      `  pdf rungs   ${enabledExtractors().join(", ")}`,
      `  doc rungs   ${enabledDocExtractors().join(", ") || "none (disabled)"}`,
      `  ocr         ${ocr.copyablePdf && ocr.tesseract ? "available" : `unavailable (copyable-pdf: ${ocr.copyablePdf ? "yes" : "no"}, tesseract: ${ocr.tesseract ? "yes" : "no"})`}`,
      "",
      "  Everything optional degrades to a note — nothing above is required, and none of it needs a key.",
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  fail(`unknown command "${cmd}" — run \`webindex --help\``);
}

// Only when run as a program. Importing this module must not start anything.
if (process.argv[1] && /webindex(\.mjs)?$/.test(process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(`webindex: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
