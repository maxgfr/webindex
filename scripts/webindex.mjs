#!/usr/bin/env node

// src/cli.ts
import { readFileSync as readFileSync5 } from "fs";
import { basename as basename3 } from "path";
import { pathToFileURL } from "url";

// src/brand.ts
var DEFAULT_BRAND = {
  name: "webindex",
  envPrefix: "WEBINDEX",
  cli: "webindex",
  contactUrl: "https://github.com/maxgfr/webindex"
};
var current = { ...DEFAULT_BRAND };
function configure(next) {
  if (!next.envPrefix || !/^[A-Z][A-Z0-9_]*$/.test(next.envPrefix)) {
    throw new Error(`webindex: envPrefix must be UPPER_SNAKE, got ${JSON.stringify(next.envPrefix)}`);
  }
  if (!next.name || !next.cli) {
    throw new Error("webindex: configure() requires both `name` and `cli`");
  }
  current = { ...next };
}
function brand() {
  return current;
}
function envName(suffix) {
  return `${current.envPrefix}_${suffix}`;
}
function env(suffix) {
  const raw = process.env[envName(suffix)];
  if (typeof raw !== "string") return void 0;
  const trimmed = raw.trim();
  return trimmed ? trimmed : void 0;
}
function envFlag(suffix) {
  const v = env(suffix);
  if (v === void 0) return false;
  const lower = v.toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "no" && lower !== "off";
}
function envInt(suffix, def, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = env(suffix);
  if (raw === void 0) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// src/version.ts
var ENGINE_VERSION = "1.13.0";

// src/doc/formats.ts
var BINARY = { textFallback: false };
var CSV = { format: "csv", textFallback: true };
var BY_EXTENSION = {
  // Word
  doc: BINARY,
  docx: BINARY,
  docm: BINARY,
  odt: BINARY,
  rtf: BINARY,
  // PowerPoint
  ppt: BINARY,
  pps: BINARY,
  pot: BINARY,
  pptx: BINARY,
  pptm: BINARY,
  ppsx: BINARY,
  ppsm: BINARY,
  odp: BINARY,
  // Excel
  xls: BINARY,
  xlsx: BINARY,
  xlsm: BINARY,
  xlsb: BINARY,
  ods: BINARY,
  // Everything else the converter reads
  epub: BINARY,
  csv: CSV
};
var BY_CONTENT_TYPE = {
  "application/msword": BINARY,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": BINARY,
  "application/vnd.ms-word.document.macroenabled.12": BINARY,
  "application/vnd.oasis.opendocument.text": BINARY,
  "application/rtf": BINARY,
  "text/rtf": BINARY,
  "application/vnd.ms-powerpoint": BINARY,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": BINARY,
  "application/vnd.oasis.opendocument.presentation": BINARY,
  "application/vnd.ms-excel": BINARY,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": BINARY,
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": BINARY,
  "application/vnd.oasis.opendocument.spreadsheet": BINARY,
  "application/epub+zip": BINARY,
  "text/csv": CSV
};
var DOC_EXTENSIONS = Object.keys(BY_EXTENSION);
function docFormatForUrl(url) {
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url);
  return m ? BY_EXTENSION[m[1].toLowerCase()] : void 0;
}
function docFormatForContentType(contentType) {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type ? BY_CONTENT_TYPE[type] : void 0;
}

// src/pdf/exec.ts
import { spawn } from "child_process";
var PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
var ANYDOC_SPEC = "@firecrawl/anydoc@0.1";
var MAX_STDOUT_BYTES = 24 * 1024 * 1024;
function binaryName(name) {
  return process.platform === "win32" && name === "npx" ? "npx.cmd" : name;
}
function runWithInput(cmd, args, input, timeoutMs) {
  return new Promise((resolve3) => {
    let child;
    try {
      child = spawn(binaryName(cmd), args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve3({ ok: false, stdout: "", error: e.message });
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve3(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, stdout: "", error: `timed out after ${Math.round(timeoutMs / 1e3)}s` });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      if (size >= MAX_STDOUT_BYTES) return;
      size += d.length;
      chunks.push(d);
    });
    child.stderr?.on("data", () => {
    });
    child.on("error", (e) => {
      done({ ok: false, stdout: "", error: e.code === "ENOENT" ? "not installed" : e.message });
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).subarray(0, MAX_STDOUT_BYTES).toString("utf8");
      if (code === 0) done({ ok: true, stdout });
      else done({ ok: false, stdout, error: `exit ${code}` });
    });
    child.stdin?.on("error", () => {
    });
    child.stdin?.end(input);
  });
}

// src/pdf/quality.ts
var MIN_CHARS_FOR_SHAPE_CHECKS = 200;
var CONTROL_RATIO_MAX = 5e-3;
var REPLACEMENT_RATIO_MAX = 5e-3;
var LONGEST_RUN_MAX = 300;
var LETTER_RATIO_MIN = 0.5;
function isControlCode(c) {
  if (c === 9 || c === 10 || c === 13) return false;
  return c < 32 || c >= 127 && c <= 159;
}
var REPLACEMENT_CODE = 65533;
function scanRatios(t) {
  let control = 0;
  let replacement = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === REPLACEMENT_CODE) replacement++;
    else if (isControlCode(c)) control++;
  }
  return { control: control / t.length, replacement: replacement / t.length };
}
function assessPdfText(text) {
  return assessExtractedText(text, "no text layer (scanned or image-only PDF?)");
}
function assessExtractedText(text, emptyReason) {
  const t = text.trim();
  if (!t) return { ok: false, reason: emptyReason };
  const { control, replacement } = scanRatios(t);
  if (control > CONTROL_RATIO_MAX) {
    return { ok: false, reason: "binary/control characters in the text (undecodable PDF stream)" };
  }
  if (replacement > REPLACEMENT_RATIO_MAX) {
    return { ok: false, reason: "replacement characters throughout (wrong character map)" };
  }
  if (t.length < MIN_CHARS_FOR_SHAPE_CHECKS) return { ok: true };
  let longestRun = 0;
  for (const w of t.split(/\s+/)) if (w.length > longestRun) longestRun = w.length;
  const letters = (t.match(new RegExp("\\p{L}|\\p{N}", "gu"))?.length ?? 0) / t.replace(/\s+/g, "").length;
  if (longestRun > LONGEST_RUN_MAX && letters < LETTER_RATIO_MIN) {
    return { ok: false, reason: "unreadable text layer (garbled glyph encoding)" };
  }
  return { ok: true };
}

// src/doc/ladder.ts
var DOC_EXTRACTORS = ["anydoc", "firecrawl"];
var NPX_TIMEOUT_MS = 9e4;
var dead = /* @__PURE__ */ new Set();
function enabledDocExtractors(engines) {
  if (engines) return engines;
  const forced = env("DOC_ENGINE");
  if (forced === "none") return [];
  if (forced && DOC_EXTRACTORS.includes(forced)) return [forced];
  if (envFlag("NO_NPX")) return DOC_EXTRACTORS.filter((e) => e !== "anydoc");
  return DOC_EXTRACTORS;
}
async function viaAnydoc(bytes, format) {
  const args = ["-y", "--prefer-offline", ANYDOC_SPEC, "-"];
  if (format) args.push("--format", format);
  const r = await runWithInput("npx", args, bytes, NPX_TIMEOUT_MS);
  return r.ok ? r.stdout : void 0;
}
async function extractDocument(bytes, fmt, opts = {}) {
  let lastReason;
  for (const id of enabledDocExtractors(opts.engines)) {
    if (dead.has(id)) continue;
    let text;
    try {
      if (id === "anydoc") text = await viaAnydoc(bytes, fmt.format);
      else text = opts.firecrawl ? await opts.firecrawl() : void 0;
    } catch {
      text = void 0;
    }
    if (text === void 0) {
      if (id !== "firecrawl") dead.add(id);
      continue;
    }
    const verdict = assessExtractedText(text, "the converter produced no text");
    if (verdict.ok) return { text: text.trim(), via: id };
    lastReason = verdict.reason;
  }
  return { text: "", reason: lastReason ?? "no document converter available" };
}

// src/pdf/native.ts
import { inflateSync, inflateRawSync } from "zlib";
function decodePdfString(tok) {
  if (tok[0] !== "(") return "";
  const inner = tok.slice(1, -1);
  const simple = { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
  return inner.replace(/\\([nrtbf()\\])/g, (_m, c) => simple[c] ?? c).replace(/\\([0-7]{1,3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8) & 255));
}
function decodeHexString(tok) {
  const hex = tok.slice(1, -1).replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  if (hex.length % 2) out += String.fromCharCode(parseInt(hex[hex.length - 1] + "0", 16));
  return out;
}
function decodeString(tok) {
  return tok[0] === "<" ? decodeHexString(tok) : decodePdfString(tok);
}
function decodeTJArray(tok) {
  let out = "";
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|-?\d+(?:\.\d+)?/g;
  let m;
  while (m = re.exec(tok)) {
    const t = m[0];
    if (t[0] === "(" || t[0] === "<") out += decodeString(t);
    else if (Number(t) <= -100) out += " ";
  }
  return out;
}
var TOKEN_RE = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\[(?:\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|[^\]])*\]|\bT\*|\bTd\b|\bTD\b|\bTj\b|\bTJ\b|'|"/g;
function extractTextOps(content) {
  let out = "";
  let operands = [];
  const take = () => {
    for (let i = operands.length - 1; i >= 0; i--) {
      const t = operands[i];
      if (t[0] === "(" || t[0] === "<") return decodeString(t);
      if (t[0] === "[") return decodeTJArray(t);
    }
    return "";
  };
  TOKEN_RE.lastIndex = 0;
  let m;
  while (m = TOKEN_RE.exec(content)) {
    const tok = m[0];
    const c = tok[0];
    if (c === "(" || c === "<" || c === "[") {
      operands.push(tok);
      continue;
    }
    if (tok === "Tj" || tok === "TJ") out += take() + " ";
    else if (tok === "'" || tok === '"') out += "\n" + take() + " ";
    else if (tok === "T*") out += "\n";
    operands = [];
  }
  return out;
}
function extractStreams(buf) {
  const out = [];
  const s = buf.toString("latin1");
  const re = /stream\r?\n/g;
  let m;
  while (m = re.exec(s)) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) continue;
    let stop = end;
    if (s[stop - 1] === "\n") stop--;
    if (s[stop - 1] === "\r") stop--;
    const chunk = buf.subarray(start, stop);
    let data;
    try {
      data = inflateSync(chunk);
    } catch {
      try {
        data = inflateRawSync(chunk);
      } catch {
        data = chunk;
      }
    }
    out.push(data.toString("latin1"));
  }
  return out;
}
function pdfToText(buf) {
  let out = "";
  try {
    for (const stream of extractStreams(buf)) {
      if (/\b(Tj|TJ)\b/.test(stream) || /\)\s*'/.test(stream)) out += extractTextOps(stream) + "\n";
    }
  } catch {
  }
  return out.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// src/pdf/ocr.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
var DEFAULT_TIMEOUT_MS = 3e5;
var DEFAULT_MAX_DOCS = 3;
var DEFAULT_LANG = "eng";
var spent = 0;
function ocrBudgetLeft() {
  return Math.max(0, envInt("OCR_MAX", DEFAULT_MAX_DOCS) - spent);
}
async function ocrTools() {
  const probe = async (cmd, args) => (await runWithInput(cmd, args, Buffer.alloc(0), 2e4)).ok;
  const [copyablePdf, tesseract] = await Promise.all([probe("copyable-pdf", ["--help"]), probe("tesseract", ["--version"])]);
  return { copyablePdf, tesseract };
}
async function ocrPdf(bytes) {
  if (ocrBudgetLeft() <= 0) return void 0;
  const { copyablePdf, tesseract } = await ocrTools();
  if (!copyablePdf || !tesseract) return void 0;
  const dir = mkdtempSync(join(tmpdir(), `${brand().name}-ocr-`));
  try {
    const input = join(dir, "in.pdf");
    const output = join(dir, "out.pdf");
    writeFileSync(input, bytes);
    const lang = env("OCR_LANG") || DEFAULT_LANG;
    const r = await runWithInput("copyable-pdf", ["-o", output, "-m", "-l", lang, input], Buffer.alloc(0), envInt("OCR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
    spent++;
    if (!r.ok) return void 0;
    const md = output.replace(/\.pdf$/, ".md");
    return existsSync(md) ? readFileSync(md, "utf8") : void 0;
  } catch {
    return void 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// src/pdf/ladder.ts
var PDF_EXTRACTORS = ["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native", "ocr"];
var NPX_TIMEOUT_MS2 = 9e4;
var PDFTOTEXT_TIMEOUT_MS = 6e4;
var dead2 = /* @__PURE__ */ new Set();
function enabledExtractors(engines) {
  if (engines) return engines;
  const forced = env("PDF_ENGINE");
  if (forced && PDF_EXTRACTORS.includes(forced)) return [forced];
  if (envFlag("NO_NPX")) return PDF_EXTRACTORS.filter((e) => e !== "pdf-inspector" && e !== "anydoc");
  return PDF_EXTRACTORS;
}
async function viaAnydoc2(bytes) {
  const r = await runWithInput("npx", ["-y", "--prefer-offline", ANYDOC_SPEC, "-", "--format", "pdf"], bytes, NPX_TIMEOUT_MS2);
  return r.ok ? r.stdout : void 0;
}
async function viaPdfInspector(bytes) {
  const r = await runWithInput("npx", ["-y", "--prefer-offline", PDF_INSPECTOR_SPEC, "-"], bytes, NPX_TIMEOUT_MS2);
  return r.ok ? r.stdout : void 0;
}
async function viaPdftotext(bytes) {
  const r = await runWithInput("pdftotext", ["-layout", "-", "-"], bytes, PDFTOTEXT_TIMEOUT_MS);
  return r.ok ? r.stdout : void 0;
}
async function extractPdf(bytes, opts = {}) {
  let lastReason;
  for (const id of enabledExtractors(opts.engines)) {
    if (dead2.has(id)) continue;
    if (id === "ocr" && ocrBudgetLeft() <= 0) {
      lastReason = `scanned PDF, and this run's OCR budget is spent (raise ${envName("OCR_MAX")})`;
      continue;
    }
    let text;
    try {
      if (id === "pdf-inspector") text = await viaPdfInspector(bytes);
      else if (id === "anydoc") text = await viaAnydoc2(bytes);
      else if (id === "pdftotext") text = await viaPdftotext(bytes);
      else if (id === "firecrawl") text = opts.firecrawl ? await opts.firecrawl() : void 0;
      else if (id === "ocr") text = await ocrPdf(bytes);
      else text = pdfToText(bytes);
    } catch {
      text = void 0;
    }
    if (text === void 0) {
      if (id !== "firecrawl") dead2.add(id);
      continue;
    }
    const verdict = assessPdfText(text);
    if (verdict.ok) return { text: text.trim(), via: id };
    lastReason = verdict.reason;
  }
  return { text: "", reason: lastReason ?? "no PDF extractor available" };
}

// src/charset.ts
function bomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) return { encoding: "utf-8", skip: 3 };
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) return { encoding: "utf-16le", skip: 2 };
  if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) return { encoding: "utf-16be", skip: 2 };
  return void 0;
}
var CHARSET_IN_CONTENT_TYPE = /charset\s*=\s*["']?([a-z0-9_:.+-]+)/i;
function charsetFromContentType(contentType) {
  return CHARSET_IN_CONTENT_TYPE.exec(contentType ?? "")?.[1]?.toLowerCase();
}
function charsetFromHtml(head) {
  const window = head.slice(0, 4096);
  const direct = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_:.+-]+)/i.exec(window);
  if (direct) return direct[1].toLowerCase();
  const httpEquiv = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.+-]+)/i.exec(window);
  return httpEquiv?.[1]?.toLowerCase();
}
function decodeBody(bytes, contentType = "") {
  const bom = bomEncoding(bytes);
  if (bom) return decodeWith(bytes.subarray(bom.skip), bom.encoding);
  const declared = charsetFromContentType(contentType);
  if (declared && declared !== "utf-8" && declared !== "utf8") return decodeWith(bytes, declared);
  if (declared) return bytes.toString("utf8");
  const meta = charsetFromHtml(bytes.subarray(0, 4096).toString("latin1"));
  if (meta && meta !== "utf-8" && meta !== "utf8") return decodeWith(bytes, meta);
  return bytes.toString("utf8");
}
function decodeWith(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

// src/text.ts
var STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "how",
  "what",
  "why",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "of",
  "in",
  "on",
  "to",
  "for",
  "with",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "than",
  "as",
  "at",
  "by",
  "from",
  "into",
  "about",
  "it",
  "its",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "there",
  "here",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "have",
  "has",
  "had",
  "not",
  "no",
  "yes",
  "so",
  "such",
  "only",
  "any",
  "some",
  "all",
  "get",
  "set",
  "use",
  "used",
  "using",
  "work",
  "works",
  "working",
  "handle",
  "handled",
  "happen",
  "happens",
  "default",
  "value",
  "values",
  "please",
  "explain",
  "tell",
  "me",
  "my",
  "our",
  "le",
  "la",
  "les",
  "de",
  "des",
  "du",
  "un",
  "une",
  "est",
  "sont",
  "que",
  "qui",
  "quoi",
  "quel",
  "quelle",
  "quels",
  "quelles",
  "pour",
  "dans",
  "avec",
  "entre",
  "sur",
  "par",
  "pas",
  "plus",
  "et",
  "ou",
  "o\xF9",
  "ce",
  "cette",
  "ces",
  "se",
  "sa",
  "son",
  "ses",
  "leur",
  "leurs",
  "comment",
  "pourquoi",
  "quand",
  "fait",
  "faire",
  "peut",
  "doit",
  "\xEAtre",
  "avoir",
  "il",
  "elle",
  "nous",
  "vous",
  "ils",
  "elles",
  "au",
  "aux",
  "si",
  "ne"
]);
function isStopword(term) {
  const t = term.toLowerCase();
  if (STOPWORDS.has(t)) return true;
  const extra = brand().extraStopwords;
  return extra ? extra.some((w) => w.toLowerCase() === t) : false;
}
var ACCENT_CLASSES = {
  a: "a\xE0\xE1\xE2\xE3\xE4\xE5\u0101\u0103\u0105",
  c: "c\xE7\u0107\u0109\u010B\u010D",
  d: "d\u010F\u0111",
  e: "e\xE8\xE9\xEA\xEB\u0113\u0115\u0117\u0119\u011B",
  g: "g\u011D\u011F\u0121\u0123",
  i: "i\xEC\xED\xEE\xEF\u0129\u012B\u012D\u012F\u0131",
  l: "l\u013A\u013C\u013E\u0140\u0142",
  n: "n\xF1\u0144\u0146\u0148",
  o: "o\xF2\xF3\xF4\xF5\xF6\xF8\u014D\u014F\u0151",
  r: "r\u0155\u0157\u0159",
  s: "s\u015B\u015D\u015F\u0161",
  t: "t\u0163\u0165\u0167",
  u: "u\xF9\xFA\xFB\xFC\u0169\u016B\u016D\u016F\u0171\u0173",
  y: "y\xFD\xFF\u0177",
  z: "z\u017A\u017C\u017E"
};
var BASE_OF = /* @__PURE__ */ new Map();
for (const [base, cls] of Object.entries(ACCENT_CLASSES)) {
  for (const ch of cls) BASE_OF.set(ch, base);
}
function baseChar(ch) {
  const known = BASE_OF.get(ch);
  if (known) return known;
  const stripped = ch.normalize("NFD").replace(new RegExp("\\p{M}+", "gu"), "");
  return stripped.length === 1 ? stripped : ch;
}
function deaccent(s) {
  let out = "";
  for (const ch of s) out += baseChar(ch);
  return out;
}
function foldPlural(t) {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && /(?:[sxz]|[cs]h)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !/(?:ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}
function foldTerm(raw) {
  return foldPlural(deaccent(raw.toLowerCase()));
}
function slugify(input, opts = {}) {
  const s = input.toLowerCase().replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/\.git$/, "").replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, opts.max ?? 120);
  return s || (opts.fallback ?? "");
}

// src/firecrawl.ts
var FIRECRAWL_DEFAULT_BASE = "http://localhost:3002";
var PROBE_TIMEOUT_MS = 2e3;
var SCRAPE_TIMEOUT_MS = 45e3;
var SEARCH_TIMEOUT_MS = 3e4;
var SCRAPE_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
function firecrawlBase(opts = {}) {
  const raw = (opts.firecrawl ?? env("FIRECRAWL") ?? FIRECRAWL_DEFAULT_BASE).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/+$/, "");
}
function firecrawlIsExplicit(opts = {}) {
  return !!(opts.firecrawl ?? env("FIRECRAWL"));
}
function authHeaders() {
  const key = env("FIRECRAWL_KEY");
  return key ? { authorization: `Bearer ${key}` } : void 0;
}
var probeCache = /* @__PURE__ */ new Map();
function looksLikeFirecrawl(contentType, body) {
  if (/firecrawl/i.test(body.slice(0, 4096))) return true;
  return !/^\s*text\/html/i.test(contentType ?? "");
}
function probeFirecrawl(base, explicit = false) {
  const key = `${base}|${explicit}`;
  let p = probeCache.get(key);
  if (!p) {
    p = (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/`, { signal: ctrl.signal });
        const body = await res.text().catch(() => "");
        return explicit || looksLikeFirecrawl(res.headers.get("content-type"), body);
      } catch {
        return false;
      } finally {
        clearTimeout(t);
      }
    })();
    probeCache.set(key, p);
  }
  return p;
}
var prefixCache = /* @__PURE__ */ new Map();
function apiPrefix(base) {
  return prefixCache.get(base) ?? "/v2";
}
async function postJson(base, path, body, timeoutMs) {
  const headers = authHeaders();
  const first = await httpJson("POST", `${base}${apiPrefix(base)}${path}`, body, { timeoutMs, headers });
  if (first.status !== 404 || apiPrefix(base) !== "/v2") return first;
  prefixCache.set(base, "/v1");
  return httpJson("POST", `${base}/v1${path}`, body, { timeoutMs, headers });
}
function mapScrapeResponse(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  if (json.success === false) return null;
  const data = json.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const markdown = typeof data.markdown === "string" ? data.markdown.trim() : "";
  if (!markdown) return null;
  const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const rawTitle = typeof meta.title === "string" ? cleanInline(meta.title) : "";
  const src = typeof meta.sourceURL === "string" ? meta.sourceURL : typeof meta.url === "string" ? meta.url : void 0;
  const status = typeof meta.statusCode === "number" ? meta.statusCode : void 0;
  return {
    markdown,
    ...rawTitle ? { title: rawTitle } : {},
    ...src ? { sourceURL: src } : {},
    ...status !== void 0 ? { statusCode: status } : {}
  };
}
function mapSearchResponse(json) {
  if (!json || typeof json !== "object") return [];
  if (json.success === false) return [];
  const data = json.data;
  const web = Array.isArray(data) ? data : Array.isArray(data?.web) ? data.web : Array.isArray(data?.results) ? data.results : [];
  const out = [];
  for (const x of web) {
    if (!x || typeof x.url !== "string" || !x.url) continue;
    out.push({
      url: x.url,
      // `||` (not `??`): an empty title degrades to the URL, never blank.
      title: cleanInline(String(x.title || x.url)),
      description: cleanInline(String(x.description ?? x.snippet ?? "")).slice(0, 360),
      ...typeof x.markdown === "string" && x.markdown.trim() ? { markdown: x.markdown } : {}
    });
  }
  return out;
}
async function scrapeViaFirecrawl(url, opts = {}) {
  const base = firecrawlBase(opts);
  if (!base) return {};
  if (!await probeFirecrawl(base, firecrawlIsExplicit(opts))) {
    return firecrawlIsExplicit(opts) ? { why: `Firecrawl not reachable at ${base} \u2014 used the built-in extractor.` } : {};
  }
  const r = await postJson(
    base,
    "/scrape",
    {
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      blockAds: true,
      removeBase64Images: true,
      maxAge: SCRAPE_MAX_AGE_MS,
      timeout: SCRAPE_TIMEOUT_MS
    },
    SCRAPE_TIMEOUT_MS
  );
  if (!r.ok) {
    const why = r.status ? `status ${r.status}` : r.error ?? "no response";
    return { why: `Firecrawl could not scrape ${url} (${why}) \u2014 fell back to the built-in extractor.` };
  }
  const data = mapScrapeResponse(r.data);
  if (!data) return { why: `Firecrawl returned no markdown for ${url} \u2014 fell back to the built-in extractor.` };
  return { data };
}
async function searchViaFirecrawl(query, limit, opts = {}) {
  const base = firecrawlBase(opts);
  if (!base) return { why: `Firecrawl disabled (--firecrawl off / ${envName("FIRECRAWL")}=off). Skipping.` };
  if (!await probeFirecrawl(base, firecrawlIsExplicit(opts))) {
    return { why: `Firecrawl not reachable at ${base} (bring it up with \`${brand().cli} firecrawl up\`). Skipping.` };
  }
  const r = await postJson(base, "/search", { query, limit, sources: ["web"] }, SEARCH_TIMEOUT_MS);
  if (!r.ok) {
    const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status || 0})`;
    return { why: `Firecrawl search ${why} at ${base}.` };
  }
  return { hits: mapSearchResponse(r.data) };
}

// src/fetch.ts
var DEFAULT_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
function browserUa() {
  return env("UA") || DEFAULT_BROWSER_UA;
}
function contactUa() {
  const b = brand();
  return `${b.name}/1.x (+${b.contactUrl ?? `https://github.com/maxgfr/${b.name}`})`;
}
var RETRY_STATUS = /* @__PURE__ */ new Set([429, 503, 502, 504]);
var maxAttempts = () => envInt("MAX_ATTEMPTS", 2, 1, 5);
var defaultRetryMs = () => envInt("RETRY_MS", 600, 0, 5e3);
function pageDelayMs() {
  return envInt("PAGE_DELAY_MS", 350, 0, 5e3);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function detectRateLimited(status, headers) {
  if (status === 429) return true;
  return status === 403 && headers.get("x-ratelimit-remaining") === "0";
}
function parseRetryAfter(headers, capMs = 5e3) {
  const h = headers.get("retry-after");
  if (!h) return void 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs) * 1e3, capMs);
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), capMs);
  return void 0;
}
function retryDelayMs(headers) {
  return parseRetryAfter(headers) ?? defaultRetryMs();
}
async function readCappedBytes(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const remaining = max - total;
    if (chunk.length >= remaining) {
      chunks.push(chunk.subarray(0, remaining));
      await reader.cancel().catch(() => {
      });
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks);
}
async function httpGet(url, opts = {}) {
  let last = { ok: false, status: 0, body: "", contentType: "", url };
  for (let attempt = 0; attempt < maxAttempts(); attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2e4);
    try {
      const headers = { "user-agent": opts.userAgent ?? browserUa(), accept: opts.accept ?? "*/*" };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers
      });
      const max = opts.maxBytes ?? 4 * 1024 * 1024;
      const meta = {
        contentType: res.headers.get("content-type") ?? "",
        url: res.url || url,
        etag: res.headers.get("etag") ?? void 0,
        lastModified: res.headers.get("last-modified") ?? void 0,
        rateLimited: detectRateLimited(res.status, res.headers),
        retryAfterMs: parseRetryAfter(res.headers)
      };
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > max) {
        ctrl.abort();
        return { ok: false, status: res.status, body: "", ...meta, error: `response too large: ${declared} bytes > ${max} cap` };
      }
      const bytes = res.status === 304 ? Buffer.alloc(0) : await readCappedBytes(res, max);
      const result = {
        ok: res.ok,
        status: res.status,
        // Decoded per the response's own encoding, not assumed UTF-8. A
        // Windows-1252 page used to come back with every accented character
        // replaced by U+FFFD, and nothing anywhere noticed.
        body: opts.binary ? "" : decodeBody(bytes, meta.contentType),
        bytes: opts.binary ? bytes : void 0,
        ...meta
      };
      if (RETRY_STATUS.has(res.status) && attempt < maxAttempts() - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, body: "", contentType: "", url, error: e.message };
      if (attempt < maxAttempts() - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
async function httpJson(method, url, body, opts = {}) {
  let last = { ok: false, status: 0, data: void 0 };
  for (let attempt = 0; attempt < maxAttempts(); attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2e4);
    try {
      const headers = {
        "content-type": "application/json",
        accept: opts.accept ?? "application/json",
        "user-agent": opts.userAgent ?? browserUa()
      };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers,
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : void 0;
      } catch {
        data = text;
      }
      const result = { ok: res.ok, status: res.status, data };
      if (RETRY_STATUS.has(res.status) && attempt < maxAttempts() - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, data: void 0, error: e.message };
      if (attempt < maxAttempts() - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
var ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "\u2014",
  "&ndash;": "\u2013",
  "&hellip;": "\u2026",
  "&copy;": "\xA9",
  // Typographic punctuation CMSes emit as named refs (WordPress "smart" text) —
  // otherwise a curly quote/apostrophe leaks into the report prose verbatim.
  "&lsquo;": "\u2018",
  "&rsquo;": "\u2019",
  "&sbquo;": "\u201A",
  "&ldquo;": "\u201C",
  "&rdquo;": "\u201D",
  "&bdquo;": "\u201E",
  "&bull;": "\u2022",
  "&middot;": "\xB7",
  "&laquo;": "\xAB",
  "&raquo;": "\xBB",
  "&deg;": "\xB0",
  "&plusmn;": "\xB1",
  "&times;": "\xD7",
  "&divide;": "\xF7",
  "&frac12;": "\xBD",
  "&frac14;": "\xBC",
  "&frac34;": "\xBE",
  "&sup2;": "\xB2",
  "&sup3;": "\xB3",
  "&micro;": "\xB5",
  "&trade;": "\u2122",
  "&reg;": "\xAE",
  "&sect;": "\xA7",
  "&para;": "\xB6",
  "&dagger;": "\u2020",
  "&Dagger;": "\u2021",
  "&prime;": "\u2032",
  "&Prime;": "\u2033",
  "&iexcl;": "\xA1",
  "&iquest;": "\xBF",
  "&cent;": "\xA2",
  "&pound;": "\xA3",
  "&curren;": "\xA4",
  "&yen;": "\xA5",
  "&euro;": "\u20AC",
  // Latin-1 accented letters — pervasive in non-English titles/snippets.
  "&agrave;": "\xE0",
  "&aacute;": "\xE1",
  "&acirc;": "\xE2",
  "&atilde;": "\xE3",
  "&auml;": "\xE4",
  "&aring;": "\xE5",
  "&aelig;": "\xE6",
  "&ccedil;": "\xE7",
  "&egrave;": "\xE8",
  "&eacute;": "\xE9",
  "&ecirc;": "\xEA",
  "&euml;": "\xEB",
  "&igrave;": "\xEC",
  "&iacute;": "\xED",
  "&icirc;": "\xEE",
  "&iuml;": "\xEF",
  "&ntilde;": "\xF1",
  "&ograve;": "\xF2",
  "&oacute;": "\xF3",
  "&ocirc;": "\xF4",
  "&otilde;": "\xF5",
  "&ouml;": "\xF6",
  "&oslash;": "\xF8",
  "&ugrave;": "\xF9",
  "&uacute;": "\xFA",
  "&ucirc;": "\xFB",
  "&uuml;": "\xFC",
  "&yacute;": "\xFD",
  "&yuml;": "\xFF",
  "&szlig;": "\xDF",
  "&Agrave;": "\xC0",
  "&Aacute;": "\xC1",
  "&Acirc;": "\xC2",
  "&Auml;": "\xC4",
  "&Aring;": "\xC5",
  "&AElig;": "\xC6",
  "&Ccedil;": "\xC7",
  "&Egrave;": "\xC8",
  "&Eacute;": "\xC9",
  "&Ecirc;": "\xCA",
  "&Euml;": "\xCB",
  "&Iacute;": "\xCD",
  "&Ntilde;": "\xD1",
  "&Oacute;": "\xD3",
  "&Ouml;": "\xD6",
  "&Oslash;": "\xD8",
  "&Uacute;": "\xDA",
  "&Uuml;": "\xDC"
};
function decodeEntities(s) {
  let out = s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => {
    try {
      return String.fromCodePoint(parseInt(h, 16));
    } catch {
      return " ";
    }
  });
  out = out.replace(/&#(\d+);/g, (_m, n) => {
    try {
      return String.fromCodePoint(Number(n));
    } catch {
      return " ";
    }
  });
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out;
}
function cleanInline(s) {
  return decodeEntities(String(s)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function htmlToText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|head|nav|footer|svg|template)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<h([1-6])(?:\s[^>]*)?>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ");
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote|br)>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join("\n");
}
function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return void 0;
  const t = decodeEntities(m[1].replace(/\s+/g, " ").trim());
  return t || void 0;
}
function htmlCanonicalUrl(html) {
  const head = html.slice(0, 6e4);
  const canonical = /<link\b[^>]*\brel=["']?canonical["']?[^>]*>/i.exec(head)?.[0];
  const og = /<meta\b[^>]*\bproperty=["']?og:url["']?[^>]*>/i.exec(head)?.[0];
  for (const tag of [canonical, og]) {
    const href = tag && /\b(?:href|content)=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href?.trim()) return decodeEntities(href.trim());
  }
  return void 0;
}
function sliceToMatchingClose(html, start, tag) {
  const re = new RegExp(`<${tag}\\b|</${tag}\\s*>`, "gi");
  re.lastIndex = start;
  let depth = 1;
  let m;
  while (m = re.exec(html)) {
    if (m[0][1] === "/") {
      if (--depth === 0) return html.slice(start, m.index);
    } else {
      depth++;
    }
  }
  return null;
}
function extractMainHtml(html) {
  const visible = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
  const tiers = [
    /<(main)\b[^>]*>/gi,
    /<(article)\b[^>]*>/gi,
    /<(div|section)\b[^>]*\b(?:id|class)="[^"]*\b(?:content|article|post|entry|story|markdown-body|main|prose)\b[^"]*"[^>]*>/gi
  ];
  let candidates = [];
  for (const re of tiers) {
    const found = [];
    re.lastIndex = 0;
    let m;
    while (m = re.exec(html)) {
      const inner = sliceToMatchingClose(html, re.lastIndex, m[1].toLowerCase());
      if (inner !== null) found.push(inner);
    }
    if (found.length) {
      candidates = found;
      break;
    }
  }
  if (!candidates.length) return html;
  let best = candidates[0];
  let bestLen = visible(best);
  for (const c of candidates.slice(1)) {
    const len = visible(c);
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  const fullLen = visible(html);
  if (bestLen < 500 && bestLen < fullLen * 0.3) return html;
  return best;
}
var PDF_URL_RE = /\.pdf($|[?#])/i;
var PDF_ROUTE_RE = /\/pdf\/[^/?#]+($|[?#])/i;
var NON_PDF_TAIL_RE = /\.(html?|php|aspx?|jsp|json|xml|txt|md|csv)($|[?#])/i;
function looksLikePdfUrl(url) {
  if (PDF_URL_RE.test(url)) return true;
  return PDF_ROUTE_RE.test(url) && !NON_PDF_TAIL_RE.test(url);
}
var PDF_FETCH_OPTS = { accept: "application/pdf,*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
var DOC_FETCH_OPTS = { accept: "*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
async function fetchAndExtract(url, opts = {}) {
  const wantsPdf = looksLikePdfUrl(url);
  const wantsDoc = wantsPdf ? void 0 : docFormatForUrl(url);
  let firecrawlNote;
  if (!wantsPdf && !wantsDoc) {
    const fc = await scrapeViaFirecrawl(url, opts);
    if (fc.data && (fc.data.statusCode ?? 200) < 400) {
      return {
        text: fc.data.markdown,
        title: fc.data.title,
        finalUrl: fc.data.sourceURL || url,
        status: fc.data.statusCode ?? 200,
        extractor: "firecrawl"
      };
    }
    firecrawlNote = fc.data ? `Firecrawl got HTTP ${fc.data.statusCode} for ${url} \u2014 fell back to the built-in extractor.` : fc.why;
  }
  const base = wantsPdf ? PDF_FETCH_OPTS : wantsDoc ? DOC_FETCH_OPTS : { accept: "text/html,text/plain,*/*", acceptLanguage: opts.acceptLanguage };
  const fetchOpts = opts.headers ? { ...base, headers: opts.headers } : base;
  const res = await httpGet(url, fetchOpts);
  if (res.status === 304) {
    return { text: "", finalUrl: res.url, status: 304, etag: res.etag ?? opts.headers?.["if-none-match"], lastModified: res.lastModified };
  }
  if (!res.ok) {
    const why = res.status === 429 ? "rate-limited (HTTP 429)" : `status ${res.status}${res.error ? ", " + res.error : ""}`;
    return { text: "", finalUrl: res.url, status: res.status, note: `Could not fetch ${url} (${why}).` };
  }
  const validators = res.etag || res.lastModified ? { etag: res.etag, lastModified: res.lastModified } : {};
  if (wantsPdf || /application\/pdf/i.test(res.contentType)) {
    const bytes = res.bytes ?? (await httpGet(url, PDF_FETCH_OPTS)).bytes;
    const got = bytes ? await extractPdf(bytes, {
      firecrawl: async () => {
        const fc = await scrapeViaFirecrawl(url, opts);
        return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : void 0;
      }
    }) : { text: "", reason: "empty response body" };
    return {
      text: got.text,
      finalUrl: res.url,
      status: res.status,
      // `native` keeps reporting as absent, which is what the cache key and every
      // existing dossier already assume.
      extractor: got.via && got.via !== "native" ? got.via : void 0,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text \u2014 ${got.reason}.`,
      ...validators
    };
  }
  const docFmt = wantsDoc ?? docFormatForContentType(res.contentType);
  if (docFmt) {
    const bytes = res.bytes ?? (await httpGet(url, DOC_FETCH_OPTS)).bytes;
    const got = bytes ? await extractDocument(bytes, docFmt, {
      firecrawl: async () => {
        const fc = await scrapeViaFirecrawl(url, opts);
        return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : void 0;
      }
    }) : { text: "", reason: "empty response body" };
    if (!got.text && docFmt.textFallback && bytes?.length) {
      return { text: bytes.toString("utf8"), finalUrl: res.url, status: res.status, note: firecrawlNote, ...validators };
    }
    return {
      text: got.text,
      finalUrl: res.url,
      status: res.status,
      extractor: got.via,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text \u2014 ${got.reason}.`,
      ...validators
    };
  }
  const isHtml = /html/i.test(res.contentType) || /^\s*</.test(res.body);
  const text = isHtml ? htmlToText(extractMainHtml(res.body)) : res.body;
  const title = isHtml ? htmlTitle(res.body) : void 0;
  const canonical = isHtml ? htmlCanonicalUrl(res.body) : void 0;
  return { text, title, canonical, finalUrl: res.url, status: res.status, note: firecrawlNote, ...validators };
}

// src/stack.ts
import { spawnSync } from "child_process";
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { tmpdir as tmpdir2 } from "os";
import { dirname, join as join2 } from "path";
var COMPOSE_YAML = `# Optional, fully-local, no-API-key stack for a semantic mode, web
# search and content extraction. Start it with \`{{CLI}} semantic up\` (or
# \`docker compose --profile all up -d\`). The published bundle stays
# dependency-free \u2014 it only speaks HTTP to these containers on localhost;
# nothing here is required for Tier-1 retrieval.
#
# Profiles let you start subsets:
#   --profile semantic  \u2192 qdrant + ollama (vector search)
#   --profile search    \u2192 searxng (web discovery)
#   --profile all       \u2192 everything above
#   --profile extract   \u2192 firecrawl (content cleaning; \`{{CLI}} firecrawl up\`)
# \u2500\u2500 One stack, however many tools use it \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
# Any tool needing SearXNG or Firecrawl binds the SAME host ports. Run two from
# separate compose projects and only one can ever be up: the second fails with
# "port is already allocated", after leaving its sidecars running.
#
# So this file uses one fixed project name, one set of container names and one
# set of volumes. A second tool bringing the stack up is a no-op against the
# containers already running, and the whole thing costs one machine's worth of
# RAM rather than one per tool.
#
# WARNING: any tool shipping its own copy of these service blocks must keep them
# byte-identical. Docker compares the RESOLVED config, so a divergence makes an
# up from one recreate the other's running containers.

name: skills

services:
  # Vector database \u2014 Apache-2.0, self-hosted, no key.
  qdrant:
    image: qdrant/qdrant:v1.18.2
    container_name: skills-qdrant
    ports:
      - "6333:6333"
    volumes:
      - qdrant:/qdrant/storage
    restart: unless-stopped
    profiles: ["semantic", "all"]
    healthcheck:
      # The image ships no curl/wget \u2014 probe the REST port over bash's /dev/tcp.
      test: ["CMD-SHELL", "bash -c ':> /dev/tcp/127.0.0.1/6333' || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  # Local embedding server \u2014 no key, no data leaves the machine. Pull the model
  # once: \`docker compose exec ollama ollama pull nomic-embed-text\`
  # (\`{{CLI}} semantic up\` does this for you).
  ollama:
    image: ollama/ollama:0.30.7
    container_name: skills-ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama:/root/.ollama
    restart: unless-stopped
    profiles: ["semantic", "all"]
    healthcheck:
      test: ["CMD", "ollama", "list"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  # Self-hosted metasearch for keyless web discovery. JSON output is enabled in
  # docker/searxng/settings.yml so the engine can be queried programmatically.
  # Also backs Firecrawl's keyless /search through SEARXNG_ENDPOINT.
  searxng:
    image: searxng/searxng:2026.6.11-a1490676e
    container_name: skills-searxng
    ports:
      - "8888:8080"
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888/
    volumes:
      - ./docker/searxng:/etc/searxng:rw
    restart: unless-stopped
    profiles: ["search", "all"]
    healthcheck:
      # busybox wget is in the image; /healthz answers on the container port.
      test: ["CMD-SHELL", "wget -qO- http://localhost:8080/healthz || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  # Self-hosted Firecrawl \u2014 keyless content cleaning. Fetches a page with a real
  # browser and returns main-content markdown, which beats the built-in regex
  # HTML stripper on nav/cookie chrome and is the only way JS-rendered pages
  # yield any text at all. Keyless because USE_DB_AUTHENTICATION=false; see
  # docker/firecrawl/firecrawl.env for the tunables.
  #
  # Deliberately NOT in the "all" profile: it is ~3 GB of images and 5
  # containers, and \`{{CLI}} semantic up\` must stay cheap.
  #
  #   docker compose --profile search --profile extract up -d --wait
  firecrawl:
    image: ghcr.io/firecrawl/firecrawl:2.10.5@sha256:8ce1af201332e1de046d70d5d516fbfe7f0f6229820d271d880873eeca531ea6
    container_name: skills-firecrawl
    ports:
      - "3002:3002"
    env_file:
      - ./docker/firecrawl/firecrawl.env
    environment:
      # Wiring lives here; tunables live in the env file above.
      - HOST=0.0.0.0
      - PORT=3002
      - ENV=local
      - REDIS_URL=redis://firecrawl-redis:6379
      - REDIS_RATE_LIMIT_URL=redis://firecrawl-redis:6379
      - PLAYWRIGHT_MICROSERVICE_URL=http://firecrawl-playwright:3000/scrape
      - POSTGRES_HOST=firecrawl-postgres
      - NUQ_RABBITMQ_URL=amqp://firecrawl-rabbitmq:5672
      # Keeps /search keyless by delegating to the searxng service above.
      # Unreachable when the \`search\` profile is down \u2014 Firecrawl then falls
      # back to DuckDuckGo on its own.
      - SEARXNG_ENDPOINT=http://searxng:8080
    command: node dist/src/harness.js --start-docker
    depends_on:
      firecrawl-redis:
        condition: service_started
      firecrawl-playwright:
        condition: service_started
      firecrawl-postgres:
        condition: service_started
      firecrawl-rabbitmq:
        condition: service_healthy
    restart: unless-stopped
    profiles: ["extract"]
    # The image ships no curl/wget, but it is a Node image \u2014 probe with node.
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3002/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 60s
    # Trimmed for a 16 GB laptop; upstream asks for 4 CPU / 8 GB. Measured at
    # 2.3 GB steady under 5 concurrent scrapes, so 3 GB was too tight a cap \u2014
    # MAX_RAM=0.8 in the env file makes Firecrawl self-throttle at ~3.2 GB.
    cpus: 2.0
    mem_limit: 4g
    memswap_limit: 4g

  # Headless-browser sidecar \u2014 this is what makes JS-rendered pages extractable.
  firecrawl-playwright:
    image: ghcr.io/firecrawl/playwright-service:latest@sha256:8c50add7293201e575110e6c7489fa383a9dfc46f168936526a458e06ffc5c28
    container_name: skills-firecrawl-playwright
    environment:
      - PORT=3000
      - BLOCK_MEDIA=true
      - MAX_CONCURRENT_PAGES=4
    restart: unless-stopped
    profiles: ["extract"]
    cpus: 1.5
    mem_limit: 2g
    memswap_limit: 2g
    tmpfs:
      - /tmp/.cache:noexec,nosuid,size=512m

  firecrawl-redis:
    image: redis:alpine
    container_name: skills-firecrawl-redis
    command: redis-server --bind 0.0.0.0
    restart: unless-stopped
    profiles: ["extract"]

  firecrawl-rabbitmq:
    image: rabbitmq:3-management
    container_name: skills-firecrawl-rabbitmq
    restart: unless-stopped
    profiles: ["extract"]
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "check_running"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s

  firecrawl-postgres:
    image: ghcr.io/firecrawl/nuq-postgres:latest@sha256:aed86f62858f29bd971abddcdeb301c12888098d2cf5d33c1ba42b053bc460f6
    container_name: skills-firecrawl-postgres
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=postgres
    volumes:
      - firecrawl_pg:/var/lib/postgresql/data
    restart: unless-stopped
    profiles: ["extract"]

volumes:
  qdrant:
  ollama:
  firecrawl_pg:
`;
var SEARXNG_SETTINGS_YAML = `# Minimal SearXNG config for keyless, self-hosted web discovery. The important
# bit is enabling the JSON output format so the CLI can query it
# programmatically (\`/search?format=json\`) \u2014 most PUBLIC instances disable it,
# which is why a local one ships here.
#
# The service names and ports below are deliberately stable, so several tools on
# one machine share a single container rather than each starting their own.
use_default_settings: true

server:
  # Override with a real random secret if you expose this beyond localhost.
  secret_key: "searxng-local-dev-change-me"
  # The limiter/bot-detection middleware answers 403 to format=json requests.
  limiter: false
  image_proxy: false

search:
  safe_search: 0
  autocomplete: ""
  formats:
    - html
    - json
`;
var FIRECRAWL_ENV = `# Tunables for the self-hosted Firecrawl stack (docker compose --profile extract).
# Wiring (hostnames, ports, SEARXNG_ENDPOINT) lives in docker-compose.yml and
# overrides anything set here.

# THIS is what makes the API keyless. Turning it on would require a Supabase
# project; there is no reason to for a localhost stack.
USE_DB_AUTHENTICATION=false

# Firecrawl's Rust PDF extractor, which is OFF by default upstream. Without it
# Firecrawl falls back to pdf-parse (JS) for PDFs. Still keyless: this is the
# local Rust path, not the MinerU / Fire PDF routes, which need API credentials.
# Reached as a rung of the PDF ladder when the built-in reader finds no text.
PDF_RUST_EXTRACT_ENABLE=true

# Postgres credentials for the bundled nuq-postgres container. It is not
# published on a host port, so these never leave the compose network.
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=postgres
POSTGRES_PORT=5432

# Admin queue dashboard at http://localhost:3002/admin/CHANGEME/queues
BULL_AUTH_KEY=CHANGEME

# Concurrency, trimmed for a laptop. Upstream defaults are 8/5/5/10 and assume
# a 4-CPU / 8-GB box; these keep the stack near ~4 GB total.
NUM_WORKERS_PER_QUEUE=2
MAX_CONCURRENT_JOBS=3
BROWSER_POOL_SIZE=2
CRAWL_CONCURRENT_REQUESTS=4

# Back off before the host runs out of headroom.
MAX_CPU=0.8
MAX_RAM=0.8

LOGGING_LEVEL=info
`;
function renderAsset(template) {
  return template.replaceAll("{{CLI}}", brand().cli);
}
function cacheRoot() {
  return env("CACHE_DIR") ?? brand().cacheDir ?? join2(tmpdir2(), brand().name);
}
function ensureComposeMaterialized() {
  const base = join2(cacheRoot(), "compose");
  const composePath = join2(base, "docker-compose.yml");
  const settingsPath = join2(base, "docker", "searxng", "settings.yml");
  const firecrawlEnvPath = join2(base, "docker", "firecrawl", "firecrawl.env");
  writeIfChanged(composePath, renderAsset(COMPOSE_YAML));
  writeIfChanged(settingsPath, renderAsset(SEARXNG_SETTINGS_YAML));
  writeIfChanged(firecrawlEnvPath, renderAsset(FIRECRAWL_ENV));
  return composePath;
}
function writeIfChanged(path, content) {
  try {
    if (existsSync2(path) && readFileSync2(path, "utf8") === content) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync2(path, content);
  } catch {
  }
}
var DEFAULT_PULL_TIMEOUT_MS = 12e5;
var UP_TIMEOUT_MS = 3e5;
var DOWN_TIMEOUT_MS = 12e4;
var PS_TIMEOUT_MS = 3e4;
var MODEL_PULL_TIMEOUT_MS = 6e5;
function pullTimeoutMs() {
  return envInt("DOCKER_PULL_TIMEOUT_MS", DEFAULT_PULL_TIMEOUT_MS);
}
function embedModel() {
  return env("EMBED_MODEL") ?? "nomic-embed-text";
}
function defaultRun(cmd, args, opts) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: opts.capture ? "pipe" : "inherit"
  });
  const missing = !!res.error && res.error.code === "ENOENT";
  return {
    ok: !res.error && res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
    missing
  };
}
function defaultHas(cmd) {
  const probe = defaultRun(process.platform === "win32" ? "where" : "which", [cmd], { timeoutMs: 1e4, capture: true });
  return probe.ok && probe.stdout.trim().length > 0;
}
var STACKS = {
  searxng: {
    profiles: ["search"],
    summary: "SearXNG is up (:8888) \u2014 keyless discovery, JSON API enabled."
  },
  firecrawl: {
    profiles: ["search", "extract"],
    summary: "Firecrawl is up (:3002 \xB7 playwright \xB7 redis \xB7 rabbitmq \xB7 postgres), with SearXNG behind it.",
    postUp: () => [
      "  keyless: USE_DB_AUTHENTICATION=false \u2014 no API key is sent or needed.",
      "  effect:  pages are now cleaned by a real browser; --firecrawl off opts out."
    ]
  },
  semantic: {
    profiles: ["semantic"],
    summary: "Qdrant (:6333) and Ollama (:11434) are up.",
    postUp: (file, run) => {
      const model = embedModel();
      const pull = run("docker", ["compose", "-f", file, "exec", "-T", "ollama", "ollama", "pull", model], { timeoutMs: MODEL_PULL_TIMEOUT_MS, capture: true });
      return [pull.ok ? `  model:   ${model} ready` : `  model:   pull it yourself: docker compose -f ${file} exec ollama ollama pull ${model}`];
    }
  },
  all: {
    profiles: ["all", "extract"],
    summary: "The whole stack is up (Qdrant \xB7 Ollama \xB7 SearXNG \xB7 Firecrawl).",
    postUp: (file, run) => STACKS.semantic.postUp(file, run)
  }
};
function combine(names) {
  const specs = names.map((n) => STACKS[n]);
  if (specs.some((x) => !x)) return null;
  const found = specs;
  if (found.length === 1) return found[0];
  return {
    profiles: [...new Set(found.flatMap((x) => x.profiles))],
    summary: found.map((x) => x.summary).join("\n  "),
    postUp: (file, run) => found.flatMap((x) => x.postUp?.(file, run) ?? [])
  };
}
var STACK_SERVICES = Object.keys(STACKS);
var SERVICE_PROFILES = Object.fromEntries(Object.entries(STACKS).map(([k, v]) => [k, v.profiles]));
function stackControl(service, action, deps = {}) {
  const run = deps.run ?? defaultRun;
  const has = deps.has ?? defaultHas;
  const names = Array.isArray(service) ? service : [service];
  const tag = `${brand().cli} ${names.join("+")}`;
  const spec = combine(names);
  if (!spec) {
    const bad = names.filter((n) => !STACKS[n]);
    return { message: `${brand().cli}: unknown service ${bad.map((b) => `"${b}"`).join(", ")} \u2014 expected one of ${STACK_SERVICES.join(", ")}`, code: 1 };
  }
  if (action !== "up" && action !== "down" && action !== "status") {
    return { message: `${tag}: unknown action "${action}" (use: up | down | status)`, code: 1 };
  }
  if (!has("docker")) {
    return { message: `${tag}: docker not found on PATH. The stack is optional \u2014 everything it provides degrades to a note.`, code: 1 };
  }
  const file = ensureComposeMaterialized();
  const profiles = spec.profiles.flatMap((p) => ["--profile", p]);
  if (action === "down") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "down"], { timeoutMs: DOWN_TIMEOUT_MS, capture: true });
    return { message: r.ok ? `${tag}: stopped.` : `${tag}: down failed.
${r.stderr}`, code: r.ok ? 0 : 1 };
  }
  if (action === "status") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "ps"], { timeoutMs: PS_TIMEOUT_MS, capture: true });
    return { message: r.ok ? r.stdout.trim() || `${tag}: no services running.` : `${tag}: status failed.
${r.stderr}`, code: 0 };
  }
  const pulled = run("docker", ["compose", "-f", file, ...profiles, "pull"], { timeoutMs: pullTimeoutMs() });
  if (!pulled.ok) {
    return {
      message: `${tag}: pulling the images failed (they are large \u2014 raise ${envName("DOCKER_PULL_TIMEOUT_MS")}, currently ${pullTimeoutMs()}ms).` + (pulled.stderr ? `
${pulled.stderr}` : ""),
      code: 1
    };
  }
  const up = run("docker", ["compose", "-f", file, ...profiles, "up", "-d", "--wait"], { timeoutMs: UP_TIMEOUT_MS });
  if (!up.ok) return { message: `${tag}: up failed.${up.stderr ? `
${up.stderr}` : ""}`, code: 1 };
  return { message: [`${tag}: ${spec.summary}`, ...spec.postUp?.(file, run) ?? []].join("\n"), code: 0 };
}

// src/locale.ts
var LANG_COUNTRY = {
  en: "us",
  pt: "br",
  ja: "jp",
  zh: "cn",
  ko: "kr",
  sv: "se",
  da: "dk",
  cs: "cz",
  el: "gr",
  uk: "ua",
  // Ukrainian language → Ukraine
  ar: "xa",
  // DuckDuckGo's "Arabia" region
  he: "il",
  hi: "in"
};
var REGION_ALIASES = {
  gb: "uk",
  en: "us"
};
function baseLang(lang) {
  return (lang || "en").split("-")[0].toLowerCase();
}
function resolveRegion(lang, region) {
  if (region?.trim()) return region.trim().toLowerCase();
  const parts = (lang || "en").split("-");
  if (parts.length > 1 && parts[1]) return parts[1].toLowerCase();
  const l = baseLang(lang);
  return LANG_COUNTRY[l] ?? l;
}
function ddgRegion(lang, region) {
  const l = baseLang(lang);
  let r = resolveRegion(lang, region);
  r = REGION_ALIASES[r] ?? r;
  return `${r}-${l}`;
}
function acceptLanguageHeader(lang, region) {
  const l = baseLang(lang);
  const R = resolveRegion(lang, region).toUpperCase();
  if (l === "en") return `${l}-${R},${l};q=0.9`;
  return `${l}-${R},${l};q=0.9,en;q=0.5`;
}

// src/url.ts
var TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|ref_url$|spm$|_hsenc$|_hsmi$|igshid$)/i;
function canonicalizeUrl(raw) {
  try {
    const u = new URL(raw.trim());
    const proto = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let port = u.port;
    if (proto === "http:" && port === "80" || proto === "https:" && port === "443") port = "";
    const path = u.pathname.replace(/\/+$/, "");
    const keep = [];
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
    }
    keep.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const search2 = keep.length ? "?" + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
    return `${proto}//${host}${port ? ":" + port : ""}${path}${search2}`.replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/#.*$/, "").replace(/\/$/, "");
  }
}
var FNV_OFFSET = 0xcbf29ce484222325n;
var FNV_PRIME = 0x100000001b3n;
var MASK64 = (1n << 64n) - 1n;
function fnv1a64(s) {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = h * FNV_PRIME & MASK64;
  }
  return h;
}

// src/engines.ts
var KEYLESS_ENGINES = ["ddg", "ddglite", "mojeek"];
function isKeylessEngine(v) {
  return KEYLESS_ENGINES.includes(v);
}
function keylessEngines(opts = {}) {
  if (opts.engines) return opts.engines;
  const raw = env("ENGINES");
  if (raw === void 0) return KEYLESS_ENGINES;
  if (raw.toLowerCase() === "off") return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(isKeylessEngine);
}
function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function ddgRedirectTarget(href) {
  const uddg = /[?&]uddg=([^&]+)/.exec(href);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}
function throttleReason(status) {
  if (status === 429 || status === 503) return { throttled: true, why: `rate-limited (HTTP ${status})` };
  return { throttled: false, why: `unreachable (status ${status})` };
}
function parseBlocks(body, limit, blockRe, snippetRe, reject, resolveHref) {
  const found = [];
  let m;
  blockRe.lastIndex = 0;
  while ((m = blockRe.exec(body)) && found.length < limit) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]);
    if (!href0) continue;
    const href = resolveHref(href0[1]);
    if (!/^https?:\/\//.test(href) || reject.test(href)) continue;
    const snip = snippetRe.exec(m[3]);
    snippetRe.lastIndex = 0;
    found.push({ url: href, title: stripTags(m[2]) || href, snippet: snip ? stripTags(snip[1]) : "" });
  }
  return found;
}
function parseDdgHtml(body, limit = 50) {
  return parseBlocks(
    body,
    limit,
    /<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult__a\b|$)/gi,
    /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i,
    /duckduckgo\.com/,
    ddgRedirectTarget
  );
}
function parseDdgLite(body, limit = 50) {
  return parseBlocks(
    body,
    limit,
    /<a\b([^>]*\bresult-link\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult-link\b|$)/gi,
    /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i,
    /duckduckgo\.com/,
    ddgRedirectTarget
  );
}
function parseMojeek(body, limit = 50) {
  return parseBlocks(
    body,
    limit,
    /<a\b([^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bclass="[^"]*\btitle\b|$)/gi,
    /<p\b[^>]*\bclass="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
    /mojeek\.com/,
    (h) => h.startsWith("//") ? `https:${h}` : h
  );
}
var SPECS = {
  // `s` is a 0-based result offset, ~30 per page.
  ddg: {
    label: "DuckDuckGo",
    url: (q, p, kl) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}${p > 0 ? `&s=${p * 30}` : ""}`,
    parse: parseDdgHtml
  },
  ddglite: {
    label: "DuckDuckGo Lite",
    url: (q, p, kl) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}${p > 0 ? `&s=${p * 30}` : ""}`,
    parse: parseDdgLite
  },
  // Mojeek's `s` is the 1-BASED index of the first result, 10 per page — so
  // page 2 starts at 11, not 10. Its own crawler and index, which is why it is
  // worth asking at all: it surfaces pages the DDG family does not have.
  mojeek: {
    label: "Mojeek",
    url: (q, p) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}${p > 0 ? `&s=${p * 10 + 1}` : ""}`,
    parse: parseMojeek
  }
};
async function searchViaKeyless(engine, query, opts = {}) {
  const spec = SPECS[engine];
  const q = query.trim();
  if (!q) return { hits: [], note: "Empty query." };
  const pages = Math.max(1, opts.pages ?? 1);
  const limit = Math.max(1, opts.limit ?? 10);
  const kl = ddgRegion(opts.lang, opts.region);
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  const seen = /* @__PURE__ */ new Set();
  const hits = [];
  for (let p = 0; p < pages && hits.length < limit; p++) {
    const r = await httpGet(spec.url(q, p, kl), { accept: "text/html", acceptLanguage, timeoutMs: opts.timeoutMs ?? 12e3 });
    if (!r.ok || !r.body) {
      if (p > 0) break;
      const { throttled, why } = throttleReason(r.status);
      return { hits: [], note: `${spec.label} ${why}.`, throttled };
    }
    const before = hits.length;
    for (const f of spec.parse(r.body, limit * 2)) {
      const key = canonicalizeUrl(f.url);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(f);
      if (hits.length >= limit) break;
    }
    if (hits.length === before) break;
    if (p < pages - 1 && pageDelayMs()) await sleep(pageDelayMs());
  }
  return hits.length ? { hits } : { hits: [], note: `${spec.label} returned no results.` };
}

// src/search.ts
var SEARXNG_DEFAULT_BASE = "http://localhost:8888";
var PROBE_TIMEOUT_MS2 = 2e3;
var QUERY_TIMEOUT_MS = 8e3;
function searxngBase(opts = {}) {
  const raw = (opts.searxng ?? env("SEARXNG") ?? SEARXNG_DEFAULT_BASE).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/+$/, "");
}
function searxngIsExplicit(opts = {}) {
  return !!(opts.searxng ?? env("SEARXNG"));
}
var probeCache2 = /* @__PURE__ */ new Map();
function probeSearxng(base) {
  let p = probeCache2.get(base);
  if (!p) {
    p = (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS2);
      try {
        const res = await fetch(`${base}/healthz`, { signal: ctrl.signal });
        await res.text().catch(() => "");
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(t);
      }
    })();
    probeCache2.set(base, p);
  }
  return p;
}
async function searchViaSearxng(query, opts = {}) {
  const base = searxngBase(opts);
  if (!base) return { hits: [], notes: [`SearXNG disabled (${envName("SEARXNG")}=off).`] };
  if (!await probeSearxng(base)) {
    return {
      hits: [],
      notes: [
        searxngIsExplicit(opts) ? `SearXNG not reachable at ${base}.` : `SearXNG not running at ${base} \u2014 start it with \`${brand().cli} searxng up\` for local, keyless discovery.`
      ]
    };
  }
  const pages = Math.max(1, opts.pages ?? 1);
  const limit = Math.max(1, opts.limit ?? 10);
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  const root = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1` + (opts.lang ? `&language=${encodeURIComponent(opts.lang)}` : "");
  const notes = [];
  const seen = /* @__PURE__ */ new Set();
  const hits = [];
  const suspended = /* @__PURE__ */ new Map();
  for (let p = 0; p < pages && hits.length < limit; p++) {
    const r = await httpGet(root + (p > 0 ? `&pageno=${p + 1}` : ""), { accept: "application/json", acceptLanguage, timeoutMs: QUERY_TIMEOUT_MS });
    if (!r.ok) {
      if (p === 0) notes.push(r.status === 429 || r.status === 503 ? `SearXNG rate-limited (HTTP ${r.status}).` : `SearXNG unreachable (status ${r.status}).`);
      break;
    }
    let data;
    try {
      data = JSON.parse(r.body);
    } catch {
      if (p === 0) notes.push("SearXNG returned a non-JSON body \u2014 is `format: json` enabled on that instance?");
      break;
    }
    for (const e of data.unresponsive_engines ?? []) {
      const pair = Array.isArray(e) ? e : [];
      if (typeof pair[0] === "string") suspended.set(pair[0], typeof pair[1] === "string" ? pair[1] : "unavailable");
    }
    const before = hits.length;
    for (const raw of data.results ?? []) {
      const it = raw;
      if (typeof it.url !== "string") continue;
      const key = canonicalizeUrl(it.url);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        url: it.url,
        title: typeof it.title === "string" && it.title.trim() ? it.title.trim() : it.url,
        snippet: typeof it.content === "string" ? it.content.trim() : "",
        via: "searxng"
      });
      if (hits.length >= limit) break;
    }
    if (hits.length === before) break;
    if (p < pages - 1 && pageDelayMs()) await sleep(pageDelayMs());
  }
  if (suspended.size) {
    notes.push(`SearXNG upstreams throttled: ${[...suspended].map(([e, why]) => `${e} (${why})`).join(", ")} \u2014 fewer results than usual, not an empty web.`);
  }
  if (!hits.length && !notes.length) notes.push("SearXNG returned no results.");
  return { hits, notes };
}
async function search(query, opts = {}) {
  const q = query.trim();
  if (!q) return { hits: [], notes: ["Empty query."] };
  const viaSearxng = await searchViaSearxng(q, opts);
  if (viaSearxng.hits.length) return viaSearxng;
  const notes = [...viaSearxng.notes];
  for (const engine of keylessEngines(opts)) {
    const r = await searchViaKeyless(engine, q, { limit: opts.limit, pages: opts.pages, lang: opts.lang, region: opts.region });
    if (r.hits.length) {
      return { hits: r.hits.map((h) => ({ ...h, via: engine })), notes };
    }
    if (r.throttled && r.note) notes.push(r.note);
  }
  const fc = await searchViaFirecrawl(q, opts.limit ?? 10, opts);
  const hits = (fc.hits ?? []).map((h) => ({ url: h.url, title: h.title, snippet: h.description, via: "firecrawl" }));
  if (fc.why) notes.push(fc.why);
  if (!hits.length) notes.push(`No results from any engine. \`${brand().cli} stack up\` starts SearXNG and Firecrawl locally.`);
  return { hits, notes };
}

// src/cache.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync, rmSync as rmSync2, statSync, writeFileSync as writeFileSync4 } from "fs";
import { join as join3 } from "path";
import { tmpdir as tmpdir3 } from "os";

// src/no-write.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync3 } from "fs";
var flagged = false;
function isNoWrite() {
  return flagged || envFlag("NO_WRITE");
}

// src/cache.ts
var DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
function cacheDir() {
  return env("CACHE_DIR") ?? brand().cacheDir ?? join3(tmpdir3(), brand().name, "cache");
}
function ttlMs() {
  return envInt("CACHE_TTL_MS", DEFAULT_TTL_MS);
}
function isCacheFresh(entry, now = Date.now()) {
  return typeof entry.cachedAt === "number" && now - entry.cachedAt <= ttlMs();
}
function cacheStats(now = Date.now()) {
  const dir = cacheDir();
  const out = { dir, entries: 0, bytes: 0, fresh: 0, stale: 0, ttlMs: ttlMs() };
  if (!existsSync3(dir)) return out;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const abs = join3(dir, name);
    try {
      out.bytes += statSync(abs).size;
      const entry = JSON.parse(readFileSync3(abs, "utf8"));
      if (typeof entry.cachedAt !== "number") continue;
      out.entries++;
      if (isCacheFresh(entry, now)) out.fresh++;
      else out.stale++;
      if (entry.cachedAt < oldest) oldest = entry.cachedAt;
      if (entry.cachedAt > newest) newest = entry.cachedAt;
    } catch {
    }
  }
  if (out.entries) {
    out.oldest = new Date(oldest).toISOString();
    out.newest = new Date(newest).toISOString();
  }
  return out;
}
function cacheClean(all = false, now = Date.now()) {
  const dir = cacheDir();
  if (!existsSync3(dir) || isNoWrite()) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const abs = join3(dir, name);
    let drop = all;
    if (!drop) {
      try {
        const entry = JSON.parse(readFileSync3(abs, "utf8"));
        drop = !isCacheFresh(entry, now);
      } catch {
        drop = true;
      }
    }
    if (!drop) continue;
    try {
      rmSync2(abs, { force: true });
      removed++;
    } catch {
    }
  }
  return removed;
}

// src/robots.ts
var EMPTY = { rules: [], sitemaps: [], absent: true };
function parseRobots(body, userAgent) {
  const ua = userAgent.toLowerCase();
  const groups = /* @__PURE__ */ new Map();
  const delays = /* @__PURE__ */ new Map();
  const sitemaps = [];
  let current2 = [];
  let inHeader = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sep2 = line.indexOf(":");
    if (sep2 === -1) continue;
    const field = line.slice(0, sep2).trim().toLowerCase();
    const value = line.slice(sep2 + 1).trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!inHeader) current2 = [];
      current2.push(value.toLowerCase());
      inHeader = true;
      for (const g of current2) if (!groups.has(g)) groups.set(g, []);
      continue;
    }
    inHeader = false;
    if (!current2.length) continue;
    if (field === "allow" || field === "disallow") {
      for (const g of current2) groups.get(g).push({ allow: field === "allow", path: value });
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) for (const g of current2) delays.set(g, n * 1e3);
    }
  }
  let chosen;
  for (const g of groups.keys()) {
    if (g === "*") continue;
    if (ua.includes(g) && (!chosen || g.length > chosen.length)) chosen = g;
  }
  chosen ??= groups.has("*") ? "*" : void 0;
  if (chosen === void 0) return { rules: [], sitemaps, absent: false };
  const rules = [...groups.get(chosen)].sort((a, b) => b.path.length - a.path.length || (a.allow === b.allow ? 0 : a.allow ? -1 : 1));
  const crawlDelayMs = delays.get(chosen);
  return { rules, sitemaps, absent: false, ...crawlDelayMs !== void 0 ? { crawlDelayMs } : {} };
}
function ruleMatches(pattern, path) {
  if (pattern === "") return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  if (!body.includes("*")) return anchored ? path === body : path.startsWith(body);
  const re = new RegExp(`^${body.split("*").map(escapeRe).join(".*")}${anchored ? "$" : ""}`);
  return re.test(path);
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isAllowed(robots, url) {
  if (robots.absent || !robots.rules.length) return true;
  let path;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return true;
  }
  for (const rule of robots.rules) if (ruleMatches(rule.path, path)) return rule.allow;
  return true;
}
var cache = /* @__PURE__ */ new Map();
async function fetchRobots(url) {
  if (envFlag("NO_ROBOTS")) return EMPTY;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return EMPTY;
  }
  let p = cache.get(origin);
  if (!p) {
    p = (async () => {
      const r = await httpGet(`${origin}/robots.txt`, { accept: "text/plain", timeoutMs: 5e3, maxBytes: 512 * 1024 });
      if (!r.ok || !r.body.trim()) return EMPTY;
      return parseRobots(r.body, env("ROBOTS_UA") ?? brand().name);
    })();
    cache.set(origin, p);
  }
  return p;
}

// src/feed.ts
function tagText(block, ...names) {
  for (const name of names) {
    const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
    if (!m) continue;
    const raw = m[1];
    const inner = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw)?.[1] ?? raw;
    const text = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return void 0;
}
function itemUrl(block) {
  const link = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i.exec(block);
  if (link) {
    const alts = [...block.matchAll(/<link\b([^>]*)>/gi)].map((m) => m[1]).filter((attrs) => !/\brel\s*=\s*["'](?:self|edit|replies|enclosure)["']/i.test(attrs));
    for (const attrs of alts) {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      if (href) return decodeEntities(href).trim();
    }
    return decodeEntities(link[1]).trim();
  }
  return tagText(block, "link", "guid");
}
function parseFeed(xml) {
  const isAtom = /<feed\b[^>]*xmlns\s*=\s*["'][^"']*www\.w3\.org\/2005\/Atom/i.test(xml) || /<entry\b/i.test(xml);
  const isRss = /<rss\b/i.test(xml) || /<channel\b/i.test(xml);
  if (!isAtom && !isRss) return void 0;
  const kind = isAtom && !isRss ? "atom" : "rss";
  const itemRe = kind === "atom" ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;
  const items = [];
  for (const m of xml.matchAll(itemRe)) {
    const block = m[0];
    const it = {};
    const title2 = tagText(block, "title");
    if (title2) it.title = title2;
    const url = itemUrl(block);
    if (url) it.url = url;
    const published = tagText(block, "pubDate", "published", "updated", "dc:date");
    if (published) it.published = published;
    const summary = tagText(block, "description", "summary");
    if (summary) it.summary = summary;
    const id = tagText(block, "guid", "id");
    if (id) it.id = id;
    if (it.title || it.url) items.push(it);
  }
  const head = xml.replace(itemRe, "");
  const title = tagText(head, "title");
  return { kind, items, ...title ? { title } : {} };
}
function discoverFeeds(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1];
    if (!/\brel\s*=\s*["']?alternate\b/i.test(attrs)) continue;
    if (!/\btype\s*=\s*["'](?:application\/(?:rss|atom)\+xml|application\/feed\+json)["']/i.test(attrs)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    try {
      const abs = new URL(decodeEntities(href).trim(), baseUrl).href;
      if (!out.includes(abs)) out.push(abs);
    } catch {
    }
  }
  return out;
}
function parseSitemap(xml) {
  const out = { urls: [], sitemaps: [] };
  const isIndex = /<sitemapindex\b/i.test(xml);
  for (const m of xml.matchAll(/<(sitemap|url)\b[\s\S]*?<\/\1>/gi)) {
    const block = m[0];
    const loc = tagText(block, "loc");
    if (!loc) continue;
    if (isIndex || m[1].toLowerCase() === "sitemap") {
      out.sitemaps.push(loc);
    } else {
      const lastmod = tagText(block, "lastmod");
      out.urls.push({ loc, ...lastmod ? { lastmod } : {} });
    }
  }
  return out;
}
async function fetchSitemap(url, opts = {}) {
  const out = { urls: [], sitemaps: [] };
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return out;
  }
  const queue = [...opts.sitemaps ?? [], `${origin}/sitemap.xml`];
  const seen = /* @__PURE__ */ new Set();
  let fetched = 0;
  const max = Math.max(1, opts.max ?? 3);
  while (queue.length && fetched < max) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    const r = await httpGet(next, { accept: "application/xml,text/xml,*/*", timeoutMs: 1e4 });
    fetched++;
    if (!r.ok || !r.body.trim()) continue;
    const parsed = parseSitemap(r.body);
    out.urls.push(...parsed.urls);
    for (const s of parsed.sitemaps) {
      if (!out.sitemaps.includes(s)) out.sitemaps.push(s);
      queue.push(s);
    }
  }
  return out;
}
async function fetchFeed(url) {
  const r = await httpGet(url, { accept: "application/atom+xml,application/rss+xml,application/xml,*/*", timeoutMs: 1e4 });
  if (!r.ok || !r.body.trim()) return void 0;
  return parseFeed(r.body);
}

// src/structured.ts
var META_TAG = /<meta\b[^>]*>/gi;
var ATTR = (tag, name) => {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v ? decodeEntities(v).trim() : void 0;
};
function extractJsonLd(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while (m = re.exec(html)) {
    const raw = m[1].replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed["@graph"])) {
        out.push(...parsed["@graph"]);
      } else if (Array.isArray(parsed)) {
        out.push(...parsed);
      } else {
        out.push(parsed);
      }
    } catch {
    }
  }
  return out;
}
function extractMetaTags(html) {
  const out = /* @__PURE__ */ new Map();
  META_TAG.lastIndex = 0;
  for (const m of html.matchAll(META_TAG)) {
    const tag = m[0];
    const key = (ATTR(tag, "property") ?? ATTR(tag, "name") ?? ATTR(tag, "itemprop"))?.toLowerCase();
    const content = ATTR(tag, "content");
    if (key && content && !out.has(key)) out.set(key, content);
  }
  return out;
}
function firstString(v) {
  if (typeof v === "string") return v.trim() || void 0;
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = firstString(x);
      if (s) return s;
    }
    return void 0;
  }
  if (v && typeof v === "object") return firstString(v.name);
  return void 0;
}
function allStrings(v) {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (v && typeof v === "object") return allStrings(v.name);
  return [];
}
function pageMetadata(html) {
  const meta = extractMetaTags(html);
  const jsonLd = extractJsonLd(html);
  const out = { authors: [], jsonLd };
  const set = (k, v) => {
    if (v !== void 0 && out[k] === void 0) out[k] = v;
  };
  for (const node of jsonLd) {
    if (!node || typeof node !== "object") continue;
    const n = node;
    set("type", firstString(n["@type"]));
    set("title", firstString(n.headline) ?? firstString(n.name));
    set("description", firstString(n.description));
    set("publishedAt", firstString(n.datePublished));
    set("modifiedAt", firstString(n.dateModified));
    set("canonicalUrl", firstString(n.url) ?? firstString(n["@id"]));
    set("imageUrl", firstString(n.image));
    set("siteName", firstString(n.publisher));
    for (const a of allStrings(n.author)) if (!out.authors.includes(a)) out.authors.push(a);
  }
  set("title", meta.get("og:title") ?? meta.get("twitter:title"));
  set("description", meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description"));
  set("type", meta.get("og:type"));
  set("siteName", meta.get("og:site_name"));
  set("publishedAt", meta.get("article:published_time") ?? meta.get("datepublished") ?? meta.get("citation_publication_date"));
  set("modifiedAt", meta.get("article:modified_time") ?? meta.get("datemodified"));
  set("imageUrl", meta.get("og:image") ?? meta.get("twitter:image"));
  set("canonicalUrl", meta.get("og:url"));
  for (const key of ["article:author", "author", "citation_author", "dc.creator"]) {
    const v = meta.get(key);
    if (v && !out.authors.includes(v)) out.authors.push(v);
  }
  if (out.title === void 0) {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    if (t) out.title = decodeEntities(t).replace(/\s+/g, " ").trim() || void 0;
  }
  return out;
}

// src/repo.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readdirSync as readdirSync2, rmSync as rmSync3, statSync as statSync2 } from "fs";
import { tmpdir as tmpdir4 } from "os";
import { basename, join as join4, resolve } from "path";

// src/exec.ts
import { spawn as spawn2, spawnSync as spawnSync2 } from "child_process";
var STDOUT_CAP = 24 * 1024 * 1024;

// src/repo.ts
function resolveRepo(raw) {
  const trimmed = raw.trim();
  if (trimmed) {
    const asPath = resolve(trimmed);
    if (existsSync4(asPath) && statSync2(asPath).isDirectory()) {
      return { raw: trimmed, host: "local", isLocal: true, slug: `local-${slugify(`${basename(asPath)}-${asPath}`)}` };
    }
  }
  const file = /^file:\/\/(\/.*)$/.exec(trimmed);
  if (file) {
    const p = file[1].replace(/\.git$/, "").replace(/\/+$/, "");
    return {
      raw: trimmed,
      host: "file",
      ...basename(p) ? { repo: basename(p) } : {},
      cloneUrl: trimmed,
      isLocal: false,
      slug: `file-${slugify(p)}`
    };
  }
  let host;
  let path;
  const scp = /^git@([^:]+):(.+)$/.exec(trimmed);
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const hostPath = /^([a-z0-9.-]+\.[a-z]{2,})\/(.+)$/i.exec(trimmed);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else if (url) {
    host = url[1];
    path = url[2];
  } else if (hostPath) {
    host = hostPath[1];
    path = hostPath[2];
  } else if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    host = "github.com";
    path = trimmed;
  } else {
    return { raw: trimmed, host: "generic", isLocal: false, slug: slugify(trimmed) || "seed" };
  }
  host = host.toLowerCase();
  path = path.replace(/\.git$/, "").replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  const repo = segments.length ? segments[segments.length - 1] : void 0;
  const owner = segments.length > 1 ? segments.slice(0, -1).join("/") : void 0;
  const base = /^https?:\/\//i.test(trimmed) || scp ? trimmed.replace(/\/+$/, "") : `https://${host}/${path}.git`;
  return {
    raw: trimmed,
    host,
    ...owner ? { owner } : {},
    ...repo ? { repo } : {},
    cloneUrl: base.endsWith(".git") ? base : `${base}.git`,
    webUrl: `https://${host}/${path}`,
    isLocal: false,
    slug: slugify(`${host}/${path}`)
  };
}

// src/forge.ts
function forgeKind(host) {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com") || h.startsWith("github.")) return "github";
  if (h === "gitlab.com" || h.includes("gitlab")) return "gitlab";
  if (h.includes("gitea") || h.includes("codeberg")) return "gitea";
  return void 0;
}
function apiBase(ref, opts = {}) {
  if (opts.apiBase) return opts.apiBase.replace(/\/+$/, "");
  const kind = forgeKind(ref.host);
  if (kind === "github") return ref.host === "github.com" ? "https://api.github.com" : `https://${ref.host}/api/v3`;
  if (kind === "gitlab") return `https://${ref.host}/api/v4`;
  return `https://${ref.host}/api/v1`;
}
function forgeAuthHeaders(kind) {
  if (kind === "github") {
    const t2 = env("GITHUB_TOKEN") ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    return t2 ? { authorization: `Bearer ${t2}` } : {};
  }
  if (kind === "gitlab") {
    const t2 = env("GITLAB_TOKEN") ?? process.env.GITLAB_TOKEN;
    return t2 ? { "private-token": t2 } : {};
  }
  const t = env("GITEA_TOKEN") ?? process.env.GITEA_TOKEN;
  return t ? { authorization: `token ${t}` } : {};
}
function reqOpts(kind, opts) {
  return {
    timeoutMs: opts.timeoutMs ?? 15e3,
    userAgent: contactUa(),
    headers: { ...forgeAuthHeaders(kind), ...kind === "github" ? { accept: "application/vnd.github+json" } : {} }
  };
}
function clip(s, n = 1200) {
  return String(s ?? "").replace(/\r/g, "").trim().slice(0, n);
}
function labelsOf(v) {
  if (!Array.isArray(v)) return [];
  return v.map((l) => typeof l === "string" ? l : l?.name ?? "").filter(Boolean);
}
function limited(status, data) {
  if (status === 429) return true;
  return status === 403 && /rate limit/i.test(JSON.stringify(data ?? ""));
}
function mapGithubIssues(raw, kind) {
  return (raw ?? []).filter((it) => !!it && typeof it === "object").map((it) => ({
    kind,
    number: typeof it.number === "number" ? it.number : void 0,
    title: String(it.title ?? "").trim(),
    url: String(it.html_url ?? ""),
    state: it.draft ? "draft" : String(it.state ?? ""),
    labels: labelsOf(it.labels),
    body: clip(it.body),
    updatedAt: it.updated_at ? String(it.updated_at) : void 0,
    score: typeof it.score === "number" ? it.score : void 0
  }));
}
async function canonicalRepo(ref, opts = {}) {
  if (!ref.owner || !ref.repo) return void 0;
  const kind = forgeKind(ref.host);
  if (kind !== "github") return `${ref.owner}/${ref.repo}`;
  const r = await httpJson("GET", `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}`, void 0, reqOpts(kind, opts));
  const full = r.ok ? r.data?.full_name : void 0;
  return typeof full === "string" ? full : `${ref.owner}/${ref.repo}`;
}
async function searchIssues(ref, terms, kind, opts = {}) {
  const forge = forgeKind(ref.host);
  if (!forge) return { items: [], note: `${ref.host} is not a forge this engine knows how to query.` };
  if (!ref.owner || !ref.repo) return { items: [], note: `"${ref.raw}" does not name owner/repo.` };
  const limit = Math.max(1, opts.limit ?? 10);
  const q = terms.filter(Boolean).join(" ");
  if (forge === "github") {
    const slug = await canonicalRepo(ref, opts) ?? `${ref.owner}/${ref.repo}`;
    const filter = kind === "pr" ? "is:pr" : "is:issue";
    const url2 = `${apiBase(ref, opts)}/search/issues?q=${encodeURIComponent(`repo:${slug} ${filter} ${q}`)}&per_page=${limit}&sort=updated&order=desc`;
    const r2 = await httpJson("GET", url2, void 0, reqOpts(forge, opts));
    if (limited(r2.status, r2.data))
      return { items: [], rateLimited: true, note: "GitHub rate-limited this search \u2014 set GITHUB_TOKEN to raise the anonymous quota." };
    if (!r2.ok) return { items: [], note: `GitHub search failed (status ${r2.status}).` };
    return { items: mapGithubIssues(r2.data?.items ?? [], kind) };
  }
  if (forge === "gitlab") {
    const project = encodeURIComponent(`${ref.owner}/${ref.repo}`);
    const path2 = kind === "pr" ? "merge_requests" : "issues";
    const url2 = `${apiBase(ref, opts)}/projects/${project}/${path2}?search=${encodeURIComponent(q)}&per_page=${limit}&order_by=updated_at`;
    const r2 = await httpJson("GET", url2, void 0, reqOpts(forge, opts));
    if (limited(r2.status, r2.data)) return { items: [], rateLimited: true, note: "GitLab rate-limited this search." };
    if (!r2.ok) return { items: [], note: `GitLab request failed (status ${r2.status}).` };
    const items2 = (Array.isArray(r2.data) ? r2.data : []).map((it) => ({
      kind,
      number: typeof it.iid === "number" ? it.iid : void 0,
      title: String(it.title ?? "").trim(),
      url: String(it.web_url ?? ""),
      state: String(it.state ?? ""),
      labels: labelsOf(it.labels),
      body: clip(it.description),
      updatedAt: it.updated_at ? String(it.updated_at) : void 0
    }));
    return { items: items2 };
  }
  const path = kind === "pr" ? "pulls" : "issues";
  const url = `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}/${path}?state=all&limit=${limit}&q=${encodeURIComponent(q)}`;
  const r = await httpJson("GET", url, void 0, reqOpts(forge, opts));
  if (limited(r.status, r.data)) return { items: [], rateLimited: true, note: "Gitea rate-limited this request." };
  if (!r.ok) return { items: [], note: `Gitea request failed (status ${r.status}).` };
  const items = (Array.isArray(r.data) ? r.data : []).map((it) => ({
    kind,
    number: typeof it.number === "number" ? it.number : void 0,
    title: String(it.title ?? "").trim(),
    url: String(it.html_url ?? ""),
    state: String(it.state ?? ""),
    labels: labelsOf(it.labels),
    body: clip(it.body),
    updatedAt: it.updated_at ? String(it.updated_at) : void 0
  }));
  return { items };
}
async function listReleases(ref, opts = {}) {
  const forge = forgeKind(ref.host);
  if (!forge || !ref.owner || !ref.repo) return { items: [], note: `Cannot list releases for "${ref.raw}".` };
  const limit = Math.max(1, opts.limit ?? 20);
  const url = forge === "gitlab" ? `${apiBase(ref, opts)}/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/releases?per_page=${limit}` : `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}/releases?per_page=${limit}&limit=${limit}`;
  const r = await httpJson("GET", url, void 0, reqOpts(forge, opts));
  if (limited(r.status, r.data)) return { items: [], rateLimited: true, note: `${forge} rate-limited the release list.` };
  if (!r.ok) return { items: [], note: `Could not list releases (status ${r.status}).` };
  const items = (Array.isArray(r.data) ? r.data : []).map((it) => ({
    kind: "release",
    title: String(it.name ?? it.tag_name ?? it.tag ?? "").trim() || String(it.tag_name ?? ""),
    url: String(it.html_url ?? it._links ?? it.web_url ?? ref.webUrl ?? ""),
    state: it.prerelease ? "prerelease" : "released",
    labels: [],
    body: clip(it.body ?? it.description),
    updatedAt: String(it.published_at ?? it.released_at ?? it.created_at ?? "") || void 0
  }));
  return { items };
}
async function repoFacts(ref, opts = {}) {
  const forge = forgeKind(ref.host);
  if (!forge || !ref.owner || !ref.repo) return void 0;
  const url = forge === "gitlab" ? `${apiBase(ref, opts)}/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}` : `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}`;
  const r = await httpJson("GET", url, void 0, reqOpts(forge, opts));
  if (!r.ok || !r.data || typeof r.data !== "object") return void 0;
  const d = r.data;
  return {
    fullName: d.full_name ?? d.path_with_namespace,
    description: d.description ?? void 0,
    homepage: d.homepage ?? d.web_url ?? void 0,
    license: d.license?.spdx_id ?? d.license?.name ?? void 0,
    stars: d.stargazers_count ?? d.star_count,
    forks: d.forks_count,
    openIssues: d.open_issues_count,
    defaultBranch: d.default_branch,
    pushedAt: d.pushed_at ?? d.last_activity_at,
    archived: d.archived,
    topics: Array.isArray(d.topics) ? d.topics : Array.isArray(d.tag_list) ? d.tag_list : []
  };
}

// src/registry.ts
var REGISTRY_URL = {
  npm: (n) => `https://registry.npmjs.org/${encodeURIComponent(n).replace(/^%40/, "@")}`,
  pypi: (n) => `https://pypi.org/pypi/${encodeURIComponent(n)}/json`,
  crates: (n) => `https://crates.io/api/v1/crates/${encodeURIComponent(n)}`
};
function normalizeRepoUrl(raw) {
  const s = typeof raw === "string" ? raw.trim() : typeof raw?.url === "string" ? String(raw.url).trim() : "";
  if (!s) return void 0;
  let out = s.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://").replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(out)) out = `https://github.com/${out}`;
  return /^https?:\/\//i.test(out) ? out : void 0;
}
function reqOpts2() {
  return { timeoutMs: 12e3, userAgent: contactUa(), accept: "application/json" };
}
async function lookupPackage(registry, name, version) {
  const n = name.trim();
  if (!n) return void 0;
  const r = await httpJson("GET", REGISTRY_URL[registry](n), void 0, reqOpts2());
  if (!r.ok || !r.data || typeof r.data !== "object") return void 0;
  const d = r.data;
  if (registry === "npm") {
    const latest = version ?? d["dist-tags"]?.latest;
    const v = latest && d.versions?.[latest] || {};
    const deprecated = typeof v.deprecated === "string" ? v.deprecated : v.deprecated === true ? "deprecated" : void 0;
    return {
      registry,
      name: d.name ?? n,
      version: latest,
      description: v.description ?? d.description,
      homepage: v.homepage ?? d.homepage,
      repository: normalizeRepoUrl(v.repository ?? d.repository),
      documentation: typeof v.documentation === "string" ? v.documentation : void 0,
      license: typeof v.license === "string" ? v.license : v.license?.type,
      ...deprecated ? { deprecated } : {},
      publishedAt: latest ? d.time?.[latest] : void 0
    };
  }
  if (registry === "pypi") {
    const info = d.info ?? {};
    const urls = info.project_urls ?? {};
    const yanked = Array.isArray(d.urls) && d.urls.length ? d.urls.every((u) => u.yanked) : false;
    return {
      registry,
      name: info.name ?? n,
      version: info.version,
      description: info.summary,
      homepage: info.home_page || urls.Homepage || urls.homepage,
      repository: normalizeRepoUrl(urls.Source ?? urls.Repository ?? urls["Source Code"] ?? urls.Code ?? info.home_page),
      documentation: info.docs_url || urls.Documentation || urls.documentation,
      license: info.license || void 0,
      ...yanked ? { deprecated: "every file for this release is yanked" } : {}
    };
  }
  const c = d.crate ?? {};
  return {
    registry,
    name: c.name ?? n,
    version: version ?? c.max_stable_version ?? c.newest_version,
    description: c.description,
    homepage: c.homepage,
    repository: normalizeRepoUrl(c.repository),
    documentation: c.documentation,
    downloads: typeof c.downloads === "number" ? c.downloads : void 0,
    publishedAt: c.updated_at
  };
}
async function resolvePackage(name, opts = {}) {
  const order = opts.registry ? [opts.registry] : ["npm", "pypi", "crates"];
  for (const r of order) {
    const found = await lookupPackage(r, name, opts.version);
    if (found) return found;
  }
  return void 0;
}

// src/rank.ts
function bm25Tokenize(text) {
  if (!text) return [];
  const out = [];
  for (const raw of text.split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 2) continue;
    if (isStopword(raw)) continue;
    const t = foldTerm(raw);
    if (t.length >= 2) out.push(t);
  }
  return out;
}
function docTokens(doc, titleWeight, headingWeight) {
  const out = bm25Tokenize(doc.body);
  const headings = bm25Tokenize(doc.headings);
  for (let r = 0; r < headingWeight; r++) out.push(...headings);
  const title = bm25Tokenize(doc.title);
  for (let r = 0; r < titleWeight; r++) out.push(...title);
  return out;
}
function proximityBonus(tokens, queryTerms, window = 6, cap = 0.1) {
  if (queryTerms.length < 2) return 0;
  const q = new Set(queryTerms);
  const hits = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (q.has(tok)) hits.push({ pos: i, term: tok });
  }
  if (hits.length < 2) return 0;
  let close = 0;
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].term !== hits[i - 1].term && hits[i].pos - hits[i - 1].pos <= window) close++;
  }
  return Math.min(cap, cap * (close / Math.max(1, queryTerms.length - 1)));
}
function buildBm25Index(question, docs, opts = {}) {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  const titleWeight = 3;
  const headingWeight = 2;
  const queryTerms = [...new Set(bm25Tokenize(question))];
  const N = docs.length;
  const df = /* @__PURE__ */ new Map();
  let totalLen = 0;
  for (const doc of docs) {
    const toks = docTokens(doc, titleWeight, headingWeight);
    totalLen += toks.length;
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgdl = N ? totalLen / N : 0;
  const idf = /* @__PURE__ */ new Map();
  for (const t of queryTerms) {
    if (N < 3) {
      idf.set(t, 1);
      continue;
    }
    const dfi = df.get(t) ?? 0;
    idf.set(t, Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5)));
  }
  return { idf, avgdl, N, queryTerms, k1, b, titleWeight, headingWeight };
}
function bm25Score(index, doc) {
  if (!index.queryTerms.length) return 0;
  const toks = docTokens(doc, index.titleWeight, index.headingWeight);
  const dl = toks.length;
  if (!dl) return 0;
  const tf = /* @__PURE__ */ new Map();
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
  const { k1, b, avgdl } = index;
  const lenNorm = 1 - b + b * (avgdl ? dl / avgdl : 1);
  let score = 0;
  for (const term of index.queryTerms) {
    const f = tf.get(term);
    if (!f) continue;
    const idf = index.idf.get(term) ?? 0;
    score += idf * (f * (k1 + 1)) / (f + k1 * lenNorm);
  }
  return score * (1 + proximityBonus(toks, index.queryTerms));
}
function bm25MatchedTerms(index, doc) {
  if (!index.queryTerms.length) return [];
  const present = new Set(docTokens(doc, index.titleWeight, index.headingWeight));
  return index.queryTerms.filter((t) => present.has(t));
}
function simhash(text) {
  const toks = bm25Tokenize(text);
  const shingles = [];
  if (toks.length < 3) shingles.push(...toks);
  else for (let i = 0; i + 3 <= toks.length; i++) shingles.push(`${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`);
  if (!shingles.length) return 0n;
  const v = new Array(64).fill(0);
  for (const sh2 of shingles) {
    const h = fnv1a64(sh2);
    for (let b = 0; b < 64; b++) v[b] += (h >> BigInt(b) & 1n) === 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b] > 0) out |= 1n << BigInt(b);
  return out;
}
function hammingDistance(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}
function dedupeNearDuplicates(items, opts = {}) {
  const maxBits = opts.maxBits ?? 3;
  const minChars = opts.minChars ?? 500;
  const better = (a, b) => a.score !== b.score ? a.score > b.score : a.url.localeCompare(b.url) < 0;
  const kept = [];
  let dropped = 0;
  for (const it of items) {
    const text = it.text || "";
    const hash = text.length >= minChars ? simhash(text) : null;
    if (hash !== null) {
      const dup = kept.find((k) => k.hash !== null && hammingDistance(k.hash, hash) <= maxBits);
      if (dup) {
        dropped++;
        if (better(it, dup.it)) {
          dup.it = it;
          dup.hash = hash;
        }
        continue;
      }
    }
    kept.push({ it, hash });
  }
  return { items: kept.map((k) => k.it), dropped };
}
function diversify(items, tokensOf, lambda = 0.75) {
  if (items.length <= 2) return [...items];
  const toks = new Map(items.map((it) => [it, tokensOf(it)]));
  const max = Math.max(...items.map((it) => it.score), 1e-9);
  const rel = (it) => it.score / max;
  const jaccard = (a, b) => {
    if (!a.size || !b.size) return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let inter = 0;
    for (const t of small) if (large.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };
  let simMax = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const v = jaccard(toks.get(items[i]), toks.get(items[j]));
      if (v > simMax) simMax = v;
    }
  }
  const sim = (a, b) => simMax > 0 ? jaccard(toks.get(a), toks.get(b)) / simMax : 0;
  const remaining = [...items];
  const out = [];
  remaining.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  out.push(remaining.shift());
  const maxSim = new Map(remaining.map((it) => [it, sim(it, out[0])]));
  while (remaining.length) {
    let bestIdx = 0;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const it = remaining[i];
      const val = lambda * rel(it) - (1 - lambda) * (maxSim.get(it) ?? 0);
      if (val > bestVal || val === bestVal && it.url.localeCompare(remaining[bestIdx].url) < 0) {
        bestVal = val;
        bestIdx = i;
      }
    }
    const picked = remaining.splice(bestIdx, 1)[0];
    out.push(picked);
    for (const it of remaining) maxSim.set(it, Math.max(maxSim.get(it) ?? 0, sim(it, picked)));
  }
  return out;
}

// src/mcp/protocol.ts
var PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
var LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
var ASSUMED_HTTP_PROTOCOL = "2025-03-26";
var RICH_TOOLS_SINCE = "2025-06-18";
var DEFAULT_MAX_RESPONSE_BYTES = 1e6;
function isProtocolVersion(v) {
  return typeof v === "string" && PROTOCOL_VERSIONS.includes(v);
}
function negotiateProtocol(requested) {
  return isProtocolVersion(requested) ? requested : LATEST_PROTOCOL;
}
function validateArgs(schema, args) {
  for (const key of schema.required) {
    const v = args[key];
    if (v === void 0 || v === null || v === "") return `\`${key}\` is required`;
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === void 0 || value === null) continue;
    const spec = schema.properties[key];
    if (!spec?.type) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (spec.type === "number") {
      if (actual === "number") continue;
      if (actual === "string" && value.trim() !== "" && Number.isFinite(Number(value))) continue;
      return `\`${key}\` must be a number, got ${actual === "string" ? JSON.stringify(value) : actual}`;
    }
    if (spec.type === "array") {
      if (actual !== "array") return `\`${key}\` must be an array, got ${actual}`;
      const arr = value;
      if (spec.items?.type === "string" && !arr.every((x) => typeof x === "string")) {
        return `\`${key}\` must be an array of strings`;
      }
      if (spec.enum) {
        const bad = arr.find((x) => typeof x === "string" && !spec.enum.includes(x));
        if (bad !== void 0) return `\`${key}\` contains "${String(bad)}" \u2014 allowed: ${spec.enum.join(", ")}`;
      }
      continue;
    }
    if (actual !== spec.type) return `\`${key}\` must be a ${spec.type}, got ${actual}`;
    if (spec.enum && typeof value === "string" && !spec.enum.includes(value)) {
      return `\`${key}\` must be one of: ${spec.enum.join(", ")}`;
    }
  }
  return void 0;
}
function capResponse(text, tool, maxBytes, artifact, advice = {}) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  return JSON.stringify(
    {
      truncated: true,
      tool,
      bytes,
      maxBytes,
      reason: "This response exceeds the configured limit and was withheld rather than sent as an unusable partial payload.",
      narrower: advice[tool] ?? "narrow the request and call again",
      ...artifact ? { artifact, artifactNote: "The full result is on disk here \u2014 read it directly if you need all of it." } : {}
    },
    null,
    2
  ) + "\n";
}
function structuredContentFor(text, capped, hasSchema) {
  if (capped || !hasSchema) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
  return parsed;
}
var LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function isOriginAllowed(origin, allowed = []) {
  if (origin === void 0) return true;
  const o = origin.trim();
  if (o === "" || o === "null") return true;
  if (LOOPBACK_ORIGIN.test(o)) return true;
  return allowed.some((a) => a === "*" || a.toLowerCase() === o.toLowerCase());
}

// src/mcp/resources.ts
import { existsSync as existsSync5, readdirSync as readdirSync3, readFileSync as readFileSync4, realpathSync, statSync as statSync3 } from "fs";
import { basename as basename2, dirname as dirname2, join as join5, resolve as resolve2, sep } from "path";
import { fileURLToPath } from "url";
var skillName = () => brand().name;
var URI_SCHEME = "skill://";
function resolveSkillRoot(moduleDir) {
  const here = moduleDir ?? dirname2(fileURLToPath(import.meta.url));
  const name = brand().name;
  const candidates = [resolve2(here, ".."), resolve2(here, "..", "skills", name), resolve2(here, "..", "..", "skills", name)];
  return candidates.find((dir) => existsSync5(join5(dir, "SKILL.md")));
}
function listResources(moduleDir) {
  const root = resolveSkillRoot(moduleDir);
  if (!root) return [];
  const out = [describe(root, "SKILL.md", `${skillName()}: the skill`)];
  const refDir = join5(root, "references");
  if (!existsSync5(refDir)) return out;
  for (const file of readdirSync3(refDir).sort()) {
    if (!file.endsWith(".md")) continue;
    out.push(describe(root, join5("references", file), `${skillName()} reference: ${basename2(file, ".md")}`));
  }
  return out;
}
function readResource(uri, moduleDir) {
  if (!uri.startsWith(URI_SCHEME)) {
    throw new ResourceError(`unknown resource scheme in "${uri}" (expected ${URI_SCHEME}\u2026)`);
  }
  const root = resolveSkillRoot(moduleDir);
  if (!root) throw new ResourceError("no skill payload found next to this build \u2014 nothing to read");
  const rel = uri.slice(URI_SCHEME.length);
  if (!rel) throw new ResourceError("empty resource path");
  const target = resolve2(root, rel);
  const rootReal = realpathSync(root);
  let targetReal;
  try {
    targetReal = realpathSync(target);
  } catch {
    throw new ResourceError(`no such resource: ${uri}`);
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    throw new ResourceError(`resource path escapes the skill root: ${uri}`);
  }
  if (!statSync3(targetReal).isFile()) throw new ResourceError(`not a file: ${uri}`);
  return { uri, mimeType: "text/markdown", text: readFileSync4(targetReal, "utf8") };
}
var ResourceError = class extends Error {
};
function describe(root, rel, fallbackTitle) {
  const decl = {
    uri: `${URI_SCHEME}${rel.split(sep).join("/")}`,
    name: rel.split(sep).join("/"),
    title: fallbackTitle,
    mimeType: "text/markdown"
  };
  const summary = firstProse(join5(root, rel));
  if (summary) decl.description = summary;
  return decl;
}
function firstProse(file) {
  let text;
  try {
    text = readFileSync4(file, "utf8");
  } catch {
    return void 0;
  }
  const body = text.startsWith("---\n") ? text.slice(text.indexOf("\n---", 3) + 4) : text;
  for (const block of body.split(/\n\s*\n/)) {
    const line = block.trim();
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("|") || line.startsWith("```")) continue;
    const flat = line.replace(/\s+/g, " ").replace(/[*`]/g, "");
    return flat.length > 300 ? `${flat.slice(0, 297)}\u2026` : flat;
  }
  return void 0;
}

// src/mcp/server.ts
var ToolError = class extends Error {
};
var PromptError = class extends Error {
};
var ERR_INVALID_REQUEST = -32600;
var ERR_METHOD_NOT_FOUND = -32601;
var ERR_INVALID_PARAMS = -32602;
var ERR_INTERNAL = -32603;
function createServer(adapter, opts = {}) {
  const serverInfo = { name: opts.serverName ?? brand().name, version: adapter.version };
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  let protocol = LATEST_PROTOCOL;
  const cancelled = /* @__PURE__ */ new Set();
  const CANCELLED_MAX = 1024;
  const listTools = () => adapter.listTools(protocol);
  const prompts = () => adapter.prompts ?? [];
  async function handle(msg, send) {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
      return;
    }
    if (msg.id === void 0 || msg.id === null) {
      if (msg.method === "notifications/cancelled") {
        const target = msg.params?.requestId;
        if (typeof target === "string" || typeof target === "number") {
          if (cancelled.size >= CANCELLED_MAX) cancelled.delete(cancelled.values().next().value);
          cancelled.add(String(target));
        }
      }
      return;
    }
    const id = msg.id;
    const reply = (out) => {
      if (cancelled.delete(String(id))) return;
      send({ jsonrpc: "2.0", id, ...out });
    };
    try {
      switch (msg.method) {
        case "initialize": {
          protocol = negotiateProtocol(msg.params?.protocolVersion);
          reply({
            result: {
              protocolVersion: protocol,
              // Three primitives, because a skill is three things: the engine
              // (tools), the method (prompts) and the documentation the method
              // refers to (resources). A client given only the first has to
              // invent the other two.
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                prompts: { listChanged: false }
              },
              serverInfo
            }
          });
          return;
        }
        case "ping":
          reply({ result: {} });
          return;
        case "tools/list":
          reply({ result: { tools: listTools() } });
          return;
        case "tools/call":
          await handleToolCall(msg, reply);
          return;
        case "resources/list":
          reply({ result: { resources: listResources(opts.skillDir) } });
          return;
        case "resources/read": {
          const uri = typeof msg.params?.uri === "string" ? msg.params.uri : "";
          if (!uri) {
            reply({ error: { code: ERR_INVALID_PARAMS, message: "`uri` is required" } });
            return;
          }
          try {
            reply({ result: { contents: [readResource(uri, opts.skillDir)] } });
          } catch (e) {
            if (e instanceof ResourceError) reply({ error: { code: ERR_INVALID_PARAMS, message: e.message } });
            else reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
          }
          return;
        }
        case "prompts/list":
          reply({ result: { prompts: prompts() } });
          return;
        case "prompts/get": {
          const name = typeof msg.params?.name === "string" ? msg.params.name : "";
          const args = msg.params?.arguments ?? {};
          try {
            if (!adapter.getPrompt) throw new PromptError(`unknown prompt: ${name || "(none given)"}`);
            reply({ result: adapter.getPrompt(name, args) });
          } catch (e) {
            if (e instanceof PromptError) reply({ error: { code: ERR_INVALID_PARAMS, message: e.message } });
            else reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
          }
          return;
        }
        default:
          reply({ error: { code: ERR_METHOD_NOT_FOUND, message: `method not found: ${String(msg.method)}` } });
          return;
      }
    } catch (e) {
      reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
    }
  }
  async function handleToolCall(msg, reply) {
    const params = msg.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments ?? {};
    const decl = listTools().find((t) => t.name === name);
    if (!decl) {
      reply({ error: { code: ERR_INVALID_PARAMS, message: `unknown tool: ${name || "(none given)"}` } });
      return;
    }
    const invalid = validateArgs(decl.inputSchema, args);
    if (invalid) {
      reply({ error: { code: ERR_INVALID_PARAMS, message: invalid } });
      return;
    }
    try {
      const { text: raw, artifact } = await adapter.callTool(name, args);
      const text = capResponse(raw, name, maxBytes, artifact, adapter.capAdvice);
      const capped = text !== raw;
      const structured = protocol >= RICH_TOOLS_SINCE ? structuredContentFor(text, capped, decl.outputSchema !== void 0) : void 0;
      reply({ result: { content: [{ type: "text", text }], ...structured ? { structuredContent: structured } : {} } });
    } catch (e) {
      if (e instanceof ToolError) {
        reply({ result: { content: [{ type: "text", text: e.message }], isError: true } });
        return;
      }
      reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
    }
  }
  return {
    handle,
    protocolVersion: () => protocol,
    setProtocolVersion: (v) => {
      protocol = v;
    },
    tools: listTools
  };
}
function errMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/mcp/stdio.ts
import { createInterface } from "readline";
var MAX_IN_FLIGHT = 4;
async function runStdioServer(adapter, opts = {}) {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const emit = output.write.bind(output);
  let restore;
  if (!opts.captureStdout && output === process.stdout) {
    const original = process.stdout.write;
    process.stdout.write = ((chunk, ...rest) => process.stderr.write(chunk, ...rest));
    restore = () => {
      process.stdout.write = original;
    };
  }
  const server = createServer(adapter, opts);
  const send = (msg) => {
    emit(JSON.stringify(msg) + "\n");
  };
  const inFlight = /* @__PURE__ */ new Set();
  const track = (p) => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };
  const drainToLimit = async () => {
    while (inFlight.size >= MAX_IN_FLIGHT) await Promise.race(inFlight);
  };
  const rl = createInterface({ input, terminal: false });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      await drainToLimit();
      if (Array.isArray(parsed)) {
        track(
          (async () => {
            const out = [];
            await Promise.all(parsed.map((m) => server.handle(m, (r) => void out.push(r))));
            if (out.length) emit(JSON.stringify(out) + "\n");
          })().catch(reportInternal(send))
        );
        continue;
      }
      if (parsed === null || typeof parsed !== "object") {
        send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
        continue;
      }
      track(server.handle(parsed, send).catch(reportInternal(send)));
    }
    await Promise.all(inFlight);
  } finally {
    rl.close();
    restore?.();
  }
}
function reportInternal(send) {
  return (e) => {
    send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  };
}

// src/mcp/http.ts
import { createServer as createHttpServer } from "http";
var MCP_PATH = "/mcp";
var MAX_BODY_BYTES = 4 * 1024 * 1024;
var CORS_HEADERS = "content-type, accept, mcp-protocol-version, mcp-session-id, authorization, last-event-id";
var LOOPBACK_BIND = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "localhost"]);
function startHttpServer(adapter, opts = {}) {
  const bind = opts.bind ?? "127.0.0.1";
  if (!LOOPBACK_BIND.has(bind) && !opts.allowRemote) {
    return Promise.reject(
      new Error(
        `refusing to bind ${bind}: ${brand().name}'s MCP server fetches arbitrary URLs and reads local files. Pass --allow-remote if that is really what you want.`
      )
    );
  }
  const server = createHttpServer((req, res) => {
    void route(req, res, adapter, opts).catch((e) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 6e4;
  server.keepAliveTimeout = 12e4;
  return new Promise((resolve3, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, bind, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
      const host = bind.includes(":") ? `[${bind}]` : bind;
      resolve3({
        server,
        port,
        url: `http://${host}:${port}${MCP_PATH}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        })
      });
    });
  });
}
async function route(req, res, adapter, opts) {
  const path = (req.url ?? "").split("?")[0];
  const origin = header(req, "origin");
  if (!isOriginAllowed(origin, opts.allowOrigin)) {
    sendJson(res, 403, { error: "origin not allowed", origin });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders(origin),
      "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      "access-control-allow-headers": CORS_HEADERS,
      "access-control-max-age": "86400"
    });
    res.end();
    return;
  }
  if (path !== MCP_PATH) {
    sendJson(res, 404, { error: `not found: ${path} (the MCP endpoint is ${MCP_PATH})` }, origin);
    return;
  }
  if (req.method === "GET" || req.method === "DELETE") {
    res.writeHead(405, { allow: "POST, OPTIONS", ...corsHeaders(origin) });
    res.end(JSON.stringify({ error: `${req.method} is not supported: this server is stateless and offers no server-initiated stream` }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST, OPTIONS", ...corsHeaders(origin) });
    res.end(JSON.stringify({ error: `${req.method} is not supported` }));
    return;
  }
  const contentType = (header(req, "content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType && contentType !== "application/json") {
    sendJson(res, 415, { error: `unsupported content-type "${contentType}" \u2014 send application/json` }, origin);
    return;
  }
  const accept = (header(req, "accept") ?? "").toLowerCase();
  if (accept && !/application\/json|text\/event-stream|\*\/\*/.test(accept)) {
    sendJson(res, 406, { error: "this endpoint replies with application/json" }, origin);
    return;
  }
  const declared = header(req, "mcp-protocol-version");
  if (declared !== void 0 && !isProtocolVersion(declared)) {
    sendJson(res, 400, { error: `unsupported MCP-Protocol-Version: ${declared}` }, origin);
    return;
  }
  const protocol = declared ?? ASSUMED_HTTP_PROTOCOL;
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    if (e.message === "too large") {
      sendJson(res, 413, { error: `request body exceeds ${MAX_BODY_BYTES} bytes` }, origin);
      return;
    }
    sendJson(res, 400, { error: `could not read request body: ${e.message}` }, origin);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, origin);
    return;
  }
  const mcp = createServer(adapter, opts);
  mcp.setProtocolVersion(protocol);
  const out = [];
  const collect = (m) => void out.push(m);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const m of messages) await mcp.handle(m, collect);
  if (out.length === 0) {
    res.writeHead(202, corsHeaders(origin));
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(parsed) ? out : out[0], origin);
}
function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
function corsHeaders(origin) {
  return origin ? { "access-control-allow-origin": origin, vary: "origin" } : {};
}
function sendJson(res, status, body, origin, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text, "utf8")),
    ...corsHeaders(origin),
    ...extra
  });
  res.end(text);
}
var DRAIN_LIMIT = MAX_BODY_BYTES * 8;
function readBody(req) {
  return new Promise((resolve3, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) over = true;
    req.on("data", (c) => {
      size += c.length;
      if (over) {
        if (size > DRAIN_LIMIT) {
          req.destroy();
          reject(new Error("too large"));
        }
        return;
      }
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) reject(new Error("too large"));
      else resolve3(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("client aborted the request")));
  });
}

// src/cli.ts
configure({ name: "webindex", envPrefix: "WEBINDEX", cli: "webindex", contactUrl: "https://github.com/maxgfr/webindex" });
var HELP = `webindex v${ENGINE_VERSION}
Find pages with a local keyless search stack, turn a URL or a file into clean,
citable text \u2014 HTML, PDFs through a six-rung ladder ending in OCR, and office
documents \u2014 and serve that to an agent over MCP. Zero dependencies, no API key.

USAGE
  webindex search <query> [--json] [--limit <n>] [--pages <n>] [--lang <tag>]
                          [--engine ddg|ddglite|mojeek|off]
  webindex fetch <url> [--json] [--firecrawl <base>|off] [--lang <tag>]
  webindex extract <file> [--json]
  webindex rank --query <q> [--docs <file.json|->] [--limit <n>] [--json]
  webindex repo <ref> [--json]
  webindex issues <ref> [--terms "<words>"] [--limit <n>] [--json]
  webindex prs <ref> [--terms "<words>"] [--limit <n>] [--json]
  webindex releases <ref> [--limit <n>] [--json]
  webindex package <name> [--registry npm|pypi|crates] [--json]
  webindex meta <url> [--json]
  webindex robots <url> [--json]
  webindex sitemap <url> [--max <n>] [--json]
  webindex feed <url> [--json]
  webindex mcp [--transport stdio|http] [--port <n>] [--bind <addr>]
  webindex searxng   up|down|status
  webindex firecrawl up|down|status
  webindex semantic  up|down|status
  webindex stack     up|down|status|path
  webindex cache     status|clean [--all] [--json]
  webindex doctor
  webindex version

COMMANDS
  search     Find candidate URLs: a local SearXNG first, then the keyless
             engines (DuckDuckGo, DDG Lite, Mojeek \u2014 no key, no container),
             then Firecrawl. Prints what it found, or says which backend was
             missing and how to start it \u2014 those are different answers.
  fetch      Fetch a URL and print the extracted text. Routes PDFs and office
             documents to their ladders automatically, and falls back through
             Firecrawl and the Wayback Machine when a page resists.
  extract    Same extraction, on a file already on disk.
  rank       Order candidate documents against a question \u2014 BM25F, then a
             near-duplicate collapse, then MMR so the top says several
             different things. Reads a JSON array of {url,title,text} from
             --docs or stdin. Deterministic; no model, no network.
  repo       A repository's own facts: stars, licence, default branch, last
             push, and whether it is archived \u2014 the record, not the README.
  issues     Search a repository's issues on GitHub, GitLab or Gitea.
  prs        The same, over pull or merge requests.
  releases   Its releases, newest first, with their notes.
  package    A library NAME resolved through npm, PyPI or crates.io to its
             repository, docs, current version, licence and deprecation.
  meta       What a page says about itself: JSON-LD, OpenGraph and meta tags \u2014
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
             written. The stack is EMBEDDED in this binary \u2014 no checkout needed.
  cache      What the on-disk fetch cache holds, and how to evict it. 'clean'
             drops stale entries, '--all' drops every one.
  doctor     Report which optional helpers are reachable and which extraction
             rungs are available on this machine.

ENVIRONMENT
  WEBINDEX_FIRECRAWL     Firecrawl base URL, or "off"  (default http://localhost:3002)
  WEBINDEX_PDF_ENGINE    force one PDF rung: native|pdf-inspector|anydoc|firecrawl|pdftotext|ocr
  WEBINDEX_DOC_ENGINE    force one office rung, or "none" to disable
  WEBINDEX_NO_NPX        skip the rungs that would install through npx
  WEBINDEX_OCR_MAX       documents this process may OCR (default 3)
  WEBINDEX_ENGINES       keyless engines to try: a comma list, or "off"  (default all)
  WEBINDEX_CACHE_DIR     where the fetch cache lives
  WEBINDEX_UA            override the browser User-Agent

Every optional helper degrades to a note. Nothing here needs an API key.`;
function fail(msg) {
  process.stderr.write(`webindex: ${msg}
`);
  process.exit(1);
}
function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : void 0;
}
function positional(argv, valued) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") {
      out.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      if (valued.includes(a.slice(2))) i++;
      continue;
    }
    out.push(a);
  }
  return out.join(" ").trim();
}
async function extractLocal(path) {
  let bytes;
  try {
    bytes = readFileSync5(path);
  } catch (e) {
    fail(`cannot read ${path}: ${e.message}`);
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
function rankDocuments(question, docs, limit) {
  const bm = docs.map((d, i) => ({ id: String(i), title: d.title ?? "", headings: d.headings ?? "", body: d.text ?? "" }));
  const index = buildBm25Index(question, bm);
  const raw = docs.map((_, i) => bm25Score(index, bm[i]));
  const max = Math.max(...raw, 1e-9);
  const scored = docs.map((d, i) => ({
    url: d.url,
    title: d.title,
    text: d.text ?? "",
    score: (raw[i] ?? 0) / max,
    matched: bm25MatchedTerms(index, bm[i])
  }));
  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  const { items: unique, dropped } = dedupeNearDuplicates(scored);
  const ordered = diversify(unique, (it) => new Set(bm25Tokenize(it.text)));
  const ranked = ordered.slice(0, limit && limit > 0 ? limit : void 0).map((it, i) => ({
    rank: i + 1,
    url: it.url,
    ...it.title ? { title: it.title } : {},
    score: Number(it.score.toFixed(4)),
    matched: it.matched
  }));
  return { ranked, collapsed: dropped, queryTerms: index.queryTerms };
}
function parseRankDocs(value, where) {
  const arr = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(arr) || !arr.length) throw new Error(`${where} must be a non-empty JSON array of {url, text}`);
  return arr.map((d, i) => {
    if (!d || typeof d !== "object") throw new Error(`${where}[${i}] is not an object`);
    const url = d.url;
    if (typeof url !== "string" || !url) throw new Error(`${where}[${i}] has no url`);
    return d;
  });
}
function webindexAdapter() {
  return {
    version: ENGINE_VERSION,
    listTools: () => [
      {
        name: "webindex_search",
        title: "Search for candidate URLs",
        description: "Find candidate URLs: a locally-running SearXNG first, then the keyless engines (DuckDuckGo, DuckDuckGo Lite, Mojeek \u2014 no key, no container), then Firecrawl. Returns title, URL and snippet \u2014 not page text; follow up with webindex_fetch on the ones worth reading. When nothing answers it says which piece was missing rather than returning an empty result that reads like 'nothing exists'.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for." },
            limit: { type: "number", description: "How many hits to aim for (default 10)." },
            lang: { type: "string", description: "BCP-47 language tag, e.g. fr-FR." },
            engine: {
              type: "string",
              description: "Pin one keyless engine: ddg | ddglite | mojeek. Omit to let the cascade choose.",
              enum: [...KEYLESS_ENGINES]
            }
          },
          required: ["query"]
        }
      },
      {
        name: "webindex_fetch",
        title: "Fetch a URL as clean text",
        description: "Fetch a URL and return its readable text. Handles HTML, PDFs (native reader \u2192 pdf-inspector \u2192 anydoc \u2192 Firecrawl \u2192 pdftotext \u2192 OCR) and office documents, and falls back through Firecrawl and the Wayback Machine for pages that resist. Returns the extracted text plus which rung produced it \u2014 never raw bytes.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The http(s) URL to fetch." },
            lang: { type: "string", description: "Accept-Language tag, e.g. fr-FR." }
          },
          required: ["url"]
        }
      },
      {
        name: "webindex_extract",
        title: "Extract text from a local file",
        description: "Read a PDF, office document or HTML file already on disk and return its text, using the same extraction ladders as webindex_fetch.",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute path to the file." } }, required: ["path"] }
      },
      {
        name: "webindex_rank",
        title: "Rank candidate documents against a question",
        description: "Order a pool of documents by relevance to a question: BM25F (title and headings weighted above body), then SimHash collapse of near-duplicates, then MMR so the top of the list says several different things rather than restating one. Returns the ranking with a score, the matched query terms, and what was collapsed \u2014 deterministic, no model, no network. Use it after gathering pages to decide what to actually read.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "What the ranking is for." },
            documents: {
              type: "array",
              description: 'The pool. Each item is {url, text} plus optional {title, headings, score}. Passed as JSON, e.g. [{"url":"\u2026","title":"\u2026","text":"\u2026"}].'
            },
            limit: { type: "number", description: "How many ranked entries to return (default all)." }
          },
          required: ["question", "documents"]
        }
      },
      {
        name: "webindex_repo",
        title: "A repository's own facts",
        description: "Read a repository's record from GitHub, GitLab or Gitea: description, stars, licence, default branch, last push, topics, and whether it is ARCHIVED. Answers 'is this maintained' from the forge rather than from a README that says it is. Keyless; a token only raises the quota.",
        inputSchema: {
          type: "object",
          properties: { repo: { type: "string", description: "owner/repo, a URL, or git@host:owner/repo." } },
          required: ["repo"]
        }
      },
      {
        name: "webindex_issues",
        title: "Search a repository's issues or pull requests",
        description: "Search issues (or pull/merge requests) in one repository across GitHub, GitLab and Gitea. Returns number, title, state, labels and body. GitHub results are relevance-ranked and carry a score; GitLab and Gitea have no search endpoint, so theirs are recency-ordered and carry none \u2014 deliberately, rather than inventing one.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/repo, or a repository URL." },
            terms: { type: "string", description: "What to look for." },
            kind: { type: "string", description: "issue (default) or pr.", enum: ["issue", "pr"] },
            limit: { type: "number", description: "How many to return (default 10)." }
          },
          required: ["repo"]
        }
      },
      {
        name: "webindex_releases",
        title: "A repository's releases",
        description: "List releases newest-first with their notes and dates \u2014 the authoritative answer to 'what changed', and to 'when was X added'.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/repo, or a repository URL." },
            limit: { type: "number", description: "How many (default 20)." }
          },
          required: ["repo"]
        }
      },
      {
        name: "webindex_package",
        title: "Resolve a library name to its real coordinates",
        description: "Look a package up in npm, PyPI or crates.io and return its repository, homepage, documentation URL, current version, licence and any DEPRECATION notice. Use this before searching the web for a library: it is one request, and it is the registry's own answer rather than whatever ranks for '<name> official documentation'.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The package name." },
            registry: { type: "string", description: "Skip the guessing when you know the ecosystem.", enum: ["npm", "pypi", "crates"] },
            version: { type: "string", description: "A specific version, instead of the latest." }
          },
          required: ["name"]
        }
      },
      {
        name: "webindex_meta",
        title: "What a page says about itself",
        description: "Read a page's own structured metadata \u2014 JSON-LD, OpenGraph and meta tags \u2014 and return author, publication and modification dates, type, site name and canonical URL. Far cheaper and far more reliable than inferring a publication date from body text, and it does not need the page's prose at all.",
        inputSchema: { type: "object", properties: { url: { type: "string", description: "The page to inspect." } }, required: ["url"] }
      },
      {
        name: "webindex_robots",
        title: "Is this URL ours to fetch?",
        description: "Check the site's robots.txt for this URL: whether it is allowed, any crawl-delay, and the sitemaps the file advertises. Advisory \u2014 webindex_fetch does not consult it, because following one citation is not crawling. Ask before enumerating a site.",
        inputSchema: { type: "object", properties: { url: { type: "string", description: "The URL to check." } }, required: ["url"] }
      },
      {
        name: "webindex_sitemap",
        title: "What pages does this site list?",
        description: "Fetch and parse the site's sitemap (following the ones robots.txt names first), returning page URLs with their last-modified dates. A sitemap index is followed at most `max` documents deep \u2014 enumerating a site is a budget you set, not something this does on its own.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Any URL on the site." },
            max: { type: "number", description: "Sitemap documents to fetch (default 3)." }
          },
          required: ["url"]
        }
      },
      {
        name: "webindex_feed",
        title: "A site's RSS or Atom feed",
        description: "Parse a feed URL, or discover and parse the feeds a page advertises. Returns dated, ordered entries \u2014 the site telling you what it published and when, instead of a web search guessing.",
        inputSchema: { type: "object", properties: { url: { type: "string", description: "A feed URL, or a page that links to one." } }, required: ["url"] }
      }
    ],
    capAdvice: {
      webindex_search: "lower `limit`",
      webindex_repo: "this repository's record is unusually large; ask for what you need instead",
      webindex_issues: "lower `limit`, or narrow `terms`",
      webindex_releases: "lower `limit` \u2014 release notes are long",
      webindex_package: "this package's registry record is unusually large; pin a `version`",
      webindex_meta: "the page is very large; this reads only its head, so a cap here means the document itself is enormous",
      webindex_robots: "this site's robots.txt is unusually large; read it directly",
      webindex_sitemap: "lower `max`, or read one child sitemap at a time",
      webindex_feed: "the feed is very large; fetch it and read the file instead of inlining it",
      webindex_fetch: "the page is very large; fetch it and read the file instead of inlining it",
      webindex_extract: "the document is very large; read it in pieces",
      webindex_rank: "lower `limit`, or send shorter `text` per document \u2014 the ranking only needs enough to score"
    },
    async callTool(name, args) {
      if (name === "webindex_fetch") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        const r = await fetchAndExtract(url, { acceptLanguage: args.lang ? String(args.lang) : void 0 });
        if (!r.text) throw new ToolError(`Nothing readable at ${url}${r.note ? ` \u2014 ${r.note}` : ""}.`);
        return { text: `${r.text}

---
extractor: ${r.extractor ?? "native"}` };
      }
      if (name === "webindex_search") {
        const q = String(args.query ?? "").trim();
        if (!q) throw new ToolError("`query` is required.");
        const raw = args.engine ? String(args.engine) : void 0;
        if (raw !== void 0 && !isKeylessEngine(raw)) throw new ToolError(`unknown engine "${raw}" \u2014 expected one of ${KEYLESS_ENGINES.join(", ")}`);
        const engines = raw === void 0 ? void 0 : [raw];
        const r = await search(q, {
          limit: typeof args.limit === "number" ? args.limit : void 0,
          lang: args.lang ? String(args.lang) : void 0,
          ...engines ? { engines } : {}
        });
        if (!r.hits.length) throw new ToolError(r.notes.join(" ") || "No results.");
        const body = r.hits.map((h, i) => `${i + 1}. ${h.title}
   ${h.url}${h.snippet ? `
   ${h.snippet}` : ""}`).join("\n\n");
        return { text: r.notes.length ? `${body}

---
${r.notes.join("\n")}` : body };
      }
      if (name === "webindex_extract") {
        const r = await extractLocal(String(args.path ?? ""));
        if (!r.text) throw new ToolError(`Nothing readable in that file${r.reason ? ` \u2014 ${r.reason}` : ""}.`);
        return { text: `${r.text}

---
extractor: ${r.extractor}` };
      }
      if (name === "webindex_rank") {
        const question = String(args.question ?? "").trim();
        if (!question) throw new ToolError("`question` is required.");
        let docs;
        try {
          docs = parseRankDocs(args.documents, "`documents`");
        } catch (e) {
          throw new ToolError(e.message);
        }
        const r = rankDocuments(question, docs, typeof args.limit === "number" ? args.limit : void 0);
        if (!r.queryTerms.length) {
          throw new ToolError("`question` has no rankable terms once stopwords are removed \u2014 nothing to score against.");
        }
        return { text: JSON.stringify(r, null, 2) };
      }
      if (name === "webindex_package") {
        const pkg = String(args.name ?? "").trim();
        if (!pkg) throw new ToolError("`name` is required.");
        const reg = args.registry ? String(args.registry) : void 0;
        const p = await resolvePackage(pkg, { ...reg ? { registry: reg } : {}, ...args.version ? { version: String(args.version) } : {} });
        if (!p) throw new ToolError(`No registry knows a package called "${pkg}".`);
        return { text: JSON.stringify(p, null, 2) };
      }
      if (name === "webindex_repo" || name === "webindex_issues" || name === "webindex_releases") {
        const ref = resolveRepo(String(args.repo ?? ""));
        if (ref.host === "generic") throw new ToolError(`"${String(args.repo ?? "")}" does not name a repository.`);
        const limit = typeof args.limit === "number" ? args.limit : void 0;
        if (name === "webindex_repo") {
          const f = await repoFacts(ref);
          if (!f) throw new ToolError(`Could not read ${ref.webUrl ?? ref.raw} \u2014 is it public, and is ${ref.host} a forge?`);
          return { text: JSON.stringify({ ref, ...f }, null, 2) };
        }
        const r = name === "webindex_releases" ? await listReleases(ref, { ...limit ? { limit } : {} }) : await searchIssues(
          ref,
          String(args.terms ?? "").split(/\s+/).filter(Boolean),
          args.kind === "pr" ? "pr" : "issue",
          { ...limit ? { limit } : {} }
        );
        if (!r.items.length) throw new ToolError(r.note ?? `Nothing found for ${ref.raw}.`);
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
          const s = await fetchSitemap(url, { sitemaps: robots.sitemaps, max: typeof args.max === "number" ? args.max : void 0 });
          if (!s.urls.length && !s.sitemaps.length) throw new ToolError(`No sitemap found for ${url}.`);
          return { text: JSON.stringify(s, null, 2) };
        }
        const page = await httpGet(url, { accept: "text/html,application/xml,*/*" });
        if (!page.ok) throw new ToolError(`Could not fetch ${url} (status ${page.status}).`);
        if (name === "webindex_meta") return { text: JSON.stringify(pageMetadata(page.body), null, 2) };
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
      throw new ToolError(`unknown tool: ${name}`);
    }
  };
}
async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    process.stdout.write(ENGINE_VERSION + "\n");
    return;
  }
  if (cmd === "search") {
    const q = positional(argv, ["limit", "pages", "lang", "searxng", "firecrawl", "engine"]);
    if (!q) fail("usage: webindex search <query>");
    const engine = flag(argv, "engine");
    if (engine && engine !== "off" && !isKeylessEngine(engine)) fail(`unknown --engine "${engine}" \u2014 expected one of ${KEYLESS_ENGINES.join(", ")}, or off`);
    const r = await search(q, {
      limit: flag(argv, "limit") ? Number(flag(argv, "limit")) : void 0,
      pages: flag(argv, "pages") ? Number(flag(argv, "pages")) : void 0,
      lang: flag(argv, "lang"),
      searxng: flag(argv, "searxng"),
      firecrawl: flag(argv, "firecrawl"),
      ...engine ? { engines: engine === "off" ? [] : [engine] } : {}
    });
    if (argv.includes("--json")) {
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      return;
    }
    for (const h of r.hits) {
      process.stdout.write(`${h.title}
  ${h.url}${h.snippet ? `
  ${h.snippet.slice(0, 160)}` : ""}

`);
    }
    for (const n of r.notes) process.stderr.write(`  ${n}
`);
    if (!r.hits.length) process.exit(1);
    return;
  }
  if (cmd === "fetch") {
    const url = argv[1];
    if (!url || url.startsWith("--")) fail("usage: webindex fetch <url>");
    if (!/^https?:\/\//i.test(url)) fail("fetch needs an http(s) URL");
    const r = await fetchAndExtract(url, { acceptLanguage: flag(argv, "lang"), firecrawl: flag(argv, "firecrawl") });
    if (argv.includes("--json")) {
      process.stdout.write(
        JSON.stringify({ url, title: r.title, extractor: r.extractor, status: r.status, chars: r.text.length, note: r.note, text: r.text }, null, 2) + "\n"
      );
      return;
    }
    if (!r.text) fail(`nothing readable at ${url}${r.note ? ` \u2014 ${r.note}` : ""}`);
    process.stdout.write(r.text + "\n");
    return;
  }
  if (cmd === "extract") {
    const path = argv[1];
    if (!path || path.startsWith("--")) fail("usage: webindex extract <file>");
    const r = await extractLocal(path);
    if (argv.includes("--json")) {
      process.stdout.write(
        JSON.stringify({ file: basename3(path), extractor: r.extractor, chars: r.text.length, reason: r.reason, text: r.text }, null, 2) + "\n"
      );
      return;
    }
    if (!r.text) fail(`nothing readable in ${path}${r.reason ? ` \u2014 ${r.reason}` : ""}`);
    process.stdout.write(r.text + "\n");
    return;
  }
  if (cmd === "mcp") {
    const transport = flag(argv, "transport") ?? "stdio";
    if (transport === "stdio") {
      await runStdioServer(webindexAdapter());
      return;
    }
    if (transport !== "http") fail(`unknown transport "${transport}" \u2014 expected stdio or http`);
    const port = Number(flag(argv, "port") ?? 7340);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail("invalid --port");
    let running;
    try {
      running = await startHttpServer(webindexAdapter(), { port, bind: flag(argv, "bind"), allowRemote: argv.includes("--allow-remote") });
    } catch (e) {
      fail(e.message);
    }
    process.stderr.write(`webindex: MCP server listening on ${running.url}
`);
    process.stderr.write(`  client: claude mcp add --transport http webindex ${running.url}
`);
    return;
  }
  if (STACK_SERVICES.includes(cmd) && cmd !== "all" || cmd === "stack") {
    const action = argv[1] ?? "status";
    if (cmd === "stack" && action === "path") {
      process.stdout.write(ensureComposeMaterialized() + "\n");
      return;
    }
    const valid = cmd === "stack" ? ["up", "down", "status", "path"] : ["up", "down", "status"];
    if (!valid.includes(action)) fail(`usage: webindex ${cmd} ${valid.join("|")}`);
    const r = stackControl(cmd === "stack" ? "all" : cmd, action);
    (r.code === 0 ? process.stdout : process.stderr).write(r.message + "\n");
    if (r.code !== 0) process.exit(r.code);
    return;
  }
  if (cmd === "rank") {
    const question = flag(argv, "query");
    if (!question) fail("usage: webindex rank --query <question> --docs <file.json|-> [--limit <n>] [--json]");
    const src = flag(argv, "docs") ?? "-";
    let payload;
    try {
      payload = src === "-" ? readFileSync5(0, "utf8") : readFileSync5(src, "utf8");
    } catch (e) {
      fail(`cannot read ${src === "-" ? "stdin" : src}: ${e.message}`);
    }
    let docs;
    try {
      docs = parseRankDocs(payload, "--docs");
    } catch (e) {
      fail(e.message);
    }
    const limit = flag(argv, "limit") ? Number(flag(argv, "limit")) : void 0;
    const r = rankDocuments(question, docs, limit);
    if (argv.includes("--json")) {
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      r.ranked.map((x) => `${x.rank}. [${x.score.toFixed(3)}] ${x.title ?? x.url}
   ${x.url}${x.matched.length ? `
   matched: ${x.matched.join(", ")}` : ""}`).join("\n\n") + "\n"
    );
    if (r.collapsed) process.stderr.write(`${r.collapsed} near-duplicate(s) collapsed.
`);
    if (!r.queryTerms.length) {
      process.stderr.write("The question has no rankable terms once stopwords are removed \u2014 the order is arbitrary.\n");
      process.exit(1);
    }
    return;
  }
  if (cmd === "repo" || cmd === "issues" || cmd === "prs" || cmd === "releases" || cmd === "package") {
    const target = positional(argv, ["limit", "registry", "version", "terms"]);
    if (!target) fail(`usage: webindex ${cmd} <${cmd === "package" ? "name" : "repo"}> [--json]`);
    const asJson = argv.includes("--json");
    const limit = flag(argv, "limit") ? Number(flag(argv, "limit")) : void 0;
    const emit = (obj, human) => process.stdout.write(asJson ? `${JSON.stringify(obj, null, 2)}
` : `${human.join("\n")}
`);
    if (cmd === "package") {
      const reg = flag(argv, "registry");
      const p = await resolvePackage(target, { ...reg ? { registry: reg } : {}, ...flag(argv, "version") ? { version: flag(argv, "version") } : {} });
      if (!p) fail(`no registry knows a package called "${target}"`);
      emit(p, [
        `  registry    ${p.registry}`,
        `  version     ${p.version ?? "\u2014"}`,
        `  repository  ${p.repository ?? "\u2014"}`,
        `  homepage    ${p.homepage ?? "\u2014"}`,
        `  docs        ${p.documentation ?? "\u2014"}`,
        `  license     ${p.license ?? "\u2014"}`,
        ...p.deprecated ? [`  DEPRECATED  ${p.deprecated}`] : []
      ]);
      return;
    }
    const ref = resolveRepo(target);
    if (ref.host === "generic") fail(`"${target}" does not name a repository`);
    if (cmd === "repo") {
      const f = await repoFacts(ref);
      if (!f) fail(`could not read ${ref.webUrl ?? target} \u2014 is it public, and is ${ref.host} a forge?`);
      emit({ ref, ...f }, [
        `  name        ${f.fullName ?? `${ref.owner}/${ref.repo}`}`,
        `  description ${f.description ?? "\u2014"}`,
        `  stars       ${f.stars ?? "\u2014"}`,
        `  license     ${f.license ?? "\u2014"}`,
        `  branch      ${f.defaultBranch ?? "\u2014"}`,
        `  last push   ${f.pushedAt ?? "\u2014"}`,
        ...f.archived ? ["  ARCHIVED    this repository is read-only upstream"] : []
      ]);
      return;
    }
    const r = cmd === "releases" ? await listReleases(ref, { ...limit ? { limit } : {} }) : await searchIssues(ref, (flag(argv, "terms") ?? "").split(/\s+/).filter(Boolean), cmd === "prs" ? "pr" : "issue", { ...limit ? { limit } : {} });
    if (!r.items.length) fail(r.note ?? `nothing found for ${target}`);
    emit(
      r,
      r.items.map((i) => `${i.number ? `#${i.number} ` : ""}${i.title}${i.state ? ` [${i.state}]` : ""}
  ${i.url}`)
    );
    if (r.note) process.stderr.write(`${r.note}
`);
    return;
  }
  if (cmd === "meta" || cmd === "robots" || cmd === "sitemap" || cmd === "feed") {
    const target = positional(argv, ["max"]);
    if (!target) fail(`usage: webindex ${cmd} <url>`);
    if (!/^https?:\/\//i.test(target)) fail("expected an http(s) URL");
    const asJson = argv.includes("--json");
    const emit = (obj, human) => process.stdout.write(asJson ? `${JSON.stringify(obj, null, 2)}
` : `${human.join("\n")}
`);
    if (cmd === "robots") {
      const r = await fetchRobots(target);
      const allowed = isAllowed(r, target);
      emit({ url: target, allowed, ...r }, [
        `  allowed   ${allowed ? "yes" : "no"}`,
        `  rules     ${r.absent ? "none (no robots.txt)" : r.rules.length}`,
        ...r.crawlDelayMs ? [`  delay     ${r.crawlDelayMs}ms`] : [],
        ...r.sitemaps.length ? [`  sitemaps  ${r.sitemaps.join("\n            ")}`] : []
      ]);
      if (!allowed) process.exit(1);
      return;
    }
    if (cmd === "sitemap") {
      const robots = await fetchRobots(target);
      const s = await fetchSitemap(target, { sitemaps: robots.sitemaps, max: flag(argv, "max") ? Number(flag(argv, "max")) : void 0 });
      if (!s.urls.length && !s.sitemaps.length) fail(`no sitemap found for ${target}`);
      emit(
        s,
        s.urls.map((u) => u.loc)
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
          direct.items.map((i) => `${i.published ? `${i.published}  ` : ""}${i.title ?? ""}
  ${i.url ?? ""}`)
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
        feeds.flatMap((f) => [`# ${f.title ?? f.url}`, ...f.items.map((i) => `${i.published ? `${i.published}  ` : ""}${i.title ?? ""}
  ${i.url ?? ""}`)])
      );
      return;
    }
    const m = pageMetadata(page.body);
    emit(m, [
      `  title      ${m.title ?? "\u2014"}`,
      `  type       ${m.type ?? "\u2014"}`,
      `  site       ${m.siteName ?? "\u2014"}`,
      `  published  ${m.publishedAt ?? "\u2014"}`,
      `  modified   ${m.modifiedAt ?? "\u2014"}`,
      `  authors    ${m.authors.join(", ") || "\u2014"}`,
      `  canonical  ${m.canonicalUrl ?? "\u2014"}`
    ]);
    return;
  }
  if (cmd === "cache") {
    const action = argv[1] ?? "status";
    if (action !== "status" && action !== "clean") fail("usage: webindex cache status|clean [--all]");
    if (action === "clean") {
      const all = argv.includes("--all");
      const removed = cacheClean(all);
      process.stdout.write(`${removed} entr${removed === 1 ? "y" : "ies"} removed (${all ? "all" : "stale only"}) from ${cacheDir()}
`);
      return;
    }
    const s = cacheStats();
    if (argv.includes("--json")) {
      process.stdout.write(JSON.stringify(s, null, 2) + "\n");
      return;
    }
    const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
    process.stdout.write(
      [
        `  dir      ${s.dir}`,
        `  entries  ${s.entries} (${s.fresh} fresh, ${s.stale} stale)`,
        `  size     ${mb(s.bytes)}`,
        `  ttl      ${Math.round(s.ttlMs / 1e3)}s`,
        ...s.oldest ? [`  oldest   ${s.oldest}`, `  newest   ${s.newest}`] : []
      ].join("\n") + "\n"
    );
    return;
  }
  if (cmd === "doctor") {
    const base = firecrawlBase();
    const sx = searxngBase();
    const [fc, sxUp] = await Promise.all([base ? probeFirecrawl(base) : false, sx ? probeSearxng(sx) : false]);
    const ocr = await ocrTools();
    const lines = [
      `webindex ${ENGINE_VERSION}`,
      `  searxng     ${sx ? sxUp ? `answering at ${sx}` : `not reachable at ${sx} \u2014 \`webindex searxng up\` starts it` : "disabled"}`,
      `  firecrawl   ${base ? fc ? `answering at ${base}` : `not reachable at ${base} \u2014 the built-in extractor is used instead` : "disabled"}`,
      `  pdf rungs   ${enabledExtractors().join(", ")}`,
      `  doc rungs   ${enabledDocExtractors().join(", ") || "none (disabled)"}`,
      `  ocr         ${ocr.copyablePdf && ocr.tesseract ? "available" : `unavailable (copyable-pdf: ${ocr.copyablePdf ? "yes" : "no"}, tesseract: ${ocr.tesseract ? "yes" : "no"})`}`,
      "",
      "  Everything optional degrades to a note \u2014 nothing above is required, and none of it needs a key."
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  fail(`unknown command "${cmd}" \u2014 run \`webindex --help\``);
}
if (process.argv[1] && /webindex(\.mjs)?$/.test(process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(`webindex: ${e.message}
`);
    process.exit(1);
  });
}
export {
  main,
  webindexAdapter
};
