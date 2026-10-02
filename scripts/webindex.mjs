#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};

// src/brand.ts
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
function countFetch(bytes, cached = false) {
  const hook = current.onFetch;
  if (!hook) return;
  try {
    hook(bytes, cached);
  } catch {
  }
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
var DEFAULT_BRAND, current;
var init_brand = __esm({
  "src/brand.ts"() {
    "use strict";
    DEFAULT_BRAND = {
      name: "webindex",
      envPrefix: "WEBINDEX",
      cli: "webindex",
      contactUrl: "https://github.com/maxgfr/webindex"
    };
    current = { ...DEFAULT_BRAND };
  }
});

// src/no-write.ts
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
function isNoWrite() {
  return flagged || envFlag("NO_WRITE");
}
function ensureDir(dir) {
  if (isNoWrite()) return;
  mkdirSync(dir, { recursive: true });
}
function writeArtifact(path, content) {
  if (isNoWrite()) {
    const at = collected.findIndex((a) => a.path === path);
    if (at !== -1) collected[at] = { path, content };
    else collected.push({ path, content });
    return path;
  }
  writeFileAtomic(path, content);
  return path;
}
function writeFileAtomic(path, content, mode2) {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    writeFileSync(tmp, content, mode2 === void 0 ? void 0 : { mode: mode2 });
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
}
var flagged, collected, tmpCounter;
var init_no_write = __esm({
  "src/no-write.ts"() {
    "use strict";
    init_brand();
    flagged = false;
    collected = [];
    tmpCounter = 0;
  }
});

// src/mime.ts
var AMBIGUOUS_TYPES;
var init_mime = __esm({
  "src/mime.ts"() {
    "use strict";
    AMBIGUOUS_TYPES = /* @__PURE__ */ new Set([
      "",
      "application/octet-stream",
      "binary/octet-stream",
      "application/x-download",
      "application/force-download",
      "application/download",
      "application/unknown",
      "application/zip",
      "application/x-zip-compressed"
    ]);
  }
});

// src/charset.ts
function bomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) return { encoding: "utf-8", skip: 3 };
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) return { encoding: "utf-16le", skip: 2 };
  if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) return { encoding: "utf-16be", skip: 2 };
  return void 0;
}
function charsetFromContentType(contentType) {
  return CHARSET_IN_CONTENT_TYPE.exec(contentType ?? "")?.[1]?.toLowerCase();
}
function prescanLabel(label) {
  const lower = label.toLowerCase();
  if (UTF16_LABELS.has(lower)) return "utf-8";
  return lower === "x-user-defined" ? "windows-1252" : lower;
}
function metaAttributes(tag) {
  const attrs = /* @__PURE__ */ new Map();
  for (const m of tag.slice(5).matchAll(TAG_ATTRIBUTE)) {
    const value = m[2] ?? m[3] ?? m[4];
    const name2 = m[1].toLowerCase();
    if (value !== void 0 && !attrs.has(name2)) attrs.set(name2, value);
  }
  return attrs;
}
function charsetFromHtml(head) {
  for (const [tag] of head.slice(0, 4096).matchAll(META_TAG)) {
    const attrs = metaAttributes(tag);
    const direct = attrs.get("charset")?.trim();
    if (direct) return prescanLabel(direct);
    if (attrs.get("http-equiv")?.trim().toLowerCase() !== "content-type") continue;
    const pragma = charsetFromContentType(attrs.get("content") ?? "");
    if (pragma) return prescanLabel(pragma);
  }
  return void 0;
}
function charsetFromXmlDeclaration(bytes) {
  const label = XML_DECLARATION.exec(bytes.subarray(0, 256).toString("latin1"))?.[1];
  return label ? prescanLabel(label) : void 0;
}
function readsAsUtf8(text) {
  let valid = 0;
  let replaced = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 || c >= 56320 && c <= 57343) continue;
    if (c === 65533) replaced++;
    else valid++;
  }
  return valid > replaced;
}
function decodeUtf8OrCp1252(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text;
  try {
    text = decoder.decode(bytes, { stream: true });
  } catch {
    const lenient = new TextDecoder("utf-8").decode(bytes);
    return readsAsUtf8(lenient) ? lenient : decodeCp1252(bytes);
  }
  try {
    return text + decoder.decode();
  } catch {
    return /[\x80-\uffff]/.test(text) ? text : decodeCp1252(bytes);
  }
}
function decodeBody(bytes, contentType = "") {
  const bom = bomEncoding(bytes);
  if (bom) return decodeWith(bytes.subarray(bom.skip), bom.encoding);
  const declared = charsetFromContentType(contentType);
  if (declared && !isUtf8Label(declared)) return decodeWith(bytes, declared);
  if (declared) return bytes.toString("utf8");
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const own = charsetFromXmlDeclaration(bytes) ?? (SNIFFABLE_MIME.has(mime) ? charsetFromHtml(bytes.subarray(0, 4096).toString("latin1")) : void 0);
  if (own && !isUtf8Label(own)) return decodeWith(bytes, own);
  return decodeUtf8OrCp1252(bytes);
}
function decodeLocal(bytes, opts = {}) {
  const bom = bomEncoding(bytes);
  if (bom) return decodeWith(bytes.subarray(bom.skip), bom.encoding);
  const own = charsetFromXmlDeclaration(bytes) ?? (opts.sniffHtmlCharset === false ? void 0 : charsetFromHtml(bytes.subarray(0, 4096).toString("latin1")));
  if (own && !isUtf8Label(own)) return decodeWith(bytes, own);
  return decodeUtf8OrCp1252(bytes);
}
function decodeCp1252(bytes) {
  return bytes.toString("latin1").replace(CP1252_C1_RANGE, cp1252C1);
}
function decodeWith(bytes, encoding) {
  if (CP1252_LABELS.has(encoding)) return decodeCp1252(bytes);
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}
var CHARSET_IN_CONTENT_TYPE, UTF16_LABELS, META_TAG, TAG_ATTRIBUTE, XML_DECLARATION, isUtf8Label, SNIFFABLE_MIME, CP1252_C1, CP1252_LABELS, CP1252_C1_RANGE, cp1252C1;
var init_charset = __esm({
  "src/charset.ts"() {
    "use strict";
    init_mime();
    CHARSET_IN_CONTENT_TYPE = /charset\s*=\s*["']?([a-z0-9_:.+-]+)/i;
    UTF16_LABELS = /* @__PURE__ */ new Set(["utf-16", "utf-16le", "utf-16be", "unicode", "unicodefeff", "unicodefffe", "ucs-2", "csunicode", "iso-10646-ucs-2"]);
    META_TAG = /<meta\b(?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*(?:>|$)/gi;
    TAG_ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s"'=<>`]+)))?/g;
    XML_DECLARATION = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/;
    isUtf8Label = (label) => label === "utf-8" || label === "utf8";
    SNIFFABLE_MIME = /* @__PURE__ */ new Set(["text/html", "application/xhtml+xml", ...AMBIGUOUS_TYPES]);
    CP1252_C1 = [
      8364,
      129,
      8218,
      402,
      8222,
      8230,
      8224,
      8225,
      710,
      8240,
      352,
      8249,
      338,
      141,
      381,
      143,
      144,
      8216,
      8217,
      8220,
      8221,
      8226,
      8211,
      8212,
      732,
      8482,
      353,
      8250,
      339,
      157,
      382,
      376
    ];
    CP1252_LABELS = /* @__PURE__ */ new Set([
      "windows-1252",
      "cp1252",
      "cp-1252",
      "x-cp1252",
      "ansi_x3.4-1968",
      "iso-8859-1",
      "iso8859-1",
      "latin1",
      "l1",
      "us-ascii",
      "ascii"
    ]);
    CP1252_C1_RANGE = /[\x80-\x9f]/g;
    cp1252C1 = (c) => String.fromCharCode(CP1252_C1[c.charCodeAt(0) - 128]);
  }
});

// src/doc/formats.ts
function docFormatForUrl(url) {
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url);
  return m ? BY_EXTENSION[m[1].toLowerCase()] : void 0;
}
function docFormatForContentType(contentType) {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type ? BY_CONTENT_TYPE[type] : void 0;
}
function sniffDocument(bytes) {
  const head = bytes.subarray(0, 1024).toString("latin1");
  if (PDF_HEADER_RE.test(head)) return "pdf";
  if (bytes.subarray(0, 8).equals(OLE_SIGNATURE)) return BINARY;
  if (head.startsWith("{\\rtf")) return BINARY;
  if (head.startsWith("PK") && (head.startsWith("mimetype", 30) || bytes.includes("[Content_Types].xml"))) return BINARY;
  return void 0;
}
var BINARY, CSV, BY_EXTENSION, BY_CONTENT_TYPE, DOC_EXTENSIONS, PDF_HEADER_RE, OLE_SIGNATURE;
var init_formats = __esm({
  "src/doc/formats.ts"() {
    "use strict";
    BINARY = { textFallback: false };
    CSV = { format: "csv", textFallback: true };
    BY_EXTENSION = {
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
    BY_CONTENT_TYPE = {
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
    DOC_EXTENSIONS = Object.keys(BY_EXTENSION);
    PDF_HEADER_RE = /(?:^|[\r\n])%PDF-\d/;
    OLE_SIGNATURE = Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]);
  }
});

// src/process-tree.ts
import { spawn, spawnSync } from "child_process";
import { readdirSync, readFileSync as readFileSync6 } from "fs";
function addChild(tree, parent, child) {
  const siblings = tree.get(parent);
  if (siblings) siblings.push(child);
  else tree.set(parent, [child]);
}
function treeFromProc() {
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return void 0;
  }
  const tree = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat2;
    try {
      stat2 = readFileSync6(`/proc/${entry}/stat`, "latin1");
    } catch {
      continue;
    }
    const ppid = Number(stat2.slice(stat2.lastIndexOf(")") + 2).split(" ")[1]);
    if (ppid > 0) addChild(tree, ppid, Number(entry));
  }
  return tree;
}
function treeFromPs() {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5e3 });
  if (r.status !== 0 || !r.stdout) return void 0;
  const tree = /* @__PURE__ */ new Map();
  for (const line of r.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) addChild(tree, ppid, pid);
  }
  return tree;
}
function descendants(pid) {
  const tree = (process.platform === "linux" ? treeFromProc() : void 0) ?? treeFromPs();
  if (!tree) return [];
  const found = /* @__PURE__ */ new Set();
  const queue2 = [pid];
  while (queue2.length) {
    for (const child of tree.get(queue2.shift()) ?? []) {
      if (found.has(child) || child === pid) continue;
      found.add(child);
      queue2.push(child);
    }
  }
  return [...found];
}
function killTree(child) {
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill("SIGKILL"));
    } else {
      const pids = child.pid ? descendants(child.pid) : [];
      child.kill("SIGKILL");
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
    }
  } catch {
    child.kill("SIGKILL");
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}
var init_process_tree = __esm({
  "src/process-tree.ts"() {
    "use strict";
  }
});

// src/pdf/exec.ts
import { spawn as spawn2 } from "child_process";
function binaryName(name2) {
  return process.platform === "win32" && name2 === "npx" ? "npx.cmd" : name2;
}
function runWithInput(cmd, args, input, timeoutMs, opts = {}) {
  return new Promise((resolve12) => {
    let child;
    try {
      const bin = binaryName(cmd);
      const viaShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin);
      const quote = (s) => `"${s.replace(/"/g, '""')}"`;
      const common = { stdio: ["pipe", "pipe", "pipe"], ...opts.env ? { env: opts.env } : {} };
      child = viaShell ? spawn2([bin, ...args].map(quote).join(" "), { ...common, shell: true, windowsHide: true }) : spawn2(bin, args, common);
    } catch (e) {
      resolve12({ ok: false, stdout: "", error: e.message });
      return;
    }
    const chunks = [];
    let size = 0;
    let stderrHead = "";
    let stderrTail = "";
    let stderrCut = false;
    const withStderr = (r) => {
      const stderr = (stderrCut ? `${stderrHead}
\u2026
${stderrTail}` : stderrHead + stderrTail).trim();
      return stderr ? { ...r, stderr } : r;
    };
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve12(r);
    };
    const timer = setTimeout(() => {
      killTree(child);
      done(withStderr({ ok: false, stdout: "", error: `timed out after ${Math.round(timeoutMs / 1e3)}s` }));
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      if (size >= MAX_STDOUT_BYTES) return;
      size += d.length;
      chunks.push(d);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      let rest = chunk;
      if (stderrHead.length < STDERR_END_CHARS) {
        const room = STDERR_END_CHARS - stderrHead.length;
        stderrHead += rest.slice(0, room);
        rest = rest.slice(room);
      }
      const tail = stderrTail + rest;
      if (tail.length > STDERR_END_CHARS) stderrCut = true;
      stderrTail = tail.slice(-STDERR_END_CHARS);
    });
    child.on("error", (e) => {
      done({ ok: false, stdout: "", error: e.code === "ENOENT" ? "not installed" : e.message });
    });
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(chunks).subarray(0, MAX_STDOUT_BYTES).toString("utf8");
      if (code === 0) done({ ok: true, stdout });
      else done(withStderr({ ok: false, stdout, error: code === null ? `killed by ${signal}` : `exit ${code}` }));
    });
    child.stdin?.on("error", () => {
    });
    child.stdin?.end(input);
  });
}
var PDF_INSPECTOR_SPEC, ANYDOC_SPEC, MAX_STDOUT_BYTES, STDERR_END_CHARS;
var init_exec = __esm({
  "src/pdf/exec.ts"() {
    "use strict";
    init_process_tree();
    PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
    ANYDOC_SPEC = "@firecrawl/anydoc@0.1";
    MAX_STDOUT_BYTES = 24 * 1024 * 1024;
    STDERR_END_CHARS = 1024;
  }
});

// src/pdf/npx.ts
import { isAbsolute } from "path";
function npxTimeoutMs() {
  return envInt("NPX_TIMEOUT_MS", 9e4, 1e3, 6e5);
}
function npxEnv() {
  const env2 = { ...process.env };
  for (const [key, value] of Object.entries(FAIL_FAST)) {
    if (env2[key] === void 0 && env2[key.toUpperCase()] === void 0) env2[key] = value;
  }
  return env2;
}
function unavailability(r, spec) {
  if (r.error === "not installed" || r.error === "exit 127") return "not installed";
  const stderr = r.stderr ?? "";
  const code = NPM_ERROR_RE.exec(stderr)?.[1];
  if (code) {
    if (!NETWORK_CODES.has(code)) return `could not be installed (npm error ${code})`;
    registryDown = code;
    return `could not be installed (npm error ${code} \u2014 offline?)`;
  }
  if (/could not determine executable to run/.test(stderr)) return "could not be installed (npm found no executable)";
  if (!proven.has(spec) && r.error?.startsWith("timed out")) return `${r.error} on first use (raise ${envName("NPX_TIMEOUT_MS")} on a slow network)`;
  return void 0;
}
function npxBinName(spec) {
  return spec.replace(/^@[^/]+\//, "").replace(/@.*$/, "");
}
function findInstalled(spec) {
  let hit = installed.get(spec);
  if (!hit) {
    hit = (async () => {
      if (process.platform === "win32") return {};
      const probe = ["-y", "--prefer-offline", "--package", spec, "-c", `command -v ${npxBinName(spec)}`];
      const r = await runWithInput("npx", probe, Buffer.alloc(0), npxTimeoutMs(), { env: npxEnv() });
      if (!r.ok) {
        const why = unavailability(r, spec);
        return why ? { unavailable: { ...r, unavailable: why } } : {};
      }
      const path = r.stdout.trim().split("\n").pop()?.trim();
      return path && isAbsolute(path) ? { path } : {};
    })();
    installed.set(spec, hit);
  }
  return hit;
}
async function npxCacheState(spec) {
  if (process.platform === "win32") return "unknown";
  const probe = ["-y", "--offline", "--package", spec, "-c", `command -v ${npxBinName(spec)}`];
  const r = await runWithInput("npx", probe, Buffer.alloc(0), 3e4, { env: npxEnv() });
  if (r.ok) return "cached";
  if (r.error === "not installed") return "no npx";
  return NPM_ERROR_RE.exec(r.stderr ?? "")?.[1] === "ENOTCACHED" ? "not cached" : "unknown";
}
async function runNpx(spec, args, input) {
  if (registryDown && !proven.has(spec) && !installed.has(spec)) {
    const why2 = `could not be installed (npm error ${registryDown} \u2014 offline?)`;
    return { ok: false, stdout: "", error: why2, unavailable: why2 };
  }
  const found = await findInstalled(spec);
  if (found.unavailable) return found.unavailable;
  if (found.path) {
    const run = await runWithInput(found.path, args, input, npxTimeoutMs());
    if (run.ok) proven.add(spec);
    if (run.error !== "not installed") return run;
    installed.delete(spec);
  }
  const r = await runWithInput("npx", ["-y", "--prefer-offline", spec, ...args], input, npxTimeoutMs(), { env: npxEnv() });
  if (r.ok) {
    proven.add(spec);
    return r;
  }
  const why = unavailability(r, spec);
  return why ? { ...r, unavailable: why } : r;
}
function skipNpxHint() {
  return `set ${envName("NO_NPX")}=1 to skip the rungs that install through npx`;
}
function failureDetail(tool2, r) {
  const lines = [];
  let source2 = false;
  let props = false;
  for (const raw of (r.stderr ?? "").split(/\r?\n/)) {
    const l = raw.trim();
    if (source2) source2 = false;
    else if (props) props = l !== "}";
    else if (THROW_SITE_RE.test(l)) source2 = true;
    else if (l.startsWith("at ") && l.endsWith("{")) props = true;
    else if (l && !NOISE_RE.test(l)) lines.push(l);
  }
  const line = lines.find((l) => ERROR_LINE_RE.test(l)) ?? lines[0];
  const detail = (line ?? r.error ?? "failed").replace(PATH_RE, (p) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1)).slice(0, 200);
  return detail.startsWith(`${tool2}:`) ? detail : `${tool2}: ${detail}`;
}
var FAIL_FAST, NPM_ERROR_RE, NETWORK_CODES, proven, registryDown, installed, NOISE_RE, THROW_SITE_RE, ERROR_LINE_RE, PATH_RE;
var init_npx = __esm({
  "src/pdf/npx.ts"() {
    "use strict";
    init_brand();
    init_exec();
    FAIL_FAST = {
      npm_config_fetch_retries: "1",
      npm_config_fetch_retry_mintimeout: "1000",
      npm_config_fetch_retry_maxtimeout: "2000",
      npm_config_fetch_timeout: "30000"
    };
    NPM_ERROR_RE = /^npm (?:ERR!|error) code (\S+)/m;
    NETWORK_CODES = /* @__PURE__ */ new Set([
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTCACHED",
      "ERR_SOCKET_TIMEOUT"
    ]);
    proven = /* @__PURE__ */ new Set();
    installed = /* @__PURE__ */ new Map();
    NOISE_RE = /^(?:npm (?:warn|WARN|notice)\b|\(node:\d+\)|\(Use `node --|\^+$|at\s|Node\.js v\d)/;
    THROW_SITE_RE = /^(?:file:\/\/|\/|[A-Za-z]:\\)\S*:\d+$/;
    ERROR_LINE_RE = /^\w*error\b/i;
    PATH_RE = /(?<![\w:/.\\])(?:file:\/\/\/?(?:[A-Za-z]:)?|[A-Za-z]:(?=\\))?(?:[/\\][^\s/\\:'"()]+)+/g;
  }
});

// src/pdf/quality.ts
function isControlCode(c) {
  if (c >= 9 && c <= 13) return false;
  return c < 32 || c >= 127 && c <= 159;
}
function scanShape(t) {
  let control = 0;
  let replacement = 0;
  let letters = 0;
  let nonSpace = 0;
  let run = 0;
  let runIsRule = true;
  let longestRun2 = 0;
  const endRun = () => {
    if (!runIsRule && run > longestRun2) longestRun2 = run;
    run = 0;
    runIsRule = true;
  };
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (isSpace(c)) {
      endRun();
      continue;
    }
    if (c === REPLACEMENT_CODE) replacement++;
    else if (isControlCode(c)) control++;
    if (!isRuleChar(c)) runIsRule = false;
    if (c < 128) {
      if (c >= 48 && c <= 57 || (c | 32) >= 97 && (c | 32) <= 122) letters++;
      nonSpace++;
      run++;
      continue;
    }
    const cp = t.codePointAt(i);
    const units = cp > 65535 ? 2 : 1;
    if (LETTER_RE.test(String.fromCodePoint(cp))) letters++;
    nonSpace += units;
    run += units;
    i += units - 1;
  }
  endRun();
  return { control: control / t.length, replacement: replacement / t.length, longestRun: longestRun2, letterRatio: nonSpace ? letters / nonSpace : 0 };
}
function assessPdfText(text) {
  return assessExtractedText(text, NO_TEXT_LAYER);
}
function assessExtractedText(text, emptyReason) {
  const t = text.trim();
  if (!t) return { ok: false, reason: emptyReason };
  const shape = scanShape(t);
  if (shape.control > CONTROL_RATIO_MAX) {
    return { ok: false, reason: "binary/control characters in the text (undecodable PDF stream)" };
  }
  if (shape.replacement > REPLACEMENT_RATIO_MAX) {
    return { ok: false, reason: "replacement characters throughout (wrong character map)" };
  }
  if (t.length < MIN_CHARS_FOR_SHAPE_CHECKS) return { ok: true };
  if (shape.longestRun > LONGEST_RUN_MAX && shape.letterRatio < LETTER_RATIO_MIN) {
    return { ok: false, reason: "unreadable text layer (garbled glyph encoding)" };
  }
  return { ok: true };
}
var MIN_CHARS_FOR_SHAPE_CHECKS, CONTROL_RATIO_MAX, REPLACEMENT_RATIO_MAX, LONGEST_RUN_MAX, LETTER_RATIO_MIN, REPLACEMENT_CODE, SPACE_RE, isSpace, LETTER_RE, isRuleChar, NO_TEXT_LAYER;
var init_quality = __esm({
  "src/pdf/quality.ts"() {
    "use strict";
    MIN_CHARS_FOR_SHAPE_CHECKS = 200;
    CONTROL_RATIO_MAX = 5e-3;
    REPLACEMENT_RATIO_MAX = 5e-3;
    LONGEST_RUN_MAX = 300;
    LETTER_RATIO_MIN = 0.5;
    REPLACEMENT_CODE = 65533;
    SPACE_RE = /\s/;
    isSpace = (c) => c < 128 ? c === 32 || c >= 9 && c <= 13 : SPACE_RE.test(String.fromCharCode(c));
    LETTER_RE = /[\p{L}\p{N}]/u;
    isRuleChar = (c) => c === 95 || c === 45 || c === 46 || c === 61;
    NO_TEXT_LAYER = "no text layer (scanned or image-only PDF?)";
  }
});

// src/pdf/native.ts
import { inflateRawSync, inflateSync } from "zlib";
function decodePdfString(tok) {
  return tok.slice(1, -1).replace(/\\(?:([nrtbf()\\])|([0-7]{1,3})|(\r\n|\r|\n)|([\s\S]))/g, (_m, esc, oct, _eol, other) => {
    if (esc) return ESCAPES[esc];
    if (oct) return String.fromCharCode(parseInt(oct, 8) & 255);
    return other ?? "";
  });
}
function decodeHexString(tok) {
  const hex = tok.slice(1, -1).replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  if (hex.length % 2) out += String.fromCharCode(parseInt(hex[hex.length - 1] + "0", 16));
  return out;
}
function decodeString(tok) {
  const bytes = tok[0] === "<" ? decodeHexString(tok) : decodePdfString(tok);
  return bytes.replace(/[\x7f-\x9f]/g, winAnsi);
}
function decodeTJArray(items) {
  let out = "";
  for (const item of items) {
    if (typeof item === "string") out += decodeString(item);
    else if (item <= -100) out += " ";
  }
  return out;
}
function inlineImageEnd(s, from) {
  for (let k = s.indexOf("EI", from); k >= 0; k = s.indexOf("EI", k + 1)) {
    const after2 = k + 2 >= s.length || isWhite(s.charCodeAt(k + 2)) || isDelimiter(s.charCodeAt(k + 2));
    if (isWhite(s.charCodeAt(k - 1)) && after2) return k + 2;
  }
  return s.length;
}
function extractTextOps(s) {
  const lexer = new Lexer(s);
  let out = "";
  let operands = [];
  const take = () => {
    const last = operands[operands.length - 1];
    if (last === void 0) return "";
    return typeof last === "string" ? decodeString(last) : decodeTJArray(last);
  };
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 40 || c === 60 && s.charCodeAt(i + 1) !== 60) {
      const end2 = c === 40 ? lexer.stringEnd(i) : lexer.hexEnd(i);
      if (end2 > 0) {
        operands.push(s.slice(i, end2));
        i = end2;
      } else i++;
      continue;
    }
    if (c === 91) {
      const arr = lexer.array(i);
      if (arr) {
        operands.push(arr.items);
        i = arr.end;
      } else i++;
      continue;
    }
    if (c === 37) {
      while (i < s.length && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++;
      continue;
    }
    if (isWhite(c) || isDelimiter(c)) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < s.length && !isWhite(s.charCodeAt(end)) && !isDelimiter(s.charCodeAt(end))) end++;
    const word = s.slice(i, end);
    i = end;
    if (word === "Tj" || word === "TJ") out += take() + " ";
    else if (word === "'" || word === '"') out += "\n" + take() + " ";
    else if (word === "T*") out += "\n";
    else if (word === "ID") i = inlineImageEnd(s, i);
    else if (word !== "Td" && word !== "TD") continue;
    operands = [];
  }
  return out;
}
function ascii85Decode(text, cap) {
  const out = Buffer.allocUnsafe(Math.min(cap, 4 * text.length));
  let n = 0;
  let group = 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 126) break;
    if (isWhite(c)) continue;
    if (c === 122 && count === 0) {
      if (n + 4 > cap) return TOO_BIG;
      out.writeUInt32BE(0, n);
      n += 4;
      continue;
    }
    if (c < 33 || c > 117) return void 0;
    group = group * 85 + (c - 33);
    if (++count === 5) {
      if (n + 4 > cap) return TOO_BIG;
      out.writeUInt32BE(group >>> 0, n);
      n += 4;
      group = 0;
      count = 0;
    }
  }
  if (count === 1) return void 0;
  if (count > 1) {
    for (let k = count; k < 5; k++) group = group * 85 + 84;
    if (n + count - 1 > cap) return TOO_BIG;
    for (let k = 0; k < count - 1; k++) out[n++] = group >>> 24 - 8 * k & 255;
  }
  return out.subarray(0, n);
}
function asciiHexDecode(text) {
  const end = text.indexOf(">");
  const hex = (end < 0 ? text : text.slice(0, end)).replace(/[^0-9A-Fa-f]/g, "");
  return Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
}
function inflateCapped(data, cap) {
  for (const inflate of [inflateSync, inflateRawSync]) {
    try {
      return inflate(data, { maxOutputLength: cap });
    } catch (e) {
      if (e.code === "ERR_BUFFER_TOO_LARGE") return TOO_BIG;
    }
  }
  return void 0;
}
function filtersOf(dict) {
  const m = /\/Filter\s*(\[[^\]]*\]|\/[^\s/<>[\]()]+)/.exec(dict);
  return m ? (m[1].match(/\/[^\s/<>[\]()]+/g) ?? []).map((f) => f.slice(1)) : void 0;
}
function* contentStreams(buf) {
  const s = buf.toString("latin1");
  const re = /(?<!end)stream\r?\n/g;
  let budget = MAX_TOTAL_BYTES;
  let previousEnd = 0;
  let m;
  while (budget > 0 && (m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) return;
    re.lastIndex = end + "endstream".length;
    const window = s.slice(Math.max(previousEnd, m.index - DICT_WINDOW), m.index);
    previousEnd = re.lastIndex;
    const dict = window.slice(window.lastIndexOf("obj") + 1);
    if (NOT_TEXT_RE.test(dict)) continue;
    let stop = end;
    if (s[stop - 1] === "\n") stop--;
    if (s[stop - 1] === "\r") stop--;
    let data = buf.subarray(start, stop);
    const filters = filtersOf(dict);
    if (filters) {
      for (const f of filters) {
        if (!data) break;
        const cap = Math.min(MAX_STREAM_BYTES, budget);
        let decoded;
        if (f === "ASCII85Decode" || f === "A85") decoded = ascii85Decode(data.toString("latin1"), cap);
        else if (f === "ASCIIHexDecode" || f === "AHx") decoded = asciiHexDecode(data.toString("latin1"));
        else if (f === "FlateDecode" || f === "Fl") decoded = inflateCapped(data, cap);
        if (decoded === TOO_BIG) budget -= cap;
        data = decoded instanceof Buffer ? decoded : void 0;
      }
    } else {
      const cap = Math.min(MAX_STREAM_BYTES, budget);
      if (/~>\s*$/.test(s.slice(Math.max(start, stop - 8), stop))) {
        const decoded = ascii85Decode(data.toString("latin1"), cap);
        if (decoded === TOO_BIG) {
          budget -= cap;
          continue;
        }
        data = decoded ?? data;
      }
      const inflated = inflateCapped(data, cap);
      if (inflated === TOO_BIG) {
        budget -= cap;
        data = void 0;
      } else if (inflated) data = inflated;
    }
    if (!data) continue;
    budget -= data.length;
    yield data.toString("latin1");
  }
}
function pdfToText(buf) {
  let out = "";
  try {
    for (const stream of contentStreams(buf)) {
      if (/\b(Tj|TJ)\b/.test(stream) || /\)\s*'/.test(stream)) out += extractTextOps(stream) + "\n";
    }
  } catch {
  }
  return out.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
var MAX_STREAM_BYTES, MAX_TOTAL_BYTES, DICT_WINDOW, WIN_ANSI_C1, winAnsi, ESCAPES, isWhite, isDelimiter, isHexDigit, isNumberChar, Lexer, TOO_BIG, NOT_TEXT_RE;
var init_native = __esm({
  "src/pdf/native.ts"() {
    "use strict";
    MAX_STREAM_BYTES = 32 * 1024 * 1024;
    MAX_TOTAL_BYTES = 128 * 1024 * 1024;
    DICT_WINDOW = 4096;
    WIN_ANSI_C1 = [
      8364,
      8226,
      8218,
      402,
      8222,
      8230,
      8224,
      8225,
      710,
      8240,
      352,
      8249,
      338,
      8226,
      381,
      8226,
      8226,
      8216,
      8217,
      8220,
      8221,
      8226,
      8211,
      8212,
      732,
      8482,
      353,
      8250,
      339,
      8226,
      382,
      376
    ];
    winAnsi = (c) => {
      const code = c.charCodeAt(0);
      return code === 127 ? "\u2022" : String.fromCharCode(WIN_ANSI_C1[code - 128]);
    };
    ESCAPES = { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    isWhite = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
    isDelimiter = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
    isHexDigit = (c) => c >= 48 && c <= 57 || c >= 65 && c <= 70 || c >= 97 && c <= 102;
    isNumberChar = (c) => c >= 48 && c <= 57 || c === 45 || c === 43 || c === 46;
    Lexer = class {
      constructor(s) {
        this.s = s;
      }
      s;
      // Cleared by the first literal string whose parentheses never balance: from
      // then on strings are read flat, which is what every string was before
      // nesting was supported, and costs no more than the next parenthesis.
      nested = true;
      // Cleared by the first array that runs to the end of the stream. Every later
      // `[` is scanned through the same segmentation and reaches the same end, so
      // scanning them would re-pay the whole stream each time.
      arrays = true;
      /** End (exclusive) of the literal string opening at `i`, or -1. */
      stringEnd(i) {
        const s = this.s;
        if (this.nested) {
          let depth = 0;
          for (let j = i; j < s.length; j++) {
            const c = s.charCodeAt(j);
            if (c === 92) j++;
            else if (c === 40) depth++;
            else if (c === 41 && --depth === 0) return j + 1;
          }
          this.nested = false;
        }
        for (let j = i + 1; j < s.length; j++) {
          const c = s.charCodeAt(j);
          if (c === 92) j++;
          else if (c === 41) return j + 1;
          else if (c === 40) return -1;
        }
        return -1;
      }
      /** End (exclusive) of the hex string opening at `i`, or -1. */
      hexEnd(i) {
        const s = this.s;
        for (let j = i + 1; j < s.length; j++) {
          const c = s.charCodeAt(j);
          if (c === 62) return j + 1;
          if (!isHexDigit(c) && !isWhite(c)) return -1;
        }
        return -1;
      }
      /**
       * The array opening at `i`: its strings and numbers, and where it ends.
       *
       * A `]` inside one of its strings does not close it. That detail is
       * load-bearing: `[(] and gated recurrent [)-250(7)]` truncated at the inner
       * `]` silently dropped the rest of the array — on a real paper, whole clauses
       * from the middle of sentences, leaving fluent, citable prose.
       */
      array(i) {
        if (!this.arrays) return void 0;
        const s = this.s;
        const items = [];
        for (let j = i + 1; j < s.length; ) {
          const c = s.charCodeAt(j);
          if (c === 93) return { end: j + 1, items };
          const end = c === 40 ? this.stringEnd(j) : c === 60 ? this.hexEnd(j) : -1;
          if (end > 0) {
            items.push(s.slice(j, end));
            j = end;
          } else if (isNumberChar(c)) {
            let e = j + 1;
            while (e < s.length && isNumberChar(s.charCodeAt(e))) e++;
            items.push(Number(s.slice(j, e)));
            j = e;
          } else j++;
        }
        this.arrays = false;
        return void 0;
      }
    };
    TOO_BIG = /* @__PURE__ */ Symbol("too big");
    NOT_TEXT_RE = /\/Subtype\s*\/Image\b|\/Length[123]\b/;
  }
});

// src/pdf/ocr.ts
import { mkdtempSync, readFileSync as readFileSync7, rmSync, writeFileSync as writeFileSync3, existsSync } from "fs";
import { join as join7 } from "path";
import { tmpdir } from "os";
function ocrBudgetLeft() {
  return Math.max(0, envInt("OCR_MAX", DEFAULT_MAX_DOCS) - spent);
}
async function ocrTools() {
  if (!toolsProbe) {
    toolsProbe = (async () => {
      const probe = async (cmd, args) => (await runWithInput(cmd, args, Buffer.alloc(0), 2e4)).ok;
      const [copyablePdf, tesseract] = await Promise.all([probe("copyable-pdf", ["--help"]), probe("tesseract", ["--version"])]);
      return { copyablePdf, tesseract };
    })();
  }
  return toolsProbe;
}
async function ocrAttempt(bytes) {
  if (ocrBudgetLeft() <= 0) return { declined: "budget" };
  const { copyablePdf, tesseract } = await ocrTools();
  if (!copyablePdf || !tesseract) return { declined: "tools" };
  if (ocrBudgetLeft() <= 0) return { declined: "budget" };
  spent++;
  const dir = mkdtempSync(join7(tmpdir(), `${brand().name}-ocr-`));
  try {
    const input = join7(dir, "in.pdf");
    const output = join7(dir, "out.pdf");
    writeFileSync3(input, bytes);
    const lang = env("OCR_LANG") || DEFAULT_LANG;
    const r = await runWithInput("copyable-pdf", ["-o", output, "-m", "-l", lang, input], Buffer.alloc(0), envInt("OCR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
    if (r.error === "not installed") {
      spent = Math.max(0, spent - 1);
      return { declined: "tools" };
    }
    if (!r.ok) return { failed: true };
    const md = output.replace(/\.pdf$/, ".md");
    return existsSync(md) ? { text: readFileSync7(md, "utf8") } : { failed: true };
  } catch {
    return { failed: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
var DEFAULT_TIMEOUT_MS, DEFAULT_MAX_DOCS, DEFAULT_LANG, spent, toolsProbe;
var init_ocr = __esm({
  "src/pdf/ocr.ts"() {
    "use strict";
    init_brand();
    init_exec();
    DEFAULT_TIMEOUT_MS = 3e5;
    DEFAULT_MAX_DOCS = 3;
    DEFAULT_LANG = "eng";
    spent = 0;
  }
});

// src/pdf/ladder.ts
function enginesFromEnv(name2, known) {
  const raw = env(name2)?.trim();
  if (!raw) return void 0;
  const asked = raw.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (asked.length === 1 && asked[0] === "none") return [];
  const picked = [...new Set(asked.filter((s) => known.includes(s)))];
  const unknown = asked.filter((s) => !known.includes(s));
  if (unknown.length && !warnedEngineValues.has(`${name2}=${raw}`)) {
    warnedEngineValues.add(`${name2}=${raw}`);
    const fallback = picked.length ? "" : " \u2014 using the full ladder";
    process.emitWarning(`${envName(name2)}: ignoring unknown rung ${unknown.map((u) => `"${u}"`).join(", ")} (known: ${known.join(", ")}, or none)${fallback}`);
  }
  return picked.length ? picked : void 0;
}
function enabledExtractors(engines) {
  if (engines) return engines;
  const chosen = enginesFromEnv("PDF_ENGINE", PDF_EXTRACTORS);
  if (chosen) return chosen;
  if (envFlag("NO_NPX")) return PDF_EXTRACTORS.filter((e) => e !== "pdf-inspector" && e !== "anydoc");
  return PDF_EXTRACTORS;
}
async function viaNpx(id, spec, args, bytes) {
  const r = await runNpx(spec, args, bytes);
  if (r.ok) return { text: r.stdout };
  if (r.unavailable === "not installed") return { unavailable: true };
  if (r.unavailable) return { unavailable: true, failure: `${id} ${r.unavailable}`, hint: skipNpxHint() };
  return { failure: failureDetail(id, r) };
}
async function viaPdftotext(bytes) {
  const r = await runWithInput("pdftotext", ["-layout", "-", "-"], bytes, PDFTOTEXT_TIMEOUT_MS);
  if (r.ok) return { text: r.stdout.replace(/\f/g, "\n\n") };
  return r.error === "not installed" ? { unavailable: true } : { failure: failureDetail("pdftotext", r) };
}
async function viaOcr(bytes) {
  const r = await ocrAttempt(bytes);
  if ("text" in r) return { text: r.text };
  if ("declined" in r) return r.declined === "tools" ? { unavailable: true } : { budgetSpent: true };
  return { failure: "ocr: the conversion failed on this document" };
}
async function runRung(id, bytes, opts) {
  try {
    if (id === "pdf-inspector") return await viaNpx(id, PDF_INSPECTOR_SPEC, ["-"], bytes);
    if (id === "anydoc") return await viaNpx(id, ANYDOC_SPEC, ["-", "--format", "pdf"], bytes);
    if (id === "pdftotext") return await viaPdftotext(bytes);
    if (id === "ocr") return await viaOcr(bytes);
    if (id === "firecrawl") {
      const text = opts.firecrawl ? await opts.firecrawl() : void 0;
      return text === void 0 ? {} : { text };
    }
    return { text: pdfToText(bytes) };
  } catch {
    return {};
  }
}
async function extractPdf(bytes, opts = {}) {
  if (!bytes.subarray(0, 1024).includes("%PDF-")) {
    return { text: "", reason: "not a PDF (no %PDF- header \u2014 an error page or a login wall?)" };
  }
  let lastReason;
  const failures = [];
  const hints = /* @__PURE__ */ new Set();
  let ocrMissing = false;
  const noteFailure = (id, got) => {
    if (id === "ocr" && got.unavailable) ocrMissing = true;
    else if (got.failure) failures.push(got.failure);
    if (got.hint) hints.add(got.hint);
  };
  const budgetSpent = `scanned PDF, and this run's OCR budget is spent (raise ${envName("OCR_MAX")})`;
  for (const id of enabledExtractors(opts.engines)) {
    const known = dead.get(id);
    if (known) {
      noteFailure(id, known);
      continue;
    }
    if (id === "ocr" && ocrBudgetLeft() <= 0) {
      lastReason = budgetSpent;
      continue;
    }
    const got = await runRung(id, bytes, opts);
    if (got.text === void 0) {
      if (got.budgetSpent) {
        lastReason = budgetSpent;
        continue;
      }
      if (got.unavailable) dead.set(id, got);
      noteFailure(id, got);
      continue;
    }
    const verdict = assessPdfText(got.text);
    if (verdict.ok) return { text: got.text.trim(), via: id };
    lastReason = verdict.reason;
  }
  if (lastReason === NO_TEXT_LAYER) {
    if (bytes.includes("/Encrypt")) lastReason = "encrypted PDF (no rung here could decrypt its text)";
    else if (ocrMissing) lastReason = `${NO_TEXT_LAYER} \u2014 install copyable-pdf and tesseract to OCR it`;
  }
  const reason = [...new Set([lastReason, ...failures, ...hints].filter(Boolean))].join("; ");
  return { text: "", reason: reason || "no PDF extractor available" };
}
var PDF_EXTRACTORS, PDFTOTEXT_TIMEOUT_MS, dead, warnedEngineValues;
var init_ladder = __esm({
  "src/pdf/ladder.ts"() {
    "use strict";
    init_brand();
    init_exec();
    init_npx();
    init_quality();
    init_native();
    init_ocr();
    PDF_EXTRACTORS = ["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native", "ocr"];
    PDFTOTEXT_TIMEOUT_MS = 6e4;
    dead = /* @__PURE__ */ new Map();
    warnedEngineValues = /* @__PURE__ */ new Set();
  }
});

// src/doc/office.ts
import { inflateRawSync as inflateRawSync2 } from "zlib";
function openZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 101010256) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new Refused(buf.subarray(0, 4).toString("latin1") === "PK" ? "truncated or corrupt ZIP archive" : "not an OOXML or OpenDocument file");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 117853008) throw new Refused("ZIP64 archives are not supported");
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 65535 || dirSize === 4294967295 || dirOffset === 4294967295) throw new Refused("ZIP64 archives are not supported");
  if (count > MAX_ENTRIES) throw new Refused(`more than ${MAX_ENTRIES} ZIP entries`);
  if (dirOffset + dirSize > eocd) throw new Refused("truncated or corrupt ZIP archive");
  const entries = /* @__PURE__ */ new Map();
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 33639248) throw new Refused("truncated or corrupt ZIP archive");
    const nameLength = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (next > eocd) throw new Refused("truncated or corrupt ZIP archive");
    entries.set(buf.toString("utf8", p + 46, p + 46 + nameLength), {
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localHeader: buf.readUInt32LE(p + 42)
    });
    p = next;
  }
  return new Zip(buf, entries);
}
function decodeXml(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z]{2,4}));/g, (m, hex, dec, name2) => {
    if (name2) return ENTITIES[name2] ?? m;
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    return cp > 0 && cp <= 1114111 ? String.fromCodePoint(cp) : m;
  });
}
function walkXml(xml, v) {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const textEnd = lt < 0 ? xml.length : lt;
    if (textEnd > i && v.text) v.text(decodeXml(xml.slice(i, textEnd)));
    if (lt < 0) return;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) return;
      v.text?.(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) return;
    i = gt + 1;
    const first = xml.charCodeAt(lt + 1);
    if (first === 63 || first === 33) continue;
    if (first === 47) {
      v.close?.(xml.slice(lt + 2, gt).trim());
      continue;
    }
    const selfClosing = xml.charCodeAt(gt - 1) === 47;
    const body = xml.slice(lt + 1, selfClosing ? gt - 1 : gt);
    const space = body.search(/\s/);
    const name2 = space < 0 ? body : body.slice(0, space);
    v.open?.(name2, space < 0 ? "" : body.slice(space));
    if (selfClosing) v.close?.(name2);
  }
}
function attr(attrs, name2) {
  let re = attrPatterns.get(name2);
  if (!re) {
    const key = name2.startsWith("*:") ? `[\\w.-]+:${name2.slice(2)}` : name2.replace(/[.]/g, "\\.");
    re = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attrPatterns.set(name2, re);
  }
  const m = re.exec(attrs);
  return m ? decodeXml(m[1] ?? m[2] ?? "") : void 0;
}
function blankRow(row, width) {
  for (let c = 0; c < row.length && c < width; c++) if (row[c]?.trim()) return false;
  return true;
}
function keepRow(table, row) {
  const blank = blankRow(row, row.length);
  if (!blank || !table.blank) table.rows.push(row);
  table.blank = blank;
}
function markdownTable(rows, budget) {
  let last = rows.length;
  while (last > 0 && rows[last - 1].every((c) => !c.trim())) last--;
  let width = 0;
  for (let r = 0; r < last; r++) {
    const row = rows[r];
    for (let c = Math.min(row.length, MAX_COLUMNS) - 1; c >= width; c--) {
      if (row[c]?.trim()) {
        width = c + 1;
        break;
      }
    }
  }
  if (!last || !width) return "";
  const rules = 3 * width + 2;
  const rule = `|${" --- |".repeat(width)}`;
  if (!budget.takeRules(rules + rule.length + 1)) return "";
  const line = (row) => `| ${Array.from({ length: width }, (_, c) => cell(row[c] ?? "")).join(" | ")} |`;
  const out = [line(rows[0]), rule];
  let blank = false;
  for (let r = 1; r < last; r++) {
    const row = rows[r];
    const empty = blankRow(row, width);
    if (empty && blank) continue;
    blank = empty;
    if (!budget.takeRules(rules)) break;
    out.push(line(row));
  }
  return out.join("\n");
}
function joinBlocks(blocks) {
  const out = [];
  for (const [i, block] of blocks.entries()) {
    if (i) out.push(block.startsWith("- ") && blocks[i - 1].startsWith("- ") ? "\n" : "\n\n");
    out.push(block);
  }
  return out.join("");
}
function relationships(zip, part) {
  const slash = part.lastIndexOf("/");
  const dir = part.slice(0, slash + 1);
  const rels = /* @__PURE__ */ new Map();
  const xml = zip.text(`${dir}_rels/${part.slice(slash + 1)}.rels`);
  if (!xml) return rels;
  walkXml(xml, {
    open(name2, attrs) {
      if (local(name2) !== "Relationship" || attr(attrs, "TargetMode") === "External") return;
      const id = attr(attrs, "Id");
      const target = attr(attrs, "Target");
      if (id && target) rels.set(id, { target: resolvePart(dir, target), type: attr(attrs, "Type") ?? "" });
    }
  });
  return rels;
}
function relatedPart(rels, type) {
  for (const r of rels.values()) if (r.type.endsWith(`/${type}`)) return r.target;
  return void 0;
}
function resolvePart(dir, target) {
  const segments = [];
  for (const s of (target.startsWith("/") ? target.slice(1) : dir + target).split("/")) {
    if (s === "..") segments.pop();
    else if (s && s !== ".") segments.push(s);
  }
  return segments.join("/");
}
function stylePrefix(name2, outline) {
  const level = HEADING_STYLE_RE.exec(name2)?.[1] ?? (outline !== void 0 && outline >= 0 && outline < 6 ? String(outline + 1) : void 0);
  if (level) return `${"#".repeat(Number(level))} `;
  if (TITLE_STYLE_RE.test(name2)) return "# ";
  if (LIST_STYLE_RE.test(name2)) return "- ";
  return void 0;
}
function wordStyles(xml) {
  if (!xml) return void 0;
  const styles = /* @__PURE__ */ new Map();
  let current2;
  walkXml(xml, {
    open(name2, attrs) {
      const n = local(name2);
      if (n === "style") {
        const id = attr(attrs, "w:styleId");
        current2 = id && attr(attrs, "w:type") === "paragraph" ? { name: "" } : void 0;
        if (current2) styles.set(id, current2);
      } else if (!current2) return;
      else if (n === "name") current2.name = attr(attrs, "w:val") ?? "";
      else if (n === "basedOn") current2.basedOn = attr(attrs, "w:val");
      else if (n === "outlineLvl") current2.outline = Number(attr(attrs, "w:val"));
    },
    close(name2) {
      if (local(name2) === "style") current2 = void 0;
    }
  });
  const prefixes = /* @__PURE__ */ new Map();
  for (const [id, own] of styles) {
    let style = own;
    for (let depth = 0; style && depth < 16; depth++) {
      const prefix = stylePrefix(style.name, style.outline);
      if (prefix !== void 0) {
        prefixes.set(id, prefix);
        break;
      }
      style = style.basedOn ? styles.get(style.basedOn) : void 0;
    }
    if (!prefixes.has(id)) prefixes.set(id, "");
  }
  return prefixes;
}
function wordText(xml, budget, styles) {
  const blocks = [];
  const paragraphs = [];
  const tables = [];
  let inText = 0;
  let fallback = 0;
  let tabStops = 0;
  let moved = 0;
  const add2 = (p, s) => {
    if (p && !moved && budget.take(s.length)) p.text += s;
  };
  const emit = (block) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(block);
    else if (block.trim()) blocks.push(block);
  };
  walkXml(xml, {
    open(name2, attrs) {
      const n = local(name2);
      if (n === "Fallback") fallback++;
      else if (n === "tabs") tabStops++;
      if (fallback) return;
      const p = paragraphs[paragraphs.length - 1];
      const table = tables[tables.length - 1];
      if (n === "moveFrom") moved++;
      else if (n === "p") paragraphs.push({ text: "", prefix: "" });
      else if (n === "t") inText++;
      else if (n === "tab" && !tabStops) add2(p, "	");
      else if (n === "br" || n === "cr") add2(p, "\n");
      else if (n === "noBreakHyphen") add2(p, "-");
      else if (n === "pStyle" && p) {
        const id = attr(attrs, "w:val") ?? "";
        const prefix = styles?.has(id) ? styles.get(id) : stylePrefix(id);
        if (prefix) p.prefix = prefix;
      } else if (n === "numPr" && p && !p.prefix) p.prefix = "- ";
      else if (n === "tbl") tables.push({ rows: [] });
      else if (n === "tr" && table) table.row = [];
      else if (n === "tc" && table) table.cell = [];
    },
    close(name2) {
      const n = local(name2);
      if (n === "Fallback") {
        fallback = Math.max(0, fallback - 1);
        return;
      }
      if (n === "tabs") tabStops = Math.max(0, tabStops - 1);
      if (fallback) return;
      const table = tables[tables.length - 1];
      if (n === "moveFrom") moved = Math.max(0, moved - 1);
      else if (n === "t") inText = Math.max(0, inText - 1);
      else if (n === "p") {
        const p = paragraphs.pop();
        if (p?.text.trim()) emit(table?.cell ? p.text.trim() : p.prefix ? p.prefix + p.text.trim() : p.text.trimEnd());
      } else if (n === "tc" && table?.row && table.cell) {
        table.row.push(table.cell.join(" "));
        table.cell = void 0;
      } else if (n === "tr" && table?.row) {
        keepRow(table, table.row);
        table.row = void 0;
      } else if (n === "tbl") {
        const done = tables.pop();
        if (done) emit(tables.length ? done.rows.map((r) => r.join(" ")).join(" ") : markdownTable(done.rows, budget));
      }
    },
    text(s) {
      if (!fallback && inText) add2(paragraphs[paragraphs.length - 1], s);
    }
  });
  return joinBlocks(blocks);
}
function sharedStrings(xml) {
  const strings3 = [];
  if (!xml) return strings3;
  let current2;
  let inText = 0;
  let phonetic = 0;
  walkXml(xml, {
    open(name2) {
      const n = local(name2);
      if (n === "si") current2 = "";
      else if (n === "t") inText++;
      else if (n === "rPh") phonetic++;
    },
    close(name2) {
      const n = local(name2);
      if (n === "si" && current2 !== void 0) {
        strings3.push(current2);
        current2 = void 0;
      } else if (n === "t") inText = Math.max(0, inText - 1);
      else if (n === "rPh") phonetic = Math.max(0, phonetic - 1);
    },
    text(s) {
      if (current2 !== void 0 && inText && !phonetic) current2 += s;
    }
  });
  return strings3;
}
function columnOf(ref2) {
  const letters = ref2 && /^[A-Za-z]{1,3}/.exec(ref2)?.[0];
  if (!letters) return void 0;
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}
function temporalOf(code) {
  if (code.length > 255 || /\[[hms]+\]/i.test(code)) return void 0;
  const bare = code.replace(/"[^"]*"|[\\_*].|\[[^[\]]*\]|General|E[+-]/gi, "");
  const time = /[hs]/i.test(bare);
  const date = /[yd]/i.test(bare) || !time && /m/i.test(bare);
  return date && time ? "datetime" : date ? "date" : time ? "time" : void 0;
}
function cellTemporals(xml) {
  const kinds = [];
  if (!xml) return kinds;
  const custom = /* @__PURE__ */ new Map();
  let cellXfs = false;
  walkXml(xml, {
    open(name2, attrs) {
      const n = local(name2);
      if (n === "numFmt") custom.set(Number(attr(attrs, "numFmtId")), temporalOf(attr(attrs, "formatCode") ?? ""));
      else if (n === "cellXfs") cellXfs = true;
      else if (n === "xf" && cellXfs) {
        const id = Number(attr(attrs, "numFmtId") ?? 0);
        kinds.push(custom.has(id) ? custom.get(id) : BUILTIN_TEMPORAL[id]);
      }
    },
    close(name2) {
      if (local(name2) === "cellXfs") cellXfs = false;
    }
  });
  return kinds;
}
function serialDate(serial, kind, date1904) {
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
  if (!(serial >= 0 && days <= 2958466)) return void 0;
  const iso = new Date(Math.round((EXCEL_EPOCH + days * DAY_MS) / 1e3) * 1e3).toISOString();
  const time = iso.slice(11, iso.endsWith(":00.000Z") ? 16 : 19);
  return kind === "date" ? iso.slice(0, 10) : kind === "time" ? time : `${iso.slice(0, 10)} ${time}`;
}
function sheetRows(xml, shared, styles, budget) {
  const table = { rows: [] };
  let row;
  let col = 0;
  let type;
  let style = 0;
  let value;
  let collecting = 0;
  walkXml(xml, {
    open(name2, attrs) {
      const n = local(name2);
      if (n === "row") row = [];
      else if (n === "c" && row) {
        col = columnOf(attr(attrs, "r")) ?? row.length;
        type = attr(attrs, "t");
        style = Number(attr(attrs, "s") ?? 0);
        value = "";
      } else if ((n === "v" || n === "t") && value !== void 0) collecting++;
    },
    close(name2) {
      const n = local(name2);
      if ((n === "v" || n === "t") && collecting) collecting--;
      else if (n === "c" && row && value !== void 0) {
        let shown2 = value;
        const kind = styles.temporal[style];
        if (type === "s") shown2 = shared[Number(value)] ?? "";
        else if (type === "b") shown2 = value === "1" ? "TRUE" : "FALSE";
        else if (kind && (type === void 0 || type === "n") && value.trim()) shown2 = serialDate(Number(value), kind, styles.date1904) ?? value;
        if (col < MAX_COLUMNS && shown2 && budget.take(shown2.length)) {
          while (row.length < col) row.push("");
          row[col] = shown2;
        }
        value = void 0;
      } else if (n === "row" && row) {
        keepRow(table, row);
        row = void 0;
      }
    },
    text(s) {
      if (collecting && value !== void 0 && value.length < MAX_OUTPUT_CHARS) value += s;
    }
  });
  return table.rows;
}
function spreadsheetText(zip, workbookPart, budget) {
  const rels = relationships(zip, workbookPart);
  const stringsPart = relatedPart(rels, "sharedStrings");
  const shared = sharedStrings(stringsPart ? zip.text(stringsPart) : void 0);
  const stylesPart = relatedPart(rels, "styles");
  const styles = { temporal: cellTemporals(stylesPart ? zip.text(stylesPart) : void 0), date1904: false };
  const sheets = [];
  walkXml(zip.text(workbookPart) ?? "", {
    open(name2, attrs) {
      const n = local(name2);
      const id = attr(attrs, "*:id");
      if (n === "sheet" && id) sheets.push({ name: attr(attrs, "name") ?? `Sheet ${sheets.length + 1}`, id });
      else if (n === "workbookPr") styles.date1904 = /^(?:1|true)$/i.test(attr(attrs, "date1904") ?? "");
    }
  });
  const blocks = [];
  for (const sheet of sheets) {
    if (budget.spent) break;
    const part = rels.get(sheet.id)?.target;
    const xml = part ? zip.text(part) : void 0;
    const table = xml ? markdownTable(sheetRows(xml, shared, styles, budget), budget) : "";
    if (table) blocks.push(`## ${sheet.name}

${table}`);
  }
  return blocks.join("\n\n");
}
function drawingText(xml, budget, onlyBody = false) {
  const lines = [];
  const titles = [];
  const shapes = [];
  const tables = [];
  let para;
  let inText = 0;
  let fallback = 0;
  const add2 = (s) => {
    if (para !== void 0 && budget.take(s.length)) para += s;
  };
  const emit = (line) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(line);
    else if (shapes.length) shapes[shapes.length - 1].lines.push(line);
    else if (!onlyBody) lines.push(line);
  };
  walkXml(xml, {
    open(name2, attrs) {
      const n = local(name2);
      if (n === "Fallback") fallback++;
      if (fallback) return;
      const table = tables[tables.length - 1];
      if (n === "sp") shapes.push({ kind: "other", lines: [] });
      else if (n === "ph" && shapes.length) {
        const type = attr(attrs, "type");
        shapes[shapes.length - 1].kind = type === "title" || type === "ctrTitle" ? "title" : type === "body" ? "body" : "other";
      } else if (n === "p" && name2.startsWith("a:")) para = "";
      else if (n === "t") inText++;
      else if (n === "br") add2("\n");
      else if (name2 === "a:tbl") tables.push({ rows: [] });
      else if (name2 === "a:tr" && table) table.row = [];
      else if (name2 === "a:tc" && table?.row) table.cell = [];
    },
    close(name2) {
      const n = local(name2);
      if (n === "Fallback") {
        fallback = Math.max(0, fallback - 1);
        return;
      }
      if (fallback) return;
      const table = tables[tables.length - 1];
      if (n === "t") inText = Math.max(0, inText - 1);
      else if (n === "p" && name2.startsWith("a:") && para !== void 0) {
        const line = para.trim();
        para = void 0;
        if (line) emit(line);
      } else if (name2 === "a:tc" && table?.row && table.cell) {
        table.row.push(table.cell.join(" "));
        table.cell = void 0;
      } else if (name2 === "a:tr" && table?.row) {
        keepRow(table, table.row);
        table.row = void 0;
      } else if (name2 === "a:tbl") {
        const done = tables.pop();
        if (done) emit(tables.length ? done.rows.map((r) => r.join(" ")).join(" ") : `
${markdownTable(done.rows, budget)}
`);
      } else if (n === "sp") {
        const shape = shapes.pop();
        if (!shape) return;
        if (shape.kind === "title" && !onlyBody) titles.push(shape.lines.join(" "));
        else if (!onlyBody || shape.kind === "body") lines.push(...shape.lines);
      }
    },
    text(s) {
      if (!fallback && inText) add2(s);
    }
  });
  return { title: titles.join(" ").trim(), text: lines.join("\n").trim() };
}
function presentationText(zip, presentationPart, budget) {
  const rels = relationships(zip, presentationPart);
  const order = [];
  walkXml(zip.text(presentationPart) ?? "", {
    open(name2, attrs) {
      const target = local(name2) === "sldId" ? rels.get(attr(attrs, "*:id") ?? "")?.target : void 0;
      if (target) order.push(target);
    }
  });
  const blocks = [];
  for (const [i, part] of order.entries()) {
    if (budget.spent) break;
    const slide = drawingText(zip.text(part) ?? "", budget);
    const notesPart = relatedPart(relationships(zip, part), "notesSlide");
    const notes = notesPart ? drawingText(zip.text(notesPart) ?? "", budget, true).text : "";
    const heading = `## Slide ${i + 1}${slide.title ? `: ${slide.title}` : ""}`;
    if (slide.title || slide.text || notes) blocks.push(`${heading}${slide.text ? `

${slide.text}` : ""}${notes ? `

Notes: ${notes}` : ""}`);
  }
  return blocks.join("\n\n");
}
function openDocumentText(xml, budget) {
  const blocks = [];
  const paragraphs = [];
  const tables = [];
  let skip = 0;
  let listItem = false;
  let spreadsheet = false;
  let slide = 0;
  let heading = -1;
  let titleFrame = 0;
  let inNotes = 0;
  const title = [];
  const notes = [];
  const add2 = (p, s) => {
    if (p && budget.take(s.length)) p.text += s;
  };
  const emit = (block) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(block);
    else if (titleFrame) title.push(block);
    else if (inNotes) notes.push(block);
    else if (block.trim()) blocks.push(block);
  };
  const repeat = (attrs, name2) => Math.min(MAX_REPEAT, Math.max(1, Number(attr(attrs, name2)) || 1));
  walkXml(xml, {
    open(name2, attrs) {
      if (ODF_ASIDES.has(name2)) skip++;
      if (skip) return;
      const p = paragraphs[paragraphs.length - 1];
      const table = tables[tables.length - 1];
      if (name2 === "text:p" || name2 === "text:h") {
        const level = name2 === "text:h" ? Math.min(6, Number(attr(attrs, "text:outline-level")) || 1) : 0;
        paragraphs.push({ text: "", prefix: level ? `${"#".repeat(level)} ` : listItem && !table ? "- " : "" });
        listItem = false;
      } else if (name2 === "text:list-item") listItem = true;
      else if (name2 === "text:s") add2(p, " ".repeat(Math.min(100, Number(attr(attrs, "text:c")) || 1)));
      else if (name2 === "text:tab") add2(p, "	");
      else if (name2 === "text:line-break") add2(p, "\n");
      else if (name2 === "office:spreadsheet") spreadsheet = true;
      else if (name2 === "draw:page") {
        heading = blocks.push(`## Slide ${++slide}`) - 1;
        title.length = 0;
        notes.length = 0;
      } else if (name2 === "presentation:notes") inNotes++;
      else if (name2 === "draw:frame" && (titleFrame || attr(attrs, "presentation:class") === "title")) titleFrame++;
      else if (name2 === "table:table") {
        const sheet = attr(attrs, "table:name");
        const heading2 = sheet && spreadsheet && !tables.length ? blocks.push(`## ${sheet}`) - 1 : void 0;
        tables.push({ rows: [], repeatRow: 1, repeatCell: 1, ...heading2 !== void 0 ? { heading: heading2 } : {} });
      } else if (name2 === "table:table-row" && table) {
        table.row = [];
        table.repeatRow = repeat(attrs, "table:number-rows-repeated");
      } else if ((name2 === "table:table-cell" || name2 === "table:covered-table-cell") && table?.row) {
        table.cell = [];
        table.repeatCell = repeat(attrs, "table:number-columns-repeated");
      }
    },
    close(name2) {
      if (ODF_ASIDES.has(name2)) {
        skip = Math.max(0, skip - 1);
        return;
      }
      if (skip) return;
      const table = tables[tables.length - 1];
      if (name2 === "text:p" || name2 === "text:h") {
        const p = paragraphs.pop();
        if (p?.text.trim()) emit(table?.cell ? p.text.trim() : p.prefix + p.text.trim());
      } else if ((name2 === "table:table-cell" || name2 === "table:covered-table-cell") && table?.row && table.cell) {
        const text = table.cell.join(" ");
        for (let k = 0; k < table.repeatCell && table.row.length < MAX_COLUMNS; k++) {
          if (k && text && !budget.take(text.length)) break;
          table.row.push(text);
        }
        table.cell = void 0;
      } else if (name2 === "table:table-row" && table?.row) {
        const size = table.row.reduce((n, c) => n + c.length, 0);
        const times = size ? table.repeatRow : 1;
        for (let k = 0; k < times; k++) {
          if (k && !budget.take(size)) break;
          keepRow(table, table.row);
        }
        table.row = void 0;
      } else if (name2 === "table:table") {
        const done = tables.pop();
        if (done) emit(tables.length ? done.rows.map((r) => r.join(" ")).join(" ") : markdownTable(done.rows, budget));
        if (done?.heading !== void 0 && blocks.length === done.heading + 1) blocks.length = done.heading;
      } else if (name2 === "draw:frame" && titleFrame) titleFrame--;
      else if (name2 === "presentation:notes") inNotes = Math.max(0, inNotes - 1);
      else if (name2 === "draw:page" && heading >= 0) {
        if (title.length) blocks[heading] = `## Slide ${slide}: ${title.join(" ")}`;
        if (notes.length) blocks.push(`Notes: ${notes.join(" ")}`);
        if (!title.length && !notes.length && blocks.length === heading + 1) blocks.length = heading;
        heading = -1;
      }
    },
    text(s) {
      if (!skip) add2(paragraphs[paragraphs.length - 1], s.replace(/[ \t\r\n]+/g, " "));
    }
  });
  return joinBlocks(blocks);
}
function mainPart(zip) {
  const officeDocument = relatedPart(relationships(zip, ""), "officeDocument");
  if (officeDocument && zip.has(officeDocument)) return officeDocument;
  return ["word/document.xml", "xl/workbook.xml", "ppt/presentation.xml"].find((p) => zip.has(p));
}
function packageText(bytes, budget) {
  if (bytes.subarray(0, 8).equals(OLE_SIGNATURE2))
    throw new Refused("a legacy binary or password-protected Office file (only OOXML and OpenDocument are read here)");
  const zip = openZip(bytes);
  const mimetype = zip.has("mimetype") ? zip.text("mimetype")?.trim() : void 0;
  if (mimetype?.startsWith("application/vnd.oasis.opendocument.")) {
    const content = zip.text("content.xml");
    if (content === void 0) throw new Refused("an OpenDocument package with no content.xml");
    return openDocumentText(content, budget);
  }
  const main2 = mainPart(zip);
  const xml = main2 ? zip.text(main2) : void 0;
  if (!main2 || xml === void 0) throw new Refused("not an OOXML or OpenDocument file");
  if (main2.startsWith("word/")) {
    const stylesPart = relatedPart(relationships(zip, main2), "styles");
    return wordText(xml, budget, wordStyles(stylesPart ? zip.text(stylesPart) : void 0));
  }
  if (main2.startsWith("xl/")) return spreadsheetText(zip, main2, budget);
  if (main2.startsWith("ppt/")) return presentationText(zip, main2, budget);
  throw new Refused("not an OOXML or OpenDocument file");
}
function readOffice(bytes) {
  try {
    const text = packageText(bytes, new Budget()).replace(/\n{3,}/g, "\n\n").trim();
    return { text: text.length > MAX_OUTPUT_CHARS ? text.slice(0, text.lastIndexOf("\n", MAX_OUTPUT_CHARS)) : text };
  } catch (e) {
    return { failure: e instanceof Refused ? e.message : "the built-in reader could not parse it" };
  }
}
var MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES2, MAX_OUTPUT_CHARS, MAX_COLUMNS, MAX_REPEAT, Refused, Zip, Budget, ENTITIES, local, attrPatterns, cell, HEADING_STYLE_RE, TITLE_STYLE_RE, LIST_STYLE_RE, BUILTIN_TEMPORAL, DAY_MS, EXCEL_EPOCH, ODF_ASIDES, OLE_SIGNATURE2;
var init_office = __esm({
  "src/doc/office.ts"() {
    "use strict";
    MAX_ENTRIES = 1e4;
    MAX_ENTRY_BYTES = 64 * 1024 * 1024;
    MAX_TOTAL_BYTES2 = 256 * 1024 * 1024;
    MAX_OUTPUT_CHARS = 24 * 1024 * 1024;
    MAX_COLUMNS = 256;
    MAX_REPEAT = 1e3;
    Refused = class extends Error {
    };
    Zip = class {
      constructor(buf, entries) {
        this.buf = buf;
        this.entries = entries;
      }
      buf;
      entries;
      inflated = 0;
      has(name2) {
        return this.entries.has(name2);
      }
      /** An entry's bytes, or undefined when there is no such entry. Throws Refused on anything it will not read. */
      read(name2) {
        const e = this.entries.get(name2);
        if (!e) return void 0;
        if (e.flags & 1) throw new Refused("encrypted ZIP entries");
        if (e.compressedSize === 4294967295 || e.size === 4294967295 || e.localHeader === 4294967295) throw new Refused("ZIP64 archives are not supported");
        const buf = this.buf;
        const lh = e.localHeader;
        if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 67324752) throw new Refused("truncated or corrupt ZIP archive");
        const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
        const end = start + e.compressedSize;
        if (end > buf.length) throw new Refused("truncated or corrupt ZIP archive");
        const cap = Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES2 - this.inflated);
        const tooLarge = () => new Refused(
          cap < MAX_ENTRY_BYTES ? `the archive inflates past ${MAX_TOTAL_BYTES2 >> 20} MB` : `an entry inflates past ${MAX_ENTRY_BYTES >> 20} MB (a decompression bomb?)`
        );
        if (cap <= 0) throw tooLarge();
        let out;
        if (e.method === 0) {
          if (e.compressedSize > cap) throw tooLarge();
          out = buf.subarray(start, end);
        } else if (e.method === 8) {
          try {
            out = inflateRawSync2(buf.subarray(start, end), { maxOutputLength: cap });
          } catch (err) {
            throw err.code === "ERR_BUFFER_TOO_LARGE" ? tooLarge() : new Refused("truncated or corrupt ZIP archive");
          }
        } else {
          throw new Refused(`unsupported ZIP compression method ${e.method}`);
        }
        this.inflated += out.length;
        return out;
      }
      /** An XML part as text: UTF-8, or UTF-16LE when it says so with a BOM. */
      text(name2) {
        const b = this.read(name2);
        if (!b) return void 0;
        if (b[0] === 255 && b[1] === 254) return b.subarray(2).toString("utf16le");
        const s = b.toString("utf8");
        return s.charCodeAt(0) === 65279 ? s.slice(1) : s;
      }
    };
    Budget = class {
      left = MAX_OUTPUT_CHARS;
      rulesLeft = MAX_OUTPUT_CHARS;
      /** Spend `n` characters: false, and nothing spent, once they no longer fit — the caller drops them. */
      take(n) {
        if (n > this.left) {
          this.left = 0;
          return false;
        }
        this.left -= n;
        return true;
      }
      /** The same, for `n` characters of table rules. */
      takeRules(n) {
        if (n > this.rulesLeft) {
          this.rulesLeft = 0;
          return false;
        }
        this.rulesLeft -= n;
        return true;
      }
      get spent() {
        return this.left <= 0 || this.rulesLeft <= 0;
      }
    };
    ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    local = (name2) => name2.slice(name2.indexOf(":") + 1);
    attrPatterns = /* @__PURE__ */ new Map();
    cell = (s) => s.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
    HEADING_STYLE_RE = /^(?:heading|titre|berschrift|überschrift|kop|titolo|encabezado|ttulo|título)\s?([1-6])$/i;
    TITLE_STYLE_RE = /^(?:title|titel|titre|titolo|ttulo|título)$/i;
    LIST_STYLE_RE = /^list ?(?:bullet|number)/i;
    BUILTIN_TEMPORAL = {
      14: "date",
      15: "date",
      16: "date",
      17: "date",
      18: "time",
      19: "time",
      20: "time",
      21: "time",
      22: "datetime",
      45: "time",
      47: "time"
    };
    DAY_MS = 864e5;
    EXCEL_EPOCH = Date.UTC(1899, 11, 30);
    ODF_ASIDES = /* @__PURE__ */ new Set(["text:note", "office:annotation", "text:tracked-changes"]);
    OLE_SIGNATURE2 = Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]);
  }
});

// src/doc/ladder.ts
function enabledDocExtractors(engines) {
  if (engines) return engines;
  const chosen = enginesFromEnv("DOC_ENGINE", DOC_EXTRACTORS);
  if (chosen) return chosen;
  if (envFlag("NO_NPX")) return DOC_EXTRACTORS.filter((e) => e !== "anydoc");
  return DOC_EXTRACTORS;
}
async function viaAnydoc(bytes, format) {
  const args = ["-"];
  if (format) args.push("--format", format);
  const r = await runNpx(ANYDOC_SPEC, args, bytes);
  if (r.ok) return { text: r.stdout };
  if (r.unavailable === "not installed") return { unavailable: true };
  if (r.unavailable) return { unavailable: true, failure: `anydoc ${r.unavailable}; ${skipNpxHint()}` };
  return { failure: failureDetail("anydoc", r) };
}
function viaBuiltin(bytes, fmt) {
  if (fmt.format === "csv") return {};
  const r = readOffice(bytes);
  return r.text === void 0 ? { failure: `builtin: ${r.failure}` } : { text: r.text };
}
async function extractDocument(bytes, fmt, opts = {}) {
  let lastReason;
  const failures = [];
  for (const id of enabledDocExtractors(opts.engines)) {
    const known = dead2.get(id);
    if (known) {
      if (known.failure) failures.push(known.failure);
      continue;
    }
    let got;
    try {
      if (id === "anydoc") got = await viaAnydoc(bytes, fmt.format);
      else if (id === "builtin") got = viaBuiltin(bytes, fmt);
      else got = { text: opts.firecrawl ? await opts.firecrawl() : void 0 };
    } catch {
      got = {};
    }
    if (got.text === void 0) {
      if (got.unavailable) dead2.set(id, { failure: got.failure });
      if (got.failure) failures.push(got.failure);
      continue;
    }
    const verdict = assessExtractedText(got.text, "the converter produced no text");
    if (verdict.ok) return { text: got.text.trim(), via: id };
    lastReason = verdict.reason;
  }
  const reason = [lastReason, ...failures].filter(Boolean).join("; ");
  return { text: "", reason: reason || "no document converter available" };
}
var DOC_EXTRACTORS, dead2;
var init_ladder2 = __esm({
  "src/doc/ladder.ts"() {
    "use strict";
    init_brand();
    init_exec();
    init_ladder();
    init_npx();
    init_quality();
    init_office();
    DOC_EXTRACTORS = ["anydoc", "firecrawl", "builtin"];
    dead2 = /* @__PURE__ */ new Map();
  }
});

// src/doc.ts
var init_doc = __esm({
  "src/doc.ts"() {
    "use strict";
    init_formats();
    init_ladder2();
    init_office();
  }
});

// src/pdf.ts
var init_pdf = __esm({
  "src/pdf.ts"() {
    "use strict";
    init_native();
    init_quality();
    init_ocr();
    init_ladder();
  }
});

// src/url.ts
function canonicalizeUrl(raw) {
  try {
    const u = new URL(raw.trim());
    const proto = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let port = u.port;
    if (proto === "http:" && port === "80" || proto === "https:" && port === "443") port = "";
    const path = u.pathname.replace(/\/+$/, "");
    const keep = [];
    const shareSi = SHARE_SI_HOSTS.test(host);
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.test(k) && !(shareSi && k === "si")) keep.push([k, v]);
    }
    keep.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const search2 = keep.length ? "?" + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
    return `${proto}//${host}${port ? ":" + port : ""}${path}${search2}`.replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/#.*$/, "").replace(/\/$/, "");
  }
}
function domainOf(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === "file:") return LOCAL_FILE_DOMAIN;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
function fnvMix(s) {
  let hi = laneHi;
  let lo = laneLo;
  for (let i = 0; i < s.length; i++) {
    lo = (lo ^ s.charCodeAt(i)) >>> 0;
    const bP = (lo & 65535) * FNV_PRIME_LOW;
    const aP = (lo >>> 16) * FNV_PRIME_LOW + (bP >>> 16);
    const carry = aP >>> 16;
    hi = carry + Math.imul(hi, FNV_PRIME_LOW) + (lo << 8) >>> 0;
    lo = ((aP & 65535) << 16 | bP & 65535) >>> 0;
  }
  laneHi = hi;
  laneLo = lo;
}
function fnv1a64(s) {
  laneHi = FNV_OFFSET_HI;
  laneLo = FNV_OFFSET_LO;
  fnvMix(s);
  return BigInt(laneHi) << 32n | BigInt(laneLo);
}
function fnv1a64Words(pieces, out) {
  laneHi = FNV_OFFSET_HI;
  laneLo = FNV_OFFSET_LO;
  for (const p of pieces) fnvMix(p);
  out[0] = laneHi;
  out[1] = laneLo;
}
var TRACKING_PARAMS, SHARE_SI_HOSTS, LOCAL_FILE_DOMAIN, FNV_OFFSET_HI, FNV_OFFSET_LO, FNV_PRIME_LOW, laneHi, laneLo;
var init_url = __esm({
  "src/url.ts"() {
    "use strict";
    TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|gclsrc$|dclid$|msclkid$|yclid$|twclid$|ttclid$|li_fat_id$|mkt_tok$|_gl$|mc_|ref_src$|ref_url$|spm$|_hsenc$|_hsmi$|igshid$|igsh$)/i;
    SHARE_SI_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/;
    LOCAL_FILE_DOMAIN = "local file";
    FNV_OFFSET_HI = 3421674724;
    FNV_OFFSET_LO = 2216829733;
    FNV_PRIME_LOW = 435;
    laneHi = 0;
    laneLo = 0;
  }
});

// src/video/url.ts
function parse(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u : void 0;
  } catch {
    return void 0;
  }
}
function isYoutubeHost(host) {
  const h = host.toLowerCase();
  return YOUTUBE_HOSTS.some((d) => onHost(h, d));
}
function youtubeVideoId(url) {
  const u = parse(url);
  if (!u) return void 0;
  const host = u.hostname.toLowerCase();
  let id;
  if (host === "youtu.be" || host === "www.youtu.be") id = u.pathname.split("/")[1];
  else if (isYoutubeHost(host)) {
    if (u.pathname === "/watch") id = u.searchParams.get("v") ?? void 0;
    else id = /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(u.pathname)?.[1];
  }
  return id && VIDEO_ID.test(id) ? id : void 0;
}
function youtubeListKind(url) {
  const u = parse(url);
  if (!u || !isYoutubeHost(u.hostname)) return void 0;
  if (u.searchParams.get("list")) return "playlist";
  if (/^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(u.pathname)) return "channel";
  return void 0;
}
function knownVideo(url) {
  const id = youtubeVideoId(url);
  if (id) return { site: "youtube", url: `https://www.youtube.com/watch?v=${id}`, key: id };
  const u = parse(url);
  if (!u) return void 0;
  const host = u.hostname.toLowerCase();
  for (const rule of HOSTS) {
    if (!rule.domains.some((d) => onHost(host, d))) continue;
    const m = rule.video.exec(u.pathname);
    if (!m) continue;
    if (!rule.canonical) return { site: rule.site, url: u.toString() };
    const c = rule.canonical(m, u);
    return { site: rule.site, url: c.url, key: safeKey(rule.site, c.id) };
  }
  return void 0;
}
function videoSource(url, opts = {}) {
  const known = knownVideo(url);
  if (known) return known;
  if (!opts.anySite) return void 0;
  const u = parse(url);
  return u ? { site: "web", url: u.toString() } : void 0;
}
function videoRunKey(site, id, pageUrl) {
  if (site === "youtube" && VIDEO_ID.test(id)) return id;
  const key = safeKey(site, id);
  const altered = key !== `${site}-${id}`;
  return site === "web" || altered ? `${key.slice(0, 110)}-${shortHash(pageUrl ?? id)}` : key;
}
function videoUrlAt(webpageUrl, seconds3) {
  const t = Math.max(0, Math.floor(seconds3));
  const u = parse(webpageUrl);
  if (!u) return webpageUrl;
  const host = u.hostname.toLowerCase();
  if (isYoutubeHost(host) || host === "youtu.be") u.searchParams.set("t", `${t}s`);
  else if (onHost(host, "vimeo.com")) u.hash = `t=${t}s`;
  else if (onHost(host, "dailymotion.com")) u.searchParams.set("start", String(t));
  else if (onHost(host, "twitch.tv")) u.searchParams.set("t", `${Math.floor(t / 3600)}h${Math.floor(t % 3600 / 60)}m${t % 60}s`);
  else return webpageUrl;
  return u.toString();
}
var VIDEO_ID, YOUTUBE_HOSTS, onHost, HOSTS, safeKey, shortHash;
var init_url2 = __esm({
  "src/video/url.ts"() {
    "use strict";
    init_url();
    VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
    YOUTUBE_HOSTS = ["youtube.com", "youtube-nocookie.com"];
    onHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);
    HOSTS = [
      {
        site: "vimeo",
        domains: ["vimeo.com"],
        // vimeo.com/<id>, vimeo.com/<id>/<hash> (unlisted), vimeo.com/channels/<c>/<id>,
        // vimeo.com/groups/<g>/videos/<id>, player.vimeo.com/video/<id>.
        video: /^\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d{5,})(?:\/([0-9a-f]{6,}))?\/?$/,
        // The player URL, because vimeo.com's own page now answers yt-dlp with a
        // login wall while the player serves a public video — and its subtitles.
        canonical: (m, u) => {
          const hash = m[2] ?? u.searchParams.get("h") ?? void 0;
          return { id: m[1], url: `https://player.vimeo.com/video/${m[1]}${hash ? `?h=${hash}` : ""}` };
        }
      },
      {
        site: "dailymotion",
        domains: ["dailymotion.com"],
        video: /^\/(?:embed\/)?video\/([a-z0-9]{5,})(?:_[^/]*)?\/?$/i,
        canonical: (m) => ({ id: m[1], url: `https://www.dailymotion.com/video/${m[1]}` })
      },
      {
        site: "dailymotion",
        domains: ["dai.ly"],
        video: /^\/([a-z0-9]{5,})\/?$/i,
        canonical: (m) => ({ id: m[1], url: `https://www.dailymotion.com/video/${m[1]}` })
      },
      // Where the URL names the video, its key does too: a video read once is
      // reused with no yt-dlp call at all, as on YouTube.
      {
        site: "twitch",
        domains: ["twitch.tv"],
        video: /^\/videos\/(\d+)\/?$/,
        canonical: (m) => ({ id: m[1], url: `https://www.twitch.tv/videos/${m[1]}` })
      },
      { site: "twitch", domains: ["twitch.tv"], video: /^\/[^/]+\/clip\/[^/]+\/?$/ },
      {
        site: "ted",
        domains: ["ted.com"],
        video: /^\/talks\/([\w-]+)\/?$/,
        canonical: (m) => ({ id: m[1], url: `https://www.ted.com/talks/${m[1]}` })
      },
      {
        site: "loom",
        domains: ["loom.com"],
        video: /^\/(?:share|embed)\/([0-9a-f]{16,})\/?$/,
        canonical: (m) => ({ id: m[1], url: `https://www.loom.com/share/${m[1]}` })
      },
      {
        site: "tiktok",
        domains: ["tiktok.com"],
        video: /^\/(@[^/]+)\/video\/(\d+)\/?$/,
        canonical: (m) => ({ id: m[2], url: `https://www.tiktok.com/${m[1]}/video/${m[2]}` })
      },
      { site: "instagram", domains: ["instagram.com"], video: /^\/(?:reel|reels|tv)\/[\w-]+\/?$/ },
      { site: "facebook", domains: ["facebook.com"], video: /^\/(?:[^/]+\/videos\/[^/]+|reel\/\d+)\/?$/ },
      { site: "facebook", domains: ["fb.watch"], video: /^\/[\w-]{6,}\/?$/ },
      {
        site: "x",
        domains: ["x.com", "twitter.com"],
        video: /^\/([^/]+)\/status\/(\d+)(?:\/video\/\d)?\/?$/,
        canonical: (m) => ({ id: m[2], url: `https://x.com/${m[1]}/status/${m[2]}` })
      },
      { site: "bilibili", domains: ["bilibili.com"], video: /^\/video\/(?:BV\w+|av\d+)\/?$/i },
      { site: "rumble", domains: ["rumble.com"], video: /^\/v[\w-]+\.html$/ },
      { site: "peertube", domains: ["framatube.org", "tilvids.com"], video: /^\/(?:w|videos\/watch)\/[\w-]+\/?$/ }
    ];
    safeKey = (site, id) => `${site}-${id}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    shortHash = (text) => fnv1a64(text).toString(16).padStart(16, "0").slice(0, 8);
  }
});

// src/exec.ts
import { spawn as spawn3, spawnSync as spawnSync2 } from "child_process";
function toResult(status, stdout, stderr, err) {
  const missing = err?.code === "ENOENT";
  return {
    ok: !missing && status === 0,
    status: status ?? (missing ? 127 : 1),
    stdout,
    stderr: stderr || (err ? err.message : ""),
    ...missing ? { missing: true } : {}
  };
}
function have(cmd) {
  let hit = havePresence.get(cmd);
  if (hit === void 0) {
    const probe = spawnSync2(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
    hit = probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
    havePresence.set(cmd, hit);
  }
  return hit;
}
function sh(cmd, args, opts = {}) {
  let r;
  try {
    r = spawnSync2(cmd, args, {
      cwd: opts.cwd,
      input: opts.input,
      timeout: opts.timeoutMs ?? defaultTimeoutMs(),
      encoding: "utf8",
      maxBuffer: STDOUT_CAP,
      env: opts.env ?? process.env
    });
  } catch (e) {
    return { ok: false, status: 1, stdout: "", stderr: e.message };
  }
  return toResult(r.status, String(r.stdout ?? ""), String(r.stderr ?? ""), r.error);
}
function shAsync(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, status: 130, stdout: "", stderr: "aborted" });
  return new Promise((resolve12) => {
    let settled = false;
    let timer;
    let onAbort;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
      resolve12(r);
    };
    let child;
    try {
      child = spawn3(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ ok: false, status: 1, stdout: "", stderr: e.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => {
      if (stdout.length < STDOUT_CAP) stdout += d;
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < STDOUT_CAP) stderr += d;
    });
    timer = setTimeout(() => {
      killTree(child);
      done({ ok: false, status: 124, stdout, stderr: stderr || `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    if (opts.signal) {
      onAbort = () => {
        killTree(child);
        done({ ok: false, status: 130, stdout, stderr: "aborted" });
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (e) => done(toResult(null, stdout, stderr, e)));
    child.on("close", (code) => done(toResult(code, stdout, stderr)));
  });
}
var STDOUT_CAP, defaultTimeoutMs, havePresence;
var init_exec2 = __esm({
  "src/exec.ts"() {
    "use strict";
    init_brand();
    init_process_tree();
    STDOUT_CAP = 24 * 1024 * 1024;
    defaultTimeoutMs = () => envInt("SH_TIMEOUT_MS", 6e4, 1e3);
    havePresence = /* @__PURE__ */ new Map();
  }
});

// src/video/ytdlp.ts
import { mkdtempSync as mkdtempSync2, readdirSync as readdirSync2, readFileSync as readFileSync8, rmSync as rmSync2, writeFileSync as writeFileSync4 } from "fs";
import { tmpdir as tmpdir2 } from "os";
import { join as join8 } from "path";
function ytdlpExtraArgs() {
  return (env("YTDLP_ARGS") ?? "").split(/\s+/).filter(Boolean);
}
function runYtdlp(args, opts = {}) {
  const strict = opts.knownOnly ? ["--use-extractors", "default,-generic"] : [];
  const argv = [...strict, ...args, ...ytdlpExtraArgs(), ...opts.url ? ["--", opts.url] : []];
  return (opts.run ?? defaultVideoRunner)("yt-dlp", argv, { timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS, signal: opts.signal });
}
function siteOf(extractor) {
  const e = extractor.toLowerCase().split(":")[0].replace(/[^a-z0-9]/g, "");
  const known = [
    ["youtube", "youtube"],
    ["vimeo", "vimeo"],
    ["dailymotion", "dailymotion"],
    ["twitch", "twitch"],
    ["twitter", "x"],
    ["ted", "ted"],
    ["loom", "loom"],
    ["tiktok", "tiktok"],
    ["instagram", "instagram"],
    ["facebook", "facebook"],
    ["bilibili", "bilibili"],
    ["rumble", "rumble"],
    ["peertube", "peertube"]
  ];
  if (!e || e === "generic") return "web";
  return known.find(([prefix]) => e.startsWith(prefix))?.[1] ?? e;
}
function videoMetaFromInfo(info, sourceUrl) {
  const id = str(info.id);
  if (!id) return void 0;
  const site = siteOf(str(info.extractor_key) ?? str(info.extractor) ?? "youtube");
  const webpageUrl = httpUrl(str(info.webpage_url)) ?? httpUrl(str(info.original_url)) ?? httpUrl(sourceUrl) ?? `https://www.youtube.com/watch?v=${id}`;
  const date = str(info.upload_date);
  const tracks = (v) => v && typeof v === "object" ? Object.keys(v).filter((k) => k !== "live_chat") : [];
  const duration = num(info.duration);
  const chapters = Array.isArray(info.chapters) ? info.chapters.map((c) => ({
    start: num(c.start_time) ?? 0,
    end: num(c.end_time) ?? duration ?? 0,
    title: (str(c.title) ?? "").replace(/^<Untitled Chapter (\d+)>$/, "Chapter $1")
  })).filter((c) => c.title) : [];
  return {
    id,
    site,
    key: videoRunKey(site, id, webpageUrl),
    title: str(info.title) ?? id,
    channel: str(info.channel) ?? str(info.uploader),
    uploadDate: date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : void 0,
    duration,
    language: str(info.language),
    chapters,
    subtitles: tracks(info.subtitles),
    autoCaptions: tracks(info.automatic_captions),
    webpageUrl,
    ...info.live_status === "is_live" || info.is_live === true ? { live: "live" } : {},
    ...info.live_status === "is_upcoming" ? { live: "upcoming" } : {}
  };
}
async function probeVideo(url, run = defaultVideoRunner, signal, knownOnly = false) {
  const r = await runYtdlp(["-J", "--skip-download", "--no-playlist", "--no-warnings"], { run, url, signal, knownOnly });
  if (signal?.aborted) return { error: "cancelled" };
  if (r.missing) return { error: "install yt-dlp (https://github.com/yt-dlp/yt-dlp) to read videos", missing: true };
  if (!r.ok) return { error: classifyYtdlpError(r.stderr) };
  try {
    const parsed = JSON.parse(r.stdout);
    if (parsed?._type === "playlist") return { error: "a list of videos, not one \u2014 read it with `video list`" };
    const meta = parsed ? videoMetaFromInfo(parsed, url) : void 0;
    return meta ? { meta, info: r.stdout } : { error: "no video at this URL (yt-dlp found none)" };
  } catch {
    return { error: "yt-dlp returned unreadable metadata" };
  }
}
function classifyYtdlpError(stderr) {
  const s = stderr || "";
  const unblock = `update yt-dlp (\`${brand().cli} doctor\` shows how old it is) or set ${envName("YTDLP_ARGS")}="--cookies-from-browser firefox"`;
  if (/private video/i.test(s)) return "private video";
  if (/logged-in|log(?:ged)? ?in (?:is )?required|login required|requires? (?:a )?login|--username and --password|account credentials/i.test(s)) {
    return `the site asks yt-dlp to log in \u2014 ${envName("YTDLP_ARGS")}="--cookies-from-browser firefox" passes your browser's session`;
  }
  if (/members[- ]only|join this channel/i.test(s)) return "members-only video";
  if (/confirm your age|age[- ]restricted|inappropriate for some users/i.test(s)) {
    return `age-restricted video \u2014 it needs a signed-in session: ${envName("YTDLP_ARGS")}="--cookies-from-browser firefox"`;
  }
  if (/not a bot|sign in to confirm|po[ _-]?token|HTTP Error 403/i.test(s)) return `YouTube refused yt-dlp \u2014 ${unblock}`;
  if (/has been removed|account .*terminated|no longer available|copyright claim/i.test(s)) return "video removed";
  if (/unavailable|not available/i.test(s)) return "video unavailable";
  if (/timed out after/i.test(s)) return "yt-dlp timed out";
  if (/DRM protected/i.test(s)) return "the site serves this video under DRM: its picture and sound cannot be downloaded (subtitles still can)";
  if (/unsupported url|no video (?:formats|could be found)|no media found|there's no video/i.test(s)) return "no video at this URL (yt-dlp found none)";
  const line = s.split("\n").map((l) => l.trim()).find((l) => l.startsWith("ERROR:"));
  return `yt-dlp failed: ${(line ?? s.trim().split("\n")[0] ?? "").replace(/^ERROR:\s*/, "").slice(0, 200) || "no output"}`;
}
async function withTempDir(label, fn) {
  const dir = mkdtempSync2(join8(tmpdir2(), `${brand().name}-${label}-`));
  try {
    return await fn(dir);
  } finally {
    rmSync2(dir, { recursive: true, force: true });
  }
}
async function downloadSubtitle(info, lang, auto, run = defaultVideoRunner, signal, knownOnly = false) {
  return withTempDir("subs", async (dir) => {
    const infoPath = join8(dir, "info.json");
    writeFileSync4(infoPath, info);
    const r = await runYtdlp(
      [
        "--load-info-json",
        infoPath,
        "--skip-download",
        "--no-warnings",
        auto ? "--write-auto-subs" : "--write-subs",
        "--sub-langs",
        lang,
        "--sub-format",
        "vtt/srt",
        "-o",
        join8(dir, "sub.%(ext)s")
      ],
      { run, timeoutMs: SUBTITLE_TIMEOUT_MS, signal, knownOnly }
    );
    const file = readdirSync2(dir).find((f) => f.endsWith(".vtt")) ?? readdirSync2(dir).find((f) => f.endsWith(".srt"));
    if (file) return { vtt: readFileSync8(join8(dir, file), "utf8") };
    if (signal?.aborted) return { error: "cancelled" };
    return { error: r.ok ? `yt-dlp wrote no ${lang} track` : classifyYtdlpError(r.stderr) };
  });
}
async function ytdlpVersionAge(run = defaultVideoRunner, now = Date.now()) {
  const r = await run("yt-dlp", ["--version"], { timeoutMs: 2e4 });
  if (!r.ok) return void 0;
  const version = r.stdout.trim().split("\n")[0] ?? "";
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version);
  if (!m) return { version };
  const released = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return { version, ageDays: Math.max(0, Math.floor((now - released) / 864e5)) };
}
async function downloadMedia(args, dir, stem, opts) {
  let stderr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeoutMs = typeof opts.timeoutMs === "function" ? opts.timeoutMs() : opts.timeoutMs;
    const r = await runYtdlp([...args, "--no-warnings", "-o", join8(dir, `${stem}.%(ext)s`)], {
      run: opts.run,
      url: opts.url,
      timeoutMs,
      signal: opts.signal,
      knownOnly: opts.knownOnly
    });
    if (opts.signal?.aborted) return { error: "cancelled" };
    if (r.status === 124) return { error: "timed out", timedOut: true };
    const file = r.ok ? readdirSync2(dir).find((f) => f.startsWith(`${stem}.`) && !/\.part(?:-Frag\d+)?$|\.ytdl$|\.f\d+\.\w+$/.test(f)) : void 0;
    if (file) return { file };
    stderr = r.ok ? "yt-dlp wrote no file" : r.stderr;
  }
  return { error: classifyYtdlpError(stderr) };
}
var defaultVideoRunner, PROBE_TIMEOUT_MS, SUBTITLE_TIMEOUT_MS, str, httpUrl, num;
var init_ytdlp = __esm({
  "src/video/ytdlp.ts"() {
    "use strict";
    init_brand();
    init_exec2();
    init_url2();
    defaultVideoRunner = (cmd, args, opts) => shAsync(cmd, args, opts);
    PROBE_TIMEOUT_MS = 12e4;
    SUBTITLE_TIMEOUT_MS = 12e4;
    str = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
    httpUrl = (v) => v && /^https?:\/\//i.test(v) ? v : void 0;
    num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  }
});

// src/video/vtt.ts
function seconds(stamp) {
  const parts = stamp.replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole2, name2) => {
    if (name2[0] === "#") {
      const code = name2[1] === "x" || name2[1] === "X" ? Number.parseInt(name2.slice(2), 16) : Number(name2.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 1114111 ? String.fromCodePoint(code) : whole2;
    }
    return ENTITIES2[name2.toLowerCase()] ?? whole2;
  });
}
function parseVtt(src, opts = {}) {
  const text = src.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const srt = !/^WEBVTT/.test(text) && /^\s*\d+[ \t]*\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(text);
  if (!/^WEBVTT/.test(text) && !srt) return [];
  const rolling = opts.rolling ?? (/<\d{2}:\d{2}[:.]\d/.test(text) || /<c>/.test(text));
  const out = [];
  let shown2 = [];
  for (const block of text.split(/\n{2,}/)) {
    const raw = block.split("\n");
    const at = raw.findIndex((l) => TIMING.test(l));
    if (at < 0) continue;
    const m = TIMING.exec(raw[at]);
    const start = seconds(m[1]);
    const end = seconds(m[2]);
    const lines = raw.slice(at + 1).map(clean).filter(Boolean);
    const previous = shown2;
    shown2 = lines;
    if (end - start < MIN_CUE_S) continue;
    let fresh = lines;
    if (rolling) {
      fresh = lines.slice(repeatedLead(lines, previous));
      const last = previous[previous.length - 1];
      if (last && fresh[0]?.startsWith(`${last} `)) fresh = [fresh[0].slice(last.length + 1), ...fresh.slice(1)];
    }
    if (fresh.length) out.push({ start, end, text: fresh.join(" ") });
  }
  return out;
}
function repeatedLead(lines, previous) {
  for (let n = Math.min(lines.length, previous.length); n > 0; n--) {
    const tail = previous.slice(previous.length - n);
    if (tail.every((l, i) => l === lines[i])) return n;
  }
  return 0;
}
function mergeSegments(cues, breaks = []) {
  const out = [];
  let cur;
  const flush = () => {
    if (cur) out.push(cur);
    cur = void 0;
  };
  const crossesBreak = (from, to) => breaks.some((b) => b > from + BREAK_SLACK_S && b <= to + BREAK_SLACK_S);
  for (const cue of cues) {
    if (cur && (cue.start - cur.end > PAUSE_S || cue.end - cur.start > MAX_SEGMENT_S || crossesBreak(cur.start, cue.start))) flush();
    cur = cur ? { start: cur.start, end: Math.max(cur.end, cue.end), text: `${cur.text} ${cue.text}` } : { ...cue };
    const sentences = cur.text.match(SENTENCE_END)?.length ?? 0;
    const endsSentence = /[.!?…]+["'”’)\]]*$/.test(cur.text);
    const words = cur.text.split(/\s+/).length;
    if (sentences >= MAX_SENTENCES || endsSentence && words >= WORDS_TO_CLOSE) flush();
  }
  flush();
  return out;
}
var TIMING, MIN_CUE_S, ENTITIES2, clean, SENTENCE_END, MAX_SEGMENT_S, MAX_SENTENCES, PAUSE_S, WORDS_TO_CLOSE, BREAK_SLACK_S;
var init_vtt = __esm({
  "src/video/vtt.ts"() {
    "use strict";
    TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})/;
    MIN_CUE_S = 0.05;
    ENTITIES2 = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" };
    clean = (line) => decode(line.replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "")).replace(/\s+/g, " ").trim();
    SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
    MAX_SEGMENT_S = 30;
    MAX_SENTENCES = 3;
    PAUSE_S = 5;
    WORDS_TO_CLOSE = 25;
    BREAK_SLACK_S = 0.5;
  }
});

// src/video/whisper.ts
import { existsSync as existsSync2, readFileSync as readFileSync9, writeFileSync as writeFileSync5 } from "fs";
import { join as join9 } from "path";
function whisperBudgetLeft() {
  return Math.max(0, envInt("WHISPER_MAX", DEFAULT_MAX) - spent2);
}
function whisperModel() {
  return env("WHISPER_MODEL") ?? DEFAULT_MODEL;
}
function whisperSegments(json2) {
  try {
    const parsed = JSON.parse(json2);
    return (parsed.segments ?? []).map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      text: String(s.text ?? "").replace(/\s+/g, " ").trim()
    })).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.text);
  } catch {
    return [];
  }
}
function whisperLanguage(tag) {
  const base2 = tag?.toLowerCase().split(/[-_]/)[0];
  return base2 && /^[a-z]{2,3}$/.test(base2) ? base2 : void 0;
}
async function whisperTranscribe(info, language, run, signal, knownOnly = false) {
  if (whisperBudgetLeft() <= 0) return { declined: "budget" };
  spent2++;
  const refund = (r) => {
    spent2 = Math.max(0, spent2 - 1);
    return r;
  };
  const budgetMs = envInt("WHISPER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS2, 1e3);
  const deadline = Date.now() + budgetMs;
  const left = () => Math.max(1e3, deadline - Date.now());
  const timedOut = { failed: `whisper: timed out after ${Math.round(budgetMs / 6e4)} min (${envName("WHISPER_TIMEOUT_MS")})` };
  return withTempDir("whisper", async (dir) => {
    const infoPath = join9(dir, "info.json");
    writeFileSync5(infoPath, info);
    const dl = await downloadMedia(["--load-info-json", infoPath, "-f", AUDIO_FORMAT], dir, "audio", { run, timeoutMs: left, signal, knownOnly });
    if (signal?.aborted) return refund({ failed: "whisper: cancelled" });
    if ("timedOut" in dl) return timedOut;
    if ("error" in dl) return refund({ failed: `whisper: the audio download failed (${dl.error})` });
    const audio = dl.file;
    const wav = join9(dir, "speech.wav");
    const ff = await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", join9(dir, audio), "-ar", "16000", "-ac", "1", wav], {
      timeoutMs: left(),
      signal
    });
    if (ff.missing) return refund({ failed: "whisper needs ffmpeg", unavailable: true });
    if (signal?.aborted) return refund({ failed: "whisper: cancelled" });
    if (ff.status === 124) return timedOut;
    if (!ff.ok || !existsSync2(wav)) return refund({ failed: "whisper: ffmpeg could not convert the audio" });
    const args = ["--with", PYAV_PIN, "whisper-ctranslate2", wav, "--model", whisperModel(), "--output_format", "json", "--output_dir", dir];
    const lang = whisperLanguage(language);
    if (lang) args.push("--language", lang);
    const w = await run("uvx", args, { timeoutMs: left(), cwd: dir, signal });
    if (w.missing) return refund({ failed: "whisper needs uvx", unavailable: true });
    if (signal?.aborted) return { failed: "whisper: cancelled" };
    if (w.status === 124) return timedOut;
    const out = join9(dir, "speech.json");
    if (!w.ok || !existsSync2(out)) return { failed: `whisper: ${w.stderr.trim().split("\n").pop() || "failed"}` };
    return { segments: whisperSegments(readFileSync9(out, "utf8")) };
  });
}
var DEFAULT_MAX, DEFAULT_TIMEOUT_MS2, DEFAULT_MODEL, PYAV_PIN, AUDIO_FORMAT, spent2;
var init_whisper = __esm({
  "src/video/whisper.ts"() {
    "use strict";
    init_brand();
    init_ytdlp();
    DEFAULT_MAX = 3;
    DEFAULT_TIMEOUT_MS2 = 30 * 6e4;
    DEFAULT_MODEL = "small";
    PYAV_PIN = "av<18";
    AUDIO_FORMAT = "bestaudio/best";
    spent2 = 0;
  }
});

// src/video/ladder.ts
function videoDeps(own) {
  return { run: own?.run ?? processDeps.run ?? defaultVideoRunner, have: own?.have ?? processDeps.have ?? have };
}
function enabledTranscribers(engines) {
  return engines ?? enginesFromEnv("VIDEO_ENGINES", VIDEO_TRANSCRIBERS) ?? VIDEO_TRANSCRIBERS;
}
function assessTranscript(segments, duration) {
  const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  if (!words) return { ok: false, reason: "empty transcript" };
  if (duration && duration > 60) {
    const minutes = duration / 60;
    if (words / minutes < MIN_WORDS_PER_MINUTE) {
      return { ok: false, reason: `transcript too sparse: ${words} words over ${Math.round(minutes)} min \u2014 music or a silent video?` };
    }
  }
  return { ok: true };
}
function pickManualTrack(meta, lang) {
  const tracks = meta.subtitles;
  if (!tracks.length) return void 0;
  for (const want of [lang, meta.language, "en"]) {
    if (!want) continue;
    const exact = tracks.find((t) => t.toLowerCase() === want.toLowerCase());
    if (exact) return exact;
    const sameBase = tracks.find((t) => base(t) === base(want));
    if (sameBase) return sameBase;
  }
  return tracks[0];
}
function pickAutoTrack(meta) {
  const tracks = meta.autoCaptions;
  const lang = meta.language;
  if (lang) {
    for (const want of [`${lang}-orig`, lang]) {
      const hit = tracks.find((t) => t.toLowerCase() === want.toLowerCase());
      if (hit) return hit;
    }
    const orig = tracks.find((t) => t.endsWith("-orig") && base(t) === base(lang));
    if (orig) return orig;
    return void 0;
  }
  const origs = tracks.filter((t) => t.endsWith("-orig"));
  return origs.length === 1 ? origs[0] : void 0;
}
async function subtitleRung(auto, meta, info, opts, deps) {
  const track3 = auto ? pickAutoTrack(meta) : pickManualTrack(meta, opts.lang);
  if (!track3) return { failure: auto ? "no auto-captions in the video's language" : "no manual subtitles", noTrack: true };
  const got = await downloadSubtitle(info, track3, auto, deps.run, opts.signal, opts.knownHostsOnly);
  if ("error" in got) return { failure: `${auto ? "auto-captions" : "subtitles"} (${track3}): ${got.error}` };
  return { segments: mergeSegments(parseVtt(got.vtt, { rolling: auto }), chapterStarts(meta)), track: track3 };
}
async function whisperRung(meta, info, opts, deps) {
  const missing = ["uvx", "ffmpeg"].filter((c) => !deps.have(c));
  if (missing.length) return { failure: "whisper needs uvx and ffmpeg", unavailable: true };
  if (whisperBudgetLeft() <= 0) return { failure: `this run's whisper budget is spent (raise ${envName("WHISPER_MAX")})` };
  const r = await whisperTranscribe(info, meta.language, deps.run, opts.signal, opts.knownHostsOnly);
  if ("segments" in r) return { segments: mergeSegments(r.segments, chapterStarts(meta)) };
  if ("declined" in r) return { failure: `this run's whisper budget is spent (raise ${envName("WHISPER_MAX")})` };
  return { failure: r.failed, unavailable: r.unavailable };
}
async function transcribeVideo(url, opts = {}) {
  const none = (reason2, meta2) => ({
    text: "",
    segments: [],
    chapters: meta2?.chapters ?? [],
    ...meta2 ? { meta: meta2 } : {},
    reason: reason2
  });
  const source2 = videoSource(url, { anySite: !opts.knownHostsOnly });
  if (!source2) return none(`not a video URL${opts.knownHostsOnly ? " on a known video host" : ""}: ${url}`);
  const deps = videoDeps(opts.deps);
  const rungs = enabledTranscribers(opts.engines);
  if (!rungs.length) return none(`every transcript rung is switched off (${envName("VIDEO_ENGINES")})`);
  const probe = opts.probed ?? await probeVideo(source2.url, deps.run, opts.signal, opts.knownHostsOnly);
  if ("error" in probe) return none(probe.error);
  const { meta, info } = probe;
  if (meta.live) return none(`live stream ${meta.live === "live" ? "in progress" : "not started yet"} \u2014 read it once it has ended`, meta);
  const failures = [];
  let noTrack = 0;
  let subtitleRungs = 0;
  let whisperMissing = false;
  let gateReason;
  for (const rung of rungs) {
    if (opts.signal?.aborted) return none("cancelled", meta);
    if (rung !== "whisper") subtitleRungs++;
    const known = dead3.get(rung);
    let got;
    if (known) got = { failure: known, unavailable: true };
    else {
      try {
        got = rung === "whisper" ? await whisperRung(meta, info, opts, deps) : await subtitleRung(rung === "auto-subs", meta, info, opts, deps);
      } catch (e) {
        got = { failure: `${rung}: ${e.message}` };
      }
    }
    if (opts.signal?.aborted) return none("cancelled", meta);
    if ("failure" in got) {
      if (got.unavailable) dead3.set(rung, got.failure);
      if (rung === "whisper" && got.unavailable) whisperMissing = true;
      if (got.noTrack) noTrack++;
      failures.push(got.failure);
      continue;
    }
    const verdict = assessTranscript(got.segments, meta.duration);
    if (verdict.ok)
      return { text: plain(got.segments), segments: got.segments, chapters: meta.chapters, meta, via: rung, ...got.track ? { track: got.track } : {} };
    gateReason = verdict.reason;
  }
  let reason;
  if (subtitleRungs && noTrack === subtitleRungs && whisperMissing && !gateReason) reason = "no subtitles, and whisper needs uvx and ffmpeg";
  else reason = [...new Set([gateReason, ...failures].filter(Boolean))].join("; ");
  return none(reason || "no transcript", meta);
}
var VIDEO_TRANSCRIBERS, processDeps, dead3, MIN_WORDS_PER_MINUTE, base, chapterStarts, plain;
var init_ladder3 = __esm({
  "src/video/ladder.ts"() {
    "use strict";
    init_brand();
    init_exec2();
    init_ladder();
    init_url2();
    init_vtt();
    init_whisper();
    init_ytdlp();
    VIDEO_TRANSCRIBERS = ["manual-subs", "auto-subs", "whisper"];
    processDeps = {};
    dead3 = /* @__PURE__ */ new Map();
    MIN_WORDS_PER_MINUTE = 5;
    base = (tag) => tag.toLowerCase().split(/[-_]/)[0];
    chapterStarts = (meta) => meta.chapters.map((c) => c.start);
    plain = (segments) => segments.map((s) => s.text).join("\n");
  }
});

// src/video/markdown.ts
function formatStamp(seconds3) {
  const t = Math.max(0, Math.floor(Number.isFinite(seconds3) ? seconds3 : 0));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(t / 3600);
  const m = Math.floor(t % 3600 / 60);
  const s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function source(t) {
  if (!t.via) return void 0;
  const site = t.meta?.site ?? "youtube";
  const label = t.via === "auto-subs" && site !== "youtube" ? `the site's auto-captions` : VIA_LABEL[t.via] ?? t.via;
  const how = `${label} (${t.via}${t.track ? `, track ${t.track}` : ""})`;
  const spoken = t.meta?.language;
  if (t.track && spoken && baseLang(t.track) !== baseLang(spoken)) return `${how} \u2014 a translation: the video speaks ${spoken}`;
  return how;
}
function transcriptMarkdown(t) {
  if (!t.segments.length) return "";
  const meta = t.meta;
  const head = [`# ${meta?.title ?? "Video transcript"}`, ""];
  if (meta) {
    const facts = [
      meta.channel && `- Channel: ${meta.channel}`,
      meta.uploadDate && `- Published: ${meta.uploadDate}`,
      meta.duration !== void 0 && `- Duration: ${formatStamp(meta.duration)}`,
      `- URL: ${meta.webpageUrl}`,
      t.via && `- Transcript: ${source(t)}`
    ].filter(Boolean);
    head.push(...facts, "");
  }
  const body = [];
  const chapters = [...t.chapters].sort((a, b) => a.start - b.start);
  let c = -1;
  for (const seg of t.segments) {
    while (c + 1 < chapters.length && chapters[c + 1].start <= seg.start + 0.5) {
      c++;
      body.push(`## ${chapters[c].title}`, "");
    }
    body.push(paragraph(seg), "");
  }
  return [...head, ...body].join("\n").trimEnd() + "\n";
}
var VIA_LABEL, paragraph, baseLang;
var init_markdown = __esm({
  "src/video/markdown.ts"() {
    "use strict";
    VIA_LABEL = {
      "manual-subs": "manual subtitles",
      "auto-subs": "YouTube auto-captions",
      whisper: "local whisper transcription"
    };
    paragraph = (s) => `[${formatStamp(s.start)}] ${s.text}`;
    baseLang = (tag) => tag.toLowerCase().replace(/-orig$/, "").split(/[-_]/)[0];
  }
});

// src/text.ts
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isStopword(term) {
  const t = term.toLowerCase();
  if (STOPWORDS.has(t)) return true;
  if (LOCALE_STOPWORDS.has(t) && !(term !== t && term === term.toUpperCase())) return true;
  const extra = brand().extraStopwords;
  return extra ? extraStopwordSet(extra).has(t) : false;
}
function extraStopwordSet(extra) {
  const hit = extraSets.get(extra);
  if (hit && hit.length === extra.length) return hit.set;
  const set = new Set(extra.map((w) => w.toLowerCase()));
  extraSets.set(extra, { length: extra.length, set });
  return set;
}
function cjkBigrams(run) {
  const chars = Array.from(run);
  if (chars.length === 1) return [run];
  const out = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}
function keywords(question) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  const add2 = (raw, minLength) => {
    const lower = raw.toLowerCase();
    if (raw.length < minLength || isStopword(raw) || seen.has(lower)) return;
    seen.add(lower);
    out.push(raw);
  };
  const nonAscii = NON_ASCII.test(question);
  for (const [raw] of (nonAscii ? question.normalize("NFC") : question).matchAll(TOKEN_RE)) {
    if (!nonAscii || !CJK_CHAR.test(raw)) {
      add2(raw, 2);
      continue;
    }
    for (const piece of raw.split(CJK_RUNS)) {
      if (!piece) continue;
      if (!CJK_CHAR.test(piece)) add2(piece, 2);
      else for (const gram of cjkBigrams(piece)) add2(gram, 1);
    }
  }
  return out;
}
function rankedKeywords(question) {
  const base2 = keywords(question);
  const score = (raw) => {
    let s = 0;
    if (/\d/.test(raw)) s += 3;
    if (/[A-Z]/.test(raw) && !/^[A-Z0-9]+$/.test(raw)) s += 2;
    if (/_/.test(raw)) s += 2;
    if (raw.length >= 8) s += 1.5;
    else if (raw.length >= 5) s += 0.5;
    return s;
  };
  return base2.map((k, i) => ({ k, s: score(k), i })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.k);
}
function baseChar(ch) {
  const known = BASE_OF.get(ch);
  if (known) return known;
  const stripped = ch.normalize("NFD").replace(new RegExp("\\p{M}+", "gu"), "");
  return stripped.length === 1 ? stripped : ch;
}
function deaccent(s) {
  if (!NON_ASCII.test(s)) return s;
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
function subtokens(raw) {
  const spaced = raw.replace(new RegExp("([\\p{Ll}\\p{N}])(\\p{Lu})", "gu"), "$1 $2").replace(new RegExp("(\\p{Lu}+)(\\p{Lu}\\p{Ll})", "gu"), "$1 $2").replace(new RegExp("(\\p{L})(\\p{N})", "gu"), "$1 $2").replace(new RegExp("(\\p{N})(\\p{L})", "gu"), "$1 $2");
  const parts = spaced.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  if (parts.length < 2) return [];
  const out = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower.length < 3 || isStopword(p)) continue;
    if (!out.includes(lower)) out.push(lower);
    if (out.length >= 4) break;
  }
  return out;
}
function trimDashes(s) {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 45) start++;
  while (end > start && s.charCodeAt(end - 1) === 45) end--;
  return s.slice(start, end);
}
function slugify(input, opts = {}) {
  const max = opts.max ?? 120;
  const normalized = input.toLowerCase().replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/\.git$/, "");
  const s = trimDashes(normalized.replace(/[^a-z0-9._-]+/g, "-"));
  if (!/[\u0080-\uffff]/.test(normalized) && s.length <= max) return s || (opts.fallback ?? "");
  const canonical = trimDashes(normalized.replace(/[^\p{L}\p{N}._-]+/gu, "-"));
  const tag = fnv1a64(canonical).toString(16).padStart(16, "0").slice(0, 8);
  const readable = /[\u0080-\uffff]/.test(normalized) ? s.replace(/-{2,}/g, "-") : s;
  const head = readable.slice(0, Math.max(0, max - tag.length - 1)).replace(/-+$/, "");
  return head ? `${head}-${tag}` : tag;
}
var STOPWORDS, LOCALE_STOPWORDS, extraSets, TOKEN_RE, CJK_CHAR, CJK_RUNS, ACCENT_CLASSES, BASE_OF, NON_ASCII;
var init_text = __esm({
  "src/text.ts"() {
    "use strict";
    init_brand();
    init_url();
    STOPWORDS = /* @__PURE__ */ new Set([
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
      "vs"
    ]);
    LOCALE_STOPWORDS = /* @__PURE__ */ new Set([
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
      "ne",
      // German.
      "der",
      "die",
      "das",
      "und",
      "ist",
      "sind",
      "wie",
      "ein",
      "eine",
      "einen",
      "einem",
      "einer",
      "mit",
      "f\xFCr",
      "von",
      "zu",
      "den",
      "dem",
      "im",
      "auf",
      "nicht",
      "sich",
      "oder",
      "warum",
      "wann",
      "welche",
      "welcher",
      "welches",
      "kann",
      "wird"
    ]);
    extraSets = /* @__PURE__ */ new WeakMap();
    TOKEN_RE = new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])\\.net(?![\\p{L}\\p{M}\\p{N}_])|[\\p{L}\\p{M}\\p{N}_]+(?:(?<=\\p{L})[+#]{1,2}\\d*(?![\\p{L}\\p{M}\\p{N}_+#])|\\/\\d(?:\\.\\d)?(?![\\p{L}\\p{M}\\p{N}_./]))?", "giu");
    CJK_CHAR = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
    CJK_RUNS = /([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]+)/u;
    ACCENT_CLASSES = {
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
    BASE_OF = /* @__PURE__ */ new Map();
    for (const [base2, cls] of Object.entries(ACCENT_CLASSES)) {
      for (const ch of cls) BASE_OF.set(ch, base2);
    }
    NON_ASCII = /[\u0080-\uffff]/;
  }
});

// src/rank.ts
function rrf(lists, keyOf, k = 60) {
  const score = /* @__PURE__ */ new Map();
  for (const list of lists) {
    const seen = /* @__PURE__ */ new Set();
    list.forEach((item, idx) => {
      const key = keyOf(item);
      if (seen.has(key)) return;
      seen.add(key);
      score.set(key, (score.get(key) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return score;
}
function bm25Tokenize(text, opts = {}) {
  return tokenize(text, opts.subtokens !== false);
}
function tokenize(text, expand2) {
  if (!text) return [];
  const out = [];
  const nonAscii = NON_ASCII2.test(text);
  for (const raw of (nonAscii ? text.normalize("NFC") : text).split(WORD_SPLIT)) {
    if (!raw) continue;
    if (nonAscii && CJK_CHAR2.test(raw)) {
      for (const piece of raw.split(CJK_RUNS2)) {
        if (!piece) continue;
        if (CJK_CHAR2.test(piece)) pushBigrams(piece, out);
        else pushTerm(piece, out, expand2);
      }
    } else pushTerm(raw, out, expand2);
  }
  return out;
}
function pushTerm(raw, out, expand2) {
  if (raw.length < 2 || isStopword(raw)) return;
  const t = foldCached(raw);
  if (t.length < 2) return;
  out.push(t);
  if (!expand2 || raw.length > MAX_IDENT) return;
  for (const sub of subtermsCached(raw, t)) out.push(sub);
}
function pushBigrams(run, out) {
  const chars = Array.from(run);
  if (chars.length === 1) {
    out.push(run);
    return;
  }
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
}
function foldCached(raw) {
  const hit = foldCache.get(raw);
  if (hit !== void 0) return hit;
  const t = foldTerm(raw);
  if (foldCache.size >= FOLD_CACHE_MAX) foldCache.clear();
  foldCache.set(raw, t);
  return t;
}
function subtermsCached(raw, folded) {
  const list = brand().extraStopwords;
  if (list !== subtermExtras.list || (list?.length ?? 0) !== subtermExtras.length) {
    subtermCache.clear();
    subtermExtras = { list, length: list?.length ?? 0 };
  }
  const hit = subtermCache.get(raw);
  if (hit !== void 0) return hit;
  let subs = NO_SUBTERMS;
  if (IDENT_BOUNDARY.test(raw)) {
    subs = subtokens(raw).map(foldCached).filter((sub) => sub !== folded && sub.length >= 2);
  }
  if (subtermCache.size >= FOLD_CACHE_MAX) subtermCache.clear();
  subtermCache.set(raw, subs);
  return subs;
}
function docTokens(doc, titleWeight, headingWeight, body) {
  const out = body ? [...body] : bm25Tokenize(doc.body);
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
  const tokenCache = /* @__PURE__ */ new WeakMap();
  let totalLen = 0;
  for (const doc of docs) {
    const toks = docTokens(doc, titleWeight, headingWeight, opts.tokensOf?.(doc));
    tokenCache.set(doc, { title: doc.title, headings: doc.headings, body: doc.body, tokens: toks });
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
  const index = { idf, avgdl, N, queryTerms, k1, b, titleWeight, headingWeight };
  indexTokenCache.set(index, tokenCache);
  return index;
}
function indexedDocTokens(index, doc) {
  const cache2 = indexTokenCache.get(index);
  const cached = cache2?.get(doc);
  if (cached && cached.title === doc.title && cached.headings === doc.headings && cached.body === doc.body) return cached.tokens;
  const tokens = docTokens(doc, index.titleWeight, index.headingWeight);
  cache2?.set(doc, { title: doc.title, headings: doc.headings, body: doc.body, tokens });
  return tokens;
}
function bm25Score(index, doc) {
  if (!index.queryTerms.length) return 0;
  const toks = indexedDocTokens(index, doc);
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
  const present = new Set(indexedDocTokens(index, doc));
  return index.queryTerms.filter((t) => present.has(t));
}
function simhashLanes(toks, out) {
  out[0] = 0;
  out[1] = 0;
  if (!toks.length) return;
  const v = new Int32Array(64);
  const words = new Uint32Array(2);
  const pieces = toks.length < 3 ? [""] : ["", " ", "", " ", ""];
  const n = toks.length < 3 ? toks.length : toks.length - 2;
  for (let i = 0; i < n; i++) {
    if (toks.length < 3) pieces[0] = toks[i];
    else {
      pieces[0] = toks[i];
      pieces[2] = toks[i + 1];
      pieces[4] = toks[i + 2];
    }
    fnv1a64Words(pieces, words);
    const hi2 = words[0];
    const lo2 = words[1];
    for (let b = 0; b < 32; b++) {
      v[b] = v[b] + (lo2 >>> b & 1);
      v[b + 32] = v[b + 32] + (hi2 >>> b & 1);
    }
  }
  let lo = 0;
  let hi = 0;
  for (let b = 0; b < 32; b++) {
    if (2 * v[b] > n) lo |= 1 << b;
    if (2 * v[b + 32] > n) hi |= 1 << b;
  }
  out[0] = hi;
  out[1] = lo;
}
function popcount32(n) {
  let x = n - (n >>> 1 & 1431655765);
  x = (x & 858993459) + (x >>> 2 & 858993459);
  return Math.imul(x + (x >>> 4) & 252645135, 16843009) >>> 24;
}
function dedupeNearDuplicates(items, opts = {}) {
  const maxBits = opts.maxBits ?? 3;
  const minChars = opts.minChars ?? 500;
  const better = (a, b) => a.score !== b.score ? a.score > b.score : byCodeUnit(a.url, b.url) < 0;
  const kept = [];
  const hashed = [];
  const his = [];
  const los = [];
  const lanes = new Uint32Array(2);
  const dups = [];
  for (const it of items) {
    const text = it.text || "";
    if (text.length < minChars) {
      kept.push({ it });
      continue;
    }
    simhashLanes(opts.tokensOf ? opts.tokensOf(it) : tokenize(text, false), lanes);
    const hi = lanes[0];
    const lo = lanes[1];
    let at = -1;
    for (let k = 0; k < hashed.length; k++) {
      if (popcount32(his[k] ^ hi) + popcount32(los[k] ^ lo) <= maxBits) {
        at = k;
        break;
      }
    }
    if (at < 0) {
      const cluster = { it };
      kept.push(cluster);
      hashed.push(cluster);
      his.push(hi);
      los.push(lo);
      continue;
    }
    const dup = hashed[at];
    if (better(it, dup.it)) {
      dups.push({ url: dup.it.url, cluster: dup });
      dup.it = it;
      his[at] = hi;
      los[at] = lo;
    } else dups.push({ url: it.url, cluster: dup });
  }
  return { items: kept.map((k) => k.it), dropped: dups.length, duplicates: dups.map((d) => ({ url: d.url, of: d.cluster.it.url })) };
}
function diversify(items, tokensOf, lambda = 0.75, opts = {}) {
  const sorted = [...items].sort((a, b) => b.score - a.score || byCodeUnit(a.url, b.url));
  if (sorted.length <= 2) return sorted;
  const window = opts.window !== void 0 && opts.window > 0 ? Math.floor(opts.window) : sorted.length;
  if (window >= sorted.length) return mmr(sorted, tokensOf, lambda);
  return [...window > 2 ? mmr(sorted.slice(0, window), tokensOf, lambda) : sorted.slice(0, window), ...sorted.slice(window)];
}
function mmr(sorted, tokensOf, lambda) {
  const m = sorted.length;
  let max = 1e-9;
  for (const it of sorted) if (it.score > max) max = it.score;
  const ids = /* @__PURE__ */ new Map();
  const sets = [];
  for (const it of sorted) {
    const raw = [];
    for (const t of tokensOf(it)) {
      let id = ids.get(t);
      if (id === void 0) {
        id = ids.size;
        ids.set(t, id);
      }
      raw.push(id);
    }
    const all = Int32Array.from(raw).sort();
    let k = 0;
    for (let j = 0; j < all.length; j++) if (j === 0 || all[j] !== all[j - 1]) all[k++] = all[j];
    sets.push(all.subarray(0, k));
  }
  const cache2 = m <= PAIR_CACHE_MAX ? new Float64Array(m * (m - 1) / 2) : void 0;
  const pair = (i, j) => i < j ? i * (2 * m - i - 1) / 2 + (j - i - 1) : j * (2 * m - j - 1) / 2 + (i - j - 1);
  let simMax = 0;
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const v = jaccardSorted(sets[i], sets[j]);
      if (cache2) cache2[pair(i, j)] = v;
      if (v > simMax) simMax = v;
    }
  }
  const sim = (i, j) => simMax > 0 ? (cache2 ? cache2[pair(i, j)] : jaccardSorted(sets[i], sets[j])) / simMax : 0;
  const out = [sorted[0]];
  const remaining = [];
  for (let i = 1; i < m; i++) remaining.push(i);
  const maxSim = new Float64Array(m);
  for (const i of remaining) maxSim[i] = sim(i, 0);
  let relevantLeft = 0;
  for (const i of remaining) if (sorted[i].score > 0) relevantLeft++;
  while (remaining.length) {
    let bestPos = -1;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (let p = 0; p < remaining.length; p++) {
      const it = sorted[remaining[p]];
      if (relevantLeft > 0 && !(it.score > 0)) continue;
      const val = lambda * (it.score / max) - (1 - lambda) * maxSim[remaining[p]];
      if (bestPos < 0 || val > bestVal || val === bestVal && byCodeUnit(it.url, sorted[remaining[bestPos]].url) < 0) {
        bestVal = val;
        bestPos = p;
      }
    }
    const picked = remaining.splice(bestPos, 1)[0];
    if (sorted[picked].score > 0) relevantLeft--;
    out.push(sorted[picked]);
    for (const i of remaining) {
      const v = sim(i, picked);
      if (v > maxSim[i]) maxSim[i] = v;
    }
  }
  return out;
}
function jaccardSorted(a, b) {
  const na = a.length;
  const nb = b.length;
  if (!na || !nb) return 0;
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < na && j < nb) {
    const x = a[i];
    const y = b[j];
    if (x === y) {
      inter++;
      i++;
      j++;
    } else if (x < y) i++;
    else j++;
  }
  return inter / (na + nb - inter);
}
var byCodeUnit, indexTokenCache, WORD_SPLIT, NON_ASCII2, CJK_CHAR2, CJK_RUNS2, IDENT_BOUNDARY, MAX_IDENT, FOLD_CACHE_MAX, foldCache, NO_SUBTERMS, subtermCache, subtermExtras, PAIR_CACHE_MAX;
var init_rank = __esm({
  "src/rank.ts"() {
    "use strict";
    init_brand();
    init_text();
    init_url();
    byCodeUnit = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    indexTokenCache = /* @__PURE__ */ new WeakMap();
    WORD_SPLIT = /[^\p{L}\p{M}\p{N}_]+/u;
    NON_ASCII2 = /[^\p{ASCII}]/u;
    CJK_CHAR2 = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
    CJK_RUNS2 = /([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]+)/u;
    IDENT_BOUNDARY = new RegExp("_|[\\p{Ll}\\p{N}]\\p{Lu}|\\p{Lu}\\p{Lu}\\p{Ll}|\\p{L}\\p{N}|\\p{N}\\p{L}", "u");
    MAX_IDENT = 64;
    FOLD_CACHE_MAX = 5e4;
    foldCache = /* @__PURE__ */ new Map();
    NO_SUBTERMS = [];
    subtermCache = /* @__PURE__ */ new Map();
    subtermExtras = { list: void 0, length: 0 };
    PAIR_CACHE_MAX = 2048;
  }
});

// src/video/run.ts
import { existsSync as existsSync3, readdirSync as readdirSync3, readFileSync as readFileSync10, statSync } from "fs";
import { tmpdir as tmpdir3 } from "os";
import { join as join10, resolve } from "path";
function videoRoot(out) {
  return resolve(out ?? env("VIDEO_DIR") ?? join10(tmpdir3(), brand().name, "video"));
}
function servesLang(meta, lang) {
  if (!lang) return true;
  const read3 = meta.track ?? meta.lang ?? meta.language;
  return read3 !== void 0 && baseLang2(read3) === baseLang2(lang);
}
function readVideoRun(dir) {
  const meta = readJson(join10(dir, "meta.json"));
  const segments = readJson(join10(dir, "segments.json"));
  if (!meta?.id || !Array.isArray(segments)) return void 0;
  return { meta, segments };
}
async function fetchVideoRun(url, root, opts = {}) {
  const source2 = videoSource(url, { anySite: !opts.knownHostsOnly });
  if (!source2) return { ok: false, reason: `not a video URL${opts.knownHostsOnly ? " on a known video host" : ""}: ${url}` };
  const kept = (key) => {
    const dir2 = join10(root, key);
    const run = opts.refresh ? void 0 : readVideoRun(dir2);
    if (!run || !existsSync3(join10(dir2, "TRANSCRIPT.md")) || !servesLang(run.meta, opts.lang)) return void 0;
    return { ok: true, id: key, dir: dir2, transcript: join10(dir2, "TRANSCRIPT.md"), reused: true, meta: run.meta, segments: run.segments.length };
  };
  if (source2.key) {
    const reused = kept(source2.key);
    if (reused) return reused;
  }
  let probed3;
  if (!source2.key) {
    const probe = await probeVideo(source2.url, videoDeps(opts.deps).run, opts.signal, opts.knownHostsOnly);
    if ("error" in probe) return { ok: false, reason: probe.error };
    const reused = kept(probe.meta.key ?? probe.meta.id);
    if (reused) return reused;
    probed3 = probe;
  }
  const t = await transcribeVideo(url, { ...opts, ...probed3 ? { probed: probed3 } : {} });
  const id = source2.key ?? t.meta?.key ?? t.meta?.id;
  if (!t.via || !t.meta || !id) return { ok: false, ...id ? { id } : {}, reason: t.reason ?? "no transcript" };
  const dir = join10(root, id);
  const transcriptPath = join10(dir, "TRANSCRIPT.md");
  const meta = {
    ...t.meta,
    via: t.via,
    ...t.track ? { track: t.track } : {},
    ...opts.lang ? { lang: opts.lang } : {},
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const markdown = transcriptMarkdown(t);
  const done = { ok: true, id, dir, transcript: transcriptPath, reused: false, meta, segments: t.segments.length };
  if (isNoWrite()) return { ...done, markdown };
  try {
    ensureDir(dir);
    writeArtifact(join10(dir, "segments.json"), `${JSON.stringify(t.segments, null, 1)}
`);
    writeArtifact(transcriptPath, markdown);
    writeArtifact(join10(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}
`);
  } catch (e) {
    return { ok: false, id, reason: `cannot write the run in ${dir}: ${e.message}` };
  }
  return done;
}
function passageGroups(segments, chapterStarts2) {
  const out = [];
  let cur = [];
  for (const s of segments) {
    if (cur.length && chapterStarts2.some((b) => b > cur[0].start + 0.5 && b <= s.start + 0.5)) {
      out.push(cur);
      cur = [];
    }
    cur.push(s);
    if (s.end - cur[0].start >= PASSAGE_S) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
function listVideoRuns(dir) {
  const self = readVideoRun(dir);
  if (self) return [{ dir, ...self }];
  let names = [];
  try {
    names = readdirSync3(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((name2) => {
    const child = join10(dir, name2);
    try {
      if (!statSync(child).isDirectory()) return [];
    } catch {
      return [];
    }
    const run = readVideoRun(child);
    return run ? [{ dir: child, ...run }] : [];
  });
}
function corpusLabels(dir) {
  const c = readJson(join10(dir, "corpus.json"));
  const out = /* @__PURE__ */ new Map();
  for (const v of c?.videos ?? []) if (typeof v.id === "string" && typeof v.label === "string") out.set(v.id, v.label);
  return out;
}
function searchVideoRuns(dir, query, opts = {}) {
  const labels = opts.labels ?? corpusLabels(dir);
  const docs = [];
  for (const run of listVideoRuns(dir)) {
    const { meta } = run;
    const key = meta.key ?? meta.id;
    for (const parts of passageGroups(
      run.segments,
      (meta.chapters ?? []).map((c) => c.start)
    )) {
      const chapter = chapterAt(meta.chapters ?? [], parts[0].start);
      docs.push({ id: `${key}@${parts[0].start}`, title: "", headings: chapter ?? "", body: parts.map((s) => s.text).join(" "), parts, meta, key, chapter });
    }
  }
  const index = buildBm25Index(query, docs);
  const scored = docs.map((d) => ({ d, score: Math.round(bm25Score(index, d) * 1e3) / 1e3 })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.d.key.localeCompare(b.d.key) || a.d.parts[0].start - b.d.parts[0].start).slice(0, opts.limit ?? 10);
  return scored.map(({ d, score }) => {
    let best = d.parts[0];
    let top = 0;
    for (const s of d.parts) {
      const sc = bm25Score(index, { id: `${d.id}#${s.start}`, title: "", headings: "", body: s.text });
      if (sc > top) {
        top = sc;
        best = s;
      }
    }
    return {
      label: labels.get(d.key) ?? d.key,
      videoId: d.key,
      title: d.meta.title,
      ...d.chapter ? { chapter: d.chapter } : {},
      start: best.start,
      stamp: formatStamp(best.start),
      url: videoUrlAt(d.meta.webpageUrl, best.start),
      text: d.body,
      score
    };
  });
}
var baseLang2, readJson, PASSAGE_S, chapterAt;
var init_run = __esm({
  "src/video/run.ts"() {
    "use strict";
    init_brand();
    init_no_write();
    init_rank();
    init_ladder3();
    init_markdown();
    init_url2();
    init_ytdlp();
    baseLang2 = (tag) => tag.toLowerCase().replace(/-orig$/, "").split(/[-_]/)[0];
    readJson = (path) => {
      try {
        return JSON.parse(readFileSync10(path, "utf8"));
      } catch {
        return void 0;
      }
    };
    PASSAGE_S = 45;
    chapterAt = (chapters, t) => [...chapters].reverse().find((c) => c.start <= t + 0.5)?.title;
  }
});

// src/video/align.ts
function transcriptAround(segments, t) {
  return segments.filter((s) => s.end >= t - BEFORE_S && s.start <= t + AFTER_S).map((s) => `[${formatStamp(s.start)}] ${s.text}`).join("\n");
}
function alignFrames(frames, segments, chapters) {
  return frames.map((f) => {
    const chapter = chapterAt2(chapters, f.time);
    return { file: f.file, time: f.time, stamp: formatStamp(f.time), kind: f.kind, ...chapter ? { chapter } : {}, text: transcriptAround(segments, f.time) };
  });
}
function framesMarkdown(meta, frames, note) {
  const out = [`# ${meta.title} \u2014 frames`, "", `- URL: ${meta.webpageUrl}`, `- ${note}`, ""];
  const quoted = /* @__PURE__ */ new Set();
  for (const f of frames) {
    out.push(`## [${f.stamp}]${f.chapter ? ` ${f.chapter}` : ""}`, "", `![${f.stamp}](${f.file})`, "");
    const lines = f.text ? f.text.split("\n") : [];
    const fresh = lines.filter((l) => !quoted.has(l));
    for (const l of fresh) quoted.add(l);
    if (fresh.length) out.push(...fresh.map((l) => `> ${l}`), "");
    else if (lines.length) out.push(`_(said over the passage quoted above, from ${lines[0].slice(0, lines[0].indexOf("]") + 1)})_`, "");
    else out.push("_(nothing said around this frame)_", "");
  }
  return out.join("\n").trimEnd() + "\n";
}
var BEFORE_S, AFTER_S, chapterAt2;
var init_align = __esm({
  "src/video/align.ts"() {
    "use strict";
    init_markdown();
    BEFORE_S = 5;
    AFTER_S = 10;
    chapterAt2 = (chapters, t) => [...chapters].sort((a, b) => b.start - a.start).find((c) => c.start <= t + 0.5)?.title;
  }
});

// src/video/dhash.ts
function dhash(gray) {
  if (gray.length < DHASH_FRAME_BYTES) throw new Error(`dhash needs ${DHASH_FRAME_BYTES} bytes, got ${gray.length}`);
  let h = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      h = h << 1n | (gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return h;
}
function hamming(a, b) {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}
function dhashStream(raw) {
  const out = [];
  for (let at = 0; at + DHASH_FRAME_BYTES <= raw.length; at += DHASH_FRAME_BYTES) out.push(dhash(raw.subarray(at, at + DHASH_FRAME_BYTES)));
  return out;
}
var DHASH_FRAME_BYTES, DHASH_SAME;
var init_dhash = __esm({
  "src/video/dhash.ts"() {
    "use strict";
    DHASH_FRAME_BYTES = 72;
    DHASH_SAME = 6;
  }
});

// src/video/frames.ts
import { copyFileSync, cpSync, existsSync as existsSync4, mkdirSync as mkdirSync2, readdirSync as readdirSync4, readFileSync as readFileSync11, renameSync as renameSync2, rmSync as rmSync3 } from "fs";
import { join as join11 } from "path";
function parseShowinfo(stderr) {
  const out = [];
  for (const m of stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g)) out[Number(m[1])] = Number(m[2]);
  return out.filter((t) => Number.isFinite(t));
}
function capFrames(frames, max) {
  const kept = [...frames].sort((a, b) => a.time - b.time);
  const limit = Math.max(1, max);
  while (kept.length > limit) {
    const spareChapters = kept.some((f) => f.kind !== "chapter");
    let worst = kept.length - 1;
    let gap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < kept.length; i++) {
      if (spareChapters && kept[i].kind === "chapter") continue;
      const g = i ? kept[i].time - kept[i - 1].time : kept[1].time - kept[0].time;
      if (g < gap) {
        gap = g;
        worst = i;
      }
    }
    kept.splice(worst, 1);
  }
  return kept;
}
async function extractFrames(runDir, opts = {}) {
  if (isNoWrite()) return { ok: false, reason: "frames are image files, and nothing may be written (NO_WRITE)" };
  const run = readVideoRun(runDir);
  if (!run) return { ok: false, reason: `no video run in ${runDir} \u2014 fetch the video first` };
  const deps = videoDeps(opts.deps);
  if (!deps.have("ffmpeg")) return { ok: false, reason: "frames need ffmpeg" };
  const effort = opts.effort ?? "med";
  const { meta, segments } = run;
  const source2 = videoSource(opts.url ?? meta.webpageUrl, { anySite: !opts.knownHostsOnly });
  if (!source2) return { ok: false, reason: `the run in ${runDir} names no page this may download the video from` };
  const duration = meta.duration ?? 0;
  return withTempDir("frames", async (tmp) => {
    const dl = await downloadMedia(["-f", VIDEO_FORMAT, "--no-playlist"], tmp, "video", {
      run: deps.run,
      url: source2.url,
      knownOnly: opts.knownHostsOnly,
      timeoutMs: FRAMES_TIMEOUT_MS,
      signal: opts.signal
    });
    if (opts.signal?.aborted) return { ok: false, reason: "cancelled" };
    if ("error" in dl) return { ok: false, reason: `the video download failed: ${dl.error}` };
    const video = dl.file;
    const input = join11(tmp, video);
    const ffmpeg = (args) => deps.run("ffmpeg", ["-nostdin", "-hide_banner", ...args], { timeoutMs: FRAMES_TIMEOUT_MS, signal: opts.signal });
    const sceneDir = join11(tmp, "scene");
    mkdirSync2(sceneDir);
    const scenes = await ffmpeg([
      "-i",
      input,
      "-vf",
      `select='gt(scene,${SCENE_THRESHOLD})',showinfo,${JPEG_FILTER}`,
      "-fps_mode",
      "vfr",
      "-q:v",
      "3",
      join11(sceneDir, "%04d.jpg")
    ]);
    if (opts.signal?.aborted) return { ok: false, reason: "cancelled" };
    const times = parseShowinfo(scenes.stderr);
    const sceneFiles = readdirSync4(sceneDir).sort();
    const candidates2 = sceneFiles.slice(0, times.length).map((f, i) => ({ path: join11(sceneDir, f), time: times[i], kind: "scene" }));
    const single = async (time, kind) => {
      const path = join11(tmp, `${kind}-${candidates2.length}.jpg`);
      await ffmpeg(["-loglevel", "error", "-ss", time.toFixed(2), "-i", input, "-frames:v", "1", "-vf", JPEG_FILTER, "-q:v", "3", "-y", path]);
      if (existsSync4(path)) candidates2.push({ path, time, kind });
    };
    const last = duration > 1 ? duration - 0.5 : Number.POSITIVE_INFINITY;
    for (const c of meta.chapters ?? []) await single(Math.min(c.start + 1, last), "chapter");
    if (candidates2.length < MIN_FRAMES && duration > 0) {
      const n = Math.min(FRAME_EFFORT[effort], INTERVAL_FRAMES);
      for (let i = 0; i < n; i++) await single(duration * (i + 0.5) / n, "interval");
    }
    if (opts.signal?.aborted) return { ok: false, reason: "cancelled" };
    if (!candidates2.length)
      return { ok: false, reason: `ffmpeg took no frame from the video${scenes.ok ? "" : ` (${scenes.stderr.trim().split("\n").pop()})`}` };
    candidates2.sort((a, b) => a.time - b.time);
    const candDir = join11(tmp, "cand");
    mkdirSync2(candDir);
    candidates2.forEach((c, i) => copyFileSync(c.path, join11(candDir, `${String(i + 1).padStart(4, "0")}.jpg`)));
    const raw = join11(tmp, "hash.raw");
    await ffmpeg(["-loglevel", "error", "-i", join11(candDir, "%04d.jpg"), "-vf", "scale=9:8,format=gray", "-f", "rawvideo", "-y", raw]);
    const hashes = existsSync4(raw) ? dhashStream(readFileSync11(raw)) : [];
    const kept = [];
    for (const [i, c] of candidates2.entries()) {
      const hash = hashes.length === candidates2.length ? hashes[i] : void 0;
      if (hash !== void 0 && kept.some((k) => k.hash !== void 0 && hamming(k.hash, hash) <= DHASH_SAME)) continue;
      kept.push({ ...c, ...hash !== void 0 ? { hash } : {} });
    }
    const chosen = capFrames(kept, FRAME_EFFORT[effort]);
    const staged = join11(tmp, "frames");
    mkdirSync2(staged);
    const placed = chosen.map((c, i) => {
      const file = `frames/${String(i + 1).padStart(4, "0")}_${fileStamp(c.time)}.jpg`;
      copyFileSync(c.path, join11(tmp, file));
      return { file, time: c.time, kind: c.kind };
    });
    const frames = alignFrames(placed, segments, meta.chapters ?? []);
    const dropped = candidates2.length - kept.length;
    const note = `${plural(frames.length, "frame")} (effort ${effort}: at most ${FRAME_EFFORT[effort]}) from ${plural(candidates2.length, "candidate")} \u2014 scene changes above ${SCENE_THRESHOLD}, one per chapter start, ${plural(dropped, "near-duplicate")} dropped`;
    const framesDir = join11(runDir, "frames");
    try {
      const incoming = `${framesDir}.${process.pid}.${Date.now()}.new`;
      cpSync(staged, incoming, { recursive: true });
      rmSync3(framesDir, { recursive: true, force: true });
      renameSync2(incoming, framesDir);
      writeArtifact(join11(runDir, "frames.json"), `${JSON.stringify(frames, null, 2)}
`);
      const markdown = writeArtifact(join11(runDir, "FRAMES.md"), framesMarkdown(meta, frames, note));
      return { ok: true, dir: framesDir, markdown, frames, candidates: candidates2.length, duplicates: dropped, effort };
    } catch (e) {
      return { ok: false, reason: `cannot write the frames in ${runDir}: ${e.message}` };
    }
  });
}
var FRAME_EFFORT, SCENE_THRESHOLD, VIDEO_FORMAT, FRAMES_TIMEOUT_MS, MIN_FRAMES, INTERVAL_FRAMES, JPEG_FILTER, plural, fileStamp;
var init_frames = __esm({
  "src/video/frames.ts"() {
    "use strict";
    init_no_write();
    init_align();
    init_dhash();
    init_ladder3();
    init_markdown();
    init_run();
    init_url2();
    init_ytdlp();
    FRAME_EFFORT = { low: 20, med: 50, high: 100 };
    SCENE_THRESHOLD = 0.3;
    VIDEO_FORMAT = "bv*[height<=720]/b[height<=720]/bv*/b";
    FRAMES_TIMEOUT_MS = 30 * 6e4;
    MIN_FRAMES = 3;
    INTERVAL_FRAMES = 10;
    JPEG_FILTER = "scale='min(1280,iw)':-2:out_range=full,format=yuvj420p";
    plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    fileStamp = (t) => formatStamp(t).replace(/:/g, "-");
  }
});

// src/pool.ts
async function mapLimit(items, limit, fn) {
  const width = typeof limit !== "number" || Number.isNaN(limit) ? 1 : Math.max(1, Math.floor(limit));
  if (items.length <= 1 || width === 1) {
    const out = [];
    for (let i = 0; i < items.length; i++) out.push(await fn(items[i], i));
    return out;
  }
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (; ; ) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        next = items.length;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
var init_pool = __esm({
  "src/pool.ts"() {
    "use strict";
  }
});

// src/video/list.ts
import { join as join12 } from "path";
function listingUrl(url) {
  const u = new URL(url);
  if (youtubeListKind(url) === "channel" && /^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)\/?$/.test(u.pathname)) {
    u.pathname = `${u.pathname.replace(/\/$/, "")}/videos`;
  }
  return u.toString();
}
async function listVideos(url, opts = {}) {
  const u = /^https?:\/\//i.test(url) ? url : void 0;
  if (!u || !youtubeListKind(url) && (opts.knownHostsOnly || knownVideo(url)))
    return { error: `not a playlist or channel URL${opts.knownHostsOnly ? " on YouTube" : ""}: ${url}` };
  const limit = Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT));
  const r = await runYtdlp(["--flat-playlist", "-J", "--playlist-end", String(limit), "--no-warnings"], {
    run: videoDeps(opts.deps).run,
    url: listingUrl(url),
    timeoutMs: LIST_TIMEOUT_MS,
    signal: opts.signal,
    knownOnly: opts.knownHostsOnly
  });
  if (r.missing) return { error: "install yt-dlp (https://github.com/yt-dlp/yt-dlp) to read videos" };
  if (!r.ok) return { error: classifyYtdlpError(r.stderr) };
  try {
    const info = JSON.parse(r.stdout);
    const videos = (info.entries ?? []).flatMap((e) => {
      const id = typeof e.id === "string" ? e.id : "";
      const ie = typeof e.ie_key === "string" ? e.ie_key : "";
      if (!id || e._type === "playlist" || /tab|playlist|channel|user|album|showcase/i.test(ie)) return [];
      const title = typeof e.title === "string" ? e.title : id;
      const duration = typeof e.duration === "number" ? { duration: e.duration } : {};
      if (youtubeListKind(url)) {
        const watch = `https://www.youtube.com/watch?v=${id}`;
        return (ie === "" || ie === "Youtube") && youtubeVideoId(watch) ? [{ id, key: id, title, ...duration, url: watch }] : [];
      }
      const entryUrl = [e.url, e.webpage_url].find((v) => typeof v === "string" && /^https?:\/\//i.test(v));
      if (!entryUrl || opts.knownHostsOnly && !knownVideo(entryUrl)) return [];
      const known = knownVideo(entryUrl);
      return [{ id, ...known?.key ? { key: known.key } : {}, title, ...duration, url: known?.url ?? entryUrl }];
    });
    const unique = videos.filter((v, i) => videos.findIndex((w) => w.url === v.url) === i);
    return { ...info.title ? { title: info.title } : {}, videos: unique.slice(0, limit) };
  } catch {
    return { error: "yt-dlp returned an unreadable listing" };
  }
}
function corpusMarkdown(c, root) {
  const cell2 = (s) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");
  const rows = c.videos.map(
    (v) => [
      v.label,
      v.id,
      cell2(v.title),
      v.duration !== void 0 ? formatStamp(v.duration) : "",
      v.via ?? "\u2014",
      v.dir ? `${v.id}/TRANSCRIPT.md` : cell2(`not read: ${v.reason ?? "no transcript"}`)
    ].join(" | ")
  );
  const read3 = c.videos.filter((v) => v.dir).length;
  return [
    `# ${c.title ?? "Video corpus"}`,
    "",
    `- Source: ${c.source}`,
    `- Directory: ${root}`,
    `- ${read3} of ${c.videos.length} videos read, ${c.createdAt}`,
    "",
    "| V# | id | title | duration | via | transcript |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r} |`),
    ""
  ].join("\n");
}
async function fetchVideoCorpus(url, root, opts = {}) {
  if (isNoWrite()) return { ok: false, reason: "a corpus is kept on disk, and nothing may be written (NO_WRITE)" };
  const listed = await listVideos(url, { limit: opts.limit, deps: opts.deps, signal: opts.signal, knownHostsOnly: opts.knownHostsOnly });
  if ("error" in listed) return { ok: false, reason: listed.error };
  if (!listed.videos.length) return { ok: false, reason: `no videos listed at ${url}` };
  let done = 0;
  const videos = await mapLimit(listed.videos, CORPUS_CONCURRENCY, async (v, i) => {
    const r = await fetchVideoRun(v.url, root, { ...opts });
    opts.onVideo?.(++done, listed.videos.length, r.ok ? r.meta.title : v.title);
    const base2 = {
      label: `V${i + 1}`,
      id: r.ok ? r.id : v.key ?? v.id,
      title: r.ok ? r.meta.title : v.title,
      ...v.duration !== void 0 ? { duration: v.duration } : {}
    };
    return r.ok ? { ...base2, ...r.meta.duration !== void 0 ? { duration: r.meta.duration } : {}, via: r.meta.via, dir: r.dir, reused: r.reused } : { ...base2, reason: r.reason };
  });
  const corpus = { source: url, ...listed.title ? { title: listed.title } : {}, createdAt: (/* @__PURE__ */ new Date()).toISOString(), videos };
  let path;
  try {
    ensureDir(root);
    writeArtifact(join12(root, "corpus.json"), `${JSON.stringify(corpus, null, 2)}
`);
    path = writeArtifact(join12(root, "CORPUS.md"), corpusMarkdown(corpus, root));
  } catch (e) {
    return { ok: false, reason: `cannot write the corpus in ${root}: ${e.message}` };
  }
  return { ok: true, dir: root, corpus: path, videos, ...listed.title ? { title: listed.title } : {} };
}
var LIST_TIMEOUT_MS, DEFAULT_LIMIT, CORPUS_CONCURRENCY;
var init_list = __esm({
  "src/video/list.ts"() {
    "use strict";
    init_no_write();
    init_pool();
    init_ladder3();
    init_markdown();
    init_run();
    init_url2();
    init_ytdlp();
    LIST_TIMEOUT_MS = 12e4;
    DEFAULT_LIMIT = 10;
    CORPUS_CONCURRENCY = 2;
  }
});

// src/video.ts
var init_video = __esm({
  "src/video.ts"() {
    "use strict";
    init_url2();
    init_ytdlp();
    init_vtt();
    init_whisper();
    init_ladder3();
    init_markdown();
    init_run();
    init_frames();
    init_list();
  }
});

// src/entities.ts
function numericChar(n) {
  if (n >= 128 && n <= 159) return String.fromCodePoint(CP1252_C1[n - 128]);
  if (n === 0 || !(n <= 1114111) || n >= 55296 && n <= 57343) return "\uFFFD";
  return charFor(n);
}
function decodeEntities(s) {
  return s.replace(ENTITY_RE, (m, ref2) => {
    if (ref2[0] !== "#") return ENTITY_BY_NAME.get(ref2) ?? m;
    return numericChar(ref2[1] === "x" || ref2[1] === "X" ? Number.parseInt(ref2.slice(2), 16) : Number(ref2.slice(1)));
  });
}
var NAMED, INVISIBLE, charFor, ENTITY_BY_NAME, ENTITY_RE;
var init_entities = __esm({
  "src/entities.ts"() {
    "use strict";
    init_charset();
    NAMED = `
  quot 22 amp 26 apos 27 lt 3c gt 3e QUOT 22 AMP 26 LT 3c GT 3e COPY a9 REG ae
  nbsp a0 iexcl a1 cent a2 pound a3 curren a4 yen a5 brvbar a6 sect a7 uml a8 copy a9 ordf aa laquo ab not ac shy ad reg ae macr af
  deg b0 plusmn b1 sup2 b2 sup3 b3 acute b4 micro b5 para b6 middot b7 cedil b8 sup1 b9 ordm ba raquo bb frac14 bc frac12 bd frac34 be iquest bf
  Agrave c0 Aacute c1 Acirc c2 Atilde c3 Auml c4 Aring c5 AElig c6 Ccedil c7 Egrave c8 Eacute c9 Ecirc ca Euml cb Igrave cc Iacute cd Icirc ce Iuml cf
  ETH d0 Ntilde d1 Ograve d2 Oacute d3 Ocirc d4 Otilde d5 Ouml d6 times d7 Oslash d8 Ugrave d9 Uacute da Ucirc db Uuml dc Yacute dd THORN de szlig df
  agrave e0 aacute e1 acirc e2 atilde e3 auml e4 aring e5 aelig e6 ccedil e7 egrave e8 eacute e9 ecirc ea euml eb igrave ec iacute ed icirc ee iuml ef
  eth f0 ntilde f1 ograve f2 oacute f3 ocirc f4 otilde f5 ouml f6 divide f7 oslash f8 ugrave f9 uacute fa ucirc fb uuml fc yacute fd thorn fe yuml ff
  OElig 152 oelig 153 Scaron 160 scaron 161 Yuml 178 fnof 192 circ 2c6 tilde 2dc
  Alpha 391 Beta 392 Gamma 393 Delta 394 Epsilon 395 Zeta 396 Eta 397 Theta 398 Iota 399 Kappa 39a Lambda 39b Mu 39c Nu 39d Xi 39e Omicron 39f
  Pi 3a0 Rho 3a1 Sigma 3a3 Tau 3a4 Upsilon 3a5 Phi 3a6 Chi 3a7 Psi 3a8 Omega 3a9
  alpha 3b1 beta 3b2 gamma 3b3 delta 3b4 epsilon 3b5 zeta 3b6 eta 3b7 theta 3b8 iota 3b9 kappa 3ba lambda 3bb mu 3bc nu 3bd xi 3be omicron 3bf
  pi 3c0 rho 3c1 sigmaf 3c2 sigma 3c3 tau 3c4 upsilon 3c5 phi 3c6 chi 3c7 psi 3c8 omega 3c9 thetasym 3d1 upsih 3d2 piv 3d6
  ensp 2002 emsp 2003 thinsp 2009 zwnj 200c zwj 200d lrm 200e rlm 200f ndash 2013 mdash 2014 lsquo 2018 rsquo 2019 sbquo 201a
  ldquo 201c rdquo 201d bdquo 201e dagger 2020 Dagger 2021 bull 2022 hellip 2026 permil 2030 prime 2032 Prime 2033 lsaquo 2039 rsaquo 203a
  oline 203e frasl 2044 euro 20ac image 2111 weierp 2118 real 211c trade 2122 alefsym 2135
  larr 2190 uarr 2191 rarr 2192 darr 2193 harr 2194 crarr 21b5 lArr 21d0 uArr 21d1 rArr 21d2 dArr 21d3 hArr 21d4
  forall 2200 part 2202 exist 2203 empty 2205 nabla 2207 isin 2208 notin 2209 ni 220b prod 220f sum 2211 minus 2212 lowast 2217 radic 221a
  prop 221d infin 221e ang 2220 and 2227 or 2228 cap 2229 cup 222a int 222b there4 2234 sim 223c cong 2245 asymp 2248 ne 2260 equiv 2261
  le 2264 ge 2265 sub 2282 sup 2283 nsub 2284 sube 2286 supe 2287 oplus 2295 otimes 2297 perp 22a5 sdot 22c5
  lceil 2308 rceil 2309 lfloor 230a rfloor 230b lang 27e8 rang 27e9 loz 25ca spades 2660 clubs 2663 hearts 2665 diams 2666
`;
    INVISIBLE = /* @__PURE__ */ new Set([173, 8203, 8204, 8205, 8206, 8207, 8288, 65279]);
    charFor = (cp) => INVISIBLE.has(cp) ? "" : String.fromCodePoint(cp);
    ENTITY_BY_NAME = /* @__PURE__ */ new Map();
    {
      const parts = NAMED.trim().split(/\s+/);
      for (let i = 0; i < parts.length; i += 2) ENTITY_BY_NAME.set(parts[i], charFor(Number.parseInt(parts[i + 1], 16)));
      ENTITY_BY_NAME.set("nbsp", " ");
    }
    ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;
  }
});

// src/html.ts
function closeTagRe(name2) {
  let re = CLOSE_TAG_RE.get(name2);
  if (!re) CLOSE_TAG_RE.set(name2, re = new RegExp(`</${name2}\\s*>`, "gi"));
  return re;
}
function htmlAttributes(tag) {
  const attrs = /* @__PURE__ */ new Map();
  for (const m of tag.matchAll(/(?<![^\s"'<>/=])([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name2 = m[1].toLowerCase();
    if (!attrs.has(name2)) attrs.set(name2, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}
function dropElements(html, names, toEof = /* @__PURE__ */ new Set()) {
  const drop = new Set(names);
  const open2 = new RegExp(`<!--|${TAG_RE.source}|<(${names.join("|")})(?=[\\s/>])`, "gi");
  const unclosed = /* @__PURE__ */ new Set();
  let out = "";
  let last = 0;
  let m;
  while (m = open2.exec(html)) {
    const tag = m[0];
    const name2 = m[1]?.toLowerCase() ?? (tag === "<!--" ? "!--" : tag[1] === "/" ? "" : tagName(tag));
    const opaque = !drop.has(name2) && RCDATA_ELEMENTS.has(name2);
    if (name2 !== "!--" && !drop.has(name2) && !opaque || unclosed.has(name2)) continue;
    let end;
    if (name2 === "!--") {
      const close = html.indexOf("-->", m.index + 2);
      end = close < 0 ? -1 : close + 3;
    } else {
      const close = closeTagRe(name2);
      close.lastIndex = open2.lastIndex;
      const c = close.exec(html);
      end = c ? c.index + c[0].length : toEof.has(name2) ? html.length : -1;
    }
    if (end < 0) {
      unclosed.add(name2);
      continue;
    }
    if (!opaque) {
      out += html.slice(last, m.index) + " ";
      last = end;
    }
    open2.lastIndex = end;
  }
  return last === 0 ? html : out + html.slice(last);
}
function balancedRegions(html, tag, isCandidate) {
  const re = new RegExp(`<${tag}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>|</${tag}\\s*>`, "gi");
  const stack = [];
  const out = [];
  let m;
  while (m = re.exec(html)) {
    if (m[0][1] === "/") {
      const top = stack.pop();
      if (top?.open) out.push({ start: top.start, end: m.index, from: top.from, to: re.lastIndex, open: top.open });
    } else {
      stack.push({ start: re.lastIndex, from: m.index, open: isCandidate(m[0]) ? m[0] : void 0 });
    }
  }
  return out;
}
function dropLandmarks(html, roles) {
  const role = `\\srole\\s*=\\s*["']?(?:${roles.join("|")})(?=["'\\s/>])`;
  const hasRole = new RegExp(role, "i");
  const names = /* @__PURE__ */ new Set();
  for (const m of html.matchAll(new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)(?=[\\s/>])[^<>]*${role}`, "gi"))) names.add(m[1].toLowerCase());
  if (!names.size) return html;
  const regions = [...names].flatMap((name2) => balancedRegions(html, name2, (open2) => hasRole.test(open2))).sort((a, b) => a.from - b.from);
  let out = "";
  let last = 0;
  for (const r of regions) {
    if (r.from < last) continue;
    out += `${html.slice(last, r.from)} `;
    last = r.to;
  }
  return last === 0 ? html : out + html.slice(last);
}
var BLOCK_TAGS, INLINE_TAGS, TAG_RE, LOOSE_TAG_RE, tagName, CLOSE_TAG_RE, RCDATA_ELEMENTS, CHROME_ROLES, HIDDEN_ELEMENTS, CHROME_ELEMENTS, RAW_TEXT_ELEMENTS;
var init_html = __esm({
  "src/html.ts"() {
    "use strict";
    BLOCK_TAGS = /* @__PURE__ */ new Set([
      "p",
      "div",
      "section",
      "article",
      "li",
      "tr",
      "td",
      "th",
      "ul",
      "ol",
      "pre",
      "blockquote",
      "table",
      "caption",
      "dl",
      "dt",
      "dd",
      "header",
      "footer",
      "nav",
      "aside",
      "main",
      "search",
      "figure",
      "figcaption",
      "details",
      "summary",
      "address",
      "form",
      "fieldset",
      "legend",
      "hgroup",
      "center",
      "dialog",
      "menu"
    ]);
    INLINE_TAGS = /* @__PURE__ */ new Set([
      "a",
      "abbr",
      "acronym",
      "b",
      "bdi",
      "bdo",
      "big",
      "cite",
      "code",
      "data",
      "del",
      "dfn",
      "em",
      "font",
      "i",
      "ins",
      "kbd",
      "label",
      "mark",
      "nobr",
      "q",
      "s",
      "samp",
      "small",
      "span",
      "strike",
      "strong",
      "sub",
      "sup",
      "time",
      "tt",
      "u",
      "var",
      "wbr"
    ]);
    TAG_RE = /<[a-zA-Z!/?][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
    LOOSE_TAG_RE = /<[a-zA-Z!/?][^<>]*>/g;
    tagName = (tag) => /^<\/?([a-zA-Z][^\s/>]*)/.exec(tag)?.[1]?.toLowerCase() ?? "";
    CLOSE_TAG_RE = /* @__PURE__ */ new Map();
    RCDATA_ELEMENTS = /* @__PURE__ */ new Set(["title"]);
    CHROME_ROLES = ["navigation", "banner", "contentinfo"];
    HIDDEN_ELEMENTS = ["script", "style", "noscript", "head", "svg", "template", "select", "datalist"];
    CHROME_ELEMENTS = ["nav", "footer"];
    RAW_TEXT_ELEMENTS = /* @__PURE__ */ new Set(["script", "style"]);
  }
});

// src/retry.ts
function retryDelayMs(retryAfterMs) {
  if (retryAfterMs === void 0) return defaultRetryMs();
  return retryAfterMs <= RETRY_AFTER_CAP_MS ? retryAfterMs : void 0;
}
function isPermanentFailure(e) {
  const err = e;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string" && PERMANENT_CODES.has(code)) return true;
  return [err?.message, err?.cause?.message].some((m) => typeof m === "string" && PERMANENT_MESSAGE.test(m));
}
var maxAttempts, defaultRetryMs, RETRY_AFTER_CAP_MS, PERMANENT_CODES, PERMANENT_MESSAGE;
var init_retry = __esm({
  "src/retry.ts"() {
    "use strict";
    init_brand();
    maxAttempts = () => envInt("MAX_ATTEMPTS", 2, 1, 5);
    defaultRetryMs = () => envInt("RETRY_MS", 600, 0, 5e3);
    RETRY_AFTER_CAP_MS = 5e3;
    PERMANENT_CODES = /* @__PURE__ */ new Set([
      "ENOTFOUND",
      "ERR_INVALID_URL",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
    ]);
    PERMANENT_MESSAGE = /redirect count exceeded|scheme must be|unknown scheme|bad port|invalid url|failed to parse url/i;
  }
});

// src/tables.ts
function fragmentText(html) {
  return decodeEntities(html.replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ").replace(LOOSE_TAG_RE, " "));
}
function spanAttr(attrs, name2) {
  const n = Number.parseInt(attrs.get(name2) ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : 1;
}
function expand(rows) {
  const grid = rows.map(() => []);
  let slots = 0;
  for (let r = 0; r < rows.length; r++) {
    const out = grid[r];
    let c = 0;
    for (const cell2 of rows[r]) {
      while (out[c] !== void 0) c++;
      const down = Math.min(cell2.rowspan, rows.length - r);
      slots += down * cell2.colspan;
      if (slots > MAX_SLOTS) return void 0;
      for (let j = 0; j < down; j++) for (let i = 0; i < cell2.colspan; i++) grid[r + j][c + i] = cell2.text;
      c += cell2.colspan;
    }
  }
  const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
  if (width * grid.length > MAX_SLOTS) return void 0;
  return grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
}
function extractTables(html) {
  const src = dropElements(html, NOT_RENDERED, RAW_TEXT_ELEMENTS);
  const tag = /<(\/?)(table|caption|thead|tbody|tfoot|tr|td|th)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const done = [];
  const stack = [];
  let order = 0;
  let last = 0;
  let buried = 0;
  let m;
  while (m = tag.exec(src)) {
    const top = stack[stack.length - 1];
    if (top) top.text(src.slice(last, m.index));
    last = tag.lastIndex;
    const closing = m[1] === "/";
    const name2 = m[2].toLowerCase();
    if (top && (buried || name2 === "table" && !closing && stack.length >= MAX_DEPTH)) {
      if (name2 === "table") buried += closing ? -1 : 1;
      top.text(" ");
      continue;
    }
    if (name2 === "table") {
      if (!closing) stack.push(new OpenTable(order++));
      else if (top) closeTable(stack, done);
      continue;
    }
    if (!top) continue;
    if (name2 === "td" || name2 === "th") {
      if (closing) top.endCell();
      else top.startCell(name2 === "th", htmlAttributes(m[0]));
    } else if (name2 === "tr") {
      top.endRow();
      if (!closing) top.startRow();
    } else if (name2 === "caption") {
      top.endRow();
      top.inCaption = !closing;
    } else {
      top.endRow();
      top.inHead = name2 === "thead" && !closing;
    }
  }
  while (stack.length) closeTable(stack, done);
  return done.sort((a, b) => a.order - b.order).map((d) => d.table);
}
function closeTable(stack, done) {
  const t = stack.pop();
  t.endRow();
  const caption = collapse(t.caption.join(""));
  const table = buildTable(t.rows, caption);
  if (table) done.push({ order: t.order, table });
  const flat2 = [caption, ...t.rows.flatMap((r) => r.cells.map((c) => c.text))].filter(Boolean).join(" ");
  stack[stack.length - 1]?.nested(flat2);
}
function buildTable(rows, caption) {
  if (!rows.length) return void 0;
  const grid = expand(rows.map((r) => r.cells));
  if (!grid) return void 0;
  let headers = [];
  let body = grid;
  if (rows.some((r) => r.head)) {
    const head = grid.filter((_, i) => rows[i].head);
    headers = head[0].map((_, c) => [...new Set(head.map((r) => r[c]).filter(Boolean))].join(" "));
    body = grid.filter((_, i) => !rows[i].head);
  } else if (isHeaderRow(rows[0].cells)) {
    headers = grid[0];
    body = grid.slice(1);
  }
  if (!body.length) return void 0;
  return { ...caption ? { caption } : {}, headers, rows: body };
}
function isHeaderRow(cells) {
  return cells.some((c) => c.header) && cells.every((c) => c.header || !c.text);
}
function tableToMarkdown(table) {
  const width = table.rows.reduce((w, r) => Math.max(w, r.length), Math.max(table.headers.length, 1));
  const esc = (s) => s.replace(/\|/g, "\\|");
  const line = (cells) => `| ${Array.from({ length: width }, (_, i) => esc(cells[i] ?? "")).join(" | ")} |`;
  const out = [];
  if (table.caption) out.push(`**${table.caption}**`, "");
  out.push(line(table.headers.length ? table.headers : Array.from({ length: width }, () => "")));
  out.push(`|${" --- |".repeat(width)}`);
  for (const row of table.rows) out.push(line(row));
  return out.join("\n");
}
var collapse, MAX_SLOTS, NOT_RENDERED, MAX_DEPTH, OpenTable;
var init_tables = __esm({
  "src/tables.ts"() {
    "use strict";
    init_entities();
    init_html();
    collapse = (s) => s.replace(/\s+/g, " ").trim();
    MAX_SLOTS = 1e6;
    NOT_RENDERED = ["script", "style", "template", "svg", "select", "datalist"];
    MAX_DEPTH = 8;
    OpenTable = class {
      constructor(order) {
        this.order = order;
      }
      order;
      rows = [];
      caption = [];
      inCaption = false;
      inHead = false;
      row;
      cell;
      /** Text between two table tags: it belongs to the open cell, else the caption. */
      text(fragment) {
        if (this.cell) this.cell.parts.push(fragmentText(fragment));
        else if (this.inCaption) this.caption.push(fragmentText(fragment));
      }
      /** A nested table's text, already clean, joins the cell that holds it. */
      nested(text) {
        this.cell?.parts.push(` ${text} `);
      }
      startRow() {
        this.inCaption = false;
        this.row = { cells: [], head: this.inHead };
      }
      startCell(header2, attrs) {
        this.endCell();
        if (!this.row) this.startRow();
        this.cell = { parts: [], header: header2, colspan: spanAttr(attrs, "colspan"), rowspan: spanAttr(attrs, "rowspan") };
      }
      endCell() {
        if (!this.cell || !this.row) return;
        const { parts, header: header2, colspan, rowspan } = this.cell;
        this.row.cells.push({ text: collapse(parts.join("")), header: header2, colspan, rowspan });
        this.cell = void 0;
      }
      endRow() {
        this.endCell();
        if (this.row?.cells.length) this.rows.push(this.row);
        this.row = void 0;
      }
    };
  }
});

// src/markdown.ts
function markdownAgainst(html, base2, fullPage) {
  const src = withoutNul(html);
  const hidden = fullPage ? HIDDEN_ELEMENTS : [...HIDDEN_ELEMENTS, ...CHROME_ELEMENTS];
  let s = dropElements(src, hidden, RAW_TEXT_ELEMENTS);
  if (!fullPage) s = dropLandmarks(s, CHROME_ROLES);
  const tables = /* @__PURE__ */ new Map();
  if (TABLE_OPEN.test(s)) for (const r of balancedRegions(s, "table", () => true)) tables.set(r.from, r);
  const w = new Writer();
  const tag = new RegExp(TAG_RE.source, "g");
  const headingEdge = new RegExp(HEADING_EDGE.source, "gi");
  let preUnclosed = false;
  let headingEnd = -1;
  const divs = [];
  let divOverflow = 0;
  let prevAEnd = -1;
  let last = 0;
  let m;
  while (m = tag.exec(s)) {
    if (m.index > last) w.text(s.slice(last, m.index));
    last = tag.lastIndex;
    const t = m[0];
    const closing = t[1] === "/";
    const name2 = tagName(t);
    const adjacentLinks = name2 === "a" && !closing && m.index === prevAEnd;
    prevAEnd = name2 === "a" && closing ? tag.lastIndex : -1;
    if (!name2) continue;
    if (name2 === "div") {
      if (closing) {
        if (divOverflow) divOverflow--;
        else divs.pop();
      } else if (divs.length < MAX_BLOCK_DEPTH * 4) divs.push(t);
      else divOverflow++;
    }
    const heading = /^h[1-6]$/.test(name2) ? Number(name2[1]) : 0;
    if (w.heading) {
      if (heading) {
        w.flush();
        headingEnd = -1;
        if (closing) continue;
      } else if (BLOCK_TAGS.has(name2) || name2 === "br" || name2 === "hr") {
        if (headingEnd >= 0 && m.index < headingEnd) {
          w.space();
          continue;
        }
        w.flush();
        headingEnd = -1;
      }
    }
    if (heading) {
      w.flush();
      if (closing) continue;
      w.heading = heading;
      headingEdge.lastIndex = tag.lastIndex;
      const edge = headingEdge.exec(s);
      headingEnd = edge && edge[0][1] === "/" ? edge.index : -1;
      continue;
    }
    if (name2 === "pre" && !closing && !preUnclosed) {
      const close = closeTagRe("pre");
      close.lastIndex = tag.lastIndex;
      const c = close.exec(s);
      if (c) {
        w.flush();
        w.codeBlock(s.slice(tag.lastIndex, c.index), codeLanguage(t, s.slice(tag.lastIndex, c.index), divs));
        last = tag.lastIndex = c.index + c[0].length;
        continue;
      }
      preUnclosed = true;
    }
    if (name2 === "table" && !closing) {
      const region = tables.get(m.index);
      const table = region && !isLayoutTable(t, s, region) ? extractTables(s.slice(region.from, region.to))[0] : void 0;
      if (region && table) {
        w.flush();
        const escaped = {
          ...table.caption ? { caption: escapeText(table.caption) } : {},
          headers: table.headers.map((cell2) => escapeText(cell2)),
          rows: table.rows.map((row) => row.map((cell2) => escapeText(cell2)))
        };
        w.block(tableToMarkdown(escaped).split("\n"));
        last = tag.lastIndex = region.to;
        continue;
      }
    }
    switch (name2) {
      case "ul":
      case "ol":
        w.flush();
        if (closing) w.closeList();
        else w.openList(name2 === "ol", listStart(t));
        continue;
      case "li":
        w.flush();
        if (closing) w.closeItem();
        else w.openItem();
        continue;
      case "blockquote":
        w.flush();
        if (closing) w.closeQuote();
        else w.openQuote();
        continue;
      case "hr":
        w.flush();
        w.rule();
        continue;
      case "br":
        w.hardBreak();
        continue;
      case "img":
        w.image(htmlAttributes(t), base2);
        continue;
    }
    const kind = INLINE_KIND[name2];
    if (kind) {
      if (closing) {
        w.close(kind);
        continue;
      }
      if (adjacentLinks) w.space();
      if (kind === "a") {
        w.close("a");
        const href = htmlAttributes(t).get("href");
        w.open("a", linkTarget(href, base2), href?.trimStart().startsWith("#"));
      } else w.open(kind);
      continue;
    }
    if (BLOCK_TAGS.has(name2)) w.flush();
    else if (!INLINE_TAGS.has(name2)) w.space();
  }
  if (last < s.length) w.text(s.slice(last));
  return w.finish();
}
function withoutNul(html) {
  return html.includes(NUL) ? html.split(NUL).join("\uFFFD") : html;
}
function flank(marker, core, start, end) {
  const link = core.includes("](");
  const movable = (i) => {
    const c = core[i];
    if (!(c === " " || FLANK_PUNCT.test(c)) || MARKUP_CHARS.includes(c) || core[i - 1] === "\\") return false;
    return c === "(" || c === ")" ? !link : !(c === "!" && core[i + 1] === "[");
  };
  let from = 0;
  let to = core.length;
  if (start) while (from < to && movable(from)) from++;
  if (end) while (to > from && movable(to - 1)) to--;
  if (from === to) return core;
  return `${core.slice(0, from)}${marker}${core.slice(from, to)}${marker}${core.slice(to)}`;
}
function wrapInline(f, core, inHeading) {
  switch (f.kind) {
    case "em":
      return `*${core}*`;
    case "strong":
      return `**${core}**`;
    case "code": {
      const code = core.replace(/\s+/g, " ");
      const ticks = "`".repeat(longestRun(code, "`") + 1);
      const pad = code[0] === "`" || code[code.length - 1] === "`" ? " " : "";
      return `${ticks}${pad}${code}${pad}${ticks}`;
    }
    default:
      if (inHeading && PERMALINK_TEXT.test(core)) return "";
      if (inHeading && f.self) return core;
      return `[${core.replace(/\n{2,}/g, "\n")}](${destination(f.href)})`;
  }
}
function escapeText(s, edges) {
  let out = s.replace(ALWAYS_SYNTAX, "\\$&").replace(EDGE_UNDERSCORE, "\\_").replace(HTML_LIKE, "\\<").replace(ENTITY_LIKE, "\\&").replace(STRIKE, "\\~");
  if (edges?.after) out = out.replace(OPEN_END, "\\$&");
  if (edges?.before && out[0] === "~") out = `\\${out}`;
  return out;
}
function escapeLineStart(line) {
  const c = line[0];
  if (c === "#") return /^#{1,6}(?:\s|$)/.test(line) ? `\\${line}` : line;
  if (c === ">") return `\\${line}`;
  if (c === "-" || c === "+" || c === "=") return /^[-+=](?:\s|$)/.test(line) || /^(?:[-=]\s*)+$/.test(line) ? `\\${line}` : line;
  const ordered = /^(\d{1,9})[.)](?=\s|$)/.exec(line);
  return ordered ? `${ordered[1]}\\${line.slice(ordered[1].length)}` : line;
}
function longestRun(s, ch) {
  let best = 0;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    run = s[i] === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}
function linkTarget(raw, base2) {
  const href = raw === void 0 ? "" : afterControls(decodeEntities(raw).replace(/[\t\n\r]/g, "")).trim();
  if (!href || UNFOLLOWABLE.test(href)) return void 0;
  try {
    const url = new URL(href, base2);
    return UNFOLLOWABLE.test(url.protocol) ? void 0 : url.href;
  } catch {
    return base2 === void 0 ? href : void 0;
  }
}
function afterControls(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) <= 32) i++;
  return s.slice(i);
}
function destination(url) {
  const d = url.replace(/[ <>\\]/g, (c) => encodeURIComponent(c));
  let depth = 0;
  for (const c of d) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) break;
  }
  return depth === 0 ? d : d.replace(/[()]/g, "\\$&");
}
function documentBaseUrl(html, pageUrl) {
  if (!/<base[\s/>]/i.test(html)) return pageUrl;
  for (const m of dropElements(html, ["script", "style", "template"], RAW_TEXT_ELEMENTS).matchAll(BASE_TAG)) {
    const href = htmlAttributes(m[0]).get("href");
    if (href === void 0) continue;
    try {
      const base2 = new URL(decodeEntities(href).trim(), pageUrl);
      return base2.protocol === "data:" || base2.protocol === "javascript:" ? pageUrl : base2.href;
    } catch {
      return pageUrl;
    }
  }
  return pageUrl;
}
function codeLanguage(pre, inner, divs) {
  const code = /^\s*(<code(?=[\s/>])[^<>]*>)/i.exec(inner)?.[1];
  for (const t of [pre, code, divs[divs.length - 1], divs[divs.length - 2]]) {
    if (!t) continue;
    const lang = LANGUAGE_CLASS.exec(htmlAttributes(t).get("class") ?? "")?.[1]?.toLowerCase();
    if (lang && !NO_LANGUAGE.has(lang)) return lang;
  }
  return "";
}
function isLayoutTable(open2, html, region) {
  if (/^(?:presentation|none)$/i.test(htmlAttributes(open2).get("role")?.trim() ?? "")) return true;
  const inner = new RegExp(LAYOUT_INSIDE.source, "gi");
  inner.lastIndex = region.start;
  const next = inner.exec(html);
  return next !== null && next.index < region.end;
}
function listStart(open2) {
  const n = Number.parseInt(htmlAttributes(open2).get("start") ?? "", 10);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : 1;
}
var NUL, TABLE_OPEN, HEADING_EDGE, MAX_BLOCK_DEPTH, MAX_INLINE_DEPTH, INLINE_KIND, Writer, FLANK_PUNCT, FLANK_WORD, MARKUP_CHARS, PERMALINK_TEXT, HTML_SPACE, ALWAYS_SYNTAX, EDGE_UNDERSCORE, HTML_LIKE, ENTITY_LIKE, STRIKE, OPEN_END, UNFOLLOWABLE, BASE_TAG, LANGUAGE_CLASS, NO_LANGUAGE, LAYOUT_INSIDE;
var init_markdown2 = __esm({
  "src/markdown.ts"() {
    "use strict";
    init_entities();
    init_html();
    init_tables();
    NUL = "\0";
    TABLE_OPEN = /<table[\s/>]/i;
    HEADING_EDGE = /<\/h[1-6]\s*>|<h[1-6](?=[\s/>])/;
    MAX_BLOCK_DEPTH = 24;
    MAX_INLINE_DEPTH = 16;
    INLINE_KIND = {
      a: "a",
      em: "em",
      i: "em",
      strong: "strong",
      b: "strong",
      code: "code",
      kbd: "code",
      samp: "code",
      tt: "code"
    };
    Writer = class {
      heading = 0;
      lines = [];
      blocks = [];
      blockOverflow = 0;
      parts = [];
      frames = [];
      pendingSpace = false;
      needBlank = false;
      /** The list closed last: its container's depth, its kind, and how many lines were written by then. */
      closedList;
      /** An emphasis just written that ends in punctuation, whose closing marker a letter pushed next would spoil. */
      flanked;
      text(raw) {
        const decoded = decodeEntities(raw.includes("<") ? raw.replace(LOOSE_TAG_RE, " ") : raw).replace(HTML_SPACE, " ");
        if (!decoded) return;
        const core = decoded.trim();
        if (decoded[0] === " ") this.space();
        if (core) this.push(this.inCode() ? core : escapeText(core, { before: this.joinsBefore(decoded[0] !== " "), after: decoded[decoded.length - 1] !== " " }));
        if (core && decoded[decoded.length - 1] === " ") this.space();
      }
      space() {
        if (this.parts.length) this.pendingSpace = true;
      }
      hardBreak() {
        if (this.heading || this.inCode()) this.space();
        else if (this.parts.length) {
          this.parts.push("\n");
          this.pendingSpace = false;
        }
      }
      open(kind, href, self) {
        if (this.frames.length >= MAX_INLINE_DEPTH) return;
        const inert = kind === "a" && href === void 0 || this.inCode() || kind !== "a" && this.frames.some((f) => f.kind === kind);
        this.frames.push({ kind, start: this.parts.length, ...href !== void 0 ? { href } : {}, ...self ? { self } : {}, ...inert ? { inert } : {} });
      }
      /** Close the innermost open `kind`, and whatever opened inside it and never closed. */
      close(kind) {
        let i = this.frames.length - 1;
        while (i >= 0 && this.frames[i].kind !== kind) i--;
        if (i < 0) return;
        while (this.frames.length > i) this.wrap(this.frames.pop());
      }
      image(attrs, base2) {
        const candidates2 = [attrs.get("src"), attrs.get("data-src"), attrs.get("data-original"), attrs.get("srcset")?.trim().split(/\s+/)[0]];
        const src = candidates2.map((c) => linkTarget(c, base2)).find((u) => u !== void 0);
        const pixel = ["width", "height"].some((d) => /^[01]$/.test(attrs.get(d)?.trim() ?? ""));
        if (!src || pixel || this.inCode()) {
          this.space();
          return;
        }
        const alt = decodeEntities(attrs.get("alt") ?? "").replace(HTML_SPACE, " ").trim();
        this.push(`![${escapeText(alt)}](${destination(src)})`);
      }
      codeBlock(inner, lang) {
        const body = decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(LOOSE_TAG_RE, "")).replace(/\r\n?/g, "\n").replace(/^\n/, "").trimEnd();
        if (!body.trim()) return;
        const fence = "`".repeat(Math.max(3, longestRun(body, "`") + 1));
        this.block([fence + lang, ...body.split("\n"), fence]);
      }
      rule() {
        this.block(["***"]);
      }
      openList(ordered, start) {
        const top = this.blocks[this.blocks.length - 1];
        if (top?.kind === "list" && top.items && this.blocks.length + 1 < MAX_BLOCK_DEPTH) this.blocks.push({ kind: "item", marker: top.last, first: false });
        if (!this.room()) return;
        const item = this.blocks[this.blocks.length - 1];
        if (item?.kind === "item" && !item.first && (!ordered || start === 1)) this.needBlank = false;
        const prev = this.closedList;
        const alt = prev !== void 0 && prev.depth === this.blocks.length && prev.ordered === ordered && prev.lines === this.lines.length && !prev.alt;
        this.blocks.push({ kind: "list", ordered, alt, next: start, items: 0, last: "" });
      }
      closeList() {
        if (this.blockOverflow) {
          this.blockOverflow--;
          return;
        }
        const i = this.nearest("list");
        if (i < 0) return;
        const { ordered, alt } = this.blocks[i];
        this.closedList = { depth: i, ordered, alt, lines: this.lines.length };
        this.blocks.length = i;
        this.needBlank = true;
      }
      openItem() {
        if (this.blockOverflow) {
          this.blockOverflow++;
          return;
        }
        let list = this.nearest("list");
        if (list >= 0) this.blocks.length = list + 1;
        else {
          if (!this.room()) return;
          this.blocks.push({ kind: "list", ordered: false, alt: false, next: 1, items: 0, last: "" });
          list = this.blocks.length - 1;
        }
        if (!this.room()) return;
        const owner = this.blocks[list];
        const marker = owner.ordered ? `${owner.next++}${owner.alt ? ")" : "."} ` : owner.alt ? "+ " : "- ";
        owner.last = marker;
        this.blocks.push({ kind: "item", marker, first: true });
        if (owner.items++) this.needBlank = false;
      }
      closeItem() {
        if (this.blockOverflow) {
          this.blockOverflow--;
          return;
        }
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const kind = this.blocks[i].kind;
          if (kind === "list") return;
          if (kind === "item") {
            this.blocks.length = i;
            return;
          }
        }
      }
      openQuote() {
        if (this.room()) this.blocks.push({ kind: "quote", first: true });
      }
      closeQuote() {
        if (this.blockOverflow) {
          this.blockOverflow--;
          return;
        }
        const i = this.nearest("quote");
        if (i < 0) return;
        this.blocks.length = i;
        this.needBlank = true;
      }
      /**
       * End the paragraph or heading in progress and write it out. The inline
       * elements still open close over the text so far and reopen for what
       * follows, so a link wrapped round a heading and a paragraph — a card —
       * links both.
       */
      flush() {
        const open2 = this.frames.map((f) => ({ ...f }));
        while (this.frames.length) this.wrap(this.frames.pop());
        const text = this.parts.join("");
        this.parts = [];
        this.flanked = void 0;
        this.pendingSpace = false;
        this.frames = open2.map((f) => ({ ...f, start: 0 }));
        const level = this.heading;
        this.heading = 0;
        if (level) {
          const title = text.replace(/\s+/g, " ").trim();
          if (title) this.block([`${"#".repeat(level)} ${title.replace(/(^|\s)(#+)$/, "$1\\$2")}`]);
          return;
        }
        let para = [];
        for (const raw of `${text}

`.split("\n")) {
          const line = raw.trim();
          if (line) {
            para.push(escapeLineStart(line));
            continue;
          }
          if (!para.length) continue;
          this.block(para.map((l, i) => i < para.length - 1 ? `${l}  ` : l));
          para = [];
        }
      }
      /** Write finished lines under the open blocks' prefixes, a blank line before them where one is due. */
      block(content) {
        if (!content.length) return;
        if (this.needBlank && this.lines.length) this.lines.push(this.prefix(false).trimEnd());
        for (const line of content) {
          const prefix = this.prefix(true);
          this.lines.push(line ? prefix + line : prefix.trimEnd());
        }
        this.needBlank = true;
      }
      finish() {
        this.flush();
        return this.lines.join("\n").trimEnd();
      }
      push(markdown) {
        const f = this.flanked;
        this.flanked = void 0;
        if (f && !this.pendingSpace && f.at === this.parts.length - 1 && FLANK_WORD.test(markdown[0] ?? "")) {
          this.parts[f.at] = flank(f.marker, f.core, f.start, true);
        }
        if (this.pendingSpace) this.parts.push(" ");
        this.pendingSpace = false;
        this.parts.push(markdown);
      }
      inCode() {
        return this.frames.some((f) => f.kind === "code");
      }
      /**
       * Whether text pushed next will stand straight after something other than
       * a space or a line start: the text before it, when `touching` it, or the
       * marker of an emphasis or link that opens where it starts (the marker goes
       * in when the element closes, and moves the element's leading space outside).
       */
      joinsBefore(touching) {
        const last = this.parts[this.parts.length - 1];
        if (touching && !this.pendingSpace && last !== void 0 && last !== "\n") return true;
        return this.frames.some((f) => !f.inert && f.start === this.parts.length);
      }
      /** Replace an element's text with its Markdown, its outer whitespace kept outside it. */
      wrap(f) {
        if (f.inert) return;
        const trailing = this.pendingSpace;
        this.pendingSpace = false;
        if (this.flanked && this.flanked.at >= f.start) this.flanked = void 0;
        const content = this.parts.splice(f.start).join("");
        const core = content.trim();
        const lead = content.slice(0, content.length - content.trimStart().length);
        const trail = content.slice(content.trimEnd().length);
        this.whitespace(lead);
        if (core) {
          let markdown = wrapInline(f, core, this.heading > 0);
          const last = this.parts.length - 1;
          if (f.kind === "a" && markdown && !this.pendingSpace && this.parts[last]?.endsWith("!")) this.parts[last] = `${this.parts[last].slice(0, -1)}\\!`;
          const marker = f.kind === "em" ? "*" : f.kind === "strong" ? "**" : "";
          if (marker) {
            const start = !this.pendingSpace && FLANK_WORD.test(this.parts[last]?.slice(-1) ?? "") && FLANK_PUNCT.test(core[0]);
            if (start) markdown = flank(marker, core, true, false);
            this.push(markdown);
            if (FLANK_PUNCT.test(core[core.length - 1])) this.flanked = { at: this.parts.length - 1, marker, core, start };
          } else this.push(markdown);
        }
        this.whitespace(trail);
        if (trailing) this.space();
      }
      whitespace(ws) {
        if (ws.includes("\n")) {
          if (this.parts.length) this.parts.push("\n");
          this.pendingSpace = false;
        } else if (ws) this.space();
      }
      prefix(consume) {
        let p = "";
        for (const b of this.blocks) {
          if (b.kind === "quote") {
            if (consume || !b.first) p += "> ";
            if (consume) b.first = false;
          } else if (b.kind === "item") {
            p += b.first && consume ? b.marker : " ".repeat(b.marker.length);
            if (consume) b.first = false;
          }
        }
        return p;
      }
      nearest(kind) {
        for (let i = this.blocks.length - 1; i >= 0; i--) if (this.blocks[i].kind === kind) return i;
        return -1;
      }
      /** Whether one more block may nest; past the bound it is counted instead, and its close uncounted. */
      room() {
        if (this.blocks.length < MAX_BLOCK_DEPTH) return true;
        this.blockOverflow++;
        return false;
      }
    };
    FLANK_PUNCT = /[\p{P}\p{S}]/u;
    FLANK_WORD = /[^\s\p{P}\p{S}]/u;
    MARKUP_CHARS = "\\*`[]";
    PERMALINK_TEXT = /^(?:¶|#|§|🔗)$/u;
    HTML_SPACE = /[ \t\n\r\f]+/g;
    ALWAYS_SYNTAX = /[\\`*[\]]/g;
    EDGE_UNDERSCORE = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;
    HTML_LIKE = /<(?=[a-zA-Z/!?])/g;
    ENTITY_LIKE = /&(?=#?[a-zA-Z0-9]+;)/g;
    STRIKE = /~(?=~)|(?<=[^\t\n\f\r\p{Zs}])~/gu;
    OPEN_END = /(?:<|&#?[a-zA-Z0-9]*)$/;
    UNFOLLOWABLE = /^(?:javascript|vbscript|data):/i;
    BASE_TAG = /<base(?=[\s/>])[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/gi;
    LANGUAGE_CLASS = /(?:^|\s)(?:(?:language|lang|highlight(?:-source)?)-|brush:\s*)([\w+#.-]+)/i;
    NO_LANGUAGE = /* @__PURE__ */ new Set(["none", "nohighlight", "plaintext"]);
    LAYOUT_INSIDE = /<(?:table|pre)[\s/>]/;
  }
});

// src/locale.ts
function parseTag(tag) {
  const parts = (tag || "en").trim().replace(/[.@].*$/, "").split(/[-_]/);
  const lang = (parts[0] || "en").toLowerCase();
  let i = 1;
  const script = /^[a-z]{4}$/i.test(parts[i] ?? "") ? parts[i++].toLowerCase() : void 0;
  const region = /^(?:[a-z]{2}|\d{3})$/i.test(parts[i] ?? "") ? parts[i].toLowerCase() : void 0;
  return { lang, script, region };
}
function baseLang3(lang) {
  return parseTag(lang).lang;
}
function resolveRegion(lang, region) {
  if (region?.trim()) return region.trim().toLowerCase();
  const t = parseTag(lang);
  if (t.region) return t.region;
  const byScript = t.script ? SCRIPT_COUNTRY[`${t.lang}-${t.script}`] : void 0;
  return byScript ?? LANG_COUNTRY[t.lang] ?? t.lang;
}
function ddgRegion(lang, region) {
  const r = resolveRegion(lang, region);
  if (r === NO_REGION) return "wt-wt";
  const l = baseLang3(lang);
  return DDG_KL[`${l}-${r}`] ?? DDG_KL[l] ?? `${REGION_ALIASES[r] ?? r}-${DDG_LANG_ALIASES[l] ?? l}`;
}
function searxngLanguage(lang, region) {
  if (!lang?.trim()) return void 0;
  const t = parseTag(lang);
  if (!/^[a-z]{2,3}$/.test(t.lang)) return void 0;
  const country = region?.trim() ? region.trim().toLowerCase() : t.region ?? (t.script ? SCRIPT_COUNTRY[`${t.lang}-${t.script}`] : void 0);
  return country && /^[a-z]{2}$/.test(country) && country !== NO_REGION ? `${t.lang}-${country.toUpperCase()}` : t.lang;
}
function acceptLanguageHeader(lang, region) {
  const l = baseLang3(lang);
  const r = resolveRegion(lang, region);
  if (r === NO_REGION) return l === "en" ? "en" : `${l},en;q=0.5`;
  const R = r.toUpperCase();
  if (l === "en") return `${l}-${R},${l};q=0.9`;
  return `${l}-${R},${l};q=0.9,en;q=0.5`;
}
var LANG_COUNTRY, SCRIPT_COUNTRY, REGION_ALIASES, DDG_LANG_ALIASES, DDG_KL, NO_REGION;
var init_locale = __esm({
  "src/locale.ts"() {
    "use strict";
    LANG_COUNTRY = {
      en: "us",
      pt: "br",
      ja: "jp",
      zh: "cn",
      ko: "kr",
      sv: "se",
      da: "dk",
      cs: "cz",
      el: "gr",
      nb: "no",
      // Bokmål → Norway
      nn: "no",
      // Nynorsk → Norway
      uk: "ua",
      // Ukrainian language → Ukraine
      ar: "sa",
      he: "il",
      hi: "in",
      et: "ee",
      vi: "vn",
      ms: "my",
      fa: "ir",
      ca: "es",
      sl: "si",
      sr: "rs",
      tl: "ph",
      fil: "ph",
      ga: "ie",
      cy: "gb",
      eu: "es",
      gl: "es",
      sq: "al",
      bs: "ba",
      be: "by",
      ka: "ge",
      hy: "am",
      kk: "kz",
      af: "za",
      sw: "ke",
      ur: "pk",
      bn: "bd",
      ta: "in",
      te: "in",
      mr: "in",
      ne: "np",
      si: "lk",
      km: "kh",
      lo: "la",
      lb: "lu"
    };
    SCRIPT_COUNTRY = {
      "zh-hant": "tw",
      "zh-hans": "cn"
    };
    REGION_ALIASES = {
      gb: "uk",
      en: "us",
      "419": "xl",
      si: "sl"
    };
    DDG_LANG_ALIASES = {
      nb: "no",
      // Bokmål
      nn: "no",
      // Nynorsk
      ja: "jp",
      ko: "kr",
      fil: "tl"
    };
    DDG_KL = {
      ar: "xa-ar",
      ca: "ct-ca",
      "zh-tw": "tw-tzh",
      "zh-hk": "hk-tzh",
      "es-us": "ue-es"
    };
    NO_REGION = "wt";
  }
});

// src/firecrawl.ts
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
function markFirecrawlDown(base2) {
  for (const explicit of [true, false]) probeCache.markDown(`${base2}|${explicit}`);
}
function looksLikeFirecrawl(contentType, body) {
  if (/firecrawl/i.test(body.slice(0, 4096))) return true;
  return !/^\s*text\/html/i.test(contentType ?? "");
}
function probeFirecrawl(base2, explicit = false) {
  return probeCache.get(`${base2}|${explicit}`, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS2);
    try {
      const res = await fetch(`${base2}/`, { signal: ctrl.signal });
      const body = await res.text().catch(() => "");
      return explicit || looksLikeFirecrawl(res.headers.get("content-type"), body);
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  });
}
function apiPrefix(base2) {
  return prefixCache.get(base2) ?? "/v2";
}
async function postJson(base2, path, body, opts) {
  const req = { timeoutMs: opts.timeoutMs, retries: opts.retries, headers: authHeaders() };
  const prefix = apiPrefix(base2);
  const first = await httpJson("POST", `${base2}${prefix}${path}`, body(prefix), req);
  if (first.status !== 404 || prefix !== "/v2") return first;
  prefixCache.set(base2, "/v1");
  return httpJson("POST", `${base2}/v1${path}`, body("/v1"), req);
}
function serverReason(data) {
  const raw = typeof data === "string" ? data : typeof data?.error === "string" ? data.error : "";
  const line = cleanInline(raw).slice(0, 200);
  return line || void 0;
}
function mapScrapeResponse(json2) {
  if (!json2 || typeof json2 !== "object" || Array.isArray(json2)) return null;
  if (json2.success === false) return null;
  const data = json2.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const markdown = typeof data.markdown === "string" ? data.markdown.trim() : "";
  if (!markdown) return null;
  const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const rawTitle = typeof meta.title === "string" ? cleanInline(meta.title) : "";
  const asked = typeof meta.sourceURL === "string" && meta.sourceURL ? meta.sourceURL : void 0;
  const landed = typeof meta.url === "string" && meta.url ? meta.url : void 0;
  const src = asked ?? landed;
  const final = landed ?? asked;
  const status = typeof meta.statusCode === "number" ? meta.statusCode : void 0;
  return {
    markdown,
    ...rawTitle ? { title: rawTitle } : {},
    ...src ? { sourceURL: src } : {},
    ...final ? { finalUrl: final } : {},
    ...status !== void 0 ? { statusCode: status } : {}
  };
}
function mapSearchResponse(json2) {
  if (!json2 || typeof json2 !== "object") return [];
  if (json2.success === false) return [];
  const data = json2.data;
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
  const base2 = firecrawlBase(opts);
  if (!base2) return {};
  if (!await probeFirecrawl(base2, firecrawlIsExplicit(opts))) {
    return firecrawlIsExplicit(opts) ? { why: `Firecrawl not reachable at ${base2} \u2014 used the built-in extractor.` } : {};
  }
  const r = await postJson(
    base2,
    "/scrape",
    () => ({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      blockAds: true,
      removeBase64Images: true,
      maxAge: SCRAPE_MAX_AGE_MS,
      timeout: SCRAPE_TIMEOUT_MS - SERVER_MARGIN_MS.scrape
    }),
    // No retry: the built-in extractor is the fallback, and a second attempt
    // at a browser render that just failed doubles the wait for nothing.
    { timeoutMs: SCRAPE_TIMEOUT_MS, retries: 0 }
  );
  if (!r.ok) {
    if (!r.status) markFirecrawlDown(base2);
    const why = r.status ? `status ${r.status}` : r.error ?? "no response";
    return { why: `Firecrawl could not scrape ${url} (${why}) \u2014 fell back to the built-in extractor.` };
  }
  const data = mapScrapeResponse(r.data);
  if (!data) return { why: `Firecrawl returned no markdown for ${url} \u2014 fell back to the built-in extractor.` };
  return { data };
}
async function searchViaFirecrawl(query, limit, opts = {}) {
  const base2 = firecrawlBase(opts);
  if (!base2) return { why: `Firecrawl disabled (--firecrawl off / ${envName("FIRECRAWL")}=off). Skipping.` };
  if (!await probeFirecrawl(base2, firecrawlIsExplicit(opts))) {
    return { why: `Firecrawl not reachable at ${base2} (bring it up with \`${brand().cli} firecrawl up\`). Skipping.`, status: 0 };
  }
  const n = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 10;
  const locale = {};
  if (opts.lang || opts.region) {
    if (opts.lang) locale.lang = baseLang3(opts.lang);
    const country = resolveRegion(opts.lang, opts.region);
    if (/^[a-z]{2}$/.test(country) && country !== "wt") locale.country = country;
  }
  const timeoutMs = Math.max(1, Math.round(Math.min(SEARCH_TIMEOUT_MS, opts.budgetMs ?? SEARCH_TIMEOUT_MS)));
  const r = await postJson(
    base2,
    "/search",
    // `sources` is v2's; v1's strict schema rejects any key it does not know.
    // `timeout` tells Firecrawl to stop just before we do: its own default is
    // 60 s, double the time this client waits.
    (prefix) => ({
      query,
      limit: n,
      ...locale,
      timeout: Math.max(1e3, timeoutMs - SERVER_MARGIN_MS.search),
      ...prefix === "/v2" ? { sources: ["web"] } : {}
    }),
    // No retry: this is the cascade's last rung, and a second attempt at an
    // instance that just failed or throttled us doubles the wait for nothing.
    { timeoutMs, retries: 0 }
  );
  if (!r.ok) {
    const budgetRanOut = r.timedOut === true && timeoutMs < SEARCH_TIMEOUT_MS;
    if (!r.status && !budgetRanOut) markFirecrawlDown(base2);
    const reason = serverReason(r.data);
    const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : !r.status ? `unreachable (${r.error ?? "no response"})` : (
      // It answered: a 4xx is this request refused (a bad field, a key a
      // Cloud base wants), which "unreachable" misreported as an outage.
      `${r.status < 500 ? "rejected the request" : "failed"} (HTTP ${r.status}${reason ? `: ${reason}` : ""})`
    );
    return { why: `Firecrawl search ${why} at ${base2}.`, status: r.status };
  }
  if (r.data?.success === false) {
    return { why: `Firecrawl search failed at ${base2}${serverReason(r.data) ? `: ${serverReason(r.data)}` : ""}.`, status: r.status };
  }
  return { hits: mapSearchResponse(r.data) };
}
var FIRECRAWL_DEFAULT_BASE, PROBE_TIMEOUT_MS2, SCRAPE_TIMEOUT_MS, SEARCH_TIMEOUT_MS, SERVER_MARGIN_MS, SCRAPE_MAX_AGE_MS, PROBE_DOWN_TTL_MS, ProbeMemo, probeCache, prefixCache;
var init_firecrawl = __esm({
  "src/firecrawl.ts"() {
    "use strict";
    init_brand();
    init_fetch();
    init_locale();
    FIRECRAWL_DEFAULT_BASE = "http://localhost:3002";
    PROBE_TIMEOUT_MS2 = 2e3;
    SCRAPE_TIMEOUT_MS = 45e3;
    SEARCH_TIMEOUT_MS = 3e4;
    SERVER_MARGIN_MS = { scrape: 5e3, search: 2e3 };
    SCRAPE_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
    PROBE_DOWN_TTL_MS = 3e4;
    ProbeMemo = class {
      entries = /* @__PURE__ */ new Map();
      /** The verdict for `key`, probing when there is none or a "down" one expired. */
      get(key, probe) {
        const hit = this.entries.get(key);
        if (hit && (hit.downAt === void 0 || Date.now() - hit.downAt < PROBE_DOWN_TTL_MS)) return hit.verdict;
        const entry = { verdict: probe() };
        void entry.verdict.then((up) => {
          if (!up) entry.downAt = Date.now();
        });
        this.entries.set(key, entry);
        return entry.verdict;
      }
      markDown(key) {
        this.entries.set(key, { verdict: Promise.resolve(false), downAt: Date.now() });
      }
      clear() {
        this.entries.clear();
      }
    };
    probeCache = new ProbeMemo();
    prefixCache = /* @__PURE__ */ new Map();
  }
});

// src/junk.ts
function looksLikeJunkExtraction(text) {
  const t = text.trim();
  if (t.length >= 2e3) return void 0;
  const head = t.slice(0, 800);
  const hits = JUNK_PATTERNS.filter(([re]) => re.test(head));
  const strong = hits.find(([, , kind]) => kind === "strong");
  if (!strong) return void 0;
  if (hits.length >= 2) return strong[1];
  const prose = t.split("\n").filter((l) => l.trim().length >= 60 && !JUNK_PATTERNS.some(([re]) => re.test(l))).length;
  return prose < 3 ? strong[1] : void 0;
}
var JUNK_PATTERNS;
var init_junk = __esm({
  "src/junk.ts"() {
    "use strict";
    JUNK_PATTERNS = [
      [/\b(accept|manage)\s+(all\s+)?cookies\b/i, "cookie/consent wall", "strong"],
      [/\bwe use cookies\b/i, "cookie/consent wall", "strong"],
      [/\bcookie (policy|settings|consent|preferences)\b/i, "cookie/consent wall", "weak"],
      [/\b(accept|reject|allow|decline) all\b/i, "cookie/consent wall", "weak"],
      [/\b(please )?enable javascript\b/i, "JavaScript-required shell", "strong"],
      [/\bjavascript is (disabled|required|not enabled)\b/i, "JavaScript-required shell", "strong"],
      [
        /\bverify(ing)? (that )?(you are|you're) (a )?(human|not a (ro)?bot)\b|\bare you a (human|robot)\b|\bhuman verification\b/i,
        "anti-bot interstitial",
        "strong"
      ],
      [/\battention required\b.*cloudflare|\bunusual traffic from your (computer )?network\b|\bchecking your browser\b/i, "anti-bot interstitial", "strong"],
      // Akamai's and Cloudflare's denials carry an incident reference; without one
      // the phrase is as likely a permission-error article.
      [/\baccess denied\b[\s\S]{0,300}?(\breference #|\bray id\b|\bpermission to access\b)/i, "anti-bot interstitial", "strong"],
      // Cloudflare's WAF block page. Its "Attention Required!" is the <title>,
      // which extraction drops, so the body's own wording has to carry it.
      [/\bsorry, you have been blocked\b|\byou are unable to access\b[\s\S]{0,300}?\bray id\b/i, "anti-bot interstitial", "strong"],
      [/\baccess denied\b|\benable cookies\b/i, "anti-bot interstitial", "weak"],
      // FR / DE (the locale layer targets non-EN markets)
      [/\bnous utilisons des cookies\b|\baccepter (tous )?les cookies\b|\bactiver javascript\b/i, "cookie/consent wall (fr)", "strong"],
      [/\bwir verwenden cookies\b|\bcookies akzeptieren\b|\bjavascript aktivieren\b/i, "cookie/consent wall (de)", "strong"]
    ];
  }
});

// src/browser/mode.ts
function browserFetchMode(explicit) {
  const m = (explicit ?? env("BROWSER_FETCH"))?.toLowerCase();
  return m === "always" || m === "fallback" ? m : "off";
}
function worthRendering(res) {
  if (RENDER_STATUS.has(res.status)) return res.status ? `got HTTP ${res.status}` : "got no answer";
  if (res.status < 200 || res.status >= 300) return void 0;
  const junk = looksLikeJunkExtraction(res.text);
  if (junk) return `read a ${junk}`;
  return res.text.trim().length < 200 ? "found almost no text" : void 0;
}
var RENDER_STATUS;
var init_mode = __esm({
  "src/browser/mode.ts"() {
    "use strict";
    init_brand();
    init_junk();
    RENDER_STATUS = /* @__PURE__ */ new Set([0, 401, 403, 429, 503]);
  }
});

// src/browser/challenge.ts
function add(out, cond, e) {
  if (cond) out.push(e);
}
function genericEvidence(h, sig) {
  const out = [];
  const inTitle = GENERIC_PHRASES.find((p) => h.title.includes(p));
  add(out, inTitle, { signal: `title mentions "${inTitle}"` });
  if (h.text.length < PHRASE_TEXT_MAX) {
    const inText = GENERIC_PHRASES.find((p) => h.text.includes(p));
    add(out, inText, { signal: `text mentions "${inText}"` });
  }
  add(out, frameHas(h, "captcha"), { signal: "captcha frame", widget: true });
  add(out, sig.status !== void 0 && BLOCKED_STATUS.has(sig.status) && sig.status !== 503 && h.text.trim().length < LITTLE_TEXT, {
    signal: `status ${sig.status} with almost no text`,
    interstitial: true
  });
  return out;
}
function classifyChallenge(sig) {
  const text = norm((sig.text ?? "").slice(0, 4096));
  const h = {
    title: norm(sig.title),
    text,
    urls: [...sig.frameUrls ?? [], ...sig.scriptUrls ?? []].map(norm),
    frames: (sig.frameUrls ?? []).map(norm),
    scripts: (sig.scriptUrls ?? []).map(norm),
    cookies: (sig.cookieNames ?? []).map(norm),
    selectors: (sig.selectors ?? []).map(norm)
  };
  const statusBlocked = sig.status !== void 0 && BLOCKED_STATUS.has(sig.status);
  const littleText = sig.text !== void 0 && sig.text.trim().length < LITTLE_TEXT;
  const finish2 = (kind, ev2) => ({
    kind,
    // An empty page makes a block of what is not a widget or a tag; a widget or a tag needs a blocked status.
    blocking: statusBlocked || ev2.some((e) => e.interstitial || littleText && !e.weak && !e.widget),
    signals: ev2.map((e) => e.signal)
  });
  for (const [kind, rule] of VENDORS) {
    const ev2 = rule(h);
    if (ev2.some((e) => !e.weak) || ev2.length > 0 && statusBlocked) return finish2(kind, ev2);
  }
  const ev = genericEvidence(h, sig);
  return ev.length > 0 ? finish2("generic", ev) : null;
}
function frameUrls(node, out = []) {
  if (!node) return out;
  if (node.frame?.url) out.push(node.frame.url);
  for (const c of node.childFrames ?? []) frameUrls(c, out);
  return out;
}
async function probeChallenge(session) {
  try {
    const r = await session.page.send(
      "Runtime.evaluate",
      { expression: PROBE, returnByValue: true },
      { timeoutMs: PROBE_TIMEOUT_MS3 }
    );
    const v = r.result?.value;
    if (typeof v !== "object" || v === null) return { ok: false };
    const p = v;
    let tree = [];
    try {
      tree = frameUrls((await session.page.send("Page.getFrameTree")).frameTree);
    } catch {
    }
    const challenge = classifyChallenge({
      url: typeof p.url === "string" ? p.url : "",
      title: typeof p.title === "string" ? p.title : "",
      text: typeof p.text === "string" ? p.text : void 0,
      frameUrls: [...strings(p.iframeSrcs), ...tree],
      scriptUrls: strings(p.scriptUrls),
      cookieNames: strings(p.cookieNames),
      selectors: strings(p.selectors),
      status: typeof p.status === "number" ? p.status : void 0
    });
    return { ok: true, challenge };
  } catch {
    return { ok: false };
  }
}
async function detectChallenge(session) {
  const probe = await probeChallenge(session);
  return probe.ok ? probe.challenge : null;
}
var CHALLENGE_SELECTORS, LITTLE_TEXT, PHRASE_TEXT_MAX, BLOCKED_STATUS, norm, urlHas, frameHas, scriptHas, selHas, datadome, CF_ORCHESTRATE, cloudflare, perimeterx, akamai, imperva, arkose, hcaptcha, recaptcha, VENDORS, GENERIC_PHRASES, PROBE_TIMEOUT_MS3, PROBE, strings;
var init_challenge = __esm({
  "src/browser/challenge.ts"() {
    "use strict";
    CHALLENGE_SELECTORS = [
      "#challenge-form",
      ".cf-turnstile",
      ".g-recaptcha",
      ".h-captcha",
      "#px-captcha",
      'iframe[src*="datadome"]',
      "#sec-if-cpt-container"
    ];
    LITTLE_TEXT = 200;
    PHRASE_TEXT_MAX = 1500;
    BLOCKED_STATUS = /* @__PURE__ */ new Set([403, 429, 503]);
    norm = (s) => s.normalize("NFD").replace(new RegExp("\\p{M}", "gu"), "").replace(/[‘’]/g, "'").toLowerCase();
    urlHas = (h, needle) => h.urls.find((u) => u.includes(needle));
    frameHas = (h, needle) => h.frames.find((u) => u.includes(needle));
    scriptHas = (h, needle) => h.scripts.find((u) => u.includes(needle));
    selHas = (h, needle) => h.selectors.some((s) => s.includes(needle));
    datadome = (h) => {
      const out = [];
      const frame = frameHas(h, "captcha-delivery.com");
      add(out, frame, { signal: "captcha-delivery.com", interstitial: true });
      add(out, scriptHas(h, "captcha-delivery.com"), { signal: "captcha-delivery.com script", weak: true });
      add(out, selHas(h, "datadome"), { signal: "datadome frame" });
      add(out, h.cookies.includes("datadome"), { signal: "datadome cookie", weak: true });
      add(out, urlHas(h, "datadome.co"), { signal: "datadome.co script", weak: true });
      return out;
    };
    CF_ORCHESTRATE = /\/cdn-cgi\/challenge-platform\/(?:h\/[a-z]\/)?orchestrate\//;
    cloudflare = (h) => {
      const out = [];
      const t = h.title.trim();
      add(out, t.includes("just a moment") || t.startsWith("un instant") || t.includes("attention required! | cloudflare"), {
        signal: `title "${h.title.trim()}"`,
        interstitial: true
      });
      add(out, selHas(h, "#challenge-form"), { signal: "#challenge-form", interstitial: true });
      add(out, urlHas(h, "cf-chl") || urlHas(h, "__cf_chl"), { signal: "cf-chl", interstitial: true });
      const platform = h.urls.filter((u) => u.includes("/cdn-cgi/challenge-platform/") && !u.includes("turnstile"));
      add(
        out,
        platform.some((u) => CF_ORCHESTRATE.test(u)),
        { signal: "/cdn-cgi/challenge-platform/ orchestrate", interstitial: true }
      );
      add(
        out,
        platform.some((u) => !CF_ORCHESTRATE.test(u)),
        { signal: "/cdn-cgi/challenge-platform/", weak: true }
      );
      add(
        out,
        h.cookies.some((c) => c.startsWith("cf-chl") || c.startsWith("__cf_chl")),
        { signal: "cf-chl cookie", weak: true }
      );
      add(out, selHas(h, ".cf-turnstile"), { signal: ".cf-turnstile", widget: true });
      add(out, frameHas(h, "challenges.cloudflare.com"), { signal: "challenges.cloudflare.com frame", widget: true });
      add(out, scriptHas(h, "challenges.cloudflare.com"), { signal: "challenges.cloudflare.com script", weak: true });
      return out;
    };
    perimeterx = (h) => {
      const out = [];
      add(out, selHas(h, "px-captcha"), { signal: "#px-captcha", interstitial: true });
      add(out, h.text.includes("press & hold") || h.text.includes("appuyez et maintenez"), { signal: "Press & Hold", interstitial: true });
      add(out, urlHas(h, "captcha.px-cdn.net"), { signal: "captcha.px-cdn.net", widget: true });
      const tag = urlHas(h, "px-cdn.net") ?? urlHas(h, "px-cloud.net");
      add(out, tag, { signal: "px script", weak: true });
      add(
        out,
        h.cookies.some((c) => c === "_px3" || c === "_pxvid" || c === "_pxhd"),
        { signal: "_px cookie", weak: true }
      );
      return out;
    };
    akamai = (h) => {
      const out = [];
      add(out, h.title.includes("access denied") && h.text.includes("reference #"), { signal: "Access Denied + Reference #", interstitial: true });
      add(out, urlHas(h, "sec-if-cpt") || selHas(h, "sec-if-cpt") || selHas(h, "sec-cpt"), { signal: "sec-if-cpt", interstitial: true });
      add(out, urlHas(h, "edgesuite.net") || h.text.includes("edgesuite.net"), { signal: "edgesuite.net" });
      add(out, h.cookies.includes("sec_cpt"), { signal: "sec_cpt cookie", weak: true });
      return out;
    };
    imperva = (h) => {
      const out = [];
      add(out, h.text.includes("incapsula incident id"), { signal: "Incapsula incident ID", interstitial: true });
      add(out, urlHas(h, "_incapsula_resource") || h.text.includes("_incapsula_resource"), { signal: "_Incapsula_Resource", weak: true });
      add(
        out,
        h.cookies.some((c) => c.startsWith("incap_ses")),
        { signal: "incap_ses cookie", weak: true }
      );
      return out;
    };
    arkose = (h) => {
      const out = [];
      const f = frameHas(h, "arkoselabs.com") ?? frameHas(h, "funcaptcha");
      add(out, f, { signal: f?.includes("funcaptcha") ? "funcaptcha" : "arkoselabs.com", widget: true });
      add(out, scriptHas(h, "arkoselabs.com") ?? scriptHas(h, "funcaptcha"), { signal: "arkose script", weak: true });
      return out;
    };
    hcaptcha = (h) => {
      const out = [];
      add(out, frameHas(h, "hcaptcha.com"), { signal: "hcaptcha.com frame", widget: true });
      add(out, scriptHas(h, "hcaptcha.com"), { signal: "hcaptcha.com script", weak: true });
      add(out, selHas(h, ".h-captcha"), { signal: ".h-captcha", widget: true });
      return out;
    };
    recaptcha = (h) => {
      const out = [];
      add(out, frameHas(h, "google.com/recaptcha") || frameHas(h, "recaptcha.net"), { signal: "recaptcha frame", widget: true });
      add(out, scriptHas(h, "google.com/recaptcha") || scriptHas(h, "recaptcha.net"), { signal: "recaptcha script", weak: true });
      add(out, selHas(h, ".g-recaptcha"), { signal: ".g-recaptcha", widget: true });
      return out;
    };
    VENDORS = [
      ["datadome", datadome],
      ["cloudflare", cloudflare],
      ["perimeterx", perimeterx],
      ["akamai", akamai],
      ["imperva", imperva],
      ["arkose", arkose],
      ["hcaptcha", hcaptcha],
      ["recaptcha", recaptcha]
    ];
    GENERIC_PHRASES = [
      "captcha",
      "are you a robot",
      "are you human",
      "verify you are human",
      "verify you're human",
      "unusual traffic",
      "checking your browser",
      "verifiez que vous etes humain",
      "je ne suis pas un robot"
    ];
    PROBE_TIMEOUT_MS3 = 3e3;
    PROBE = `(() => {
  const sel = ${JSON.stringify(CHALLENGE_SELECTORS)}.filter((s) => { try { return !!document.querySelector(s); } catch { return false; } });
  const nav = performance.getEntriesByType("navigation")[0];
  return {
    url: location.href,
    title: document.title || "",
    text: (document.body ? document.body.innerText : "").slice(0, 4096),
    scriptUrls: Array.from(document.scripts, (s) => s.src).filter(Boolean),
    iframeSrcs: Array.from(document.querySelectorAll("iframe"), (f) => f.src).filter(Boolean),
    cookieNames: (() => { try { return document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean); } catch (e) { return []; } })(),
    selectors: sel,
    status: nav && nav.responseStatus > 0 ? nav.responseStatus : undefined,
  };
})()`;
    strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  }
});

// src/browser/ws.ts
import { createHash as createHash2, randomBytes } from "crypto";
import { EventEmitter } from "events";
function encodeFrame(opcode, payload, opts = {}) {
  const mask = opts.mask ?? true;
  const len = payload.length;
  const lenBytes = len <= 125 ? 0 : len <= 65535 ? 2 : 8;
  const head = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0));
  head[0] = (opts.fin === false ? 0 : 128) | opcode & 15;
  head[1] = (mask ? 128 : 0) | (lenBytes === 0 ? len : lenBytes === 2 ? 126 : 127);
  if (lenBytes === 2) head.writeUInt16BE(len, 2);
  if (lenBytes === 8) head.writeBigUInt64BE(BigInt(len), 2);
  if (!mask) return Buffer.concat([head, payload]);
  const key = opts.maskKey ?? randomBytes(4);
  key.copy(head, 2 + lenBytes);
  return Buffer.concat([head, unmask(payload, key)]);
}
function unmask(payload, key) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i & 3];
  return out;
}
async function connectWebSocket(url, opts = {}) {
  const { request } = await import("http");
  return new Promise((resolve12, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`bad WebSocket URL: ${url}`));
    }
    if (u.protocol !== "ws:") return reject(new Error(`only ws:// URLs are supported, got ${u.protocol}//`));
    const key = randomBytes(16).toString("base64");
    const expected = createHash2("sha1").update(key + GUID).digest("base64");
    let settled = false;
    const settle2 = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = request({
      host: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" }
    });
    const timer = setTimeout(
      () => settle2(() => {
        req.destroy();
        reject(new Error(`WebSocket connect timed out after ${opts.connectTimeoutMs ?? 1e4} ms`));
      }),
      opts.connectTimeoutMs ?? 1e4
    );
    req.on("upgrade", (res, socket, head) => {
      if (res.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        return settle2(() => reject(new Error("WebSocket handshake failed: bad Accept")));
      }
      settle2(() => resolve12(new WsClient(socket, opts, head)));
    });
    req.on("response", (res) => {
      res.resume();
      settle2(() => reject(new Error(`WebSocket handshake failed: HTTP ${res.statusCode}`)));
    });
    req.on("error", (e) => settle2(() => reject(e)));
    req.end();
  });
}
var GUID, DEFAULT_MAX_MESSAGE, WsProtocolError, FrameParser, WsClient;
var init_ws = __esm({
  "src/browser/ws.ts"() {
    "use strict";
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    DEFAULT_MAX_MESSAGE = 64 * 1024 * 1024;
    WsProtocolError = class extends Error {
      constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "WsProtocolError";
      }
      code;
    };
    FrameParser = class {
      buf = Buffer.alloc(0);
      max;
      constructor(opts = {}) {
        this.max = opts.maxMessageSize ?? DEFAULT_MAX_MESSAGE;
      }
      push(chunk) {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        const frames = [];
        for (; ; ) {
          const frame = this.next();
          if (!frame) return frames;
          frames.push(frame);
        }
      }
      next() {
        const b = this.buf;
        if (b.length < 2) return void 0;
        const masked = (b[1] & 128) !== 0;
        let len = b[1] & 127;
        let off = 2;
        if (len === 126) {
          if (b.length < 4) return void 0;
          len = b.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (b.length < 10) return void 0;
          const big = b.readBigUInt64BE(2);
          if (big > BigInt(this.max)) throw new WsProtocolError("message too large", 1009);
          len = Number(big);
          off = 10;
        }
        if (len > this.max) throw new WsProtocolError("message too large", 1009);
        const total = off + (masked ? 4 : 0) + len;
        if (b.length < total) return void 0;
        const payload = masked ? unmask(b.subarray(off + 4, total), b.subarray(off, off + 4)) : Buffer.from(b.subarray(off, total));
        this.buf = b.subarray(total);
        return { fin: (b[0] & 128) !== 0, opcode: b[0] & 15, payload };
      }
    };
    WsClient = class extends EventEmitter {
      constructor(socket, opts = {}, head = Buffer.alloc(0)) {
        super();
        this.socket = socket;
        this.max = opts.maxMessageSize ?? DEFAULT_MAX_MESSAGE;
        this.closeTimeoutMs = opts.closeTimeoutMs ?? 2e3;
        this.parser = new FrameParser({ maxMessageSize: this.max });
        socket.on("data", (d) => this.feed(d));
        socket.on("error", (e) => this.fail(e, 1006));
        socket.on("close", () => this.finish(1006, ""));
        socket.pause();
        setImmediate(() => {
          if (head.length) this.feed(head);
          socket.resume();
        });
      }
      socket;
      parser;
      max;
      closeTimeoutMs;
      fragments = [];
      fragmentBytes = 0;
      started = false;
      closing = false;
      done = false;
      send(text) {
        if (this.done || this.closing) throw new Error("WebSocket is not open");
        this.socket.write(encodeFrame(1, Buffer.from(text, "utf8")));
      }
      /** Send a close frame, then wait (bounded) for the peer to answer or hang up. */
      async close(code = 1e3, reason = "") {
        if (this.done) return;
        if (!this.closing) {
          this.closing = true;
          this.writeClose(code, reason);
        }
        await new Promise((resolve12) => {
          const timer = setTimeout(() => {
            this.socket.destroy();
            this.finish(code, reason);
          }, this.closeTimeoutMs);
          this.once("close", () => {
            clearTimeout(timer);
            resolve12();
          });
        });
      }
      /** Drop the socket without a closing handshake. */
      terminate() {
        this.socket.destroy();
        this.finish(1006, "");
      }
      writeClose(code, reason) {
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code, 0);
        payload.write(reason, 2);
        if (!this.socket.destroyed) this.socket.write(encodeFrame(8, payload));
      }
      feed(chunk) {
        let frames;
        try {
          frames = this.parser.push(chunk);
        } catch (e) {
          this.fail(e, e instanceof WsProtocolError ? e.code : 1002);
          return;
        }
        for (const frame of frames) {
          if (this.done) return;
          let text;
          try {
            text = this.onFrame(frame);
          } catch (e) {
            this.fail(e, e instanceof WsProtocolError ? e.code : 1002);
            return;
          }
          if (text !== void 0) this.deliver(text);
        }
      }
      deliver(text) {
        try {
          this.emit("message", text);
        } catch (e) {
          if (this.listenerCount("error") > 0) this.emit("error", e);
          else
            process.nextTick(() => {
              throw e;
            });
        }
      }
      /** Handle one frame; returns the text of a message it completed. */
      onFrame(f) {
        if (this.done) return;
        switch (f.opcode) {
          case 9:
            if (!this.socket.destroyed) this.socket.write(encodeFrame(10, f.payload));
            return;
          case 10:
            return;
          case 8: {
            const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
            const reason = f.payload.subarray(2).toString("utf8");
            if (!this.closing) this.writeClose(f.payload.length >= 2 ? code : 1e3, "");
            this.socket.end();
            this.finish(code, reason);
            return;
          }
          case 1:
          case 2:
            if (this.started) throw new WsProtocolError("new data frame inside a fragmented message", 1002);
            this.started = true;
            break;
          case 0:
            if (!this.started) throw new WsProtocolError("unexpected continuation frame", 1002);
            break;
          default:
            throw new WsProtocolError(`unknown opcode ${f.opcode}`, 1002);
        }
        this.fragmentBytes += f.payload.length;
        if (this.fragmentBytes > this.max) throw new WsProtocolError("message too large", 1009);
        this.fragments.push(f.payload);
        if (!f.fin) return;
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.fragmentBytes = 0;
        this.started = false;
        return text;
      }
      /** Protocol or socket failure: tell the peer why (when we can), surface the error, close. */
      fail(err, code) {
        if (this.done) return;
        if (code !== 1006 && !this.closing) {
          this.closing = true;
          this.writeClose(code, "");
        }
        if (this.listenerCount("error") > 0) this.emit("error", err);
        this.socket.end();
        this.finish(code, err.message);
      }
      finish(code, reason) {
        if (this.done) return;
        this.done = true;
        this.emit("close", { code, reason });
      }
    };
  }
});

// src/browser/cdp.ts
var DEFAULT_CALL_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, CdpError, defaultConnector, bucket, CdpClient;
var init_cdp = __esm({
  "src/browser/cdp.ts"() {
    "use strict";
    init_ws();
    DEFAULT_CALL_TIMEOUT_MS = 3e4;
    DEFAULT_CONNECT_TIMEOUT_MS = 1e4;
    CdpError = class extends Error {
      constructor(method, code, message) {
        super(`CDP ${method} failed: ${message}${code ? ` (${code})` : ""}`);
        this.method = method;
        this.code = code;
        this.name = "CdpError";
      }
      method;
      code;
    };
    defaultConnector = (url, { timeoutMs }) => connectWebSocket(url, { connectTimeoutMs: timeoutMs });
    bucket = (sessionId, method) => `${sessionId ?? ""}
${method}`;
    CdpClient = class _CdpClient {
      constructor(ws) {
        this.ws = ws;
        ws.on("message", (text) => this.onMessage(text));
        ws.on("close", () => this.onClosed());
        ws.on("error", () => {
        });
      }
      ws;
      nextId = 0;
      pending = /* @__PURE__ */ new Map();
      handlers = /* @__PURE__ */ new Map();
      closeHandlers = /* @__PURE__ */ new Set();
      isClosed = false;
      static async connect(wsUrl, opts = {}) {
        const connector = opts.transport ?? defaultConnector;
        return new _CdpClient(await connector(wsUrl, { timeoutMs: opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS }));
      }
      get closed() {
        return this.isClosed;
      }
      send(method, params, opts = {}) {
        if (this.isClosed) return Promise.reject(new Error(`CDP connection closed (${method})`));
        const id = ++this.nextId;
        const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
        return new Promise((resolve12, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`CDP command timed out: ${method} (${timeoutMs} ms)`));
          }, timeoutMs);
          this.pending.set(id, { method, resolve: resolve12, reject, timer });
          try {
            this.ws.send(JSON.stringify({ id, method, params, sessionId: opts.sessionId }));
          } catch (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(e);
          }
        });
      }
      on(method, handler, sessionId) {
        const key = bucket(sessionId, method);
        let set = this.handlers.get(key);
        if (!set) this.handlers.set(key, set = /* @__PURE__ */ new Set());
        set.add(handler);
      }
      off(method, handler, sessionId) {
        const key = bucket(sessionId, method);
        const set = this.handlers.get(key);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(key);
      }
      /** Resolve with the params of the next matching event; reject on timeout or when the socket closes. */
      once(method, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
        return new Promise((resolve12, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            this.off(method, handler, opts.sessionId);
            this.closeHandlers.delete(onClose);
          };
          const handler = (params) => {
            if (opts.predicate && !opts.predicate(params)) return;
            cleanup();
            resolve12(params);
          };
          const onClose = () => {
            cleanup();
            reject(new Error(`CDP connection closed while waiting for ${method}`));
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for CDP event ${method} (${timeoutMs} ms)`));
          }, timeoutMs);
          this.on(method, handler, opts.sessionId);
          this.closeHandlers.add(onClose);
          if (this.isClosed) onClose();
        });
      }
      /** A view of this client bound to one session (`Target.attachToTarget({ flatten: true })`). */
      session(sessionId) {
        return {
          sessionId,
          send: (method, params, opts) => this.send(method, params, { ...opts, sessionId }),
          on: (method, handler) => this.on(method, handler, sessionId),
          off: (method, handler) => this.off(method, handler, sessionId),
          once: (method, opts) => this.once(method, { ...opts, sessionId })
        };
      }
      /** Run `handler` once the connection is closed (at once if it already is). Returns its unsubscribe. */
      onClose(handler) {
        if (this.isClosed) {
          handler();
          return () => {
          };
        }
        this.closeHandlers.add(handler);
        return () => void this.closeHandlers.delete(handler);
      }
      /** Close the connection (the browser keeps running). */
      async close() {
        if (this.isClosed) return;
        await this.ws.close();
        this.onClosed();
      }
      onMessage(text) {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg === null || typeof msg !== "object") return;
        if (typeof msg.id === "number") {
          const p = this.pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new CdpError(p.method, Number(msg.error.code) || 0, String(msg.error.message ?? "unknown error")));
          else p.resolve(msg.result);
          return;
        }
        if (typeof msg.method !== "string") return;
        const set = this.handlers.get(bucket(msg.sessionId, msg.method));
        if (!set) return;
        for (const h of [...set]) {
          try {
            h(msg.params);
          } catch {
          }
        }
      }
      onClosed() {
        if (this.isClosed) return;
        this.isClosed = true;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(`CDP connection closed (${p.method})`));
        }
        this.pending.clear();
        for (const h of [...this.closeHandlers]) h();
        this.closeHandlers.clear();
      }
    };
  }
});

// src/browser/detect.ts
import { accessSync, constants, statSync as statSync2 } from "fs";
import { homedir } from "os";
import { posix, win32 } from "path";
function isLaunchable(path) {
  try {
    if (!statSync2(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function candidates(kind, platform, sys, home) {
  if (platform === "darwin") {
    const app = MAC_APPS[kind];
    return ["/Applications", posix.join(home, "Applications")].map((dir) => posix.join(dir, `${app}.app`, "Contents", "MacOS", app));
  }
  if (platform === "win32") {
    const roots = [sys.ProgramFiles, sys["ProgramFiles(x86)"], sys.LOCALAPPDATA].filter((r) => !!r);
    return roots.map((root) => win32.join(root, WINDOWS_PATHS[kind]));
  }
  const dirs = (sys.PATH ?? "").split(":").filter(Boolean);
  return LINUX_NAMES[kind].flatMap((name2) => dirs.map((dir) => posix.join(dir, name2)));
}
function kindOf(path) {
  const name2 = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (name2.includes("brave")) return "brave";
  if (name2.includes("edge")) return "edge";
  if (name2.includes("chromium")) return "chromium";
  return "chrome";
}
function detectBrowserBinary(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const sys = opts.processEnv ?? process.env;
  const exists = opts.exists ?? isLaunchable;
  const home = opts.home ?? homedir();
  const explicit = opts.env ? opts.env("BROWSER_BIN") : env("BROWSER_BIN");
  if (explicit) {
    const bare = !/[\\/]/.test(explicit);
    const options = bare ? (sys.PATH ?? "").split(":").filter(Boolean).map((d) => posix.join(d, explicit)) : [explicit];
    const found = options.find(exists);
    if (!found) throw new Error(`BROWSER_BIN points at "${explicit}", which is not an executable file`);
    return { kind: kindOf(found), path: found };
  }
  let only = opts.kind;
  if (!only && !opts.prefer) {
    const asked = (opts.env ? opts.env("BROWSER_KIND") : env("BROWSER_KIND"))?.trim().toLowerCase();
    if (asked && !isBrowserKind(asked)) throw new Error(`${envName("BROWSER_KIND")} is "${asked}", not one of ${ORDER.join(", ")}`);
    if (asked && isBrowserKind(asked)) only = asked;
  }
  const prefer = opts.prefer;
  const kinds = only ? [only] : prefer ? [prefer, ...ORDER.filter((k) => k !== prefer)] : ORDER;
  for (const kind of kinds) {
    const path = candidates(kind, platform, sys, home).find(exists);
    if (path) return { kind, path };
  }
  return null;
}
function ignoresUnpackedExtensions(bin, browserVersion) {
  if (bin.kind !== "chrome" || /for[ _-]?testing|[\\/]chrome-(?:linux|mac|win)[^\\/]*[\\/]/i.test(bin.path)) return false;
  if (browserVersion === void 0) return true;
  const major = /^(?:Headless)?Chrome\/(\d+)\./.exec(browserVersion)?.[1];
  return major !== void 0 && Number(major) >= 137;
}
var ORDER, BROWSER_KINDS, isBrowserKind, MAC_APPS, LINUX_NAMES, WINDOWS_PATHS;
var init_detect = __esm({
  "src/browser/detect.ts"() {
    "use strict";
    init_brand();
    ORDER = ["chrome", "brave", "chromium", "edge"];
    BROWSER_KINDS = ORDER;
    isBrowserKind = (v) => ORDER.includes(v);
    MAC_APPS = {
      chrome: "Google Chrome",
      brave: "Brave Browser",
      chromium: "Chromium",
      edge: "Microsoft Edge"
    };
    LINUX_NAMES = {
      chrome: ["google-chrome", "google-chrome-stable"],
      brave: ["brave-browser"],
      chromium: ["chromium", "chromium-browser"],
      edge: ["microsoft-edge"]
    };
    WINDOWS_PATHS = {
      chrome: "Google\\Chrome\\Application\\chrome.exe",
      brave: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      chromium: "Chromium\\Application\\chrome.exe",
      edge: "Microsoft\\Edge\\Application\\msedge.exe"
    };
  }
});

// src/browser/discovery.ts
var discovery_exports = {};
__export(discovery_exports, {
  activateTarget: () => activateTarget,
  assertLoopback: () => assertLoopback,
  closeTarget: () => closeTarget,
  dialHost: () => dialHost,
  getVersion: () => getVersion,
  isPortAlive: () => isPortAlive,
  listPages: () => listPages,
  listTargets: () => listTargets,
  loopbackSocketUrl: () => loopbackSocketUrl,
  newTarget: () => newTarget,
  parseCdpEndpoint: () => parseCdpEndpoint
});
function assertLoopback(host) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK.has(bare)) throw new Error(`refusing non-loopback DevTools host "${host}" (only 127.0.0.1, ::1 and localhost are allowed)`);
  return bare;
}
function loopbackSocketUrl(wsUrl) {
  let url;
  try {
    url = new URL(wsUrl);
  } catch {
    throw new Error(`invalid DevTools WebSocket URL "${wsUrl}"`);
  }
  if (url.protocol !== "ws:") throw new Error(`refusing DevTools WebSocket URL "${wsUrl}": only ws:// on loopback is dialled`);
  assertLoopback(url.hostname);
  return wsUrl;
}
function parseCdpEndpoint(input) {
  const text = input.trim();
  if (/^\d+$/.test(text)) return { host: "127.0.0.1", port: checkPort(Number(text), input) };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new Error(`invalid DevTools endpoint "${input}"`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error(`unsupported DevTools endpoint scheme "${url.protocol}" in "${input}"`);
  const host = assertLoopback(url.hostname);
  if (!url.port) throw new Error(`DevTools endpoint "${input}" has no port`);
  const endpoint = { host, port: checkPort(Number(url.port), input) };
  if (url.protocol === "ws:" || url.protocol === "wss:") endpoint.wsUrl = text;
  return endpoint;
}
function checkPort(port, input) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in DevTools endpoint "${input}"`);
  return port;
}
function dialHost(host) {
  const bare = assertLoopback(host);
  return bare === "localhost" ? "127.0.0.1" : bare;
}
async function http(method, port, host, path, timeoutMs = REQUEST_TIMEOUT_MS) {
  const { request } = await import("http");
  return new Promise((resolve12, reject) => {
    const req = request({ host: dialHost(host), port, path, method, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve12({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`DevTools request ${method} ${path} timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}
async function json(method, port, host, path) {
  const { status, body } = await http(method, port, host, path);
  if (status < 200 || status >= 300) throw new Error(`DevTools ${method} ${path} answered HTTP ${status}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`DevTools ${path} did not return valid JSON`);
  }
}
function getVersion(port, host = "127.0.0.1") {
  return json("GET", port, host, "/json/version");
}
function listTargets(port, host = "127.0.0.1") {
  return json("GET", port, host, "/json/list");
}
async function listPages(port, host = "127.0.0.1") {
  return (await listTargets(port, host)).filter((t) => t.type === "page");
}
async function newTarget(port, url, host = "127.0.0.1") {
  const path = url === void 0 ? "/json/new" : `/json/new?${encodeURIComponent(url)}`;
  try {
    return await json("PUT", port, host, path);
  } catch (e) {
    if (!/answered HTTP/.test(e.message)) throw e;
    return json("GET", port, host, path);
  }
}
async function command(port, host, path) {
  const { status, body } = await http("GET", port, host, path);
  if (status < 200 || status >= 300) throw new Error(`DevTools GET ${path} answered HTTP ${status}`);
  return body;
}
async function closeTarget(port, id, host = "127.0.0.1") {
  await command(port, host, `/json/close/${encodeURIComponent(id)}`);
}
async function activateTarget(port, id, host = "127.0.0.1") {
  await command(port, host, `/json/activate/${encodeURIComponent(id)}`);
}
async function isPortAlive(port, host = "127.0.0.1") {
  try {
    const { status } = await http("GET", port, host, "/json/version", ALIVE_TIMEOUT_MS);
    return status === 200;
  } catch {
    return false;
  }
}
var REQUEST_TIMEOUT_MS, ALIVE_TIMEOUT_MS, LOOPBACK;
var init_discovery = __esm({
  "src/browser/discovery.ts"() {
    "use strict";
    REQUEST_TIMEOUT_MS = 3e3;
    ALIVE_TIMEOUT_MS = 1e3;
    LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "localhost"]);
  }
});

// src/browser/deps.ts
import { spawn as nodeSpawn } from "child_process";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "fs/promises";
function defaultBrowserDeps() {
  return {
    spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts),
    fs: { readFile, writeFile, rename, mkdir, rm, stat, open },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    connectCdp: (wsUrl) => CdpClient.connect(wsUrl),
    discovery: discovery_exports,
    detectBrowser: (kind) => detectBrowserBinary(kind ? { kind } : {}),
    kill: (pid, signal) => void process.kill(pid, signal),
    env: (name2) => env(name2),
    platform: process.platform
  };
}
function browserDeps(own) {
  return { ...defaultBrowserDeps(), ...own };
}
var init_deps = __esm({
  "src/browser/deps.ts"() {
    "use strict";
    init_brand();
    init_cdp();
    init_detect();
    init_discovery();
  }
});

// src/cli-kit.ts
import { basename } from "path";
function parseArgs(argv, spec) {
  const commands = new Set(spec.commands);
  const valueFlags = new Set(spec.valueFlags);
  const boolFlags = new Set(spec.boolFlags);
  if (argv.length === 0) return { kind: "help" };
  if (isHelpWord(argv[0])) return argv[1] !== void 0 && commands.has(argv[1]) ? { kind: "help", command: argv[1] } : { kind: "help" };
  if (isVersionWord(argv[0])) return { kind: "version" };
  const command2 = argv[0];
  if (!commands.has(command2)) {
    throw new UsageError(`unknown command "${command2}" \u2014 run --help for the supported commands`);
  }
  const values = {};
  const bools = /* @__PURE__ */ new Set();
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") && arg !== "-h" && arg !== "-v") {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);
    if (!boolFlags.has(key) && !valueFlags.has(key)) {
      if (isHelpWord(arg)) return { kind: "help", command: command2 };
      if (isVersionWord(arg)) return { kind: "version" };
    }
    if (boolFlags.has(key)) {
      if (eq !== -1) throw new UsageError(`--${key} is a boolean flag and takes no value`);
      bools.add(key);
      continue;
    }
    if (!valueFlags.has(key)) {
      throw new UsageError(`unknown flag "--${key}" \u2014 run --help for the supported options`);
    }
    if (eq !== -1) {
      values[key] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === void 0 || next.startsWith("--")) {
      throw new UsageError(`missing value for --${key}`);
    }
    values[key] = next;
    i++;
  }
  return { kind: "command", command: command2, positional, values, bools };
}
function isHelpWord(a) {
  return a === "--help" || a === "-h" || a === "help";
}
function isVersionWord(a) {
  return a === "--version" || a === "-v" || a === "version";
}
function argValue(p, name2) {
  return p.values[name2];
}
function argBool(p, name2) {
  return p.bools.has(name2);
}
function argInt(p, name2, range = {}) {
  const raw = p.values[name2];
  if (raw === void 0) return void 0;
  const n = raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new UsageError(`--${name2} expects a whole number, got "${raw}"`);
  }
  const { min, max } = range;
  if (min !== void 0 && n < min || max !== void 0 && n > max) {
    const bound = min !== void 0 && max !== void 0 ? `from ${min} to ${max}` : min !== void 0 ? `of at least ${min}` : `of at most ${max}`;
    throw new UsageError(`--${name2} expects a whole number ${bound}, got "${raw}"`);
  }
  return n;
}
function positionalText(p) {
  return p.positional.join(" ");
}
function jsonLine(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function docFlagRegex() {
  return /(?<![a-z0-9-])--([a-z][a-z0-9-]*)/g;
}
function documentedFlags(text) {
  const seen = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(docFlagRegex())) seen.add(m[1]);
  return [...seen];
}
function helpCoversFlag(help, flag) {
  return new RegExp(`--${escapeRegExp(flag)}(?![a-z0-9-])`).test(help);
}
function isInvokedDirectly(argv1 = process.argv[1], cli = brand().cli) {
  if (!argv1) return false;
  return basename(argv1).replace(/\.(mjs|cjs|js)$/, "") === cli;
}
var EXIT_OK, EXIT_FAILURE, EXIT_USAGE, EXIT_HUMAN, UsageError;
var init_cli_kit = __esm({
  "src/cli-kit.ts"() {
    "use strict";
    init_brand();
    init_text();
    EXIT_OK = 0;
    EXIT_FAILURE = 1;
    EXIT_USAGE = 2;
    EXIT_HUMAN = 3;
    UsageError = class extends Error {
      exitCode = EXIT_USAGE;
    };
  }
});

// src/browser/extensions.ts
import { existsSync as existsSync5, statSync as statSync3 } from "fs";
import { isAbsolute as isAbsolute2, join as join13 } from "path";
function extensionDirs(raw) {
  const name2 = envName("BROWSER_EXTENSIONS");
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((dir) => {
    if (!isAbsolute2(dir)) throw new UsageError(`${name2} takes absolute paths, not ${JSON.stringify(dir)}`);
    let isDir = false;
    try {
      isDir = statSync3(dir).isDirectory();
    } catch {
    }
    if (!isDir) throw new UsageError(`${name2}: no such directory: ${dir}`);
    if (!existsSync5(join13(dir, "manifest.json"))) {
      throw new UsageError(`${name2}: ${dir} has no manifest.json \u2014 name the unpacked extension's own folder, the one that holds manifest.json`);
    }
    return dir;
  });
}
function extensionArgs(dirs) {
  if (dirs.length === 0) return [];
  const list = dirs.join(",");
  return [`--load-extension=${list}`, `--disable-extensions-except=${list}`];
}
var unpackedIgnoredNote;
var init_extensions = __esm({
  "src/browser/extensions.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    unpackedIgnoredNote = () => `Google Chrome \u2265 137 ignores unpacked extensions \u2014 use Brave (built-in ad/tracker blocking: ${envName("BROWSER_KIND")}=brave), Chromium or Chrome for Testing`;
  }
});

// src/browser/profile.ts
import { chmodSync, copyFileSync as copyFileSync2, existsSync as existsSync6, lstatSync, mkdirSync as mkdirSync3, readdirSync as readdirSync5, readFileSync as readFileSync12, realpathSync, rmSync as rmSync4, statSync as statSync4, writeFileSync as writeFileSync6 } from "fs";
import { homedir as homedir2 } from "os";
import { basename as basename2, join as join14, resolve as resolve2, sep } from "path";
function browserHome() {
  return env("BROWSER_DIR") ?? brand().browserDir ?? join14(homedir2(), `.${brand().name}`, "browser");
}
function checkName(name2) {
  if (!PROFILE_NAME.test(name2) || name2 === "." || name2 === "..") {
    throw new UsageError(`invalid profile name ${JSON.stringify(name2)} (1-64 of letters, digits, ".", "_", "-")`);
  }
}
function profileDir(name2 = "default") {
  checkName(name2);
  return join14(browserHome(), "profiles", name2);
}
function profileKindFile(name2 = "default") {
  return join14(profileDir(name2), `.${brand().name}-kind`);
}
function readProfileKind(name2 = "default") {
  try {
    const kind = readFileSync12(profileKindFile(name2), "utf8").trim();
    return isBrowserKind(kind) ? kind : void 0;
  } catch {
    return void 0;
  }
}
function writeProfileKind(name2, kind) {
  ensurePrivateDir(profileDir(name2));
  writeFileSync6(profileKindFile(name2), `${kind}
`, { mode: 384 });
}
function ensurePrivateDir(path) {
  try {
    mkdirSync3(path, { recursive: true, mode: 448 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  if (!st.isDirectory()) throw new Error(`${path} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${path} belongs to another user`);
  }
  if (process.platform === "win32") return;
  if (st.mode & 18) throw new Error(`${path} is writable by other users`);
  if (st.mode & 63) chmodSync(path, 448);
}
function realish(path) {
  const p = resolve2(path);
  try {
    return realpathSync(p);
  } catch {
    const parent = resolve2(p, "..");
    return parent === p ? p : join14(realish(parent), basename2(p));
  }
}
function assertInsideHome(path) {
  const home = browserHome();
  if (!realish(path).startsWith(realish(home) + sep)) {
    throw new Error(`refusing to touch ${path}: outside the browser home ${home}`);
  }
}
function resetProfile(name2 = "default") {
  const dir = profileDir(name2);
  if (!existsSync6(dir)) return;
  assertInsideHome(dir);
  rmSync4(dir, { recursive: true, force: true });
}
function userDataDir(source2, opts) {
  const platform = opts.platform ?? process.platform;
  const table = USER_DATA[platform];
  if (!table) throw new Error(`unsupported platform "${platform}" for importing a browser profile`);
  const parts = Object.hasOwn(table, source2) ? table[source2] : void 0;
  if (!parts) return resolve2(source2);
  if (platform === "win32") {
    const local2 = opts.localAppData ?? process.env.LOCALAPPDATA;
    if (!local2) throw new Error("LOCALAPPDATA is not set, so the browser profile cannot be located");
    return join14(local2, ...parts);
  }
  return join14(opts.homeDir ?? homedir2(), ...parts);
}
function copyTree(from, to, rel, tally) {
  ensurePrivateDir(to);
  for (const entry of readdirSync5(from, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (SKIP_NAMES.has(entry.name) || SKIP_PATHS.has(childRel)) continue;
    const src = join14(from, entry.name);
    const dst = join14(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst, childRel, tally);
    } else if (entry.isFile()) {
      copyFileSync2(src, dst);
      chmodSync(dst, 384);
      tally.files++;
      tally.bytes += statSync4(dst).size;
    }
  }
}
function importProfile(source2, opts = {}) {
  const to = profileDir(opts.name ?? "default");
  const from = userDataDir(source2, opts);
  if (!existsSync6(from)) throw new Error(`browser profile not found at ${from}`);
  const hasState = existsSync6(join14(from, "Local State"));
  const hasDefault = existsSync6(join14(from, "Default"));
  if (!hasState && !hasDefault) throw new Error(`${from} has no Local State or Default profile to import`);
  const lockNames = (opts.platform ?? process.platform) === "win32" ? ["SingletonLock", "lockfile"] : ["SingletonLock"];
  const locked = lockNames.some((n) => {
    try {
      lstatSync(join14(from, n));
      return true;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      return false;
    }
  });
  if (locked && !opts.force) {
    throw new Error(`the browser using ${from} appears to be running: close it, or pass force to import anyway`);
  }
  if (existsSync6(to) && readdirSync5(to).length > 0) {
    if (!opts.force) throw new Error(`${to} already holds a profile: pass force to replace it`);
    const a = realish(from);
    const b = realish(to);
    if (a === b || a.startsWith(b + sep) || b.startsWith(a + sep)) {
      throw new Error(`${from} and ${to} overlap: refusing to replace the profile with itself`);
    }
    assertInsideHome(to);
    rmSync4(to, { recursive: true, force: true });
  }
  ensurePrivateDir(join14(browserHome(), "profiles"));
  const tally = { files: 0, bytes: 0 };
  ensurePrivateDir(to);
  if (hasState) {
    copyFileSync2(join14(from, "Local State"), join14(to, "Local State"));
    chmodSync(join14(to, "Local State"), 384);
    tally.files++;
    tally.bytes += statSync4(join14(to, "Local State")).size;
  }
  if (hasDefault) copyTree(join14(from, "Default"), join14(to, "Default"), "", tally);
  const kind = String(source2);
  if (Object.hasOwn(USER_DATA[opts.platform ?? process.platform] ?? {}, kind) && isBrowserKind(kind)) writeProfileKind(opts.name ?? "default", kind);
  return { from, to, ...tally };
}
var PROFILE_NAME, USER_DATA, SKIP_NAMES, SKIP_PATHS;
var init_profile = __esm({
  "src/browser/profile.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    init_detect();
    PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
    USER_DATA = {
      darwin: {
        chrome: ["Library", "Application Support", "Google", "Chrome"],
        brave: ["Library", "Application Support", "BraveSoftware", "Brave-Browser"],
        chromium: ["Library", "Application Support", "Chromium"],
        edge: ["Library", "Application Support", "Microsoft Edge"]
      },
      linux: {
        chrome: [".config", "google-chrome"],
        brave: [".config", "BraveSoftware", "Brave-Browser"],
        chromium: [".config", "chromium"],
        edge: [".config", "microsoft-edge"]
      },
      win32: {
        chrome: ["Google", "Chrome", "User Data"],
        brave: ["BraveSoftware", "Brave-Browser", "User Data"],
        chromium: ["Chromium", "User Data"],
        edge: ["Microsoft", "Edge", "User Data"]
      }
    };
    SKIP_NAMES = /* @__PURE__ */ new Set([
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
      "lockfile",
      "DevToolsActivePort",
      "Cache",
      "Code Cache",
      "GPUCache",
      "ShaderCache",
      "GrShaderCache",
      "GraphiteDawnCache",
      "DawnGraphiteCache",
      "DawnWebGPUCache",
      "Crashpad"
    ]);
    SKIP_PATHS = /* @__PURE__ */ new Set(["Service Worker/CacheStorage", "Service Worker/ScriptCache"]);
  }
});

// src/browser/state.ts
import { randomUUID } from "crypto";
import { appendFileSync, closeSync, existsSync as existsSync7, openSync, readFileSync as readFileSync13, rmSync as rmSync5, statSync as statSync5, unlinkSync as unlinkSync2, writeSync } from "fs";
import { join as join15 } from "path";
function checkTargetId(id) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id)) throw new Error(`invalid target id: ${JSON.stringify(id)}`);
  return id;
}
function readJson2(path) {
  try {
    return JSON.parse(readFileSync13(path, "utf8"));
  } catch {
    return null;
  }
}
function writeJson(dir, name2, value) {
  ensurePrivateDir(dir);
  writeFileAtomic(join15(dir, name2), `${JSON.stringify(value)}
`, FILE_MODE);
}
function readSession(o) {
  const v = readJson2(join15(homeOf(o), "session.json"));
  if (!isObj(v) || v.version !== 1 || typeof v.port !== "number" || typeof v.targetId !== "string") return null;
  return v;
}
function writeSession(s, o) {
  if (isNoWrite()) return;
  writeJson(homeOf(o), "session.json", s);
}
function clearSession(o) {
  if (isNoWrite()) return;
  rmSync5(join15(homeOf(o), "session.json"), { force: true });
}
function readRefs(targetId, o) {
  const v = readJson2(join15(homeOf(o), "refs", `${checkTargetId(targetId)}.json`));
  if (!isObj(v) || typeof v.loaderId !== "string" || typeof v.url !== "string" || typeof v.next !== "number" || !isObj(v.refs)) return null;
  return v;
}
function writeRefs(targetId, table, o) {
  const id = checkTargetId(targetId);
  if (isNoWrite()) return;
  writeJson(join15(homeOf(o), "refs"), `${id}.json`, table);
}
function clearRefs(targetId, o) {
  const id = targetId === void 0 ? void 0 : checkTargetId(targetId);
  if (isNoWrite()) return;
  const dir = join15(homeOf(o), "refs");
  rmSync5(id === void 0 ? dir : join15(dir, `${id}.json`), { recursive: true, force: true });
}
function readNetwork(targetId, o) {
  let raw;
  try {
    raw = readFileSync13(networkFile(targetId, o), "utf8");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("invalid target id")) throw e;
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}
function appendNetwork(targetId, entries, o) {
  const file = networkFile(targetId, o);
  if (isNoWrite() || entries.length === 0) return;
  ensurePrivateDir(join15(homeOf(o), "network"));
  const lines = entries.map((e) => JSON.stringify(e));
  const existing = existsSync7(file) ? readFileSync13(file, "utf8").split("\n").filter(Boolean) : [];
  if (existing.length + lines.length <= NETWORK_CAP) {
    appendFileSync(file, `${lines.join("\n")}
`, { mode: FILE_MODE });
    return;
  }
  const kept = [...existing, ...lines].slice(-NETWORK_CAP);
  writeFileAtomic(file, `${kept.join("\n")}
`, FILE_MODE);
}
function clearNetwork(targetId, o) {
  const path = targetId === void 0 ? join15(homeOf(o), "network") : networkFile(targetId, o);
  if (isNoWrite()) return;
  rmSync5(path, { recursive: true, force: true });
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function staleReason(path, staleMs, now) {
  let at;
  let pid;
  try {
    const held = JSON.parse(readFileSync13(path, "utf8"));
    pid = held.pid;
    at = typeof held.at === "number" ? held.at : Number.NaN;
  } catch {
    at = Number.NaN;
  }
  if (Number.isNaN(at)) {
    try {
      at = statSync5(path).mtimeMs;
    } catch {
      return "gone";
    }
  }
  if (now - at > staleMs) return "old";
  if (typeof pid === "number" && !pidAlive(pid)) return "dead";
  return null;
}
function holds(path, token) {
  try {
    const held = JSON.parse(readFileSync13(path, "utf8"));
    return held.pid === process.pid && held.token === token;
  } catch {
    return false;
  }
}
async function withBrowserLock(fn, opts = {}) {
  if (isNoWrite()) return fn();
  const { staleMs = 3e4, waitMs = 1e4, pollMs = 50 } = opts;
  const { now, sleep: sleep2 } = opts.deps ?? realDeps;
  const dir = homeOf(opts);
  ensurePrivateDir(dir);
  const path = join15(dir, "lock");
  const token = randomUUID();
  const stamp = () => JSON.stringify({ pid: process.pid, at: now(), token });
  const deadline = now() + waitMs;
  for (; ; ) {
    try {
      const fd = openSync(path, "wx", FILE_MODE);
      try {
        writeSync(fd, stamp());
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (staleReason(path, staleMs, now())) {
      try {
        unlinkSync2(path);
      } catch {
      }
      continue;
    }
    if (now() >= deadline) throw new Error(`browser busy: another webindex command holds ${path} (waited ${waitMs} ms)`);
    await sleep2(pollMs);
  }
  const beat = setInterval(
    () => {
      if (!holds(path, token)) return;
      try {
        writeFileAtomic(path, stamp(), FILE_MODE);
      } catch {
      }
    },
    Math.max(1e3, staleMs / 3)
  );
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    try {
      if (holds(path, token)) unlinkSync2(path);
    } catch {
    }
  }
}
var NETWORK_CAP, FILE_MODE, homeOf, isObj, networkFile, realDeps;
var init_state = __esm({
  "src/browser/state.ts"() {
    "use strict";
    init_no_write();
    init_profile();
    NETWORK_CAP = 500;
    FILE_MODE = 384;
    homeOf = (o) => o?.home ?? browserHome();
    isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
    networkFile = (targetId, o) => join15(homeOf(o), "network", `${checkTargetId(targetId)}.jsonl`);
    realDeps = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms))
    };
  }
});

// src/browser/launch.ts
import { join as join16 } from "path";
async function resolveEndpoint(opts = {}) {
  const deps = browserDeps(opts.deps);
  const profile = opts.profile ?? "default";
  const headless = opts.headless ?? false;
  if (opts.cdp !== void 0) {
    let host;
    let port;
    try {
      const ep = parseCdpEndpoint(String(opts.cdp));
      host = dialHost(ep.host);
      port = ep.port;
    } catch (e) {
      throw new UsageError(e.message);
    }
    if (!await deps.discovery.isPortAlive(port, host)) throw new Error(`nothing answers DevTools on ${host}:${port}`);
    return { host, port, launchedByUs: false, profile, headless };
  }
  const saved = readSession();
  const usable = saved && (saved.launchedByUs ? opts.profile === void 0 || saved.profile === opts.profile : opts.profile === void 0 && !opts.ownOnly);
  if (saved && usable) {
    const host = saved.host ?? "127.0.0.1";
    const same = saved.wsBrowserUrl ? await isSameBrowser(deps, saved.port, host, saved.wsBrowserUrl) : !saved.launchedByUs && await deps.discovery.isPortAlive(saved.port, host);
    if (same) {
      return {
        host,
        port: saved.port,
        launchedByUs: saved.launchedByUs,
        ...saved.pid !== void 0 ? { pid: saved.pid } : {},
        profile: saved.profile,
        headless: saved.headless
      };
    }
    clearSession();
  }
  return launch(deps, opts.binary, profile, headless, opts.kind);
}
function wantedKind(deps, kind, profile) {
  if (kind) return kind;
  const asked = deps.env("BROWSER_KIND")?.trim().toLowerCase();
  if (asked && !isBrowserKind(asked)) throw new UsageError(`${envName("BROWSER_KIND")} is "${asked}", not one of chrome, brave, chromium, edge`);
  return asked && isBrowserKind(asked) ? asked : readProfileKind(profile);
}
async function launch(deps, binary, profile, headless, kind) {
  const wanted = binary ? void 0 : wantedKind(deps, kind, profile);
  const found = binary ? { kind: kindOf(binary), path: binary } : deps.detectBrowser(wanted);
  if (!found && wanted) throw new UsageError(`no ${wanted} found: install it, or name its executable with ${envName("BROWSER_BIN")}`);
  if (!found) {
    throw new Error(`no Chrome, Brave, Chromium or Edge found: install one, or set ${envName("BROWSER_BIN")} to the browser's executable`);
  }
  const bin = found.path;
  const dir = profileDir(profile);
  ensurePrivateDir(browserHome());
  ensurePrivateDir(join16(browserHome(), "profiles"));
  ensurePrivateDir(dir);
  const portFile = join16(dir, "DevToolsActivePort");
  const running = await readActivePort(deps, portFile);
  if (running && await isSameBrowser(deps, running.port, "127.0.0.1", running.path)) {
    return { host: "127.0.0.1", port: running.port, launchedByUs: true, profile, headless };
  }
  const owner = readProfileKind(profile);
  if (owner && owner !== found.kind) {
    const named = binary !== void 0 || !!deps.env("BROWSER_BIN");
    const hint = named ? `; ${envName("BROWSER_BIN")} names a ${found.kind} binary` : `, or ${owner} (\`--browser-kind ${owner}\`)`;
    throw new UsageError(
      `the profile "${profile}" belongs to ${owner} (its logins are encrypted for that browser), not ${found.kind}: use a profile of its own (\`--profile ${found.kind}\`)${hint}`
    );
  }
  const extensions = extensionDirs(deps.env("BROWSER_EXTENSIONS"));
  const dropped = extensions.length > 0 && ignoresUnpackedExtensions(found);
  await deps.fs.rm(portFile, { force: true });
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...dropped ? [] : extensionArgs(extensions)
  ];
  if (headless) args.push("--headless=new");
  args.push("about:blank");
  const child = deps.spawn(bin, args, { detached: true, stdio: "ignore" });
  let failure2;
  child.on("exit", (code, signal) => {
    const how = code !== null ? `code ${code}` : `signal ${signal}`;
    const hint = code === 0 ? `; is a browser already running on the profile ${dir}?` : "";
    failure2 = `the browser exited before exposing a DevTools port (${how}${hint})`;
  });
  child.on("error", (err) => {
    failure2 = `could not start ${bin}: ${err.message}`;
  });
  child.unref();
  const deadline = deps.now() + STARTUP_TIMEOUT_MS;
  for (; ; ) {
    const active2 = await readActivePort(deps, portFile);
    if (active2 && await isSameBrowser(deps, active2.port, "127.0.0.1", active2.path)) {
      const port = active2.port;
      if (!owner) {
        try {
          writeProfileKind(profile, found.kind);
        } catch {
        }
      }
      const notes = dropped ? [unpackedIgnoredNote()] : [];
      return {
        host: "127.0.0.1",
        port,
        launchedByUs: true,
        spawned: true,
        ...child.pid !== void 0 ? { pid: child.pid } : {},
        profile,
        headless,
        ...notes.length ? { notes } : {}
      };
    }
    if (failure2) throw new Error(failure2);
    if (deps.now() >= deadline) {
      child.kill("SIGTERM");
      throw new Error(`${bin} did not expose a DevTools port within ${STARTUP_TIMEOUT_MS / 1e3} s (no usable ${portFile})`);
    }
    await deps.sleep(POLL_MS);
  }
}
async function readActivePort(deps, file) {
  let text;
  try {
    text = await deps.fs.readFile(file, "utf8");
  } catch {
    return void 0;
  }
  const [first = "", second = ""] = text.split("\n");
  const port = Number(first.trim());
  const path = second.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path) return void 0;
  return { port, path };
}
function socketPath(urlOrPath) {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return urlOrPath;
  }
}
async function isSameBrowser(deps, port, host, wsBrowserUrl) {
  try {
    const { webSocketDebuggerUrl } = await deps.discovery.getVersion(port, host);
    return socketPath(webSocketDebuggerUrl) === socketPath(wsBrowserUrl);
  } catch {
    return false;
  }
}
var STARTUP_TIMEOUT_MS, POLL_MS;
var init_launch = __esm({
  "src/browser/launch.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    init_deps();
    init_detect();
    init_discovery();
    init_extensions();
    init_profile();
    init_state();
    STARTUP_TIMEOUT_MS = 2e4;
    POLL_MS = 100;
  }
});

// src/browser/overlay.ts
async function backendIdOf(page, objectId) {
  const { node } = await page.send("DOM.describeNode", { objectId }, { timeoutMs: PROBE_TIMEOUT_MS4 });
  return typeof node?.backendNodeId === "number" && node.backendNodeId > 0 ? node.backendNodeId : void 0;
}
function releaseGroup(page) {
  page.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => {
  });
}
async function findOverlays(page) {
  try {
    const r = await page.send(
      "Runtime.evaluate",
      { expression: `(${OVERLAYS_SOURCE})()`, returnByValue: false, objectGroup: GROUP },
      { timeoutMs: PROBE_TIMEOUT_MS4 }
    );
    if (r.exceptionDetails || !r.result?.objectId) return [];
    const { result = [] } = await page.send(
      "Runtime.getProperties",
      { objectId: r.result.objectId, ownProperties: true },
      { timeoutMs: PROBE_TIMEOUT_MS4 }
    );
    const elements2 = result.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId).map((p) => p.value?.objectId);
    const ids = (await Promise.all(elements2.map((id) => backendIdOf(page, id)))).filter((id) => id !== void 0);
    return ids;
  } catch {
    return [];
  } finally {
    releaseGroup(page);
  }
}
async function overlayRootOf(page, objectId) {
  try {
    const call = (id, fn, byValue) => page.send(
      "Runtime.callFunctionOn",
      { objectId: id, functionDeclaration: fn, returnByValue: byValue, objectGroup: GROUP },
      { timeoutMs: PROBE_TIMEOUT_MS4 }
    );
    const root = await call(objectId, OVERLAY_ROOT_SOURCE, false);
    const rootId = root.result?.objectId;
    if (root.exceptionDetails || !rootId) return void 0;
    const backendNodeId = await backendIdOf(page, rootId);
    if (backendNodeId === void 0) return void 0;
    const info = (await call(rootId, OVERLAY_INFO_SOURCE, true)).result?.value;
    return { backendNodeId, what: typeof info?.what === "string" ? info.what : "an element", overlay: info?.overlay === true };
  } catch {
    return void 0;
  } finally {
    releaseGroup(page);
  }
}
var CONSENT_SELECTORS, BARE_TEXT_MAX, CONTROL_TAGS, CONTROL_ROLES, HELPERS, OVERLAYS_SOURCE, OVERLAY_ROOT_SOURCE, DESCRIBE_SOURCE, OVERLAY_INFO_SOURCE, READ_DOCUMENT, GROUP, PROBE_TIMEOUT_MS4;
var init_overlay = __esm({
  "src/browser/overlay.ts"() {
    "use strict";
    CONSENT_SELECTORS = [
      // OneTrust
      "#onetrust-consent-sdk",
      "#onetrust-banner-sdk",
      "#onetrust-pc-sdk",
      // Didomi
      "#didomi-host",
      "#didomi-notice",
      'div[class^="didomi-"]',
      // Sourcepoint
      '[id^="sp_message_container"]',
      // Quantcast Choice
      ".qc-cmp2-container",
      "#qc-cmp2-container",
      // Cookiebot
      "#CybotCookiebotDialog",
      "#CybotCookiebotDialogBodyUnderlay",
      // Usercentrics
      "#usercentrics-root",
      "#usercentrics-cmp-ui",
      // TrustArc
      "#truste-consent-track",
      "#consent_blackbar",
      'div[class^="truste_"]',
      // consentmanager.net, Commanders Act, Axeptio, Iubenda, Complianz, CookieYes, Osano, Borlabs, Google Funding Choices
      "#cmpbox",
      "#cmpbox2",
      "#tc-privacy-wrapper",
      "#axeptio_overlay",
      "#iubenda-cs-banner",
      "#cmplz-cookiebanner-container",
      ".cky-consent-container",
      ".osano-cm-window",
      "#BorlabsCookieBox",
      ".fc-consent-root",
      // The IAB TCF / GPP locator frames
      'iframe[name="__tcfapiLocator"]',
      'iframe[name="__cmpLocator"]',
      'iframe[name="__gppLocator"]'
    ];
    BARE_TEXT_MAX = 40;
    CONTROL_TAGS = ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "SUMMARY", "DETAILS"];
    CONTROL_ROLES = [
      "button",
      "link",
      "checkbox",
      "radio",
      "switch",
      "tab",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "textbox",
      "searchbox",
      "combobox",
      "slider",
      "spinbutton"
    ];
    HELPERS = `const up = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || n.host || null;
  const body = document.body;
  const roleOf = (el) => String((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
  const isDialog = (el) =>
    roleOf(el) === "dialog" ||
    roleOf(el) === "alertdialog" ||
    (!!el.getAttribute && el.getAttribute("aria-modal") === "true") ||
    (String(el.tagName || "").toUpperCase() === "DIALOG" && el.open === true);
  const CONSENT = ${JSON.stringify(CONSENT_SELECTORS.join(", "))};
  const isConsent = (el) => {
    try {
      return !!el.matches && el.matches(CONSENT);
    } catch (e) {
      return false;
    }
  };
  const CONTROL_TAGS = ${JSON.stringify(CONTROL_TAGS)};
  const CONTROL_ROLES = ${JSON.stringify(CONTROL_ROLES)};
  /** Something to act on: a native control, a control role, a focusable (tabindex >= 0) or editable element. */
  const isControl = (el) => {
    const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "A") return attr("href") !== null;
    if (tag === "INPUT") return String(attr("type") || "").toLowerCase() !== "hidden";
    if (CONTROL_TAGS.indexOf(tag) >= 0 || CONTROL_ROLES.indexOf(roleOf(el)) >= 0) return true;
    const tab = attr("tabindex");
    if (tab !== null && tab !== "" && Number(tab) >= 0) return true;
    const edit = attr("contenteditable");
    return edit === "" || edit === "true" || edit === "plaintext-only";
  };
  const textLength = (n) => String((typeof n.innerText === "string" ? n.innerText : n.textContent) || "").replace(/\\s+/g, " ").trim().length;
  /**
   * Nothing to answer in it: no control, itself or inside (open shadow roots
   * included), and under ${BARE_TEXT_MAX} characters of text. An ad slot holding
   * an image is one; a cookie wall, a login dialog, a notice to read are not.
   * Never bare: a consent vendor's container (its buttons may be plain divs),
   * nor anything holding a custom element with no open shadow root (a closed
   * one hides its text and controls from here).
   */
  const bare = (el) => {
    let text = textLength(el);
    const stack = [el];
    for (let seen = 0; stack.length > 0; seen++) {
      // Too big to look through: whatever it is, it is no empty layer.
      if (text >= ${BARE_TEXT_MAX} || seen > 5000) return false;
      const n = stack.pop();
      if (n.nodeType === 1 && (isControl(n) || isConsent(n))) return false;
      if (n.nodeType === 1 && String(n.tagName || "").indexOf("-") >= 0 && !n.shadowRoot) return false;
      for (const k of Array.from(n.children || [])) stack.push(k);
      if (n.shadowRoot) {
        for (const k of Array.from(n.shadowRoot.children || [])) {
          text += textLength(k);
          stack.push(k);
        }
      }
    }
    return text < ${BARE_TEXT_MAX};
  };
  /** Fixed or sticky, itself or an ancestor up to the body: what a click's covering node belongs to. */
  const pinned = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  };`;
    OVERLAYS_SOURCE = `function findOverlays() {
  ${HELPERS}
  const found = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!body || !(vw > 0) || !(vh > 0)) return found;
  const isMain = (el) => String(el.tagName || "").toUpperCase() === "MAIN" || roleOf(el) === "main";
  const holdsMain = (el) => isMain(el) || Array.prototype.some.call(el.querySelectorAll("*"), isMain);
  const textOf = (el) => String(el.textContent || "").length;
  const pageText = textOf(body);
  const fixed = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) if (getComputedStyle(n).position === "fixed") return true;
    return false;
  };
  /** Out of the flow of the page, itself or an ancestor: what can be over something. */
  const floating = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "absolute") return true;
    }
    return false;
  };
  const hiddenUp = (el) => {
    for (let n = el; n && n.nodeType === 1; n = up(n)) {
      if (n.getAttribute && (n.getAttribute("aria-hidden") === "true" || n.getAttribute("inert") !== null)) return true;
      const cs = getComputedStyle(n);
      if (cs.display === "none" || Number(cs.opacity) === 0) return true;
    }
    return false;
  };
  const shown = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
    return !hiddenUp(el);
  };
  /** The part of the viewport the element covers, or null when it is under 30%. */
  const area = (el) => {
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const w = Math.min(r.right, vw) - left;
    const h = Math.min(r.bottom, vh) - top;
    return w > 0 && h > 0 && w * h >= 0.3 * vw * vh ? { left, top, w, h } : null;
  };
  const covers = (el, a) => {
    // A side column is no overlay: one is wide, or strictly across the middle of the screen.
    const middle = a.left < vw / 2 && a.left + a.w > vw / 2 && a.top < vh / 2 && a.top + a.h > vh / 2;
    if (a.w < 0.6 * vw && !middle) return false;
    const root = el.getRootNode ? el.getRootNode() : document;
    const at = (root && root.elementFromPoint ? root : document).elementFromPoint(a.left + a.w / 2, a.top + a.h / 2);
    for (let n = at; n; n = up(n)) if (n === el) return true;
    return false;
  };
  const kids = (n) => Array.from((n && n.children) || []);
  const visit = (el, inShell) => {
    let shell = inShell;
    let take = false;
    const role = roleOf(el);
    if (isConsent(el)) take = shown(el) && !holdsMain(el);
    else if (isDialog(el)) take = floating(el) && shown(el) && !holdsMain(el);
    else if (!inShell && role !== "presentation" && role !== "none") {
      const a = area(el);
      if (a && fixed(el) && shown(el) && covers(el, a)) {
        if (holdsMain(el) || (pageText > 0 && textOf(el) > 0.6 * pageText)) shell = true;
        else take = true;
      }
    }
    // An overlay is taken whole: what is inside it is its own. A bare one is none, nor is anything inside it.
    if (take && bare(el)) return;
    if (take) {
      found.push(el);
      return;
    }
    for (const k of kids(el)) visit(k, shell);
    if (el.shadowRoot) for (const k of kids(el.shadowRoot)) visit(k, shell);
  };
  for (const k of kids(body)) visit(k, false);
  return found.slice(0, 5);
}`;
    OVERLAY_ROOT_SOURCE = `function overlayRoot() {
  ${HELPERS}
  const overlays = (${OVERLAYS_SOURCE})();
  for (let n = this; n; n = up(n)) if (overlays.indexOf(n) >= 0) return n;
  let outer = null;
  for (let n = this; n && n !== body && n !== document.documentElement; n = up(n)) {
    if (n.nodeType !== 1) continue;
    if (isDialog(n)) return n;
    if (pinned(n) && !pinned(up(n) || body)) outer = n;
  }
  return outer;
}`;
    DESCRIBE_SOURCE = `const describe = (el) => {
    const tag = String(el.tagName || "").toLowerCase();
    const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
    const role = attr("role");
    const type = tag === "input" ? attr("type") : null;
    const text = String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    const shown = text.length > 60 ? text.slice(0, 57) + "..." : text;
    return "<" + tag + (el.id ? "#" + el.id : "") + (role ? ' role="' + role + '"' : "") + (type ? ' type="' + type + '"' : "") + ">" + (shown ? ' "' + shown + '"' : "");
  };`;
    OVERLAY_INFO_SOURCE = `function overlayInfo() {
  ${HELPERS}
  ${DESCRIBE_SOURCE}
  const overlays = (${OVERLAYS_SOURCE})();
  return { what: describe(this), overlay: (overlays.indexOf(this) >= 0 || isDialog(this) || isConsent(this)) && !bare(this) };
}`;
    READ_DOCUMENT = `(() => {
  const findOverlays = ${OVERLAYS_SOURCE};
  const root = document.documentElement;
  if (!root) return { html: "", url: location.href };
  const mark = "data-overlay-" + Math.random().toString(36).slice(2, 10);
  let overlays = [];
  let html = "";
  try {
    try {
      overlays = findOverlays();
    } catch (e) {}
    for (const el of overlays) if (el.getRootNode && el.getRootNode() === document) el.setAttribute(mark, "");
    html = root.outerHTML;
  } finally {
    for (const el of overlays) if (el.removeAttribute) el.removeAttribute(mark);
  }
  let parsed;
  try {
    parsed = new DOMParser().parseFromString(html, "text/html");
  } catch (e) {
    return { html, url: location.href };
  }
  const drop = ["[" + mark + "]", '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', "dialog", ${CONSENT_SELECTORS.map((s) => JSON.stringify(s)).join(", ")}];
  const keep = (el) =>
    el === parsed.body || el === parsed.documentElement || el.tagName === "MAIN" || el.getAttribute("role") === "main" || !!el.querySelector("main, [role=main]");
  for (const sel of drop) {
    let els = [];
    try {
      els = Array.from(parsed.querySelectorAll(sel));
    } catch (e) {}
    for (const el of els) if (!keep(el)) el.remove();
  }
  return { html: parsed.documentElement.outerHTML, url: location.href };
})()`;
    GROUP = "overlay-probe";
    PROBE_TIMEOUT_MS4 = 5e3;
  }
});

// src/browser/session.ts
import { join as join17 } from "path";
function cleanTabs(v) {
  const out = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [id, targetId] of Object.entries(v)) if (TAB_ID.test(id) && typeof targetId === "string") out[id] = targetId;
  return out;
}
function syncTabs(map, pages) {
  const live = new Set(pages.map((p) => p.id));
  let high = 0;
  const out = {};
  const kept = /* @__PURE__ */ new Set();
  for (const [id, targetId] of Object.entries(map)) {
    high = Math.max(high, tabNumber(id));
    if (live.has(targetId) && !kept.has(targetId)) {
      out[id] = targetId;
      kept.add(targetId);
    }
  }
  const unseen = pages.map((p) => p.id).filter((id) => !kept.has(id));
  for (const id of unseen.sort()) out[`t${++high}`] = id;
  return out;
}
function pick(tabs, id) {
  const tab = tabs.find((t) => t.id === id || t.targetId === id);
  if (!tab) throw new Error(`no tab ${id}: list the tabs to see their ids`);
  return tab;
}
function tabList(map, pages, current2) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  return Object.entries(map).sort(([a], [b]) => tabNumber(a) - tabNumber(b)).map(([id, targetId]) => {
    const p = byId.get(targetId);
    return { id, targetId, url: p?.url ?? "", title: p?.title ?? "", active: targetId === current2 };
  });
}
async function createTarget(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  return targetId;
}
async function attachPage(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = cdp.session(sessionId);
  const o = { timeoutMs: ATTACH_TIMEOUT_MS };
  try {
    await Promise.all([
      page.send("Page.enable", void 0, o),
      page.send("Runtime.enable", void 0, o),
      page.send("DOM.enable", void 0, o),
      page.send("Page.setLifecycleEventsEnabled", { enabled: true }, o)
    ]);
  } catch (e) {
    if (e instanceof CdpError || cdp.closed) throw e;
    throw new Error(
      `the tab does not answer; most likely a JavaScript dialog the page opened between commands \u2014 answer it in the window, or \`${brand().cli} browser close\``
    );
  }
  return sessionId;
}
async function closeLaunched(cdp, pid, deps) {
  try {
    await cdp.send("Browser.close", void 0, { timeoutMs: BROWSER_CLOSE_TIMEOUT_MS });
  } catch {
    if (cdp.closed || pid === void 0) return;
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
    }
  }
}
function forget(targetIds, all) {
  clearSession();
  if (all) {
    clearRefs();
    clearNetwork();
    return;
  }
  for (const id of new Set(targetIds)) {
    clearRefs(id);
    clearNetwork(id);
  }
}
async function openBrowserSession(opts = {}) {
  const deps = browserDeps(opts.deps);
  const endpoint = await resolveEndpoint({ ...opts, deps });
  const saved = readSession();
  const same = saved !== null && saved.port === endpoint.port && (saved.host ?? "127.0.0.1") === endpoint.host ? saved : null;
  const { webSocketDebuggerUrl } = await deps.discovery.getVersion(endpoint.port, endpoint.host);
  const cdp = await deps.connectCdp(loopbackSocketUrl(webSocketDebuggerUrl));
  let created;
  try {
    const pages = await deps.discovery.listPages(endpoint.port, endpoint.host);
    let targetId;
    if (opts.newTab || opts.scratch) targetId = created = await createTarget(cdp);
    else if (same && pages.some((p) => p.id === same.targetId)) targetId = same.targetId;
    else targetId = pages[0]?.id ?? await createTarget(cdp);
    const sessionId = await attachPage(cdp, targetId);
    const session = new BrowserSession(cdp, endpoint, webSocketDebuggerUrl, deps, targetId, sessionId, cleanTabs(same?.tabs), opts.scratch);
    if (!opts.scratch) await session.listTabs();
    if (opts.url !== void 0) await session.navigate(opts.url);
    return session;
  } catch (e) {
    if (created !== void 0) await deps.discovery.closeTarget(endpoint.port, created, endpoint.host).catch(() => {
    });
    await cdp.close();
    throw e;
  }
}
async function browserStatus(opts = {}) {
  const deps = browserDeps(opts.deps);
  const saved = readSession();
  if (!saved) return { alive: false };
  const host = saved.host ?? "127.0.0.1";
  const base2 = { port: saved.port, launchedByUs: saved.launchedByUs, profile: saved.profile, headless: saved.headless, targetId: saved.targetId };
  let pages;
  try {
    pages = await deps.discovery.listPages(saved.port, host);
  } catch {
    return { alive: false, ...base2 };
  }
  let map = syncTabs(cleanTabs(saved.tabs), pages);
  if (!sameTabs(map, cleanTabs(saved.tabs))) {
    try {
      map = await withBrowserLock(
        async () => {
          const current2 = readSession();
          if (!current2 || current2.port !== saved.port || (current2.host ?? "127.0.0.1") !== host) return map;
          const next = syncTabs(cleanTabs(current2.tabs), pages);
          writeSession({ ...current2, tabs: next, updatedAt: deps.now() });
          return next;
        },
        { deps, waitMs: 2e3 }
      );
    } catch {
    }
  }
  const tabs = tabList(map, pages, saved.targetId);
  const cur = tabs.find((t) => t.active);
  return { alive: true, ...base2, url: cur?.url ?? "", title: cur?.title ?? "", tabs };
}
async function closeAt(deps, port, host, pid) {
  const cdp = await deps.connectCdp(loopbackSocketUrl((await deps.discovery.getVersion(port, host)).webSocketDebuggerUrl));
  try {
    await closeLaunched(cdp, pid, deps);
  } finally {
    await cdp.close();
  }
}
async function closeBrowser(opts = {}) {
  const deps = browserDeps(opts.deps);
  const saved = readSession();
  const host = saved?.host ?? "127.0.0.1";
  const live = !saved ? false : saved.wsBrowserUrl ? await isSameBrowser(deps, saved.port, host, saved.wsBrowserUrl) : !saved.launchedByUs && await deps.discovery.isPortAlive(saved.port, host);
  let closed = false;
  let launchedByUs = saved?.launchedByUs ?? false;
  if (saved?.launchedByUs && live) {
    await closeAt(deps, saved.port, host, saved.pid);
    closed = true;
  } else if (!live) {
    const own = await readActivePort(deps, join17(profileDir(opts.profile ?? saved?.profile), "DevToolsActivePort"));
    if (own && await isSameBrowser(deps, own.port, "127.0.0.1", own.path)) {
      await closeAt(deps, own.port, "127.0.0.1", void 0);
      closed = launchedByUs = true;
    }
  }
  forget(saved ? [saved.targetId, ...Object.values(cleanTabs(saved.tabs))] : [], opts.all);
  return { closed, launchedByUs };
}
async function withPage(opts, fn) {
  const deps = browserDeps(opts.deps);
  return withBrowserLock(
    async () => {
      const session = await openBrowserSession({ ...opts, deps });
      try {
        const out = await fn(session);
        session.save();
        return out;
      } finally {
        await session.detach();
      }
    },
    { deps }
  );
}
var NAVIGATION_TIMEOUT_MS, BROWSER_CLOSE_TIMEOUT_MS, STATUS_TIMEOUT_MS, ATTACH_TIMEOUT_MS, TAB_ID, LIFECYCLE, NavigationTimeoutError, committedIn, stillLoading, sameTabs, tabNumber, BrowserSession;
var init_session = __esm({
  "src/browser/session.ts"() {
    "use strict";
    init_brand();
    init_cdp();
    init_deps();
    init_discovery();
    init_launch();
    init_profile();
    init_state();
    NAVIGATION_TIMEOUT_MS = 3e4;
    BROWSER_CLOSE_TIMEOUT_MS = 5e3;
    STATUS_TIMEOUT_MS = 2e3;
    ATTACH_TIMEOUT_MS = 5e3;
    TAB_ID = /^t([1-9]\d*)$/;
    LIFECYCLE = { load: "load", domcontentloaded: "DOMContentLoaded" };
    NavigationTimeoutError = class extends Error {
    };
    committedIn = (frameId, isNew) => (e) => e.frameId === frameId && isNew(e.loaderId) && (e.kind === "commit" || e.kind === "lifecycle" && e.name !== "init");
    stillLoading = (timeoutMs) => `still loading after ${timeoutMs} ms \u2014 take a snapshot or \`${brand().cli} browser wait --load\``;
    sameTabs = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
    tabNumber = (id) => Number(TAB_ID.exec(id)?.[1] ?? 0);
    BrowserSession = class {
      /** @internal use openBrowserSession */
      constructor(cdp, endpoint, wsBrowserUrl, deps, targetId, sessionId, tabs, scratch = false) {
        this.cdp = cdp;
        this.endpoint = endpoint;
        this.wsBrowserUrl = wsBrowserUrl;
        this.deps = deps;
        this.scratch = scratch;
        this.current = { targetId, sessionId, page: cdp.session(sessionId) };
        this.tabs = tabs;
      }
      cdp;
      endpoint;
      wsBrowserUrl;
      deps;
      scratch;
      tabs;
      current;
      /** Targets closed by this session that /json/list may still report for a moment. */
      closed = /* @__PURE__ */ new Set();
      /** Dialog listeners, each bound to the current tab's session and moved with it. */
      dialogListeners = /* @__PURE__ */ new Map();
      ended = false;
      get port() {
        return this.endpoint.port;
      }
      get host() {
        return this.endpoint.host;
      }
      get launchedByUs() {
        return this.endpoint.launchedByUs;
      }
      /** Whether opening this session started the browser (not a reuse of one already running). */
      get spawned() {
        return this.endpoint.spawned === true;
      }
      /** The browser-level socket URL: its path names this run of the browser and no other. */
      get browserSocket() {
        return this.wsBrowserUrl;
      }
      get pid() {
        return this.endpoint.pid;
      }
      get profile() {
        return this.endpoint.profile;
      }
      get headless() {
        return this.endpoint.headless;
      }
      /** What the launch had to say (extensions the browser will not load), once: the next call gets nothing. */
      takeNotes() {
        const notes = this.endpoint.notes ?? [];
        this.endpoint.notes = void 0;
        return notes;
      }
      get targetId() {
        return this.current.targetId;
      }
      get sessionId() {
        return this.current.sessionId;
      }
      /** The current tab's flat session. It changes with selectTab/newTab/closeTab: read it, do not keep it. */
      get page() {
        return this.current.page;
      }
      /** Write session.json (port, ownership, current tab, tab ids). A no-op once shut down, and for a scratch tab. */
      save() {
        if (this.ended || this.scratch) return;
        const { host, port, pid, launchedByUs, profile, headless } = this.endpoint;
        writeSession({
          version: 1,
          ...host !== "127.0.0.1" ? { host } : {},
          port,
          wsBrowserUrl: this.wsBrowserUrl,
          ...pid !== void 0 ? { pid } : {},
          launchedByUs,
          profile,
          headless,
          targetId: this.targetId,
          tabs: this.tabs,
          updatedAt: this.deps.now()
        });
      }
      // --- page --------------------------------------------------------------------
      async frame() {
        const { frameTree } = await this.page.send("Page.getFrameTree");
        return frameTree.frame;
      }
      async currentUrl() {
        const f = await this.frame();
        return f.url + (f.urlFragment ?? "");
      }
      async loaderId() {
        return (await this.frame()).loaderId;
      }
      async title() {
        const { targetInfo } = await this.cdp.send("Target.getTargetInfo", { targetId: this.targetId });
        return targetInfo.title ?? "";
      }
      /** The document's HTTP status from the Navigation Timing entry; undefined when the page does not say. */
      async responseStatus() {
        try {
          const r = await this.page.send(
            "Runtime.evaluate",
            { expression: "performance.getEntriesByType('navigation')[0]?.responseStatus", returnByValue: true },
            { timeoutMs: STATUS_TIMEOUT_MS }
          );
          const v = r.result?.value;
          return typeof v === "number" && v > 0 ? v : void 0;
        } catch {
          return void 0;
        }
      }
      async loaded() {
        const f = await this.frame();
        const status = await this.responseStatus();
        return { url: f.url + (f.urlFragment ?? ""), loaderId: f.loaderId, ...status !== void 0 ? { status } : {} };
      }
      /**
       * Start recording navigation events BEFORE the command that causes them: the
       * browser may report the new document's lifecycle before it answers the
       * command itself, and an event listened for too late never comes again.
       */
      watch() {
        const page = this.page;
        const seen = [];
        let wake;
        let closed = false;
        let leaving = false;
        let cancelled = false;
        const push = (e) => {
          seen.push(e);
          wake?.();
        };
        const handlers = [
          ["Page.lifecycleEvent", (p) => push({ kind: "lifecycle", frameId: p.frameId, loaderId: p.loaderId, name: p.name })],
          ["Page.navigatedWithinDocument", (p) => push({ kind: "same-document", frameId: p.frameId })],
          // A page restored from the back/forward cache fires no lifecycle event. Any other is a new
          // document committing: in the main frame, what a navigation that has not loaded yet has got to.
          [
            "Page.frameNavigated",
            (p) => {
              if (p.type === "BackForwardCacheRestore") push({ kind: "bfcache", frameId: p.frame?.id, loaderId: p.frame?.loaderId });
              else if (p.frame && !p.frame.parentId) push({ kind: "commit", frameId: p.frame.id, loaderId: p.frame.loaderId });
            }
          ],
          ["Page.javascriptDialogOpening", (p) => leaving = p?.type === "beforeunload"],
          [
            "Page.javascriptDialogClosed",
            (p) => {
              if (leaving && p?.result === false) {
                cancelled = true;
                wake?.();
              }
              leaving = false;
            }
          ]
        ];
        for (const [method, h] of handlers) page.on(method, h);
        const offClose = this.cdp.onClose(() => {
          closed = true;
          wake?.();
        });
        return {
          stop: () => {
            for (const [method, h] of handlers) page.off(method, h);
            offClose();
          },
          /** Whether such an event has come, whatever was waited for. */
          saw: (match) => seen.some(match),
          until: (match, timeoutMs, what, cancelledWhat) => new Promise((resolve12, reject) => {
            const timer = setTimeout(() => {
              wake = void 0;
              reject(new NavigationTimeoutError(`${what} within ${timeoutMs} ms`));
            }, timeoutMs);
            wake = () => {
              const hit = seen.find(match);
              if (hit) resolve12(hit);
              else if (cancelled) reject(new Error(`${cancelledWhat} was cancelled: the page asked to confirm leaving it (beforeunload), and that was declined`));
              else if (closed) reject(new Error("the browser connection closed while waiting for the page to load"));
              else return;
              clearTimeout(timer);
              wake = void 0;
            };
            wake();
          })
        };
      }
      /**
       * Load `url` in the current tab and wait for the new document's `load` (or
       * `DOMContentLoaded`, or nothing). The tab's refs are cleared: they named
       * nodes of the document that is going away. A navigation the browser refuses
       * (`errorText`: DNS failure, refused connection…) rejects, and so does one
       * that did not even commit in time. One that committed but has not loaded
       * (a cold server, a render-blocking script that holds even DOMContentLoaded)
       * is the page now, still loading: it resolves, with a `note`.
       */
      async navigate(url, opts = {}) {
        const waitUntil = opts.waitUntil ?? "load";
        const timeoutMs = opts.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
        const nav = this.watch();
        try {
          const r = await this.page.send("Page.navigate", { url }, { timeoutMs });
          if (r.errorText) throw new Error(`navigation to ${url} failed: ${r.errorText}`);
          if (!r.loaderId) {
            const f = await this.frame();
            return { url: f.url + (f.urlFragment ?? ""), loaderId: f.loaderId };
          }
          clearRefs(this.targetId);
          if (waitUntil === "none") return { url, loaderId: r.loaderId };
          const name2 = LIFECYCLE[waitUntil];
          try {
            await nav.until(
              (e) => e.kind === "lifecycle" && e.name === name2 && e.loaderId === r.loaderId,
              timeoutMs,
              `navigation to ${url} did not reach ${name2}`,
              `navigation to ${url}`
            );
          } catch (e) {
            if (!(e instanceof NavigationTimeoutError) || !nav.saw(committedIn(r.frameId, (l) => l === r.loaderId))) throw e;
            return { ...await this.loaded(), note: stillLoading(timeoutMs) };
          }
          return await this.loaded();
        } finally {
          nav.stop();
        }
      }
      /**
       * Run a history move or a reload and wait until the main frame shows another
       * document (or the same one, scrolled). One that committed but has not loaded
       * in time resolves with a `note`, as in navigate.
       */
      async settle(what, trigger, timeoutMs = NAVIGATION_TIMEOUT_MS) {
        const before = await this.frame();
        const nav = this.watch();
        try {
          await trigger(timeoutMs);
          const isNew = (l) => l !== before.loaderId;
          let hit;
          try {
            hit = await nav.until(
              (e) => e.frameId === before.id && (e.kind === "same-document" || e.kind === "bfcache" || e.kind === "lifecycle" && e.name === "load" && isNew(e.loaderId)),
              timeoutMs,
              `${what} did not reach load`,
              what
            );
          } catch (e) {
            if (!(e instanceof NavigationTimeoutError) || !nav.saw(committedIn(before.id, isNew))) throw e;
            clearRefs(this.targetId);
            return { ...await this.loaded(), note: stillLoading(timeoutMs) };
          }
          if (hit.kind !== "same-document") clearRefs(this.targetId);
          return await this.loaded();
        } finally {
          nav.stop();
        }
      }
      async history(step, timeoutMs) {
        const h = await this.page.send("Page.getNavigationHistory");
        const entry = h.entries[h.currentIndex + step];
        if (!entry) throw new Error(step < 0 ? "no previous page in this tab's history" : "no next page in this tab's history");
        return this.settle(
          step < 0 ? "going back" : "going forward",
          (t) => this.page.send("Page.navigateToHistoryEntry", { entryId: entry.id }, { timeoutMs: t }),
          timeoutMs
        );
      }
      back(opts = {}) {
        return this.history(-1, opts.timeoutMs);
      }
      forward(opts = {}) {
        return this.history(1, opts.timeoutMs);
      }
      reload(opts = {}) {
        return this.settle("reloading", (t) => this.page.send("Page.reload", void 0, { timeoutMs: t }), opts.timeoutMs);
      }
      // --- tabs --------------------------------------------------------------------
      /** The browser's tabs with their stable short ids; the map is refreshed and saved. */
      async listTabs() {
        const pages = (await this.deps.discovery.listPages(this.port, this.host)).filter((p) => !this.closed.has(p.id));
        this.tabs = syncTabs(this.tabs, pages);
        this.save();
        return tabList(this.tabs, pages, this.targetId);
      }
      /**
       * Hear the JavaScript dialogs of whichever tab is current, across tab
       * switches, each with the page session that can answer it. Returns its unsubscribe.
       */
      onDialog(listener) {
        this.hookDialogs(listener, this.page);
        return () => {
          const h = this.dialogListeners.get(listener);
          if (h) this.page.off("Page.javascriptDialogOpening", h);
          this.dialogListeners.delete(listener);
        };
      }
      hookDialogs(listener, page) {
        const h = (p) => listener({ type: String(p?.type ?? "alert"), message: String(p?.message ?? ""), ...typeof p?.url === "string" ? { url: p.url } : {} }, page);
        page.on("Page.javascriptDialogOpening", h);
        this.dialogListeners.set(listener, h);
      }
      /** Move this session onto another tab: attach to it, let go of the old one, bring it to the front. */
      async switchTo(targetId) {
        const old = this.current.sessionId;
        const sessionId = await attachPage(this.cdp, targetId);
        const oldPage = this.current.page;
        this.current = { targetId, sessionId, page: this.cdp.session(sessionId) };
        for (const [listener, h] of [...this.dialogListeners]) {
          oldPage.off("Page.javascriptDialogOpening", h);
          this.hookDialogs(listener, this.current.page);
        }
        await this.cdp.send("Target.detachFromTarget", { sessionId: old }).catch(() => {
        });
        await this.deps.discovery.activateTarget(this.port, targetId, this.host);
        this.save();
      }
      async selectTab(id) {
        const tab = pick(await this.listTabs(), id);
        await this.switchTo(tab.targetId);
        return { ...tab, active: true };
      }
      /** Open a tab, make it current and, given a url, load it. */
      async newTab(url, opts = {}) {
        const targetId = await createTarget(this.cdp);
        try {
          await this.switchTo(targetId);
        } catch (e) {
          await this.deps.discovery.closeTarget(this.port, targetId, this.host).catch(() => {
          });
          throw e;
        }
        if (url !== void 0) await this.navigate(url, opts);
        return pick(await this.listTabs(), targetId);
      }
      /**
       * Close a tab and forget its refs and network log. Closing the current tab
       * moves to another one first; closing the last opens a blank one, since a
       * browser left with no tab may quit.
       */
      async closeTab(id) {
        const tabs = await this.listTabs();
        const tab = pick(tabs, id);
        if (tab.targetId === this.targetId) {
          const next = tabs.find((t) => t.targetId !== tab.targetId);
          await this.switchTo(next ? next.targetId : await createTarget(this.cdp));
        }
        await this.deps.discovery.closeTarget(this.port, tab.targetId, this.host);
        this.closed.add(tab.targetId);
        clearRefs(tab.targetId);
        clearNetwork(tab.targetId);
        await this.listTabs();
      }
      // --- lifetime ------------------------------------------------------------------
      /** Close the socket only. The browser and its tabs keep running; the next call reconnects. */
      async detach() {
        await this.cdp.close();
      }
      /**
       * End the session. A browser we launched is closed (`Browser.close`, then
       * SIGTERM to its pid if it refuses); one we attached to is left running. Either
       * way session.json and our tabs' refs and network logs go (every tab's with `all`).
       */
      async shutdown(opts = {}) {
        this.ended = true;
        if (this.launchedByUs) await closeLaunched(this.cdp, this.pid, this.deps);
        await this.cdp.close();
        forget([this.targetId, ...Object.values(this.tabs)], opts.all);
      }
      async status() {
        const tabs = await this.listTabs();
        const cur = tabs.find((t) => t.active);
        return {
          alive: true,
          port: this.port,
          launchedByUs: this.launchedByUs,
          profile: this.profile,
          headless: this.headless,
          targetId: this.targetId,
          url: cur?.url ?? "",
          title: cur?.title ?? "",
          tabs
        };
      }
    };
  }
});

// src/browser/wait.ts
async function watchNetwork(page) {
  const inflight2 = /* @__PURE__ */ new Set();
  const handlers = [
    ["Network.requestWillBeSent", (p) => inflight2.add(String(p.requestId))],
    ["Network.loadingFinished", (p) => inflight2.delete(String(p.requestId))],
    ["Network.loadingFailed", (p) => inflight2.delete(String(p.requestId))]
  ];
  for (const [m, h] of handlers) page.on(m, h);
  await page.send("Network.enable").catch(() => {
  });
  return {
    count: () => inflight2.size,
    stop: () => {
      for (const [m, h] of handlers) page.off(m, h);
    }
  };
}
async function evaluate(page, expression) {
  try {
    const r = await page.send("Runtime.evaluate", { expression, returnByValue: true }, { timeoutMs: EVAL_TIMEOUT_MS });
    return r.result?.value;
  } catch {
    return void 0;
  }
}
function urlMatcher(pattern) {
  const re = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2]);
      return (u) => rx.test(u);
    } catch {
    }
  }
  if (pattern.includes("*")) {
    const rx = new RegExp(
      `^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`
    );
    return (u) => rx.test(u);
  }
  return (u) => u.includes(pattern);
}
function checker(page, cond, now, net) {
  const hasText = (t) => evaluate(page, `(document.body ? document.body.innerText : "").includes(${JSON.stringify(t)})`);
  if ("text" in cond) return async () => await hasText(cond.text) === true;
  if ("gone" in cond) return async () => await hasText(cond.gone) === false;
  if ("selector" in cond) {
    const sel = JSON.stringify(cond.selector);
    return async () => await evaluate(
      page,
      `(() => { try { const el = document.querySelector(${sel}); return !!el && el.getClientRects().length > 0; } catch { return false; } })()`
    ) === true;
  }
  if ("url" in cond) {
    const match = urlMatcher(cond.url);
    return async () => {
      const href = await evaluate(page, "location.href");
      return typeof href === "string" && match(href);
    };
  }
  if ("load" in cond) return async () => await evaluate(page, 'document.readyState === "complete"') === true;
  if ("idle" in cond) {
    let quietSince;
    return async () => {
      if ((net?.count() ?? 0) > 0) {
        quietSince = void 0;
        return false;
      }
      quietSince ??= now();
      return now() - quietSince >= IDLE_MS;
    };
  }
  let streak = 0;
  return async () => {
    const probe = await probeChallenge({ page });
    streak = probe.ok && !probe.challenge?.blocking ? streak + 1 : 0;
    return streak >= 2;
  };
}
async function waitFor(session, cond, opts = {}) {
  const present = KEYS.filter((k) => k in cond);
  if (present.length !== 1) throw new TypeError(`invalid wait condition ${JSON.stringify(cond)}: give exactly one of ${KEYS.join(", ")}`);
  const { now, sleep: sleep2 } = browserDeps(opts.deps);
  const start = now();
  const live = () => {
    if (opts.signal?.aborted) throw new WaitCancelledError();
  };
  if ("ms" in cond) {
    for (let left = cond.ms; ; left = cond.ms - (now() - start)) {
      live();
      if (left <= 0) break;
      await sleep2(Math.min(POLL_MS2, left));
    }
    return { waitedMs: now() - start, matched: "ms" };
  }
  const timeoutMs = opts.timeoutMs ?? ("clear" in cond ? CLEAR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS3);
  const net = "idle" in cond ? await watchNetwork(session.page) : void 0;
  try {
    const check = checker(session.page, cond, now, net);
    for (; ; ) {
      live();
      if (await check()) return { waitedMs: now() - start, matched: present[0] };
      const elapsed = now() - start;
      if (elapsed >= timeoutMs) throw new WaitTimeoutError(cond, elapsed);
      await sleep2(Math.min(POLL_MS2, timeoutMs - elapsed));
    }
  } finally {
    net?.stop();
  }
}
async function armSettle(session, opts = {}) {
  const { page } = session;
  const { now, sleep: sleep2 } = browserDeps(opts.deps);
  const timeoutMs = opts.timeoutMs ?? SETTLE_TIMEOUT_MS;
  let mainId;
  let armedLoader;
  const started = /* @__PURE__ */ new Set();
  const stopped = /* @__PURE__ */ new Set();
  const committed = /* @__PURE__ */ new Map();
  const loads = /* @__PURE__ */ new Map();
  const handlers = [
    [
      "Page.frameStartedLoading",
      (p) => {
        const id = String(p.frameId);
        started.add(id);
        stopped.delete(id);
        committed.delete(id);
        loads.delete(id);
      }
    ],
    [
      "Page.frameNavigated",
      (p) => {
        if (p.frame?.parentId) return;
        const id = String(p.frame?.id);
        mainId ??= p.frame?.id;
        started.add(id);
        stopped.delete(id);
        committed.set(id, p.frame?.loaderId ?? "");
      }
    ],
    [
      "Page.lifecycleEvent",
      (p) => {
        if (p.name !== "load") return;
        const id = String(p.frameId);
        loads.set(id, [...loads.get(id) ?? [], p.loaderId ?? ""]);
      }
    ],
    // A download or a 204 stops loading without ever firing load. Only a stop after a start is the navigation's.
    ["Page.frameStoppedLoading", (p) => started.has(String(p.frameId)) && stopped.add(String(p.frameId))]
  ];
  for (const [m, h] of handlers) page.on(m, h);
  const net = await watchNetwork(page);
  let released = false;
  const stop = () => {
    if (released) return;
    released = true;
    for (const [m, h] of handlers) page.off(m, h);
    net.stop();
  };
  const tree = async () => {
    try {
      const f = (await page.send("Page.getFrameTree")).frameTree.frame;
      return { id: f.id, loaderId: f.loaderId };
    } catch {
      return {};
    }
  };
  const t = await tree();
  mainId ??= t.id;
  armedLoader = t.loaderId;
  let used = false;
  return {
    async done() {
      if (released && !used) return { navigated: false, waitedMs: 0 };
      if (used) throw new Error("this settle was already awaited");
      used = true;
      const start = now();
      const deadline = start + timeoutMs;
      const step = () => sleep2(Math.min(SETTLE_STEP_MS, Math.max(deadline - now(), 0)));
      const sawNavigation = () => mainId !== void 0 && started.has(mainId);
      const navigationFinished = () => {
        if (mainId === void 0) return false;
        if (stopped.has(mainId)) return true;
        const commit = committed.get(mainId);
        return (loads.get(mainId) ?? []).some((l) => l === "" || (commit !== void 0 ? commit === "" || l === commit : l !== armedLoader));
      };
      try {
        let committedElsewhere = false;
        let docLoading = false;
        if (!sawNavigation()) {
          const t2 = await tree();
          const readyState = await evaluate(page, "document.readyState");
          committedElsewhere = armedLoader !== void 0 && t2.loaderId !== void 0 && t2.loaderId !== armedLoader;
          docLoading = typeof readyState === "string" && readyState !== "complete";
          if (committedElsewhere) mainId ??= t2.id;
        }
        while (!sawNavigation() && now() - start < SETTLE_NAV_WINDOW_MS && now() < deadline) await step();
        const loaded = async () => {
          if (sawNavigation()) return navigationFinished();
          if (committedElsewhere || docLoading) return await evaluate(page, "document.readyState") === "complete";
          return true;
        };
        while (now() < deadline && !await loaded()) await step();
        const navigated = sawNavigation() || committedElsewhere;
        let quietSince = navigated || docLoading ? void 0 : start;
        while (now() < deadline) {
          if (net.count() > SETTLE_MAX_INFLIGHT) quietSince = void 0;
          else quietSince ??= now();
          if (quietSince !== void 0 && now() - quietSince >= SETTLE_QUIET_MS) break;
          await step();
        }
        return { navigated, waitedMs: now() - start };
      } finally {
        stop();
      }
    },
    cancel: stop
  };
}
async function settle(session, opts = {}) {
  return (await armSettle(session, opts)).done();
}
var WaitTimeoutError, WaitCancelledError, POLL_MS2, DEFAULT_TIMEOUT_MS3, CLEAR_TIMEOUT_MS, EVAL_TIMEOUT_MS, IDLE_MS, SETTLE_NAV_WINDOW_MS, SETTLE_STEP_MS, SETTLE_QUIET_MS, SETTLE_MAX_INFLIGHT, SETTLE_TIMEOUT_MS, KEYS;
var init_wait = __esm({
  "src/browser/wait.ts"() {
    "use strict";
    init_challenge();
    init_deps();
    WaitTimeoutError = class extends Error {
      constructor(condition, elapsedMs) {
        super(`timed out waiting for ${JSON.stringify(condition)} after ${elapsedMs} ms`);
        this.condition = condition;
        this.elapsedMs = elapsedMs;
        this.name = "WaitTimeoutError";
      }
      condition;
      elapsedMs;
    };
    WaitCancelledError = class extends Error {
      constructor() {
        super("the wait was cancelled");
        this.name = "WaitCancelledError";
      }
    };
    POLL_MS2 = 250;
    DEFAULT_TIMEOUT_MS3 = 3e4;
    CLEAR_TIMEOUT_MS = 3e5;
    EVAL_TIMEOUT_MS = 2e3;
    IDLE_MS = 500;
    SETTLE_NAV_WINDOW_MS = 150;
    SETTLE_STEP_MS = 50;
    SETTLE_QUIET_MS = 300;
    SETTLE_MAX_INFLIGHT = 2;
    SETTLE_TIMEOUT_MS = 5e3;
    KEYS = ["text", "gone", "selector", "url", "load", "idle", "ms", "clear"];
  }
});

// src/browser/read.ts
var read_exports = {};
__export(read_exports, {
  closeBrowserReads: () => closeBrowserReads,
  readRenderedPage: () => readRenderedPage
});
function pump() {
  for (let next = queue[0]; next && active < next.limit; next = queue[0]) {
    queue.shift();
    active++;
    next.go();
  }
}
async function acquire(limit, signal, cancelled) {
  if (queue.length === 0 && active < limit) active++;
  else {
    await new Promise((resolve12, reject) => {
      const onAbort = () => {
        queue.splice(queue.indexOf(waiter), 1);
        reject(cancelled());
      };
      const waiter = {
        limit,
        go: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve12();
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
  }
  return () => {
    active--;
    pump();
  };
}
function track(p) {
  inflight.add(p);
  const done = () => inflight.delete(p);
  p.then(done, done);
  return p;
}
async function closeBrowserReads(opts = {}) {
  try {
    if (inflight.size > 0) {
      let timer;
      const bound = new Promise((r) => {
        timer = setTimeout(r, opts.waitMs ?? DRAIN_MS);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled([...inflight]), bound]);
      clearTimeout(timer);
    }
    const ours = launched;
    launched = void 0;
    if (!ours) return { closed: false };
    const deps = opts.deps ? browserDeps({ ...ours.deps, ...opts.deps }) : ours.deps;
    if (!await isSameBrowser(deps, ours.port, ours.host, ours.wsBrowserUrl)) return { closed: false };
    const saved = readSession();
    if (saved?.wsBrowserUrl && socketPath(saved.wsBrowserUrl) === socketPath(ours.wsBrowserUrl)) return { closed: false };
    let cdp;
    try {
      cdp = await deps.connectCdp(loopbackSocketUrl(ours.wsBrowserUrl));
    } catch {
      if (ours.pid === void 0) return { closed: false };
      deps.kill(ours.pid, "SIGTERM");
      return { closed: true };
    }
    try {
      await closeLaunched(cdp, ours.pid, deps);
    } finally {
      await cdp.close();
    }
    return { closed: true };
  } catch {
    return { closed: false };
  }
}
async function render(url, opts, deps, timeoutMs, run) {
  const { cdp, profile, headless, binary } = opts;
  const session = await withBrowserLock(
    async () => {
      if (run.stopped) throw new Error("stopped");
      return openBrowserSession({ cdp, profile, headless, binary, deps, scratch: true, ownOnly: true });
    },
    { deps }
  );
  run.session = session;
  if (session.spawned) {
    const { host, port, pid, browserSocket } = session;
    launched = { host, port, wsBrowserUrl: browserSocket, ...pid !== void 0 ? { pid } : {}, deps };
  }
  const page = session.page;
  let status;
  let mime;
  let mainFrame;
  const onResponse = (p) => {
    if (p.type !== "Document" || p.frameId !== mainFrame || typeof p.response?.status !== "number") return;
    status = p.response.status;
    mime = typeof p.response.mimeType === "string" ? p.response.mimeType : void 0;
  };
  try {
    if (run.stopped) throw new Error("stopped");
    mainFrame = (await page.send("Page.getFrameTree")).frameTree.frame.id;
    page.on("Network.responseReceived", onResponse);
    await page.send("Network.enable");
    await page.send("Page.setDownloadBehavior", { behavior: "deny" }).catch((e) => {
      throw new Error(`could not refuse downloads in the reading tab (${e.message}), so ${url} was not loaded`);
    });
    const nav = await session.navigate(url, { waitUntil: "load", timeoutMs });
    if (mime && !WEB_PAGE.test(mime)) throw new Error(`${url} is not a web page but ${mime}`);
    if (opts.waitUntil !== "load") {
      const idleMs = opts.waitUntil === "idle" ? timeoutMs / 2 : Math.min(IDLE_CAP_MS, timeoutMs);
      await waitFor(session, { idle: true }, { timeoutMs: idleMs, deps }).catch(() => {
      });
    }
    const challenge = await detectChallenge(session);
    const got = await page.send(
      "Runtime.evaluate",
      { expression: opts.fullPage ? WHOLE_DOCUMENT : READ_DOCUMENT, returnByValue: true },
      { timeoutMs }
    );
    const finalUrl = typeof got.result?.value?.url === "string" ? got.result.value.url : nav.url;
    const code = status ?? nav.status ?? 200;
    if (challenge?.blocking) {
      return {
        text: "",
        finalUrl,
        status: code >= 400 ? code : 403,
        extractor: "browser",
        note: `${challenge.kind} challenge \u2014 open it with \`${brand().cli} browser open ${url}\` and let the human solve it`
      };
    }
    const html = typeof got.result?.value?.html === "string" ? got.result.value.html : "";
    return { ...extractFromHtml(html, finalUrl, opts), finalUrl, status: code, extractor: "browser" };
  } finally {
    page.off("Network.responseReceived", onResponse);
    await deps.discovery.closeTarget(session.port, session.targetId, session.host).catch(() => {
    });
    await session.detach();
  }
}
function readRenderedPage(url, opts = {}) {
  return track(read(url, opts));
}
async function read(url, opts) {
  const cancelled = () => new Error(`reading ${url} in the browser was cancelled`);
  const { signal } = opts;
  if (signal?.aborted) throw cancelled();
  const deps = browserDeps(opts.deps);
  const timeoutMs = opts.timeoutMs ?? envInt("BROWSER_TIMEOUT_MS", 3e4, 5e3, 3e5);
  const release2 = await acquire(envInt("BROWSER_CONCURRENCY", 1, 1, 4), signal, cancelled);
  if (signal?.aborted) {
    release2();
    throw cancelled();
  }
  const run = { stopped: false };
  const work = track(render(url, opts, deps, timeoutMs, run));
  work.then(release2, release2);
  let stop;
  const cut = new Promise((_, reject) => {
    stop = reject;
  });
  const timer = setTimeout(() => stop(new Error(`reading ${url} in the browser did not finish within ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => stop(cancelled());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, cut]);
  } catch (e) {
    run.stopped = true;
    work.catch(() => {
    });
    await run.session?.detach();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
var IDLE_CAP_MS, WEB_PAGE, active, queue, DRAIN_MS, launched, inflight, WHOLE_DOCUMENT;
var init_read = __esm({
  "src/browser/read.ts"() {
    "use strict";
    init_brand();
    init_fetch();
    init_challenge();
    init_deps();
    init_launch();
    init_discovery();
    init_overlay();
    init_session();
    init_state();
    init_wait();
    IDLE_CAP_MS = 3e3;
    WEB_PAGE = /^(?:text\/html|application\/xhtml\+xml)$/i;
    active = 0;
    queue = [];
    DRAIN_MS = 5e3;
    inflight = /* @__PURE__ */ new Set();
    WHOLE_DOCUMENT = "({ html: document.documentElement ? document.documentElement.outerHTML : '', url: location.href })";
  }
});

// src/fetch.ts
function browserUa() {
  return env("UA") || DEFAULT_BROWSER_UA;
}
function contactUa() {
  const b = brand();
  return `${b.name}/${b.version ?? "1.x"} (+${b.contactUrl ?? `https://github.com/maxgfr/${b.name}`})`;
}
function defaultUa() {
  return brand().defaultUa === "contact" ? contactUa() : browserUa();
}
function pageDelayMs() {
  return envInt("PAGE_DELAY_MS", 350, 0, 5e3);
}
function sleep(ms, signal) {
  return signal ? sleepUnlessAborted(ms, signal) : new Promise((r) => setTimeout(r, ms));
}
function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve12) => {
    if (signal?.aborted) return resolve12();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve12();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
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
function attemptsFor(retries) {
  return retries === void 0 ? maxAttempts() : Math.min(4, Math.max(0, Math.trunc(retries))) + 1;
}
function networkFailure(e) {
  const err = e;
  const code = typeof err?.cause?.code === "string" ? err.cause.code : void 0;
  const detail = typeof err?.cause?.message === "string" && err.cause.message ? err.cause.message : code;
  if (!detail) return typeof err?.message === "string" ? err.message : String(e);
  return code && !detail.includes(code) ? `${code}: ${detail}` : detail;
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
async function readMeasuredBody(res, max) {
  const read3 = await readCappedBytes(res, max + 1);
  const bytes = read3.subarray(0, max);
  return { bytes, bytesRead: bytes.length, truncated: read3.length > max };
}
function isBinaryDocument(contentType) {
  return /application\/pdf/i.test(contentType) || docFormatForContentType(contentType) !== void 0;
}
function dispositionFilename(header2) {
  if (!header2) return void 0;
  let name2;
  const extended = /filename\*\s*=\s*[^'\s;]*'[^']*'([^;\s]+)/i.exec(header2);
  if (extended) {
    try {
      name2 = decodeURIComponent(extended[1]);
    } catch {
      name2 = void 0;
    }
  }
  if (name2 === void 0) {
    const plain2 = /filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]+))/i.exec(header2);
    name2 = plain2 ? plain2[1]?.replace(/\\(.)/g, "$1") ?? plain2[2].trim() : void 0;
  }
  return name2?.split(/[\\/]/).pop() || void 0;
}
async function authorizedGet(url, init, authorize) {
  let target = url;
  const fail2 = (error, redirectFailed) => ({
    failure: { ok: false, status: 0, body: "", contentType: "", url: target, error, ...redirectFailed ? { redirectFailed } : {} }
  });
  const headers = { ...init.headers };
  for (let redirects = 0; ; redirects++) {
    try {
      if (!await authorize(target)) return fail2(`URL not authorized: ${target}`);
    } catch (e) {
      return fail2(`URL authorization failed for ${target}: ${e.message}`);
    }
    const response = await fetch(target, { ...init, headers, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUS.has(response.status) || !location) return { response };
    await response.body?.cancel().catch(() => {
    });
    if (redirects >= 20) return fail2("Too many redirects (maximum 20)", true);
    try {
      const next = new URL(location, target);
      if (!/^https?:$/.test(next.protocol)) return fail2(`Unsupported redirect protocol: ${next.protocol}`, true);
      if (next.origin !== new URL(target).origin) {
        delete headers.authorization;
        delete headers.cookie;
        delete headers["proxy-authorization"];
      }
      target = next.href;
    } catch {
      return fail2(`Invalid redirect URL from ${target}`, true);
    }
  }
}
async function httpGet(url, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, body: "", contentType: "", url };
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs2();
  const cancelled = () => ({ ok: false, status: 0, body: "", contentType: "", url, error: "cancelled" });
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) return cancelled();
    const ctrl = new AbortController();
    const onCancel = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onCancel, { once: true });
    let t;
    let remainingMs = timeoutMs;
    let startedAt = 0;
    let timedOut = false;
    const expire = () => {
      timedOut = true;
      ctrl.abort();
    };
    const pauseTimeout = () => {
      if (t === void 0) return;
      clearTimeout(t);
      t = void 0;
      remainingMs -= performance.now() - startedAt;
    };
    const resumeTimeout = () => {
      startedAt = performance.now();
      if (remainingMs <= 0) expire();
      else t = setTimeout(expire, remainingMs);
    };
    try {
      const headers = { "user-agent": opts.userAgent ?? defaultUa(), accept: opts.accept ?? "*/*" };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const init = {
        signal: ctrl.signal,
        redirect: "follow",
        headers
      };
      if (!opts.authorizeUrl) resumeTimeout();
      const requested = opts.authorizeUrl ? await authorizedGet(url, init, async (target) => {
        pauseTimeout();
        const allowed = await opts.authorizeUrl(target);
        if (allowed) resumeTimeout();
        return allowed;
      }) : { response: await fetch(url, init) };
      if ("failure" in requested) return requested.failure;
      const res = requested.response;
      const meta = {
        contentType: res.headers.get("content-type") ?? "",
        url: res.url || url,
        etag: res.headers.get("etag") ?? void 0,
        lastModified: res.headers.get("last-modified") ?? void 0,
        rateLimited: detectRateLimited(res.status, res.headers),
        retryAfterMs: parseRetryAfter(res.headers, Number.POSITIVE_INFINITY)
      };
      const mime = mimeOf(meta.contentType);
      const filename = dispositionFilename(res.headers.get("content-disposition"));
      const namedDocument = isBinaryDocument(meta.contentType) || namesDocument(filename);
      const ambiguous = AMBIGUOUS_TYPES.has(mime);
      const declared = Number(res.headers.get("content-length"));
      const documentCap = namedDocument || ambiguous ? opts.maxDocumentBytes : void 0;
      const pastDocumentCap = !namedDocument && documentCap !== void 0 && declared > documentCap;
      const max = opts.maxBytes ?? (pastDocumentCap ? Math.min(documentCap, DEFAULT_MAX_RESPONSE_BYTES) : documentCap) ?? DEFAULT_MAX_RESPONSE_BYTES;
      const prefixUseless = opts.binary || namedDocument || NON_TEXT_TYPE_RE.test(mime) || Object.keys(opts.headers ?? {}).some((k) => k.toLowerCase() === "range");
      if (Number.isFinite(declared) && declared > max && prefixUseless) {
        ctrl.abort();
        return { ok: false, status: res.status, body: "", bytesRead: 0, truncated: true, ...meta, error: `response too large: ${declared} bytes > ${max} cap` };
      }
      let { bytes, bytesRead, truncated } = res.status === 304 ? { bytes: Buffer.alloc(0), bytesRead: 0, truncated: false } : await readMeasuredBody(res, max);
      countFetch(bytes.length, false);
      const sniffed = ambiguous ? sniffDocument(bytes) : void 0;
      if (ambiguous && !namedDocument && !sniffed && opts.maxBytes === void 0 && bytes.length > DEFAULT_MAX_RESPONSE_BYTES) {
        bytes = bytes.subarray(0, DEFAULT_MAX_RESPONSE_BYTES);
        bytesRead = bytes.length;
        truncated = true;
      }
      const keepBytes = opts.binary || (namedDocument || sniffed !== void 0) && !truncated;
      const binaryBody = opts.binary || sniffed !== void 0 || isBinaryDocument(meta.contentType) && !mime.startsWith("text/");
      const result = {
        ok: res.ok,
        status: res.status,
        // Decoded per the response's own encoding, not assumed UTF-8. A
        // Windows-1252 page used to come back with every accented character
        // replaced by U+FFFD, and nothing anywhere noticed.
        body: binaryBody ? "" : decodeBody(bytes, meta.contentType),
        bytes: keepBytes ? bytes : void 0,
        bytesRead,
        truncated,
        ...meta,
        ...filename ? { filename } : {}
      };
      const wait = RETRY_STATUS.has(res.status) && attempt < attempts - 1 ? retryDelayMs(meta.retryAfterMs) : void 0;
      if (wait !== void 0) {
        last = result;
        if (wait > 0) opts.onBackOff?.(result.url, wait);
        await sleepUnlessAborted(wait, opts.signal);
        continue;
      }
      return result;
    } catch (e) {
      if (!timedOut && opts.signal?.aborted) return cancelled();
      const error = timedOut ? `timed out after ${timeoutMs} ms` : networkFailure(e);
      last = {
        ok: false,
        status: 0,
        body: "",
        contentType: "",
        url,
        error,
        ...!timedOut && /redirect count exceeded/i.test(error) ? { redirectFailed: true } : {}
      };
      if (timedOut || isPermanentFailure(e)) break;
      if (attempt < attempts - 1) await sleepUnlessAborted(defaultRetryMs(), opts.signal);
    } finally {
      clearTimeout(t);
      opts.signal?.removeEventListener("abort", onCancel);
    }
  }
  return last;
}
async function httpJson(method, url, body, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, data: void 0 };
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs2();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const headers = {
        "content-type": "application/json",
        accept: opts.accept ?? "application/json",
        "user-agent": opts.userAgent ?? defaultUa()
      };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers,
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
      const max = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
      const { bytes, bytesRead, truncated } = await readMeasuredBody(res, max);
      countFetch(bytes.length, false);
      if (truncated) {
        ctrl.abort();
        return { ok: false, status: res.status, data: void 0, bytesRead, truncated, error: `response too large: over the ${max}-byte cap` };
      }
      const text = bytes.toString("utf8");
      let data;
      try {
        data = text ? JSON.parse(text) : void 0;
      } catch {
        data = text;
      }
      const result = { ok: res.ok, status: res.status, data, bytesRead, truncated };
      const wait = RETRY_STATUS.has(res.status) && attempt < attempts - 1 ? retryDelayMs(parseRetryAfter(res.headers, Number.POSITIVE_INFINITY)) : void 0;
      if (wait !== void 0) {
        last = result;
        await sleep(wait);
        continue;
      }
      return result;
    } catch (e) {
      last = timedOut ? { ok: false, status: 0, data: void 0, error: `timed out after ${timeoutMs} ms`, timedOut: true } : { ok: false, status: 0, data: void 0, error: networkFailure(e) };
      if (timedOut || isPermanentFailure(e)) break;
      if (attempt < attempts - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
function cleanInline(s) {
  const text = decodeEntities(String(s));
  const opened = /* @__PURE__ */ new Set();
  const closed = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(INLINE_FORMAT_TAG)) (m[1] ? closed : opened).add(m[2].toLowerCase());
  return text.replace(INLINE_FORMAT_TAG, (tag, slash, rawName, attrs) => {
    const name2 = rawName.toLowerCase();
    if (name2.startsWith("mml:") || name2.startsWith("jats:")) return "";
    if (!INLINE_FORMAT.has(name2)) return tag;
    if (name2 === "br") return " ";
    const markup = attrs.trim().replace(/\/$/, "") !== "" || name2 === "wbr" || (slash ? opened : closed).has(name2);
    return markup ? "" : tag;
  }).replace(/\s+/g, " ").trim();
}
function preSlotIndex(line) {
  if (line.length < 3 || line[0] !== NUL2 || line[line.length - 1] !== NUL2) return void 0;
  const i = Number(line.slice(1, -1));
  return Number.isInteger(i) ? i : void 0;
}
function restoreInlinePre(line, blocks) {
  const parts = line.split(NUL2);
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const code = (blocks[Number(parts[i])] ?? "").replace(/\s+/g, " ").trim();
    out += ` ${code} ${parts[i + 1] ?? ""}`;
  }
  return out.replace(/ {2,}/g, " ").trim();
}
function setAsidePre(html, blocks) {
  const open2 = /<pre(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const close = closeTagRe("pre");
  let out = "";
  let last = 0;
  let m;
  while (m = open2.exec(html)) {
    close.lastIndex = open2.lastIndex;
    const c = close.exec(html);
    if (!c) break;
    const inner = html.slice(open2.lastIndex, c.index);
    const text = decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(LOOSE_TAG_RE, "")).replace(/\r\n?/g, "\n").replace(/^\n/, "").trimEnd();
    blocks.push(text);
    out += html.slice(last, m.index) + PRE_SLOT(blocks.length - 1);
    last = open2.lastIndex = c.index + c[0].length;
  }
  return last === 0 ? html : out + html.slice(last);
}
function flattenHeadings(html) {
  let out = "";
  let last = 0;
  let m;
  HEADING_OPEN.lastIndex = 0;
  while (m = HEADING_OPEN.exec(html)) {
    HEADING_BOUNDARY.lastIndex = HEADING_OPEN.lastIndex;
    const b = HEADING_BOUNDARY.exec(html);
    if (!b) break;
    if (b[0][1] !== "/") continue;
    const text = html.slice(HEADING_OPEN.lastIndex, b.index).replace(PERMALINK, "").replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ").replace(/\s+/g, " ").trim();
    out += html.slice(last, m.index) + (text ? `
${"#".repeat(Number(m[1]))} ${text}
` : "\n");
    last = HEADING_OPEN.lastIndex = b.index + b[0].length;
  }
  return last === 0 ? html : out + html.slice(last);
}
function htmlToText(html, opts = {}) {
  const hidden = opts.fullPage ? HIDDEN_ELEMENTS : [...HIDDEN_ELEMENTS, ...CHROME_ELEMENTS];
  let s = dropElements(html.includes(NUL2) ? html.split(NUL2).join("\uFFFD") : html, hidden, RAW_TEXT_ELEMENTS);
  if (!opts.fullPage) s = dropLandmarks(s, CHROME_ROLES);
  const pre = [];
  s = flattenHeadings(setAsidePre(s, pre));
  let prevAEnd = -1;
  s = s.replace(TAG_RE, (tag, at) => {
    const closing = tag[1] === "/";
    const name2 = tagName(tag);
    const adjacentLinks = name2 === "a" && !closing && at === prevAEnd;
    prevAEnd = name2 === "a" && closing ? at + tag.length : -1;
    if (/^h[1-6]$/.test(name2)) {
      return closing ? "\n" : "\n" + "#".repeat(Number(name2[1])) + " ";
    }
    if (BLOCK_TAGS.has(name2) || name2 === "br" || name2 === "hr") return "\n";
    if (INLINE_TAGS.has(name2)) return adjacentLinks ? " " : "";
    return " ";
  });
  s = s.replace(LOOSE_TAG_RE, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map((l) => {
    const t = l.trim();
    const slot = preSlotIndex(t);
    if (slot !== void 0) return pre[slot] ?? t;
    return t.includes(NUL2) ? restoreInlinePre(t, pre) : t;
  }).filter((l) => l.length > 0).join("\n");
}
function firstElementText(html, name2) {
  const open2 = new RegExp(`<${name2}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "i").exec(html);
  if (!open2) return void 0;
  const close = closeTagRe(name2);
  close.lastIndex = open2.index + open2[0].length;
  const c = close.exec(html);
  if (!c) return void 0;
  const inner = html.slice(open2.index + open2[0].length, c.index).replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ");
  return decodeEntities(inner).replace(/\s+/g, " ").trim() || void 0;
}
function htmlTitle(html) {
  return firstElementText(dropElements(html, NOT_TITLE), "title");
}
function metaContent(html, keys) {
  const found = /* @__PURE__ */ new Map();
  for (const m of html.matchAll(/<meta(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(m[0]);
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
    const value = attrs.get("content")?.trim();
    if (key && value && keys.includes(key) && !found.has(key)) found.set(key, decodeEntities(value).replace(/\s+/g, " ").trim());
  }
  return keys.map((k) => found.get(k)).find(Boolean);
}
function pageTitle(html) {
  const clean3 = dropElements(html, NOT_TITLE);
  return firstElementText(clean3, "title") ?? metaContent(clean3, ["og:title", "twitter:title"]) ?? firstElementText(clean3, "h1");
}
function htmlCanonicalUrl(html) {
  const clean3 = dropElements(html, ["script", "style", "template"]);
  const end = clean3.search(/<\/head\s*>|<body(?=[\s/>])/i);
  const head = end < 0 ? clean3 : clean3.slice(0, end);
  let og;
  for (const m of head.matchAll(/<(link|meta)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(m[0]);
    if (m[1].toLowerCase() === "link") {
      const href = attrs.get("href")?.trim();
      if (href && (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) return decodeEntities(href);
    } else if (og === void 0 && attrs.get("property")?.toLowerCase() === "og:url") {
      og = attrs.get("content")?.trim() || void 0;
    }
  }
  return og && decodeEntities(og);
}
function absoluteCanonical(href, base2) {
  if (!href) return void 0;
  try {
    const u = new URL(href, base2);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : void 0;
  } catch {
    return void 0;
  }
}
function isContentContainer(open2) {
  const attrs = htmlAttributes(open2);
  for (const token of `${attrs.get("id") ?? ""} ${attrs.get("class") ?? ""}`.toLowerCase().split(/\s+/)) {
    if (token === "markdown-body") return true;
    const words = token.split(/\W+/);
    if (words.some((w) => CONTENT_WORDS.has(w)) && !words.some((w) => CHROME_WORDS.has(w))) return true;
  }
  return false;
}
function blockKind(open2) {
  const tag = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(open2)?.[1]?.toLowerCase() ?? "";
  const firstClass = (htmlAttributes(open2).get("class") ?? "").trim().split(/\s+/)[0];
  return `${tag} ${firstClass.replace(/\d+/g, "0")}`;
}
function textProfile(html) {
  const at = [];
  const len = [];
  const link = [];
  const prose = [];
  let inA = false;
  let inP = false;
  let total = 0;
  let linked = 0;
  let para = 0;
  let last = 0;
  for (const m of html.matchAll(LOOSE_TAG_RE)) {
    const n = html.slice(last, m.index).replace(/\s+/g, " ").trim().length;
    total += n;
    if (inA) linked += n;
    else if (inP) para += n;
    at.push(m.index);
    len.push(total);
    link.push(linked);
    prose.push(para);
    last = m.index + m[0].length;
    const name2 = tagName(m[0]);
    const closing = m[0][1] === "/";
    if (name2 === "a") inA = !closing;
    else if (name2 === "p") inP = !closing;
    else if (!closing && CLOSES_P.has(name2)) inP = false;
  }
  const index = (pos) => {
    let lo = 0;
    let hi = at.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (at[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return (from, to) => {
    if (!at.length) return { len: 0, link: 0, prose: 0 };
    const i = index(from);
    const j = index(to);
    return { len: len[j] - len[i], link: link[j] - link[i], prose: prose[j] - prose[i] };
  };
}
function headlineProse(clean3, stats, lists, minProse) {
  const firstAtOrAfter = (pos) => {
    let lo = 0;
    let hi = lists.length;
    while (lo < hi) {
      const mid = lo + hi >> 1;
      if (lists[mid].from < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const inList = (pos) => {
    const k = firstAtOrAfter(pos + 1) - 1;
    return k >= 0 && pos < lists[k].to;
  };
  const h1 = [...clean3.matchAll(/<h1(?=[\s/>])/gi)].map((m) => m.index).find((pos) => !inList(pos));
  if (h1 === void 0) return void 0;
  const ancestors = ["div", "section", "article", "main"].flatMap((tag) => balancedRegions(clean3, tag, () => true)).filter((r) => r.start <= h1 && h1 < r.end).sort((a, b) => a.end - a.start - (b.end - b.start));
  const cum = [{ len: 0, link: 0, prose: 0 }];
  for (const r of lists) {
    const s = stats(r.from, r.to);
    const p = cum[cum.length - 1];
    cum.push({ len: p.len + s.len, link: p.link + s.link, prose: p.prose + s.prose });
  }
  const measure = (r) => {
    const i2 = firstAtOrAfter(r.start);
    const j2 = Math.max(i2, firstAtOrAfter(r.end));
    const s = stats(r.start, r.end);
    const cut = { len: cum[j2].len - cum[i2].len, link: cum[j2].link - cum[i2].link, prose: cum[j2].prose - cum[i2].prose };
    return { region: r, i: i2, j: j2, cut: cut.len, len: s.len - cut.len, link: s.link - cut.link, prose: s.prose - cut.prose };
  };
  let best;
  for (const r of ancestors) {
    const m = measure(r);
    if (m.prose < minProse || m.prose < m.cut || isLinkList(m)) continue;
    if (!best || m.prose >= best.prose * 1.3) best = m;
  }
  if (!best) return void 0;
  const { region, i, j } = best;
  let out = "";
  let last = region.start;
  for (const r of lists.slice(i, j)) {
    out += `${clean3.slice(last, r.from)} `;
    last = r.to;
  }
  return out + clean3.slice(last, region.end);
}
function extractMainHtml(html) {
  const clean3 = dropElements(html, ["script", "style", "template", "svg"]);
  const roleMainTags = /* @__PURE__ */ new Set(["main"]);
  for (const m of clean3.matchAll(ROLE_MAIN_TAG)) roleMainTags.add(m[1].toLowerCase());
  const stats = textProfile(clean3);
  const tiers = [
    { tags: [...roleMainTags], isCandidate: (open2) => /^<main[\s/>]/i.test(open2) || ROLE_MAIN.test(open2) },
    { tags: ["article"], isCandidate: () => true },
    { tags: ["div", "section"], isCandidate: isContentContainer }
  ];
  for (const tier of tiers) {
    const regions = tier.tags.flatMap((tag) => balancedRegions(clean3, tag, tier.isCandidate)).sort((a, b) => a.start - b.start);
    if (!regions.length) continue;
    const outer = [];
    let reach = -1;
    for (const r of regions) {
      if (r.start < reach) continue;
      reach = r.end;
      outer.push({ ...r, len: visibleLength(clean3.slice(r.start, r.end)) });
    }
    let best = outer[0];
    for (const r of outer) if (r.len > best.len) best = r;
    const linkList = (r) => isLinkList(stats(r.start, r.end));
    const kind = blockKind(best.open);
    const bestIsList = linkList(best);
    const kept = outer.filter((r) => r === best || blockKind(r.open) === kind && (bestIsList || !linkList(r)));
    if (bestIsList) {
      const listProse = kept.reduce((n, r) => n + stats(r.start, r.end).prose, 0);
      const prose = headlineProse(clean3, stats, outer.filter(linkList), Math.max(MIN_PROSE, listProse + 1));
      if (prose !== void 0) return prose;
    }
    const keptLen = kept.reduce((n, r) => n + r.len, 0);
    if (keptLen < 500 && keptLen < visibleLength(clean3) * 0.3) return html;
    if (kept.length === 1) return clean3.slice(best.start, best.end);
    return kept.map((r) => `<div>${clean3.slice(r.start, r.end)}</div>`).join("\n");
  }
  return html;
}
function looksLikePdfUrl(url) {
  if (PDF_URL_RE.test(url)) return true;
  return PDF_ROUTE_RE.test(url) && !NON_PDF_TAIL_RE.test(url);
}
async function fetchAndExtract(url, opts = {}) {
  const cancelled = () => ({ text: "", finalUrl: url, status: 0, note: `Fetching ${url} was cancelled.` });
  if (opts.signal?.aborted) return cancelled();
  const video = opts.video === false ? void 0 : knownVideo(url);
  if (video) {
    if (opts.authorizeUrl && !await opts.authorizeUrl(url)) return { text: "", finalUrl: url, status: 0, note: `Refused ${url}: not a public address.` };
    const t = await transcribeVideo(url, {
      lang: opts.acceptLanguage?.split(/[,;]/)[0]?.trim() || void 0,
      signal: opts.signal,
      knownHostsOnly: true
    });
    if (opts.signal?.aborted) return cancelled();
    const text = transcriptMarkdown(t);
    if (!text && !PURE_VIDEO_HOSTS.has(video.site)) {
      const page = await fetchAndExtract(url, { ...opts, video: false });
      return { ...page, note: [`No video read at ${url} (${t.reason ?? "no transcript"}); read as a page.`, page.note].filter(Boolean).join(" ") };
    }
    return {
      text,
      title: t.meta?.title,
      finalUrl: t.meta?.webpageUrl ?? url,
      status: text ? 200 : 0,
      documentType: "video",
      ...t.via ? { extractor: t.via } : {},
      ...t.reason ? { note: `No transcript for ${url}: ${t.reason}.` } : {}
    };
  }
  const wantsPdf = looksLikePdfUrl(url);
  const wantsDoc = wantsPdf ? void 0 : docFormatForUrl(url);
  const browser = opts.authorizeUrl || opts.headers || wantsPdf || wantsDoc ? "off" : browserFetchMode(opts.browser);
  if (browser === "always") {
    const got2 = await renderInBrowser(url, opts);
    if (got2.result) return got2.result;
    const res2 = await readWithoutBrowser(url, opts, wantsPdf, wantsDoc, { page: false });
    return { ...res2, note: [`${got2.note}; read without it.`, got2.detail, res2.note].filter(Boolean).join(" ") };
  }
  const seen = { page: false };
  const res = await readWithoutBrowser(url, opts, wantsPdf, wantsDoc, seen);
  const why = browser === "fallback" && seen.page && !opts.signal?.aborted ? worthRendering(res) : void 0;
  if (!why) return res;
  const got = await renderInBrowser(url, opts);
  if (got.result?.text.trim())
    return { ...got.result, note: [`Read ${url} in the browser: the built-in fetch ${why}.`, got.result.note].filter(Boolean).join(" ") };
  return { ...res, note: [res.note, got.result ? got.result.note : `${got.note}.`, got.detail].filter(Boolean).join(" ") || void 0 };
}
async function renderInBrowser(url, opts) {
  try {
    const { readRenderedPage: readRenderedPage2 } = await Promise.resolve().then(() => (init_read(), read_exports));
    const { format, fullPage, stripConsent, keepHtml, signal, timeoutMs } = opts;
    const result = await readRenderedPage2(url, { format, fullPage, stripConsent, keepHtml, signal, timeoutMs });
    if (result.status >= 400) return { note: `The browser got HTTP ${result.status} for ${url}`, detail: result.note };
    return { result };
  } catch (e) {
    return { note: `The browser could not read ${url} (${e instanceof Error ? e.message : String(e)})` };
  }
}
async function readWithoutBrowser(url, opts, wantsPdf, wantsDoc, seen) {
  const cancelled = () => ({ text: "", finalUrl: url, status: 0, note: `Fetching ${url} was cancelled.` });
  let firecrawlNote;
  if (!wantsPdf && !wantsDoc && !opts.authorizeUrl && !opts.fullPage) {
    const fc = await scrapeViaFirecrawl(url, opts);
    if (fc.data && (fc.data.statusCode ?? 200) < 400) {
      seen.page = true;
      return {
        text: fc.data.markdown,
        title: fc.data.title,
        finalUrl: fc.data.finalUrl || url,
        status: fc.data.statusCode ?? 200,
        extractor: "firecrawl"
      };
    }
    firecrawlNote = fc.data ? `Firecrawl got HTTP ${fc.data.statusCode} for ${url} \u2014 fell back to the built-in extractor.` : fc.why;
  }
  const base2 = wantsPdf ? PDF_FETCH_OPTS : wantsDoc ? DOC_FETCH_OPTS : { accept: "text/html,text/plain,*/*", acceptLanguage: opts.acceptLanguage };
  const fetchOpts = {
    ...base2,
    maxDocumentBytes: PDF_FETCH_OPTS.maxBytes,
    headers: opts.headers,
    authorizeUrl: opts.authorizeUrl,
    timeoutMs: opts.timeoutMs,
    onBackOff: opts.onBackOff,
    signal: opts.signal
  };
  if (opts.signal?.aborted) return cancelled();
  let res = await httpGet(url, fetchOpts);
  if (opts.signal?.aborted) return cancelled();
  const toldToWait = (res.retryAfterMs ?? 0) > RETRY_AFTER_CAP_MS;
  if (!res.ok && !toldToWait && brand().defaultUa === "contact" && (res.status === 403 || res.status === 429)) {
    res = await httpGet(url, { ...fetchOpts, userAgent: browserUa(), acceptLanguage: opts.acceptLanguage ?? "en-US,en;q=0.9" });
  }
  if (res.status === 304) {
    return { text: "", finalUrl: res.url, status: 304, etag: res.etag ?? opts.headers?.["if-none-match"], lastModified: res.lastModified };
  }
  if (!res.ok) {
    seen.page = true;
    const wait = res.retryAfterMs !== void 0 ? `, retry after ${Math.ceil(res.retryAfterMs / 1e3)} s` : "";
    const why = res.status === 429 ? `rate-limited (HTTP 429${wait})` : `status ${res.status}${res.error ? ", " + res.error : ""}${wait}`;
    return {
      text: "",
      finalUrl: res.url,
      status: res.status,
      note: `Could not fetch ${url} (${why}).`,
      ...res.rateLimited ? { rateLimited: true } : {},
      ...res.retryAfterMs !== void 0 ? { retryAfterMs: res.retryAfterMs } : {}
    };
  }
  const validators = res.etag || res.lastModified ? { etag: res.etag, lastModified: res.lastModified } : {};
  const mime = mimeOf(res.contentType);
  const claimsPdf = wantsPdf || /application\/pdf/i.test(res.contentType) || res.filename !== void 0 && PDF_URL_RE.test(res.filename);
  const claimsDoc = claimsPdf ? void 0 : wantsDoc ?? docFormatForContentType(res.contentType) ?? (res.filename ? docFormatForUrl(res.filename) : void 0);
  if (res.truncated && (claimsPdf || claimsDoc || !res.body && res.bytesRead)) {
    return { text: "", finalUrl: res.url, status: res.status, note: `Fetched ${url} but the document exceeds the response size cap.` };
  }
  const sniffed = res.bytes ? sniffDocument(res.bytes) : void 0;
  if (!sniffed && NON_TEXT_TYPE_RE.test(mime)) {
    return { text: "", finalUrl: res.url, status: res.status, note: `Fetched ${url} but it is ${mime}, not a text document.`, ...validators };
  }
  const answeredHtml = !sniffed && (claimsPdf || claimsDoc !== void 0) && HTML_TYPE_RE.test(mime);
  const route2 = sniffed ?? (answeredHtml ? void 0 : claimsPdf ? "pdf" : claimsDoc);
  if (route2 === "pdf") {
    const bytes = res.bytes ?? (await httpGet(url, { ...PDF_FETCH_OPTS, headers: opts.headers, authorizeUrl: opts.authorizeUrl, timeoutMs: opts.timeoutMs, signal: opts.signal })).bytes;
    const got = bytes ? await extractPdf(bytes, {
      firecrawl: async () => {
        if (opts.authorizeUrl) return void 0;
        const fc = await scrapeViaFirecrawl(url, opts);
        return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : void 0;
      }
    }) : { text: "", reason: "empty response body" };
    return {
      text: got.text,
      documentType: "pdf",
      finalUrl: res.url,
      status: res.status,
      // `native` keeps reporting as absent, which is what the cache key and every
      // existing dossier already assume.
      extractor: got.via && got.via !== "native" ? got.via : void 0,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text \u2014 ${got.reason}.`,
      ...validators
    };
  }
  if (route2) {
    const docFmt = route2;
    const bytes = res.bytes ?? (await httpGet(url, { ...DOC_FETCH_OPTS, headers: opts.headers, authorizeUrl: opts.authorizeUrl, timeoutMs: opts.timeoutMs, signal: opts.signal })).bytes;
    const got = bytes ? await extractDocument(bytes, docFmt, {
      firecrawl: async () => {
        if (opts.authorizeUrl) return void 0;
        const fc = await scrapeViaFirecrawl(url, opts);
        return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : void 0;
      }
    }) : { text: "", reason: "empty response body" };
    if (!got.text && docFmt.textFallback && bytes?.length) {
      return { text: decodeBody(bytes, res.contentType), documentType: "doc", finalUrl: res.url, status: res.status, note: firecrawlNote, ...validators };
    }
    return {
      text: got.text,
      documentType: "doc",
      finalUrl: res.url,
      status: res.status,
      extractor: got.via,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text \u2014 ${got.reason}.`,
      ...validators
    };
  }
  const ambiguousType = AMBIGUOUS_TYPES.has(mime);
  if (ambiguousType && res.body.slice(0, 1024).includes("\0")) {
    return {
      text: "",
      finalUrl: res.url,
      status: res.status,
      note: `Fetched ${url} but it is binary data (${mime || "no content-type"}), not a text document.`,
      ...validators
    };
  }
  const body = !res.body && res.bytes ? decodeBody(res.bytes, res.contentType) : res.body;
  const isHtml = HTML_TYPE_RE.test(mime) || ambiguousType && /^\s*<(?:!doctype\s+html\b|html\b|head\b|body\b|article\b|main\b|p\b|h[1-6]\b)/i.test(body);
  seen.page = isHtml;
  const extracted = isHtml ? extractFromHtml(body, res.url, opts) : { text: body, consentDropped: 0, title: void 0, canonical: void 0, metaDescription: void 0 };
  const notDocument = answeredHtml ? `${url} looked like ${claimsPdf ? "a PDF" : "an office document"} but the server returned HTML (a login wall or landing page?), so it was read as a web page.` : void 0;
  const cut = res.truncated ? `Read only the first ${res.bytesRead} bytes of ${url} (the response size cap), so this text is a prefix.` : void 0;
  return {
    ...extracted,
    finalUrl: res.url,
    status: res.status,
    note: [firecrawlNote, notDocument, cut].filter(Boolean).join(" ") || void 0,
    ...res.truncated ? { truncated: true } : {},
    ...validators
  };
}
function extractFromHtml(html, finalUrl, opts = {}) {
  const markdown = opts.format === "markdown";
  const main2 = opts.fullPage ? html : extractMainHtml(html);
  const stripped = markdown ? markdownAgainst(main2, documentBaseUrl(html, finalUrl), opts.fullPage) : htmlToText(main2, opts);
  const consent = opts.stripConsent && !opts.fullPage ? stripConsentBoilerplate(stripped, { markdown }) : { text: stripped, dropped: 0 };
  return {
    text: consent.text,
    consentDropped: consent.dropped,
    title: pageTitle(html),
    canonical: absoluteCanonical(htmlCanonicalUrl(html), finalUrl),
    metaDescription: metaDescriptionOf(html),
    ...opts.keepHtml ? { html } : {}
  };
}
function stripConsentBoilerplate(text, opts = {}) {
  if (opts.markdown) return stripConsentMarkdown(text);
  let dropped = 0;
  const kept = text.split("\n").filter((line) => {
    const isBanner = isConsentLine(line.trim());
    if (isBanner) dropped++;
    return !isBanner;
  });
  return { text: kept.join("\n"), dropped };
}
function isConsentLine(t) {
  const hits = CONSENT_PATTERNS.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  return BUTTON_LABEL.test(t) || hits >= 1 && t.length <= BUTTON_LENGTH && (hits >= 2 || CONSENT_ACTIONS.some((re) => re.test(t))) || hits >= 1 && t.length < NOTICE_LENGTH && BANNER_VOICE.test(t);
}
function visibleText(line) {
  return line.replace(MD_LINE_START, "").replace(MD_DESTINATION, "]").replace(MD_MARKUP, "").trim();
}
function stripConsentMarkdown(text) {
  let dropped = 0;
  let fence = "";
  const kept = [];
  for (const line of text.split("\n")) {
    const f = MD_FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = "";
      kept.push(line);
      continue;
    }
    if (f) fence = f[1];
    else if (!line.trim()) {
      if (kept.length && kept[kept.length - 1].trim()) kept.push(line);
      continue;
    } else if (!/^[\s>]*\|/.test(line) && isConsentLine(visibleText(line))) {
      dropped++;
      continue;
    }
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return { text: kept.join("\n"), dropped };
}
function metaDescriptionOf(html) {
  let og;
  for (const match of html.matchAll(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(match[0]);
    const value = attrs.get("content")?.replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (attrs.get("name")?.toLowerCase() === "description") return decodeEntities(value);
    if (attrs.get("property")?.toLowerCase() === "og:description" && og === void 0) og = decodeEntities(value);
  }
  return og;
}
var DEFAULT_BROWSER_UA, RETRY_STATUS, defaultTimeoutMs2, DEFAULT_MAX_RESPONSE_BYTES, mimeOf, namesDocument, REDIRECT_STATUS, INLINE_FORMAT, INLINE_FORMAT_TAG, NUL2, PRE_SLOT, HEADING_OPEN, HEADING_BOUNDARY, PERMALINK, NOT_TITLE, visibleLength, ROLE_MAIN, ROLE_MAIN_TAG, CONTENT_WORDS, CHROME_WORDS, CLOSES_P, isLinkList, MIN_PROSE, PDF_URL_RE, PDF_ROUTE_RE, NON_PDF_TAIL_RE, PDF_FETCH_OPTS, DOC_FETCH_OPTS, PURE_VIDEO_HOSTS, HTML_TYPE_RE, NON_TEXT_TYPE_RE, CONSENT_PATTERNS, CONSENT_ACTIONS, BANNER_VOICE, BUTTON_LABEL, BUTTON_LENGTH, NOTICE_LENGTH, MD_FENCE, MD_LINE_START, MD_DESTINATION, MD_MARKUP;
var init_fetch = __esm({
  "src/fetch.ts"() {
    "use strict";
    init_brand();
    init_charset();
    init_entities();
    init_html();
    init_mime();
    init_retry();
    init_text();
    init_markdown2();
    init_pdf();
    init_doc();
    init_firecrawl();
    init_video();
    init_mode();
    init_junk();
    DEFAULT_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    RETRY_STATUS = /* @__PURE__ */ new Set([429, 503, 502, 504]);
    defaultTimeoutMs2 = () => envInt("TIMEOUT_MS", 2e4, 1e3, 3e5);
    DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
    mimeOf = (contentType) => contentType.split(";")[0].trim().toLowerCase();
    namesDocument = (filename) => filename !== void 0 && (PDF_URL_RE.test(filename) || docFormatForUrl(filename) !== void 0);
    REDIRECT_STATUS = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
    INLINE_FORMAT = /* @__PURE__ */ new Set([...INLINE_TAGS, "br", "scp"]);
    INLINE_FORMAT_TAG = /<(\/?)([a-zA-Z][\w.-]*(?::[\w.-]+)?)(?=[\s/>])([^<>]*)>/g;
    NUL2 = "\0";
    PRE_SLOT = (i) => `
${NUL2}${i}${NUL2}
`;
    HEADING_OPEN = /<h([1-6])(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
    HEADING_BOUNDARY = /<\/h[1-6]\s*>|<h[1-6](?=[\s/>])/gi;
    PERMALINK = /<a\b[^<>]*>\s*(?:(?:¶|#|§|🔗|&para;|&#182;|&#x[bB]6;|&sect;)\s*)?<\/a\s*>/gi;
    NOT_TITLE = ["script", "style", "template", "svg"];
    visibleLength = (h) => h.replace(/<[^<>]*>/g, " ").replace(/\s+/g, " ").trim().length;
    ROLE_MAIN = /\srole\s*=\s*["']?main(?=["'\s/>])/i;
    ROLE_MAIN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])[^<>]*\srole\s*=\s*["']?main(?=["'\s/>])/gi;
    CONTENT_WORDS = /* @__PURE__ */ new Set(["content", "article", "post", "entry", "story", "main", "prose"]);
    CHROME_WORDS = /* @__PURE__ */ new Set([
      "nav",
      "navbar",
      "navigation",
      "menu",
      "header",
      "footer",
      "sidebar",
      "breadcrumb",
      "breadcrumbs",
      "banner",
      "cookie",
      "consent",
      "comment",
      "comments",
      "related",
      "share",
      "social",
      "toolbar",
      "widget",
      "meta",
      "ad",
      "ads",
      "promo"
    ]);
    CLOSES_P = /* @__PURE__ */ new Set([
      "address",
      "article",
      "aside",
      "blockquote",
      "div",
      "dl",
      "fieldset",
      "figure",
      "footer",
      "form",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "hr",
      "main",
      "nav",
      "ol",
      "pre",
      "section",
      "table",
      "ul"
    ]);
    isLinkList = (s) => s.len > 0 && s.link > s.len * 0.5;
    MIN_PROSE = 200;
    PDF_URL_RE = /\.pdf($|[?#])/i;
    PDF_ROUTE_RE = /\/pdf\/[^/?#]+($|[?#])/i;
    NON_PDF_TAIL_RE = /\.(html?|php|aspx?|jsp|json|xml|txt|md|csv)($|[?#])/i;
    PDF_FETCH_OPTS = { accept: "application/pdf,*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
    DOC_FETCH_OPTS = { accept: "*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
    PURE_VIDEO_HOSTS = /* @__PURE__ */ new Set(["youtube", "vimeo", "dailymotion"]);
    HTML_TYPE_RE = /^(?:text\/html|application\/xhtml\+xml)$/;
    NON_TEXT_TYPE_RE = /^(?:image\/(?!svg\+xml$)|audio\/|video\/|font\/|model\/|application\/(?:gzip|x-gzip|x-tar|x-bzip2|x-xz|x-7z-compressed|x-rar-compressed|vnd\.rar|java-archive|wasm|x-msdownload|vnd\.android\.package-archive|x-shockwave-flash|ogg)$)/;
    CONSENT_PATTERNS = [
      /\bcookies?\b/i,
      /\bconsent\b/i,
      /\bgdpr\b/i,
      /\bccpa\b/i,
      /accept all\b/i,
      /reject all\b/i,
      /manage (?:preferences|choices|cookies|settings)/i,
      /privacy (?:policy|preferences|choices)/i,
      /tracking technolog/i,
      /advertising partners/i,
      /legitimate interest/i,
      // FR / DE: the locale layer targets those markets, and their consent
      // managers (Didomi, Usercentrics, OneTrust) speak the local language.
      /\bconsentement\b/i,
      /\brgpd\b/i,
      /\beinwilligung\b/i,
      /\bdsgvo\b/i
    ];
    CONSENT_ACTIONS = [
      /\b(?:accept|reject|decline|agree|allow|manage|preferences|settings|choices)\b/i,
      /\b(?:opt[ -]out|we use cookies|this (?:site|website) uses cookies|by continuing)\b/i,
      /\b(?:learn more|privacy policy|cookie policy)\b/i
    ];
    BANNER_VOICE = /\b(?:we|us|our)\b[^.]{0,60}?\b(?:cookies?|partners|consent|tracking)\b|\bby (?:clicking|continuing|using|browsing)\b|\bthis (?:site|website) uses cookies\b|\bnous (?:utilisons|et nos partenaires)\b|\ben cliquant sur\b|\bwir (?:verwenden|nutzen|setzen|und unsere partner)\b|\bmit (?:dem )?klick auf\b/i;
    BUTTON_LABEL = /^(?:tout (?:accepter|refuser)|(?:accepter|refuser) tout|accepter et (?:fermer|continuer)|continuer sans accepter|(?:param[ée]trer|g[ée]rer|personnaliser|accepter|refuser) (?:les|mes) cookies|alle (?:cookies )?(?:akzeptieren|ablehnen)|nur (?:notwendige|essenzielle)(?: cookies)?|cookie-einstellungen|einstellungen verwalten|akzeptieren und schlie(?:ß|ss)en)$/i;
    BUTTON_LENGTH = 40;
    NOTICE_LENGTH = 400;
    MD_FENCE = /^[\s>]*(`{3,}|~{3,})(.*)$/;
    MD_LINE_START = /^[\s>]*(?:(?:[-+*]|\d{1,9}[.)])\s+)?(?:#{1,6}\s+)?/;
    MD_DESTINATION = /\]\((?:[^()\s\\]|\\.|\([^()\s]*\))*\)/g;
    MD_MARKUP = /\\(?=[!-/:-@[-`{-~])|!?\[|\]|\*+|`+/g;
  }
});

// src/browser/keys.ts
function charKey(c) {
  if (c === "\n" || c === "\r") return NAMED2.get("enter");
  if (c === "	") return NAMED2.get("tab");
  if (c === " ") return NAMED2.get(" ");
  if (/^[a-z]$/i.test(c)) return { key: c, code: `Key${c.toUpperCase()}`, vk: c.toUpperCase().charCodeAt(0), text: c };
  if (/^[0-9]$/.test(c)) return { key: c, code: `Digit${c}`, vk: c.charCodeAt(0), text: c };
  const p = PUNCT[c];
  return p ? { key: c, code: p[0], vk: p[1], text: c } : { key: c, code: "", vk: 0, text: c };
}
function modifierBit(raw) {
  const hit = MODIFIERS.find(([, , aliases]) => aliases.includes(raw.toLowerCase()));
  if (!hit) throw new UsageError(`unknown modifier "${raw}" \u2014 use Control, Alt, Meta or Shift`);
  return hit[0];
}
function parseKey(input) {
  if (isChar(input)) return toSpec(charKey(input), 0);
  const parts = input.split("+");
  if (parts.length > 2 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
  const last = parts.pop();
  let mods = 0;
  for (const m of parts) mods |= modifierBit(m);
  if (last === "") throw new UsageError(`missing key in "${input}" \u2014 e.g. Control+A`);
  const named = isChar(last) ? charKey(last) : NAMED2.get(last.toLowerCase());
  if (!named) throw new UsageError(`unknown key "${last}" \u2014 use a single character or a name such as Enter, Tab, Escape, ArrowDown, PageUp, F1\u2026F12`);
  return toSpec(named, mods);
}
function toSpec(n, modifiers) {
  let { key, text } = n;
  if (modifiers & SHIFT && /^[a-z]$/.test(key)) key = text = key.toUpperCase();
  if (modifiers & (CTRL | ALT | META)) text = void 0;
  return { key, code: n.code, windowsVirtualKeyCode: n.vk, ...text !== void 0 ? { text } : {}, modifiers };
}
function keyName(spec) {
  const mods = MODIFIERS.filter(([bit]) => spec.modifiers & bit).map(([, m]) => m.key);
  return [...mods, spec.key === " " ? "Space" : spec.key].join("+");
}
function keyEventsFor(spec) {
  const held = MODIFIERS.filter(([bit]) => spec.modifiers & bit);
  const out = [];
  let mods = 0;
  for (const [bit, m] of held) {
    mods |= bit;
    out.push({ type: "rawKeyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers: mods, location: 1 });
  }
  const base2 = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, nativeVirtualKeyCode: spec.windowsVirtualKeyCode };
  out.push(
    spec.text !== void 0 ? { type: "keyDown", ...base2, text: spec.text, unmodifiedText: spec.text, modifiers: mods } : { type: "rawKeyDown", ...base2, modifiers: mods }
  );
  out.push({ type: "keyUp", ...base2, modifiers: mods });
  for (const [bit, m] of [...held].reverse()) {
    mods &= ~bit;
    out.push({ type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers: mods, location: 1 });
  }
  return out;
}
var ALT, CTRL, META, SHIFT, MODIFIERS, NAMED2, name, PUNCT, punct, isChar;
var init_keys = __esm({
  "src/browser/keys.ts"() {
    "use strict";
    init_cli_kit();
    ALT = 1;
    CTRL = 2;
    META = 4;
    SHIFT = 8;
    MODIFIERS = [
      [ALT, { key: "Alt", code: "AltLeft", vk: 18 }, ["alt", "option", "opt"]],
      [CTRL, { key: "Control", code: "ControlLeft", vk: 17 }, ["control", "ctrl"]],
      [META, { key: "Meta", code: "MetaLeft", vk: 91 }, ["meta", "cmd", "command", "super", "win"]],
      [SHIFT, { key: "Shift", code: "ShiftLeft", vk: 16 }, ["shift"]]
    ];
    NAMED2 = /* @__PURE__ */ new Map();
    name = (n, ...aliases) => {
      for (const a of [n.key, ...aliases]) NAMED2.set(a.toLowerCase(), n);
    };
    name({ key: "Enter", code: "Enter", vk: 13, text: "\r" }, "Return");
    name({ key: "Tab", code: "Tab", vk: 9 });
    name({ key: "Escape", code: "Escape", vk: 27 }, "Esc");
    name({ key: "Backspace", code: "Backspace", vk: 8 });
    name({ key: "Delete", code: "Delete", vk: 46 }, "Del");
    name({ key: "Insert", code: "Insert", vk: 45 });
    name({ key: "ArrowUp", code: "ArrowUp", vk: 38 }, "Up");
    name({ key: "ArrowDown", code: "ArrowDown", vk: 40 }, "Down");
    name({ key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, "Left");
    name({ key: "ArrowRight", code: "ArrowRight", vk: 39 }, "Right");
    name({ key: "Home", code: "Home", vk: 36 });
    name({ key: "End", code: "End", vk: 35 });
    name({ key: "PageUp", code: "PageUp", vk: 33 });
    name({ key: "PageDown", code: "PageDown", vk: 34 });
    name({ key: " ", code: "Space", vk: 32, text: " " }, "Space");
    for (let i = 1; i <= 12; i++) name({ key: `F${i}`, code: `F${i}`, vk: 111 + i });
    for (const [, spec, aliases] of MODIFIERS) name(spec, ...aliases);
    PUNCT = {};
    punct = (chars, code, vk) => {
      for (const c of chars) PUNCT[c] = [code, vk];
    };
    punct("-_", "Minus", 189);
    punct("=+", "Equal", 187);
    punct("[{", "BracketLeft", 219);
    punct("]}", "BracketRight", 221);
    punct("\\|", "Backslash", 220);
    punct(";:", "Semicolon", 186);
    punct(`'"`, "Quote", 222);
    punct(",<", "Comma", 188);
    punct(".>", "Period", 190);
    punct("/?", "Slash", 191);
    punct("`~", "Backquote", 192);
    ")!@#$%^&*(".split("").forEach((c, i) => punct(c, `Digit${i}`, 48 + i));
    isChar = (s) => [...s].length === 1;
  }
});

// src/browser/risk.ts
function matchLabel(label) {
  return label ? IRREVERSIBLE_RE.exec(norm2(label))?.[1]?.replace(/\s+/g, " ") : void 0;
}
function assessRisk(ctx) {
  const spaceClick = ctx.action === "press" && isSpace2(ctx.key) && SPACE_ACTIVATES.has(ctx.role ?? "");
  if (ctx.action === "press" && !isEnter(ctx.key) && !spaceClick) return { risky: false };
  if (ctx.isSubmit && ctx.formHasPassword) return { risky: true, reason: PASSWORD_REASON };
  const acts = ctx.action === "click" || spaceClick || ACTIVATES.has(ctx.role ?? "");
  const label = acts ? ctx.label : ctx.isSubmit ? ctx.submitLabel ?? "" : "";
  const word = matchLabel(label);
  if (word) return { risky: true, reason: `the control "${shown(label)}" looks irreversible (matches "${word}")` };
  return { risky: false };
}
function assessDialog(type, message) {
  if (type === "alert") return { risky: false };
  const word = matchLabel(message);
  return word ? { risky: true, reason: `it looks irreversible (matches "${word}")` } : { risky: false };
}
function collected2(r) {
  if (r.exceptionDetails)
    throw new UninspectableError(`could not inspect the target: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "page error"}`);
  const v = r.result?.value;
  if (typeof v !== "object" || v === null) throw new UninspectableError("could not inspect the target: it is not an element");
  if (v.frame === true) {
    const readable = v.readable === true;
    throw new UninspectableError(readable ? `${FRAME_REASON} \u2014 click the element inside it instead, from the snapshot` : FRAME_REASON);
  }
  return { role: "", label: "", isSubmit: false, formHasPassword: false, submitLabel: "", ...v };
}
async function riskContext(page, backendNodeId, action, _key) {
  if (action === "press") {
    return collected2(
      await page.send("Runtime.evaluate", {
        expression: `(${COLLECT_SOURCE}).call((${FOCUS_SOURCE})(document), ${JSON.stringify(action)})`,
        returnByValue: true
      })
    );
  }
  if (backendNodeId === void 0) throw new Error("a click needs a backendNodeId to inspect");
  const { object } = await page.send("DOM.resolveNode", { backendNodeId });
  try {
    return collected2(
      await page.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: COLLECT_SOURCE,
        arguments: [{ value: action }],
        returnByValue: true
      })
    );
  } finally {
    if (object.objectId) await page.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {
    });
  }
}
async function guardAction(page, opts) {
  if (opts.confirm) return;
  if (opts.action === "press" && !isEnter(opts.key) && !isSpace2(opts.key)) return;
  let el;
  try {
    el = await riskContext(page, opts.backendNodeId, opts.action, opts.key);
  } catch (e) {
    if (!(e instanceof UninspectableError)) throw e;
    throw new RiskRefusedError(opts.action, e.message, "", opts.key);
  }
  const risk = assessRisk({ action: opts.action, ...opts.key !== void 0 ? { key: opts.key } : {}, ...el });
  if (risk.risky) {
    const onTarget = opts.action === "click" || (isSpace2(opts.key) ? SPACE_ACTIVATES : ACTIVATES).has(el.role);
    throw new RiskRefusedError(opts.action, risk.reason ?? "looks irreversible", onTarget ? el.label : el.submitLabel || el.label, opts.key);
  }
}
var PASSWORD_REASON, IRREVERSIBLE, SIGN, IRREVERSIBLE_RE, norm2, ENTER, SPACE, lastKey, isEnter, isSpace2, ACTIVATES, SPACE_ACTIVATES, shown, FOCUS_SOURCE, OWNER_SOURCE, COLLECT_SOURCE, UninspectableError, FRAME_REASON, RiskRefusedError;
var init_risk = __esm({
  "src/browser/risk.ts"() {
    "use strict";
    PASSWORD_REASON = "form contains a password field \u2014 let the human log in";
    IRREVERSIBLE = [
      // pay
      "pay(?:er|ez|ment)?",
      "paie(?:ment)?",
      "purchase",
      "buy",
      "achet(?:er|ez|e)",
      "achat",
      // order
      "order",
      "command(?:er|ez|e)",
      "check\\s*out",
      "place\\s+order",
      // confirm, validate
      "confirm(?:er|ez|e)?",
      "validate",
      "valid(?:er|ez|e)",
      // delete, remove
      "delete",
      "remove",
      "supprim(?:er|ez|e)",
      "suppression",
      // publish, post, send, submit
      "publish",
      "publi(?:er|ez|e|cation)",
      "post",
      "post(?:er|ez)",
      "send",
      "envo(?:y\\w*|i)",
      "submit",
      "soumett\\w*",
      "soumettre",
      "transfer",
      "virement",
      // subscriptions
      "subscribe",
      "unsubscribe",
      "(?:des)?abonn(?:er|ez|e)",
      "resili(?:er|ez|e|ation)",
      "cancel\\s+subscription",
      // signing, booking, giving, depositing
      "sign(?:er|ez)",
      "book",
      "reserv(?:er|ez|e|ation)",
      "donate",
      "faire\\s+un\\s+don",
      "close\\s+account",
      "fermer\\s+le\\s+compte",
      "depos(?:er|ez|e)",
      "deposit"
    ];
    SIGN = "sign(?!\\s*-?\\s*(?:in|out)(?![a-z0-9]))";
    IRREVERSIBLE_RE = new RegExp(`(?<![a-z0-9])(${[...IRREVERSIBLE, SIGN].join("|")})(?![a-z0-9])`);
    norm2 = (s) => s.normalize("NFD").replace(new RegExp("\\p{M}", "gu"), "").replace(/[‘’]/g, "'").toLowerCase();
    ENTER = /* @__PURE__ */ new Set(["enter", "numpadenter", "return"]);
    SPACE = /* @__PURE__ */ new Set([" ", "space", "spacebar"]);
    lastKey = (key) => {
      const k = key ?? "";
      return k.endsWith("+ ") || k === " " ? " " : k.split("+").pop()?.toLowerCase() ?? "";
    };
    isEnter = (key) => ENTER.has(lastKey(key));
    isSpace2 = (key) => SPACE.has(lastKey(key));
    ACTIVATES = /* @__PURE__ */ new Set(["button", "link", "menuitem"]);
    SPACE_ACTIVATES = /* @__PURE__ */ new Set([...ACTIVATES, "checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio", "option", "tab", "treeitem"]);
    shown = (label) => label.length > 60 ? `${label.slice(0, 57)}...` : label;
    FOCUS_SOURCE = `function (doc) {
  let el = doc.activeElement;
  for (let i = 0; el && i < 32; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
      continue;
    }
    if (!/^i?frame$/i.test(el.tagName || "")) break;
    let inner = null;
    try { inner = el.contentDocument; } catch (e) { inner = null; }
    if (!inner || !inner.activeElement) break;
    el = inner.activeElement;
  }
  return el;
}`;
    OWNER_SOURCE = `(node) => {
  const formHost = (h) => !!h && /^(input|textarea|select)$/i.test(h.tagName || "");
  let el = node;
  for (let i = 0; el && el.nodeType !== 1 && i < 64; i++) el = el.nodeType === 11 ? (formHost(el.host) ? el.host : null) : el.parentElement || el.parentNode;
  for (let i = 0; el && el.nodeType === 1 && i < 8; i++) {
    const root = el.getRootNode ? el.getRootNode() : null;
    const host = root && root.nodeType === 11 ? root.host : null;
    if (!formHost(host)) break;
    el = host;
  }
  return el && el.nodeType === 1 ? el : null;
}`;
    COLLECT_SOURCE = `function (action) {
  const el = (${OWNER_SOURCE})(this);
  if (!el) return null;
  if (/^i?frame$/i.test(el.tagName || "")) {
    let inner = null;
    try { inner = el.contentDocument; } catch (e) { inner = null; }
    return { frame: true, readable: !!inner };
  }
  // The element's own document: it may sit in a same-origin frame, or a shadow root.
  const doc = el.ownerDocument || document;
  const BTN = "button,[role=button],input[type=submit],input[type=image],input[type=button]";
  const PW = "input[type=password]";
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().slice(0, 200);
  // The control the user means: a click on a span inside a button is a click on the button.
  const ctl = el.closest(BTN) || el;
  const tag = ctl.tagName.toLowerCase();
  const type = (ctl.getAttribute("type") || "").toLowerCase();
  const buttonInput = tag === "input" && ["button", "submit", "reset", "image"].includes(type);
  const buttonish = tag === "button" || buttonInput || (ctl.getAttribute("role") || "").toLowerCase() === "button";
  const labelOf = (e) => {
    const t = e.tagName.toLowerCase();
    const ty = (e.getAttribute("type") || "").toLowerCase();
    const isBtn = t === "button" || (t === "input" && ["button", "submit", "reset", "image"].includes(ty)) || (e.getAttribute("role") || "") === "button";
    const root = e.getRootNode ? e.getRootNode() : doc;
    const byId = (id) => (root && root.getElementById ? root.getElementById(id) : null) || doc.getElementById(id);
    const by = (e.getAttribute("aria-labelledby") || "").split(/\\s+/).map((id) => (byId(id) || {}).textContent).filter(Boolean).join(" ");
    const alts = Array.from(e.querySelectorAll("img[alt],svg title"), (n) => n.getAttribute("alt") || n.textContent);
    const labels = isBtn && e.labels ? Array.from(e.labels, (l) => l.textContent) : [];
    const value = t === "input" && ["button", "submit", "reset", "image"].includes(ty) ? e.value : "";
    // A web component's text may live in its open shadow root only: innerText and textContent of the host do not show it.
    const shadow = t !== "input" && e.shadowRoot ? e.shadowRoot.textContent : "";
    return norm([e.getAttribute("aria-label"), by, e.getAttribute("title"), e.getAttribute("alt"), value, t === "input" ? "" : e.innerText || e.textContent, shadow, ...alts, ...labels].filter(Boolean).join(" "));
  };
  const explicit = (ctl.getAttribute("role") || "").toLowerCase();
  let role = explicit;
  if (!role) {
    if (tag === "button" || buttonInput) role = "button";
    else if (tag === "a" && ctl.hasAttribute("href")) role = "link";
    else if (tag === "textarea" || (tag === "input" && !["checkbox", "radio"].includes(type))) role = "textbox";
    else if (tag === "input") role = type;
    else if (tag === "select") role = "combobox";
    else role = tag;
  }
  // The form, or with none (a single-page login) the nearest few ancestors holding a password field.
  const form = ctl.form || ctl.closest("form");
  let scope = form;
  if (!scope) {
    // Out of a shadow root to its host: a login widget's password may sit in its own root.
    const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    let a = up(ctl);
    for (let i = 0; a && i < 5 && a !== doc.body && a !== doc.documentElement; i++, a = up(a)) {
      if (a.querySelector(PW)) { scope = a; break; }
    }
  }
  const formHasPassword = !!scope && (form ? Array.from(form.elements).some((x) => x.type === "password") || !!form.querySelector(PW) : true);
  const submitter = form ? form.querySelector("button[type=submit], input[type=submit], input[type=image], button:not([type])") : scope ? scope.querySelector(BTN) : null;
  const label = labelOf(ctl);
  const toggle = /show|hide|reveal|afficher|masquer|visib/i.test(label);
  const nativeSubmit = !!form && ((tag === "button" && (type === "" || type === "submit")) || (tag === "input" && (type === "submit" || type === "image")));
  let isSubmit;
  if (buttonish) isSubmit = !toggle && (nativeSubmit || formHasPassword);
  else isSubmit = action === "press" && tag !== "textarea" && (!!form || formHasPassword);
  return { role, label, isSubmit, formHasPassword, submitLabel: submitter ? labelOf(submitter) : "" };
}`;
    UninspectableError = class extends Error {
    };
    FRAME_REASON = "cannot inspect the content of this frame (e.g. a payment button)";
    RiskRefusedError = class extends Error {
      constructor(action, reason, label, key) {
        const what = action === "press" ? `press ${key ?? "a key"}` : "click";
        super(`refused to ${what}${label ? ` on "${shown(label)}"` : ""}: ${reason}; ask the user, then retry with --confirm / confirm: true`);
        this.action = action;
        this.reason = reason;
        this.label = label;
        this.key = key;
        this.name = "RiskRefusedError";
      }
      action;
      reason;
      label;
      key;
    };
  }
});

// src/browser/snapshot.ts
function checkRef(ref2) {
  if (!REF_SHAPE.test(ref2))
    throw new UsageError("expected a ref like e12 from the latest snapshot; CSS selectors: use --selector (screenshot, snapshot, text, wait)");
}
async function elementBySelector(page, selector) {
  const { root } = await page.send("DOM.getDocument", { depth: 0 });
  let nodeId;
  try {
    ({ nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector }));
  } catch (e) {
    if (e instanceof CdpError) throw new UsageError(`${JSON.stringify(selector)} is not a valid CSS selector`);
    throw e;
  }
  if (!nodeId) throw new NoMatchError(selector);
  const { node } = await page.send("DOM.describeNode", { nodeId });
  if (typeof node?.backendNodeId !== "number" || node.backendNodeId <= 0) throw new NoMatchError(selector);
  return node.backendNodeId;
}
function fieldHint(nodeName, attributes) {
  const attr3 = /* @__PURE__ */ new Map();
  for (let i = 0; i + 1 < attributes.length; i += 2) attr3.set(attributes[i].toLowerCase(), attributes[i + 1]);
  const quote = (v) => JSON.stringify(v.length > HINT_VALUE_MAX ? `${v.slice(0, HINT_VALUE_MAX)}\u2026` : v);
  const parts = [];
  const type = attr3.get("type")?.trim().toLowerCase() || (nodeName.toUpperCase() === "INPUT" ? "text" : "");
  if (type) parts.push(`type=${type}`);
  const name2 = attr3.get("name")?.trim();
  if (name2) parts.push(`name=${quote(name2)}`);
  const placeholder = attr3.get("placeholder")?.trim();
  if (placeholder) parts.push(`placeholder=${quote(placeholder)}`);
  const id = attr3.get("id")?.trim();
  if (!name2 && id) parts.push(`id=${quote(id)}`);
  return parts.length ? `(${parts.join(", ")})` : void 0;
}
function buildTree(nodes) {
  const byId = /* @__PURE__ */ new Map();
  for (const n of nodes) byId.set(n.nodeId, n);
  return { byId, root: nodes.find((n) => n.parentId === void 0 || !byId.has(n.parentId)) };
}
function prop(n, name2) {
  return n.properties?.find((p) => p.name === name2)?.value?.value;
}
function merge(items) {
  const out = [];
  let run = "";
  const flush = () => {
    const text = squash(run);
    if (text) out.push({ t: "text", text });
    run = "";
  };
  for (const it of items) {
    if (it.t === "text") run += it.text;
    else {
      flush();
      if (it.t === "node") out.push(it);
    }
  }
  flush();
  return out;
}
function states(n) {
  const out = [];
  const checked = prop(n, "checked");
  if (checked === "mixed") out.push("[checked=mixed]");
  else if (truthy(checked)) out.push("[checked]");
  if (truthy(prop(n, "disabled"))) out.push("[disabled]");
  const expanded = prop(n, "expanded");
  if (expanded !== void 0) out.push(`[expanded=${truthy(expanded)}]`);
  if (truthy(prop(n, "selected"))) out.push("[selected]");
  const pressed = prop(n, "pressed");
  if (pressed === "mixed") out.push("[pressed=mixed]");
  else if (truthy(pressed)) out.push("[pressed]");
  if (truthy(prop(n, "required"))) out.push("[required]");
  if (truthy(prop(n, "focused"))) out.push("[focused]");
  return out;
}
function nested(items, depth, out) {
  const pad = "  ".repeat(depth);
  for (const it of items) {
    if (it.t === "text") out.push({ text: `${pad}- text: ${it.text}`, ref: false });
    else if (it.t === "node") {
      out.push({ text: pad + it.head, ref: it.ref });
      if (it.url) out.push({ text: `${pad}  - /url: ${it.url}`, ref: false });
      nested(it.children, depth + 1, out);
    }
  }
}
function flat(items, out) {
  for (const it of items) {
    if (it.t !== "node") continue;
    if (it.act) out.push({ text: it.head, ref: true });
    flat(it.children, out);
  }
}
function renderSnapshot(nodes, opts) {
  const r = new Renderer(opts.refs, opts.frames ?? {}, opts.hints);
  const main2 = buildTree(nodes);
  const all = [];
  let items = [];
  if (opts.rootBackendId !== void 0) {
    const hit = r.find(main2, opts.rootBackendId);
    if (hit) items = merge(r.collect(hit.tree, hit.node));
  } else {
    for (const id of opts.overlays ?? []) {
      const hit = r.find(main2, id);
      if (!hit) continue;
      const lines = [];
      const over = merge(r.collect(hit.tree, hit.node));
      if (opts.interactive) flat(over, lines);
      else nested(over, 1, lines);
      if (lines.length === 0) continue;
      all.push({ text: OVERLAY_HEADER, ref: false }, ...opts.interactive ? lines.map((l) => ({ ...l, text: `  ${l.text}` })) : lines);
    }
    if (main2.root) items = merge(r.collect(main2, main2.root));
  }
  if (opts.interactive) flat(items, all);
  else nested(items, 0, all);
  let kept = all;
  let tail = "";
  if (opts.maxChars !== void 0) {
    let used = 0;
    let n = 0;
    for (const l of all) {
      const cost = l.text.length + (n > 0 ? 1 : 0);
      if (used + cost > opts.maxChars) break;
      used += cost;
      n++;
    }
    const hint = "use `snapshot <ref>` or --interactive";
    if (n === 0 && all.length > 0) {
      const first = all[0];
      const text2 = `${first.text.slice(0, Math.max(0, opts.maxChars - 1))}\u2026`;
      const ref2 = first.ref && /\[ref=e\d+\]/.test(text2);
      const more = all.length - 1;
      kept = [{ text: text2, ref: ref2 }];
      tail = `\u2026 [truncated: the first line cut${more ? `, ${more} more line${more === 1 ? "" : "s"}` : ""} \u2014 ${hint}]`;
    } else if (n < all.length) {
      kept = all.slice(0, n);
      tail = `\u2026 [truncated: ${all.length - n} more lines \u2014 ${hint}]`;
    }
  }
  const text = [...kept.map((l) => l.text), ...tail ? [tail] : []].join("\n");
  return {
    text,
    refs: {
      loaderId: opts.refs.loaderId,
      url: opts.refs.url,
      next: r.next,
      refs: r.refs,
      ...r.containers.size ? { containers: [...r.containers].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) } : {}
    },
    truncated: tail !== "",
    refCount: kept.filter((l) => l.ref).length,
    unclear: unclearControls(r.controls)
  };
}
function unclearControls(controls) {
  const count = /* @__PURE__ */ new Map();
  for (const c of controls) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  return controls.filter((c) => c.name === "" || (count.get(c.name) ?? 0) > 1).map((c) => c.id);
}
async function lookupHints(page, ids) {
  const out = {};
  await Promise.all(
    ids.slice(0, HINT_MAX).map(async (backendNodeId) => {
      try {
        const { node } = await page.send("DOM.describeNode", { backendNodeId });
        const hint = fieldHint(node?.nodeName ?? "", node?.attributes ?? []);
        if (hint) out[backendNodeId] = hint;
      } catch {
      }
    })
  );
  return out;
}
function frameIds(t, into = /* @__PURE__ */ new Set()) {
  into.add(t.frame.id);
  for (const c of t.childFrames ?? []) frameIds(c, into);
  return into;
}
async function collectFrames(session, main2) {
  const out = {};
  let known;
  try {
    const { frameTree } = await session.page.send("Page.getFrameTree");
    known = frameIds(frameTree);
  } catch {
    return out;
  }
  const queue2 = [main2];
  let fetched = 0;
  for (let list = queue2.shift(); list; list = queue2.shift()) {
    for (const n of list) {
      if (n.ignored || n.backendDOMNodeId === void 0 || str4(n.role).toLowerCase() !== "iframe" || fetched >= FRAME_MAX) continue;
      try {
        const { node } = await session.page.send("DOM.describeNode", { backendNodeId: n.backendDOMNodeId });
        if (!node.frameId || !known.has(node.frameId)) continue;
        const { nodes } = await session.page.send("Accessibility.getFullAXTree", { frameId: node.frameId });
        fetched++;
        out[String(n.backendDOMNodeId)] = nodes;
        queue2.push(nodes);
      } catch {
      }
    }
  }
  return out;
}
async function takeSnapshot(session, opts = {}) {
  if (opts.ref !== void 0 && opts.selector !== void 0) throw new UsageError("a snapshot is scoped to a ref or to a selector, not both");
  if (opts.ref !== void 0) checkRef(opts.ref);
  const loaderId = await session.loaderId();
  const url = await session.currentUrl();
  const title = await session.title();
  const saved = readRefs(session.targetId);
  const table = saved && saved.loaderId === loaderId ? { ...saved, url } : { loaderId, url, next: 1, refs: {} };
  let rootBackendId;
  if (opts.ref !== void 0) {
    rootBackendId = Object.hasOwn(table.refs, opts.ref) ? table.refs[opts.ref] : void 0;
    if (rootBackendId === void 0) throw new StaleRefError(opts.ref);
  } else if (opts.selector !== void 0) rootBackendId = await elementBySelector(session.page, opts.selector);
  await session.page.send("Accessibility.enable");
  const fetchTree = async () => (await session.page.send("Accessibility.getFullAXTree", {})).nodes;
  let nodes = await fetchTree();
  const overlays = rootBackendId === void 0 ? await findOverlays(session.page) : [];
  if (overlays.some((id) => !nodes.some((n) => n.backendDOMNodeId === id))) {
    await new Promise((r2) => setTimeout(r2, OVERLAY_RETRY_MS));
    nodes = await fetchTree();
  }
  const frames = await collectFrames(session, nodes);
  const hasRoot = rootBackendId === void 0 || [nodes, ...Object.values(frames)].some((l) => l.some((n) => n.backendDOMNodeId === rootBackendId));
  if (!hasRoot) {
    if (opts.ref !== void 0) throw new StaleRefError(opts.ref);
    throw new Error(`the element ${opts.selector} matches is not in the accessibility tree: scope to an ancestor, or take the whole snapshot`);
  }
  const render2 = (hints) => renderSnapshot(nodes, {
    refs: table,
    frames,
    ...opts.interactive !== void 0 ? { interactive: opts.interactive } : {},
    ...opts.maxChars !== void 0 ? { maxChars: opts.maxChars } : {},
    ...rootBackendId !== void 0 ? { rootBackendId } : {},
    ...overlays.length ? { overlays } : {},
    ...hints ? { hints } : {}
  });
  let r = render2();
  if (r.unclear.length) {
    const hints = await lookupHints(session.page, r.unclear);
    if (Object.keys(hints).length) r = render2(hints);
  }
  writeRefs(session.targetId, r.refs);
  return { text: `url: ${url}
title: ${title}
${r.text}`, url, title, loaderId, refCount: r.refCount, truncated: r.truncated };
}
var StaleRefError, REF_SHAPE, NoMatchError, NAME_MAX, OVERLAY_HEADER, OVERLAY_RETRY_MS, FRAME_MAX, COLLAPSIBLE, HOISTED, TEXT_ROLES, REF_ROLES, CONTAINER_ROLES, NAMED_CONTAINER_ROLES, VALUE_ROLES, FIELD_ROLES, HINT_ROLES, HINT_MAX, HINT_VALUE_MAX, str4, squash, truthy, Renderer;
var init_snapshot = __esm({
  "src/browser/snapshot.ts"() {
    "use strict";
    init_cli_kit();
    init_cdp();
    init_overlay();
    init_state();
    StaleRefError = class extends Error {
      constructor(ref2) {
        super(`ref ${JSON.stringify(ref2)} is unknown or stale: take a new snapshot and use the refs it returns`);
        this.ref = ref2;
        this.name = "StaleRefError";
      }
      ref;
    };
    REF_SHAPE = /^e\d+$/;
    NoMatchError = class extends Error {
      constructor(selector) {
        super(`no element matches ${selector}`);
        this.selector = selector;
        this.name = "NoMatchError";
      }
      selector;
    };
    NAME_MAX = 120;
    OVERLAY_HEADER = "- overlay (covers the page):";
    OVERLAY_RETRY_MS = 300;
    FRAME_MAX = 10;
    COLLAPSIBLE = /* @__PURE__ */ new Set(["generic", "none", "presentation", "GenericContainer"]);
    HOISTED = /* @__PURE__ */ new Set(["RootWebArea", "WebArea"]);
    TEXT_ROLES = /* @__PURE__ */ new Set(["StaticText", "text"]);
    REF_ROLES = /* @__PURE__ */ new Set([
      "button",
      "link",
      "textbox",
      "searchbox",
      "combobox",
      "listbox",
      "option",
      "checkbox",
      "radio",
      "switch",
      "slider",
      "spinbutton",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "tab",
      "treeitem",
      "iframe",
      "heading"
    ]);
    CONTAINER_ROLES = /* @__PURE__ */ new Set(["table", "figure", "article", "main", "complementary", "form"]);
    NAMED_CONTAINER_ROLES = /* @__PURE__ */ new Set(["region", "image", "img"]);
    VALUE_ROLES = /* @__PURE__ */ new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
    FIELD_ROLES = /* @__PURE__ */ new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
    HINT_ROLES = /* @__PURE__ */ new Set(["textbox", "searchbox", "combobox", "spinbutton", "checkbox", "radio", "button"]);
    HINT_MAX = 50;
    HINT_VALUE_MAX = 40;
    str4 = (v) => typeof v?.value === "string" ? v.value : typeof v?.value === "number" ? String(v.value) : "";
    squash = (s) => s.replace(/\s+/g, " ").trim();
    truthy = (v) => v === true || v === "true" || typeof v === "string" && v !== "" && v !== "false";
    Renderer = class {
      constructor(table, frames, hints = {}) {
        this.frames = frames;
        this.hints = hints;
        this.refs = { ...table.refs };
        this.containers = new Set(table.containers ?? []);
        this.next = table.next;
      }
      frames;
      hints;
      refs;
      /** The refs that name a container only, never a control. */
      containers;
      next;
      /** The form controls rendered, in document order, with the name each was shown with. */
      controls = [];
      seen = /* @__PURE__ */ new Set();
      trees = /* @__PURE__ */ new Map();
      refFor(backendId) {
        for (const [k2, v] of Object.entries(this.refs)) if (v === backendId) return k2;
        const k = `e${this.next++}`;
        this.refs[k] = backendId;
        return k;
      }
      frameTree(backendId) {
        const key = String(backendId);
        const nodes = this.frames[key];
        if (!nodes) return void 0;
        let t = this.trees.get(key);
        if (!t) this.trees.set(key, t = buildTree(nodes));
        return t;
      }
      /** Find a node by backendDOMNodeId in the main tree, then in the frame trees. */
      find(main2, backendId) {
        for (const t of [main2, ...Object.keys(this.frames).map((k) => this.frameTree(Number(k)))]) {
          for (const n of t.byId.values()) if (n.backendDOMNodeId === backendId) return { tree: t, node: n };
        }
        return void 0;
      }
      children(tree, n, parent) {
        const out = [];
        for (const id of n.childIds ?? []) {
          const c = tree.byId.get(id);
          if (c) out.push(...this.collect(tree, c, parent));
        }
        return out;
      }
      collect(tree, n, parent = void 0) {
        if (this.seen.has(n)) return [];
        this.seen.add(n);
        const role = str4(n.role);
        if (n.ignored) return this.children(tree, n, parent);
        if (role === "InlineTextBox") return [];
        if (role === "LineBreak") return [{ t: "break" }];
        if (TEXT_ROLES.has(role)) {
          const boxes = (n.childIds ?? []).map((id) => str4(tree.byId.get(id)?.name)).join("");
          return [{ t: "text", text: str4(n.name) || boxes }];
        }
        if (HOISTED.has(role)) return this.children(tree, n, parent);
        const name2 = squash(str4(n.name));
        const hasRole = REF_ROLES.has(role.toLowerCase());
        const acts = n.backendDOMNodeId !== void 0 && (hasRole || truthy(prop(n, "focusable")) || truthy(prop(n, "editable")));
        const container = CONTAINER_ROLES.has(role) || NAMED_CONTAINER_ROLES.has(role) && name2 !== "";
        const wantsRef = acts || n.backendDOMNodeId !== void 0 && container;
        const editor = acts && !hasRole && !name2 && truthy(prop(n, "editable")) && parent?.ref === true && FIELD_ROLES.has(parent.role);
        if (COLLAPSIBLE.has(role) && !name2 && !wantsRef || editor) return [{ t: "break" }, ...this.children(tree, n, parent), { t: "break" }];
        const isFrame = role.toLowerCase() === "iframe";
        const shown2 = isFrame ? "iframe" : role;
        let head = `- ${shown2}`;
        if (name2) head += ` "${(name2.length > NAME_MAX ? `${name2.slice(0, NAME_MAX)}\u2026` : name2).replace(/"/g, '\\"')}"`;
        const level = prop(n, "level");
        if (level !== void 0 && role === "heading") head += ` [level=${String(level)}]`;
        if (wantsRef) {
          const ref2 = this.refFor(n.backendDOMNodeId);
          if (acts) this.containers.delete(ref2);
          else this.containers.add(ref2);
          head += ` [ref=${ref2}]`;
          const id = n.backendDOMNodeId;
          if (acts && HINT_ROLES.has(role)) this.controls.push({ id, name: name2 });
          const hint = this.hints[id];
          if (hint) head += ` ${hint}`;
        }
        for (const s of states(n)) head += ` ${s}`;
        let kids;
        let note = "";
        const inner = isFrame && n.backendDOMNodeId !== void 0 ? this.frameTree(n.backendDOMNodeId) : void 0;
        if (isFrame) {
          if (inner?.root) kids = merge(this.collect(inner, inner.root, void 0));
          else {
            kids = [];
            note = " (cross-origin, not expanded)";
          }
        } else kids = merge(this.children(tree, n, { role, ref: wantsRef }));
        const value = VALUE_ROLES.has(role) ? squash(str4(n.value)) : "";
        kids = kids.filter((k) => !(k.t === "text" && (name2 && k.text === name2 || value && k.text === value)));
        const rawUrl = role === "link" ? prop(n, "url") : void 0;
        const url = typeof rawUrl === "string" ? rawUrl : "";
        return [
          { t: "node", head: value ? `${head}${note}: ${value}` : `${head}${note}`, ref: wantsRef, act: acts, ...url ? { url } : {}, note, children: kids }
        ];
      }
    };
  }
});

// src/browser/actions.ts
import { isAbsolute as isAbsolute4 } from "path";
async function resolveRef(session, ref2) {
  checkRef(ref2);
  const table = readRefs(session.targetId);
  const backendNodeId = table && Object.hasOwn(table.refs, ref2) ? table.refs[ref2] : void 0;
  if (!table || backendNodeId === void 0) throw new StaleRefError(ref2);
  if (table.loaderId !== await session.loaderId()) throw new StaleRefError(ref2);
  let objectId;
  try {
    ({
      object: { objectId }
    } = await session.page.send("DOM.resolveNode", { backendNodeId }));
  } catch (e) {
    if (e instanceof CdpError) throw new StaleRefError(ref2);
    throw e;
  }
  if (!objectId) throw new StaleRefError(ref2);
  return { ref: ref2, backendNodeId, objectId };
}
function release(page, objectId) {
  page.send("Runtime.releaseObject", { objectId }).catch(() => {
  });
}
async function withRef(session, ref2, fn) {
  const node = await resolveRef(session, ref2);
  try {
    return await fn(node);
  } finally {
    release(session.page, node.objectId);
  }
}
async function callOn(page, objectId, fn, args = []) {
  const r = await page.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) throw new ActionError(`the page threw: ${exceptionText(r.exceptionDetails)}`);
  return r.result?.value;
}
function watchDialogs(page) {
  let seen;
  let url;
  let wake = () => {
  };
  const opened = new Promise((resolve12) => {
    wake = resolve12;
  });
  const handler = (p) => {
    if (!seen) {
      seen = { type: String(p?.type ?? "alert"), message: String(p?.message ?? "") };
      if (typeof p?.url === "string") url = p.url;
    }
    wake(null);
  };
  page.on("Page.javascriptDialogOpening", handler);
  return {
    opened,
    seen: () => seen,
    url: () => url,
    stop: () => page.off("Page.javascriptDialogOpening", handler)
  };
}
function stoppable(page, stopped) {
  return {
    sessionId: page.sessionId,
    send: (method, params, o) => stopped() ? Promise.reject(new CutShortError(`${method} not sent: the action was cut short`)) : page.send(method, params, o),
    on: (m, h) => page.on(m, h),
    off: (m, h) => page.off(m, h),
    once: (m, o) => page.once(m, o)
  };
}
async function perform(session, opts, act) {
  const dialogs = watchDialogs(session.page);
  let stopped = false;
  try {
    const armed = await armSettle(session, settleOpts(opts));
    try {
      const running = act(stoppable(session.page, () => stopped));
      running.catch(() => {
      });
      const first = await Promise.race([running.then((value) => ({ value })), dialogs.opened]);
      if (!first) {
        const url2 = dialogs.url();
        return { navigated: false, dialog: dialogs.seen(), ...url2 !== void 0 ? { dialogUrl: url2 } : {} };
      }
      const { navigated } = await armed.done();
      const dialog = dialogs.seen();
      const url = dialogs.url();
      return { navigated, ...dialog ? { dialog } : {}, ...url !== void 0 ? { dialogUrl: url } : {}, value: first.value };
    } finally {
      stopped = true;
      armed.cancel();
    }
  } finally {
    dialogs.stop();
  }
}
async function whereIs(session, p) {
  if (!p.dialog) return { url: await session.currentUrl(), title: await session.title() };
  try {
    const { targetInfo } = await session.page.send(
      "Target.getTargetInfo",
      { targetId: session.targetId },
      { timeoutMs: TARGET_INFO_TIMEOUT_MS }
    );
    if (targetInfo?.url !== void 0) return { url: targetInfo.url, title: targetInfo.title ?? "" };
  } catch {
  }
  return { url: p.dialogUrl ?? "", title: await session.title().catch(() => "") };
}
async function finish(session, action, ref2, p) {
  const { url, title } = await whereIs(session, p);
  const challenge = p.dialog ? null : await detectChallenge(session);
  return {
    ok: true,
    action,
    ...ref2 !== void 0 ? { ref: ref2 } : {},
    navigated: p.navigated,
    url,
    title,
    ...p.dialog ? { dialog: p.dialog } : {},
    challenge,
    ...p.value !== void 0 ? { value: p.value } : {},
    ...p.valueHidden ? { valueHidden: true } : {},
    ...p.note ? { note: p.note } : {}
  };
}
async function visibleQuads(page, node) {
  await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
  let quads = [];
  try {
    quads = (await page.send("DOM.getContentQuads", { backendNodeId: node.backendNodeId })).quads ?? [];
  } catch (e) {
    if (!(e instanceof CdpError)) throw e;
  }
  const shown2 = quads.filter((q) => q.length === 8 && area(q) > 0);
  if (shown2.length === 0) throw new ActionError(`${node.ref}: element is not visible (it has no box on the page)`);
  return shown2;
}
async function centreOf(page, node) {
  const q = (await visibleQuads(page, node))[0];
  return {
    x: Math.round((q[0] + q[2] + q[4] + q[6]) / 4),
    y: Math.round((q[1] + q[3] + q[5] + q[7]) / 4)
  };
}
async function coveredError(page, targetId, ref2, hitObjectId, where2, at) {
  const root = await overlayRootOf(page, hitObjectId);
  if (!root) return new ActionError(`${ref2} is covered by ${where2} at ${at}: close or move it out of the way, then retry`);
  let controls = [];
  try {
    const table = readRefs(targetId);
    if (table) {
      await page.send("Accessibility.enable");
      const { nodes = [] } = await page.send("Accessibility.getFullAXTree", {});
      const r = renderSnapshot(nodes, { refs: table, rootBackendId: root.backendNodeId, interactive: true });
      writeRefs(targetId, r.refs);
      controls = r.text ? r.text.split("\n") : [];
    }
  } catch {
  }
  const shown2 = controls.slice(0, OVERLAY_CONTROLS_MAX);
  const more = controls.length - shown2.length;
  const listed = ["its controls:", ...shown2, ...more > 0 ? [`\u2026 ${more} more \u2014 take a snapshot to see them`] : []].join("\n");
  if (!root.overlay)
    return new ActionError(`${ref2} is covered by ${root.what} at ${at}: close or move it out of the way, then retry${shown2.length ? `; ${listed}` : ""}`);
  const list = shown2.length ? listed : "none of its controls is in the accessibility tree \u2014 take a snapshot";
  return new ActionError(
    `${ref2} is covered by an overlay (${root.what}) at ${at}; ${list}
accepting tracking/consent or closing it is the user's choice \u2014 ask before choosing`
  );
}
async function hitTarget(page, targetId, node, x, y) {
  const at = `(${Math.round(x)}, ${Math.round(y)})`;
  const unreachable = () => new ActionError(`${node.ref} is not reachable at its centre ${at}: the browser finds nothing there to click; scroll, or take a new snapshot`);
  const ask = async (method, params) => {
    try {
      return await page.send(method, params);
    } catch (e) {
      throw e instanceof CdpError ? unreachable() : e;
    }
  };
  const m = await page.send("Page.getLayoutMetrics");
  const vp = m.cssLayoutViewport ?? m.layoutViewport ?? { pageX: 0, pageY: 0 };
  const point = { x: Math.round(x + vp.pageX), y: Math.round(y + vp.pageY), includeUserAgentShadowDOM: true };
  const hit = (await ask("DOM.getNodeForLocation", point)).backendNodeId;
  if (hit === void 0) throw unreachable();
  if (hit === node.backendNodeId) return void 0;
  const objectId = (await ask("DOM.resolveNode", { backendNodeId: hit })).object?.objectId;
  if (!objectId) throw unreachable();
  try {
    const where2 = await callOn(page, node.objectId, PAGE_FUNCTIONS.hitTest, [{ objectId }]);
    if (where2 === true) return void 0;
    if (where2) throw await coveredError(page, targetId, node.ref, objectId, where2, at);
  } finally {
    release(page, objectId);
  }
  return hit;
}
async function click(session, ref2, opts = {}) {
  const button = opts.button ?? "left";
  const count = opts.clickCount ?? 1;
  if (!(button in BUTTONS)) throw new UsageError(`unknown mouse button "${button}" \u2014 use left, right or middle`);
  if (count !== 1 && count !== 2) throw new UsageError(`clickCount is 1 or 2, not ${count}`);
  const page = session.page;
  return withRef(session, ref2, async (node) => {
    if (readRefs(session.targetId)?.containers?.includes(ref2))
      throw new UsageError(`${ref2} is a container \u2014 click a control inside it (take a snapshot of ${ref2})`);
    await guardAction(page, { backendNodeId: node.backendNodeId, action: "click", ...opts.confirm ? { confirm: true } : {} });
    const { x, y } = await centreOf(page, node);
    const inner = await hitTarget(page, session.targetId, node, x, y);
    if (inner !== void 0 && !opts.confirm) await guardAction(page, { backendNodeId: inner, action: "click" });
    const p = await perform(session, opts, async (pg) => {
      await pg.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
      for (let n = 1; n <= count; n++) {
        await pg.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: BUTTONS[button], clickCount: n });
        await pg.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: n });
      }
    });
    return finish(session, "click", ref2, p);
  });
}
async function hover(session, ref2, opts = {}) {
  const page = session.page;
  return withRef(session, ref2, async (node) => {
    const { x, y } = await centreOf(page, node);
    const p = await perform(session, opts, (pg) => pg.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 }));
    return finish(session, "hover", ref2, p);
  });
}
async function dispatchKeys(page, spec) {
  for (const e of keyEventsFor(spec)) await page.send("Input.dispatchKeyEvent", e);
}
async function textField(page, node) {
  const field = await callOn(page, node.objectId, PAGE_FUNCTIONS.fieldKind);
  if (field.kind === "other") {
    const what = field.what ?? "element";
    throw new ActionError(`${node.ref} is ${an(what)} ${what}, not a text field${field.hint ? `: ${field.hint}` : ""}`);
  }
  return field;
}
async function typeText(session, ref2, text, opts = {}) {
  const chars = [...text.replace(/\r\n?/g, "\n")];
  const page = session.page;
  const confirm2 = opts.confirm ? { confirm: true } : {};
  return withRef(session, ref2, async (node) => {
    const field = await textField(page, node);
    await page.send("DOM.focus", { backendNodeId: node.backendNodeId });
    if (opts.submit || chars.includes("\n")) await guardAction(page, { action: "press", key: "Enter", ...confirm2 });
    const p = await perform(session, opts, async (pg) => {
      let tabbed = false;
      const type = async (spec) => {
        if (spec.key === "Enter" || tabbed && spec.key === " ") await guardAction(pg, { action: "press", key: keyName(spec), ...confirm2 });
        if (spec.key === "Tab") tabbed = true;
        await dispatchKeys(pg, spec);
      };
      for (const c of chars) await type(parseKey(c));
      if (opts.submit) await type(parseKey("Enter"));
    });
    return finish(session, "type", ref2, { ...p, ...await echo(page, node, field, p) });
  });
}
function holds2(actual, want) {
  if (typeof actual !== "string") return false;
  if (actual === want || squash2(actual) === squash2(want)) return true;
  const a = alnum(want);
  return a !== "" && alnum(actual) === a;
}
async function echo(page, node, field, p) {
  if (field.secret) return { valueHidden: true };
  if (p.dialog || p.navigated) return {};
  try {
    const value = await callOn(page, node.objectId, PAGE_FUNCTIONS.readValue, [{ value: field.kind }]);
    return typeof value === "string" ? { value } : {};
  } catch {
    return {};
  }
}
async function fill(session, ref2, text, opts = {}) {
  const page = session.page;
  return withRef(session, ref2, async (node) => {
    const field = await textField(page, node);
    const kind = { value: field.kind };
    const p = await perform(session, opts, async (pg) => {
      const read3 = () => callOn(pg, node.objectId, PAGE_FUNCTIONS.readValue, [kind]);
      await pg.send("DOM.focus", { backendNodeId: node.backendNodeId });
      await callOn(pg, node.objectId, PAGE_FUNCTIONS.selectAll, [kind]);
      if (text === "") await dispatchKeys(pg, parseKey("Delete"));
      else await pg.send("Input.insertText", { text });
      const first = await read3();
      if (holds2(first, text)) return first;
      await callOn(pg, node.objectId, PAGE_FUNCTIONS.setValue, [{ value: text }, kind]);
      const now = await read3();
      if (holds2(now, text)) return now;
      const shown2 = field.secret ? "something else" : JSON.stringify(typeof now === "string" && now.length > 80 ? `${now.slice(0, 77)}...` : now);
      throw new ActionError(`could not fill ${ref2}: it holds ${shown2} (an input mask, a maxlength or a script rewrites it); try typeText`);
    });
    return finish(session, "fill", ref2, field.secret ? { ...p, value: void 0, valueHidden: true } : p);
  });
}
async function select(session, ref2, values, opts = {}) {
  if (values.length === 0) throw new UsageError("select needs at least one value (an option's value or its visible label)");
  const page = session.page;
  return withRef(session, ref2, async (node) => {
    const m = await callOn(page, node.objectId, PAGE_FUNCTIONS.matchOptions, [{ value: values }]);
    if (m.error === "not-select") {
      const what = m.what ?? "element";
      throw new ActionError(`${ref2} is ${an(what)} ${what}, not a <select>: click it, then click the option you want in a new snapshot`);
    }
    if (m.error === "missing") {
      const listed = (m.options ?? []).map((o) => `${JSON.stringify(o.value)} (${o.label})`);
      const more = (m.total ?? 0) - listed.length;
      const missing = (m.missing ?? []).map((v) => JSON.stringify(v)).join(", ");
      throw new ActionError(`no option ${missing} in ${ref2}; options: ${listed.join(", ")}${more > 0 ? `, \u2026 and ${more} more` : ""}`);
    }
    if (m.error === "single") throw new ActionError(`${ref2} takes one value, not ${values.length}`);
    const p = await perform(session, opts, (pg) => callOn(pg, node.objectId, PAGE_FUNCTIONS.applyOptions, [{ value: m.picked ?? [] }]));
    return finish(session, "select", ref2, p);
  });
}
async function press(session, key, opts = {}) {
  const spec = parseKey(key);
  const page = session.page;
  await guardAction(page, { action: "press", key: keyName(spec), ...opts.confirm ? { confirm: true } : {} });
  const p = await perform(session, opts, (pg) => dispatchKeys(pg, spec));
  return finish(session, "press", void 0, p);
}
async function upload(session, ref2, files, opts = {}) {
  if (files.length === 0) throw new UsageError("upload needs at least one file");
  const { fs } = browserDeps(opts.deps);
  for (const f of files) {
    if (!isAbsolute4(f)) throw new UsageError(`upload takes absolute paths, not ${JSON.stringify(f)}`);
    let st;
    try {
      st = await fs.stat(f);
    } catch (e) {
      throw new UsageError(e.code === "ENOENT" ? `no such file: ${f}` : `cannot read ${f}: ${e.message}`);
    }
    if (!st.isFile()) throw new UsageError(`not a file: ${f}`);
  }
  const page = session.page;
  return withRef(session, ref2, async (node) => {
    const input = await callOn(page, node.objectId, PAGE_FUNCTIONS.fileInput);
    if (!input.ok) {
      throw new ActionError(
        `${ref2} is ${an(input.what)} ${input.what}, not an <input type="file">: look in the snapshot for the file input itself (often next to or inside this control)`
      );
    }
    if (files.length > 1 && !input.multiple) throw new ActionError(`${ref2} takes one file, not ${files.length}`);
    const p = await perform(session, opts, (pg) => pg.send("DOM.setFileInputFiles", { files, backendNodeId: node.backendNodeId }));
    return finish(session, "upload", ref2, { ...p, value: { files: files.length } });
  });
}
async function evalValue(page, expression) {
  const r = await page.send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new ActionError(`the page threw: ${exceptionText(r.exceptionDetails)}`);
  return r.result?.value;
}
async function scroll(session, target, opts = {}) {
  const how = SCROLLS[target];
  if (how) {
    const p = await perform(session, opts, (pg) => evalValue(pg, `(() => { ${how}; return ${POSITION}; })()`));
    return finish(session, "scroll", void 0, p);
  }
  if (!/^e\d+$/.test(target)) throw new UsageError(`scroll takes a ref (e12) or one of up, down, top, bottom \u2014 not ${JSON.stringify(target)}`);
  return withRef(session, target, async (node) => {
    const p = await perform(session, opts, async (pg) => {
      await pg.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
      return evalValue(pg, POSITION);
    });
    return finish(session, "scroll", target, p);
  });
}
async function screenshot(session, opts = {}) {
  if (opts.ref !== void 0 && opts.selector !== void 0) throw new UsageError("a screenshot is of the element a ref or a selector names, not both");
  if ((opts.ref !== void 0 || opts.selector !== void 0) && opts.full)
    throw new UsageError("a screenshot is of one element (a ref or a selector) or of the full page, not both");
  if (opts.ref !== void 0) checkRef(opts.ref);
  const format = opts.format ?? "png";
  if (format !== "png" && format !== "jpeg") throw new UsageError(`screenshot format is png or jpeg, not ${JSON.stringify(format)}`);
  if (opts.quality !== void 0 && !(Number.isInteger(opts.quality) && opts.quality >= 0 && opts.quality <= 100))
    throw new UsageError(`screenshot quality is a whole number from 0 to 100, not ${opts.quality}`);
  const page = session.page;
  const params = { format, ...format === "jpeg" && opts.quality !== void 0 ? { quality: opts.quality } : {} };
  if (opts.ref !== void 0 || opts.selector !== void 0) {
    const quads = opts.ref !== void 0 ? await withRef(session, opts.ref, (node) => visibleQuads(page, node)) : await visibleQuads(page, { ref: opts.selector, backendNodeId: await elementBySelector(page, opts.selector) });
    const xs = quads.flatMap((q) => q.filter((_, i) => i % 2 === 0));
    const ys = quads.flatMap((q) => q.filter((_, i) => i % 2 === 1));
    const m = await page.send("Page.getLayoutMetrics");
    const vp = m.cssLayoutViewport ?? m.layoutViewport ?? { pageX: 0, pageY: 0 };
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const right = Math.max(...xs);
    const bottom = Math.max(...ys);
    const w = "clientWidth" in vp ? vp.clientWidth : void 0;
    const h = "clientHeight" in vp ? vp.clientHeight : void 0;
    if (x < 0 || y < 0 || w !== void 0 && right > w || h !== void 0 && bottom > h) params.captureBeyondViewport = true;
    params.clip = { x: x + vp.pageX, y: y + vp.pageY, width: right - x, height: bottom - y, scale: 1 };
  } else if (opts.full) {
    const m = await page.send("Page.getLayoutMetrics");
    const size = m.cssContentSize ?? m.contentSize ?? { x: 0, y: 0, width: 0, height: 0 };
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
  }
  const { data } = await page.send("Page.captureScreenshot", params);
  return Buffer.from(data, "base64");
}
function remoteValue(r) {
  if (!r) return void 0;
  if (r.subtype === "node") return r.description;
  if ("value" in r) return r.value;
  if (r.unserializableValue !== void 0) return r.unserializableValue;
  if (r.type === "undefined") return void 0;
  return r.description;
}
async function evaluate2(session, expression, opts = {}) {
  const p = await perform(session, opts, async (pg) => {
    let r;
    try {
      r = await pg.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    } catch (e) {
      if (e instanceof CdpError && /reference chain|serializ|by value/i.test(e.message))
        throw new ActionError(`the result cannot be returned as JSON (${e.message}): return plain data, e.g. only the fields you need`);
      throw e;
    }
    if (r.exceptionDetails) throw new ActionError(`evaluation failed: ${exceptionText(r.exceptionDetails)}`);
    return remoteValue(r.result);
  });
  return finish(session, "evaluate", void 0, p);
}
async function handleDialog(session, accept, promptText, opts = {}) {
  try {
    await session.page.send("Page.handleJavaScriptDialog", { accept, ...promptText !== void 0 ? { promptText } : {} });
  } catch (e) {
    if (e instanceof CdpError && /no dialog/i.test(e.message)) throw new ActionError("no dialog is open");
    throw e;
  }
  const p = await perform(session, opts, async () => {
  });
  return finish(session, "dialog", void 0, p);
}
async function history(session, action, move, opts) {
  const before = await session.loaderId();
  const nav = await move(opts.timeoutMs !== void 0 ? { timeoutMs: opts.timeoutMs } : {});
  await settle(session, settleOpts(opts));
  return finish(session, action, void 0, { navigated: nav.loaderId !== before, ...nav.note ? { note: nav.note } : {} });
}
function back(session, opts = {}) {
  return history(session, "back", (o) => session.back(o), opts);
}
function forward(session, opts = {}) {
  return history(session, "forward", (o) => session.forward(o), opts);
}
function reload(session, opts = {}) {
  return history(session, "reload", (o) => session.reload(o), opts);
}
var ActionError, DESCRIBE, PAGE_FUNCTIONS, exceptionText, an, settleOpts, CutShortError, TARGET_INFO_TIMEOUT_MS, area, OVERLAY_CONTROLS_MAX, BUTTONS, squash2, alnum, POSITION, SCROLLS;
var init_actions = __esm({
  "src/browser/actions.ts"() {
    "use strict";
    init_cli_kit();
    init_cdp();
    init_challenge();
    init_deps();
    init_keys();
    init_overlay();
    init_risk();
    init_snapshot();
    init_state();
    init_wait();
    ActionError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "ActionError";
      }
    };
    DESCRIBE = DESCRIBE_SOURCE;
    PAGE_FUNCTIONS = {
      /**
       * Where `hit` (the node under the click point) is: true when it stands for the
       * target itself (its own text, its user-agent shadow tree: see OWNER_SOURCE), null
       * when it is inside the target (a button in a card, which the guard then looks
       * at), else a description of what covers the target.
       */
      hitTest: `function hitTest(hit) {
  ${DESCRIBE}
  const owner = ${OWNER_SOURCE};
  const el = hit ? owner(hit) : null;
  if (el === this) return true;
  for (let n = hit; n; n = n.parentNode || n.host) if (n === this) return null;
  if (!el) return "nothing";
  // A target inside a frame: the top document's hit test stops at the frame element.
  if (el.ownerDocument !== this.ownerDocument && /^i?frame$/i.test(el.tagName)) return null;
  return describe(el);
}`,
      /** What fill can do with the element: a field, a contenteditable, or nothing (with a hint at the right action). */
      fieldKind: `function fieldKind() {
  ${DESCRIBE}
  const tag = String(this.tagName || "").toLowerCase();
  if (tag === "textarea") return { kind: "field" };
  if (tag === "input") {
    const type = String(this.type || "text").toLowerCase();
    if (type === "file") return { kind: "other", what: describe(this), hint: "use upload" };
    if (["checkbox", "radio", "submit", "button", "reset", "image", "range", "color", "hidden"].includes(type)) return { kind: "other", what: describe(this), hint: "click it" };
    return { kind: "field", secret: type === "password" };
  }
  if (tag === "select") return { kind: "other", what: describe(this), hint: "use select" };
  if (this.isContentEditable) return { kind: "editable" };
  return { kind: "other", what: describe(this), hint: "" };
}`,
      /** Select the current content, so that inserted text replaces it. */
      selectAll: `function selectAll(kind) {
  if (kind === "editable") {
    const range = document.createRange();
    range.selectNodeContents(this);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else if (typeof this.select === "function") this.select();
}`,
      readValue: `function readValue(kind) {
  return kind === "editable" ? this.innerText : this.value;
}`,
      /**
       * The fallback for controlled inputs (React and the like keep their own copy of
       * the value and hear the prototype's setter, not an assignment on the element).
       */
      setValue: `function setValue(value, kind) {
  if (kind === "editable") {
    this.textContent = value;
    this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  } else {
    const proto = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(this, value);
    else this.value = value;
    this.dispatchEvent(new Event("input", { bubbles: true }));
  }
  this.dispatchEvent(new Event("change", { bubbles: true }));
}`,
      /** Option indexes for the values, by value, then by visible label (exact, then without case); or why not. */
      matchOptions: `function matchOptions(values) {
  ${DESCRIBE}
  if (String(this.tagName || "").toUpperCase() !== "SELECT") return { error: "not-select", what: describe(this) };
  const squash = (s) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim();
  const label = (o) => squash(o.label || o.text);
  const opts = Array.from(this.options);
  const picked = [];
  const missing = [];
  for (const v of values) {
    let i = opts.findIndex((o) => o.value === v);
    if (i < 0) i = opts.findIndex((o) => label(o) === squash(v));
    if (i < 0) i = opts.findIndex((o) => label(o).toLowerCase() === squash(v).toLowerCase());
    if (i < 0) missing.push(v);
    else if (!picked.includes(i)) picked.push(i);
  }
  if (missing.length > 0) return { error: "missing", missing, options: opts.slice(0, 20).map((o) => ({ value: o.value, label: label(o) })), total: opts.length };
  if (picked.length > 1 && !this.multiple) return { error: "single" };
  return { picked };
}`,
      applyOptions: `function applyOptions(picked) {
  const opts = Array.from(this.options);
  if (this.multiple) opts.forEach((o, i) => { o.selected = picked.includes(i); });
  else this.selectedIndex = picked[0];
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return picked.map((i) => opts[i].value);
}`,
      fileInput: `function fileInput() {
  ${DESCRIBE}
  const ok = String(this.tagName || "").toUpperCase() === "INPUT" && String(this.type || "").toLowerCase() === "file";
  return { ok, multiple: !!this.multiple, what: describe(this) };
}`
    };
    exceptionText = (d) => d.exception?.description?.split("\n")[0] ?? (d.exception?.value !== void 0 ? String(d.exception.value) : void 0) ?? d.text ?? "page error";
    an = (what) => /^<[aeiou]/i.test(what) ? "an" : "a";
    settleOpts = (opts) => ({
      ...opts.deps ? { deps: opts.deps } : {},
      ...opts.settleTimeoutMs !== void 0 ? { timeoutMs: opts.settleTimeoutMs } : {}
    });
    CutShortError = class extends Error {
    };
    TARGET_INFO_TIMEOUT_MS = 2e3;
    area = (q) => {
      let s = 0;
      for (let i = 0; i < 4; i++) s += q[i * 2] * q[(i + 1) % 4 * 2 + 1] - q[(i + 1) % 4 * 2] * q[i * 2 + 1];
      return Math.abs(s) / 2;
    };
    OVERLAY_CONTROLS_MAX = 12;
    BUTTONS = { left: 1, right: 2, middle: 4 };
    squash2 = (s) => s.replace(/\s+/g, " ").trim();
    alnum = (s) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    POSITION = "({ x: Math.round(scrollX), y: Math.round(scrollY) })";
    SCROLLS = {
      down: 'scrollBy({ top: Math.round(innerHeight * 0.8), behavior: "instant" })',
      up: 'scrollBy({ top: -Math.round(innerHeight * 0.8), behavior: "instant" })',
      top: 'scrollTo({ top: 0, behavior: "instant" })',
      bottom: 'scrollTo({ top: (document.scrollingElement || document.documentElement).scrollHeight, behavior: "instant" })'
    };
  }
});

// src/browser/network.ts
function track2(map, key, value) {
  map.delete(key);
  map.set(key, value);
  for (const old of map.keys()) {
    if (map.size <= TRACKED_CAP) break;
    map.delete(old);
  }
}
function stored(targetId, o) {
  return readNetwork(targetId, o).filter((e) => typeof e === "object" && e !== null && typeof e.n === "number");
}
function listNetwork(targetId, o) {
  return stored(targetId, o).map(({ n, method, status, url, mime, size }) => ({ n, method, status, url, mime, size }));
}
function getNetworkEntry(targetId, n, o) {
  return stored(targetId, o).find((e) => e.n === n) ?? null;
}
function clearNetworkLog(targetId, o) {
  clearNetwork(targetId, o);
}
var REQUEST_BODY_CAP, TRACKED_CAP, DEFAULT_RESOURCE_TYPES, JSON_MIME, NetworkRecorder;
var init_network = __esm({
  "src/browser/network.ts"() {
    "use strict";
    init_state();
    REQUEST_BODY_CAP = 4096;
    TRACKED_CAP = 1e3;
    DEFAULT_RESOURCE_TYPES = /* @__PURE__ */ new Set(["XHR", "Fetch", "Document", "Other"]);
    JSON_MIME = /^(application\/(.+\+)?json|text\/json|application\/x-ndjson)\s*(;|$)/i;
    NetworkRecorder = class {
      page;
      targetId;
      filter;
      maxEntries;
      maxBodyBytes;
      persist;
      drainMs;
      state;
      requests = /* @__PURE__ */ new Map();
      pending = /* @__PURE__ */ new Map();
      inflight = /* @__PURE__ */ new Set();
      log = [];
      /** Entries not yet appended to the log file: a restart or a flush never writes one twice. */
      unsaved = [];
      next = 1;
      active = false;
      handlers = [];
      constructor(session, opts = {}) {
        this.page = session.page;
        this.targetId = session.targetId;
        this.filter = opts.filter ?? {};
        this.maxEntries = opts.maxEntries ?? 200;
        this.maxBodyBytes = opts.maxBodyBytes ?? 256 * 1024;
        this.persist = opts.persist ?? true;
        this.drainMs = opts.drainMs ?? 2e3;
        this.state = { home: opts.home };
      }
      async start() {
        if (this.active) return;
        for (const e of readNetwork(this.targetId, this.state)) {
          const n = e.n;
          if (typeof n === "number" && n >= this.next) this.next = n + 1;
        }
        this.active = true;
        this.handlers = [
          ["Network.requestWillBeSent", (p) => this.onRequest(p)],
          ["Network.responseReceived", (p) => this.onResponse(p)],
          ["Network.loadingFinished", (p) => this.onFinished(p)],
          ["Network.loadingFailed", (p) => this.onFailed(p)]
        ];
        for (const [m, h] of this.handlers) this.page.on(m, h);
        await this.page.send("Network.enable");
      }
      /** The entries recorded so far, oldest first. */
      entries() {
        return [...this.log];
      }
      /**
       * Append to the log file what was recorded since the last flush (or stop),
       * and keep recording; returns those entries. For a recorder left running
       * across calls (the MCP server's). Under `withBrowserLock`, as stop().
       */
      flush() {
        const out = this.unsaved;
        this.unsaved = [];
        if (this.persist && out.length > 0) appendNetwork(this.targetId, out, this.state);
        return out;
      }
      /**
       * Waits (bounded) for in-flight body fetches, detaches, persists and returns the entries.
       * appendNetwork is a read-modify-write: run this under `withBrowserLock` (the CLI's `withPage` does).
       */
      async stop() {
        if (this.inflight.size > 0) {
          let timer;
          const bound = new Promise((r) => {
            timer = setTimeout(r, this.drainMs);
          });
          await Promise.race([Promise.allSettled([...this.inflight]), bound]);
          clearTimeout(timer);
        }
        this.active = false;
        for (const [m, h] of this.handlers) this.page.off(m, h);
        this.handlers = [];
        this.requests.clear();
        this.pending.clear();
        this.flush();
        return this.entries();
      }
      onRequest(p) {
        if (!this.active || typeof p?.requestId !== "string") return;
        track2(this.requests, p.requestId, {
          method: String(p.request?.method ?? "GET"),
          url: String(p.request?.url ?? ""),
          resourceType: p.type,
          postData: p.request?.postData
        });
      }
      onResponse(p) {
        if (!this.active || typeof p?.requestId !== "string") return;
        const req = this.requests.get(p.requestId);
        const r = p.response ?? {};
        const rec = {
          method: req?.method ?? "GET",
          url: String(r.url ?? req?.url ?? ""),
          status: Number(r.status ?? 0),
          mime: String(r.mimeType ?? ""),
          resourceType: String(p.type ?? req?.resourceType ?? "Other"),
          requestBody: typeof req?.postData === "string" ? req.postData.slice(0, REQUEST_BODY_CAP) : void 0
        };
        if (this.keep(rec)) track2(this.pending, p.requestId, rec);
      }
      onFailed(p) {
        this.requests.delete(p?.requestId);
        this.pending.delete(p?.requestId);
      }
      onFinished(p) {
        if (!this.active) return;
        const rec = this.pending.get(p?.requestId);
        this.requests.delete(p?.requestId);
        if (!rec) return;
        this.pending.delete(p.requestId);
        const job = this.finish(p.requestId, rec, Number(p.encodedDataLength ?? 0)).finally(() => this.inflight.delete(job));
        this.inflight.add(job);
      }
      keep(r) {
        const f = this.filter;
        const mime = f.mime ?? "json";
        if (f.urlIncludes && !r.url.includes(f.urlIncludes)) return false;
        if (f.methods && !f.methods.some((m) => m.toUpperCase() === r.method.toUpperCase())) return false;
        if (mime === "any") return true;
        if (mime === "json") return JSON_MIME.test(r.mime) && DEFAULT_RESOURCE_TYPES.has(r.resourceType);
        return r.mime.toLowerCase().includes(mime.toLowerCase());
      }
      async finish(requestId, r, wireSize) {
        const entry = {
          n: 0,
          at: (/* @__PURE__ */ new Date()).toISOString(),
          method: r.method,
          url: r.url,
          status: r.status,
          mime: r.mime,
          resourceType: r.resourceType,
          size: wireSize
        };
        if (r.requestBody !== void 0) entry.requestBody = r.requestBody;
        if (wireSize > this.maxBodyBytes) {
          entry.bodyTruncated = true;
        } else {
          try {
            const res = await this.page.send("Network.getResponseBody", { requestId });
            const text = res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body;
            entry.size = Buffer.byteLength(text);
            if (entry.size > this.maxBodyBytes) {
              entry.bodyTruncated = true;
            } else {
              try {
                entry.json = JSON.parse(text);
              } catch {
                entry.text = text;
              }
            }
          } catch (e) {
            entry.error = e instanceof Error ? e.message : String(e);
          }
        }
        if (!this.active) return;
        entry.n = this.next++;
        this.log.push(entry);
        if (this.log.length > this.maxEntries) this.log.splice(0, this.log.length - this.maxEntries);
        if (this.persist) {
          this.unsaved.push(entry);
          if (this.unsaved.length > this.maxEntries) this.unsaved.splice(0, this.unsaved.length - this.maxEntries);
        }
      }
    };
  }
});

// src/browser/text.ts
async function elementObject(session, opts) {
  if (opts.ref !== void 0) return (await resolveRef(session, opts.ref)).objectId;
  const selector = opts.selector;
  const backendNodeId = await elementBySelector(session.page, selector);
  try {
    const { object } = await session.page.send("DOM.resolveNode", { backendNodeId });
    if (object.objectId) return object.objectId;
  } catch (e) {
    if (!(e instanceof CdpError)) throw e;
  }
  throw new NoMatchError(selector);
}
async function readElement(session, opts, url) {
  const objectId = await elementObject(session, opts);
  try {
    const r = await session.page.send("Runtime.callFunctionOn", { objectId, functionDeclaration: ELEMENT_TEXT, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`the page threw: ${r.exceptionDetails.text ?? "page error"}`);
    const got = r.result?.value ?? {};
    if (opts.markdown && typeof got.html === "string") return extractFromHtml(got.html, url, { format: "markdown", fullPage: true }).text;
    return typeof got.text === "string" ? got.text : "";
  } finally {
    session.page.send("Runtime.releaseObject", { objectId }).catch(() => {
    });
  }
}
async function readDocument(session, opts) {
  const got = await session.page.send("Runtime.evaluate", { expression: READ_DOCUMENT, returnByValue: true });
  const value = got.result?.value ?? {};
  const url = typeof value.url === "string" ? value.url : await session.currentUrl();
  const html = typeof value.html === "string" ? value.html : "";
  const r = extractFromHtml(html, url, { format: opts.markdown ? "markdown" : "text", stripConsent: true });
  return { text: r.text, url };
}
async function readPageText(session, opts = {}) {
  const element2 = opts.ref !== void 0 || opts.selector !== void 0;
  let url = await session.currentUrl();
  let text;
  if (element2) text = await readElement(session, opts, url);
  else ({ text, url } = await readDocument(session, opts));
  text = text.trim();
  const title = await session.title();
  const max = opts.maxChars;
  const truncated = max !== void 0 && text.length > max;
  return {
    url,
    title,
    ...opts.ref !== void 0 ? { ref: opts.ref } : {},
    ...opts.selector !== void 0 ? { selector: opts.selector } : {},
    text: truncated ? text.slice(0, max).trimEnd() : text,
    chars: text.length,
    truncated
  };
}
var ELEMENT_TEXT;
var init_text2 = __esm({
  "src/browser/text.ts"() {
    "use strict";
    init_fetch();
    init_actions();
    init_cdp();
    init_overlay();
    init_snapshot();
    ELEMENT_TEXT = `function elementText() {
  const text = typeof this.innerText === "string" ? this.innerText : this.textContent || "";
  return { text, html: typeof this.outerHTML === "string" ? this.outerHTML : "" };
}`;
  }
});

// src/browser/cli.ts
var cli_exports = {};
__export(cli_exports, {
  BROWSER_ACTIONS: () => BROWSER_ACTIONS,
  dialogLine: () => dialogLine,
  runBrowserCommand: () => runBrowserCommand,
  statusText: () => statusText,
  tabLines: () => tabLines
});
import { existsSync as existsSync13, mkdirSync as mkdirSync7, statSync as statSync11 } from "fs";
import { tmpdir as tmpdir6 } from "os";
import { dirname as dirname5, join as join26, resolve as resolve9 } from "path";
function arity(ctx, min, max = min) {
  if (ctx.args.length < min || ctx.args.length > max) throw usageError(ctx.action);
}
async function runBrowserCommand(action, args, flags = {}, deps = {}) {
  const ctx = { action, args, flags, deps };
  try {
    if (!Object.hasOwn(HANDLERS, action)) throw new UsageError(`usage: ${cliName()} browser ${BROWSER_ACTIONS.join("|")}`);
    if (flags.selector !== void 0 && !SELECTOR_ACTIONS.has(action) && !(flags.snapshot && SNAPSHOT_ACTIONS.has(action)))
      throw new UsageError("--selector goes with snapshot, screenshot, wait and text, or scopes the --snapshot an action prints");
    const { challenged, ...out } = await HANDLERS[action](ctx);
    const dialogs = unreported(ctx);
    return {
      ...out,
      text: withLines(
        out.text,
        dialogs.map((d) => dialogLine(d))
      ),
      json: { ok: true, ...out.json, ...dialogsJson(dialogs) },
      // Done, and the page needs a human: a script tells it from a plain success without reading the text.
      exitCode: challenged && (NAVIGATING.has(action) || action === "type" && flags.submit) ? EXIT_HUMAN : 0
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const dialogs = unreported(ctx);
    return {
      json: { ok: false, error, ...dialogsJson(dialogs) },
      text: withLines(
        error,
        dialogs.map((d) => dialogLine(d))
      ),
      exitCode: e instanceof UsageError ? 2 : 1
    };
  }
}
function withLines(text, lines) {
  if (lines.length === 0) return text;
  const cut = text.indexOf("\n");
  return cut < 0 ? [text, ...lines].join("\n") : [text.slice(0, cut), ...lines, text.slice(cut + 1)].join("\n");
}
function dismissDialogs(s) {
  const handled2 = [];
  const pending = [];
  let failure2;
  const stop = s.onDialog((d, page) => {
    const info = { type: d.type, message: d.message };
    pending.push(
      page.send("Page.handleJavaScriptDialog", { accept: false }).then(
        () => void handled2.push({ ...info, dismissed: true }),
        (e) => {
          if (e instanceof CdpError && /no dialog/i.test(e.message)) handled2.push({ ...info, closed: true });
          else failure2 ??= new Error(`could not dismiss the dialog the page opened (${info.type}: ${JSON.stringify(info.message)}): ${e.message}`);
        }
      )
    );
  });
  return {
    handled: handled2,
    reported: /* @__PURE__ */ new Set(),
    stop,
    async settle() {
      await Promise.all(pending);
      if (failure2) throw failure2;
    }
  };
}
async function handled(ctx, r) {
  const w = ctx.dialogs;
  if (!r.dialog || !w) return r;
  await w.settle();
  const d = w.handled.find((h) => !w.reported.has(h) && h.type === r.dialog?.type && h.message === r.dialog?.message);
  if (!d) return r;
  w.reported.add(d);
  return { ...r, dialog: d };
}
function onPage(ctx, fn, extra = {}) {
  if (ctx.deps.page) return ctx.deps.page(fn, extra);
  const { cdp, profile, headless, browserKind } = ctx.flags;
  const kind = browserKind?.trim().toLowerCase();
  if (kind !== void 0 && !isBrowserKind(kind))
    throw new UsageError(`--browser-kind is one of ${BROWSER_KINDS.join(", ")}, not ${JSON.stringify(browserKind)}`);
  const opts = {
    ...cdp !== void 0 ? { cdp } : {},
    ...profile !== void 0 ? { profile } : {},
    ...headless ? { headless } : {},
    ...kind !== void 0 ? { kind } : {},
    ...ctx.deps.browser ? { deps: ctx.deps.browser } : {},
    ...extra
  };
  return withPage(opts, async (s) => {
    const w = ctx.dialogs = dismissDialogs(s);
    try {
      const out = await fn(s);
      await w.settle();
      return out;
    } catch (e) {
      await w.settle().catch(() => {
      });
      throw e;
    } finally {
      w.stop();
    }
  });
}
async function afterSnapshot(ctx, s) {
  if (!ctx.flags.snapshot) return {};
  const { selector } = ctx.flags;
  if (selector === void 0) return { snap: await takeSnapshot(s, snapOpts(ctx)) };
  try {
    return { snap: await takeSnapshot(s, { ...snapOpts(ctx), selector }) };
  } catch (e) {
    if (e instanceof CdpError) throw e;
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
async function capturing(ctx, s, fn) {
  if (!ctx.flags.capture) return { value: await fn() };
  const rec = new NetworkRecorder(s);
  await rec.start();
  let stopped = false;
  try {
    const value = await fn();
    stopped = true;
    const captured = (await rec.stop()).length;
    return { value, capture: { captured, ...isNoWrite() ? {} : { logged: listNetwork(s.targetId).length } } };
  } finally {
    if (!stopped) await rec.stop().catch(() => {
    });
  }
}
function valueText(v) {
  if (typeof v !== "string") return show(v);
  return JSON.stringify(v.length > VALUE_SHOWN ? `${v.slice(0, VALUE_SHOWN - 1)}\u2026` : v);
}
function actionText(ctx, r, capture, after2) {
  const lines = [`${r.action}${r.ref !== void 0 ? ` ${r.ref}` : ""}: ${r.navigated ? "navigated to " : ""}${where(r.url, r.title)}`];
  if (r.valueHidden) lines.push("  value: (hidden)");
  else if (r.value !== void 0 && !(typeof r.value === "object" && r.value !== null && Object.keys(r.value).length === 0))
    lines.push(`  value: ${valueText(r.value)}`);
  if (r.note) lines.push(`note: ${r.note}`);
  if (r.dialog) lines.push(dialogLine(r.dialog, follow(ctx)));
  if (r.challenge) lines.push(challengeLine(ctx, r.challenge));
  if (capture) lines.push(capturedLine(ctx, capture));
  lines.push(...afterLines(after2));
  return lines.join("\n");
}
function mutate(ctx, run) {
  return onPage(ctx, async (s) => {
    const { value: r, capture } = await capturing(ctx, s, async () => handled(ctx, await run(s, actOpts(ctx))));
    const after2 = frozen(r.dialog) ? {} : await afterSnapshot(ctx, s);
    return {
      json: { ...r, ...capturedJson(capture), ...afterJson(after2) },
      text: actionText(ctx, r, capture, after2),
      ...r.challenge?.blocking ? { challenged: true } : {}
    };
  });
}
function refArg(ctx) {
  const ref2 = ctx.args[0];
  checkRef(ref2);
  return ref2;
}
function refAndText(ctx) {
  if (ctx.args.length < 2) throw usageError(ctx.action);
  return [refArg(ctx), ctx.args.slice(1).join(" ")];
}
function tabLines(tabs) {
  return tabs.map((t) => `${t.active ? "*" : " "} ${t.id}  ${where(t.url, t.title)}`).join("\n");
}
function statusText(st) {
  if (!st.alive) return st.port === void 0 ? "no browser session" : `no browser answers on port ${st.port} any more`;
  const owner = st.launchedByUs ? `launched by ${brand().name}` : "attached, not ours: close only forgets it";
  const head = `browser on port ${st.port} (${owner}), profile ${st.profile}${st.headless ? ", headless" : ""}`;
  return [head, tabLines(st.tabs ?? [])].filter(Boolean).join("\n");
}
async function assertProfileIdle(ctx, name2) {
  const deps = browserDeps(ctx.deps.browser);
  const own = await readActivePort(deps, join26(profileDir(name2), "DevToolsActivePort"));
  if (own && await isSameBrowser(deps, own.port, "127.0.0.1", own.path)) {
    throw new Error(`a browser is running on the profile ${name2 ?? "default"}: close it first: \`${cliName()} browser close\``);
  }
}
function currentTarget(ctx) {
  const saved = readSession();
  if (!saved) throw new Error(`no browser session: record what a page fetches with ${follow(ctx).capture}`);
  return saved.targetId;
}
var cliFollowUps, USAGE, BROWSER_ACTIONS, SNAPSHOT_MAX_CHARS, TEXT_MAX_CHARS, SELECTOR_ACTIONS, SNAPSHOT_ACTIONS, NAVIGATING, cliName, usageError, dialogsJson, unreported, actOpts, snapOpts, afterJson, afterLines, show, pretty, where, follow, dialogLine, frozen, challengeLine, capturedLine, capturedJson, VALUE_SHOWN, confirm, timeoutOpts, HANDLERS;
var init_cli = __esm({
  "src/browser/cli.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    init_no_write();
    init_actions();
    init_challenge();
    init_cdp();
    init_deps();
    init_detect();
    init_keys();
    init_launch();
    init_network();
    init_profile();
    init_session();
    init_snapshot();
    init_state();
    init_text2();
    init_wait();
    cliFollowUps = () => ({
      dialog: `\`${cliName()} browser dialog accept|dismiss\``,
      waitClear: `\`${cliName()} browser wait --clear\``,
      networkList: `\`${cliName()} browser network list\``,
      capture: `\`${cliName()} browser open <url> --capture\`, or --capture on an action`,
      textMore: "raise --max-chars, or read one element (a ref or --selector)"
    });
    USAGE = {
      open: "open <url> [--new-tab] [--headless] [--profile <n>] [--browser-kind chrome|brave|chromium|edge] [--capture] [--snapshot] [--timeout <ms>]",
      attach: "attach <port|url>",
      status: "status",
      close: "close [--all]",
      snapshot: "snapshot [<ref> | --selector <css>] [--interactive] [--max-chars <n>]",
      text: "text [<ref> | --selector <css>] [--markdown] [--max-chars <n>]",
      click: "click <ref> [--confirm]",
      hover: "hover <ref>",
      type: "type <ref> <text> [--submit] [--confirm]",
      fill: "fill <ref> <text>",
      select: "select <ref> <value\u2026>",
      press: "press <key> [--confirm]",
      upload: "upload <ref> <file\u2026>",
      scroll: "scroll <ref|up|down|top|bottom>",
      wait: "wait --text <s> | --gone <s> | --selector <css> | --url <pattern> | --idle | --load | --clear | --ms <n> [--timeout <ms>]",
      eval: "eval <expr|->",
      screenshot: "screenshot [<ref> | --selector <css>] [--full] [--out <file>]",
      network: "network [list|get <n>|clear]",
      tabs: "tabs [list|new [<url>]|select <tN>|close <tN>]",
      back: "back [--timeout <ms>]",
      forward: "forward [--timeout <ms>]",
      reload: "reload [--timeout <ms>]",
      dialog: "dialog accept [<prompt text>] | dismiss",
      profile: "profile import <chrome|brave|chromium|edge|path> [--force] | reset | path"
    };
    BROWSER_ACTIONS = Object.keys(USAGE);
    SNAPSHOT_MAX_CHARS = 2e4;
    TEXT_MAX_CHARS = 2e4;
    SELECTOR_ACTIONS = /* @__PURE__ */ new Set(["snapshot", "screenshot", "wait", "text"]);
    SNAPSHOT_ACTIONS = /* @__PURE__ */ new Set(["open", "click", "hover", "type", "fill", "select", "press", "upload", "scroll", "back", "forward", "reload", "dialog"]);
    NAVIGATING = /* @__PURE__ */ new Set(["open", "click", "press", "back", "forward", "reload"]);
    cliName = () => brand().cli;
    usageError = (action) => new UsageError(`usage: ${cliName()} browser ${USAGE[action]}`);
    dialogsJson = (dialogs) => dialogs.length ? { dialogs } : {};
    unreported = (ctx) => ctx.dialogs ? ctx.dialogs.handled.filter((d) => !ctx.dialogs?.reported.has(d)) : [];
    actOpts = (ctx) => ctx.deps.browser ? { deps: ctx.deps.browser } : {};
    snapOpts = (ctx, ref2) => ({
      maxChars: ctx.flags.maxChars ?? SNAPSHOT_MAX_CHARS,
      ...ctx.flags.interactive ? { interactive: true } : {},
      ...ref2 !== void 0 ? { ref: ref2 } : {}
    });
    afterJson = (a) => a.snap ? { snapshot: a.snap } : a.error !== void 0 ? { snapshotError: a.error } : {};
    afterLines = (a) => a.snap ? ["", a.snap.text] : a.error !== void 0 ? ["", `snapshot: ${a.error}`] : [];
    show = (v) => typeof v === "string" ? v : v === void 0 ? "undefined" : JSON.stringify(v);
    pretty = (v) => typeof v === "string" ? v : v === void 0 ? "undefined" : JSON.stringify(v, null, 2);
    where = (url, title) => `${url}${title ? ` \u2014 ${title}` : ""}`;
    follow = (ctx) => ctx.deps.followUps ?? cliFollowUps();
    dialogLine = (d, f = cliFollowUps()) => {
      const head = `dialog ${d.type}: ${JSON.stringify(d.message)}`;
      if (d.dismissed) return `${head} \u2014 dismissed: a dialog cannot outlive a command; \`${cliName()} mcp --browser\` keeps it open for an answer`;
      if (d.closed) return `${head} \u2014 closed in the window before the command could dismiss it`;
      return `${head} \u2014 it is still open: ${f.dialog}`;
    };
    frozen = (d) => d !== void 0 && !d.dismissed && !d.closed;
    challengeLine = (ctx, c) => `challenge: ${c.kind}${c.blocking ? " (blocking)" : ""} \u2014 let the human solve it, then ${follow(ctx).waitClear}`;
    capturedLine = (ctx, c) => `captured ${c.captured} JSON response${c.captured === 1 ? "" : "s"}${c.logged !== void 0 ? ` (${c.logged} in the log)` : ""} \u2014 ${follow(ctx).networkList}`;
    capturedJson = (c) => c ? { captured: c.captured, ...c.logged !== void 0 ? { logged: c.logged } : {} } : {};
    VALUE_SHOWN = 200;
    confirm = (ctx) => ctx.flags.confirm ? { confirm: true } : {};
    timeoutOpts = (ctx) => ctx.flags.timeout !== void 0 ? { timeoutMs: ctx.flags.timeout } : {};
    HANDLERS = {
      async open(ctx) {
        arity(ctx, 1);
        const url = ctx.args[0];
        return onPage(
          ctx,
          async (s) => {
            const { value: nav, capture } = await capturing(ctx, s, async () => {
              const nav2 = await s.navigate(url, timeoutOpts(ctx));
              await settle(s, actOpts(ctx));
              return nav2;
            });
            const title = await s.title();
            const challenge = await detectChallenge(s);
            const after2 = await afterSnapshot(ctx, s);
            const notes = s.takeNotes();
            const lines = [`${where(nav.url, title)}${nav.status !== void 0 ? ` (HTTP ${nav.status})` : ""}`];
            for (const n of notes) lines.push(`note: ${n}`);
            if (nav.note) lines.push(`note: ${nav.note}`);
            if (challenge) lines.push(challengeLine(ctx, challenge));
            if (capture) lines.push(capturedLine(ctx, capture));
            lines.push(...afterLines(after2));
            return {
              json: {
                ok: true,
                url: nav.url,
                title,
                ...nav.status !== void 0 ? { status: nav.status } : {},
                ...nav.note ? { note: nav.note } : {},
                ...notes.length ? { notes } : {},
                tab: s.targetId,
                challenge,
                ...capturedJson(capture),
                ...afterJson(after2)
              },
              text: lines.join("\n"),
              ...challenge?.blocking ? { challenged: true } : {}
            };
          },
          ctx.flags.newTab ? { newTab: true } : {}
        );
      },
      async attach(ctx) {
        arity(ctx, 1);
        const st = await withPage({ cdp: ctx.args[0], ...ctx.deps.browser ? { deps: ctx.deps.browser } : {} }, (s) => s.status());
        return { json: st, text: statusText(st) };
      },
      async status(ctx) {
        arity(ctx, 0);
        const st = await browserStatus(ctx.deps.browser ? { deps: ctx.deps.browser } : {});
        return { json: st, text: statusText(st) };
      },
      async close(ctx) {
        arity(ctx, 0);
        const had = readSession();
        const r = await closeBrowser({
          ...ctx.flags.all ? { all: true } : {},
          ...ctx.flags.profile !== void 0 ? { profile: ctx.flags.profile } : {},
          ...ctx.deps.browser ? { deps: ctx.deps.browser } : {}
        });
        const text = r.closed ? "closed the browser" : had && !had.launchedByUs ? `forgot the browser on port ${had.port}; it is not ours, so it was left running` : "no browser to close";
        return { json: r, text };
      },
      async snapshot(ctx) {
        arity(ctx, 0, 1);
        const { selector } = ctx.flags;
        if (ctx.args[0] !== void 0 && selector !== void 0) throw new UsageError("a snapshot is scoped to a ref or to a selector, not both");
        if (ctx.args[0] !== void 0) refArg(ctx);
        const r = await onPage(ctx, (s) => takeSnapshot(s, { ...snapOpts(ctx, ctx.args[0]), ...selector !== void 0 ? { selector } : {} }));
        return { json: r, text: r.text };
      },
      async text(ctx) {
        arity(ctx, 0, 1);
        const ref2 = ctx.args[0];
        const { selector } = ctx.flags;
        if (ref2 !== void 0 && selector !== void 0) throw new UsageError("text reads the element a ref or a selector names, not both");
        if (ref2 !== void 0) refArg(ctx);
        const max = ctx.flags.maxChars ?? TEXT_MAX_CHARS;
        const r = await onPage(
          ctx,
          (s) => readPageText(s, {
            ...ref2 !== void 0 ? { ref: ref2 } : {},
            ...selector !== void 0 ? { selector } : {},
            ...ctx.flags.markdown ? { markdown: true } : {},
            maxChars: max
          })
        );
        const element2 = ref2 !== void 0 || selector !== void 0;
        const body = r.text ? r.text : element2 ? "(no text in this element)" : "(no readable text on this page: take a snapshot, or read one element with a ref or a selector)";
        const lines = [`url: ${r.url}`, `title: ${r.title}`, "", body];
        if (r.truncated) lines.push(`\u2026 [truncated at ${max} of ${r.chars} characters: ${follow(ctx).textMore}]`);
        return { json: r, text: lines.join("\n") };
      },
      async click(ctx) {
        arity(ctx, 1);
        const ref2 = refArg(ctx);
        return mutate(ctx, (s, o) => click(s, ref2, { ...o, ...confirm(ctx) }));
      },
      async hover(ctx) {
        arity(ctx, 1);
        const ref2 = refArg(ctx);
        return mutate(ctx, (s, o) => hover(s, ref2, o));
      },
      async type(ctx) {
        const [ref2, text] = refAndText(ctx);
        return mutate(ctx, (s, o) => typeText(s, ref2, text, { ...o, ...confirm(ctx), ...ctx.flags.submit ? { submit: true } : {} }));
      },
      async fill(ctx) {
        const [ref2, text] = refAndText(ctx);
        return mutate(ctx, (s, o) => fill(s, ref2, text, o));
      },
      async select(ctx) {
        arity(ctx, 2, Number.POSITIVE_INFINITY);
        const ref2 = refArg(ctx);
        return mutate(ctx, (s, o) => select(s, ref2, ctx.args.slice(1), o));
      },
      async press(ctx) {
        arity(ctx, 1);
        parseKey(ctx.args[0]);
        return mutate(ctx, (s, o) => press(s, ctx.args[0], { ...o, ...confirm(ctx) }));
      },
      async upload(ctx) {
        arity(ctx, 2, Number.POSITIVE_INFINITY);
        const ref2 = refArg(ctx);
        const cwd = ctx.deps.cwd ?? process.cwd();
        const files = ctx.args.slice(1).map((f) => {
          const path = resolve9(cwd, f);
          if (!existsSync13(path) || !statSync11(path).isFile()) throw new UsageError(`no such file: ${path}`);
          return path;
        });
        return mutate(ctx, (s, o) => upload(s, ref2, files, o));
      },
      async scroll(ctx) {
        arity(ctx, 1);
        if (!/^(up|down|top|bottom|e\d+)$/.test(ctx.args[0])) throw usageError(ctx.action);
        return mutate(ctx, (s, o) => scroll(s, ctx.args[0], o));
      },
      async back(ctx) {
        arity(ctx, 0);
        return mutate(ctx, (s, o) => back(s, { ...o, ...timeoutOpts(ctx) }));
      },
      async forward(ctx) {
        arity(ctx, 0);
        return mutate(ctx, (s, o) => forward(s, { ...o, ...timeoutOpts(ctx) }));
      },
      async reload(ctx) {
        arity(ctx, 0);
        return mutate(ctx, (s, o) => reload(s, { ...o, ...timeoutOpts(ctx) }));
      },
      async dialog(ctx) {
        const answer = ctx.args[0];
        if (answer !== "accept" && answer !== "dismiss") throw usageError(ctx.action);
        if (answer === "dismiss") arity(ctx, 1);
        if (!ctx.deps.page) {
          throw new Error(
            `the CLI dismisses dialogs before each command ends; a dialog the page opened between commands can only be answered in the window or with \`${cliName()} browser close\`; \`${cliName()} mcp --browser\` answers dialogs`
          );
        }
        const prompt = ctx.args.length > 1 ? ctx.args.slice(1).join(" ") : void 0;
        return mutate(ctx, (s, o) => handleDialog(s, answer === "accept", prompt, o));
      },
      async wait(ctx) {
        arity(ctx, 0);
        const f = ctx.flags;
        const conds = [];
        if (f.text !== void 0) conds.push({ text: f.text });
        if (f.gone !== void 0) conds.push({ gone: f.gone });
        if (f.selector !== void 0) conds.push({ selector: f.selector });
        if (f.url !== void 0) conds.push({ url: f.url });
        if (f.idle) conds.push({ idle: true });
        if (f.load) conds.push({ load: true });
        if (f.clear) conds.push({ clear: true });
        if (f.ms !== void 0) conds.push({ ms: f.ms });
        if (conds.length !== 1) throw new UsageError(`wait takes exactly one condition \u2014 usage: ${cliName()} browser ${USAGE.wait}`);
        const cond = conds[0];
        const r = await onPage(
          ctx,
          (s) => waitFor(s, cond, {
            ...f.timeout !== void 0 ? { timeoutMs: f.timeout } : {},
            ...ctx.deps.browser ? { deps: ctx.deps.browser } : {},
            ...ctx.deps.signal ? { signal: ctx.deps.signal } : {}
          })
        );
        return { json: { ok: true, ...r }, text: `${r.matched} held after ${r.waitedMs} ms` };
      },
      async eval(ctx) {
        if (ctx.args.length === 0) throw usageError(ctx.action);
        let expression = ctx.args.join(" ");
        if (expression === "-") {
          if (!ctx.deps.stdin) throw usageError(ctx.action);
          expression = ctx.deps.stdin();
        }
        expression = expression.trim();
        if (!expression) throw usageError(ctx.action);
        const r = await onPage(ctx, async (s) => handled(ctx, await evaluate2(s, expression, actOpts(ctx))));
        const lines = [pretty(r.value)];
        if (r.dialog) lines.push(dialogLine(r.dialog, follow(ctx)));
        return { json: r, text: lines.join("\n") };
      },
      async screenshot(ctx) {
        arity(ctx, 0, 1);
        if (isNoWrite()) throw new Error(`nothing may be written (${envName("NO_WRITE")}), and a screenshot is a file`);
        const stamp = new Date(browserDeps(ctx.deps.browser).now()).toISOString().replace(/[:.]/g, "-");
        const shots = join26(tmpdir6(), brand().name, "browser");
        const path = ctx.flags.out !== void 0 ? resolve9(ctx.deps.cwd ?? process.cwd(), ctx.flags.out) : join26(shots, `shot-${stamp}.png`);
        const format = /\.jpe?g$/i.test(path) ? "jpeg" : "png";
        const ref2 = ctx.args[0];
        const { selector, full } = ctx.flags;
        if (ref2 !== void 0 && selector !== void 0) throw new UsageError("a screenshot is of the element a ref or a selector names, not both");
        if ((ref2 !== void 0 || selector !== void 0) && full)
          throw new UsageError("a screenshot is of one element (a ref or a selector) or of the full page, not both");
        if (ref2 !== void 0) refArg(ctx);
        const bytes = await onPage(
          ctx,
          (s) => screenshot(s, {
            format,
            ...ref2 !== void 0 ? { ref: ref2 } : {},
            ...selector !== void 0 ? { selector } : {},
            ...full ? { full: true } : {}
          })
        );
        if (ctx.flags.out === void 0) ensurePrivateDir(shots);
        else mkdirSync7(dirname5(path), { recursive: true });
        writeFileAtomic(path, bytes, 384);
        return { json: { ok: true, path, bytes: bytes.length, format }, text: path, image: { path } };
      },
      async network(ctx) {
        const sub = ctx.args[0] ?? "list";
        if (sub === "list") {
          arity(ctx, 0, 1);
          const entries = listNetwork(currentTarget(ctx));
          const text = entries.length ? entries.map((e) => `${e.n}  ${e.method} ${e.status} ${e.url} (${e.mime}, ${e.size} B)`).join("\n") : `nothing recorded for this tab \u2014 record it with ${follow(ctx).capture}`;
          return { json: { entries }, text };
        }
        if (sub === "get") {
          arity(ctx, 2);
          const n = Number(ctx.args[1]);
          if (!Number.isInteger(n) || n < 1) throw usageError(ctx.action);
          const e = getNetworkEntry(currentTarget(ctx), n);
          if (!e) throw new Error(`no network entry ${n} in this tab's log \u2014 ${follow(ctx).networkList}`);
          const text = e.json !== void 0 ? pretty(e.json) : e.text !== void 0 ? e.text : `${e.method} ${e.status} ${e.url}: body not kept (${e.bodyTruncated ? `${e.size} B, over the size cap` : e.error ?? "none"})`;
          return { json: e, text };
        }
        if (sub === "clear") {
          arity(ctx, 1);
          clearNetworkLog(currentTarget(ctx));
          return { json: { ok: true }, text: "cleared this tab's network log" };
        }
        throw usageError(ctx.action);
      },
      async tabs(ctx) {
        const sub = ctx.args[0] ?? "list";
        if (sub === "list") {
          arity(ctx, 0, 1);
          const tabs = await onPage(ctx, (s) => s.listTabs());
          return { json: { tabs }, text: tabLines(tabs) };
        }
        if (sub === "new") {
          arity(ctx, 1, 2);
          const tab = await onPage(ctx, (s) => s.newTab(ctx.args[1]));
          return { json: tab, text: tabLines([tab]) };
        }
        if (sub === "select") {
          arity(ctx, 2);
          const tab = await onPage(ctx, (s) => s.selectTab(ctx.args[1]));
          return { json: tab, text: tabLines([tab]) };
        }
        if (sub === "close") {
          arity(ctx, 2);
          const id = ctx.args[1];
          const tabs = await onPage(ctx, async (s) => {
            await s.closeTab(id);
            return s.listTabs();
          });
          return { json: { closed: id, tabs }, text: tabLines(tabs) };
        }
        throw usageError(ctx.action);
      },
      async profile(ctx) {
        const sub = ctx.args[0];
        const name2 = ctx.flags.profile;
        if (sub === "path") {
          arity(ctx, 1);
          const path = profileDir(name2);
          return { json: { path }, text: path };
        }
        if (sub === "import") {
          arity(ctx, 2);
          await assertProfileIdle(ctx, name2);
          const r = importProfile(ctx.args[1], { ...name2 !== void 0 ? { name: name2 } : {}, ...ctx.flags.force ? { force: true } : {} });
          return { json: r, text: `imported ${r.files} files (${r.bytes} B) from ${r.from} into ${r.to}` };
        }
        if (sub === "reset") {
          arity(ctx, 1);
          await assertProfileIdle(ctx, name2);
          const path = profileDir(name2);
          const existed = existsSync13(path);
          resetProfile(name2);
          return { json: { ok: true, path, removed: existed }, text: existed ? `removed ${path}: the next launch starts logged out` : `no profile at ${path}` };
        }
        throw usageError(ctx.action);
      }
    };
  }
});

// src/skillkit/recall.ts
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
function preserves(before, after2, policy, key = "") {
  if (Array.isArray(before)) {
    if (!Array.isArray(after2)) return false;
    const candidates2 = before.map((old) => after2.flatMap((next, i) => preserves(old, next, policy, key) ? [i] : []));
    const owner = /* @__PURE__ */ new Map();
    const assign = (row, seen) => {
      for (const candidate of candidates2[row] ?? []) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const previous = owner.get(candidate);
        if (previous === void 0 || assign(previous, seen)) {
          owner.set(candidate, row);
          return true;
        }
      }
      return false;
    };
    return candidates2.every((_, row) => assign(row, /* @__PURE__ */ new Set()));
  }
  if (before !== null && typeof before === "object") {
    if (after2 === null || typeof after2 !== "object" || Array.isArray(after2)) return false;
    return Object.entries(before).every(([k, value]) => policy.ignoreKeys?.includes(k) || preserves(value, after2[k], policy, k));
  }
  if (typeof before === "number" && typeof after2 === "number") {
    if (policy.growing?.includes(key)) return after2 >= before;
    if (policy.shrinking?.includes(key)) return after2 <= before;
  }
  return Object.is(before, after2);
}
function recallPolicy(root) {
  const config = JSON.parse(readFileSync(join(root, "skill.json"), "utf8"));
  return config.repin?.recall;
}
function checkArtifactRecall(root, ref2 = "HEAD") {
  const policy = recallPolicy(root);
  if (!policy) return [];
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const files = git(["ls-tree", "-r", "--name-only", ref2, "--", ...policy.paths]).trim().split("\n").filter(Boolean);
  if (!files.length) throw new Error("No baseline artifacts matched the declared recall paths");
  const lost = [];
  for (const file of files) {
    const before = git(["show", `${ref2}:${file}`]);
    let after2;
    try {
      after2 = readFileSync(join(root, file), "utf8");
    } catch {
      lost.push(`${file}: deleted`);
      continue;
    }
    if (before === after2) continue;
    if (file.endsWith(".json")) {
      try {
        if (preserves(JSON.parse(before), JSON.parse(after2), policy)) continue;
      } catch {
      }
    }
    lost.push(`${file}: baseline content changed or disappeared; review the semantic difference`);
  }
  return lost;
}

// src/skillkit/finish.ts
import { execFileSync as execFileSync2 } from "child_process";
import { readFileSync as readFileSync2 } from "fs";
import { join as join2 } from "path";
async function finishRepin(root) {
  const config = JSON.parse(readFileSync2(join2(root, "skill.json"), "utf8"));
  const workflows = config.repin?.workflows ?? ["ci.yml", "release.yml"];
  const git = (args) => execFileSync2("git", args, { cwd: root, encoding: "utf8" }).trim();
  const repo = githubRepoForRemote(git(["remote", "get-url", "origin"]));
  const env2 = { ...process.env, GH_REPO: repo };
  const gh = (args) => execFileSync2("gh", args, { cwd: root, env: env2, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const sha = git(["rev-parse", "HEAD"]);
  for (const workflow of workflows) {
    const runs = () => JSON.parse(
      gh(["run", "list", "--workflow", workflow, "--commit", sha, "--limit", "30", "--json", "databaseId,headSha,conclusion,status,event"])
    );
    let existing = runs();
    if (existing.some((r) => r.conclusion === "success")) continue;
    let run = existing.find((r) => r.status !== "completed");
    if (!run) {
      if (gh(["api", `repos/${repo}/commits/main`, "--jq", ".sha"]).trim() !== sha)
        throw new Error("main moved before workflow dispatch; retry from its new HEAD");
      const previous = new Set(existing.map((r) => r.databaseId));
      gh(["workflow", "run", workflow, "--ref", "main"]);
      for (let attempt = 0; attempt < 30 && !run; attempt++) {
        await new Promise((resolve12) => setTimeout(resolve12, 2e3));
        existing = runs();
        run = existing.find((r) => !previous.has(r.databaseId) && r.event === "workflow_dispatch");
      }
    }
    if (!run) throw new Error(`No ${workflow} run appeared for ${sha}`);
    process.stdout.write(`Waiting for ${workflow}: ${run.databaseId}
`);
    execFileSync2("gh", ["run", "watch", String(run.databaseId), "--exit-status", "--interval", "15"], {
      cwd: root,
      env: env2,
      stdio: "inherit",
      timeout: 25 * 6e4
    });
  }
}
function githubRepoForRemote(remote) {
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error("origin must be a GitHub repository");
  return match[1];
}

// src/skillkit/repin.ts
import { execFileSync as execFileSync3 } from "child_process";
import { readFileSync as readFileSync5, writeFileSync as writeFileSync2 } from "fs";
import { join as join6 } from "path";

// src/skillkit/config.ts
import { join as join4 } from "path";

// src/run.ts
init_no_write();
import { join as join3 } from "path";
import { readFileSync as readFileSync3 } from "fs";
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync3(path, "utf8"));
  } catch {
    return void 0;
  }
}

// src/skillkit/config.ts
var SKILL_CONFIG = "skill.json";
var DEFAULT_FILES = [
  { remote: "scripts/engine.mjs", local: "{name}-engine.mjs" },
  { remote: "scripts/engine.d.mts", local: "{name}-engine.d.mts" }
];
function readSkillConfig(root) {
  const path = join4(root, SKILL_CONFIG);
  const raw = readJsonSafe(path);
  if (!raw) return { errors: [`no readable ${SKILL_CONFIG} at ${path} \u2014 run \`skill init\` to scaffold one.`] };
  const errors = [];
  const name2 = typeof raw.name === "string" && raw.name ? raw.name : void 0;
  if (!name2) errors.push(`${SKILL_CONFIG}: "name" must be a non-empty string.`);
  const engines = {};
  const rawEngines = raw.engines;
  if (!rawEngines || typeof rawEngines !== "object") {
    errors.push(`${SKILL_CONFIG}: "engines" must be an object of { repo, minRef, meta }.`);
  } else {
    for (const [key, value] of Object.entries(rawEngines)) {
      const e = value;
      if (typeof e?.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(e.repo)) {
        errors.push(`${SKILL_CONFIG}: engines.${key}.repo must be "owner/name".`);
        continue;
      }
      if (typeof e.minRef !== "string" || !/^v\d+\.\d+\.\d+$/.test(e.minRef)) {
        errors.push(`${SKILL_CONFIG}: engines.${key}.minRef must be a "vX.Y.Z" tag.`);
        continue;
      }
      if (e.usageFloor !== void 0 && (!Number.isInteger(e.usageFloor) || e.usageFloor < 0))
        errors.push(`${SKILL_CONFIG}: engines.${key}.usageFloor must be a non-negative integer.`);
      if (e.forks !== void 0 && (typeof e.forks !== "object" || e.forks === null || Array.isArray(e.forks) || Object.values(e.forks).some((why) => typeof why !== "string" || !why.trim())))
        errors.push(`${SKILL_CONFIG}: engines.${key}.forks must map declarations to non-empty reasons.`);
      if (e.dependency !== void 0 && (typeof e.dependency !== "string" || !e.dependency.trim()))
        errors.push(`${SKILL_CONFIG}: engines.${key}.dependency must be a package name.`);
      const meta = typeof e.meta === "string" && e.meta ? e.meta : `${key}.meta.json`;
      const files = Array.isArray(e.files) && e.files.length ? e.files : DEFAULT_FILES.map((f) => ({ ...f, local: f.local.replace("{name}", key) }));
      engines[key] = { repo: e.repo, minRef: e.minRef, meta, files, usageFloor: e.usageFloor, forks: e.forks, dependency: e.dependency };
    }
    if (!Object.keys(engines).length && !errors.length) errors.push(`${SKILL_CONFIG}: "engines" is empty \u2014 nothing to vendor or police.`);
  }
  const floor = raw.usageFloor;
  if (floor !== void 0 && (typeof floor !== "number" || !Number.isInteger(floor) || floor < 0)) {
    errors.push(`${SKILL_CONFIG}: "usageFloor" must be a non-negative integer.`);
  }
  const forks = raw.forks;
  if (forks !== void 0 && (typeof forks !== "object" || forks === null || Array.isArray(forks))) {
    errors.push(`${SKILL_CONFIG}: "forks" must be an object of "path:Name" -> reason.`);
  }
  const foreign = raw.allowedForeignFlags;
  if (foreign !== void 0 && (!Array.isArray(foreign) || foreign.some((f) => typeof f !== "string"))) {
    errors.push(`${SKILL_CONFIG}: "allowedForeignFlags" must be an array of strings.`);
  }
  if (errors.length) return { errors };
  return {
    config: {
      name: name2,
      vendorDir: typeof raw.vendorDir === "string" && raw.vendorDir ? raw.vendorDir : join4("src", "vendor"),
      engines,
      usageFloor: typeof floor === "number" ? floor : 0,
      forks: forks ?? {},
      allowedForeignFlags: foreign ?? []
    },
    errors: []
  };
}
function compareTags(a, b) {
  const parts = (t) => String(t).replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// src/skillkit/vendor.ts
init_no_write();
import { createHash } from "crypto";
import { readFileSync as readFileSync4 } from "fs";
import { join as join5 } from "path";
var sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
function checkPins(root, config) {
  return Object.entries(config.engines).map(([name2, pin]) => {
    const problems = [];
    const metaPath = join5(root, config.vendorDir, pin.meta);
    const meta = readJsonSafe(metaPath);
    if (!meta?.tag || !meta.sha256) {
      return {
        engine: name2,
        ok: false,
        problems: [`no readable pin at ${config.vendorDir}/${pin.meta} \u2014 run \`skill vendor --engine ${name2} --ref <tag>\` first.`]
      };
    }
    for (const f of pin.files ?? []) {
      const local2 = join5(root, config.vendorDir, f.local);
      let actual;
      try {
        actual = sha256(readFileSync4(local2));
      } catch {
        problems.push(`${config.vendorDir}/${f.local} is missing \u2014 the pin records it but it is not on disk.`);
        continue;
      }
      const expected = meta.sha256[f.local];
      if (!expected) problems.push(`${config.vendorDir}/${f.local} is not recorded in ${pin.meta} \u2014 re-pin.`);
      else if (actual !== expected) problems.push(`DRIFT in ${config.vendorDir}/${f.local} \u2014 the bytes differ from the ${meta.tag} pin.`);
    }
    if (!problems.length) {
      const first = pin.files?.[0];
      const body = first ? readFileSync4(join5(root, config.vendorDir, first.local), "utf8") : "";
      const version = /(?:^|\n)\s*(?:(?:var|const|let)\s+)?ENGINE_VERSION\s*=\s*"([^"]+)"/.exec(body)?.[1];
      if (!version || meta.tag !== `v${version}` || meta.engineVersion !== version) problems.push("tag, engineVersion and embedded ENGINE_VERSION disagree");
      if (meta.commit && !/^[a-f0-9]{40}$/.test(meta.commit)) problems.push("invalid upstream commit");
    }
    if (!problems.length && compareTags(meta.tag, pin.minRef) < 0) {
      problems.push(
        `STALE ${name2} pin \u2014 vendored ${meta.tag}, but this repo's source needs at least ${pin.minRef}. Run \`skill vendor --engine ${name2} --ref ${pin.minRef}\` (or newer).`
      );
    }
    return { engine: name2, ok: problems.length === 0, tag: meta.tag, engineVersion: meta.engineVersion, problems };
  });
}
async function vendorEngine(root, config, name2, ref2, fetchFile, commit) {
  const pin = config.engines[name2];
  if (!pin) return { written: [], errors: [`unknown engine "${name2}" \u2014 expected one of: ${Object.keys(config.engines).join(", ")}.`] };
  if (!/^v\d+\.\d+\.\d+$/.test(ref2)) return { written: [], errors: [`invalid stable release tag ${ref2}`] };
  if (compareTags(ref2, pin.minRef) < 0) return { written: [], errors: [`${ref2} is below the minimum ${pin.minRef}`] };
  if (commit !== void 0 && !/^[a-f0-9]{40}$/.test(commit)) return { written: [], errors: ["invalid upstream commit"] };
  const vendorDir = join5(root, config.vendorDir);
  const current2 = readJsonSafe(join5(vendorDir, pin.meta));
  if (current2?.tag && compareTags(ref2, current2.tag) < 0) return { written: [], errors: [`refusing downgrade from ${current2.tag} to ${ref2}`] };
  const staged = [];
  const sums = {};
  for (const f of pin.files ?? []) {
    const url = `https://raw.githubusercontent.com/${pin.repo}/${commit ?? ref2}/${f.remote}`;
    const buf = await fetchFile(url);
    if (!buf) return { written: [], errors: [`could not fetch ${url}`] };
    staged.push({ local: join5(vendorDir, f.local), buf });
    sums[f.local] = sha256(buf);
  }
  const engineVersion = /(?:^|\n)\s*(?:(?:var|const|let)\s+)?ENGINE_VERSION\s*=\s*"([^"]+)"/.exec(staged[0]?.buf.toString("utf8") ?? "")?.[1];
  if (!engineVersion || `v${engineVersion}` !== ref2)
    return {
      written: [],
      errors: [
        `the ${name2} bundle reports ENGINE_VERSION=${engineVersion ?? "?"} but the pinned ref is ${ref2} \u2014 refusing to record a pin that disagrees with its bytes.`
      ]
    };
  if (current2?.tag === ref2 && (current2.commit && commit && current2.commit !== commit || Object.entries(current2.sha256).some(([file, hash]) => sums[file] !== hash))) {
    return { written: [], errors: [`upstream moved the existing ${ref2} pin`] };
  }
  const meta = { tag: ref2, engineVersion, sha256: sums, syncedAt: (/* @__PURE__ */ new Date()).toISOString(), ...commit ? { commit } : {} };
  ensureDir(vendorDir);
  for (const file of staged) writeFileAtomic(file.local, file.buf);
  const metaPath = join5(vendorDir, pin.meta);
  writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}
`);
  return { written: [...staged.map((f) => f.local), metaPath], errors: [], tag: ref2, engineVersion };
}

// src/skillkit/repin.ts
function latestStable(releases) {
  const tags = releases.filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name)).map((r) => r.tag_name);
  tags.sort((a, b) => compareTags(b, a));
  if (!tags[0]) throw new Error("No stable engine release found");
  return tags[0];
}
function githubJson(path, pages = false) {
  return JSON.parse(execFileSync3("gh", ["api", path, ...pages ? ["--paginate", "--slurp"] : []], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}
function releaseCommit(repo, tag) {
  const result = githubJson(`repos/${repo}/commits/${tag}`);
  if (!result.sha || !/^[a-f0-9]{40}$/.test(result.sha)) throw new Error(`Invalid commit for ${repo}@${tag}`);
  return result.sha;
}
function latest(repo) {
  return latestStable(githubJson(`repos/${repo}/releases?per_page=100`, true).flat());
}
async function fetchEngineFile(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(6e4) });
  if (!response.ok) return void 0;
  return Buffer.from(await response.arrayBuffer());
}
async function repinSkill(root, config) {
  const bad = checkPins(root, config).filter((s) => !s.ok);
  if (bad.length) throw new Error(bad.flatMap((s) => s.problems).join("\n"));
  const changes = [];
  const pkgPath = join6(root, "package.json");
  const pkg = JSON.parse(readFileSync5(pkgPath, "utf8"));
  for (const [name2, engine] of Object.entries(config.engines)) {
    const pin = JSON.parse(readFileSync5(join6(root, config.vendorDir, engine.meta), "utf8"));
    const tag = latest(engine.repo);
    if (compareTags(tag, pin.tag) < 0) throw new Error(`Refusing downgrade of ${name2}: ${pin.tag} -> ${tag}`);
    if (engine.dependency && pkg.devDependencies?.[engine.dependency] !== tag.slice(1)) {
      pkg.devDependencies = { ...pkg.devDependencies, [engine.dependency]: tag.slice(1) };
      changes.push(`${engine.dependency} -> ${tag}`);
    }
    if (tag === pin.tag && pin.commit) continue;
    const result = await vendorEngine(root, config, name2, tag, fetchEngineFile, releaseCommit(engine.repo, tag));
    if (result.errors.length) throw new Error(result.errors.join("\n"));
    if (engine.dependency) pkg.devDependencies[engine.dependency] = tag.slice(1);
    changes.push(`${name2}: ${pin.tag} -> ${tag}`);
  }
  const toolTag = latest("maxgfr/webindex");
  const toolCommit = releaseCommit("maxgfr/webindex", toolTag);
  const toolUrl = `https://codeload.github.com/maxgfr/webindex/tar.gz/${toolCommit}`;
  const oldTool = pkg.devDependencies?.["@maxgfr/webindex"];
  if (oldTool !== toolUrl) {
    const installed2 = JSON.parse(readFileSync5(join6(root, "node_modules/@maxgfr/webindex/package.json"), "utf8"));
    if (compareTags(toolTag, `v${installed2.version}`) < 0) throw new Error("Refusing maintenance-tool downgrade");
    pkg.devDependencies = { ...pkg.devDependencies, "@maxgfr/webindex": toolUrl };
    changes.push(`skillkit -> ${toolTag} (${toolCommit})`);
  }
  if (changes.length) writeFileSync2(pkgPath, `${JSON.stringify(pkg, null, 2)}
`);
  return changes;
}

// src/cli.ts
init_brand();
init_charset();
import { existsSync as existsSync14, mkdirSync as mkdirSync8, readFileSync as readFileSync19, realpathSync as realpathSync4, statSync as statSync12 } from "fs";
import { isIP as isIP2 } from "net";
import { basename as basename5, extname, isAbsolute as isAbsolute5, join as join27, relative as relative4, resolve as resolve11 } from "path";
import { fileURLToPath as fileURLToPath2, pathToFileURL } from "url";

// src/version.ts
var ENGINE_VERSION = "1.30.0";

// src/cli.ts
init_doc();
init_pdf();
init_video();
init_ladder3();
init_exec();
init_ladder();
init_npx();
init_exec2();
init_fetch();
init_firecrawl();

// src/stack.ts
init_brand();
import { spawnSync as spawnSync3 } from "child_process";
import { existsSync as existsSync9, lstatSync as lstatSync3, mkdirSync as mkdirSync5, readFileSync as readFileSync15, statSync as statSync7, writeFileSync as writeFileSync7 } from "fs";
import { dirname as dirname2, join as join19, resolve as resolve3 } from "path";

// src/cache.ts
init_fetch();
init_doc();
init_video();
init_firecrawl();
init_url();
init_no_write();
init_brand();
init_mode();
import { chmodSync as chmodSync2, existsSync as existsSync8, lstatSync as lstatSync2, mkdirSync as mkdirSync4, readFileSync as readFileSync14, readdirSync as readdirSync6, rmSync as rmSync6, statSync as statSync6 } from "fs";
import { dirname, join as join18 } from "path";
import { tmpdir as tmpdir4 } from "os";
var DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
function cacheDir() {
  return namedCacheDir() ?? join18(tmpdir4(), userScoped(brand().name), "cache");
}
var namedCacheDir = () => env("CACHE_DIR") ?? brand().cacheDir;
function userScoped(name2) {
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  return uid === void 0 ? name2 : `${name2}-${uid}`;
}
function cachePath(url, acceptLanguage = "", extractor = "native", variant = "") {
  const canon = canonicalizeUrl(url);
  const domain = domainOf(url).replace(/[^a-z0-9.-]/gi, "_") || "url";
  const ns = extractor === "browser" ? "browser\0no-overlays" : extractor;
  const key = `${canon}\0${acceptLanguage}\0${ns}${variant ? `\0${variant}` : ""}`;
  return join18(cacheDir(), `${domain}-${fnv1a64(key).toString(16)}.json`);
}
var TEXT_VARIANTS = ["", "consent", "full"];
var MARKDOWN_VARIANTS = ["md", "consent-md", "full-md"];
var PLAIN = [""];
function variantOf(opts) {
  const read3 = opts.fullPage ? "full" : opts.stripConsent ? "consent" : "";
  if (opts.format !== "markdown") return read3;
  return read3 ? `${read3}-md` : "md";
}
var sameFormat = (variant) => MARKDOWN_VARIANTS.includes(variant) ? MARKDOWN_VARIANTS : TEXT_VARIANTS;
var PDF_CACHE_NS = "pdf";
var DOC_CACHE_NS = "doc";
var VIDEO_CACHE_NS = "video";
async function currentExtractor(opts, url) {
  if (looksLikePdfUrl(url)) return PDF_CACHE_NS;
  if (knownVideo(url)) return VIDEO_CACHE_NS;
  if (docFormatForUrl(url)) return DOC_CACHE_NS;
  if (browserFetchMode(opts.browser) === "always") return "browser";
  if (opts.fullPage) return "native";
  const base2 = firecrawlBase(opts);
  return base2 && await probeFirecrawl(base2, firecrawlIsExplicit(opts)) ? "firecrawl" : "native";
}
var DOCUMENT_NAMESPACES = [PDF_CACHE_NS, DOC_CACHE_NS, VIDEO_CACHE_NS, "pdf-inspector", "pdftotext", "anydoc", "ocr"];
var WRITTEN_NAMESPACES = ["native", "firecrawl", "browser", ...DOCUMENT_NAMESPACES];
var splitByVariant = (ns) => ns === "native" || ns === "browser";
function namespaceFor(result, predicted) {
  if (predicted === VIDEO_CACHE_NS && result.documentType !== "video") return result.extractor ?? "native";
  return result.documentType ?? (predicted === PDF_CACHE_NS || predicted === DOC_CACHE_NS || predicted === VIDEO_CACHE_NS ? predicted : result.extractor ?? "native");
}
function readAnyNamespace(url, acceptLanguage, namespaces = WRITTEN_NAMESPACES, variants = PLAIN) {
  let best;
  for (const ns of namespaces) {
    for (const variant of splitByVariant(ns) ? variants : PLAIN) {
      const hit = readCache(url, acceptLanguage, ns, variant);
      if (hit && (!best || hit.cachedAt > best.cachedAt)) best = hit;
    }
  }
  return best;
}
function readAnyCopy(url, acceptLanguage, variant) {
  return readAnyNamespace(url, acceptLanguage, WRITTEN_NAMESPACES, [variant]) ?? readAnyNamespace(url, acceptLanguage, WRITTEN_NAMESPACES, sameFormat(variant));
}
function ttlMs() {
  const fallback = brand().cacheTtlMs ?? DEFAULT_TTL_MS;
  const hours = env("CACHE_TTL_HOURS");
  if (hours !== void 0) {
    const h = Number(hours);
    return Number.isFinite(h) ? Math.round(Math.max(0, h) * 36e5) : fallback;
  }
  return envInt("CACHE_TTL_MS", fallback);
}
var mode = { refresh: false, offline: false };
function setCacheMode(next) {
  mode = { ...mode, ...next };
}
function isCacheFresh(entry, now = Date.now()) {
  return typeof entry.cachedAt === "number" && now - entry.cachedAt < ttlMs();
}
function revalidationHeaders(entry) {
  const h = {};
  if (entry.etag) h["if-none-match"] = entry.etag;
  if (entry.lastModified) h["if-modified-since"] = entry.lastModified;
  return h;
}
function entryPaths(url, acceptLanguage, extractor, variant) {
  const meta = cachePath(url, acceptLanguage, extractor, splitByVariant(extractor) ? variant : "");
  return { meta, body: meta.replace(/\.json$/, ".body") };
}
function readCache(url, acceptLanguage = "", extractor = "native", variant = "") {
  if (!entryDir(false)) return void 0;
  const { meta, body } = entryPaths(url, acceptLanguage, extractor, variant);
  if (!existsSync8(meta)) return void 0;
  try {
    const entry = JSON.parse(readFileSync14(meta, "utf8"));
    if (typeof entry.cachedAt !== "number") return void 0;
    const text = existsSync8(body) ? readFileSync14(body, "utf8") : entry.text;
    if (!text?.trim()) return void 0;
    return { ...entry, text };
  } catch {
    return void 0;
  }
}
function writeCache(url, res, now, acceptLanguage = "", extractor = "native", variant = "") {
  if (isNoWrite()) return;
  const { meta, body } = entryPaths(url, acceptLanguage, extractor, variant);
  const { text, note: _note, ...rest } = res;
  const write = () => {
    if (!entryDir(true)) return;
    writeFileAtomic(body, text ?? "");
    writeFileAtomic(meta, JSON.stringify({ ...rest, cachedAt: now }));
  };
  try {
    write();
  } catch {
    ensured.delete(cacheDir());
    try {
      write();
    } catch {
    }
  }
}
var ensured = /* @__PURE__ */ new Set();
function ensureDir2(dir) {
  if (ensured.has(dir)) return;
  mkdirSync4(dir, { recursive: true });
  ensured.add(dir);
}
function openCacheDir(create) {
  const dir = cacheDir();
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (namedCacheDir() !== void 0 || uid === void 0) {
    if (create) ensureDir2(dir);
    return { dir };
  }
  if (create) mkdirSync4(dirname(dirname(dir)), { recursive: true });
  for (const p of [dirname(dir), dir]) {
    if (create) mkdirPrivate(p);
    let st;
    try {
      st = lstatSync2(p);
    } catch (e) {
      if (e.code === "ENOENT") return {};
      return { refused: `${p} cannot be inspected (${e.message})` };
    }
    if (st.isSymbolicLink()) return { refused: `${p} is a symbolic link` };
    if (!st.isDirectory()) return { refused: `${p} is not a directory` };
    if (st.uid !== uid) return { refused: `${p} belongs to another user` };
    if (st.mode & 18) return { refused: `${p} is writable by other users` };
    if (st.mode & 63 && !isNoWrite()) {
      try {
        chmodSync2(p, 448);
      } catch {
      }
    }
  }
  return { dir };
}
function mkdirPrivate(p) {
  try {
    mkdirSync4(p, { mode: 448 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}
var announced = /* @__PURE__ */ new Set();
function entryDir(create) {
  const { dir, refused } = openCacheDir(create);
  if (refused && !announced.has(refused)) {
    announced.add(refused);
    process.emitWarning(`the fetch cache is not used: ${refused}. Remove it, or set ${envName("CACHE_DIR")} to a directory only you can write.`);
  }
  return dir;
}
function touchCache(url, entry, now, acceptLanguage = "", extractor = "native", variant = "") {
  writeCache(url, entry, now, acceptLanguage, extractor, variant);
}
async function cachedFetchAndExtract(url, opts = {}, enabled = false, now = Date.now()) {
  const { refresh, offline } = mode;
  if (!enabled && !offline) return fetchAndExtract(url, opts);
  const lang = opts.acceptLanguage ?? "";
  const variant = variantOf(opts);
  const served = (entry, note) => {
    countFetch(Buffer.byteLength(entry.text), true);
    const { note: _stored, browserTried: _tried, ...rest } = entry;
    const about = note ?? (entry.truncated ? `The cached text of ${url} is a prefix: the page overran the response size cap.` : void 0);
    return { ...rest, cached: true, ...about ? { note: about } : {} };
  };
  if (offline) {
    const stored2 = readAnyCopy(url, lang, variant);
    if (stored2) return served(stored2);
    const { refused } = openCacheDir(false);
    if (refused) return { text: "", finalUrl: url, status: 0, note: `Offline: the cache is not used \u2014 ${refused}.` };
    return { text: "", finalUrl: url, status: 0, note: `Offline: ${url} is not in the cache (drop --offline, or warm it with a normal run).` };
  }
  const ns = await currentExtractor(opts, url);
  const fallback = browserFetchMode(opts.browser) === "fallback";
  const store = (result, tried = false) => {
    const target = namespaceFor(result, ns);
    let entry = ns === "firecrawl" && target === "native" ? { ...result, fallbackFrom: "firecrawl" } : result;
    if (tried && wouldRender(entry)) entry = { ...entry, browserTried: true };
    writeCache(url, entry, now, lang, target, variant);
  };
  const hit = refresh ? void 0 : lookup(url, lang, ns, variant, fallback);
  if (hit && isCacheFresh(hit, now)) return served(hit);
  let res;
  const revalidate = hit ? revalidationHeaders(hit) : {};
  if (hit && Object.keys(revalidate).length) {
    const probe = await fetchAndExtract(url, { ...opts, headers: revalidate });
    if (probe.status === 304) {
      const renewed = { ...hit, etag: probe.etag ?? hit.etag, lastModified: probe.lastModified ?? hit.lastModified };
      touchCache(url, renewed, now, lang, namespaceFor(hit, ns), variant);
      return served(renewed);
    }
    if (probe.text?.trim()) {
      store(probe);
      return probe;
    }
    if (probe.status !== 412 && !(probe.status >= 200 && probe.status < 300)) res = probe;
  }
  const unconditional = res === void 0;
  res ??= await fetchAndExtract(url, opts);
  if (res.text?.trim()) {
    store(res, fallback && unconditional);
    return res;
  }
  const stale = hit ?? readAnyCopy(url, lang, variant);
  if (stale) return served(stale, `${url} returned ${res.status || "no response"}; served the cached copy from ${new Date(stale.cachedAt).toISOString()}.`);
  return res;
}
function lookup(url, acceptLanguage, ns, variant, browserFallback = false) {
  const own = lookupOwn(url, acceptLanguage, ns, variant);
  const best = browserFallback && own && wouldRender(own) ? void 0 : own;
  const rendered = browserFallback ? readCache(url, acceptLanguage, "browser", variant) : void 0;
  return rendered && (!best || rendered.cachedAt > best.cachedAt) ? rendered : best;
}
var wouldRender = (entry) => !entry.browserTried && !entry.documentType && ["native", "firecrawl"].includes(entry.extractor ?? "native") && worthRendering(entry) !== void 0;
function lookupOwn(url, acceptLanguage, ns, variant) {
  const best = readAnyNamespace(url, acceptLanguage, [.../* @__PURE__ */ new Set([ns, ...DOCUMENT_NAMESPACES])], [variant]);
  if (ns === VIDEO_CACHE_NS && !best) return readCache(url, acceptLanguage, "native", variant);
  if (ns !== "firecrawl") return best;
  const fallback = readCache(url, acceptLanguage, "native", variant);
  return fallback?.fallbackFrom === "firecrawl" && (!best || fallback.cachedAt > best.cachedAt) ? fallback : best;
}
var WRITER_TMP = /\.\d+\.\d+\.tmp$/;
function ownFile(name2) {
  const tmp = WRITER_TMP.exec(name2);
  const base2 = tmp ? name2.slice(0, tmp.index) : name2;
  const ext = base2.endsWith(".json") ? "json" : base2.endsWith(".body") ? "body" : void 0;
  if (!ext) return void 0;
  const stem = base2.slice(0, -5);
  const dash = stem.lastIndexOf("-");
  if (dash < 1 || !/^[0-9a-f]{1,16}$/.test(stem.slice(dash + 1)) || !/^[\w.-]+$/.test(stem.slice(0, dash))) return void 0;
  return { kind: tmp ? "tmp" : ext, stem };
}
function readEntryMeta(abs) {
  try {
    const entry = JSON.parse(readFileSync14(abs, "utf8"));
    return entry && typeof entry.cachedAt === "number" && typeof entry.finalUrl === "string" ? entry : void 0;
  } catch {
    return void 0;
  }
}
var ORPHAN_GRACE_MS = 10 * 60 * 1e3;
function sizeOf(abs) {
  try {
    return statSync6(abs).size;
  } catch {
    return 0;
  }
}
function cacheStats(now = Date.now()) {
  const dir = cacheDir();
  const out = { dir, entries: 0, bytes: 0, fresh: 0, stale: 0, ttlMs: ttlMs() };
  const { refused } = openCacheDir(false);
  if (refused) return { ...out, refused };
  if (!existsSync8(dir)) return out;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  for (const name2 of readdirSync6(dir)) {
    const own = ownFile(name2);
    if (!own) continue;
    const abs = join18(dir, name2);
    if (own.kind !== "json") {
      out.bytes += sizeOf(abs);
      continue;
    }
    const entry = readEntryMeta(abs);
    if (!entry) continue;
    out.bytes += sizeOf(abs);
    out.entries++;
    if (isCacheFresh(entry, now)) out.fresh++;
    else out.stale++;
    if (entry.cachedAt < oldest) oldest = entry.cachedAt;
    if (entry.cachedAt > newest) newest = entry.cachedAt;
  }
  if (out.entries) {
    out.oldest = new Date(oldest).toISOString();
    out.newest = new Date(newest).toISOString();
  }
  return out;
}
function cacheClean(all = false, now = Date.now()) {
  const dir = cacheDir();
  if (isNoWrite() || !openCacheDir(false).dir || !existsSync8(dir)) return 0;
  const names = readdirSync6(dir);
  const present = new Set(names);
  const remove = (name2) => {
    try {
      rmSync6(join18(dir, name2), { force: true });
      return true;
    } catch {
      return false;
    }
  };
  const abandoned = (name2) => {
    try {
      return all || now - statSync6(join18(dir, name2)).mtimeMs > ORPHAN_GRACE_MS;
    } catch {
      return false;
    }
  };
  let removed = 0;
  for (const name2 of names) {
    const own = ownFile(name2);
    if (!own) continue;
    if (own.kind === "json") {
      const entry = readEntryMeta(join18(dir, name2));
      if (!entry || !all && isCacheFresh(entry, now) || !remove(name2)) continue;
      remove(`${own.stem}.body`);
      removed++;
    } else if (own.kind === "body" ? !present.has(`${own.stem}.json`) && abandoned(name2) : abandoned(name2)) {
      remove(name2);
    }
  }
  return removed;
}

// src/stack.ts
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
function composeAssets() {
  const base2 = join19(cacheDir(), "compose");
  return [
    { path: join19(base2, "docker-compose.yml"), content: renderAsset(COMPOSE_YAML) },
    { path: join19(base2, "docker", "searxng", "settings.yml"), content: renderAsset(SEARXNG_SETTINGS_YAML) },
    { path: join19(base2, "docker", "firecrawl", "firecrawl.env"), content: renderAsset(FIRECRAWL_ENV) }
  ];
}
function ensureComposeMaterialized() {
  const assets = composeAssets();
  for (const a of assets) writeIfChanged(a.path, a.content);
  return assets[0].path;
}
function untrustedStack() {
  const assets = composeAssets();
  for (const a of assets) {
    let body;
    try {
      body = readFileSync15(a.path, "utf8");
    } catch {
    }
    if (body !== a.content) return `${a.path} does not hold the stack this binary ships, and could not be rewritten`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (uid === void 0) return void 0;
  const root = resolve3(cacheDir());
  const chosen = !!(env("CACHE_DIR") ?? brand().cacheDir);
  const top = chosen ? root : dirname2(root);
  const paths = /* @__PURE__ */ new Set();
  for (const a of assets) {
    for (let p = resolve3(a.path); p !== top && p !== dirname2(p); p = dirname2(p)) paths.add(p);
  }
  for (const p of [top, ...paths]) {
    try {
      const st = p === top && chosen ? statSync7(p) : lstatSync3(p);
      if (st.isSymbolicLink()) return `${p} is a symbolic link`;
      if (st.uid !== uid) return `${p} belongs to another user`;
      if (st.mode & 2 && !(st.isDirectory() && st.mode & 512)) return `${p} is writable by anyone`;
    } catch (e) {
      return `${p} cannot be inspected (${e.message})`;
    }
  }
  return void 0;
}
function writeIfChanged(path, content) {
  try {
    if (existsSync9(path) && readFileSync15(path, "utf8") === content) return;
    mkdirSync5(dirname2(path), { recursive: true, mode: 448 });
    writeFileSync7(path, content);
  } catch {
  }
}
var DEFAULT_PULL_TIMEOUT_MS = 12e5;
var UP_TIMEOUT_MS = 3e5;
var DOWN_TIMEOUT_MS = 12e4;
var PS_TIMEOUT_MS = 3e4;
var MODEL_PULL_TIMEOUT_MS = 6e5;
var DAEMON_PROBE_TIMEOUT_MS = 15e3;
function pullTimeoutMs() {
  return envInt("DOCKER_PULL_TIMEOUT_MS", DEFAULT_PULL_TIMEOUT_MS);
}
function embedModel() {
  return env("EMBED_MODEL") ?? "nomic-embed-text";
}
function defaultRun(cmd, args, opts) {
  const res = spawnSync3(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: opts.capture ? "pipe" : "inherit"
  });
  const code = res.error?.code;
  return {
    ok: !res.error && res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
    missing: code === "ENOENT",
    ...code === "ETIMEDOUT" ? { timedOut: true } : {}
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
  const distrust = untrustedStack();
  if (distrust) {
    return {
      message: `${tag}: refusing to run docker against the stack in ${dirname2(file)} \u2014 ${distrust}. Set ${envName("CACHE_DIR")} to a directory only you can write.`,
      code: 1
    };
  }
  const daemon = run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: DAEMON_PROBE_TIMEOUT_MS, capture: true });
  if (!daemon.ok) {
    const why = daemon.stderr.trim().split("\n")[0];
    return {
      message: `${tag}: docker is installed but its daemon is not answering \u2014 start Docker (Docker Desktop, colima, or \`systemctl start docker\`) and retry.${why ? `
${why}` : ""}`,
      code: 1
    };
  }
  const profiles = spec.profiles.flatMap((p) => ["--profile", p]);
  if (action === "down") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "down"], { timeoutMs: DOWN_TIMEOUT_MS, capture: true });
    return { message: r.ok ? `${tag}: stopped.` : `${tag}: down failed.
${r.stderr}`, code: r.ok ? 0 : 1 };
  }
  if (action === "status") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "ps"], { timeoutMs: PS_TIMEOUT_MS, capture: true });
    return { message: r.ok ? r.stdout.trim() || `${tag}: no services running.` : `${tag}: status failed.
${r.stderr}`, code: r.ok ? 0 : 1 };
  }
  const pulled = run("docker", ["compose", "-f", file, ...profiles, "pull"], { timeoutMs: pullTimeoutMs() });
  if (!pulled.ok) {
    const why = pulled.timedOut ? ` after ${pullTimeoutMs()}ms (the images are large \u2014 raise ${envName("DOCKER_PULL_TIMEOUT_MS")})` : " \u2014 docker's output above says why";
    return { message: `${tag}: pulling the images failed${why}.${pulled.stderr ? `
${pulled.stderr}` : ""}`, code: 1 };
  }
  const up = run("docker", ["compose", "-f", file, ...profiles, "up", "-d", "--wait"], { timeoutMs: UP_TIMEOUT_MS });
  if (!up.ok) {
    const why = up.timedOut ? ` \u2014 the services were not healthy within ${UP_TIMEOUT_MS / 1e3}s` : "";
    return { message: `${tag}: up failed${why}.${up.stderr ? `
${up.stderr}` : ""}`, code: 1 };
  }
  return { message: [`${tag}: ${spec.summary}`, ...spec.postUp?.(file, run) ?? []].join("\n"), code: 0 };
}

// src/embed.ts
init_brand();
init_fetch();
init_pool();

// src/probe.ts
var PROBE_RETRY_MS = 3e4;
function cachedProbe(cache2, key, ask) {
  const hit = cache2.get(key);
  if (hit && (hit.ok !== false || Date.now() - hit.at < PROBE_RETRY_MS)) return hit.verdict;
  const entry = { verdict: Promise.resolve(false), at: Date.now() };
  entry.verdict = ask().catch(() => false).then((ok) => {
    entry.ok = ok;
    entry.at = Date.now();
    return ok;
  });
  cache2.set(key, entry);
  return entry.verdict;
}

// src/embed.ts
function ollamaBase() {
  return env("OLLAMA") ?? "http://localhost:11434";
}
function embedConcurrency() {
  return Math.max(1, envInt("EMBED_CONCURRENCY", 4));
}
function embedBatch() {
  return Math.max(1, envInt("EMBED_BATCH", 16));
}
var probed = /* @__PURE__ */ new Map();
async function probeOllama(base2 = ollamaBase()) {
  const key = base2.replace(/\/+$/, "");
  if (key.toLowerCase() === "off") return false;
  return cachedProbe(probed, key, async () => (await httpJson("GET", `${key}/api/tags`, void 0, { timeoutMs: 2e3, retries: 0 })).ok);
}
async function embed(texts, opts = {}) {
  const model = opts.model ?? embedModel();
  if (texts.length === 0) return { vectors: [], model };
  const base2 = (opts.base ?? ollamaBase()).replace(/\/+$/, "");
  if (base2.toLowerCase() === "off") return { vectors: [], model, note: "embeddings are disabled (OLLAMA=off)." };
  if (!await probeOllama(base2)) {
    return { vectors: [], model, note: `no embedding server at ${base2} \u2014 \`${brand().cli} semantic up\` starts Ollama and pulls ${model}.` };
  }
  const batches = [];
  const width = embedBatch();
  for (let i = 0; i < texts.length; i += width) batches.push(texts.slice(i, i + width));
  let note;
  let failed2 = false;
  const results = await mapLimit(batches, opts.concurrency ?? embedConcurrency(), async (batch) => {
    if (failed2) return void 0;
    const r = await httpJson("POST", `${base2}/api/embed`, { model, input: batch }, { timeoutMs: 6e4 });
    const got = r.ok ? r.data?.embeddings : void 0;
    if (!got || got.length !== batch.length) {
      failed2 = true;
      note ??= embedFailure(base2, model, r);
      return void 0;
    }
    return got;
  });
  if (results.some((r) => r === void 0)) return { vectors: [], model, ...note ? { note } : {} };
  return { vectors: results.flat(), model };
}
function embedFailure(base2, model, r) {
  const said = typeof r.data?.error === "string" ? r.data.error : void 0;
  const why = r.error ?? (said ? `status ${r.status}: ${said}` : r.ok ? "the response held no vectors for this batch" : `status ${r.status}`);
  const missing = r.status === 404 || /not found/i.test(said ?? "");
  const hint = missing ? ` \u2014 \`ollama pull ${model}\`, or \`${brand().cli} semantic up\`, pulls it.` : ".";
  return `embedding failed at ${base2} (${why})${hint}`;
}
var PREFIXES = [
  { model: /nomic-embed/i, query: "search_query: ", doc: "search_document: " },
  { model: /mxbai-embed/i, query: "Represent this sentence for searching relevant passages: ", doc: "" },
  { model: /snowflake-arctic-embed2/i, query: "query: ", doc: "" },
  { model: /snowflake-arctic-embed/i, query: "Represent this sentence for searching relevant passages: ", doc: "" },
  { model: /(?:^|[/:_-])(?:multilingual-)?e5(?:[-_:]|$)/i, query: "query: ", doc: "passage: " }
];
function embedPrefixes(model = embedModel()) {
  const known = PREFIXES.find((p) => p.model.test(model)) ?? { query: "", doc: "" };
  const fromEnv = (name2) => {
    const v = env(name2);
    if (v === void 0) return void 0;
    return v.toLowerCase() === "none" ? "" : `${v} `;
  };
  return { query: fromEnv("EMBED_QUERY_PREFIX") ?? known.query, doc: fromEnv("EMBED_DOC_PREFIX") ?? known.doc };
}
function cosine(a, b) {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    ma += x * x;
    mb += y * y;
  }
  if (ma === 0 || mb === 0) return 0;
  const r = dot / (Math.sqrt(ma) * Math.sqrt(mb));
  return Number.isFinite(r) ? r : 0;
}

// src/vector.ts
init_brand();
init_fetch();
init_rank();
function qdrantBase() {
  return env("QDRANT") ?? "http://localhost:6333";
}
var clean2 = (base2) => base2.replace(/\/+$/, "");
var probed2 = /* @__PURE__ */ new Map();
async function probeQdrant(base2 = qdrantBase()) {
  const key = clean2(base2);
  if (key.toLowerCase() === "off") return false;
  return cachedProbe(probed2, key, async () => (await httpJson("GET", `${key}/collections`, void 0, { timeoutMs: 2e3, retries: 0 })).ok);
}
async function hybridSearch(question, docs, opts = {}) {
  if (docs.length === 0) return { hits: [] };
  const prefixes = embedPrefixes(opts.model);
  const queryPrefix = opts.queryPrefix ?? prefixes.query;
  const docPrefix = opts.docPrefix ?? prefixes.doc;
  const maxChars = opts.maxChars ?? envInt("EMBED_MAX_CHARS", 8e3);
  const embedding = embed([queryPrefix + question, ...docs.map((d) => docPrefix + clip([d.title, d.headings, d.body].filter(Boolean).join("\n"), maxChars))], {
    ...opts.base !== void 0 ? { base: opts.base } : {},
    ...opts.model !== void 0 ? { model: opts.model } : {}
  });
  const index = buildBm25Index(question, docs);
  const lexical = docs.map((doc, i) => ({ i, score: bm25Score(index, doc) })).sort((a, b) => b.score - a.score).map((s) => s.i);
  const embedded = await embedding;
  let dense = [];
  let note = embedded.note;
  if (embedded.vectors.length === docs.length + 1) {
    const q = embedded.vectors[0];
    const scored = docs.map((_, i) => ({ i, sim: cosine(q, embedded.vectors[i + 1]) }));
    dense = scored.sort((a, b) => b.sim - a.sim).map((s) => s.i);
  } else if (!note) {
    note = "the dense lane returned an unexpected number of vectors \u2014 ranking lexically only.";
  }
  const lists = dense.length ? [lexical, dense] : [lexical];
  const fused = rrf(lists, (i) => String(i), opts.k ?? envInt("RRF_K", 60));
  const lexRank = new Map(lexical.map((i, r) => [i, r + 1]));
  const denseRank = new Map(dense.map((i, r) => [i, r + 1]));
  const hits = docs.map((doc, i) => ({
    doc,
    score: fused.get(String(i)) ?? 0,
    ...lexRank.has(i) ? { lexicalRank: lexRank.get(i) } : {},
    ...denseRank.has(i) ? { denseRank: denseRank.get(i) } : {}
  })).sort((a, b) => b.score - a.score);
  return { hits: opts.limit !== void 0 && opts.limit > 0 ? hits.slice(0, opts.limit) : hits, ...note ? { note } : {} };
}
function clip(text, max) {
  if (max <= 0 || text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 55296 && code <= 56319 ? max - 1 : max);
}

// src/crawl.ts
init_brand();
init_fetch();

// src/feed.ts
init_charset();
init_fetch();
init_html();
import { promisify } from "util";
import { gunzip } from "zlib";
var OPENERS = /* @__PURE__ */ new Map();
function openerRe(name2) {
  let re = OPENERS.get(name2);
  if (!re) OPENERS.set(name2, re = new RegExp(`<${name2}(?=[\\s/>])`, "gi"));
  return re;
}
var withoutBom = (s) => s.charCodeAt(0) === 65279 ? s.slice(1) : s;
function markupOnly(xml) {
  if (!xml.includes("<![CDATA[") && !xml.includes("<!--")) return xml;
  const re = /<!\[CDATA\[|<!--/g;
  let out = "";
  let pos = 0;
  let m;
  while (m = re.exec(xml)) {
    const close = xml.indexOf(m[0] === "<!--" ? "-->" : "]]>", m.index + m[0].length);
    const end = close < 0 ? xml.length : close + 3;
    out += xml.slice(pos, m.index) + " ".repeat(end - m.index);
    pos = re.lastIndex = end;
  }
  return out + xml.slice(pos);
}
function elements(xml, name2, limit = Number.POSITIVE_INFINITY) {
  const scan = markupOnly(xml);
  const open2 = openerRe(name2);
  const close = closeTagRe(name2);
  const out = [];
  open2.lastIndex = 0;
  let m;
  while (out.length < limit && (m = open2.exec(scan))) {
    const tagEnd = scan.indexOf(">", open2.lastIndex);
    if (tagEnd < 0) break;
    const attrs = xml.slice(open2.lastIndex, tagEnd);
    if (attrs.endsWith("/")) {
      out.push({ attrs: attrs.slice(0, -1), inner: "", from: m.index, to: tagEnd + 1 });
      open2.lastIndex = tagEnd + 1;
      continue;
    }
    close.lastIndex = tagEnd + 1;
    const c = close.exec(scan);
    if (!c) break;
    out.push({ attrs, inner: xml.slice(tagEnd + 1, c.index), from: m.index, to: c.index + c[0].length });
    open2.lastIndex = c.index + c[0].length;
  }
  return out;
}
var OPEN_TAGS = /* @__PURE__ */ new Map();
function openTags(html, name2) {
  let re = OPEN_TAGS.get(name2);
  if (!re) OPEN_TAGS.set(name2, re = new RegExp(`<${name2}(?=[\\s/>])[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>`, "gi"));
  return [...markupOnly(html).matchAll(re)].map((m) => m[0]);
}
function xmlText(raw) {
  const re = /<!\[CDATA\[|<!--/g;
  let out = "";
  let pos = 0;
  let m;
  while (m = re.exec(raw)) {
    const cdata = m[0] !== "<!--";
    const close = raw.indexOf(cdata ? "]]>" : "-->", m.index + m[0].length);
    if (close < 0) break;
    out += decodeEntities(raw.slice(pos, m.index)) + (cdata ? raw.slice(m.index + 9, close) : "");
    pos = re.lastIndex = close + 3;
  }
  return out + decodeEntities(raw.slice(pos));
}
function fragmentText2(html) {
  const stripped = dropElements(html, ["script", "style"], RAW_TEXT_ELEMENTS).replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ").replace(LOOSE_TAG_RE, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}
var collapse2 = (s) => s.replace(/\s+/g, " ").trim();
function tagText(block, ...names) {
  for (const name2 of names) {
    const el = elements(block, name2, 1)[0];
    const text = el && collapse2(xmlText(el.inner));
    if (text) return text;
  }
  return void 0;
}
var HTML_ELEMENTS = /* @__PURE__ */ new Set([...BLOCK_TAGS, ...INLINE_TAGS, "br", "hr", "img", "h1", "h2", "h3", "h4", "h5", "h6"]);
function looksLikeHtml(text) {
  if (!/<\/[A-Za-z]\w*>/.test(text) && !/&#?\w+;/.test(text)) return false;
  for (const m of text.matchAll(/<\/?([A-Za-z]\w*)/g)) if (!HTML_ELEMENTS.has(m[1].toLowerCase())) return false;
  return true;
}
function proseText(block, atom, ...names) {
  for (const name2 of names) {
    const el = elements(block, name2, 1)[0];
    if (!el) continue;
    const declared = htmlAttributes(el.attrs).get("type")?.toLowerCase();
    const decoded = declared === "xhtml" ? "" : xmlText(el.inner);
    const type = declared ?? (atom ? "text" : name2 === "title" && !looksLikeHtml(decoded) ? "text" : "html");
    const text = type === "xhtml" ? fragmentText2(el.inner) : type === "text" || type === "text/plain" ? collapse2(decoded) : fragmentText2(decoded);
    if (text) return text;
  }
  return void 0;
}
var SUMMARY_MAX = 500;
function clip2(s) {
  return s && s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX).trimEnd()}\u2026` : s;
}
function resolveUrl(href, base2) {
  if (!base2) return href;
  try {
    return new URL(href, base2).href;
  } catch {
    return href;
  }
}
function rootElement(xml) {
  let i = xml.charCodeAt(0) === 65279 ? 1 : 0;
  for (; ; ) {
    while (i < xml.length && /\s/.test(xml[i])) i++;
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end < 0) return void 0;
      i = end + 2;
    } else if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end < 0) return void 0;
      i = end + 3;
    } else if (xml.startsWith("<!", i)) {
      let end = xml.indexOf(">", i);
      const subset = xml.indexOf("[", i);
      if (subset >= 0 && subset < end) {
        const closed = xml.indexOf("]", subset);
        end = closed < 0 ? -1 : xml.indexOf(">", closed);
      }
      if (end < 0) return void 0;
      if (/^<!doctype\s+html\b/i.test(xml.slice(i, end))) return "html";
      i = end + 1;
    } else {
      return /^<([A-Za-z_][\w.:-]*)/.exec(xml.slice(i, i + 256))?.[1]?.toLowerCase();
    }
  }
}
var NOT_THE_PAGE = /* @__PURE__ */ new Set(["self", "edit", "replies", "enclosure", "via", "related", "license"]);
function itemUrl(block, base2) {
  const links = openTags(block, "link").map(htmlAttributes);
  const hrefOf = (attrs) => {
    const href2 = attrs.get("href");
    return href2 ? decodeEntities(href2).trim() : void 0;
  };
  const rels = (attrs) => attrs.get("rel")?.toLowerCase().split(/\s+/) ?? [];
  const pick2 = links.find((a) => hrefOf(a) && (rels(a).length === 0 || rels(a).includes("alternate"))) ?? links.find((a) => hrefOf(a) && !rels(a).some((r) => NOT_THE_PAGE.has(r))) ?? links.find((a) => hrefOf(a));
  const href = pick2 && hrefOf(pick2);
  if (href) return resolveUrl(href, base2);
  const text = tagText(block, "link");
  if (text) return resolveUrl(text, base2);
  const guid = elements(block, "guid", 1)[0];
  if (!guid || htmlAttributes(guid.attrs).get("ispermalink")?.toLowerCase() === "false") return void 0;
  const value = collapse2(xmlText(guid.inner));
  return /^https?:\/\//i.test(value) ? value : void 0;
}
function xmlBase(attrs, above) {
  const declared = htmlAttributes(attrs).get("xml:base");
  return declared ? resolveUrl(decodeEntities(declared).trim(), above) : above;
}
function parseFeed(xml, baseUrl) {
  if (withoutBom(xml).trimStart().startsWith("{")) return parseJsonFeed(xml, baseUrl);
  const root = rootElement(xml);
  if (!root) return void 0;
  const kind = root === "rss" || /(^|:)rdf$/.test(root) ? "rss" : /(^|:)feed$/.test(root) ? "atom" : void 0;
  if (!kind) return void 0;
  const atom = kind === "atom";
  const rootTag = atom ? openTags(xml, root)[0] : void 0;
  const feedBase = rootTag ? xmlBase(rootTag, baseUrl) : baseUrl;
  const blocks = elements(xml, atom ? "entry" : "item");
  const items = [];
  for (const block of blocks) {
    const inner = block.inner;
    const it = {};
    const title2 = proseText(inner, atom, "title");
    if (title2) it.title = title2;
    const url = itemUrl(inner, atom ? xmlBase(block.attrs, feedBase) : feedBase);
    if (url) it.url = url;
    const published = tagText(inner, "pubDate", "published", "updated", "dc:date");
    if (published) it.published = published;
    const summary = proseText(inner, atom, "description", "summary") ?? clip2(proseText(inner, atom, "content", "content:encoded"));
    if (summary) it.summary = summary;
    const id = tagText(inner, "guid", "id");
    if (id) it.id = id;
    if (it.title || it.url) items.push(it);
  }
  let head = "";
  let last = 0;
  for (const b of blocks) {
    head += xml.slice(last, b.from);
    last = b.to;
  }
  head += xml.slice(last);
  const title = proseText(head, atom, "title");
  return { kind, items, ...title ? { title } : {} };
}
function parseJsonFeed(text, baseUrl) {
  let doc;
  try {
    doc = JSON.parse(withoutBom(text));
  } catch {
    return void 0;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return void 0;
  const feed = doc;
  if (typeof feed.version !== "string" || !feed.version.startsWith("https://jsonfeed.org/version/")) return void 0;
  const str6 = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
  const items = [];
  for (const raw of Array.isArray(feed.items) ? feed.items : []) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw;
    const it = {};
    const id = typeof entry.id === "number" ? String(entry.id) : str6(entry.id);
    if (id) it.id = id;
    const url = str6(entry.url) ?? str6(entry.external_url);
    if (url) it.url = resolveUrl(url, baseUrl);
    const title2 = str6(entry.title);
    if (title2) it.title = title2;
    const published = str6(entry.date_published) ?? str6(entry.date_modified);
    if (published) it.published = published;
    const html = str6(entry.content_html);
    const summary = str6(entry.summary) ?? clip2(str6(entry.content_text) ?? (html ? fragmentText2(html) : void 0));
    if (summary) it.summary = summary;
    if (it.title || it.url) items.push(it);
  }
  const title = str6(feed.title);
  return { kind: "json", items, ...title ? { title } : {} };
}
var FEED_TYPES = /* @__PURE__ */ new Set(["application/rss+xml", "application/atom+xml", "application/feed+json"]);
function discoverFeeds(html, baseUrl) {
  const out = [];
  for (const tag of openTags(html, "link")) {
    const attrs = htmlAttributes(tag);
    const rels = attrs.get("rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!rels.includes("alternate")) continue;
    const type = attrs.get("type")?.split(";")[0]?.trim().toLowerCase();
    if (!type || !FEED_TYPES.has(type)) continue;
    const href = attrs.get("href");
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
  const body = withoutBom(xml);
  if (!body.trimStart().startsWith("<")) {
    for (const line of body.split(/\r\n|\r|\n/)) {
      const loc = line.trim();
      if (/^https?:\/\/\S+$/i.test(loc)) out.urls.push({ loc });
    }
    return out;
  }
  const isIndex = /<sitemapindex(?=[\s/>])/i.test(body);
  for (const el of elements(body, "sitemap")) {
    const loc = tagText(el.inner, "loc");
    if (loc) out.sitemaps.push(loc);
  }
  if (isIndex) return out;
  for (const el of elements(body, "url")) {
    const loc = tagText(el.inner, "loc");
    if (!loc) continue;
    const lastmod = tagText(el.inner, "lastmod");
    out.urls.push({ loc, ...lastmod ? { lastmod } : {} });
  }
  return out;
}
var SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
var gunzipAsync = promisify(gunzip);
async function readSitemapDocument(url, authorize, signal) {
  let refused = false;
  const authorizeUrl = authorize && (async (u) => {
    const ok = await authorize(u);
    if (!ok) refused = true;
    return ok;
  });
  const r = await httpGet(url, {
    accept: "application/xml,text/xml,text/plain,*/*",
    timeoutMs: 1e4,
    binary: true,
    maxBytes: SITEMAP_MAX_BYTES,
    authorizeUrl,
    signal
  });
  if (!r.ok) {
    if (r.error === "cancelled") return {};
    if (r.truncated) return { note: `${url} is larger than the 50 MB a sitemap may be; not read.` };
    if (refused || r.status === 404 || r.status === 410) return {};
    return { note: `could not read ${url} (${r.status ? `status ${r.status}` : r.error ?? "no answer"}).` };
  }
  let bytes = r.bytes ?? Buffer.alloc(0);
  const gzipped = bytes[0] === 31 && bytes[1] === 139;
  if (gzipped) {
    if (r.truncated) return { note: `${url} is larger than the 50 MB a sitemap may be; not read.` };
    try {
      bytes = await gunzipAsync(bytes, { maxOutputLength: SITEMAP_MAX_BYTES });
    } catch (e) {
      const tooBig = e.code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError;
      return { note: tooBig ? `${url} decompresses past the 50 MB a sitemap may be; not read.` : `${url} is not valid gzip; not read.` };
    }
  }
  return {
    text: decodeBody(bytes, gzipped ? "application/xml" : r.contentType),
    ...r.truncated ? { note: `read only the first 50 MB of ${url}, the most a sitemap may be.` } : {}
  };
}
async function fetchSitemap(url, opts = {}) {
  const out = { urls: [], sitemaps: [] };
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return out;
  }
  const fallback = `${origin}/sitemap.xml`;
  const named = opts.sitemaps ?? [];
  const queue2 = named.length ? [...named] : [fallback];
  let guessed = !named.length;
  const seen = /* @__PURE__ */ new Set();
  const children = /* @__PURE__ */ new Set();
  const notes = [];
  let fetched = 0;
  const max = opts.max !== void 0 && Number.isFinite(opts.max) ? Math.max(1, Math.floor(opts.max)) : 3;
  for (; ; ) {
    if (!queue2.length && !guessed && !out.urls.length && !out.sitemaps.length) {
      guessed = true;
      queue2.push(fallback);
    }
    if (!queue2.length || fetched >= max) break;
    if (opts.signal?.aborted) {
      notes.push(`cancelled after ${fetched} sitemap document(s).`);
      break;
    }
    const next = queue2.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    fetched++;
    const doc = await readSitemapDocument(next, opts.authorizeUrl, opts.signal);
    if (opts.signal?.aborted) {
      queue2.unshift(next);
      seen.delete(next);
      notes.push(`cancelled after ${fetched - 1} sitemap document(s).`);
      break;
    }
    opts.onDocument?.(next, fetched);
    if (doc.note) notes.push(doc.note);
    if (!doc.text?.trim()) continue;
    const parsed = parseSitemap(doc.text);
    for (const u of parsed.urls) out.urls.push(u);
    for (const s of parsed.sitemaps) {
      if (children.has(s)) continue;
      children.add(s);
      out.sitemaps.push(s);
      queue2.push(s);
    }
  }
  out.unfetched = [...new Set(queue2.filter((s) => !seen.has(s) && s !== fallback))];
  if (notes.length) out.notes = notes;
  return out;
}
async function fetchFeed(url, opts = {}) {
  const r = await httpGet(url, {
    accept: "application/atom+xml,application/rss+xml,application/feed+json,application/xml,*/*",
    timeoutMs: 1e4,
    authorizeUrl: opts.authorizeUrl,
    signal: opts.signal
  });
  if (!r.ok || !r.body.trim()) return void 0;
  return parseFeed(r.body, r.url);
}

// src/crawl.ts
init_pool();
init_html();
init_markdown2();

// src/robots.ts
init_brand();
init_fetch();
var EMPTY = { rules: [], sitemaps: [], absent: true };
function productToken(s) {
  return /^[A-Za-z_-]+/.exec(s.trim())?.[0]?.toLowerCase();
}
function parseRobots(body, userAgent) {
  const ua = productToken(userAgent) ?? userAgent.trim().toLowerCase();
  const groups = /* @__PURE__ */ new Map();
  const delays = /* @__PURE__ */ new Map();
  const sitemaps = [];
  let current2 = [];
  let inHeader = false;
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sep4 = line.indexOf(":");
    if (sep4 === -1) continue;
    const field = line.slice(0, sep4).trim().toLowerCase();
    const value = line.slice(sep4 + 1).trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!inHeader) current2 = [];
      const token = value === "*" ? "*" : productToken(value);
      if (token) current2.push(token);
      inHeader = true;
      for (const g of current2) if (!groups.has(g)) groups.set(g, []);
      continue;
    }
    inHeader = false;
    if (!current2.length) continue;
    if (field === "allow" || field === "disallow") {
      for (const g of current2) groups.get(g).push({ allow: field === "allow", path: value });
    } else if (field === "crawl-delay") {
      const n = value === "" ? Number.NaN : Number(value);
      if (Number.isFinite(n) && n >= 0) for (const g of current2) delays.set(g, n * 1e3);
    }
  }
  const chosen = groups.has(ua) ? ua : groups.has("*") ? "*" : void 0;
  if (chosen === void 0) return { rules: [], sitemaps, absent: false };
  const rules = [...groups.get(chosen)].sort((a, b) => matcherOf(b).length - matcherOf(a).length || (a.allow === b.allow ? 0 : a.allow ? -1 : 1));
  const crawlDelayMs = delays.get(chosen);
  return { rules, sitemaps, absent: false, ...crawlDelayMs !== void 0 ? { crawlDelayMs } : {} };
}
var UNRESERVED = /^[A-Za-z0-9\-._~]$/;
var HEX2 = /^[0-9A-Fa-f]{2}$/;
function normalisePath(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "%" && HEX2.test(s.slice(i + 1, i + 3))) {
      const hex = s.slice(i + 1, i + 3);
      const ch2 = String.fromCharCode(Number.parseInt(hex, 16));
      out += UNRESERVED.test(ch2) ? ch2 : `%${hex.toUpperCase()}`;
      i += 2;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code > 32 && code < 127 && !'"<>`{}|\\^'.includes(c)) {
      out += c;
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    try {
      out += encodeURIComponent(ch);
    } catch {
      out += "%EF%BF%BD";
    }
    i += ch.length - 1;
  }
  return out;
}
var matchers = /* @__PURE__ */ new WeakMap();
function matcherOf(rule) {
  let m = matchers.get(rule);
  if (!m) {
    const pattern = normalisePath(rule.path);
    const anchored = pattern.endsWith("$");
    m = { parts: (anchored ? pattern.slice(0, -1) : pattern).split("*"), anchored, length: pattern.length };
    matchers.set(rule, m);
  }
  return m;
}
function matches(m, path) {
  const { parts, anchored } = m;
  const first = parts[0];
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return !anchored || path.length === first.length;
  let pos = first.length;
  const last = parts.length - 1;
  for (let i = 1; i < last; i++) {
    const at = path.indexOf(parts[i], pos);
    if (at < 0) return false;
    pos = at + parts[i].length;
  }
  const tail = parts[last];
  return anchored ? path.length - tail.length >= pos && path.endsWith(tail) : path.indexOf(tail, pos) >= 0;
}
function isAllowed(robots, url) {
  if (!robots.rules.length) return true;
  let path;
  try {
    const u = new URL(url);
    path = normalisePath(u.pathname + u.search);
  } catch {
    return true;
  }
  for (const rule of robots.rules) {
    if (rule.path !== "" && matches(matcherOf(rule), path)) return rule.allow;
  }
  return true;
}
var ROBOTS_TTL_MS = 24 * 60 * 60 * 1e3;
var UNREACHABLE_TTL_MS = 5 * 60 * 1e3;
var cache = /* @__PURE__ */ new Map();
var guardedCaches = /* @__PURE__ */ new WeakMap();
async function readRobots(origin, authorize) {
  let refused = false;
  const authorizeUrl = async (u) => {
    const ok = authorize ? await authorize(u) : true;
    if (!ok) refused = true;
    return ok;
  };
  const r = await httpGet(`${origin}/robots.txt`, { accept: "text/plain", timeoutMs: 5e3, maxBytes: 512 * 1024, authorizeUrl });
  if (r.ok) {
    const body = r.truncated ? r.body.slice(0, Math.max(r.body.lastIndexOf("\n"), r.body.lastIndexOf("\r")) + 1) : r.body;
    if (!body.trim()) return { ...EMPTY, status: r.status };
    return { ...parseRobots(body, env("ROBOTS_UA") ?? brand().name), status: r.status };
  }
  if (!refused && !r.redirectFailed && (r.status === 0 || r.status === 429 || r.status >= 500)) {
    return { rules: [{ allow: false, path: "/" }], sitemaps: [], absent: false, status: r.status, unreachable: true };
  }
  return { ...EMPTY, status: r.status };
}
async function fetchRobots(url, opts = {}) {
  if (envFlag("NO_ROBOTS")) return EMPTY;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return EMPTY;
  }
  let scopedCache = cache;
  if (opts.authorizeUrl) {
    const existing = guardedCaches.get(opts.authorizeUrl);
    scopedCache = existing ?? /* @__PURE__ */ new Map();
    if (!existing) guardedCaches.set(opts.authorizeUrl, scopedCache);
  }
  const hit = scopedCache.get(origin);
  if (hit && hit.expires > Date.now()) return hit.robots;
  const entry = { robots: readRobots(origin, opts.authorizeUrl), expires: Number.POSITIVE_INFINITY };
  scopedCache.set(origin, entry);
  const robots = await entry.robots;
  entry.expires = Date.now() + (robots.unreachable ? UNREACHABLE_TTL_MS : ROBOTS_TTL_MS);
  return robots;
}

// src/crawl.ts
init_url();
var nextFree = /* @__PURE__ */ new Map();
var holdUntil = /* @__PURE__ */ new Map();
var MAX_TIMER_MS = 2 ** 31 - 1;
async function sleepFor(ms, signal) {
  for (let left = ms; left > 0 && !signal?.aborted; left -= MAX_TIMER_MS) await sleep(Math.min(left, MAX_TIMER_MS), signal);
}
function hostDelayMs() {
  return envInt("POLITE_DELAY_MS", 400, 0, 5e3);
}
function maxCrawlDelayMs() {
  return envInt("MAX_CRAWL_DELAY_MS", 6e4, 0, MAX_TIMER_MS);
}
function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
async function awaitHostSlot(url, delayMs = hostDelayMs(), now = Date.now(), signal) {
  const host = hostOf(url);
  if (!host) return 0;
  const spaced = delayMs > 0;
  let waited = 0;
  let t = now;
  for (; ; ) {
    const hold = holdUntil.get(host) ?? 0;
    const free = spaced ? Math.max(nextFree.get(host) ?? 0, hold) : hold;
    const wait = Math.max(0, free - t);
    if (spaced) nextFree.set(host, Math.max(free, t) + delayMs);
    if (wait === 0 || signal?.aborted) return waited;
    const started = Date.now();
    await sleepFor(wait, signal);
    if (signal?.aborted) return waited + Math.min(wait, Math.max(0, Date.now() - started));
    waited += wait;
    t = Date.now();
    if ((holdUntil.get(host) ?? 0) <= t) return waited;
  }
}
function backOffHost(url, ms, now = Date.now()) {
  const host = hostOf(url);
  if (!host || !(ms > 0)) return;
  holdUntil.set(host, Math.max(holdUntil.get(host) ?? 0, now + ms));
}
var LINK_TAG_RE = /<(a|area)(?=[\s/>])[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/gi;
var INERT_ELEMENTS = ["script", "style", "template"];
function linksFrom(html, baseUrl) {
  const base2 = documentBaseUrl(html, baseUrl) ?? baseUrl;
  const hrefs = [];
  for (const m of dropElements(html, INERT_ELEMENTS, RAW_TEXT_ELEMENTS).matchAll(LINK_TAG_RE)) {
    const href = htmlAttributes(m[0]).get("href");
    if (href !== void 0) hrefs.push(decodeEntities(href).trim());
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of hrefs) {
    if (!raw || raw.startsWith("#")) continue;
    if (/^(mailto|tel|javascript|data):/i.test(raw)) continue;
    try {
      const abs = new URL(raw, base2);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      abs.hash = "";
      const canon = canonicalizeUrl(abs.href);
      if (!seen.has(canon)) {
        seen.add(canon);
        out.push(abs.href);
      }
    } catch {
    }
  }
  return out;
}
function sameOrigin(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host === y.host;
  } catch {
    return false;
  }
}
function sameSite(url, origin) {
  try {
    const a = new URL(url);
    const b = new URL(origin);
    const bare = (host) => host.replace(/^www\./, "");
    const scheme = a.protocol === b.protocol || b.protocol === "http:" && a.protocol === "https:";
    return scheme && a.port === b.port && bare(a.hostname) === bare(b.hostname);
  } catch {
    return false;
  }
}
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return void 0;
  }
}
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
function sectionOf(url) {
  const path = pathOf(url) || "/";
  const cut = path.lastIndexOf("/");
  const last = path.slice(cut + 1);
  return last && !last.includes(".") ? `${path}/` : path.slice(0, cut + 1);
}
var NOT_A_PAGE_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|heic|mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|m4v|mov|avi|wmv|mkv|webm|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|tar|dmg|iso|exe|msi|apk|deb|rpm)$/i;
function crawlConcurrency() {
  return envInt("CRAWL_CONCURRENCY", 4, 1, 16);
}
function whole(n, fallback, min) {
  return typeof n === "number" && !Number.isNaN(n) ? Math.max(min, Math.floor(n)) : fallback;
}
var seconds2 = (ms) => `${ms / 1e3} s`;
async function crawlSite(seed, opts = {}) {
  const maxPages = whole(opts.maxPages, 20, 1);
  const maxDepth = whole(opts.maxDepth, 2, 0);
  const maxRequests = whole(opts.maxRequests, maxPages * 3, 1);
  const delayOverride = opts.delayMs !== void 0 && Number.isFinite(opts.delayMs) ? Math.max(0, opts.delayMs) : void 0;
  const prefix = opts.prefix ? pathOf(`http://x${opts.prefix.startsWith("/") ? "" : "/"}${opts.prefix}`) || void 0 : void 0;
  const width = crawlConcurrency();
  const notes = [];
  const disallowed = [];
  const refused = /* @__PURE__ */ new Set();
  const disallow = (url) => {
    if (refused.has(url)) return;
    refused.add(url);
    disallowed.push(url);
  };
  const pages = [];
  const seedOrigin = originOf(seed);
  if (!seedOrigin) return { pages, pending: [], disallowed, notes: [`${seed} is not a URL.`] };
  let origin = seedOrigin;
  let section = sectionOf(seed);
  const inScope = (url) => opts.crossOrigin === true || sameOrigin(url, origin);
  const permitted = async (url) => {
    if (!opts.authorizeUrl || await opts.authorizeUrl(url)) return true;
    notes.push(`${url}: refused by the caller's policy.`);
    return false;
  };
  const NONE = { rules: [], sitemaps: [], absent: true };
  const robotsPolicy = /* @__PURE__ */ new Map();
  const robotsFor = (url) => {
    if (opts.ignoreRobots) return Promise.resolve(NONE);
    const home = originOf(url) ?? "";
    let authorize = robotsPolicy.get(home);
    if (!authorize) {
      authorize = async (target) => {
        if (!await permitted(target)) return false;
        if (sameSite(target, home) || inScope(target)) return true;
        notes.push(`${target}: destination is outside the crawl origin.`);
        return false;
      };
      robotsPolicy.set(home, authorize);
    }
    return fetchRobots(url, { authorizeUrl: authorize });
  };
  const ceiling = maxCrawlDelayMs();
  const tooSlow = /* @__PURE__ */ new Set();
  const refusesDelay = (url, r) => {
    if (delayOverride !== void 0 || r.crawlDelayMs === void 0 || r.crawlDelayMs <= ceiling) return false;
    const home = originOf(url) ?? url;
    if (!tooSlow.has(home)) {
      tooSlow.add(home);
      notes.push(
        `${home} asks for a Crawl-delay of ${seconds2(r.crawlDelayMs)} between requests \u2014 over the ${seconds2(ceiling)} this crawl will wait (${envName("MAX_CRAWL_DELAY_MS")}), so none of its pages were fetched.`
      );
    }
    return true;
  };
  const delayFor = (r) => delayOverride ?? r.crawlDelayMs ?? hostDelayMs();
  const unreachable = (home, r) => `robots.txt at ${home} ${r.status ? `answered HTTP ${r.status}` : "did not answer"} \u2014 RFC 9309 says to assume nothing may be crawled, so nothing was.`;
  const robots = await robotsFor(seed);
  if (!opts.ignoreRobots && robots.unreachable) return { pages, pending: [seed], disallowed, notes: [...notes, unreachable(seedOrigin, robots)] };
  if (refusesDelay(seed, robots)) return { pages, pending: [seed], disallowed, notes };
  const authorizeHop = async (url, seedHop) => {
    if (opts.signal?.aborted) return false;
    if (!await permitted(url)) return false;
    if (!seedHop && !inScope(url)) {
      notes.push(`${url}: destination is outside the crawl origin.`);
      return false;
    }
    const r = await robotsFor(url);
    if (!opts.ignoreRobots && !isAllowed(r, url)) {
      disallow(url);
      return false;
    }
    if (refusesDelay(url, r)) return false;
    await awaitHostSlot(url, delayFor(r), Date.now(), opts.signal);
    return !opts.signal?.aborted;
  };
  const authorizeUrl = (url) => authorizeHop(url, false);
  const authorizeSeed = (url) => authorizeHop(url, true);
  let settleSeed;
  const seedSettled = new Promise((resolve12) => {
    settleSeed = resolve12;
  });
  const authorizeSitemap = async (url) => {
    if (!sameOrigin(url, seedOrigin)) await seedSettled;
    return authorizeUrl(url);
  };
  let rerooted = false;
  const settle2 = (got) => {
    if (got.status > 0) {
      if (section !== "/") section = sectionOf(got.finalUrl);
      const moved = originOf(got.finalUrl);
      if (moved && moved !== origin) {
        origin = moved;
        rerooted = true;
        notes.push(`the seed redirected to ${got.finalUrl}${opts.crossOrigin ? "" : `, so the walk stays on ${moved}`}.`);
      }
    }
    settleSeed();
  };
  const seen = /* @__PURE__ */ new Set([canonicalizeUrl(seed)]);
  const read3 = /* @__PURE__ */ new Set();
  let skippedFiles = 0;
  const admit = (url, depth, into) => {
    const canon = canonicalizeUrl(url);
    if (seen.has(canon)) return false;
    if (!inScope(url)) return false;
    const path = pathOf(url);
    if (prefix && !path.startsWith(prefix)) return false;
    seen.add(canon);
    if (NOT_A_PAGE_RE.test(path)) {
      skippedFiles++;
      return false;
    }
    into.push({ url, depth });
    return true;
  };
  const wantSitemap = opts.useSitemap !== false && maxDepth > 0 && maxPages > 1;
  let sitemap = wantSitemap ? fetchSitemap(seed, { sitemaps: robots.sitemaps, authorizeUrl: authorizeSitemap, signal: opts.signal }) : void 0;
  let sitemapAgain = false;
  let requests = 0;
  let failed2 = 0;
  const takeSitemap = async (into) => {
    const sm = await sitemap;
    sitemap = void 0;
    for (const n of sm.notes ?? []) notes.push(n);
    const scope = prefix ?? (section === "/" ? void 0 : section);
    const room = maxRequests - requests;
    let added = 0;
    let outside = 0;
    let beyond = 0;
    for (const entry of sm.urls) {
      if (scope && !pathOf(entry.loc).startsWith(scope)) outside++;
      else if (added >= room) beyond++;
      else if (admit(entry.loc, 1, into)) added++;
    }
    if (added || outside || beyond) {
      notes.push(
        `seeded ${added} URL(s) from the sitemap` + (beyond ? `; ${beyond} more are past this crawl's request ceiling` : "") + (outside ? `; ${outside} outside ${scope} were left out` : "") + "."
      );
    }
    if (!added && rerooted && !sitemapAgain) {
      sitemapAgain = true;
      const home = origin;
      sitemap = robotsFor(home).then((r) => fetchSitemap(home, { sitemaps: r.sitemaps, authorizeUrl, signal: opts.signal }));
    }
  };
  const seedItem = { url: seed, depth: 0 };
  const fetchOne = async (item) => {
    const isSeed = item === seedItem;
    const got = await fetchAndExtract(item.url, {
      keepHtml: item.depth < maxDepth,
      authorizeUrl: isSeed ? authorizeSeed : authorizeUrl,
      // A short Retry-After is waited out and retried inside httpGet; the rest
      // of this host's queue must wait with it, not go out meanwhile.
      onBackOff: (url, ms) => backOffHost(url, ms),
      signal: opts.signal
    });
    if (got.retryAfterMs) backOffHost(got.finalUrl, Math.min(got.retryAfterMs, 6e4));
    if (isSeed) settle2(got);
    if (!got.text && opts.signal?.aborted) return { cancelled: true };
    if (!got.text) return { note: `${item.url}: ${got.note ?? "nothing readable"}` };
    return {
      page: {
        url: got.finalUrl,
        depth: item.depth,
        ...got.title ? { title: got.title } : {},
        text: got.text,
        extractor: got.extractor ?? "native",
        links: got.html ? linksFrom(got.html, got.finalUrl) : []
      }
    };
  };
  let wave = [seedItem];
  for (; ; ) {
    if (!wave.length && sitemap) await takeSitemap(wave);
    if (!wave.length || pages.length >= maxPages || requests >= maxRequests) break;
    if (opts.signal?.aborted) {
      notes.push(`cancelled after ${requests} page request(s).`);
      break;
    }
    const room = Math.min(maxPages - pages.length, maxRequests - requests);
    const batch = [];
    let cursor = 0;
    while (cursor < wave.length && batch.length < room) {
      const slice = wave.slice(cursor, cursor + (room - batch.length));
      const files = await Promise.all(slice.map((it) => robotsFor(it.url)));
      slice.forEach((item, i) => {
        if (!opts.ignoreRobots && !isAllowed(files[i], item.url)) disallow(item.url);
        else batch.push(item);
      });
      cursor += slice.length;
    }
    requests += batch.length;
    const leftover = wave.slice(cursor);
    const settled = new Array(batch.length);
    let streamed = 0;
    const streamReady = () => {
      while (streamed < settled.length && settled[streamed] !== void 0) {
        const i = streamed++;
        const done = settled[i];
        if (!("page" in done)) continue;
        const canon = canonicalizeUrl(done.page.url);
        if (read3.has(canon)) {
          settled[i] = { note: `${batch[i].url} redirected to ${done.page.url}, already read.`, duplicate: true };
          continue;
        }
        read3.add(canon);
        seen.add(canon);
        opts.onPage?.(done.page);
      }
    };
    await mapLimit(batch, width, async (item, i) => {
      settled[i] = await fetchOne(item);
      streamReady();
    });
    settleSeed();
    const parents = [];
    const unread = [];
    for (const [i, r] of settled.entries()) {
      if ("cancelled" in r) {
        unread.push(batch[i]);
        requests--;
        continue;
      }
      if ("note" in r) {
        notes.push(r.note);
        if (!r.duplicate) failed2++;
        continue;
      }
      pages.push(r.page);
      if (r.page.depth < maxDepth) parents.push(r.page);
    }
    const next = [];
    const rootSeed = section === "/";
    if (sitemap && rootSeed) await takeSitemap(next);
    for (const page of parents) for (const link of page.links) admit(link, page.depth + 1, next);
    if (sitemap && !rootSeed) await takeSitemap(next);
    wave = [...unread, ...leftover, ...next];
  }
  const pending = wave.map((q) => q.url);
  const queued = pending.length ? ` with ${pending.length} URL(s) still queued` : "";
  const budgetStopped = !opts.signal?.aborted;
  if (budgetStopped && pages.length < maxPages && requests >= maxRequests)
    notes.push(`stopped after ${requests} page requests, ${failed2} of them failed \u2014 the ceiling for a ${maxPages}-page budget${queued}.`);
  else if (budgetStopped && pending.length) notes.push(`stopped at the ${maxPages}-page budget${queued}.`);
  if (skippedFiles) notes.push(`skipped ${skippedFiles} link(s) to images, media, fonts or archives without fetching them.`);
  const policy = [];
  if (opts.ignoreRobots) policy.push("robots.txt was not consulted (ignoreRobots) \u2014 only correct on a site you own.");
  else if (envFlag("NO_ROBOTS")) policy.push(`robots.txt was not consulted (${envName("NO_ROBOTS")}) \u2014 only correct on a site you own.`);
  else {
    const home = await robotsFor(origin);
    if (home.unreachable) policy.push(unreachable(origin, home));
    else if (home.absent) policy.push(`no robots.txt${home.status ? ` (HTTP ${home.status})` : ""} \u2014 nothing was refused, but nothing was granted either.`);
    if (home.crawlDelayMs && delayOverride === void 0 && home.crawlDelayMs <= ceiling)
      policy.push(`honouring the declared Crawl-delay of ${home.crawlDelayMs}ms.`);
  }
  return { pages, pending, disallowed, notes: [...policy, ...notes] };
}

// src/cli.ts
init_tables();
init_markdown2();

// src/changed.ts
init_fetch();
import { createHash as createHash3 } from "crypto";
function contentHash(body) {
  return createHash3("sha256").update(body).digest("hex");
}
var FINGERPRINT_MAX_BYTES = 64 * 1024 * 1024;
function read2(url, opts, headers) {
  return httpGet(url, { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes ?? FINGERPRINT_MAX_BYTES, binary: true, ...headers ? { headers } : {} });
}
function observation(url, res) {
  const complete = res.ok && !res.truncated;
  const error = res.status === 304 || complete ? void 0 : !res.ok ? res.error ?? `status ${res.status}` : "response truncated at the byte cap";
  return {
    url,
    ...res.etag ? { etag: res.etag } : {},
    ...res.lastModified ? { lastModified: res.lastModified } : {},
    ...complete ? { contentHash: contentHash(res.bytes ?? Buffer.alloc(0)) } : {},
    bytes: res.bytesRead ?? 0,
    status: res.status,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...error ? { error } : {}
  };
}
async function fingerprint(url, opts = {}) {
  return observation(url, await read2(url, opts));
}
async function hasChanged(url, previous, opts = {}) {
  const headers = {};
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  const res = await read2(url, opts, Object.keys(headers).length ? headers : void 0);
  const observed = observation(url, res);
  if (res.status === 304) {
    const etag = observed.etag ?? previous?.etag;
    const lastModified = observed.lastModified ?? previous?.lastModified;
    const fingerprint2 = {
      ...observed,
      ...etag ? { etag } : {},
      ...lastModified ? { lastModified } : {},
      ...previous?.contentHash ? { contentHash: previous.contentHash } : {},
      status: 304,
      bytes: 0
    };
    return { changed: false, via: "not-modified", fingerprint: fingerprint2 };
  }
  if (!res.ok) {
    return { via: "unknown", fingerprint: observed, note: `could not read ${url}: ${res.error ?? `status ${res.status}`}` };
  }
  if (res.truncated) {
    return { via: "unknown", fingerprint: observed, note: `could not compare ${url}: response truncated at the byte cap.` };
  }
  if (!previous || !previous.etag && !previous.lastModified && !previous.contentHash) {
    return { changed: false, via: "unknown", fingerprint: observed, note: "no previous observation \u2014 this is the baseline." };
  }
  if (previous.contentHash && observed.contentHash) {
    return { changed: previous.contentHash !== observed.contentHash, via: "hash", fingerprint: observed };
  }
  if (previous.etag && observed.etag) return { changed: previous.etag !== observed.etag, via: "etag", fingerprint: observed };
  if (previous.lastModified && observed.lastModified) {
    return { changed: previous.lastModified !== observed.lastModified, via: "last-modified", fingerprint: observed };
  }
  return { via: "unknown", fingerprint: observed, note: "nothing comparable between the two observations \u2014 store contentHash to make this answerable." };
}

// src/skillkit/usage.ts
import { readdirSync as readdirSync7, readFileSync as readFileSync16, statSync as statSync8 } from "fs";
import { dirname as dirname3, join as join20, relative, resolve as resolve4 } from "path";
var DECL = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|enum)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm;
var USES_ENGINE = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']((?:\.{1,2}\/)*(?:engine\.js|vendor\/[^"']+-engine\.mjs))["']/g;
function engineExports(dts) {
  const block = /export\s*\{([\s\S]*?)\}\s*;?\s*$/.exec(dts);
  if (!block) return /* @__PURE__ */ new Set();
  return new Set(
    block[1].split(",").map(
      (s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()
    ).filter((s) => Boolean(s))
  );
}
function walkSources(dir, skip = "vendor", out = []) {
  let entries;
  try {
    entries = readdirSync7(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join20(dir, e);
    if (statSync8(p).isDirectory()) {
      if (e !== skip) walkSources(p, skip, out);
    } else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}
function auditEngineUsage(root, config, dts, engineName) {
  const surface = engineExports(dts);
  const files = walkSources(join20(root, "src"));
  const forks = new Map(Object.entries(config.forks));
  const collisions = [];
  const tolerated = [];
  const imported = /* @__PURE__ */ new Set();
  for (const file of files) {
    const src = readFileSync16(file, "utf8");
    const rel = relative(root, file);
    for (const m of src.matchAll(DECL)) {
      const name2 = m[1] ?? m[2];
      if (!name2 || !surface.has(name2)) continue;
      const why = forks.get(`${rel}:${name2}`);
      if (why) tolerated.push({ file: rel, name: name2, why });
      else collisions.push({ file: rel, name: name2 });
    }
    for (const m of src.matchAll(USES_ENGINE)) {
      if (engineName) {
        const spec = m[2] ?? "";
        if (spec.endsWith("-engine.mjs")) {
          if (!spec.endsWith(`/vendor/${engineName}-engine.mjs`) && !spec.endsWith(`vendor/${engineName}-engine.mjs`)) continue;
        } else {
          let shim = "";
          try {
            shim = readFileSync16(resolve4(dirname3(file), spec.replace(/\.js$/, ".ts")), "utf8");
          } catch {
            continue;
          }
          if (!shim.includes(`vendor/${engineName}-engine.mjs`)) continue;
        }
      }
      for (const raw of m[1].split(",")) {
        const name2 = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (name2 && surface.has(name2)) imported.add(name2);
      }
    }
  }
  const seen = new Set(tolerated.map((t) => `${t.file}:${t.name}`));
  const stale = [...forks.keys()].filter((k) => !seen.has(k));
  return { collisions, tolerated, stale, imported: [...imported], surface: surface.size };
}

// src/skillkit/bundle.ts
init_cli_kit();
import { existsSync as existsSync10, readdirSync as readdirSync8, readFileSync as readFileSync17 } from "fs";
import { join as join21 } from "path";
var DESC_MAX = 1e3;
function auditSkillBundle(root, config, cli) {
  const out = [];
  const check = (ok, message) => out.push({ ok, message });
  const name2 = config.name;
  const skillDir = join21(root, "skills", name2);
  check(
    !existsSync10(join21(root, "SKILL.md")),
    existsSync10(join21(root, "SKILL.md")) ? `a SKILL.md exists at the repo ROOT \u2014 \`skills add\` would install it alone, dropping the engine. Move it to skills/${name2}/SKILL.md` : "no root SKILL.md"
  );
  const skillMd = join21(skillDir, "SKILL.md");
  if (!existsSync10(skillMd)) {
    check(false, `missing skills/${name2}/SKILL.md \u2014 the skill package has no SKILL.md`);
    return out;
  }
  const raw = readFileSync17(skillMd, "utf8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!fm) {
    check(false, `skills/${name2}/SKILL.md has no frontmatter block`);
    return out;
  }
  check(true, "packaged SKILL.md present with frontmatter");
  const front = fm[1];
  const declared = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  check(
    declared === name2,
    declared === name2 ? `frontmatter name "${name2}" matches the config` : `frontmatter name "${declared ?? ""}" != skill.json name "${name2}"`
  );
  const desc = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim();
  if (!desc) {
    check(false, "frontmatter has no description");
  } else {
    const len = desc.replace(/^["']|["']$/g, "").length;
    check(
      len <= DESC_MAX,
      len <= DESC_MAX ? `description ${len} chars (<= ${DESC_MAX})` : `description ${len} chars exceeds the ${DESC_MAX}-char headroom cap`
    );
  }
  const refsDir = join21(skillDir, "references");
  if (existsSync10(refsDir)) {
    const files = readdirSync8(refsDir).filter((f) => f.endsWith(".md"));
    for (const m of new Set(raw.match(/references\/[\w.-]+\.md/g) ?? [])) {
      check(
        existsSync10(join21(skillDir, m)),
        existsSync10(join21(skillDir, m)) ? `mentioned ${m} exists` : `${m} is mentioned in SKILL.md but missing from the package`
      );
    }
    for (const f of files) {
      check(
        raw.includes(`references/${f}`),
        raw.includes(`references/${f}`) ? `references/${f} is linked` : `references/${f} exists but SKILL.md never mentions it`
      );
    }
  }
  const bundleRel = `scripts/${name2}.mjs`;
  const rootBundle = join21(root, bundleRel);
  const pkgBundle = join21(skillDir, bundleRel);
  if (!existsSync10(rootBundle)) check(false, `missing ${bundleRel} at the repo root \u2014 run the build`);
  else if (!existsSync10(pkgBundle)) check(false, `missing skills/${name2}/${bundleRel} \u2014 run \`skill copy\``);
  else {
    const same = readFileSync17(rootBundle).equals(readFileSync17(pkgBundle));
    check(
      same,
      same ? `embedded engine is byte-identical to ${bundleRel}` : `skills/${name2}/${bundleRel} differs from ${bundleRel} \u2014 run \`skill copy\` and commit`
    );
  }
  if (!cli) return out;
  const universe = /* @__PURE__ */ new Set([...cli.valueFlags, ...cli.boolFlags, "help", "version", ...config.allowedForeignFlags]);
  const docs = [["SKILL.md", raw]];
  if (existsSync10(refsDir)) {
    for (const f of readdirSync8(refsDir).filter((f2) => f2.endsWith(".md"))) docs.push([`references/${f}`, readFileSync17(join21(refsDir, f), "utf8")]);
  }
  let unknown = 0;
  for (const [file, text] of docs) {
    for (const flag of documentedFlags(text)) {
      if (universe.has(flag)) continue;
      check(false, `${file} documents unknown flag --${flag} (add it to allowedForeignFlags only if it belongs to another tool)`);
      unknown++;
    }
  }
  if (!unknown) check(true, `every --flag documented across ${docs.length} skill file(s) exists in the CLI`);
  const missing = [...cli.valueFlags, ...cli.boolFlags].filter((f) => !helpCoversFlag(cli.help, f));
  check(missing.length === 0, missing.length === 0 ? "--help covers the whole flag surface" : `--help omits: ${missing.map((f) => `--${f}`).join(", ")}`);
  for (const cmd of cli.commands ?? []) {
    const named = new RegExp(`(^|[^\\w-])${cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`, "m").test(cli.help);
    check(named, named ? `--help names \`${cmd}\`` : `--help never names the \`${cmd}\` command`);
  }
  return out;
}

// src/skillkit/scaffold.ts
init_no_write();
import { join as join22 } from "path";
var enginesJson = (engine, repo, minRef) => JSON.stringify(
  {
    _comment: "The packaging contract for this skill, read by `skill vendor|check|bundle`. `forks` is a ratchet: entries may leave, never arrive \u2014 so the next declaration shadowing an engine export is an argued decision rather than a quiet copy. `usageFloor` goes up when a layer lands and never down to make a red run pass.",
    name: engine,
    engines: { webindex: { repo, minRef, meta: "webindex.meta.json" } },
    usageFloor: 0,
    forks: {},
    allowedForeignFlags: []
  },
  null,
  2
);
var engineShim = (name2, prefix) => `// The vendored engine, configured for this skill.
//
// Everything in src/ reaches the engine through THIS module, never through
// src/vendor/ directly. That is the whole point: you cannot obtain an engine
// function without first importing the module that configures it, so there is
// no ordering hazard to remember and no entry point that can forget \u2014 a new CLI
// command, a new MCP handler and a test all get a configured engine for free.
//
// The engine reads \`${prefix}_*\` at CALL time, so every variable a user has
// already exported keeps working. \`cli\` names this tool inside engine-emitted
// notes, and \`contactUrl\` goes into the polite User-Agent rate-limited APIs
// see \u2014 it must identify ${name2}, not the shared engine underneath.
import { configure } from "./vendor/webindex-engine.mjs";

configure({
  name: "${name2}",
  envPrefix: "${prefix}",
  cli: "${name2}",
  contactUrl: "https://github.com/maxgfr/${name2}",
});

export * from "./vendor/webindex-engine.mjs";
`;
var ci = () => `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm run lint
      - run: pnpm test

  # The packaging gates. Each one has caught a real defect in a sibling skill:
  # a pin nine releases stale, a re-forked engine layer running beside the
  # vendored one, and a SKILL.md at the repo root that would have installed
  # alone without its engine.
  #
  # The CLI is this repo's @maxgfr/webindex devDependency \u2014 the GitHub release
  # archive \`webindex skill repin\` keeps current \u2014 run with \`pnpm exec\`, which
  # fails when it is missing. Never \`npx webindex\`: that name on npm is
  # somebody else's package, and npx would download and run it.
  packaging:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm exec webindex skill check
      - run: pnpm exec webindex skill bundle
      - run: pnpm exec webindex skill vendor --check
`;
var gitignore = `node_modules/
coverage/
*.tsbuildinfo
`;
function skillNameProblem(name2) {
  return /^[a-z][a-z0-9-]*$/.test(name2) ? void 0 : `"${name2}" is not a usable skill name \u2014 lower-case letters, digits and hyphens, starting with a letter.`;
}
function scaffoldSkill(root, name2, opts = {}) {
  const errors = [];
  const badName = skillNameProblem(name2);
  if (badName) return { written: [], errors: [badName] };
  const prefix = name2.toUpperCase().replace(/-/g, "_");
  const files = {
    // A skill started now is written against the engine release doing the
    // scaffolding; any older floor lets the staleness gate pass a pin that old.
    [SKILL_CONFIG]: `${enginesJson(name2, opts.engineRepo ?? "maxgfr/webindex", opts.minRef ?? `v${ENGINE_VERSION}`)}
`,
    [join22("src", "engine.ts")]: engineShim(name2, prefix),
    [join22("skills", name2, "SKILL.md")]: `---
name: ${name2}
description: TODO \u2014 one sentence saying WHEN to use this skill, under 1000 characters.
---

# ${name2}

TODO
`,
    [join22(".github", "workflows", "ci.yml")]: ci(),
    ".gitignore": gitignore
  };
  const written = [];
  const exists = opts.exists;
  for (const [rel, content] of Object.entries(files)) {
    const path = join22(root, rel);
    if (exists?.(path)) {
      errors.push(`${rel} already exists \u2014 left alone.`);
      continue;
    }
    ensureDir(join22(path, ".."));
    written.push(writeArtifact(path, content));
  }
  return { written, errors };
}

// src/engines.ts
init_brand();
init_fetch();
init_locale();
init_url();
var KEYLESS_ENGINES = ["ddg", "ddglite", "mojeek"];
function isKeylessEngine(v) {
  return KEYLESS_ENGINES.includes(v);
}
function keylessEngines(opts = {}) {
  if (opts.engines) return opts.engines;
  const raw = env("ENGINES");
  if (raw === void 0) return KEYLESS_ENGINES;
  if (raw.toLowerCase() === "off") return [];
  return engineNames(raw).filter(isKeylessEngine);
}
function unknownEngines(opts = {}) {
  const raw = opts.engines ? void 0 : env("ENGINES");
  if (raw === void 0 || raw.toLowerCase() === "off") return [];
  return engineNames(raw).filter((s) => !isKeylessEngine(s));
}
function engineNames(raw) {
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
var INLINE_TAG = /<\/?(?:a|abbr|b|bdi|bdo|cite|code|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)\b[^<>]*>/gi;
function stripTags(s) {
  return decodeEntities(s.replace(INLINE_TAG, "").replace(/<[^<>]*>/g, " ")).replace(/\s+/g, " ").trim();
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
function throttleReason(status, error) {
  if (status === 429 || status === 503) return { throttled: true, why: `rate-limited (HTTP ${status})` };
  if (status === 403) return { throttled: true, why: "blocked this client as automated traffic (HTTP 403)" };
  if (status === 0) return { throttled: false, why: `unreachable (${error || "no response"})` };
  return { throttled: false, why: `unreachable (status ${status})` };
}
function looksLikeChallenge(body) {
  if (body.length > 4e4) return false;
  const head = body.slice(0, 4e3).toLowerCase();
  return /<title>[^<]*captcha/.test(head) || head.includes("anomaly-modal") || head.includes("/anomaly.js") || head.includes("captcha-wrap") || head.includes("sending automated queries");
}
var attrPattern = (name2) => new RegExp(`(?:^|\\s)${name2}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>=\`]+))`, "i");
var HREF_ATTR = attrPattern("href");
var CLASS_ATTR = attrPattern("class");
var NAME_ATTR = attrPattern("name");
var TYPE_ATTR = attrPattern("type");
var VALUE_ATTR = attrPattern("value");
function attr2(attrs, re) {
  const m = re.exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : void 0;
}
function hasClass(attrs, cls) {
  return (attr2(attrs, CLASS_ATTR) ?? "").split(/\s+/).includes(cls);
}
function hostIs(url, domain) {
  try {
    const host = new URL(url).hostname;
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}
var OPEN_A = /<a\b([^<>]*)>/gi;
var element = (tag, cls) => ({ open: new RegExp(`<${tag}\\b([^<>]*)>`, "gi"), close: new RegExp(`</${tag}\\s*>`, "i"), cls });
function parseBlocks(body, limit, shape) {
  const anchors = [];
  for (const m of body.matchAll(OPEN_A)) {
    if (hasClass(m[1], shape.anchor)) anchors.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] });
  }
  const found = [];
  for (let i = 0; i < anchors.length && found.length < limit; i++) {
    const a = anchors[i];
    const block = body.slice(a.end, anchors[i + 1]?.start ?? body.length);
    const close = /<\/a\s*>/i.exec(block);
    const href = attr2(a.attrs, HREF_ATTR);
    if (!close || !href) continue;
    const url = shape.resolve(href);
    if (!url) continue;
    const rest = block.slice(close.index + close[0].length);
    found.push({ url, title: stripTags(block.slice(0, close.index)) || url, snippet: elementText(rest, shape.snippet) });
  }
  return found;
}
function elementText(html, el) {
  for (const m of html.matchAll(el.open)) {
    if (!hasClass(m[1], el.cls)) continue;
    const inner = html.slice(m.index + m[0].length);
    const end = el.close.exec(inner);
    return end ? stripTags(inner.slice(0, end.index)) : "";
  }
  return "";
}
function ddgDestination(href) {
  const url = ddgRedirectTarget(href);
  if (!/^https?:\/\//i.test(url)) return void 0;
  const unwrapped = url !== (href.startsWith("//") ? `https:${href}` : href);
  return unwrapped || !hostIs(url, "duckduckgo.com") ? url : void 0;
}
function parseDdgHtml(body, limit = 50) {
  return parseBlocks(body, limit, { anchor: "result__a", snippet: element("a", "result__snippet"), resolve: ddgDestination });
}
function parseDdgLite(body, limit = 50) {
  return parseBlocks(body, limit, { anchor: "result-link", snippet: element("td", "result-snippet"), resolve: ddgDestination });
}
function parseMojeek(body, limit = 50) {
  return parseBlocks(body, limit, {
    anchor: "title",
    snippet: element("p", "s"),
    // Mojeek links its results directly, so its own links are the ones on its
    // own host. Its blog, or a page ABOUT Mojeek, is a result like any other.
    resolve: (h) => {
      const url = h.startsWith("//") ? `https:${h}` : h;
      return /^https?:\/\//i.test(url) && !/^https?:\/\/(?:www\.)?mojeek\.com(?:[:/?#]|$)/i.test(url) ? url : void 0;
    }
  });
}
var OPEN_FORM = /<form\b[^<>]*>/gi;
var INPUT = /<input\b([^<>]*)>/gi;
function ddgNextForm(body) {
  const forms = [...body.matchAll(OPEN_FORM)];
  for (let i = 0; i < forms.length; i++) {
    const chunk = body.slice(forms[i].index + forms[i][0].length, forms[i + 1]?.index ?? body.length);
    const end = chunk.search(/<\/form\s*>/i);
    const fields = {};
    let next = false;
    for (const m of (end < 0 ? chunk : chunk.slice(0, end)).matchAll(INPUT)) {
      const value = attr2(m[1], VALUE_ATTR) ?? "";
      if (attr2(m[1], TYPE_ATTR)?.toLowerCase() === "submit") next ||= /^\s*next\b/i.test(value);
      else {
        const name2 = attr2(m[1], NAME_ATTR);
        if (name2) fields[name2] = value;
      }
    }
    if (next) return fields;
  }
  return void 0;
}
function ddgNext(endpoint) {
  return (body, q, kl, p) => {
    const form = ddgNextForm(body);
    if (!form) return null;
    return `${endpoint}?${new URLSearchParams({ ...form, q, kl, s: form.s || String((p + 1) * 10) })}`;
  };
}
function mojeekLocaleParams(locale) {
  if (!locale) return "";
  const lang = `&lb=${encodeURIComponent(locale.lang)}&lbb=100`;
  return locale.region === "WT" ? lang : `${lang}&rb=${encodeURIComponent(locale.region)}&rbb=10`;
}
var SPECS = {
  // Page one only: every later page is the one the previous page's own Next
  // form names (see ddgNextForm).
  ddg: {
    label: "DuckDuckGo",
    url: (q, _p, kl) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}`,
    parse: parseDdgHtml,
    next: ddgNext("https://html.duckduckgo.com/html/")
  },
  ddglite: {
    label: "DuckDuckGo Lite",
    url: (q, _p, kl) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}`,
    parse: parseDdgLite,
    next: ddgNext("https://lite.duckduckgo.com/lite/")
  },
  // Mojeek's `s` is the 1-BASED index of the first result, 10 per page — so
  // page 2 starts at 11, not 10. Its own crawler and index, which is why it is
  // worth asking at all: it surfaces pages the DDG family does not have.
  mojeek: {
    label: "Mojeek",
    url: (q, p, _kl, locale) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}${p > 0 ? `&s=${p * 10 + 1}` : ""}${mojeekLocaleParams(locale)}`,
    parse: parseMojeek
  }
};
function spentSlackMs(budgetMs) {
  return budgetMs === void 0 ? 0 : Math.min(25, budgetMs / 4);
}
async function searchViaKeyless(engine, query, opts = {}) {
  const spec = SPECS[engine];
  const q = query.trim();
  if (!q) return { hits: [], note: "Empty query." };
  const pages = Math.max(1, opts.pages ?? 1);
  const limit = Math.max(1, opts.limit ?? 10);
  const localised = !!(opts.lang || opts.region);
  const kl = localised ? ddgRegion(opts.lang, opts.region) : "wt-wt";
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  const locale = localised ? { lang: baseLang3(opts.lang), region: resolveRegion(opts.lang, opts.region).toUpperCase() } : void 0;
  const seen = /* @__PURE__ */ new Set();
  const hits = [];
  const deadline = opts.budgetMs === void 0 ? Number.POSITIVE_INFINITY : Date.now() + opts.budgetMs;
  let url = spec.url(q, 0, kl, locale);
  for (let p = 0; p < pages && hits.length < limit; p++) {
    if (opts.signal?.aborted || Date.now() >= deadline - spentSlackMs(opts.budgetMs)) {
      if (p > 0) break;
      return { hits: [], note: `${spec.label} was not asked: ${opts.signal?.aborted ? "the search was cancelled" : "no time was left"}.`, stopped: true };
    }
    const r = await httpGet(url, {
      accept: "text/html",
      acceptLanguage,
      timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? 12e3, deadline - Date.now())),
      retries: 0,
      signal: opts.signal
    });
    if (!r.ok || !r.body.trim()) {
      if (p > 0) break;
      if (!r.status && r.error === "cancelled") return { hits: [], note: `${spec.label} did not get to answer: the search was cancelled.`, stopped: true };
      if (r.ok) return { hits: [], note: `${spec.label} returned an empty page (HTTP ${r.status}).`, status: r.status };
      const { throttled, why } = throttleReason(r.status, r.error);
      return { hits: [], note: `${spec.label} ${why}.`, throttled, ...r.status === 403 ? { blocked: true } : {}, status: r.status };
    }
    const before = hits.length;
    const parsed = spec.parse(r.body, limit * 2);
    if (parsed.length === 0 && looksLikeChallenge(r.body)) {
      if (p > 0) break;
      return {
        hits: [],
        note: `${spec.label} served an anti-bot challenge (HTTP ${r.status}) instead of results \u2014 blocked, not empty.`,
        throttled: true,
        blocked: true,
        status: r.status
      };
    }
    for (const f of parsed) {
      const key = canonicalizeUrl(f.url);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(f);
      if (hits.length >= limit) break;
    }
    if (hits.length === before || p + 1 >= pages || hits.length >= limit) break;
    const next = spec.next ? spec.next(r.body, q, kl, p) : spec.url(q, p + 1, kl, locale);
    if (!next) break;
    url = next;
    const pause = pageDelayMs();
    if (opts.signal?.aborted || Date.now() + pause >= deadline - spentSlackMs(opts.budgetMs)) break;
    if (pause) await sleep(pause, opts.signal);
  }
  return hits.length ? { hits, answered: true } : { hits: [], note: `${spec.label} returned no results.`, answered: true };
}

// src/search.ts
init_brand();
init_fetch();
init_firecrawl();
init_locale();
init_url();
var SEARXNG_DEFAULT_BASE = "http://localhost:8888";
var PROBE_TIMEOUT_MS5 = 2e3;
var QUERY_TIMEOUT_MS = 8e3;
function searxngBase(opts = {}) {
  const raw = (opts.searxng ?? env("SEARXNG") ?? SEARXNG_DEFAULT_BASE).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/+$/, "");
}
function searxngIsExplicit(opts = {}) {
  return !!(opts.searxng ?? env("SEARXNG"));
}
var probeCache2 = new ProbeMemo();
function probeSearxng(base2, explicit = false) {
  return probeCache2.get(`${base2}|${explicit}`, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS5);
    try {
      const res = await fetch(`${base2}/healthz`, { signal: ctrl.signal });
      const body = await res.text().catch(() => "");
      return explicit || res.ok && /^\s*ok\s*$/i.test(body);
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  });
}
async function searchViaSearxng(query, opts = {}) {
  const base2 = searxngBase(opts);
  if (!base2) return rungResult("searxng", "disabled", [], [`SearXNG disabled (--searxng off / ${envName("SEARXNG")}=off).`]);
  const deadline = budgetDeadline(opts);
  if (!await probeSearxng(base2, searxngIsExplicit(opts))) {
    return rungResult(
      "searxng",
      "unreachable",
      [],
      [
        searxngIsExplicit(opts) ? `SearXNG not reachable at ${base2}.` : `SearXNG not running at ${base2} \u2014 start it with \`${brand().cli} searxng up\` for local, keyless discovery.`
      ]
    );
  }
  const pages = Math.max(1, opts.pages ?? 1);
  const limit = Math.max(1, opts.limit ?? 10);
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  const language = searxngLanguage(opts.lang, opts.region);
  const root = `${base2}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1` + (language ? `&language=${encodeURIComponent(language)}` : "");
  const notes = [];
  const seen = /* @__PURE__ */ new Set();
  const hits = [];
  const suspended = /* @__PURE__ */ new Map();
  let failed2;
  for (let p = 0; p < pages && hits.length < limit; p++) {
    const stop = halted(opts, deadline);
    if (stop) {
      if (p > 0) break;
      return rungResult("searxng", "not-tried", [], [`SearXNG was not asked: ${stop === "cancelled" ? "the search was cancelled" : "no time was left"}.`]);
    }
    const r = await httpGet(root + (p > 0 ? `&pageno=${p + 1}` : ""), {
      accept: "application/json",
      acceptLanguage,
      timeoutMs: Math.max(1, Math.min(QUERY_TIMEOUT_MS, deadline - Date.now())),
      // No retry: the cascade's next rung is the retry.
      retries: 0,
      signal: opts.signal
    });
    if (!r.ok) {
      if (p === 0 && !r.status && r.error === "cancelled") {
        return rungResult("searxng", "not-tried", [], ["SearXNG did not get to answer: the search was cancelled."]);
      }
      if (p === 0) {
        failed2 = r.status === 429 || r.status === 503 ? "throttled" : r.status === 0 ? "unreachable" : "error";
        notes.push(
          failed2 === "throttled" ? `SearXNG rate-limited (HTTP ${r.status}).` : failed2 === "unreachable" ? `SearXNG unreachable (${r.error || "no response"}).` : (
            // SearXNG answers a format it does not serve with flask.abort(403),
            // and the probe has just shown the instance is up: this is the
            // most common misconfiguration, not an outage.
            r.status === 403 ? "SearXNG refused format=json (HTTP 403) \u2014 add `json` to `search.formats` in its settings.yml." : `SearXNG failed the query (HTTP ${r.status}).`
          )
        );
      }
      break;
    }
    let data;
    try {
      data = JSON.parse(r.body);
    } catch {
      if (p === 0) {
        failed2 = "error";
        notes.push("SearXNG returned a non-JSON body \u2014 is `format: json` enabled on that instance?");
      }
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
    if (p < pages - 1) {
      const pause = pageDelayMs();
      if (opts.signal?.aborted || Date.now() + pause >= deadline - spentSlackMs2(opts.timeoutMs)) break;
      if (pause) await sleep(pause, opts.signal);
    }
  }
  if (suspended.size) {
    notes.push(`SearXNG upstreams throttled: ${[...suspended].map(([e, why]) => `${e} (${why})`).join(", ")} \u2014 fewer results than usual, not an empty web.`);
  }
  if (!hits.length && !notes.length) notes.push("SearXNG returned no results.");
  const outcome = hits.length ? "hits" : failed2 ?? (suspended.size ? "throttled" : "empty");
  return rungResult("searxng", outcome, hits, notes);
}
function budgetDeadline(opts) {
  return opts.timeoutMs !== void 0 && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : Number.POSITIVE_INFINITY;
}
function spentSlackMs2(budgetMs) {
  return budgetMs === void 0 ? 0 : Math.min(25, budgetMs / 4);
}
function halted(opts, deadline) {
  if (opts.signal?.aborted) return "cancelled";
  return Date.now() >= deadline - spentSlackMs2(opts.timeoutMs) ? "out of time" : void 0;
}
function rungResult(rung, outcome, hits, notes) {
  return { hits, notes, rungs: [report(rung, outcome, hits.length, notes.join(" "))], searched: answered(outcome) };
}
function report(rung, outcome, hits = 0, note) {
  return { rung, outcome, ...hits ? { hits } : {}, ...note ? { note } : {} };
}
var answered = (outcome) => outcome === "hits" || outcome === "empty";
function keylessOutcome(r) {
  if (r.hits.length) return "hits";
  if (r.stopped) return "not-tried";
  if (r.answered) return "empty";
  if (r.blocked) return "blocked";
  if (r.throttled) return "throttled";
  return r.status ? "error" : "unreachable";
}
async function search(query, opts = {}) {
  const q = query.trim();
  if (!q) return { hits: [], notes: ["Empty query."] };
  const deadline = budgetDeadline(opts);
  const left = () => deadline === Number.POSITIVE_INFINITY ? void 0 : Math.max(1, deadline - Date.now());
  const keyless = keylessEngines(opts);
  const order = ["searxng", ...keyless, "firecrawl"];
  const untried = (rung) => report(rung, rung === "searxng" && !searxngBase(opts) || rung === "firecrawl" && !firecrawlBase(opts) ? "disabled" : "not-tried");
  const notes = [];
  const unknown = unknownEngines(opts);
  if (unknown.length) {
    notes.push(`${envName("ENGINES")} names no engine this knows: ${unknown.join(", ")} (expected ${KEYLESS_ENGINES.join(", ")}) \u2014 ignored.`);
  }
  const rungs = [];
  let hits = [];
  for (let i = 0; i < order.length; i++) {
    const rung = order[i];
    if (hits.length) {
      rungs.push(untried(rung));
      continue;
    }
    const stop = halted(opts, deadline);
    if (stop) {
      const rest = order.slice(i).map(untried);
      const skipped = rest.filter((r) => r.outcome === "not-tried").map((r) => r.rung);
      const why = stop === "cancelled" ? "the search was cancelled" : `the ${opts.timeoutMs} ms budget ran out`;
      if (skipped.length) notes.push(`Stopped before ${skipped.join(", ")}: ${why}.`);
      rungs.push(...rest);
      break;
    }
    if (rung === "searxng") {
      const r = await searchViaSearxng(q, { ...opts, timeoutMs: left() });
      hits = r.hits;
      notes.push(...r.notes);
      rungs.push(...r.rungs ?? []);
    } else if (rung === "firecrawl") {
      const fc = await searchViaFirecrawl(q, limitOf(opts), { firecrawl: opts.firecrawl, lang: opts.lang, region: opts.region, budgetMs: left() });
      hits = firecrawlHits(fc.hits ?? [], limitOf(opts));
      if (fc.why) notes.push(fc.why);
      rungs.push(report("firecrawl", firecrawlOutcome(fc), hits.length, fc.why));
    } else {
      const r = await searchViaKeyless(rung, q, {
        limit: opts.limit,
        pages: opts.pages,
        lang: opts.lang,
        region: opts.region,
        budgetMs: left(),
        signal: opts.signal
      });
      hits = r.hits.map((h) => ({ ...h, via: rung }));
      rungs.push(report(rung, keylessOutcome(r), r.hits.length, r.note));
      if (!r.answered && r.note) notes.push(r.note);
    }
  }
  if (!hits.length) notes.push(closingNote(rungs, opts.signal?.aborted === true));
  return { hits, notes, rungs, searched: rungs.some((r) => answered(r.outcome)) };
}
var limitOf = (opts) => Math.max(1, opts.limit ?? 10);
function firecrawlHits(found, limit) {
  const seen = /* @__PURE__ */ new Set();
  const hits = [];
  for (const h of found) {
    const key = canonicalizeUrl(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ url: h.url, title: h.title, snippet: h.description, via: "firecrawl" });
    if (hits.length >= limit) break;
  }
  return hits;
}
function firecrawlOutcome(fc) {
  if (fc.hits) return fc.hits.length ? "hits" : "empty";
  if (fc.status === void 0) return "disabled";
  if (fc.status === 0) return "unreachable";
  return fc.status === 429 || fc.status === 503 ? "throttled" : "error";
}
function closingNote(rungs, cancelled) {
  const cli = brand().cli;
  if (rungs.every((r) => r.outcome === "disabled")) {
    return `No search backend was enabled \u2014 SearXNG and Firecrawl are off and no keyless engine is selected, so nothing was searched. Set ${envName("ENGINES")} to a list of ${KEYLESS_ENGINES.join(", ")}, or run \`${cli} stack up\`.`;
  }
  if (rungs.some((r) => answered(r.outcome))) return `No results from any engine. \`${cli} stack up\` starts SearXNG and Firecrawl locally.`;
  if (cancelled) return "The search was cancelled before any engine answered \u2014 nothing was searched.";
  const keyless = rungs.filter((r) => isKeylessEngine(r.rung));
  if (keyless.length && keyless.every((r) => r.outcome === "blocked")) {
    return `Every keyless engine blocked this client (${keyless.map((r) => r.rung).join(", ")}) \u2014 nothing was searched, which is not the same as nothing being there. Try again later, or run \`${cli} stack up\` for a local SearXNG.`;
  }
  return `No engine answered (${rungs.filter((r) => r.outcome !== "disabled").map((r) => `${r.rung} ${r.outcome}`).join(", ")}) \u2014 nothing was searched, which is not the same as nothing being there. Try again later, or run \`${cli} stack up\` for a local SearXNG.`;
}

// src/structured.ts
init_entities();
init_fetch();
init_html();
var openTag = (name2) => new RegExp(`<${name2}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "gi");
function parseJsonLd(raw) {
  try {
    return JSON.parse(raw);
  } catch {
  }
  const lenient = raw.replace(/^\s*(?:\/\*\s*<!\[CDATA\[\s*\*\/|\/\/\s*<!\[CDATA\[|<!\[CDATA\[)/, "").replace(/(?:\/\*\s*\]\]>\s*\*\/|\/\/\s*\]\]>|\]\]>)\s*$/, "").replace(/\s+/g, " ").replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(lenient);
  } catch {
    return void 0;
  }
}
var MAX_JSONLD_DEPTH = 32;
function nestsDeeper(v, max) {
  const stack = [[v, 0]];
  while (stack.length) {
    const [x, depth] = stack.pop();
    if (!x || typeof x !== "object") continue;
    if (depth >= max) return true;
    for (const y of Array.isArray(x) ? x : Object.values(x)) if (y && typeof y === "object") stack.push([y, depth + 1]);
  }
  return false;
}
function flattenJsonLd(v, out) {
  if (Array.isArray(v)) for (const x of v) flattenJsonLd(x, out);
  else if (v && typeof v === "object" && Array.isArray(v["@graph"])) {
    for (const x of v["@graph"]) out.push(x);
  } else out.push(v);
}
function extractJsonLd(html) {
  const out = [];
  const open2 = new RegExp(`<!--|${openTag("script").source}`, "gi");
  const close = closeTagRe("script");
  let commentsClose = true;
  let m;
  while (m = open2.exec(html)) {
    if (m[0] === "<!--") {
      const end = commentsClose ? html.indexOf("-->", m.index + 2) : -1;
      if (end < 0) commentsClose = false;
      else open2.lastIndex = end + 3;
      continue;
    }
    close.lastIndex = open2.lastIndex;
    const c = close.exec(html);
    if (!c) break;
    const type = (htmlAttributes(m[0]).get("type") ?? "").split(";")[0].trim().toLowerCase();
    if (type === "application/ld+json") {
      const raw = html.slice(open2.lastIndex, c.index).replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
      const parsed = raw ? parseJsonLd(raw) : void 0;
      if (parsed !== void 0 && !nestsDeeper(parsed, MAX_JSONLD_DEPTH)) flattenJsonLd(parsed, out);
    }
    open2.lastIndex = c.index + c[0].length;
  }
  return out;
}
function metaEntries(html) {
  const out = [];
  for (const m of dropElements(html, ["script", "style", "template"]).matchAll(openTag("meta"))) {
    const attrs = htmlAttributes(m[0]);
    const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop"))?.trim().toLowerCase();
    const content = attrs.has("content") ? decodeEntities(attrs.get("content")).trim() : "";
    if (key && content) out.push([key, content]);
  }
  return out;
}
var isNode = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var CHROME_TYPES = /* @__PURE__ */ new Set([
  "Organization",
  "Corporation",
  "NewsMediaOrganization",
  "WebSite",
  "BreadcrumbList",
  "ListItem",
  "SiteNavigationElement",
  "WPHeader",
  "WPFooter",
  "WPSideBar",
  "WPAdBlock",
  "Person",
  "ImageObject",
  "SearchAction",
  "ContactPoint",
  "PostalAddress"
]);
var PAGE_TYPES = /* @__PURE__ */ new Set([
  "WebPage",
  "ItemPage",
  "AboutPage",
  "CollectionPage",
  "ContactPage",
  "ProfilePage",
  "SearchResultsPage",
  "CheckoutPage",
  "QAPage",
  "FAQPage",
  "MedicalWebPage"
]);
var WORK_TYPES = /* @__PURE__ */ new Set([
  "CreativeWork",
  "Blog",
  "Book",
  "Chapter",
  "Course",
  "Dataset",
  "Game",
  "Guide",
  "HowTo",
  "Legislation",
  "Movie",
  "MusicAlbum",
  "Question",
  "Recipe",
  "Report",
  "SoftwareSourceCode",
  "Thesis",
  "VideoGame",
  "VideoObject",
  "AudioObject"
]);
var WORK_SUFFIX = /(?:Article|Posting|Event|Review|Product|Application|Episode|Series|Recording)$/;
var isWork = (t) => WORK_TYPES.has(t) || WORK_SUFFIX.test(t);
var typesOf = (n) => allStrings(n["@type"]).map((t) => t.slice(Math.max(t.lastIndexOf("/"), t.lastIndexOf(":")) + 1));
function rank(n) {
  const types = typesOf(n);
  if (!types.length) return 1;
  if (types.some(isWork)) return 4;
  if (types.some((t) => !CHROME_TYPES.has(t) && !PAGE_TYPES.has(t))) return 3;
  return types.some((t) => PAGE_TYPES.has(t)) ? 2 : 0;
}
function indexById(nodes) {
  const byId = /* @__PURE__ */ new Map();
  const visit = (v, depth) => {
    if (depth > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (!isNode(v)) return;
    const id = v["@id"];
    if (typeof id === "string" && Object.keys(v).length > 1 && !byId.has(id)) byId.set(id, v);
    for (const x of Object.values(v)) if (typeof x === "object") visit(x, depth + 1);
  };
  visit(nodes, 0);
  return byId;
}
function allStrings(v) {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  return [];
}
function firstString(v) {
  return allStrings(v)[0];
}
function pageMetadata(html, opts = {}) {
  const entries = metaEntries(html);
  const meta = /* @__PURE__ */ new Map();
  for (const [key, content] of entries) if (!meta.has(key)) meta.set(key, content);
  const jsonLd = extractJsonLd(html);
  const out = { authors: [], jsonLd };
  const set = (k, v) => {
    if (v !== void 0 && out[k] === void 0) out[k] = v;
  };
  const authorSeen = /* @__PURE__ */ new Set();
  const addAuthor = (a) => {
    if (out.authors.length >= MAX_AUTHORS || authorSeen.has(a)) return;
    authorSeen.add(a);
    out.authors.push(a);
  };
  const nodes = jsonLd.filter(isNode);
  const byId = indexById(jsonLd);
  const deref = (v) => {
    if (!isNode(v) || typeof v["@id"] !== "string" || "name" in v || "url" in v) return v;
    return byId.get(v["@id"]) ?? v;
  };
  const names = (v) => {
    if (Array.isArray(v)) return v.flatMap(names);
    const d = deref(v);
    return isNode(d) ? allStrings(d.name) : allStrings(d);
  };
  const image = (v) => {
    if (Array.isArray(v)) return v.map(image).find(Boolean);
    const d = deref(v);
    return isNode(d) ? firstString(d.url) ?? firstString(d.contentUrl) : firstString(d);
  };
  let primary;
  for (const n of nodes) if (rank(n) > (primary ? rank(primary) : 0)) primary = n;
  const sources = primary ? [primary, ...nodes.filter((n) => n !== primary && rank(n) === 2)] : [];
  for (const n of sources) {
    set("type", firstString(n["@type"]));
    set("title", firstString(n.headline) ?? names(n.name)[0]);
    set("description", firstString(n.description));
    set("publishedAt", firstString(n.datePublished));
    set("modifiedAt", firstString(n.dateModified));
    set("imageUrl", image(n.image));
    set("siteName", names(n.publisher)[0]);
    if (!out.authors.length) for (const a of names(n.author)) addAuthor(a);
  }
  const nameOfA = (...types) => nodes.filter((n) => typesOf(n).some((t) => types.includes(t))).flatMap((n) => names(n.name))[0];
  set("siteName", nameOfA("WebSite"));
  set("title", meta.get("og:title") ?? meta.get("twitter:title"));
  set("description", meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description"));
  set("type", meta.get("og:type"));
  set("siteName", meta.get("og:site_name"));
  set("siteName", nameOfA("Organization", "NewsMediaOrganization", "Corporation"));
  set("publishedAt", meta.get("article:published_time") ?? meta.get("datepublished") ?? meta.get("citation_publication_date"));
  set("modifiedAt", meta.get("article:modified_time") ?? meta.get("datemodified"));
  set("imageUrl", meta.get("og:image") ?? meta.get("twitter:image"));
  set("canonicalUrl", htmlCanonicalUrl(html) ?? sources.map((n) => firstString(n.url)).find(Boolean));
  const authorKeys = /* @__PURE__ */ new Set(["article:author", "author", "citation_author", "dc.creator"]);
  for (const [key, v] of entries) if (authorKeys.has(key)) addAuthor(v);
  if (!primary || rank(primary) < 4) {
    const read3 = new Set(sources);
    const rest = nodes.filter((n) => !read3.has(n) && rank(n) > 0);
    for (const n of rest) {
      if (out.authors.length) break;
      for (const a of names(n.author)) addAuthor(a);
    }
    set("publishedAt", rest.map((n) => firstString(n.datePublished)).find(Boolean));
  }
  set("title", htmlTitle(html));
  if (opts.baseUrl) {
    for (const k of ["canonicalUrl", "imageUrl"]) {
      if (out[k] === void 0) continue;
      const abs = resolveUrl2(out[k], opts.baseUrl);
      if (abs) out[k] = abs;
      else delete out[k];
    }
  }
  return out;
}
var MAX_AUTHORS = 1e4;
function resolveUrl2(url, base2) {
  try {
    const abs = new URL(url, base2);
    return abs.protocol === "http:" || abs.protocol === "https:" ? abs.href : void 0;
  } catch {
    return void 0;
  }
}

// src/repo.ts
init_brand();
init_exec2();
import { createHash as createHash4, randomBytes as randomBytes2 } from "crypto";
import { existsSync as existsSync11, mkdirSync as mkdirSync6, readdirSync as readdirSync9, renameSync as renameSync3, rmSync as rmSync7, statSync as statSync9 } from "fs";
import { tmpdir as tmpdir5 } from "os";
import { basename as basename3, join as join23, resolve as resolve5 } from "path";

// src/forge-host.ts
init_brand();
var KINDS = /* @__PURE__ */ new Set(["github", "gitlab", "gitea"]);
var WWW_ALIASED = /* @__PURE__ */ new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"]);
function normalizeForgeHost(host) {
  const h = host.trim().toLowerCase();
  const bare = h.replace(/^www\./, "");
  return WWW_ALIASED.has(bare) ? bare : h;
}
function configuredForgeHosts() {
  const out = /* @__PURE__ */ new Map();
  for (const entry of (env("FORGE_HOSTS") ?? "").split(/[\s,]+/)) {
    const eq = entry.indexOf("=");
    if (eq < 1) continue;
    const kind = entry.slice(eq + 1).trim().toLowerCase();
    if (KINDS.has(kind)) out.set(normalizeForgeHost(entry.slice(0, eq)), kind);
  }
  return out;
}
function hostForgeKind(host) {
  const h = normalizeForgeHost(host);
  const declared = configuredForgeHosts().get(h);
  if (declared) return declared;
  if (h === "github.com" || h.endsWith(".github.com") || h.startsWith("github.")) return "github";
  if (h === "gitlab.com" || h.includes("gitlab")) return "gitlab";
  if (h.includes("gitea") || h.includes("codeberg")) return "gitea";
  return void 0;
}

// src/repo.ts
init_text();
function resolveRepo(raw, opts = {}) {
  const trimmed = raw.trim();
  if (trimmed && opts.local !== false) {
    const asPath = resolve5(trimmed);
    if (existsSync11(asPath) && statSync9(asPath).isDirectory()) {
      return { raw: trimmed, host: "local", isLocal: true, slug: `local-${slugify(`${basename3(asPath)}-${asPath}`)}` };
    }
  }
  const p = filePath(trimmed);
  if (p !== void 0) {
    return {
      raw: trimmed,
      host: "file",
      ...basename3(p) ? { repo: basename3(p) } : {},
      cloneUrl: trimmed,
      isLocal: false,
      slug: `file-${repoSlug(p)}`
    };
  }
  const generic = () => ({ raw: trimmed, host: "generic", isLocal: false, slug: slugify(trimmed) || "seed" });
  let transport;
  let host;
  let rest;
  const scp = /^([\w.-]+)@([^:/]+):(.+)$/.exec(trimmed);
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]+)@)?([^/:?#]+)(?::(\d+))?\/(.+)$/i.exec(trimmed);
  const hostPath = /^([a-z0-9.-]+\.[a-z]{2,})\/(.+)$/i.exec(trimmed);
  if (scp) {
    transport = { kind: "scp", user: scp[1], absolute: scp[3].startsWith("/") };
    host = scp[2];
    rest = scp[3];
  } else if (url) {
    const scheme = url[1].toLowerCase();
    transport = /^(?:https?|ssh|git\+ssh|ssh\+git)$/.test(scheme) ? { kind: "url", scheme: scheme.startsWith("http") ? scheme : "ssh", userinfo: url[2], port: url[4] } : { kind: "https" };
    host = url[3];
    rest = url[5];
  } else if (hostPath) {
    transport = { kind: "https" };
    host = hostPath[1];
    rest = hostPath[2];
  } else if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    transport = { kind: "https" };
    host = "github.com";
    rest = trimmed;
  } else {
    return generic();
  }
  const user = transport.kind === "scp" ? transport.user : transport.kind === "url" ? transport.userinfo : void 0;
  if (host.startsWith("-") || user?.startsWith("-")) return generic();
  host = normalizeForgeHost(host);
  const segments = repoSegments(host, rest, opts.kind ?? hostForgeKind(host));
  if (!segments) return generic();
  const path = segments.join("/");
  const repo = segments[segments.length - 1];
  const owner = segments.length > 1 ? segments.slice(0, -1).join("/") : void 0;
  const cloneUrl = transport.kind === "scp" ? `${transport.user}@${host}:${transport.absolute ? "/" : ""}${path}.git` : transport.kind === "url" ? `${transport.scheme}://${transport.userinfo ? `${transport.userinfo}@` : ""}${host}${transport.port ? `:${transport.port}` : ""}/${path}.git` : `https://${host}/${path}.git`;
  return {
    raw: trimmed,
    host,
    ...owner ? { owner } : {},
    ...repo ? { repo } : {},
    cloneUrl,
    webUrl: `https://${host}/${path}`,
    isLocal: false,
    slug: repoSlug(`${host}/${path}`)
  };
}
function filePath(url) {
  const file = /^file:\/\/(\/.*)$/.exec(url);
  return file ? trimRuns(file[1].replace(/\.git$/, ""), "/", false) : void 0;
}
function trimRuns(s, ch, start = true) {
  const code = ch.charCodeAt(0);
  let a = 0;
  let b = s.length;
  while (start && a < b && s.charCodeAt(a) === code) a++;
  while (b > a && s.charCodeAt(b - 1) === code) b--;
  return s.slice(a, b);
}
var fold = (k) => trimRuns(k.replace(/[^a-z0-9._-]+/g, "-"), "-");
var sha256Hex = (k) => createHash4("sha256").update(k).digest("hex");
function repoSlug(key) {
  const k = key.toLowerCase();
  const folded = fold(k);
  if (/^[a-z0-9._/]+$/.test(k) && slugify(k) === folded) return folded;
  return `${folded.slice(0, 105).replace(/-+$/, "") || "repo"}--${sha256Hex(k).slice(0, 12)}`;
}
var DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
var TWO_SEGMENT_HOSTS = /* @__PURE__ */ new Set(["bitbucket.org"]);
function repoSegments(host, rest, kind) {
  let segments = rest.replace(/[?#].*$/s, "").split("/").filter(Boolean);
  if (segments.some((s) => DOT_SEGMENT.test(s))) return void 0;
  const dash = segments.indexOf("-");
  if (dash >= 0) segments = segments.slice(0, dash);
  if (kind === "github" || kind === "gitea" || TWO_SEGMENT_HOSTS.has(host)) segments = segments.slice(0, 2);
  const last = segments.length - 1;
  if (last >= 0) segments[last] = segments[last].replace(/\.git$/i, "");
  return segments.filter(Boolean).length ? segments.filter(Boolean) : void 0;
}
var STALE_STAGING_MS = 24 * 60 * 60 * 1e3;
function originUrl(dir) {
  const r = sh("git", ["-C", dir, "remote", "get-url", "origin"], { timeoutMs: 1e4 });
  return r.ok ? r.stdout.trim() || void 0 : void 0;
}

// src/forge.ts
init_brand();
init_exec2();
init_fetch();
import { resolve as resolve6 } from "path";
init_retry();
init_text();
function forgeKind(host, opts = {}) {
  return opts.kind ?? hostForgeKind(host);
}
function forgeRef(ref2, opts = {}) {
  if (!ref2.isLocal) return ref2;
  const origin = originUrl(resolve6(ref2.raw));
  if (!origin) return ref2;
  const remote = resolveRepo(origin.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1"), opts);
  return remote.host === "generic" || remote.isLocal ? ref2 : remote;
}
function apiBase(ref2, opts = {}) {
  if (opts.apiBase) return opts.apiBase.replace(/\/+$/, "");
  const host = normalizeForgeHost(typeof ref2 === "string" ? ref2 : ref2.host);
  const kind = forgeKind(host, opts);
  if (kind === "github") return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  if (kind === "gitlab") return `https://${host}/api/v4`;
  return `https://${host}/api/v1`;
}
var TOKEN_HOSTS = {
  github: ["github.com", "api.github.com"],
  gitlab: ["gitlab.com"],
  gitea: []
};
function tokenHostAllowed(kind, host) {
  const h = normalizeForgeHost(host);
  return TOKEN_HOSTS[kind].includes(h) || configuredForgeHosts().get(h) === kind;
}
var TOKEN_VARS = {
  github: ["GITHUB_TOKEN", "GH_TOKEN"],
  gitlab: ["GITLAB_TOKEN"],
  gitea: ["GITEA_TOKEN"]
};
function forgeToken(kind) {
  const own = env(TOKEN_VARS[kind][0]);
  if (own) return { value: own, name: envName(TOKEN_VARS[kind][0]) };
  for (const name2 of TOKEN_VARS[kind]) {
    const value = process.env[name2]?.trim();
    if (value) return { value, name: name2 };
  }
  return void 0;
}
function forgeAuthHeaders(kind, host) {
  const t = forgeToken(kind);
  if (!t || host !== void 0 && !tokenHostAllowed(kind, host)) return {};
  return { authorization: kind === "gitea" ? `token ${t.value}` : `Bearer ${t.value}` };
}
function limited(status, headers, data) {
  if (status === 429) return true;
  return status === 403 && (headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(JSON.stringify(data ?? "")));
}
function resetTime(headers) {
  const wait = parseRetryAfter(headers, Number.POSITIVE_INFINITY);
  if (wait !== void 0) return new Date(Date.now() + wait).toISOString();
  const epoch = Number(headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset"));
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1e3).toISOString() : void 0;
}
function quotaState(headers) {
  const remaining = headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining");
  if (remaining === null || remaining.trim() === "" || !Number.isFinite(Number(remaining))) return void 0;
  return Number(remaining) <= 0 ? "spent" : "left";
}
var REDIRECT_STATUS2 = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
var RETRY_STATUS2 = /* @__PURE__ */ new Set([502, 503, 504]);
var MAX_REDIRECTS = 5;
var MAX_BODY_BYTES = 4 * 1024 * 1024;
function failureText(e) {
  const err = e;
  const code = typeof err?.cause?.code === "string" ? err.cause.code : void 0;
  const detail = typeof err?.cause?.message === "string" && err.cause.message ? err.cause.message : code;
  if (!detail) return typeof err?.message === "string" ? err.message : String(e);
  return code && !detail.includes(code) ? `${code}: ${detail}` : detail;
}
async function refusal(authorize, url) {
  if (!authorize) return void 0;
  let error;
  try {
    if (!await authorize(url)) error = `URL not authorized: ${url}`;
  } catch (e) {
    error = `URL authorization failed for ${url}: ${e.message}`;
  }
  return error === void 0 ? void 0 : { ok: false, status: 0, data: void 0, error, permanent: true, refused: true };
}
async function forgeGetOnce(url, headers, timeoutMs, authorize) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const sent = { ...headers };
  let target = url;
  try {
    for (let hop = 0; ; hop++) {
      const refused = await refusal(authorize, target);
      if (refused) return refused;
      const res = await fetch(target, { headers: sent, redirect: "manual", signal: ctrl.signal });
      const location = res.headers.get("location");
      if (REDIRECT_STATUS2.has(res.status) && location) {
        await res.body?.cancel().catch(() => {
        });
        if (hop >= MAX_REDIRECTS) return { ok: false, status: 0, data: void 0, error: `more than ${MAX_REDIRECTS} redirects from ${url}`, permanent: true };
        const next = new URL(location, target);
        if (next.protocol !== "https:" && next.protocol !== "http:") {
          return { ok: false, status: 0, data: void 0, error: `redirected to ${next.protocol}`, permanent: true };
        }
        if (next.origin !== new URL(target).origin) {
          delete sent.authorization;
          delete sent["private-token"];
          delete sent.cookie;
        }
        target = next.href;
        continue;
      }
      const bytes = await readCappedBytes(res, MAX_BODY_BYTES + 1);
      countFetch(Math.min(bytes.length, MAX_BODY_BYTES), false);
      if (bytes.length > MAX_BODY_BYTES) return { ok: false, status: res.status, data: void 0, error: `response over the ${MAX_BODY_BYTES}-byte cap` };
      const text = bytes.toString("utf8");
      let data;
      try {
        data = text ? JSON.parse(text) : void 0;
      } catch {
        data = text;
      }
      const quota = !res.ok && limited(res.status, res.headers, data);
      const retryAfterMs = RETRY_STATUS2.has(res.status) ? parseRetryAfter(res.headers, Number.POSITIVE_INFINITY) : void 0;
      return {
        ok: res.ok,
        status: res.status,
        data,
        ...quota ? { rateLimited: true, resetAt: resetTime(res.headers), quota: quotaState(res.headers) } : {},
        ...retryAfterMs !== void 0 ? { retryAfterMs } : {}
      };
    }
  } catch (e) {
    if (timedOut) return { ok: false, status: 0, data: void 0, error: `timed out after ${timeoutMs} ms`, timedOut };
    return { ok: false, status: 0, data: void 0, error: failureText(e), ...isPermanentFailure(e) ? { permanent: true } : {} };
  } finally {
    clearTimeout(timer);
  }
}
async function forgeGet(url, kind, ref2, opts) {
  const auth = opts.apiBase ? forgeAuthHeaders(kind) : forgeAuthHeaders(kind, ref2.host);
  const headers = { "user-agent": contactUa(), accept: kind === "github" ? "application/vnd.github+json" : "application/json", ...auth };
  const tokenVar = auth.authorization ? forgeToken(kind)?.name : void 0;
  const timeoutMs = opts.timeoutMs ?? 15e3;
  const attempts = maxAttempts();
  let r = await forgeGetOnce(url, headers, timeoutMs, opts.authorizeUrl);
  for (let attempt = 1; attempt < attempts; attempt++) {
    const wait = retryWait(r);
    if (wait === void 0) break;
    await sleep(wait);
    r = await forgeGetOnce(url, headers, timeoutMs, opts.authorizeUrl);
  }
  return tokenVar ? { ...r, tokenVar } : r;
}
function retryWait(r) {
  if (RETRY_STATUS2.has(r.status)) return retryDelayMs(r.retryAfterMs);
  if (r.status === 0 && !r.timedOut && !r.permanent) return defaultRetryMs();
  return void 0;
}
var FORGE_NAME = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea" };
function failure(r, forge, ref2, action, opts) {
  const host = ref2.host;
  const tokenVar = TOKEN_VARS[forge][0];
  const declared = !!opts.apiBase || tokenHostAllowed(forge, host);
  const withheld = !r.tokenVar && !declared ? forgeToken(forge)?.name : void 0;
  const declare = `${envName("FORGE_HOSTS")}=${host}=${forge}`;
  const withheldNote = withheld ? `${withheld} is set, but is only sent to hosts listed in ${envName("FORGE_HOSTS")}: declare this one with ${declare}` : "";
  const authAdvice = withheldNote || (declared ? `set ${tokenVar}` : `declare the host with ${declare} and set ${tokenVar}`);
  if (r.rateLimited) {
    const when = r.resetAt ? ` until ${r.resetAt}` : "";
    const advice = r.quota === "left" ? `a secondary limit on how fast requests arrive; the quota${r.tokenVar ? ` for ${r.tokenVar}` : ""} is not spent` : r.tokenVar ? `the quota for ${r.tokenVar} is spent` : `${authAdvice} to raise the anonymous quota`;
    return {
      note: `${FORGE_NAME[forge]} rate-limited this request${when} \u2014 ${advice}.`,
      status: r.status,
      rateLimited: true,
      ...r.resetAt ? { resetAt: r.resetAt } : {}
    };
  }
  if (r.refused) return { note: `${action} refused: ${r.error}.`, status: 0 };
  if (r.status === 0) {
    let apiHost = host;
    try {
      apiHost = new URL(apiBase(ref2, opts)).host;
    } catch {
    }
    return { note: `${action} failed: network error reaching ${apiHost} \u2014 ${r.error ?? "no response"}.`, status: 0 };
  }
  const why = r.status === 404 ? `no such repository on ${host}, or it is private${withheldNote ? ` \u2014 ${withheldNote}` : ""}` : r.status === 401 ? r.tokenVar ? `${host} rejected ${r.tokenVar} \u2014 refresh it, or unset it to read public repositories anonymously` : `${host} requires authentication \u2014 ${authAdvice}` : r.status === 403 ? `${host} refused access${r.tokenVar ? ` \u2014 ${r.tokenVar} may lack the scope this needs` : withheldNote ? ` \u2014 ${withheldNote}` : ""}` : r.status === 422 && forge === "github" ? "GitHub cannot search that repository \u2014 it does not exist, or it is private" : r.status >= 500 ? `${host} is unavailable` : r.error ?? `${host} answered with an error`;
  return { note: `${action} failed (status ${r.status}): ${why}.`, status: r.status };
}
function failed(r, forge, ref2, action, opts) {
  return { items: [], ...failure(r, forge, ref2, action, opts) };
}
var DOT_SEGMENT2 = /^(?:\.|%2e){1,2}$/i;
function repoPath(ref2, forge) {
  if (!ref2.owner || !ref2.repo) return void 0;
  if ([...ref2.owner.split("/"), ref2.repo].some((s) => !s || DOT_SEGMENT2.test(s))) return void 0;
  return forge === "gitlab" ? `projects/${encodeURIComponent(`${ref2.owner}/${ref2.repo}`)}` : `repos/${encodeURIComponent(ref2.owner)}/${encodeURIComponent(ref2.repo)}`;
}
function clip3(s, n = 1200) {
  return String(s ?? "").replace(/\r/g, "").trim().slice(0, n);
}
function labelsOf(v) {
  if (!Array.isArray(v)) return [];
  return v.map((l) => typeof l === "string" ? l : l?.name ?? "").filter(Boolean);
}
function mapGithubIssues(raw, kind) {
  return (raw ?? []).filter((it) => !!it && typeof it === "object").map((it) => ({
    kind,
    number: typeof it.number === "number" ? it.number : void 0,
    title: String(it.title ?? "").trim(),
    url: String(it.html_url ?? ""),
    state: it.draft ? "draft" : String(it.state ?? ""),
    labels: labelsOf(it.labels),
    body: clip3(it.body),
    updatedAt: it.updated_at ? String(it.updated_at) : void 0,
    score: typeof it.score === "number" ? it.score : void 0
  }));
}
var canonCache = /* @__PURE__ */ new Map();
function ghUsable(host) {
  return /(^|\.)github\.com$/i.test(host) && !envFlag("NO_GH") && have("gh");
}
function splitSlug(full, fallback) {
  const i = full.indexOf("/");
  return i > 0 ? { owner: full.slice(0, i), repo: full.slice(i + 1) } : fallback;
}
function canonicalLookup(ref2, opts) {
  const fallback = { owner: ref2.owner ?? "", repo: ref2.repo ?? "" };
  const path = forgeKind(ref2.host, opts) === "github" ? repoPath(ref2, "github") : void 0;
  if (!path) return Promise.resolve(fallback);
  const key = `${ref2.host}/${ref2.owner}/${ref2.repo}`;
  let hit = canonCache.get(key);
  if (!hit) {
    const lookup2 = (async () => {
      if (ghUsable(ref2.host)) {
        const r2 = await shAsync("gh", ["api", path, "--jq", ".full_name"], { timeoutMs: opts.timeoutMs ?? 15e3 });
        if (r2.ok && r2.stdout.includes("/")) return splitSlug(r2.stdout.trim(), fallback);
      }
      const r = await forgeGet(`${apiBase(ref2, opts)}/${path}`, "github", ref2, opts);
      if (!r.ok) return { ...fallback, failed: r };
      const full = r.data?.full_name;
      return typeof full === "string" && full.includes("/") ? splitSlug(full, fallback) : fallback;
    })();
    hit = lookup2;
    canonCache.set(key, lookup2);
    void lookup2.then((c) => {
      if (c.failed && canonCache.get(key) === lookup2) canonCache.delete(key);
    });
  }
  return hit;
}
var noOrigin = (ref2) => `"${ref2.raw}" is a local directory with no origin remote \u2014 name the repository it is a clone of.`;
async function searchIssues(ref2, terms, kind, opts = {}) {
  ref2 = forgeRef(ref2, opts);
  if (ref2.isLocal) return { items: [], note: noOrigin(ref2) };
  const forge = forgeKind(ref2.host, opts);
  if (!forge) return { items: [], note: `${ref2.host} is not a forge this engine knows how to query.` };
  const repoAt = repoPath(ref2, forge);
  if (!repoAt) return { items: [], note: `"${ref2.raw}" does not name owner/repo.` };
  const wanted = terms.map((t) => t.trim()).filter(Boolean);
  const first = await searchOnce(ref2, forge, repoAt, wanted, kind, opts);
  if (first.items.length || first.note || opts.relax === false) return first;
  const relaxed = relaxTerms(wanted);
  if (!relaxed) return first;
  const second = await searchOnce(ref2, forge, repoAt, relaxed, kind, opts);
  if (second.note) return second;
  return { ...second, note: `No match for all the terms; relaxed to "${relaxed.join(" ")}".` };
}
function relaxTerms(terms) {
  const qualifiers = terms.filter((t) => t.includes(":"));
  const words = terms.filter((t) => !t.includes(":"));
  if (words.length < 3) return void 0;
  const best = rankedKeywords(words.join(" ")).slice(0, Math.max(2, Math.ceil(words.length / 2)));
  if (best.length < 2 || best.length >= words.length) return void 0;
  return [...best, ...qualifiers];
}
async function searchOnce(ref2, forge, repoAt, terms, kind, opts) {
  const limit = Math.max(1, opts.limit ?? 10);
  const q = terms.join(" ");
  if (forge === "github") {
    const canon = await canonicalLookup(ref2, opts);
    if (canon.failed) return failed(canon.failed, forge, ref2, "GitHub search", opts);
    const filter = kind === "pr" ? "is:pr" : "is:issue";
    const order = q ? "" : "&sort=updated&order=desc";
    const url2 = `${apiBase(ref2, opts)}/search/issues?q=${encodeURIComponent(`repo:${canon.owner}/${canon.repo} ${filter} ${q}`.trim())}&per_page=${limit}${order}`;
    const r2 = await forgeGet(url2, forge, ref2, opts);
    if (!r2.ok) return failed(r2, forge, ref2, "GitHub search", opts);
    return { items: mapGithubIssues(r2.data?.items ?? [], kind) };
  }
  if (forge === "gitlab") {
    const path = kind === "pr" ? "merge_requests" : "issues";
    const url2 = `${apiBase(ref2, opts)}/${repoAt}/${path}?search=${encodeURIComponent(q)}&per_page=${limit}&order_by=updated_at`;
    const r2 = await forgeGet(url2, forge, ref2, opts);
    if (!r2.ok) return failed(r2, forge, ref2, "GitLab search", opts);
    const items2 = (Array.isArray(r2.data) ? r2.data : []).map((it) => ({
      kind,
      number: typeof it.iid === "number" ? it.iid : void 0,
      title: String(it.title ?? "").trim(),
      url: String(it.web_url ?? ""),
      state: String(it.state ?? ""),
      labels: labelsOf(it.labels),
      body: clip3(it.description),
      updatedAt: it.updated_at ? String(it.updated_at) : void 0
    }));
    return { items: items2 };
  }
  const url = `${apiBase(ref2, opts)}/${repoAt}/issues?state=all&type=${kind === "pr" ? "pulls" : "issues"}&limit=${limit}&q=${encodeURIComponent(q)}`;
  const r = await forgeGet(url, forge, ref2, opts);
  if (!r.ok) return failed(r, forge, ref2, "Gitea search", opts);
  const items = (Array.isArray(r.data) ? r.data : []).map((it) => ({
    kind,
    number: typeof it.number === "number" ? it.number : void 0,
    title: String(it.title ?? "").trim(),
    url: String(it.html_url ?? ""),
    state: String(it.state ?? ""),
    labels: labelsOf(it.labels),
    body: clip3(it.body),
    updatedAt: it.updated_at ? String(it.updated_at) : void 0
  }));
  return { items };
}
async function listReleases(ref2, opts = {}) {
  ref2 = forgeRef(ref2, opts);
  if (ref2.isLocal) return { items: [], note: noOrigin(ref2) };
  const forge = forgeKind(ref2.host, opts);
  const repoAt = forge && repoPath(ref2, forge);
  if (!forge || !repoAt) return { items: [], note: `Cannot list releases for "${ref2.raw}".` };
  const limit = Math.max(1, opts.limit ?? 20);
  const url = `${apiBase(ref2, opts)}/${repoAt}/releases?per_page=${limit}${forge === "gitlab" ? "" : `&limit=${limit}`}`;
  const r = await forgeGet(url, forge, ref2, opts);
  if (!r.ok) return failed(r, forge, ref2, "Listing releases", opts);
  const items = (Array.isArray(r.data) ? r.data : []).map((it) => ({
    kind: "release",
    title: String(it.name ?? it.tag_name ?? it.tag ?? "").trim() || String(it.tag_name ?? ""),
    // GitLab has no html_url; its page is `_links.self`, an object's field.
    url: String(it.html_url ?? it._links?.self ?? it.web_url ?? ref2.webUrl ?? ""),
    state: it.prerelease ? "prerelease" : "released",
    labels: [],
    body: clip3(it.body ?? it.description),
    updatedAt: String(it.published_at ?? it.released_at ?? it.created_at ?? "") || void 0
  }));
  return { items };
}
async function listTags(ref2, opts = {}) {
  ref2 = forgeRef(ref2, opts);
  if (ref2.isLocal) return { items: [], note: noOrigin(ref2) };
  const forge = forgeKind(ref2.host, opts);
  const repoAt = forge && repoPath(ref2, forge);
  if (!forge || !repoAt) return { items: [], note: `Cannot list tags for "${ref2.raw}".` };
  const limit = Math.max(1, opts.limit ?? 50);
  const url = forge === "gitlab" ? `${apiBase(ref2, opts)}/${repoAt}/repository/tags?per_page=${limit}` : `${apiBase(ref2, opts)}/${repoAt}/tags?per_page=${limit}&limit=${limit}`;
  const r = await forgeGet(url, forge, ref2, opts);
  if (!r.ok) return failed(r, forge, ref2, "Listing tags", opts);
  const tagPage = forge === "gitlab" ? "-/tags" : "releases/tag";
  const items = (Array.isArray(r.data) ? r.data : []).map((it) => {
    const name2 = String(it.name ?? "").trim();
    const commit = it.commit;
    const at = commit?.created_at ?? commit?.created;
    return {
      kind: "tag",
      title: name2,
      url: ref2.webUrl ? `${ref2.webUrl}/${tagPage}/${name2.split("/").map(encodeURIComponent).join("/")}` : "",
      labels: [],
      body: "",
      ...typeof at === "string" ? { updatedAt: at } : {}
    };
  });
  return { items };
}
async function repoFactsResult(ref2, opts = {}) {
  ref2 = forgeRef(ref2, opts);
  if (ref2.isLocal) return { note: noOrigin(ref2) };
  const forge = forgeKind(ref2.host, opts);
  if (!forge) return { note: `${ref2.host} is not a forge this engine knows how to query.` };
  const repoAt = repoPath(ref2, forge);
  if (!repoAt) return { note: `"${ref2.raw}" does not name owner/repo.` };
  const r = await forgeGet(`${apiBase(ref2, opts)}/${repoAt}${forge === "gitlab" ? "?license=true" : ""}`, forge, ref2, opts);
  if (!r.ok) return failure(r, forge, ref2, `Reading ${ref2.webUrl ?? ref2.raw}`, opts);
  if (!r.data || typeof r.data !== "object") return { status: r.status, note: `${ref2.host} answered with something other than a repository record.` };
  return { status: r.status, facts: mapRepoFacts(forge, r.data) };
}
var str2 = (v) => typeof v === "string" && v.trim() ? v : void 0;
var num2 = (v) => typeof v === "number" ? v : void 0;
function mapRepoFacts(forge, d) {
  const topics = (v) => Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  const shared = {
    description: str2(d.description),
    forks: num2(d.forks_count),
    openIssues: num2(d.open_issues_count),
    defaultBranch: str2(d.default_branch),
    archived: typeof d.archived === "boolean" ? d.archived : void 0
  };
  if (forge === "gitlab") {
    return {
      ...shared,
      fullName: str2(d.path_with_namespace),
      // A project has no homepage field; its page is the closest thing it states.
      homepage: str2(d.web_url),
      license: str2(d.license?.name) ?? str2(d.license?.key),
      stars: num2(d.star_count),
      pushedAt: str2(d.last_activity_at),
      topics: topics(d.topics).length ? topics(d.topics) : topics(d.tag_list)
    };
  }
  if (forge === "gitea") {
    return {
      ...shared,
      fullName: str2(d.full_name),
      homepage: str2(d.website),
      license: Array.isArray(d.licenses) ? str2(d.licenses[0]) : void 0,
      stars: num2(d.stars_count),
      pushedAt: str2(d.updated_at),
      topics: topics(d.topics)
    };
  }
  const spdx = str2(d.license?.spdx_id);
  return {
    ...shared,
    fullName: str2(d.full_name),
    homepage: str2(d.homepage),
    license: spdx && spdx !== "NOASSERTION" ? spdx : str2(d.license?.name),
    stars: num2(d.stargazers_count),
    pushedAt: str2(d.pushed_at),
    topics: topics(d.topics)
  };
}

// src/registry.ts
init_fetch();
var REGISTRIES = ["npm", "pypi", "crates"];
var NPM = (n) => `https://registry.npmjs.org/${encodeURIComponent(n).replace(/^%40/, "@")}`;
var PYPI = (n, version) => `https://pypi.org/pypi/${encodeURIComponent(n)}/${version ? `${encodeURIComponent(version)}/` : ""}json`;
var CRATES = (n) => `https://crates.io/api/v1/crates/${encodeURIComponent(n)}`;
var SHORTHAND_HOST = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" };
function normalizeRepoUrl(raw) {
  const s = typeof raw === "string" ? raw.trim() : typeof raw?.url === "string" ? String(raw.url).trim() : "";
  if (!s) return void 0;
  const short = /^(github|gitlab|bitbucket):([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#.*)?$/i.exec(s);
  if (short) return `https://${SHORTHAND_HOST[short[1].toLowerCase()]}/${short[2]}`;
  let out = s.replace(/#.*$/s, "").replace(/^git\+/i, "").replace(/^git:\/\//i, "https://").replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//i, "https://$1/").replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+):/i, "https://$1/").replace(/^[\w.-]+@([^:/]+):/, "https://$1/").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(out)) out = `https://github.com/${out}`;
  return /^https?:\/\//i.test(out) ? out.replace(/^https?:\/\//i, (scheme) => scheme.toLowerCase()) : void 0;
}
function reqOpts() {
  return { timeoutMs: 12e3, userAgent: contactUa(), accept: "application/json" };
}
var NPM_TIME_TAIL_FIRST_BYTES = 256 * 1024;
var NPM_TIME_TAIL_BYTES = 2 * 1024 * 1024;
var isWs = (c) => c === " " || c === "	" || c === "\n" || c === "\r";
function opensTimeMap(text, i) {
  let j = i - 1;
  while (j >= 0 && isWs(text[j])) j--;
  if (text[j] !== ":") return false;
  j--;
  while (j >= 0 && isWs(text[j])) j--;
  return j >= 5 && text.slice(j - 5, j + 1) === '"time"';
}
var MAX_OPEN_TIME_MAPS = 16;
function scanTimeMap(text, version, phase) {
  let publishedAt;
  let closed = false;
  let depth = 0;
  let quoted = phase !== "outside";
  let escaped = phase === "escape";
  const open2 = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "{") {
      if (open2.length < MAX_OPEN_TIME_MAPS && opensTimeMap(text, i)) open2.push({ at: i, depth });
      depth++;
    } else if (c === "}") {
      depth--;
      const top = open2[open2.length - 1];
      if (top?.depth === depth) {
        open2.pop();
        try {
          const time = JSON.parse(text.slice(top.at, i + 1));
          if (time && typeof time === "object" && !Array.isArray(time)) {
            closed = true;
            if (typeof time[version] === "string") publishedAt = time[version];
          }
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
      while (open2.length && open2[open2.length - 1].depth > depth) open2.pop();
    }
  }
  return { publishedAt, closed };
}
function npmTimeFromTail(text, version) {
  let closed = false;
  for (const phase of ["outside", "string", "escape"]) {
    const found = scanTimeMap(text, version, phase);
    if (found.publishedAt) return found;
    closed ||= found.closed;
  }
  return { closed };
}
async function npmPublishedAt(packageUrl, version) {
  if (!version) return void 0;
  for (const bytes of [NPM_TIME_TAIL_FIRST_BYTES, NPM_TIME_TAIL_BYTES]) {
    const tail = await httpGet(packageUrl, {
      ...reqOpts(),
      // Optional enrichment must not inherit the primary lookup's retry budget:
      // package facts are already usable if this suffix is slow or unavailable.
      timeoutMs: 2500,
      retries: 0,
      headers: { range: `bytes=-${bytes}` },
      maxBytes: bytes
    });
    if (!tail.ok) return void 0;
    const found = npmTimeFromTail(tail.body, version);
    if (found.publishedAt || found.closed || tail.status !== 206) return found.publishedAt;
  }
  return void 0;
}
function record(r) {
  return r.ok && r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : void 0;
}
var ABSENT = /* @__PURE__ */ new Set([400, 404, 410]);
var str3 = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
function miss(r) {
  if (ABSENT.has(r.status)) return { status: r.status };
  const said = r.data && typeof r.data === "object" ? str3(r.data.errors?.[0]?.detail) ?? str3(r.data.message) ?? str3(r.data.error) : void 0;
  return { status: r.status, error: r.error ?? said ?? (r.ok ? "the registry answered with something other than a package record" : `status ${r.status}`) };
}
async function lookupPackageResult(registry, name2, version) {
  if (!REGISTRIES.includes(registry)) return { status: 0, error: `unknown registry "${String(registry)}" \u2014 expected ${REGISTRIES.join(", ")}` };
  const n = name2.trim();
  if (!n) return { status: 0, error: "no package name given" };
  const v = version?.trim() || void 0;
  if (registry === "npm") return npmLookup(n, v);
  if (registry === "pypi") return pypiLookup(n, v);
  return cratesLookup(n, v);
}
async function npmLookup(n, version) {
  const r = await httpJson("GET", `${NPM(n)}/${encodeURIComponent(version ?? "latest")}`, void 0, reqOpts());
  const d = record(r);
  if (!d) return miss(r);
  const asked = version ?? "latest";
  const tags = d["dist-tags"] ?? {};
  const resolved = str3(d.version) ?? (typeof tags[asked] === "string" ? tags[asked] : void 0) ?? (d.versions?.[asked] ? asked : void 0);
  const v = resolved && d.versions?.[resolved] || d;
  const stated = resolved ? d.time?.[resolved] : void 0;
  const publishedAt = typeof stated === "string" ? stated : await npmPublishedAt(NPM(n), resolved);
  const deprecated = typeof v.deprecated === "string" ? v.deprecated : v.deprecated === true ? "deprecated" : void 0;
  const repository = v.repository ?? d.repository;
  const directory = str3(repository?.directory);
  return {
    status: r.status,
    facts: {
      registry: "npm",
      name: d.name ?? n,
      version: resolved,
      description: v.description ?? d.description,
      homepage: v.homepage ?? d.homepage,
      repository: normalizeRepoUrl(repository),
      ...directory ? { repositoryDirectory: directory } : {},
      documentation: typeof v.documentation === "string" ? v.documentation : void 0,
      license: typeof v.license === "string" ? v.license : v.license?.type,
      ...deprecated ? { deprecated } : {},
      publishedAt
    }
  };
}
var FORGE_URL = /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/[^/]+\/[^/]+/i;
var PYPI_REPO_LABELS = ["source", "sourcecode", "repository", "code", "github", "gitlab"];
function projectUrls(raw) {
  const out = /* @__PURE__ */ new Map();
  if (!raw || typeof raw !== "object") return out;
  for (const [label, url] of Object.entries(raw)) {
    const key = label.toLowerCase().replace(/[^a-z]/g, "");
    if (typeof url === "string" && url.trim() && !out.has(key)) out.set(key, url.trim());
  }
  return out;
}
function pypiLicense(info, classifiers) {
  const expression = str3(info.license_expression);
  if (expression) return expression;
  const license = str3(info.license);
  if (license && license.length <= 100 && !license.includes("\n")) return license;
  const named = classifiers.filter((c) => c.startsWith("License ::")).map((c) => c.split("::").pop().trim());
  return named.filter(Boolean).join(", ") || void 0;
}
async function pypiLookup(n, version) {
  const r = await httpJson("GET", PYPI(n, version), void 0, reqOpts());
  const d = record(r);
  if (!d) return miss(r);
  const info = d.info ?? {};
  const urls = projectUrls(info.project_urls);
  const classifiers = Array.isArray(info.classifiers) ? info.classifiers.filter((c) => typeof c === "string") : [];
  const homepage = str3(info.home_page) ?? urls.get("homepage");
  const labelled = PYPI_REPO_LABELS.map((k) => urls.get(k)).find(Boolean);
  const repository = labelled ?? [info.home_page, urls.get("homepage")].find((u) => typeof u === "string" && FORGE_URL.test(u));
  const filesYanked = Array.isArray(d.urls) && d.urls.length ? d.urls.every((u) => u.yanked) : false;
  const yanked = info.yanked === true ? `this release is yanked${str3(info.yanked_reason) ? `: ${str3(info.yanked_reason)}` : ""}` : filesYanked ? "every file for this release is yanked" : void 0;
  const inactive = classifiers.find((c) => /^Development Status :: 7 - Inactive/.test(c));
  const deprecated = yanked ?? (inactive ? `the project declares itself inactive (${inactive})` : void 0);
  return {
    status: r.status,
    facts: {
      registry: "pypi",
      name: info.name ?? n,
      version: info.version,
      description: info.summary,
      homepage,
      repository: normalizeRepoUrl(repository),
      documentation: str3(info.docs_url) ?? urls.get("documentation") ?? urls.get("docs"),
      license: pypiLicense(info, classifiers),
      ...deprecated ? { deprecated } : {}
    }
  };
}
async function cratesLookup(n, version) {
  const [crateAnswer, pinnedAnswer] = await Promise.all([
    httpJson("GET", `${CRATES(n)}?include=default_version`, void 0, reqOpts()),
    version ? httpJson("GET", `${CRATES(n)}/${encodeURIComponent(version)}`, void 0, reqOpts()) : void 0
  ]);
  const d = record(crateAnswer);
  if (!d) return miss(crateAnswer);
  let v;
  if (pinnedAnswer) {
    const pinned = record(pinnedAnswer);
    if (!pinned) return miss(pinnedAnswer);
    v = pinned.version ?? {};
  }
  const c = d.crate ?? {};
  const listed = Array.isArray(d.versions) ? str3(d.versions[0]?.num) : void 0;
  const newest = str3(c.newest_version) === "0.0.0" ? void 0 : str3(c.newest_version);
  const num4 = version ? str3(v?.num) ?? version : str3(c.default_version) ?? listed ?? str3(c.max_stable_version) ?? newest;
  v ??= Array.isArray(d.versions) ? d.versions.find((x) => x?.num === num4) : void 0;
  const yanked = v?.yanked === true ? `this version is yanked${str3(v.yank_message) ? `: ${str3(v.yank_message)}` : ""}` : void 0;
  return {
    status: crateAnswer.status,
    facts: {
      registry: "crates",
      name: c.name ?? n,
      version: num4,
      description: str3(c.description) ?? str3(v?.description),
      homepage: str3(c.homepage) ?? str3(v?.homepage),
      repository: normalizeRepoUrl(c.repository ?? v?.repository),
      documentation: str3(c.documentation) ?? str3(v?.documentation),
      license: str3(v?.license),
      downloads: typeof c.downloads === "number" ? c.downloads : void 0,
      publishedAt: str3(v?.created_at) ?? (version ? void 0 : str3(c.updated_at)),
      ...yanked ? { deprecated: yanked } : {}
    }
  };
}
async function resolvePackageResult(name2, opts = {}) {
  if (!name2.trim()) return { tried: [], note: "no package name given" };
  const order = opts.registry ? [opts.registry] : REGISTRIES;
  const tried = [];
  for (const registry of order) {
    const r = await lookupPackageResult(registry, name2, opts.version);
    tried.push({ registry, status: r.status, ...r.error ? { error: r.error } : {} });
    if (r.facts) return { facts: r.facts, tried };
    if (!REGISTRIES.includes(registry)) return { tried, note: r.error };
    if (!ABSENT.has(r.status)) {
      const why = r.status ? ` (status ${r.status})` : "";
      return { tried, note: `${registry} could not be asked${why}: ${r.error ?? "no answer"} \u2014 retry, or name the registry the package is on.` };
    }
  }
  const at = opts.version ? ` at version ${opts.version}` : "";
  const range = opts.version && /[\^~<>=*|\s]|^[xX]$|\.[xX]\b/.test(opts.version) ? " (a version range is not resolved \u2014 pass an exact version, or an npm dist-tag)" : "";
  return { tried, note: `no registry knows a package called "${name2.trim()}"${at}${range}` };
}

// src/cli.ts
init_rank();
init_cli_kit();
init_no_write();
init_pool();

// src/mcp/server.ts
init_brand();

// src/mcp/protocol.ts
var PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
var LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
var ASSUMED_HTTP_PROTOCOL = "2025-03-26";
var ANNOTATIONS_SINCE = "2025-03-26";
var RICH_TOOLS_SINCE = "2025-06-18";
var PROGRESS_MESSAGE_SINCE = "2025-03-26";
var BATCHES_REMOVED_IN = "2025-06-18";
function batchRefusal(batch, negotiated) {
  if (batch.length === 0) return "invalid request: an empty batch";
  if (negotiated !== void 0 && negotiated >= BATCHES_REMOVED_IN) {
    return `invalid request: JSON-RPC batches are not part of MCP ${negotiated} (removed in ${BATCHES_REMOVED_IN}) \u2014 send one message at a time`;
  }
  return void 0;
}
var DEFAULT_MAX_RESPONSE_BYTES2 = 1e6;
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
      if (actual === "number" && Number.isFinite(value)) continue;
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
function capResponse(text, tool2, maxBytes, artifact, advice = {}) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  return JSON.stringify(
    {
      truncated: true,
      tool: tool2,
      bytes,
      maxBytes,
      reason: "This response exceeds the configured limit and was withheld rather than sent as an unusable partial payload.",
      narrower: advice[tool2] ?? "narrow the request and call again",
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
  if (o === "" || o === "null") return false;
  if (LOOPBACK_ORIGIN.test(o)) return true;
  return allowed.some((a) => a === "*" || a.toLowerCase() === o.toLowerCase());
}

// src/mcp/resources.ts
init_brand();
import { existsSync as existsSync12, readdirSync as readdirSync10, readFileSync as readFileSync18, realpathSync as realpathSync2, statSync as statSync10 } from "fs";
import { basename as basename4, dirname as dirname4, join as join24, relative as relative2, resolve as resolve7, sep as sep2 } from "path";
import { fileURLToPath } from "url";
var skillName = () => brand().name;
var URI_SCHEME = "skill://";
function resolveSkillRoot(moduleDir) {
  const here = moduleDir ?? dirname4(fileURLToPath(import.meta.url));
  const name2 = brand().name;
  const candidates2 = [resolve7(here, ".."), resolve7(here, "..", "skills", name2), resolve7(here, "..", "..", "skills", name2)];
  return candidates2.find((dir) => existsSync12(join24(dir, "SKILL.md")));
}
function listResources(moduleDir) {
  const root = resolveSkillRoot(moduleDir);
  if (!root) return [];
  const out = [describe(root, "SKILL.md", `${skillName()}: the skill`)];
  const refDir = join24(root, "references");
  if (!existsSync12(refDir)) return out;
  for (const file of readdirSync10(refDir).sort()) {
    if (!file.endsWith(".md")) continue;
    out.push(describe(root, join24("references", file), `${skillName()} reference: ${basename4(file, ".md")}`));
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
  const target = resolve7(root, rel);
  const served = relative2(root, target).split(sep2).join("/");
  if (served !== "SKILL.md" && !/^references\/[^/]+\.md$/.test(served)) {
    throw new ResourceError(`not a resource this server serves: ${uri} (resources/list names them)`);
  }
  const rootReal = realpathSync2(root);
  let targetReal;
  try {
    targetReal = realpathSync2(target);
  } catch {
    throw new ResourceError(`no such resource: ${uri}`);
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep2)) {
    throw new ResourceError(`resource path escapes the skill root: ${uri}`);
  }
  if (!statSync10(targetReal).isFile()) throw new ResourceError(`not a file: ${uri}`);
  return { uri, mimeType: "text/markdown", text: readFileSync18(targetReal, "utf8") };
}
var ResourceError = class extends Error {
};
function describe(root, rel, fallbackTitle) {
  const decl = {
    uri: `${URI_SCHEME}${rel.split(sep2).join("/")}`,
    name: rel.split(sep2).join("/"),
    title: fallbackTitle,
    mimeType: "text/markdown"
  };
  const summary = firstProse(join24(root, rel));
  if (summary) decl.description = summary;
  return decl;
}
function firstProse(file) {
  let text;
  try {
    text = readFileSync18(file, "utf8");
  } catch {
    return void 0;
  }
  const body = text.startsWith("---\n") ? text.slice(text.indexOf("\n---", 3) + 4) : text;
  for (const block of body.split(/\n\s*\n/)) {
    const line = block.trim();
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("|") || line.startsWith("```")) continue;
    const flat2 = line.replace(/\s+/g, " ").replace(/[*`]/g, "");
    return flat2.length > 300 ? `${flat2.slice(0, 297)}\u2026` : flat2;
  }
  return void 0;
}

// src/mcp/server.ts
var ToolError = class extends Error {
};
var InvalidParamsError = class extends Error {
};
var PromptError = class extends Error {
};
var ERR_INVALID_REQUEST = -32600;
var ERR_METHOD_NOT_FOUND = -32601;
var ERR_INVALID_PARAMS = -32602;
var ERR_INTERNAL = -32603;
function createServer(adapter, opts = {}) {
  const serverInfo = { name: opts.serverName ?? brand().name, version: adapter.version };
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES2;
  let protocol = LATEST_PROTOCOL;
  const active2 = /* @__PURE__ */ new Map();
  const listTools = () => adapter.listTools(protocol).map((decl) => forRevision(decl, protocol));
  const prompts = () => adapter.prompts ?? [];
  async function handle(msg, send, handleOpts = {}) {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
      return;
    }
    if (msg.method === void 0 && ("result" in msg || "error" in msg)) return;
    if (msg.id !== void 0 && msg.id !== null && typeof msg.id !== "string" && typeof msg.id !== "number") {
      send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: `id` must be a string or a number" } });
      return;
    }
    if (msg.id === void 0 || msg.id === null) {
      if (msg.method === "notifications/cancelled") {
        const target = msg.params?.requestId;
        if (typeof target === "string" || typeof target === "number") active2.get(target)?.cancel();
      }
      return;
    }
    const id = msg.id;
    const controller = new AbortController();
    const request = {
      cancelled: false,
      answered: false,
      cancel() {
        request.cancelled = true;
        controller.abort();
      }
    };
    active2.set(id, request);
    const lost = handleOpts.signal;
    const onLost = () => request.cancel();
    if (lost?.aborted) request.cancel();
    else lost?.addEventListener("abort", onLost, { once: true });
    const reply = (out) => {
      if (request.cancelled) return;
      request.answered = true;
      send({ jsonrpc: "2.0", id, ...out });
    };
    const token = msg.params?._meta?.progressToken;
    const notify = handleOpts.notify ?? send;
    let last = Number.NEGATIVE_INFINITY;
    const progress = (value, total, message) => {
      if (typeof token !== "string" && typeof token !== "number" || request.cancelled || request.answered) return;
      if (!Number.isFinite(value) || value <= last) return;
      last = value;
      const params = { progressToken: token, progress: value };
      if (total !== void 0 && Number.isFinite(total)) params.total = total;
      if (message && protocol >= PROGRESS_MESSAGE_SINCE) params.message = message;
      notify({ jsonrpc: "2.0", method: "notifications/progress", params });
    };
    const context = { signal: controller.signal, progress };
    try {
      if (typeof msg.method !== "string") {
        reply({ error: { code: ERR_INVALID_REQUEST, message: "invalid request: no `method`" } });
        return;
      }
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
          await handleToolCall(msg, reply, context);
          return;
        case "resources/list":
          reply({ result: { resources: listResources(opts.skillDir) } });
          return;
        // Part of the resources capability declared above; every resource is
        // a fixed document, so there are no templates to offer.
        case "resources/templates/list":
          reply({ result: { resourceTemplates: [] } });
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
          const name2 = typeof msg.params?.name === "string" ? msg.params.name : "";
          const args = msg.params?.arguments ?? {};
          try {
            if (!adapter.getPrompt) throw new PromptError(`unknown prompt: ${name2 || "(none given)"}`);
            reply({ result: adapter.getPrompt(name2, args) });
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
    } finally {
      if (active2.get(id) === request) active2.delete(id);
      lost?.removeEventListener("abort", onLost);
    }
  }
  async function handleToolCall(msg, reply, context) {
    const params = msg.params ?? {};
    const name2 = typeof params.name === "string" ? params.name : "";
    const rawArgs = params.arguments ?? {};
    if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      reply({ error: { code: ERR_INVALID_PARAMS, message: "`arguments` must be an object" } });
      return;
    }
    const args = rawArgs;
    const decl = listTools().find((t) => t.name === name2);
    if (!decl) {
      reply({ error: { code: ERR_INVALID_PARAMS, message: `unknown tool: ${name2 || "(none given)"}` } });
      return;
    }
    const invalid = validateArgs(decl.inputSchema, args);
    if (invalid) {
      reply({ error: { code: ERR_INVALID_PARAMS, message: invalid } });
      return;
    }
    try {
      const normalized = Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          decl.inputSchema.properties[key]?.type === "number" && typeof value === "string" ? Number(value) : value
        ])
      );
      const { text: raw, artifact, images } = await adapter.callTool(name2, normalized, context);
      const text = capResponse(raw, name2, maxBytes, artifact, adapter.capAdvice);
      const capped = text !== raw;
      const structured = protocol >= RICH_TOOLS_SINCE ? structuredContentFor(text, capped, decl.outputSchema !== void 0) : void 0;
      const pictures = (images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
      reply({ result: { content: [{ type: "text", text }, ...pictures], ...structured ? { structuredContent: structured } : {} } });
    } catch (e) {
      if (e instanceof InvalidParamsError) {
        reply({ error: { code: ERR_INVALID_PARAMS, message: e.message } });
        return;
      }
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
function forRevision(decl, protocol) {
  const { title, outputSchema, annotations, ...base2 } = decl;
  const out = { ...base2 };
  if (protocol >= RICH_TOOLS_SINCE) {
    if (title !== void 0) out.title = title;
    if (outputSchema !== void 0) out.outputSchema = outputSchema;
  }
  if (protocol >= ANNOTATIONS_SINCE && annotations) {
    out.annotations = title !== void 0 && annotations.title === void 0 ? { title, ...annotations } : annotations;
  }
  return out;
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
  const track3 = (p) => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };
  let active2 = 0;
  const waiting = [];
  const queued = /* @__PURE__ */ new Map();
  let negotiated;
  const handleOpts = { notify: send };
  const runToolCall = async (msg, id, reply) => {
    const ticket = { cancelled: false };
    queued.set(id, ticket);
    try {
      while (active2 >= MAX_IN_FLIGHT) await new Promise((resolve12) => waiting.push(resolve12));
    } finally {
      if (queued.get(id) === ticket) queued.delete(id);
    }
    if (ticket.cancelled) {
      waiting.shift()?.();
      return;
    }
    active2++;
    try {
      await server.handle(msg, reply, handleOpts);
    } finally {
      active2--;
      waiting.shift()?.();
    }
  };
  const dispatch2 = async (msg, reply) => {
    if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) {
      if (msg.method === "notifications/cancelled") {
        const target = msg.params?.requestId;
        const ticket = typeof target === "string" || typeof target === "number" ? queued.get(target) : void 0;
        if (ticket) ticket.cancelled = true;
      }
      if (msg.method === "tools/call" && (typeof msg.id === "string" || typeof msg.id === "number")) {
        await runToolCall(msg, msg.id, reply);
        return;
      }
    }
    await server.handle(msg, reply, handleOpts);
    if (msg?.method === "initialize") negotiated = server.protocolVersion();
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
      if (Array.isArray(parsed)) {
        const refusal2 = batchRefusal(parsed, negotiated);
        if (refusal2) {
          send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: refusal2 } });
          continue;
        }
        const batch = parsed;
        track3(
          (async () => {
            const out = [];
            await Promise.all(batch.map((m) => dispatch2(m, (r) => void out.push(r))));
            if (out.length) emit(JSON.stringify(out) + "\n");
          })().catch(reportInternal(send))
        );
        continue;
      }
      if (parsed === null || typeof parsed !== "object") {
        send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
        continue;
      }
      track3(dispatch2(parsed, send).catch(reportInternal(send)));
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
init_brand();
import { createHash as createHash5, timingSafeEqual } from "crypto";
var MCP_PATH = "/mcp";
var MAX_BODY_BYTES2 = 4 * 1024 * 1024;
var REQUEST_TIMEOUT_MS2 = 6e4;
var CORS_HEADERS = "content-type, accept, mcp-protocol-version, mcp-session-id, authorization, last-event-id";
var LOOPBACK_BIND = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "localhost"]);
async function startHttpServer(adapter, opts = {}) {
  const bind = opts.bind ?? "127.0.0.1";
  if (!LOOPBACK_BIND.has(bind) && !opts.allowRemote) {
    throw new Error(
      `refusing to bind ${bind}: ${brand().name}'s MCP server fetches arbitrary URLs and reads local files. Pass --allow-remote if that is really what you want.`
    );
  }
  const { createServer: createHttpServer } = await import("http");
  const server = createHttpServer((req, res) => {
    void route(req, res, adapter, opts).catch((e) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS2;
  server.headersTimeout = 6e4;
  server.keepAliveTimeout = 12e4;
  return new Promise((resolve12, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, bind, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
      const host = bind.includes(":") ? `[${bind}]` : bind;
      resolve12({
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
  if (opts.bearerToken !== void 0 && !bearerMatches(header(req, "authorization"), opts.bearerToken)) {
    sendJson(res, 401, { error: "this server needs `Authorization: Bearer <token>`" }, origin, { "www-authenticate": 'Bearer realm="mcp"' });
    return;
  }
  if (path !== MCP_PATH) {
    sendJson(res, 404, { error: `not found: ${path} (the MCP endpoint is ${MCP_PATH})` }, origin);
    return;
  }
  if (req.method === "GET" || req.method === "DELETE") {
    const why = `${req.method} is not supported: this server is stateless and offers no server-initiated stream`;
    sendJson(res, 405, { error: why }, origin, { allow: "POST, OPTIONS" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: `${req.method} is not supported` }, origin, { allow: "POST, OPTIONS" });
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
      sendJson(res, 413, { error: `request body exceeds ${MAX_BODY_BYTES2} bytes` }, origin);
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
  if (Array.isArray(parsed)) {
    const refusal2 = batchRefusal(parsed, declared);
    if (refusal2) {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: refusal2 } }, origin);
      return;
    }
  }
  const mcp = createServer(adapter, opts);
  mcp.setProtocolVersion(protocol);
  const lost = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) lost.abort();
  });
  const single = Array.isArray(parsed) ? void 0 : parsed;
  const token = single?.params?._meta;
  const asked = typeof single?.id === "string" || typeof single?.id === "number";
  if (asked && token?.progressToken !== void 0 && accept.includes("text/event-stream")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...corsHeaders(origin) });
    const event = (m) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: message
data: ${JSON.stringify(m)}

`);
    };
    await mcp.handle(single, event, { signal: lost.signal, notify: event });
    res.end();
    return;
  }
  const out = [];
  const collect = (m) => void out.push(m);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const m of messages) await mcp.handle(m, collect, { signal: lost.signal, notify: () => {
  } });
  if (out.length === 0) {
    res.writeHead(202, corsHeaders(origin));
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(parsed) ? out : out[0], origin);
}
function bearerMatches(sent, token) {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(sent ?? "");
  if (!m) return false;
  const digest = (s) => createHash5("sha256").update(s).digest();
  return timingSafeEqual(digest(m[1]), digest(token));
}
function header(req, name2) {
  const v = req.headers[name2];
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
var DRAIN_LIMIT = MAX_BODY_BYTES2 * 8;
function readBody(req) {
  return new Promise((resolve12, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES2) over = true;
    req.on("data", (c) => {
      size += c.length;
      if (over) {
        if (size > DRAIN_LIMIT) {
          req.destroy();
          reject(new Error("too large"));
        }
        return;
      }
      if (size > MAX_BODY_BYTES2) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) reject(new Error("too large"));
      else resolve12(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("client aborted the request")));
  });
}

// src/browser/doctor.ts
init_brand();
init_detect();
init_discovery();
init_extensions();
init_mode();
init_profile();
init_state();
import { readdirSync as readdirSync11 } from "fs";
import { join as join25 } from "path";
function listProfiles(home) {
  try {
    return readdirSync11(join25(home, "profiles"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}
var defaults = {
  detect: () => detectBrowserBinary(),
  home: browserHome,
  profiles: listProfiles,
  session: () => readSession(),
  alive: isPortAlive,
  fetchMode: () => browserFetchMode(),
  concurrency: () => envInt("BROWSER_CONCURRENCY", 1, 1, 4),
  env: (name2) => env(name2)
};
async function browserDoctor(own = {}) {
  const d = { ...defaults, ...own };
  let binary;
  try {
    const found = d.detect();
    binary = found ? { state: "found", kind: found.kind, path: found.path } : { state: "not found", hint: `install Chrome/Brave/Chromium/Edge or set ${envName("BROWSER_BIN")}` };
  } catch (e) {
    binary = { state: "error", error: e.message };
  }
  const home = d.home();
  const saved = d.session();
  let session = { state: "none" };
  if (saved) {
    const up = await d.alive(saved.port, saved.host ?? "127.0.0.1").catch(() => false);
    session = { state: up ? "alive" : "dead", port: saved.port, launchedByUs: saved.launchedByUs, profile: saved.profile };
  }
  const asked = d.env("BROWSER_KIND")?.trim();
  const kind = asked ? { value: asked, ...isBrowserKind(asked.toLowerCase()) ? {} : { error: `not one of ${BROWSER_KINDS.join(", ")}` } } : void 0;
  const rawExtensions = d.env("BROWSER_EXTENSIONS");
  let extensions;
  if (rawExtensions?.trim()) {
    try {
      const paths = extensionDirs(rawExtensions);
      const drops = binary.state === "found" && ignoresUnpackedExtensions({ kind: binary.kind, path: binary.path });
      extensions = { paths, ...drops ? { note: unpackedIgnoredNote() } : {} };
    } catch (e) {
      extensions = { paths: [], error: e.message };
    }
  }
  return {
    binary,
    home,
    profiles: d.profiles(home),
    session,
    fetch: { mode: d.fetchMode(), concurrency: d.concurrency() },
    ...kind ? { kind } : {},
    ...extensions ? { extensions } : {}
  };
}

// src/browser/mcp.ts
import { resolve as resolve10 } from "path";

// src/mcp/policy.ts
import { lookup as dnsLookup } from "dns/promises";
import { realpathSync as realpathSync3 } from "fs";
import { isIP } from "net";
import { isAbsolute as isAbsolute3, relative as relative3, resolve as resolve8, sep as sep3 } from "path";
var V4_NON_PUBLIC = [
  ["0.0.0.0", 8],
  // "this network" — 0.0.0.0 itself reaches the local host
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  // carrier-grade NAT, and Alibaba Cloud's metadata endpoint
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  // link-local: AWS, GCP, Azure and OpenStack metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  // multicast
  ["240.0.0.0", 4]
  // reserved, and the broadcast address
];
var v4Number = (ip) => ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
function v4Public(n) {
  return !V4_NON_PUBLIC.some(([base2, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(base2) / 2 ** (32 - bits)));
}
function v6Groups(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(":");
  const quad = s.slice(lastColon + 1);
  if (quad.includes(".")) {
    if (isIP(quad) !== 4) return void 0;
    const n = v4Number(quad);
    s = `${s.slice(0, lastColon + 1)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return void 0;
  const parse2 = (part) => part ? part.split(":").map((h) => /^[0-9a-f]{1,4}$/.test(h) ? Number.parseInt(h, 16) : Number.NaN) : [];
  const head = parse2(halves[0]);
  const tail = halves.length === 2 ? parse2(halves[1]) : [];
  const fill2 = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill2 < 0 : fill2 !== 0) return void 0;
  const groups = [...head, ...new Array(fill2).fill(0), ...tail];
  return groups.every((g) => Number.isInteger(g)) ? groups : void 0;
}
function embeddedV4(g) {
  const tail = g[6] * 65536 + g[7];
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0) {
    if (g[4] === 0 && (g[5] === 0 || g[5] === 65535)) return tail;
    if (g[4] === 65535 && g[5] === 0) return tail;
  }
  if (g[0] === 100 && g[1] === 65435 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return tail;
  if (g[0] === 8194) return g[1] * 65536 + g[2];
  return void 0;
}
function isPublicAddress(ip) {
  const kind = isIP(ip);
  if (kind === 4) return v4Public(v4Number(ip));
  if (kind !== 6) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  const v4 = embeddedV4(g);
  if (v4 !== void 0) return v4Public(v4);
  if ((g[0] & 57344) !== 8192) return false;
  if (g[0] === 8193 && (g[1] === 0 || g[1] === 3512 || g[1] === 2 && g[2] === 0)) return false;
  if ((g[0] & 65520) === 16368) return false;
  return true;
}
var systemLookup = (host) => dnsLookup(host, { all: true, verbatim: true });
async function publicUrlRefusal(url, lookup2 = systemLookup) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `${parsed.protocol} is not http(s)`;
  const host = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
  if (isIP(host)) return isPublicAddress(host) ? void 0 : `${host} is not a public address`;
  let addresses;
  try {
    addresses = await lookup2(host);
  } catch (e) {
    return `${host} did not resolve (${e.code ?? e.message})`;
  }
  if (!addresses.length) return `${host} did not resolve`;
  const inside = addresses.find((a) => !isPublicAddress(a.address));
  return inside ? `${host} resolves to ${inside.address}, which is not a public address` : void 0;
}
function publicUrlsOnly(lookup2) {
  return async (url) => await publicUrlRefusal(url, lookup2) === void 0;
}
function confinePath(root, requested) {
  const rootLex = resolve8(root);
  const rootReal = realpathSync3(root);
  const under = (base2, p) => {
    const rel = relative3(base2, p);
    return !isAbsolute3(rel) && rel !== ".." && !rel.startsWith(`..${sep3}`);
  };
  const outside = new Error(`${requested} is outside ${rootLex}, the only directory this server reads files from`);
  const target = resolve8(rootLex, requested);
  if (!under(rootLex, target) && !under(rootReal, target)) throw outside;
  let real;
  try {
    real = realpathSync3(target);
  } catch {
    throw new Error(`no such file under ${rootLex}: ${requested}`);
  }
  if (!under(rootReal, real)) throw outside;
  return real;
}
var MAX_TOOL_WAIT_MS = 3e5;
function toolTimeoutMs(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(MAX_TOOL_WAIT_MS, Math.max(1, Math.round(n))) : void 0;
}

// src/browser/mcp.ts
init_cli_kit();

// src/run-lock.ts
var chains = /* @__PURE__ */ new Map();
function withRunLock(slug, fn) {
  const prev = chains.get(slug) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(noop, noop);
  chains.set(slug, tail);
  tail.then(() => {
    if (chains.get(slug) === tail) chains.delete(slug);
  }, noop);
  return next;
}
function noop() {
}

// src/browser/mcp.ts
init_actions();
init_cli();
init_deps();
init_detect();
init_network();
init_profile();
init_risk();
init_session();
init_state();
var PREFIX = "webindex_browser_";
var RUN_LOCK = "\0browser-session";
var JPEG_QUALITY = 70;
var MAX_IMAGE_BYTES = 4 * 1024 * 1024;
var FOLLOW_UPS = {
  dialog: "answer it with webindex_browser_dialog (accept or dismiss)",
  waitClear: "webindex_browser_wait with condition clear",
  networkList: "webindex_browser_network with action list",
  capture: "webindex_browser_open with capture: true",
  textMore: "raise maxChars, or read one element (scope element with a ref or a selector)"
};
var DIALOG_SAFE = /* @__PURE__ */ new Set(["dialog", "status", "close", "network", "tabs"]);
var READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
var ACTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
var COMMITS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
var RETURNS = " Returns the result line, then a snapshot of the page after it: its refs are the current ones.";
var GUARDED = " One that looks irreversible \u2014 pay, order, delete, publish, send, validate, or submitting a password form \u2014 is refused unless confirm: true, which you set only after asking the user and getting their yes for this very action.";
var ref = (what) => ({
  type: "string",
  description: `The ref of ${what} (e.g. "e12"), from the latest snapshot \u2014 webindex_browser_snapshot's, or the one an action returns.`
});
var CONFIRM = {
  type: "boolean",
  description: "The user said yes to THIS action. Set it only after asking them; never on your own judgement."
};
var AFTER = {
  interactive: { type: "boolean", description: "List only what can be clicked or typed into in the snapshot returned (shorter)." },
  maxChars: { type: "number", description: "Cut the snapshot returned at this many characters (default 20000)." }
};
function tool(name2, title, hints, description, properties, required) {
  return {
    name: name2,
    title,
    description,
    inputSchema: { type: "object", properties, required },
    // Every browser tool reaches the web through a real browser.
    annotations: { ...hints, openWorldHint: true }
  };
}
function browserToolDecls() {
  return [
    tool(
      "webindex_browser_open",
      "Open a URL in the browser",
      ACTS,
      "Load a URL in the browser's current tab (a new one with newTab) and return where it landed, then a snapshot of the page: its accessibility tree, with a ref (e1, e2\u2026) on each element the other tools act on. The browser is a separate one on a dedicated profile, never the user's own, launched by the first browser call and kept for the server's life; logins made in it persist. With capture: true, the JSON the page fetches is recorded from then on (webindex_browser_network). A challenge (captcha, bot check) is named: let the human solve it in the window, then webindex_browser_wait with condition clear.",
      {
        url: { type: "string", description: "The URL to load." },
        newTab: { type: "boolean", description: "Open it in a new tab, which becomes the current one." },
        capture: { type: "boolean", description: "Record the JSON responses pages fetch from now on, until network clear or close." },
        profile: { type: "string", description: "The dedicated profile (default `default`), used when this call launches the browser." },
        headless: { type: "boolean", description: "No window, when this call launches the browser. A human cannot solve a challenge in it." },
        browserKind: {
          type: "string",
          enum: ["chrome", "brave", "chromium", "edge"],
          description: "Which browser to launch, when this call launches it (brave blocks ads and trackers on its own). A profile stays with the kind it was first launched with."
        },
        ...AFTER
      },
      ["url"]
    ),
    tool(
      "webindex_browser_snapshot",
      "Read the page as an accessibility tree",
      READS,
      "The current page as an accessibility tree with a ref (e1, e2\u2026) on each control, and on the containers worth scoping to (a table, a figure, an article, main, a form, a named region or image): the refs every other tool takes. A ref holds while its element lives; a stale one, or one of a document the tab has left, is refused with a request for a new snapshot. mode interactive keeps only what can be clicked or typed into (much shorter); a ref, or a CSS selector, scopes it to one element's subtree. Cut at maxChars (default 20000).",
      {
        mode: { type: "string", enum: ["full", "interactive"], description: "full: every element; interactive: only controls." },
        ref: ref("the element whose subtree to show"),
        selector: { type: "string", description: "A CSS selector: show the subtree of the first element it matches (not with ref)." },
        maxChars: { type: "number", description: "Cut at this many characters (default 20000)." }
      },
      ["mode"]
    ),
    tool(
      "webindex_browser_text",
      "Read the page's text",
      READS,
      "The text of the current tab, loading nothing: scope page reads its main content as webindex_fetch would (navigation and boilerplate left out, cookie walls, consent panels and other overlays stripped, even while one covers the page); scope element reads one element's text, by its ref or a CSS selector. markdown: true keeps headings, links and lists. Cut at maxChars (default 20000). Read an article or a list of results with it; the snapshot is for acting on the page.",
      {
        scope: { type: "string", enum: ["page", "element"], description: "page: the tab's main content; element: the element ref or selector names." },
        ref: ref("the element to read, with scope element"),
        selector: { type: "string", description: "With scope element and no ref: the first element this CSS selector matches." },
        markdown: { type: "boolean", description: "Markdown instead of plain text." },
        maxChars: { type: "number", description: "Cut at this many characters (default 20000)." }
      },
      ["scope"]
    ),
    tool(
      "webindex_browser_click",
      "Click an element",
      COMMITS,
      `Click an element, by its ref from the latest snapshot, as a person would: the mouse at its centre, refused if something covers it.${GUARDED}${RETURNS}`,
      { ref: ref("the element to click"), confirm: CONFIRM, ...AFTER },
      ["ref"]
    ),
    tool(
      "webindex_browser_hover",
      "Hover over an element",
      ACTS,
      `Move the mouse over an element (menus that open on hover).${RETURNS}`,
      { ref: ref("the element"), ...AFTER },
      ["ref"]
    ),
    tool(
      "webindex_browser_type",
      "Type into a text field",
      COMMITS,
      `Type text into a text field key by key, for fields that react to each keystroke (autocomplete, masks); webindex_browser_fill replaces a value in one go. submit: true presses Enter after it. An Enter that would submit a form is guarded:${GUARDED}${RETURNS}`,
      {
        ref: ref("the text field"),
        text: { type: "string", description: "What to type. A newline is an Enter." },
        submit: { type: "boolean", description: "Press Enter after the text." },
        confirm: CONFIRM,
        ...AFTER
      },
      ["ref", "text"]
    ),
    tool(
      "webindex_browser_fill",
      "Fill a text field",
      COMMITS,
      `Replace the content of a text field (input, textarea, contenteditable) with the text in one go, as a paste would, and check it took.${RETURNS}`,
      { ref: ref("the text field"), text: { type: "string", description: "The new content; none, or an empty one, clears the field." }, ...AFTER },
      ["ref"]
    ),
    tool(
      "webindex_browser_select",
      "Choose options of a select",
      COMMITS,
      `Choose options of a native <select> by value or visible label. A custom dropdown is not a select: click it, then click the option in the snapshot that returns.${RETURNS}`,
      { ref: ref("the <select>"), values: { type: "array", items: { type: "string" }, description: "Option values or visible labels." }, ...AFTER },
      ["ref", "values"]
    ),
    tool(
      "webindex_browser_press",
      "Press a key",
      COMMITS,
      `Press a key or a chord on whatever has focus: Enter, Escape, Tab, ArrowDown, Control+A\u2026 Enter in a form is guarded:${GUARDED}${RETURNS}`,
      { key: { type: "string", description: 'The key ("Enter", "Escape", "PageDown"\u2026) or chord ("Control+A").' }, confirm: CONFIRM, ...AFTER },
      ["key"]
    ),
    tool(
      "webindex_browser_upload",
      "Put files on a file input",
      COMMITS,
      `Put files of this server's machine on an <input type="file">: the ref of the input itself, often next to the visible button. With an extract root set, only files under it (a relative path is read from there). With none, any file could go, so it needs confirm: true \u2014 set it only after asking the user and naming the files to them: a page may try to talk you into uploading a private one (a key, a password store).${RETURNS}`,
      {
        ref: ref('the <input type="file">'),
        files: { type: "array", items: { type: "string" }, description: "Paths of the files." },
        confirm: { type: "boolean", description: "The user said yes to uploading THESE files (needed with no extract root). Only after asking them." },
        ...AFTER
      },
      ["ref", "files"]
    ),
    tool(
      "webindex_browser_scroll",
      "Scroll the page",
      ACTS,
      `Scroll the window (up or down by most of a screen, top, bottom) or bring an element into view. Returns the scroll position too.${RETURNS}`,
      { target: { type: "string", description: 'A ref ("e12"), or up, down, top or bottom.' }, ...AFTER },
      ["target"]
    ),
    tool(
      "webindex_browser_wait",
      "Wait for the page",
      READS,
      "Wait until a condition holds: a text appears (value), a text is gone, a CSS selector matches, the URL matches (a substring, or a /regex/), the page has loaded, the network is idle, a challenge is cleared \u2014 by the human, up to 5 minutes \u2014 or a number of ms (value). Returns which held and after how long; running out of timeoutMs (30 s by default, 300 s at most, as for ms) is an error.",
      {
        condition: { type: "string", enum: ["text", "gone", "selector", "url", "load", "idle", "clear", "ms"], description: "What to wait for." },
        value: { type: "string", description: "The text, selector or URL pattern; for ms, the number of milliseconds." },
        timeoutMs: { type: "number", description: "How long to wait at most." }
      },
      ["condition"]
    ),
    tool(
      "webindex_browser_screenshot",
      "Take a screenshot",
      READS,
      "A picture of the page, returned as an image (JPEG): the viewport, the full page, or one element (area element, with its ref or a CSS selector). An image over 4 MB is withheld: take one element, or the viewport.",
      {
        area: { type: "string", enum: ["viewport", "full", "element"], description: "What to capture." },
        ref: ref("the element to capture, with area element"),
        selector: { type: "string", description: "With area element and no ref: the first element this CSS selector matches." }
      },
      ["area"]
    ),
    tool(
      "webindex_browser_eval",
      "Run JavaScript in the page",
      COMMITS,
      "Evaluate a JavaScript expression in the page and return its value as JSON (a promise is awaited). It runs in the logged-in page, with the user's session, reads whatever the page holds and may change it: no snapshot follows it. Return plain data, only the fields you need. Never use it to do what the click and press guard would refuse \u2014 el.click() on a pay or delete button, form.submit() \u2014 use click or press, which ask for confirm on an irreversible action.",
      { expression: { type: "string", description: "The expression, e.g. document.title or [...document.links].map((a) => a.href)." } },
      ["expression"]
    ),
    tool(
      "webindex_browser_network",
      "Read what the page fetched",
      // Its clear deletes the log.
      COMMITS,
      "The JSON responses pages fetched (XHR/fetch) since webindex_browser_open with capture: true \u2014 often the cleanest data a JS-heavy site has. The tab's log keeps growing across calls until clear. list: number, method, status, URL of each; get: one body, by n; clear: empty the log and stop recording. Headers are never recorded.",
      {
        action: { type: "string", enum: ["list", "get", "clear"], description: "What to do with the log." },
        n: { type: "number", description: "The entry to get, from list." }
      },
      ["action"]
    ),
    tool(
      "webindex_browser_tabs",
      "List, open, select or close tabs",
      ACTS,
      "The browser's tabs, with short ids (t1, t2\u2026) that keep naming the same tab: list them, open a new one (on url), select the one to work in, or close one.",
      {
        action: { type: "string", enum: ["list", "new", "select", "close"], description: "What to do." },
        id: { type: "string", description: "The tab (t2), for select and close." },
        url: { type: "string", description: "For new: the URL to load in it." }
      },
      ["action"]
    ),
    tool(
      "webindex_browser_history",
      "Go back, forward or reload",
      ACTS,
      `Go back, forward, or reload the current tab, and wait for the page to load.${RETURNS}`,
      {
        action: { type: "string", enum: ["back", "forward", "reload"], description: "Where to go." },
        timeoutMs: { type: "number", description: "How long the page may take to load (30 s by default)." },
        ...AFTER
      },
      ["action"]
    ),
    tool(
      "webindex_browser_dialog",
      "Answer a JavaScript dialog",
      COMMITS,
      `Answer the JavaScript dialog the page shows (alert, confirm, prompt, beforeunload): accept, with promptText for a prompt, or dismiss. While one is open the page is frozen: every result says so, and the tools that read or act on the page are refused until it is answered. Accepting a dialog whose message looks irreversible (delete, pay, send\u2026) is refused unless confirm: true, which you set only after asking the user; dismissing never needs it.${RETURNS}`,
      {
        action: { type: "string", enum: ["accept", "dismiss"], description: "How to answer." },
        promptText: { type: "string", description: "The answer typed into a prompt, with accept." },
        confirm: CONFIRM,
        ...AFTER
      },
      ["action"]
    ),
    tool(
      "webindex_browser_status",
      "Show the browser's state",
      READS,
      "Whether the browser runs, on which port and profile, and whose it is (launched here, or attached to); with show tabs, its tabs too. Never launches one.",
      { show: { type: "string", enum: ["browser", "tabs"], description: "browser: one line; tabs: the tabs as well." } },
      ["show"]
    ),
    tool(
      "webindex_browser_close",
      "Close the browser",
      COMMITS,
      "Close the browser if it was launched here (one attached to is left running) and forget the session; the next browser call starts a new one. The refs and network logs go with it: of the tabs this session used (forget ours), or of every tab (forget all).",
      { forget: { type: "string", enum: ["ours", "all"], description: "Whose refs and network logs to delete." } },
      ["forget"]
    )
  ];
}
var SNAPSHOT_ADVICE = "pass `interactive: true`, or a smaller `maxChars`, for the snapshot it returns";
var BROWSER_CAP_ADVICE = {
  webindex_browser_open: SNAPSHOT_ADVICE,
  webindex_browser_snapshot: "pass mode `interactive`, a `ref` or a `selector` to scope it, or a smaller `maxChars`",
  webindex_browser_text: 'pass a smaller `maxChars`, or `scope: "element"` with a `ref` or a `selector`',
  webindex_browser_click: SNAPSHOT_ADVICE,
  webindex_browser_hover: SNAPSHOT_ADVICE,
  webindex_browser_type: SNAPSHOT_ADVICE,
  webindex_browser_fill: SNAPSHOT_ADVICE,
  webindex_browser_select: SNAPSHOT_ADVICE,
  webindex_browser_press: SNAPSHOT_ADVICE,
  webindex_browser_upload: SNAPSHOT_ADVICE,
  webindex_browser_scroll: SNAPSHOT_ADVICE,
  webindex_browser_history: SNAPSHOT_ADVICE,
  webindex_browser_dialog: SNAPSHOT_ADVICE,
  webindex_browser_wait: "nothing to narrow: a wait answers in one line",
  webindex_browser_screenshot: 'the text is one line; for a smaller image, `area: "element"` with a `ref` or a `selector`',
  webindex_browser_eval: "return less from the expression: only the fields you need",
  webindex_browser_network: "get one entry by `n` instead of the list",
  webindex_browser_tabs: "close the tabs you no longer need",
  webindex_browser_status: '`show: "browser"` answers in one line',
  webindex_browser_close: "nothing to narrow: closing answers in one line"
};
var str5 = (v) => typeof v === "string" && v !== "" ? v : void 0;
var num3 = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
var strings2 = (v) => Array.isArray(v) ? v.map(String) : [];
var after = (a) => ({
  snapshot: true,
  ...a.interactive === true ? { interactive: true } : {},
  ...num3(a.maxChars) !== void 0 ? { maxChars: num3(a.maxChars) } : {}
});
function refArg2(a) {
  const v = String(a.ref ?? "");
  if (!/^e\d+$/.test(v)) {
    throw new ToolError(
      "expected a ref like e12 from the latest snapshot; CSS selectors: pass `selector` to webindex_browser_screenshot, webindex_browser_snapshot or webindex_browser_text, or wait with condition selector"
    );
  }
  return v;
}
var confirmed = (a) => a.confirm === true ? { confirm: true } : {};
function annotate(text, notes) {
  if (notes.length === 0) return text;
  const cut = text.indexOf("\n");
  return cut < 0 ? [text, ...notes].join("\n") : [text.slice(0, cut), ...notes, text.slice(cut + 1)].join("\n");
}
function oneOf(a, key, values) {
  const v = a[key];
  if (typeof v === "string" && values.includes(v)) return v;
  throw new ToolError(`\`${key}\` must be one of ${values.join(", ")}`);
}
var Host = class {
  constructor(policy, deps) {
    this.policy = policy;
    this.deps = deps;
  }
  policy;
  deps;
  session;
  /** A dialog open on the current tab, heard from its events: reported until answered. */
  dialog;
  hooked;
  /** Whether `open … capture: true` asked to record, and the recorder doing it on the current tab. */
  capture = false;
  recording;
  /** The running call's cancel (calls run one at a time). */
  signal;
  call(name2, args, ctx) {
    return withRunLock(RUN_LOCK, async () => {
      try {
        if (ctx?.signal.aborted) throw new ToolError("the call was cancelled");
        this.signal = ctx?.signal;
        return await this.dispatch(name2, args);
      } catch (e) {
        throw e instanceof ToolError ? e : new ToolError(e instanceof Error ? e.message : String(e));
      }
    });
  }
  close() {
    return withRunLock(RUN_LOCK, () => this.locked(() => this.drop()).catch(() => this.drop()));
  }
  locked(fn) {
    return withBrowserLock(fn, { deps: browserDeps(this.deps.browser) });
  }
  live() {
    return this.session && !this.session.cdp.closed ? this.session : void 0;
  }
  async dispatch(name2, args) {
    const action = name2.startsWith(PREFIX) ? name2.slice(PREFIX.length) : "";
    const handler = Object.hasOwn(this.handlers, action) ? this.handlers[action] : void 0;
    if (!handler) throw new ToolError(`unknown tool: ${name2}`);
    if (!this.live()) this.dialog = void 0;
    if (this.dialog && !DIALOG_SAFE.has(action)) {
      throw new ToolError(
        `a JavaScript dialog is open (${this.dialog.type}: ${JSON.stringify(this.dialog.message)}) and the page is frozen until it is answered: ${FOLLOW_UPS.dialog}`
      );
    }
    const out = action === "status" && !this.live() ? await handler(args) : await this.locked(() => handler(args));
    const said = typeof out.json === "object" && out.json !== null && "dialog" in out.json;
    const notes = this.dialog && !said ? [dialogLine(this.dialog, FOLLOW_UPS)] : [];
    return { text: annotate(out.text, notes), ...out.images ? { images: out.images } : {} };
  }
  // --- the session -------------------------------------------------------------
  /**
   * Run a page command on the live session (opened, or opened again, as
   * needed), following it onto whatever tab it ends on. `capture` records
   * during this command already; it is kept only if the command succeeds.
   */
  async onPage(fn, o, run = {}) {
    let s = this.live();
    if (!s) {
      await this.drop();
      s = this.session = await openBrowserSession({ ...run.launch, ...this.deps.browser ? { deps: this.deps.browser } : {} });
    }
    if (o.newTab) await s.newTab();
    const capture = this.capture || run.capture === true;
    await this.follow(s, capture);
    let out;
    try {
      out = await fn(s);
    } catch (e) {
      if (!this.capture) await this.stopRecording();
      throw e;
    }
    await this.follow(s, capture);
    s.save();
    return out;
  }
  /** Listen for dialogs on the session's current tab, and record it when asked: a tab switch moves both. */
  async follow(s, capture) {
    if (this.hooked?.page.sessionId !== s.sessionId) {
      this.unhook();
      const page = s.page;
      const handlers = [
        ["Page.javascriptDialogOpening", (p) => this.dialog = { type: String(p?.type ?? "alert"), message: String(p?.message ?? "") }],
        ["Page.javascriptDialogClosed", () => this.dialog = void 0]
      ];
      for (const [m, h] of handlers) page.on(m, h);
      this.hooked = { page, handlers };
    }
    if (capture && this.recording?.targetId !== s.targetId) {
      await this.stopRecording();
      const recorder = new NetworkRecorder(s);
      await recorder.start();
      this.recording = { recorder, targetId: s.targetId };
    }
  }
  unhook() {
    if (this.hooked) for (const [m, h] of this.hooked.handlers) this.hooked.page.off(m, h);
    this.hooked = void 0;
    this.dialog = void 0;
  }
  /** Stop the recorder, keeping what it recorded in the tab's log. */
  async stopRecording() {
    const r = this.recording;
    this.recording = void 0;
    await r?.recorder.stop().catch(() => {
    });
  }
  /** Let go of the session: stop recording, stop listening, close the socket. The browser keeps running. */
  async drop() {
    await this.stopRecording();
    this.unhook();
    const s = this.session;
    this.session = void 0;
    await s?.detach().catch(() => {
    });
  }
  /** Run a `browser` action through the CLI handlers, on the live session, with results that name the tools. */
  async cli(action, args, flags, run = {}) {
    const r = await runBrowserCommand(action, args, flags, {
      ...this.deps,
      page: (fn, o) => this.onPage(fn, o, run),
      followUps: FOLLOW_UPS,
      ...this.signal ? { signal: this.signal } : {}
    });
    if (r.exitCode !== 0 && r.exitCode !== EXIT_HUMAN) throw new ToolError(r.text);
    return { text: r.text, json: r.json };
  }
  /** An upload path as the policy allows it: under the root, or not at all. */
  localFile(p) {
    const root = this.policy.extractRoot;
    if (root === void 0 && this.policy.noLocalFiles) throw new ToolError(`${p} is a path on this machine, and this server reads no local files.`);
    if (root === void 0) return resolve10(this.deps.cwd ?? process.cwd(), p);
    try {
      return confinePath(root, p);
    } catch (e) {
      throw new ToolError(e.message);
    }
  }
  // --- the tools -----------------------------------------------------------------
  handlers = {
    open: async (a) => {
      const profile = str5(a.profile);
      const kind = a.browserKind === void 0 ? void 0 : oneOf(a, "browserKind", BROWSER_KINDS);
      const launch2 = { ...profile ? { profile } : {}, ...a.headless === true ? { headless: true } : {}, ...kind ? { kind } : {} };
      const running = this.live();
      const otherKind = running && kind !== void 0 && (!running.launchedByUs || readProfileKind(running.profile) !== kind);
      const moot = running && (profile !== void 0 && profile !== running.profile || a.headless === true && !running.headless || otherKind);
      const capture = a.capture === true;
      const out = await this.cli("open", [String(a.url ?? "")], { ...after(a), ...a.newTab === true ? { newTab: true } : {} }, { launch: launch2, capture });
      if (capture) this.capture = true;
      const notes = [
        ...moot ? [
          `profile, headless and browserKind apply only when this call launches the browser; one is already running on profile ${running.profile}${running.headless ? ", headless" : ""} (webindex_browser_close first to change them)`
        ] : [],
        ...capture ? [`recording the JSON pages fetch \u2014 ${FOLLOW_UPS.networkList}`] : []
      ];
      return { ...out, text: annotate(out.text, notes) };
    },
    snapshot: (a) => {
      const mode2 = oneOf(a, "mode", ["full", "interactive"]);
      const r = a.ref === void 0 ? void 0 : refArg2(a);
      const selector = str5(a.selector);
      if (r !== void 0 && selector !== void 0) throw new ToolError("a snapshot is scoped to a `ref` or to a `selector`, not both");
      return this.cli("snapshot", r ? [r] : [], {
        interactive: mode2 === "interactive",
        ...selector !== void 0 ? { selector } : {},
        ...num3(a.maxChars) !== void 0 ? { maxChars: num3(a.maxChars) } : {}
      });
    },
    text: (a) => {
      const scope = oneOf(a, "scope", ["page", "element"]);
      const r = a.ref === void 0 ? void 0 : refArg2(a);
      const selector = str5(a.selector);
      if (scope === "page" && (r !== void 0 || selector !== void 0)) throw new ToolError('`ref` and `selector` go with scope "element"');
      if (scope === "element" && r !== void 0 && selector !== void 0) throw new ToolError('scope "element" takes a `ref` or a `selector`, not both');
      if (scope === "element" && r === void 0 && selector === void 0)
        throw new ToolError('scope "element" needs a `ref` or a `selector`: the element to read, from the latest snapshot');
      return this.cli("text", r !== void 0 ? [r] : [], {
        ...selector !== void 0 ? { selector } : {},
        ...a.markdown === true ? { markdown: true } : {},
        ...num3(a.maxChars) !== void 0 ? { maxChars: num3(a.maxChars) } : {}
      });
    },
    click: (a) => this.cli("click", [refArg2(a)], { ...after(a), ...confirmed(a) }),
    hover: (a) => this.cli("hover", [refArg2(a)], after(a)),
    type: (a) => this.cli("type", [refArg2(a), String(a.text ?? "")], { ...after(a), ...confirmed(a), ...a.submit === true ? { submit: true } : {} }),
    fill: (a) => this.cli("fill", [refArg2(a), String(a.text ?? "")], after(a)),
    select: (a) => this.cli("select", [refArg2(a), ...strings2(a.values)], after(a)),
    press: (a) => this.cli("press", [String(a.key ?? "")], { ...after(a), ...confirmed(a) }),
    upload: (a) => {
      const files = strings2(a.files).map((f) => this.localFile(f));
      if (this.policy.extractRoot === void 0 && a.confirm !== true) {
        throw new ToolError(
          `uploading ${files.join(", ")} needs confirm: true: with no extract root, any file of this machine could go \u2014 ask the user, naming the files, then retry with confirm: true`
        );
      }
      return this.cli("upload", [refArg2(a), ...files], after(a));
    },
    scroll: (a) => this.cli("scroll", [String(a.target ?? "")], after(a)),
    history: (a) => {
      const action = oneOf(a, "action", ["back", "forward", "reload"]);
      const timeout = toolTimeoutMs(a.timeoutMs);
      return this.cli(action, [], { ...after(a), ...timeout !== void 0 ? { timeout } : {} });
    },
    dialog: async (a) => {
      const answer = oneOf(a, "action", ["accept", "dismiss"]);
      const prompt = answer === "accept" && typeof a.promptText === "string" ? [a.promptText] : [];
      const risk = answer === "accept" && a.confirm !== true && this.dialog ? assessDialog(this.dialog.type, this.dialog.message) : void 0;
      if (risk?.risky && this.dialog) {
        throw new ToolError(
          `refused to accept the ${this.dialog.type} dialog ${JSON.stringify(this.dialog.message)}: ${risk.reason}; ask the user, then retry with confirm: true (or dismiss it)`
        );
      }
      try {
        const out = await this.cli("dialog", [answer, ...prompt], after(a));
        this.dialog = void 0;
        return out;
      } catch (e) {
        if (e instanceof ToolError && e.message === "no dialog is open") this.dialog = void 0;
        throw e;
      }
    },
    wait: (a) => {
      const condition = oneOf(a, "condition", ["text", "gone", "selector", "url", "load", "idle", "clear", "ms"]);
      const limit = toolTimeoutMs(a.timeoutMs);
      const timeout = limit !== void 0 ? { timeout: limit } : {};
      if (condition === "load" || condition === "idle" || condition === "clear") return this.cli("wait", [], { [condition]: true, ...timeout });
      const value = str5(a.value);
      if (value === void 0) throw new ToolError(`\`value\` is required with condition ${condition}`);
      if (condition !== "ms") return this.cli("wait", [], { [condition]: value, ...timeout });
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 0) throw new ToolError(`\`value\` is a number of milliseconds with condition ms, not ${JSON.stringify(value)}`);
      return this.cli("wait", [], { ms: Math.min(ms, MAX_TOOL_WAIT_MS), ...timeout });
    },
    eval: (a) => this.cli("eval", [String(a.expression ?? "")], {}),
    network: async (a) => {
      const action = oneOf(a, "action", ["list", "get", "clear"]);
      this.recording?.recorder.flush();
      if (action === "clear") {
        await this.stopRecording();
        this.capture = false;
        return this.cli("network", ["clear"], {});
      }
      if (action === "list") return this.cli("network", ["list"], {});
      const n = num3(a.n);
      if (n === void 0) throw new ToolError("`n` is required to get an entry: its number in the list");
      return this.cli("network", ["get", String(n)], {});
    },
    tabs: (a) => {
      const action = oneOf(a, "action", ["list", "new", "select", "close"]);
      if (action === "list") return this.cli("tabs", ["list"], {});
      if (action === "new") return this.cli("tabs", ["new", ...str5(a.url) ? [str5(a.url)] : []], {});
      const id = str5(a.id);
      if (id === void 0) throw new ToolError(`\`id\` is required to ${action} a tab: its id in the list (t2)`);
      return this.cli("tabs", [action, id], {});
    },
    screenshot: async (a) => {
      const area2 = oneOf(a, "area", ["viewport", "full", "element"]);
      const r = a.ref === void 0 ? void 0 : refArg2(a);
      const selector = str5(a.selector);
      if (area2 !== "element" && (r !== void 0 || selector !== void 0)) throw new ToolError('`ref` and `selector` go with area "element"');
      if (area2 === "element" && r !== void 0 && selector !== void 0) throw new ToolError('area "element" takes a `ref` or a `selector`, not both');
      if (area2 === "element" && r === void 0 && selector === void 0)
        throw new ToolError('`ref` is required with area "element": the element to capture, from the latest snapshot (or a CSS `selector`)');
      const element2 = r !== void 0 ? { ref: r } : { selector };
      const bytes = await this.onPage(
        (s) => screenshot(s, { format: "jpeg", quality: JPEG_QUALITY, ...area2 === "element" ? element2 : area2 === "full" ? { full: true } : {} }),
        {}
      );
      const size = bytes.length >= 1024 * 1024 ? `${(bytes.length / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes.length / 1024)} KB`;
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new ToolError(`the screenshot is ${size}, over the 4 MB an answer may carry: take one element (area: "element" with a ref), or the viewport`);
      }
      const what = area2 === "element" ? r ?? selector : area2 === "full" ? "the full page" : "the viewport";
      return { text: `screenshot of ${what} (JPEG, ${size})`, images: [{ data: bytes.toString("base64"), mimeType: "image/jpeg" }] };
    },
    status: async (a) => {
      const show2 = oneOf(a, "show", ["browser", "tabs"]);
      const s = this.live();
      const text = statusText(s ? await s.status() : await browserStatus(this.deps.browser ? { deps: this.deps.browser } : {}));
      const head = show2 === "tabs" ? text : text.split("\n")[0];
      return { text: annotate(head, this.recording ? [`recording the JSON pages fetch \u2014 ${FOLLOW_UPS.networkList}`] : []) };
    },
    close: async (a) => {
      const forget2 = oneOf(a, "forget", ["ours", "all"]);
      const profile = this.session?.profile;
      await this.drop();
      this.capture = false;
      return this.cli("close", [], { ...forget2 === "all" ? { all: true } : {}, ...profile !== void 0 ? { profile } : {} });
    }
  };
};
function createBrowserToolHost(opts = {}) {
  return new Host(opts.policy ?? {}, opts.deps ?? {});
}

// src/cli.ts
configure({ name: "webindex", envPrefix: "WEBINDEX", cli: "webindex", contactUrl: "https://github.com/maxgfr/webindex" });
var HELP = `webindex v${ENGINE_VERSION}
Find pages with a local keyless search stack, turn a URL or a file into clean,
citable text \u2014 HTML, PDFs through a six-rung ladder ending in OCR, and office
documents \u2014 and serve that to an agent over MCP. Zero dependencies, no API key.

USAGE
  webindex search <query> [--json] [--limit <n>] [--pages <n>] [--lang <tag>]
                          [--region <cc>|wt] [--engine ddg|ddglite|mojeek|off]
                          [--searxng <base>|off] [--firecrawl <base>|off]
                          [--timeout <ms>]
  webindex fetch <url> [<url> \u2026] [--json] [--format text|markdown]
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
  webindex browser   fill <ref> <text> | select <ref> <val\u2026> | press <key> [--confirm]
  webindex browser   upload <ref> <file\u2026> | scroll <ref|up|down|top|bottom>
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
             engines (DuckDuckGo, DDG Lite, Mojeek \u2014 no key, no container),
             then Firecrawl. Prints what it found, or says which backend was
             missing and how to start it \u2014 those are different answers.
             --lang is the result language; --region a country overriding
             the one it implies (fr + ca is Canadian French), or wt for none.
             --timeout bounds the WHOLE cascade, every rung and page; the
             rungs it never reached are named. --json adds each rung's
             outcome (rungs) and whether anything answered (searched).
  fetch      Fetch a URL and print the extracted text. Routes PDFs and office
             documents to their ladders automatically \u2014 by URL, content-type,
             download filename or the bytes themselves; images, media and
             archives get a note, never their bytes. Uses Firecrawl when
             available, with built-in extraction as fallback. HTML is reduced
             to main content with consent banners dropped; --full-page keeps
             the whole page through the built-in reader, navigation, footer and
             consent banners included. --format markdown writes an HTML page as
             CommonMark \u2014 links and images absolute, code fenced, lists and
             tables kept \u2014 the shape Firecrawl returns (the default, text,
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
             every one of them did. A video URL \u2014 YouTube, Vimeo, Dailymotion,
             Twitch, TED, Loom, TikTok and the other common hosts \u2014 returns
             its transcript as Markdown, one [mm:ss] stamp per paragraph and
             a heading per chapter: manual subtitles, else the video's own
             auto-captions (never a machine translation), else a local
             whisper transcription \u2014 through yt-dlp, which has to be
             installed. A post on such a host with no video is read as a page.
             --browser renders the page in the dedicated browser (see browser),
             for a page only JavaScript fills; WEBINDEX_BROWSER_FETCH=fallback
             does it only when the plain read is refused, walled or near empty.
  extract    Same extraction, on a file already on disk (- reads stdin),
             recognised by its bytes when its name says otherwise. --full-page
             keeps the whole HTML page, navigation and consent banners included;
             --format markdown writes it as CommonMark, as fetch does. Plain
             text and documents keep their text either way.
  rank       Order candidate documents against a question \u2014 BM25F, then a
             near-duplicate collapse, then MMR so the top says several
             different things. Reads a JSON array of {url,title,text} from
             --docs or stdin; a document's own "score" (a search engine's
             relevance) is fused with BM25F by rank, but never lifts one that
             shares no term with the question. Each collapsed mirror is named
             on stderr (in "duplicates" with --json). MMR reorders the best
             max(5 \xD7 --limit, 100); the rest follow by relevance. Warns when no
             document contains any term of the question. Deterministic; no
             model, no network \u2014 unless --dense fuses in the local embedding
             lane first (as hybrid does), which degrades to BM25F with a note
             when no embedding server answers.
  repo       A repository's own facts: stars, licence, default branch, last
             push, and whether it is archived \u2014 the record, not the README.
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
  tags       Its tags \u2014 the versions of a project that tags without
             publishing releases.
  package    A library NAME resolved through npm, PyPI or crates.io to its
             repository, docs, current version, licence and deprecation.
             --version answers for that version (or an npm dist-tag) or not
             at all. A registry that cannot be reached stops the search, so
             another ecosystem's namesake never answers in its place.
  meta       What a page says about itself: JSON-LD, OpenGraph and meta tags \u2014
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
  mcp        Serve these commands to an agent as MCP tools \u2014 search, fetch,
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
             written. The stack is EMBEDDED in this binary \u2014 no checkout needed.
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
             Dev-time only \u2014 it reads a repo, it never runs inside one.
  video      A video kept on disk, so a question about it never reads it
             twice \u2014 any page yt-dlp reads: YouTube, Vimeo, Dailymotion and
             hundreds more. 'fetch' writes <dir>/<key>/TRANSCRIPT.md (the key
             is the YouTube id, else site-id: vimeo-76979871; what fetch
             prints for a video), segments.json and meta.json, and reuses them
             on the next call \u2014 no yt-dlp at all \u2014 unless --refresh. 'search'
             ranks ~45 s passages of every video under --out (or of one video's
             own directory) against a question, each with its [mm:ss] stamp
             and a link that opens the video there. 'frames' takes what is
             on screen \u2014 a frame at every scene change and chapter start,
             near-duplicates dropped, at most 20, 50 or 100 by --effort (med
             by default) \u2014 into <id>/frames/, and FRAMES.md pairs each with
             what was said from 5 s before it to 10 s after; it needs ffmpeg,
             and fetches the video first when given a URL. 'list' reads the
             first --limit videos (default 10) of a playlist or channel on any
             site, two at a time, and writes CORPUS.md naming them V1\u2026Vn;
             'search' on that directory then labels its hits V1\u2026Vn. The directory is --out,
             else WEBINDEX_VIDEO_DIR, else <tmp>/webindex/video.
  browser    Drive a real Chrome, Brave, Chromium or Edge for an agent: a
             SEPARATE browser on a dedicated profile, never your own, launched
             on first use (headed unless --headless) and reused by every later
             call, its tab and refs included. attach <port|url> (or --cdp)
             drives one on a loopback port; close shuts down only a browser it
             launched. snapshot prints the accessibility tree with refs (e12)
             on controls and containers (table, figure\u2026); a ref or --selector
             scopes snapshot, screenshot, text and an action's --snapshot. text
             reads the tab's main content as fetch does, overlays stripped. A
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
                         document ("none" for none); default from the model \u2014 nomic's
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
  WEBINDEX_NO_ROBOTS     robots and crawl do not consult robots.txt \u2014 only on a site you own
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
                         paths, comma separated (an ad blocker); branded Chrome \u2265 137 ignores them
  WEBINDEX_BROWSER_FETCH fetch renders pages in that browser: always, fallback or off (default)
  GITHUB_TOKEN, GH_TOKEN, GITLAB_TOKEN, GITEA_TOKEN
                         optional forge tokens (WEBINDEX_GITHUB_TOKEN and its kin win over
                         them); each goes only to github.com, gitlab.com, or a host listed
                         in WEBINDEX_FORGE_HOSTS
  WEBINDEX_FORGE_HOSTS   self-hosted forges, e.g. "salsa.debian.org=gitlab,git.corp=github":
                         each is queried as that forge and receives that forge's token
  WEBINDEX_NO_GH         never reach for the gh CLI on github.com \u2014 plain HTTP only
  WEBINDEX_DOCKER_PULL_TIMEOUT_MS  the image-pull budget of up (default 1200000)

The README lists every variable, the library-only ones included.
Every optional helper degrades to a note. Nothing here needs an API key.`;
var VALUE_FLAGS = [
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
  "ms"
];
var BOOL_FLAGS = [
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
  "force"
];
var COMMANDS = [
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
  "stack"
];
var SPEC = { commands: COMMANDS, valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS };
var SKILL_ACTIONS = ["check", "bundle", "vendor", "copy", "doctor", "init", "repin", "finish", "recall"];
var VIDEO_ACTIONS = ["fetch", "search", "frames", "list"];
var YTDLP_STALE_DAYS = 60;
function fail(msg) {
  process.stderr.write(`webindex: ${msg}
`);
  process.exit(EXIT_FAILURE);
}
function usage(msg) {
  process.stderr.write(`webindex: ${msg}
`);
  process.exit(EXIT_USAGE);
}
function argFormat(args) {
  const format = argValue(args, "format") ?? "text";
  if (format !== "text" && format !== "markdown") throw new UsageError(`--format expects text or markdown, got "${format}"`);
  return format;
}
function argTimeout(args) {
  const ms = argInt(args, "timeout");
  if (ms !== void 0 && ms < 1) throw new UsageError(`--timeout expects a positive number of milliseconds, got "${ms}"`);
  return ms;
}
function mcpPolicy(args, allowRemote) {
  const allowPrivate = argBool(args, "allow-private");
  if (allowPrivate && argBool(args, "public-only")) usage("--public-only and --allow-private contradict each other");
  const publicOnly = !allowPrivate && (argBool(args, "public-only") || envFlag("PUBLIC_ONLY") || allowRemote);
  const browser = argBool(args, "browser");
  if (browser && allowRemote)
    usage("--browser and --allow-remote contradict each other: the browser tools drive a logged-in browser on this machine, for it alone");
  if (browser && publicOnly) {
    usage(
      `--browser and --public-only (or ${envName("PUBLIC_ONLY")}) contradict each other: a browser follows any address a page leads it to, private ones included`
    );
  }
  const rootArg = argValue(args, "extract-root") ?? env("EXTRACT_ROOT");
  let extractRoot;
  if (rootArg !== void 0) {
    extractRoot = resolve11(rootArg);
    let isDir = false;
    try {
      isDir = statSync12(extractRoot).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) usage(`--extract-root ${rootArg} is not a directory`);
  }
  return {
    publicOnly,
    ...extractRoot !== void 0 ? { extractRoot } : allowRemote ? { noLocalFiles: true } : {},
    ...browser ? { browser } : {},
    ...allowRemote ? { remote: true } : {}
  };
}
function mcpPolicyNotice(policy, allowRemote, allowPrivate) {
  const lines = [];
  if (policy.publicOnly) lines.push(`fetches: public addresses only${allowRemote ? " (the --allow-remote default; --allow-private lifts it)" : ""}.`);
  else if (allowRemote && allowPrivate) lines.push("fetches: any address, this machine's own network included (--allow-private).");
  if (policy.extractRoot !== void 0) lines.push(`local files: only under ${policy.extractRoot}.`);
  else if (policy.noLocalFiles) lines.push("local files: none, and webindex_extract is off (--extract-root <dir> offers one directory).");
  if (policy.browser) lines.push("browser: the webindex_browser_* tools drive a separate browser on this machine; irreversible actions need confirm: true.");
  return lines;
}
var SEARCH_TOOL_BUDGET_MS = 45e3;
var SEARCH_TOOL_MAX_PAGES = 5;
var FORGE_KINDS = ["github", "gitlab", "gitea"];
var isForgeKind = (v) => FORGE_KINDS.includes(v);
var isRegistryKind = (v) => v === "npm" || v === "pypi" || v === "crates";
var FORGE_ARG = {
  type: "string",
  description: "Which forge a self-hosted host runs when its name does not say (salsa.debian.org is gitlab). Omit for github.com, gitlab.com, Codeberg.",
  enum: [...FORGE_KINDS]
};
var FORMAT_ARG = {
  type: "string",
  description: "The shape of an HTML page's text: text (default; headings kept as #, the rest flattened) or markdown (CommonMark with absolute links, fenced code, lists and tables \u2014 the shape Firecrawl returns). PDFs and office documents keep their text either way.",
  enum: ["text", "markdown"]
};
var fetchFailure = (r) => r.status ? `status ${r.status}` : r.error ?? "no answer";
function forgeTarget(raw, kind) {
  const opts = kind ? { kind } : {};
  return forgeRef(resolveRepo(raw, opts), opts);
}
async function extractLocal(path, fullPage = false, given, format = "text") {
  let bytes;
  try {
    bytes = given ?? readFileSync19(path);
  } catch (e) {
    throw new ToolError(`cannot read ${path}: ${e.message}`);
  }
  const asUrl = pathToFileURL(path).href;
  const sniffed = sniffDocument(bytes);
  if (sniffed === "pdf" || !sniffed && looksLikePdfUrl(asUrl)) {
    const r = await extractPdf(bytes);
    return { text: r.text, extractor: r.via ?? "none", reason: r.reason, consentDropped: 0 };
  }
  const fmt = sniffed ?? docFormatForUrl(asUrl);
  if (fmt) {
    const r = await extractDocument(bytes, fmt);
    if (!r.text && fmt.textFallback) return { text: decodeLocal(bytes, { sniffHtmlCharset: false }), extractor: "plain", consentDropped: 0 };
    return { text: r.text, extractor: r.via ?? "none", reason: r.reason, consentDropped: 0 };
  }
  const extension = extname(path).toLowerCase();
  const explicitText = [".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".xml", ".yaml", ".yml"].includes(extension);
  const raw = decodeLocal(bytes, { sniffHtmlCharset: !explicitText });
  if (raw.slice(0, 1024).includes("\0")) return { text: "", extractor: "none", reason: "binary data, not a text document", consentDropped: 0 };
  const looksHtml = !explicitText && ([".html", ".htm", ".xhtml"].includes(extension) || /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(raw));
  const markdown = format === "markdown";
  const main2 = looksHtml && !fullPage ? extractMainHtml(raw) : raw;
  const text = !looksHtml ? raw : markdown ? markdownAgainst(main2, documentBaseUrl(raw), fullPage) : htmlToText(main2, { fullPage });
  const consent = looksHtml && !fullPage ? stripConsentBoilerplate(text, { markdown }) : { text, dropped: 0 };
  return { text: consent.text, extractor: looksHtml ? "native" : "plain", consentDropped: consent.dropped };
}
async function tagCommit(repo, tag) {
  let viaGh;
  if (have("gh")) {
    try {
      return releaseCommit(repo, tag);
    } catch (e) {
      viaGh = e.message.trim().split("\n")[0];
    }
  }
  const r = await httpJson("GET", `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(tag)}`, void 0, {
    accept: "application/vnd.github+json",
    headers: forgeAuthHeaders("github", "api.github.com")
  });
  const sha = r.ok ? r.data?.sha : void 0;
  if (typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)) return sha;
  throw new ToolError(
    `could not resolve ${repo}@${tag} to a commit \u2014 GitHub answered ${r.status ? `HTTP ${r.status}` : r.error ?? "nothing"}${viaGh ? `, and gh said: ${viaGh}` : ""}`
  );
}
function competitionRanks(values) {
  const order = values.map((_, i) => i).sort((a, b) => values[b] - values[a]);
  const ranks = new Array(values.length);
  order.forEach((i, p) => {
    const prev = order[p - 1];
    ranks[i] = prev !== void 0 && values[prev] === values[i] ? ranks[prev] : p + 1;
  });
  return ranks;
}
var MMR_WINDOW = 100;
async function rankDocuments(question, docs, opts = {}) {
  const { limit } = opts;
  const bm = docs.map((d, i) => ({ id: String(i), title: d.title ?? "", headings: d.headings ?? "", body: d.text ?? "" }));
  const bodyTokens = bm.map((d) => bm25Tokenize(d.body));
  const index = buildBm25Index(question, bm, { tokensOf: (d) => bodyTokens[Number(d.id)] });
  const raw = bm.map((d) => bm25Score(index, d));
  const lanes = [];
  if (docs.some((d) => d.score !== void 0)) {
    const ranks = competitionRanks(docs.map((d) => d.score ?? Number.NEGATIVE_INFINITY));
    lanes.push(docs.map((d, i) => d.score === void 0 ? void 0 : ranks[i]));
  }
  const notes = [];
  let dense = false;
  if (opts.dense) {
    const h = await hybridSearch(question, bm);
    const ranks = new Array(bm.length);
    for (const hit of h.hits) if (hit.denseRank !== void 0) ranks[Number(hit.doc.id)] = hit.denseRank;
    dense = ranks.some((r) => r !== void 0);
    if (dense) lanes.push(ranks);
    else notes.push(h.note ?? "the dense lane returned nothing \u2014 ranked with BM25F only.");
  }
  let relevance = raw;
  if (lanes.length) {
    const k = envInt("RRF_K", 60);
    const lexical = competitionRanks(raw);
    const fused = raw.map((s, i) => {
      if (!dense && !(s > 0)) return 0;
      let f = 1 / (k + lexical[i]);
      for (const lane of lanes) if (lane[i] !== void 0) f += 1 / (k + lane[i]);
      return f;
    });
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (const f of fused) {
      if (f > 0 && f < lo) lo = f;
      if (f > hi) hi = f;
    }
    const floor = 0.01;
    relevance = fused.map((f) => !(f > 0) ? 0 : hi > lo ? floor + (1 - floor) * (f - lo) / (hi - lo) : 1);
  }
  if (!dense && index.queryTerms.length && raw.every((s) => !(s > 0))) {
    notes.push("no document contains any term of the question \u2014 the order is not a relevance ranking.");
  }
  let max = 1e-9;
  for (const r of relevance) if (r > max) max = r;
  const scored = docs.map((d, i) => ({
    url: d.url,
    title: d.title,
    text: d.text ?? "",
    score: (relevance[i] ?? 0) / max,
    matched: bm25MatchedTerms(index, bm[i]),
    tokens: bodyTokens[i]
  }));
  scored.sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const { items: unique, dropped, duplicates } = dedupeNearDuplicates(scored, { tokensOf: (it) => it.tokens });
  const window = Math.max((limit && limit > 0 ? limit : 0) * 5, MMR_WINDOW);
  const ordered = diversify(unique, (it) => it.tokens, 0.75, { window });
  const ranked = ordered.slice(0, limit && limit > 0 ? limit : void 0).map((it, i) => ({
    rank: i + 1,
    url: it.url,
    ...it.title ? { title: it.title } : {},
    score: Number(it.score.toFixed(4)),
    matched: it.matched
  }));
  return { ranked, collapsed: dropped, duplicates, queryTerms: index.queryTerms, ...notes.length ? { note: notes.join(" ") } : {} };
}
function parseJsonInput(text, label, expected) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON (${e.message}) \u2014 ${expected}`);
  }
}
function readDocsInput(args, usageLine) {
  const src = argValue(args, "docs");
  if (src === void 0 && process.stdin.isTTY) usage(usageLine);
  const label = `--docs ${src === void 0 || src === "-" ? "(stdin)" : src}`;
  try {
    return { text: readFileSync19(src === void 0 || src === "-" ? 0 : src, "utf8"), label };
  } catch (e) {
    fail(`cannot read ${src === void 0 || src === "-" ? "stdin" : src}: ${e.message}`);
  }
}
function readStdin(usageLine) {
  if (process.stdin.isTTY) usage(usageLine);
  try {
    return readFileSync19(0);
  } catch (e) {
    fail(`cannot read stdin: ${e.message}`);
  }
}
async function readPage(target, accept, usageLine) {
  if (/^https?:\/\//i.test(target)) {
    const page = await httpGet(target, { accept });
    if (!page.ok) fail(`could not fetch ${target} (status ${page.status})`);
    return { body: page.body, url: page.url };
  }
  let bytes;
  if (target === "-") bytes = readStdin(usageLine);
  else {
    try {
      bytes = readFileSync19(target.startsWith("file:") ? fileURLToPath2(target) : target);
    } catch (e) {
      fail(`${target} is neither an http(s) URL nor a readable file (${e.code ?? e.message})`);
    }
  }
  const body = decodeLocal(bytes, { sniffHtmlCharset: true });
  if (body.slice(0, 1024).includes("\0")) fail(`${target === "-" ? "stdin" : target} is binary data, not an HTML page`);
  return { body };
}
var RANK_DOCS_SHAPE = "pass a JSON array of {url, text} via --docs <file> or stdin";
function parseRankDocs(value, where2) {
  const arr = typeof value === "string" ? parseJsonInput(value, where2, "pass a JSON array of {url, text}") : value;
  if (!Array.isArray(arr) || !arr.length) throw new Error(`${where2} must be a non-empty JSON array of {url, text}`);
  return arr.map((d, i) => {
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(`${where2}[${i}] is not an object`);
    const url = d.url;
    if (typeof url !== "string" || !url) throw new Error(`${where2}[${i}] has no url`);
    for (const field of ["title", "headings", "text"]) {
      if (d[field] !== void 0 && typeof d[field] !== "string") throw new Error(`${where2}[${i}].${field} must be a string`);
    }
    if (d.score !== void 0 && (typeof d.score !== "number" || !Number.isFinite(d.score))) {
      throw new Error(`${where2}[${i}].score must be a finite number`);
    }
    return d;
  });
}
var CLOSED_WORLD_TOOLS = /* @__PURE__ */ new Set(["webindex_extract", "webindex_rank", "webindex_embed", "webindex_video_search"]);
function toolLimit(raw, def, max = 50) {
  const n = typeof raw === "number" ? Math.trunc(raw) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : def;
}
var WRITING_TOOLS = /* @__PURE__ */ new Set(["webindex_video_fetch", "webindex_video_frames", "webindex_video_list"]);
var REPLACING_TOOLS = /* @__PURE__ */ new Set(["webindex_video_frames", "webindex_video_list"]);
function withHints(tools) {
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
      openWorldHint: !CLOSED_WORLD_TOOLS.has(t.name) || WRITING_TOOLS.has(t.name)
    }
  }));
}
function withPolicy(policy, tools) {
  const root = policy.extractRoot;
  const offered = root === void 0 && policy.noLocalFiles ? tools.filter((t) => t.name !== "webindex_extract") : tools;
  const withArg = (t, name2, prop2) => ({
    ...t,
    inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, [name2]: prop2 } }
  });
  return withHints(
    offered.map((t) => {
      if (t.name === "webindex_extract" && root !== void 0) {
        return withArg(t, "path", {
          type: "string",
          description: `Path to the file, under ${root} \u2014 the only directory this server reads; a relative path is read from there.`
        });
      }
      if (t.name === "webindex_fetch" && policy.publicOnly) {
        return withArg(t, "cache", {
          type: "boolean",
          description: "Ignored here: this server fetches public addresses only, and never reads the on-disk cache, which unguarded runs share."
        });
      }
      return t;
    })
  );
}
function resolvedHost(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return void 0;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return void 0;
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  return isIP2(host) ? void 0 : host;
}
function webindexAdapter(policy = {}) {
  const browserHost = policy.browser ? createBrowserToolHost({ policy }) : void 0;
  const guard = policy.publicOnly ? publicUrlsOnly() : void 0;
  const refuseUrl = async (url) => {
    if (!guard) return;
    const why = await publicUrlRefusal(url);
    if (!why) return;
    const host = resolvedHost(url);
    throw new ToolError(`Refused ${url}: ${host ? `${host} is not a public address, or did not resolve` : why} \u2014 this server fetches public addresses only.`);
  };
  const root = policy.extractRoot;
  const localFiles = root !== void 0 || !policy.noLocalFiles;
  const localPath = (requested) => {
    if (!localFiles) throw new ToolError(`${requested} is a path on this machine, and this server reads no local files.`);
    if (root === void 0) return requested;
    try {
      return confinePath(root, requested);
    } catch (e) {
      throw new ToolError(e.message);
    }
  };
  const repoRef = (raw, kind) => {
    if (root === void 0 && localFiles) return resolveRepo(raw, kind);
    const named = raw.trim();
    if (isAbsolute5(named) || /^(?:\.{1,2}|~)(?:[\\/]|$)/.test(named)) return resolveRepo(localPath(named), kind);
    if (named && root !== void 0) {
      try {
        const under = confinePath(root, named);
        if (statSync12(under).isDirectory()) return resolveRepo(under, kind);
      } catch {
      }
    }
    return resolveRepo(named, { ...kind, local: false });
  };
  const refuseForgeHost = async (ref2, kind) => {
    if (!guard || configuredForgeHosts().has(normalizeForgeHost(ref2.host))) return;
    await refuseUrl(apiBase(ref2, kind ? { kind } : {}));
  };
  const forgeGuard = (ref2, kind) => {
    if (!guard) return void 0;
    if (!configuredForgeHosts().has(normalizeForgeHost(ref2.host))) return guard;
    const own = new URL(apiBase(ref2, kind ? { kind } : {})).origin;
    return async (url) => new URL(url).origin === own || await guard(url);
  };
  const guarded = guard !== void 0 || root !== void 0 || policy.noLocalFiles === true;
  const videoDir = (raw) => {
    const base2 = videoRoot();
    if (raw === void 0 || raw === null || raw === "") return base2;
    const named = String(raw);
    if (!guarded) return isAbsolute5(named) ? named : resolve11(base2, named);
    if (!/^[A-Za-z0-9._-]+$/.test(named) || named === "." || named === "..") {
      throw new ToolError(`\`dir\` must be the name of a directory inside ${base2} on this server, not a path.`);
    }
    mkdirSync8(base2, { recursive: true });
    const target = join27(base2, named);
    if (existsSync14(target) && relative4(realpathSync4(base2), realpathSync4(target)).startsWith("..")) {
      throw new ToolError(`${named} leads outside ${base2}, the only directory this server writes videos to.`);
    }
    return target;
  };
  const videoUrl = async (raw, what) => {
    const url = String(raw ?? "");
    const ok = what === "video" ? videoSource(url, { anySite: !guarded }) : guarded ? youtubeListKind(url) : youtubeListKind(url) || /^https?:\/\//i.test(url) && !knownVideo(url);
    if (!ok) {
      throw new ToolError(
        what === "video" ? guarded ? "`url` must be a video on a host this server reads (YouTube, Vimeo, Dailymotion, Twitch, TED, Loom, TikTok\u2026)." : "`url` must be an http(s) URL of a video." : guarded ? "`url` must be a YouTube playlist or channel URL." : "`url` must be the http(s) URL of a playlist or channel."
      );
    }
    await refuseUrl(url);
    return url;
  };
  return {
    version: ENGINE_VERSION,
    listTools: () => withPolicy(policy, [
      {
        name: "webindex_search",
        title: "Search for candidate URLs",
        description: `Find candidate URLs: a locally-running SearXNG first, then the keyless engines (DuckDuckGo, DuckDuckGo Lite, Mojeek \u2014 no key, no container), then Firecrawl. Returns title, URL and snippet \u2014 not page text; follow up with webindex_fetch on the ones worth reading. When nothing answers it says which piece was missing rather than returning an empty result that reads like 'nothing exists'. The whole cascade is bounded at ${SEARCH_TOOL_BUDGET_MS / 1e3} s; the last line names each rung's outcome (rungs: searxng=unreachable ddg=hits(8) \u2026).`,
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
              description: "Restrict the keyless rung to one engine: ddg | ddglite | mojeek (SearXNG and Firecrawl still run around it). Omit to try all three in turn.",
              enum: [...KEYLESS_ENGINES]
            }
          },
          required: ["query"]
        }
      },
      {
        name: "webindex_fetch",
        title: "Fetch a URL as clean text",
        description: "Fetch a URL and return its readable text. Handles HTML, PDFs (pdf-inspector \u2192 anydoc \u2192 Firecrawl \u2192 pdftotext \u2192 native \u2192 OCR) and office documents (anydoc \u2192 Firecrawl \u2192 a built-in OOXML/OpenDocument reader), videos on YouTube, Vimeo, Dailymotion, Twitch, TED, Loom, TikTok and the other common hosts (a timestamped, chaptered transcript: manual subtitles \u2192 the video's own auto-captions \u2192 a local whisper transcription, which can take minutes for a long video with no subtitles), and uses Firecrawl when available, with built-in extraction as fallback. Returns the extracted text, then a trailer with the final URL after redirects, the page's canonical URL and title, any note, and which rung produced it \u2014 never raw bytes. Accepts URLs from the host's native search (including ChatGPT or Claude) or supplied directly; webindex_search is optional.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The http(s) URL to fetch." },
            lang: { type: "string", description: "Accept-Language tag, e.g. fr-FR." },
            fullPage: { type: "boolean", description: "Keep the whole page: no main-content isolation, no consent-banner filter." },
            format: FORMAT_ARG,
            timeoutMs: {
              type: "number",
              description: "How long the request may take, connection and body download included, before it is abandoned, in ms (default 20000, at most 300000). A timed-out request is not retried."
            },
            cache: {
              type: "boolean",
              description: "Use the on-disk cache: a fresh copy is reused for its TTL (24 h by default), a stale one revalidated with a conditional GET."
            }
          },
          required: ["url"]
        }
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
            format: FORMAT_ARG
          },
          required: ["path"]
        }
      },
      {
        name: "webindex_rank",
        title: "Rank candidate documents against a question",
        description: "Order a pool of documents by relevance to a question: BM25F (title and headings weighted above body), then SimHash collapse of near-duplicates, then MMR so the top of the list says several different things rather than restating one. Returns the ranking with a score, the matched query terms, and what was collapsed (each dropped mirror's URL and the URL it duplicated), plus a `note` when no document matched or the dense lane was missing \u2014 deterministic, no model, no network unless `dense` asks for the local embedding lane. Use it after gathering pages from any search provider to decide what to actually read. Scores measure relevance within this pool, not factual accuracy.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "What the ranking is for." },
            documents: {
              type: "array",
              description: 'The pool. Each item is {url, text} plus optional {title, headings, score}. A `score` (e.g. the search engine\'s own relevance) is fused with BM25F by rank; it never lifts a document sharing no term with the question. Passed as JSON, e.g. [{"url":"\u2026","title":"\u2026","text":"\u2026"}].'
            },
            limit: { type: "number", description: "How many ranked entries to return (default all)." },
            dense: {
              type: "boolean",
              description: "Fuse the local embedding lane (Ollama) with BM25F before the collapse and MMR, so a page that never uses the question's words can still rank. Falls back to BM25F with a `note` when no embedding server answers. Default false: deterministic and offline."
            }
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
          properties: {
            repo: { type: "string", description: "owner/repo, a URL (a browser URL works), git@host:owner/repo, or a local checkout (read as its origin)." },
            forge: FORGE_ARG
          },
          required: ["repo"]
        }
      },
      {
        name: "webindex_issues",
        title: "Search a repository's issues or pull requests",
        description: "Search issues (or pull/merge requests) in one repository across GitHub, GitLab and Gitea. Returns number, title, state, labels and body. GitHub results for `terms` are relevance-ranked and carry a score; GitLab and Gitea have no search endpoint, so theirs are recency-ordered and carry none \u2014 deliberately, rather than inventing one. Every term must match; when all of them together match nothing, it searches once more with the most distinctive ones and says so in `note`.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/repo, or a repository URL." },
            terms: { type: "string", description: "What to look for." },
            kind: { type: "string", description: "issue (default) or pr.", enum: ["issue", "pr"] },
            limit: { type: "number", description: "How many to return (default 10)." },
            forge: FORGE_ARG
          },
          required: ["repo"]
        }
      },
      {
        name: "webindex_releases",
        title: "A repository's releases",
        description: "List releases newest-first with their notes and dates \u2014 the authoritative answer to 'what changed', and to 'when was X added'. A project that tags versions without publishing releases has none: use webindex_tags for it.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/repo, or a repository URL." },
            limit: { type: "number", description: "How many (default 20)." },
            forge: FORGE_ARG
          },
          required: ["repo"]
        }
      },
      {
        name: "webindex_tags",
        title: "A repository's tags",
        description: "List a repository's tags with a link to each \u2014 the versions of a project that tags without publishing forge releases, where webindex_releases finds nothing.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/repo, or a repository URL." },
            limit: { type: "number", description: "How many (default 50)." },
            forge: FORGE_ARG
          },
          required: ["repo"]
        }
      },
      {
        name: "webindex_package",
        title: "Resolve a library name to its real coordinates",
        description: "Look a package up in npm, PyPI or crates.io and return its repository, homepage, documentation URL, current version, licence and any DEPRECATION notice. Use this before searching the web for a library: it uses bounded registry requests, and it is the registry's own answer rather than whatever ranks for '<name> official documentation'.",
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
        description: "Fetch and parse the site's sitemap (the ones robots.txt names, else /sitemap.xml; gzipped and plain-text ones too), returning page URLs with their last-modified dates. At most `max` documents are read \u2014 enumerating a site is a budget you set, not something this does on its own \u2014 and the child sitemaps it did not reach come back in `unfetched`.",
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
        title: "A site's RSS, Atom or JSON feed",
        description: "Parse a feed URL (RSS, Atom or JSON Feed), or discover and parse the feeds a page advertises. Returns dated, ordered entries with absolute URLs \u2014 the site telling you what it published and when, instead of a web search guessing.",
        inputSchema: { type: "object", properties: { url: { type: "string", description: "A feed URL, or a page that links to one." } }, required: ["url"] }
      },
      {
        name: "webindex_tables",
        title: "The tables on a page, as data",
        description: "Extract every <table> as headers and rows, with colspan and rowspan resolved. Plain extraction flattens a table into a run of cell text, which reads plausibly while every figure has lost the row and column it belonged to \u2014 use this whenever the answer is IN a table.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The page holding the table(s)." },
            markdown: { type: "boolean", description: "Render as markdown instead of JSON rows." }
          },
          required: ["url"]
        }
      },
      {
        name: "webindex_embed",
        title: "Embed text with the local model",
        description: "Turn text into vectors with the local Ollama, which needs no key and sends nothing off the machine. Returns one vector per input, in input order. Fails with a note naming the command that starts the service when it is not running.",
        inputSchema: {
          type: "object",
          properties: { texts: { type: "array", items: { type: "string" }, description: "The texts to embed." } },
          required: ["texts"]
        }
      },
      {
        name: "webindex_crawl",
        title: "Walk a site, within a budget",
        description: "Follow links from a seed page, breadth-first, honouring robots.txt at EVERY hop and staying on the origin the seed lands on. `max` pages is required \u2014 enumerating someone else's site is the one operation here that can inconvenience them, so the budget is not optional. Returns each page's URL, title and text, the URLs robots.txt refused (`disallowed`), how many in-scope URLs the budget did not reach (`pending`), and `notes`.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The seed page." },
            max: {
              type: "number",
              description: "Pages to return. Required. A failed fetch costs no page, but the crawl makes at most 3 \xD7 `max` page requests in all. Every page's text comes back inline and an answer over 1 MB is withheld, so ask for the tens of pages you will read, not hundreds."
            },
            depth: { type: "number", description: "How many links deep to follow (default 2)." },
            prefix: { type: "string", description: "Only follow URLs whose path starts with this, e.g. `/docs/`." },
            sitemap: {
              type: "boolean",
              description: "Seed the walk from the site's sitemap too (default true; a seed below the root takes only its own section's entries)."
            }
          },
          required: ["url", "max"]
        }
      },
      {
        name: "webindex_video_fetch",
        title: "Read a video, and keep it",
        description: "Read a video \u2014 YouTube, Vimeo, Dailymotion or any page yt-dlp reads (only the known video hosts under this server's public-only policy) \u2014 into a run directory and return its transcript as Markdown: a header (title, channel, date, duration, which track), a heading per chapter, and a [mm:ss] stamp on every paragraph \u2014 cite by stamp. Manual subtitles first, then the video's own auto-captions, then a local whisper transcription (minutes for a long video). The run is kept: a second call, and webindex_video_search, read it without touching the site.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The video's URL: YouTube (watch, youtu.be, shorts, embed, live), Vimeo, Dailymotion, or any page yt-dlp reads."
            },
            lang: {
              type: "string",
              description: "Preferred subtitle language, e.g. fr. Defaults to the video's own; another language's track is marked as a translation."
            },
            refresh: { type: "boolean", description: "Read the video again even when its run is on disk." },
            dir: { type: "string", description: "The directory runs are kept in (default: the server's video root)." }
          },
          required: ["url"]
        }
      },
      {
        name: "webindex_video_search",
        title: "Search the videos already read",
        description: "Rank ~45 s passages of the videos kept in a directory (every one, or a corpus from webindex_video_list, labelled V1\u2026Vn) against a question, with BM25F. Each hit has its video, [mm:ss] stamp, chapter, a link that opens the video there, and the passage \u2014 for answering a follow-up question without reading the video again.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The question, or its key words." },
            limit: { type: "number", description: "How many passages (default 10)." },
            dir: { type: "string", description: "The directory to search (default: the server's video root)." }
          },
          required: ["query"]
        }
      },
      {
        name: "webindex_video_frames",
        title: "What is on screen in a video",
        description: "Take a frame at every scene change and chapter start of a video, drop near-duplicates, keep at most 20/50/100 by `effort`, and pair each frame with what was said from 5 s before to 10 s after. Returns FRAMES.md's path and each frame's image path, stamp and aligned transcript; read the images to see slides, code or diagrams. Downloads the video (720p at most) and needs ffmpeg \u2014 expect tens of seconds.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The video's URL; read first when it is not kept yet." },
            effort: { type: "string", enum: ["low", "med", "high"], description: "At most 20, 50 or 100 frames (default med)." },
            dir: { type: "string", description: "The directory runs are kept in (default: the server's video root)." }
          },
          required: ["url"]
        }
      },
      {
        name: "webindex_video_list",
        title: "Read a playlist or a channel",
        description: "Read the first `limit` videos of a playlist or channel \u2014 YouTube, or any site yt-dlp lists (YouTube only under a public-only policy) \u2014 two at a time, each kept as its own run, and write CORPUS.md naming them V1\u2026Vn in listing order \u2014 the labels to cite across videos. A video that cannot be read keeps its label, with the reason. Returns the corpus rows; webindex_video_search on the same `dir` then searches them all.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "A playlist or channel URL: YouTube (list=, /@handle, /channel/, /c/, /user/), a Vimeo showcase, a Dailymotion playlist\u2026"
            },
            limit: { type: "number", description: "How many videos (default 10)." },
            dir: { type: "string", description: "The directory the corpus is kept in (default: the server's video root)." }
          },
          required: ["url"]
        }
      },
      ...policy.browser ? browserToolDecls() : []
    ]),
    capAdvice: {
      webindex_search: "lower `limit`",
      webindex_repo: "this repository's record is unusually large; ask for what you need instead",
      webindex_issues: "lower `limit`, or narrow `terms`",
      webindex_releases: "lower `limit` \u2014 release notes are long",
      webindex_tags: "lower `limit`",
      webindex_package: "this package's registry record is unusually large; pin a `version`",
      webindex_meta: "the page is very large; this reads only its head, so a cap here means the document itself is enormous",
      webindex_robots: "this site's robots.txt is unusually large; read it directly",
      webindex_sitemap: "lower `max`, or read one child sitemap at a time",
      webindex_feed: "the feed is very large; fetch it and read the file instead of inlining it",
      webindex_fetch: "the page is very large; fetch it and read the file instead of inlining it",
      webindex_extract: "the document is very large; read it in pieces",
      webindex_rank: "lower `limit`, or send shorter `text` per document \u2014 the ranking only needs enough to score",
      webindex_tables: "this page's tables are enormous; fetch it and read the file instead of inlining them",
      webindex_embed: "send fewer `texts` \u2014 a vector per input is large, and they are rarely worth reading inline",
      webindex_crawl: "lower `max`, or `depth` \u2014 a crawl's whole output is the sum of its pages",
      webindex_video_fetch: "the transcript is very long; read TRANSCRIPT.md from the run directory, or ask webindex_video_search",
      webindex_video_search: "lower `limit`",
      webindex_video_frames: "lower `effort`",
      webindex_video_list: "lower `limit`",
      ...policy.browser ? BROWSER_CAP_ADVICE : {}
    },
    async callTool(name2, args, ctx) {
      const signal = ctx?.signal;
      if (browserHost && name2.startsWith("webindex_browser_")) return browserHost.call(name2, args, ctx);
      if (name2 === "webindex_fetch") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        await refuseUrl(url);
        const fullPage = args.fullPage === true;
        const fetchOpts = {
          acceptLanguage: args.lang ? String(args.lang) : void 0,
          fullPage,
          stripConsent: !fullPage,
          format: args.format === "markdown" ? "markdown" : "text",
          timeoutMs: toolTimeoutMs(args.timeoutMs),
          signal,
          // The same wall that refuses --browser: a browser follows any address
          // a page leads it to, in a profile that may be logged in.
          ...policy.remote || policy.publicOnly ? { browser: "off" } : {}
        };
        const r = guard ? await fetchAndExtract(url, { ...fetchOpts, authorizeUrl: guard }) : await cachedFetchAndExtract(url, fetchOpts, args.cache === true);
        if (!r.text) throw new ToolError(`Nothing readable at ${url}${r.note ? ` \u2014 ${r.note}` : ""}.`);
        const trailer = [
          `url: ${r.finalUrl}`,
          ...r.canonical && r.canonical !== r.finalUrl ? [`canonical: ${r.canonical}`] : [],
          ...r.title ? [`title: ${r.title}`] : [],
          ...r.documentType ? [`document: ${r.documentType}`] : [],
          ...r.cached ? ["cached: true"] : [],
          ...r.note ? [`note: ${r.note}`] : [],
          `extractor: ${r.extractor ?? "native"}`
        ];
        return { text: `${r.text}

---
${trailer.join("\n")}` };
      }
      if (name2 === "webindex_search") {
        const q = String(args.query ?? "").trim();
        if (!q) throw new ToolError("`query` is required.");
        const raw = args.engine ? String(args.engine) : void 0;
        if (raw !== void 0 && !isKeylessEngine(raw)) throw new ToolError(`unknown engine "${raw}" \u2014 expected one of ${KEYLESS_ENGINES.join(", ")}`);
        const engines = raw === void 0 ? void 0 : [raw];
        const r = await search(q, {
          limit: typeof args.limit === "number" ? args.limit : void 0,
          lang: args.lang ? String(args.lang) : void 0,
          region: args.region ? String(args.region) : void 0,
          // Clamped, not refused: every page is another request to an engine
          // that rations them, and an agent's 50 should cost it a few pages,
          // not the call.
          pages: typeof args.pages === "number" && Number.isFinite(args.pages) ? Math.min(SEARCH_TOOL_MAX_PAGES, Math.max(1, Math.trunc(args.pages))) : void 0,
          // An MCP host gives up on a tool call long before a cascade of
          // timeouts would: better a partial answer that says where it
          // stopped than none at all.
          timeoutMs: SEARCH_TOOL_BUDGET_MS,
          signal,
          ...engines ? { engines } : {}
        });
        const rungs = r.rungs?.length ? `rungs: ${r.rungs.map((x) => `${x.rung}=${x.outcome}${x.hits ? `(${x.hits})` : ""}`).join(" ")}` : "";
        if (!r.hits.length) throw new ToolError([r.notes.join(" ") || "No results.", rungs].filter(Boolean).join("\n"));
        const body = r.hits.map((h, i) => `${i + 1}. ${h.title}
   ${h.url}${h.snippet ? `
   ${h.snippet}` : ""}`).join("\n\n");
        const trailer = [...r.notes, rungs].filter(Boolean);
        return { text: trailer.length ? `${body}

---
${trailer.join("\n")}` : body };
      }
      if (name2 === "webindex_extract") {
        const r = await extractLocal(localPath(String(args.path ?? "")), args.fullPage === true, void 0, args.format === "markdown" ? "markdown" : "text");
        if (!r.text) throw new ToolError(`Nothing readable in that file${r.reason ? ` \u2014 ${r.reason}` : ""}.`);
        return { text: `${r.text}

---
extractor: ${r.extractor}` };
      }
      if (name2 === "webindex_rank") {
        const question = String(args.question ?? "").trim();
        if (!question) throw new ToolError("`question` is required.");
        let docs;
        try {
          docs = parseRankDocs(args.documents, "`documents`");
        } catch (e) {
          throw new InvalidParamsError(e.message);
        }
        const r = await rankDocuments(question, docs, { limit: typeof args.limit === "number" ? args.limit : void 0, dense: args.dense === true });
        if (!r.queryTerms.length) {
          throw new ToolError("`question` has no rankable terms once stopwords are removed \u2014 nothing to score against.");
        }
        return { text: JSON.stringify(r, null, 2) };
      }
      if (name2 === "webindex_package") {
        const pkg = String(args.name ?? "").trim();
        if (!pkg) throw new ToolError("`name` is required.");
        const reg = args.registry === void 0 ? void 0 : String(args.registry);
        if (reg !== void 0 && !isRegistryKind(reg)) throw new InvalidParamsError("`registry` must be one of: npm, pypi, crates");
        const { facts: p, note } = await resolvePackageResult(pkg, {
          ...reg ? { registry: reg } : {},
          ...args.version ? { version: String(args.version) } : {}
        });
        if (!p) throw new ToolError(note ?? `No registry knows a package called "${pkg}".`);
        return { text: JSON.stringify(p, null, 2) };
      }
      if (name2 === "webindex_repo" || name2 === "webindex_issues" || name2 === "webindex_releases" || name2 === "webindex_tags") {
        const forge = args.forge === void 0 ? void 0 : String(args.forge);
        if (forge !== void 0 && !isForgeKind(forge)) throw new InvalidParamsError(`\`forge\` must be one of: ${FORGE_KINDS.join(", ")}`);
        const raw = String(args.repo ?? "");
        const kind = forge ? { kind: forge } : {};
        const ref2 = forgeRef(repoRef(raw, kind), kind);
        if (ref2.host === "generic") throw new ToolError(`"${raw}" does not name a repository.`);
        await refuseForgeHost(ref2, forge);
        const limit = typeof args.limit === "number" ? args.limit : void 0;
        const authorizeUrl = forgeGuard(ref2, forge);
        const opts = { ...limit ? { limit } : {}, ...forge ? { kind: forge } : {}, ...authorizeUrl ? { authorizeUrl } : {} };
        if (name2 === "webindex_repo") {
          const { facts: f, note } = await repoFactsResult(ref2, opts);
          if (!f) throw new ToolError(note ?? `Could not read ${ref2.webUrl ?? ref2.raw}.`);
          return { text: JSON.stringify({ ref: ref2, ...f }, null, 2) };
        }
        const r = name2 === "webindex_releases" ? await listReleases(ref2, opts) : name2 === "webindex_tags" ? await listTags(ref2, opts) : await searchIssues(
          ref2,
          String(args.terms ?? "").split(/\s+/).filter(Boolean),
          args.kind === "pr" ? "pr" : "issue",
          opts
        );
        if (!r.items.length) {
          if (!r.note && name2 === "webindex_releases")
            throw new ToolError(`No releases published for ${ref2.raw} \u2014 its versions may only be tags: try webindex_tags.`);
          throw new ToolError(r.note ?? `Nothing found for ${ref2.raw}.`);
        }
        return { text: JSON.stringify(r, null, 2) };
      }
      if (name2 === "webindex_meta" || name2 === "webindex_robots" || name2 === "webindex_sitemap" || name2 === "webindex_feed") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        await refuseUrl(url);
        const robotsOpts = guard ? { authorizeUrl: guard } : {};
        if (name2 === "webindex_robots") {
          const r = await fetchRobots(url, robotsOpts);
          return { text: JSON.stringify({ url, allowed: isAllowed(r, url), ...r }, null, 2) };
        }
        if (name2 === "webindex_sitemap") {
          const robots = await fetchRobots(url, robotsOpts);
          const max = typeof args.max === "number" ? args.max : void 0;
          const s = await fetchSitemap(url, {
            sitemaps: robots.sitemaps,
            max,
            signal,
            authorizeUrl: guard,
            onDocument: (doc, fetched) => ctx?.progress(fetched, max ?? 3, doc)
          });
          if (!s.urls.length && !s.sitemaps.length) throw new ToolError(`No sitemap found for ${url}.${s.notes?.length ? ` ${s.notes.join(" ")}` : ""}`);
          return { text: JSON.stringify(s, null, 2) };
        }
        const page = await httpGet(url, { accept: "text/html,application/xml,application/feed+json,*/*", signal, authorizeUrl: guard });
        if (!page.ok) throw new ToolError(`Could not fetch ${url} (${fetchFailure(page)}).`);
        if (name2 === "webindex_meta") return { text: JSON.stringify(pageMetadata(page.body, { baseUrl: page.url }), null, 2) };
        const direct = parseFeed(page.body, page.url);
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
      if (name2 === "webindex_tables") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        await refuseUrl(url);
        const page = await httpGet(url, { accept: "text/html,*/*", signal, authorizeUrl: guard });
        if (!page.ok) throw new ToolError(`could not fetch ${url} (${fetchFailure(page)})`);
        const tables = extractTables(page.body);
        if (!tables.length) throw new ToolError(`${url} has no tables \u2014 use webindex_fetch for its text.`);
        return { text: args.markdown ? tables.map(tableToMarkdown).join("\n\n") : JSON.stringify(tables, null, 2) };
      }
      if (name2 === "webindex_embed") {
        const texts = Array.isArray(args.texts) ? args.texts.map(String) : [];
        if (!texts.length) throw new ToolError("`texts` must be a non-empty array of strings.");
        const r = await embed(texts);
        if (!r.vectors.length) throw new ToolError(r.note ?? "the embedding server returned nothing.");
        return { text: JSON.stringify({ model: r.model, dimensions: r.vectors[0]?.length ?? 0, vectors: r.vectors }, null, 2) };
      }
      if (name2 === "webindex_crawl") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        const max = Number(args.max);
        if (!Number.isInteger(max) || max < 1)
          throw new ToolError("`max` is required and must be a positive whole number \u2014 a crawl without a budget is not one.");
        await refuseUrl(url);
        let read3 = 0;
        const r = await crawlSite(url, {
          maxPages: max,
          signal,
          ...guard ? { authorizeUrl: guard } : {},
          onPage: (page) => ctx?.progress(++read3, max, page.url),
          ...args.depth !== void 0 ? { maxDepth: Number(args.depth) } : {},
          ...typeof args.prefix === "string" && args.prefix ? { prefix: args.prefix } : {},
          ...args.sitemap === false ? { useSitemap: false } : {}
        });
        if (!r.pages.length) throw new ToolError(`nothing readable from ${url}${r.notes.length ? ` \u2014 ${r.notes.join(" ")}` : ""}`);
        return {
          text: JSON.stringify(
            {
              pages: r.pages.map((p) => ({ url: p.url, depth: p.depth, title: p.title, text: p.text })),
              disallowed: r.disallowed,
              pending: r.pending.length,
              notes: r.notes
            },
            null,
            2
          )
        };
      }
      if (name2 === "webindex_video_fetch") {
        const url = await videoUrl(args.url, "video");
        const dir = videoDir(args.dir);
        const r = await fetchVideoRun(url, dir, {
          refresh: args.refresh === true,
          lang: args.lang ? String(args.lang) : void 0,
          signal,
          knownHostsOnly: guarded
        });
        if (!r.ok) throw new ToolError(`No transcript for ${url}: ${r.reason}.`);
        const text = r.markdown ?? readFileSync19(r.transcript, "utf8");
        return { text: `${text}
---
run: ${r.dir}
via: ${r.meta.via}${r.reused ? " (already on disk)" : ""}` };
      }
      if (name2 === "webindex_video_search") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new ToolError("`query` is required.");
        const dir = videoDir(args.dir);
        const hits = searchVideoRuns(dir, query, { limit: toolLimit(args.limit, 10) });
        if (!hits.length) throw new ToolError(`Nothing kept under ${dir} matches "${query}" \u2014 read a video first with webindex_video_fetch.`);
        return { text: JSON.stringify({ dir, hits }, null, 2) };
      }
      if (name2 === "webindex_video_frames") {
        const url = await videoUrl(args.url, "video");
        const effort = args.effort === void 0 ? "med" : String(args.effort);
        if (!(effort in FRAME_EFFORT)) throw new ToolError("`effort` must be low, med or high.");
        const run = await fetchVideoRun(url, videoDir(args.dir), { signal, knownHostsOnly: guarded });
        if (!run.ok) throw new ToolError(`No transcript for ${url}: ${run.reason}.`);
        const r = await extractFrames(run.dir, { effort, signal, url, knownHostsOnly: guarded });
        if (!r.ok) throw new ToolError(r.reason);
        const frames = r.frames.map((f) => ({ image: join27(run.dir, f.file), stamp: f.stamp, chapter: f.chapter, kind: f.kind, said: f.text }));
        return { text: JSON.stringify({ markdown: r.markdown, candidates: r.candidates, duplicates: r.duplicates, frames }, null, 2) };
      }
      if (name2 === "webindex_video_list") {
        const url = await videoUrl(args.url, "list");
        const dir = videoDir(args.dir);
        const limit = toolLimit(args.limit, 10);
        const r = await fetchVideoCorpus(url, dir, {
          limit,
          signal,
          knownHostsOnly: guarded,
          onVideo: (done, total, title) => ctx?.progress(done, total, title)
        });
        if (!r.ok) throw new ToolError(r.reason);
        return { text: JSON.stringify({ corpus: r.corpus, title: r.title, videos: r.videos }, null, 2) };
      }
      throw new ToolError(`unknown tool: ${name2}`);
    },
    /** Let go of the browser session, if one was opened; the browser keeps running. */
    close: async () => browserHost?.close()
  };
}
async function main(argv = process.argv.slice(2)) {
  try {
    await dispatch(argv);
  } catch (e) {
    if (!(e instanceof UsageError) && !(e instanceof ToolError)) throw e;
    process.stderr.write(`webindex: ${e.message}
`);
    process.exit(e instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE);
  }
}
function commandHelp(cmd) {
  const section = (title) => {
    const lines = HELP.split("\n");
    const start = lines.indexOf(title);
    const end = lines.indexOf("", start);
    return start === -1 ? [] : lines.slice(start + 1, end === -1 ? void 0 : end);
  };
  const entries = (lines, head) => {
    const out = [];
    for (const line of lines) {
      const m = head.exec(line);
      if (m) out.push({ name: m[1], lines: [line] });
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
    ...cmd === "mcp" ? ["", ...browserToolsHelp()] : [],
    "",
    "Run `webindex --help` for every command and the environment variables."
  ].join("\n");
}
function browserToolsHelp() {
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
async function fetchSeveral(urls, fetchOne, json2, record2) {
  const results = [];
  let next = 0;
  let wrote = false;
  const report2 = (i) => {
    const r = results[i];
    if (!r.text) {
      process.stderr.write(`webindex: nothing readable at ${urls[i]}${r.note ? ` \u2014 ${r.note}` : ""}
`);
      return;
    }
    if (json2) return;
    process.stdout.write(`${wrote ? "\n" : ""}==> ${urls[i]} <==
${r.text}
`);
    wrote = true;
    if (r.note) process.stderr.write(`  ${r.note}
`);
  };
  await mapLimit(urls, envInt("FETCH_CONCURRENCY", 4, 1, 16), async (url, i) => {
    results[i] = await fetchOne(url);
    while (next < urls.length && results[next]) report2(next++);
  });
  if (json2) {
    const records = results.map((r, i) => record2(urls[i], r));
    process.stdout.write(JSON.stringify(records, null, 2) + "\n");
  }
  if (results.every((r) => !r.text)) fail(`none of the ${urls.length} URLs had anything readable`);
}
function positionalLimit(args) {
  const cmd = args.command;
  if (cmd === "search" || cmd === "embed" || cmd === "fetch") return { max: Number.POSITIVE_INFINITY };
  if (cmd === "rank" || cmd === "hybrid") return { max: 0, hint: 'the question goes in --query "<q>"' };
  if (cmd === "doctor" || cmd === "mcp") return { max: 0 };
  if (cmd === "skill") return { max: args.positional[0] === "init" ? 2 : 1 };
  if (cmd === "video") return args.positional[0] === "search" ? { max: Number.POSITIVE_INFINITY } : { max: 2 };
  if (cmd === "browser") return { max: Number.POSITIVE_INFINITY };
  if (cmd === "issues" || cmd === "prs") return { max: 1, hint: 'search words go in --terms "<words>"' };
  if (cmd === "repo" || cmd === "releases" || cmd === "tags") return { max: 1, hint: "quote a path that contains spaces" };
  return { max: 1 };
}
async function dispatch(argv) {
  const parsed = parseArgs(argv, SPEC);
  if (parsed.kind === "help") {
    process.stdout.write((parsed.command ? commandHelp(parsed.command) : HELP) + "\n");
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(ENGINE_VERSION + "\n");
    return;
  }
  const args = parsed;
  const cmd = args.command;
  const arity2 = positionalLimit(args);
  if (args.positional.length > arity2.max) {
    const extra = args.positional[arity2.max];
    const takes = arity2.max === 0 ? "no arguments" : arity2.max === 1 ? "one argument" : `${arity2.max} arguments`;
    usage(`unexpected argument "${extra}" \u2014 \`webindex ${cmd}\` takes ${takes}${arity2.hint ? `; ${arity2.hint}` : ""} (see \`webindex ${cmd} --help\`)`);
  }
  if (cmd === "search") {
    const q = positionalText(args);
    if (!q) usage("usage: webindex search <query>");
    const engine = argValue(args, "engine");
    if (engine && engine !== "off" && !isKeylessEngine(engine)) usage(`unknown --engine "${engine}" \u2014 expected one of ${KEYLESS_ENGINES.join(", ")}, or off`);
    const r = await search(q, {
      limit: argInt(args, "limit", { min: 1 }),
      pages: argInt(args, "pages", { min: 1 }),
      lang: argValue(args, "lang"),
      region: argValue(args, "region"),
      searxng: argValue(args, "searxng"),
      firecrawl: argValue(args, "firecrawl"),
      // The budget for the whole cascade, not one request.
      timeoutMs: argTimeout(args),
      ...engine ? { engines: engine === "off" ? [] : [engine] } : {}
    });
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(r));
    } else {
      for (const h of r.hits) {
        process.stdout.write(`${h.title}
  ${h.url}${h.snippet ? `
  ${h.snippet.slice(0, 160)}` : ""}

`);
      }
      for (const n of r.notes) process.stderr.write(`  ${n}
`);
    }
    if (!r.hits.length) process.exit(EXIT_FAILURE);
    return;
  }
  if (cmd === "fetch") {
    const urls = args.positional;
    if (!urls.length) usage("usage: webindex fetch <url> [<url> \u2026]");
    const bad = urls.find((u) => !/^https?:\/\//i.test(u));
    if (bad !== void 0) {
      fail(
        `fetch needs an http(s) URL${urls.length > 1 ? `, got "${bad}"` : ""}${existsSync14(bad) ? ` \u2014 for a file on disk, \`webindex extract ${bad}\`` : ""}`
      );
    }
    const fullPage = argBool(args, "full-page");
    const format = argFormat(args);
    const refresh = argBool(args, "refresh");
    const offline = argBool(args, "offline");
    if (refresh && offline) usage("--refresh and --offline contradict each other: one always fetches, the other never does");
    setCacheMode({ refresh, offline });
    const fetchOpts = {
      acceptLanguage: argValue(args, "lang"),
      firecrawl: argValue(args, "firecrawl"),
      fullPage,
      stripConsent: !fullPage,
      format,
      timeoutMs: argTimeout(args),
      // A flag, not a value: `--browser` is a switch on mcp too. Fallback mode is WEBINDEX_BROWSER_FETCH's.
      ...argBool(args, "browser") ? { browser: "always" } : {}
    };
    const cache2 = argBool(args, "cache") || refresh;
    const json2 = argBool(args, "json");
    const record2 = (url2, r2) => ({
      url: url2,
      // Where the text actually came from — after redirects — and the
      // address the page gives for itself: what a citation needs.
      finalUrl: r2.finalUrl,
      canonical: r2.canonical,
      title: r2.title,
      extractor: r2.extractor,
      documentType: r2.documentType,
      status: r2.status,
      cached: r2.cached === true,
      chars: r2.text.length,
      note: r2.note,
      text: r2.text,
      fullPage,
      consentDropped: r2.consentDropped ?? 0
    });
    if (urls.length > 1) {
      await fetchSeveral(urls, (url2) => cachedFetchAndExtract(url2, fetchOpts, cache2), json2, record2);
      return;
    }
    const url = urls[0];
    const r = await cachedFetchAndExtract(url, fetchOpts, cache2);
    if (json2) {
      process.stdout.write(JSON.stringify(record2(url, r), null, 2) + "\n");
    } else if (r.text) {
      process.stdout.write(r.text + "\n");
      if (r.note) process.stderr.write(`  ${r.note}
`);
    }
    if (!r.text) fail(`nothing readable at ${url}${r.note ? ` \u2014 ${r.note}` : ""}`);
    return;
  }
  if (cmd === "extract") {
    const EXTRACT_USAGE = "usage: webindex extract <file|-> [--format text|markdown] [--full-page] [--json]";
    const path = args.positional[0];
    if (!path) usage(EXTRACT_USAGE);
    const fullPage = argBool(args, "full-page");
    const format = argFormat(args);
    const r = await extractLocal(path, fullPage, path === "-" ? readStdin(EXTRACT_USAGE) : void 0, format);
    if (argBool(args, "json")) {
      process.stdout.write(
        JSON.stringify(
          { file: basename5(path), extractor: r.extractor, chars: r.text.length, reason: r.reason, text: r.text, fullPage, consentDropped: r.consentDropped },
          null,
          2
        ) + "\n"
      );
    } else if (r.text) {
      process.stdout.write(r.text + "\n");
    }
    if (!r.text) fail(`nothing readable in ${path}${r.reason ? ` \u2014 ${r.reason}` : ""}`);
    return;
  }
  if (cmd === "mcp") {
    const transport = argValue(args, "transport") ?? "stdio";
    const allowRemote = argBool(args, "allow-remote");
    const policy = mcpPolicy(args, allowRemote);
    const notice = mcpPolicyNotice(policy, allowRemote, argBool(args, "allow-private"));
    if (transport === "stdio") {
      for (const line of notice) process.stderr.write(`webindex: ${line}
`);
      const adapter = webindexAdapter(policy);
      await runStdioServer(adapter);
      await adapter.close();
      return;
    }
    if (transport !== "http") usage(`unknown transport "${transport}" \u2014 expected stdio or http`);
    const port = argInt(args, "port", { min: 0, max: 65535 }) ?? 7340;
    const token = env("MCP_TOKEN");
    let running;
    try {
      running = await startHttpServer(webindexAdapter(policy), {
        port,
        bind: argValue(args, "bind"),
        allowRemote,
        ...token ? { bearerToken: token } : {}
      });
    } catch (e) {
      fail(e.message);
    }
    process.stderr.write(`webindex: MCP server listening on ${running.url}
`);
    const header2 = token ? ` --header "Authorization: Bearer $${envName("MCP_TOKEN")}"` : "";
    process.stderr.write(`  client: claude mcp add --transport http webindex ${running.url}${header2}
`);
    if (allowRemote) {
      process.stderr.write(
        token ? "  exposed beyond this machine (--allow-remote); every request needs the bearer token.\n" : `  exposed beyond this machine (--allow-remote) with no authentication: anyone who can reach the port can use it. Set ${envName("MCP_TOKEN")} to require a bearer token.
`
      );
    }
    for (const line of notice) process.stderr.write(`  ${line}
`);
    return;
  }
  if (STACK_SERVICES.includes(cmd) && cmd !== "all" || cmd === "stack") {
    const action = args.positional[0] ?? "status";
    if (cmd === "stack" && action === "path") {
      process.stdout.write(ensureComposeMaterialized() + "\n");
      return;
    }
    const valid = cmd === "stack" ? ["up", "down", "status", "path"] : ["up", "down", "status"];
    if (!valid.includes(action)) usage(`usage: webindex ${cmd} ${valid.join("|")}`);
    const r = stackControl(cmd === "stack" ? "all" : cmd, action);
    (r.code === 0 ? process.stdout : process.stderr).write(r.message + "\n");
    if (r.code !== 0) process.exit(r.code);
    return;
  }
  if (cmd === "rank") {
    const RANK_USAGE = "usage: webindex rank --query <question> --docs <file.json|-> [--limit <n>] [--dense] [--json]";
    const question = argValue(args, "query");
    if (!question) usage(RANK_USAGE);
    const limit = argInt(args, "limit", { min: 1 });
    const input = readDocsInput(args, RANK_USAGE);
    let docs;
    try {
      docs = parseRankDocs(parseJsonInput(input.text, input.label, RANK_DOCS_SHAPE), "--docs");
    } catch (e) {
      fail(e.message);
    }
    const r = await rankDocuments(question, docs, { limit, dense: argBool(args, "dense") });
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(r));
    } else {
      process.stdout.write(
        r.ranked.map((x) => `${x.rank}. [${x.score.toFixed(3)}] ${x.title ?? x.url}
   ${x.url}${x.matched.length ? `
   matched: ${x.matched.join(", ")}` : ""}`).join("\n\n") + "\n"
      );
      if (r.collapsed) {
        process.stderr.write(`${r.collapsed} near-duplicate(s) collapsed.
`);
        for (const d of r.duplicates) process.stderr.write(`  ${d.url} duplicates ${d.of}
`);
      }
    }
    if (r.note) process.stderr.write(`  ${r.note}
`);
    if (!r.queryTerms.length) {
      process.stderr.write("The question has no rankable terms once stopwords are removed \u2014 the order is arbitrary.\n");
      process.exit(1);
    }
    return;
  }
  if (cmd === "repo" || cmd === "issues" || cmd === "prs" || cmd === "releases" || cmd === "tags" || cmd === "package") {
    const target = positionalText(args);
    if (!target) usage(`usage: webindex ${cmd} <${cmd === "package" ? "name" : "repo"}> [--json]`);
    const asJson = argBool(args, "json");
    const limit = argInt(args, "limit", { min: 1 });
    const emit = (obj, human) => process.stdout.write(asJson ? jsonLine(obj) : `${human.join("\n")}
`);
    if (cmd === "package") {
      const reg = argValue(args, "registry");
      if (reg !== void 0 && !isRegistryKind(reg)) usage(`--registry expects npm, pypi or crates, got "${reg}"`);
      const { facts: p, note } = await resolvePackageResult(target, {
        ...reg ? { registry: reg } : {},
        ...argValue(args, "version") ? { version: argValue(args, "version") } : {}
      });
      if (!p) fail(note ?? `no registry knows a package called "${target}"`);
      emit(p, [
        `  name        ${p.name}`,
        `  registry    ${p.registry}`,
        `  description ${p.description ?? "\u2014"}`,
        `  version     ${p.version ?? "\u2014"}`,
        `  repository  ${p.repository ?? "\u2014"}`,
        `  homepage    ${p.homepage ?? "\u2014"}`,
        `  docs        ${p.documentation ?? "\u2014"}`,
        `  license     ${p.license ?? "\u2014"}`,
        ...p.deprecated ? [`  DEPRECATED  ${p.deprecated}`] : []
      ]);
      return;
    }
    const forge = argValue(args, "forge");
    if (forge !== void 0 && !isForgeKind(forge)) usage(`--forge expects github, gitlab or gitea, got "${forge}"`);
    const ref2 = forgeTarget(target, forge);
    if (ref2.host === "generic") fail(`"${target}" does not name a repository`);
    const opts = { ...limit ? { limit } : {}, ...forge ? { kind: forge } : {} };
    if (cmd === "repo") {
      const { facts: f, note } = await repoFactsResult(ref2, opts);
      if (!f) fail(note ?? `could not read ${ref2.webUrl ?? target}`);
      emit({ ref: ref2, ...f }, [
        `  name        ${f.fullName ?? `${ref2.owner}/${ref2.repo}`}`,
        `  description ${f.description ?? "\u2014"}`,
        `  stars       ${f.stars ?? "\u2014"}`,
        `  license     ${f.license ?? "\u2014"}`,
        `  branch      ${f.defaultBranch ?? "\u2014"}`,
        `  last push   ${f.pushedAt ?? "\u2014"}`,
        ...f.archived ? ["  ARCHIVED    this repository is read-only upstream"] : []
      ]);
      return;
    }
    const r = cmd === "releases" ? await listReleases(ref2, opts) : cmd === "tags" ? await listTags(ref2, opts) : await searchIssues(ref2, (argValue(args, "terms") ?? "").split(/\s+/).filter(Boolean), cmd === "prs" ? "pr" : "issue", opts);
    if (!r.items.length) {
      if (!r.note && cmd === "releases") fail(`no releases published for ${target} \u2014 try \`webindex tags ${target}\``);
      fail(r.note ?? `nothing found for ${target}`);
    }
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
    const target = positionalText(args);
    const usageLine = `usage: webindex ${cmd} <url${cmd === "meta" ? "|file|-" : ""}>`;
    if (!target) usage(usageLine);
    if (cmd !== "meta" && !/^https?:\/\//i.test(target)) fail("expected an http(s) URL");
    const asJson = argBool(args, "json");
    const emit = (obj, human) => process.stdout.write(asJson ? jsonLine(obj) : `${human.join("\n")}
`);
    if (cmd === "robots") {
      const r = await fetchRobots(target);
      const allowed = isAllowed(r, target);
      emit({ url: target, allowed, ...r }, [
        `  allowed   ${allowed ? "yes" : "no"}`,
        `  rules     ${envFlag("NO_ROBOTS") ? `not consulted (${envName("NO_ROBOTS")})` : r.unreachable ? `none readable (${r.status ? `HTTP ${r.status}` : "no answer"}) \u2014 RFC 9309 says to assume nothing may be crawled` : r.absent ? `none (no robots.txt${r.status ? `, HTTP ${r.status}` : ""})` : r.rules.length}`,
        ...r.crawlDelayMs ? [`  delay     ${r.crawlDelayMs}ms`] : [],
        ...r.sitemaps.length ? [`  sitemaps  ${r.sitemaps.join("\n            ")}`] : []
      ]);
      if (!allowed) process.exit(1);
      return;
    }
    if (cmd === "sitemap") {
      const robots = await fetchRobots(target);
      const s = await fetchSitemap(target, { sitemaps: robots.sitemaps, max: argInt(args, "max", { min: 1 }) });
      if (!asJson) for (const n of s.notes ?? []) process.stderr.write(`${n}
`);
      if (!s.urls.length && !s.sitemaps.length) fail(`no sitemap found for ${target}`);
      const unread = s.unfetched ?? [];
      if (!asJson && unread.length)
        process.stderr.write(`${unread.length} child sitemap(s) not read \u2014 raise --max to follow them:
  ${unread.join("\n  ")}
`);
      if (!s.urls.length && !asJson) fail(`no page URLs in the ${s.sitemaps.length ? "sitemap index" : "sitemap"} read so far`);
      emit(
        s,
        s.urls.map((u) => u.loc)
      );
      return;
    }
    if (cmd === "meta") {
      const page2 = await readPage(target, "text/html,*/*", usageLine);
      const m = pageMetadata(page2.body, page2.url ? { baseUrl: page2.url } : {});
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
    const page = await httpGet(target, { accept: "text/html,application/xml,application/feed+json,*/*" });
    if (!page.ok) fail(`could not fetch ${target} (status ${page.status})`);
    const direct = parseFeed(page.body, page.url);
    const found = direct?.items.length ? [] : discoverFeeds(page.body, page.url);
    if (direct && !found.length) {
      emit(
        direct,
        direct.items.map((i) => `${i.published ? `${i.published}  ` : ""}${i.title ?? ""}
  ${i.url ?? ""}`)
      );
      return;
    }
    if (!found.length) fail(`${target} advertises no feed`);
    const feeds = [];
    for (const f of found) {
      const parsed2 = await fetchFeed(f);
      if (parsed2) feeds.push({ url: f, ...parsed2 });
    }
    if (!feeds.length) fail(`${target} advertises ${found.length} feed(s), none of which parsed`);
    emit(
      feeds,
      feeds.flatMap((f) => [`# ${f.title ?? f.url}`, ...f.items.map((i) => `${i.published ? `${i.published}  ` : ""}${i.title ?? ""}
  ${i.url ?? ""}`)])
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
      else if (noWrite) process.stdout.write(`no-write mode: nothing removed from ${cacheDir()}
`);
      else process.stdout.write(`${removed} entr${removed === 1 ? "y" : "ies"} removed (${all ? "all" : "stale only"}) from ${cacheDir()}
`);
      return;
    }
    const s = cacheStats();
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(s));
      return;
    }
    const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
    process.stdout.write(
      [
        `  dir      ${s.dir}`,
        `  entries  ${s.entries} (${s.fresh} fresh, ${s.stale} stale)`,
        `  size     ${mb(s.bytes)}`,
        `  ttl      ${Math.round(s.ttlMs / 1e3)}s`,
        ...s.oldest ? [`  oldest   ${s.oldest}`, `  newest   ${s.newest}`] : [],
        // Otherwise a refused directory reads as an empty cache that never fills.
        ...s.refused ? [`  unused   ${s.refused}: remove it, or set ${envName("CACHE_DIR")} to a directory only you can write`] : []
      ].join("\n") + "\n"
    );
    return;
  }
  if (cmd === "crawl") {
    const seed = positionalText(args);
    if (!seed) usage("usage: webindex crawl <url> --max <n>");
    if (!/^https?:\/\//i.test(seed)) fail("crawl needs an http(s) URL");
    const max = argInt(args, "max");
    if (max === void 0) usage("crawl needs --max <n> \u2014 an unbounded walk of somebody else's site is not something to do by accident");
    if (max < 1) usage("--max must be a positive whole number \u2014 a crawl without a budget is not one");
    const prefix = argValue(args, "prefix");
    const depth = argInt(args, "depth", { min: 0 });
    const r = await crawlSite(seed, {
      maxPages: max,
      ...depth !== void 0 ? { maxDepth: depth } : {},
      crossOrigin: argBool(args, "cross-origin"),
      useSitemap: !argBool(args, "no-sitemap"),
      ...prefix ? { prefix } : {}
    });
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(r));
    } else {
      for (const p of r.pages) process.stdout.write(`${p.url}${p.title ? `
  ${p.title}` : ""}
`);
      for (const d of r.disallowed) process.stderr.write(`  disallowed: ${d}
`);
      for (const n of r.notes) process.stderr.write(`  ${n}
`);
    }
    if (!r.pages.length) process.exit(EXIT_FAILURE);
    return;
  }
  if (cmd === "tables") {
    const TABLES_USAGE = "usage: webindex tables <url|file|-> [--json]";
    const url = positionalText(args);
    if (!url) usage(TABLES_USAGE);
    const page = await readPage(url, "text/html,*/*", TABLES_USAGE);
    const tables = extractTables(page.body);
    if (!tables.length) fail(`no tables on ${url}`);
    process.stdout.write(argBool(args, "json") ? jsonLine(tables) : `${tables.map(tableToMarkdown).join("\n\n")}
`);
    return;
  }
  if (cmd === "embed") {
    const EMBED_USAGE = "usage: webindex embed <text> | --docs <file.json|-> [--lines] [--json]";
    const text = positionalText(args);
    if (argValue(args, "docs") !== void 0 || argBool(args, "lines")) {
      if (text) usage(EMBED_USAGE);
      const input = readDocsInput(args, EMBED_USAGE);
      const shape = "a non-empty JSON array of strings (or one text per line with --lines)";
      let texts;
      if (argBool(args, "lines")) texts = input.text.split(/\r?\n/).filter((l) => l.trim());
      else {
        let arr;
        try {
          arr = parseJsonInput(input.text, input.label, `pass ${shape}`);
        } catch (e) {
          fail(e.message);
        }
        texts = Array.isArray(arr) && arr.every((t) => typeof t === "string") ? arr : [];
      }
      if (!texts.length) fail(`${input.label} must be ${shape}`);
      const r2 = await embed(texts);
      if (!r2.vectors.length) fail(r2.note ?? "the embedding server returned nothing");
      process.stdout.write(
        argBool(args, "json") ? jsonLine({ model: r2.model, dimensions: r2.vectors[0]?.length ?? 0, vectors: r2.vectors }) : `${r2.vectors.map((v) => v.join(" ")).join("\n")}
`
      );
      return;
    }
    if (!text) usage(EMBED_USAGE);
    const r = await embed([text]);
    if (!r.vectors.length) fail(r.note ?? "the embedding server returned nothing");
    process.stdout.write(
      argBool(args, "json") ? jsonLine({ model: r.model, dimensions: r.vectors[0]?.length ?? 0, vector: r.vectors[0] }) : `${(r.vectors[0] ?? []).join(" ")}
`
    );
    return;
  }
  if (cmd === "hybrid") {
    const HYBRID_USAGE = "usage: webindex hybrid --query <question> --docs <file.json|->";
    const question = argValue(args, "query");
    if (!question) usage(HYBRID_USAGE);
    const limit = argInt(args, "limit", { min: 1 });
    const input = readDocsInput(args, HYBRID_USAGE);
    let docs;
    try {
      docs = parseRankDocs(parseJsonInput(input.text, input.label, RANK_DOCS_SHAPE), "--docs");
    } catch (e) {
      fail(e.message);
    }
    const r = await hybridSearch(
      question,
      docs.map((d, i) => ({ id: d.url ?? String(i), title: d.title ?? "", headings: "", body: d.text ?? "" })),
      limit !== void 0 ? { limit } : {}
    );
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(r));
      return;
    }
    process.stdout.write(
      `${r.hits.map((h, i) => `${i + 1}. [${h.score.toFixed(4)}] ${h.doc.title || h.doc.id}
   ${h.doc.id}   lexical#${h.lexicalRank ?? "-"} dense#${h.denseRank ?? "-"}`).join("\n")}
`
    );
    if (r.note) process.stderr.write(`  ${r.note}
`);
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
      if (f.error) fail(`could not read ${url}: ${f.error}`);
      return;
    }
    const v = await hasChanged(
      url,
      { ...etag ? { etag } : {}, ...lastModified ? { lastModified } : {}, ...hash ? { contentHash: hash } : {} },
      { timeoutMs }
    );
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(v));
    } else {
      process.stdout.write(`${v.changed === void 0 ? "unknown" : v.changed ? "changed" : "unchanged"} (via ${v.via})
`);
      if (v.note) process.stderr.write(`  ${v.note}
`);
    }
    if (v.changed === void 0) process.exit(EXIT_FAILURE);
    return;
  }
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
        process.stdout.write(r.markdown ?? readFileSync19(r.transcript, "utf8"));
      } else {
        const m = r.meta;
        const facts = [m.channel, m.duration !== void 0 ? formatStamp(m.duration) : void 0, m.via, `${r.segments} segment${r.segments === 1 ? "" : "s"}`].filter(Boolean).join(" \xB7 ");
        process.stdout.write(`${r.transcript}
  ${m.title} \u2014 ${facts}${r.reused ? " (already on disk)" : ""}
`);
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
        onVideo: (done, total, title) => process.stderr.write(`  [${done}/${total}] ${title}
`)
      });
      if (!r.ok) fail(r.reason);
      if (asJson) process.stdout.write(jsonLine(r));
      else {
        const rows = r.videos.map((v) => `  ${v.label.padEnd(4)}${v.dir ? `${v.via?.padEnd(12)}${v.title}` : `not read \u2014 ${v.reason}`}`);
        process.stdout.write(`${r.corpus}
${rows.join("\n")}
`);
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
      let runDir;
      if (/^https?:\/\//i.test(target)) {
        const r2 = await fetchVideoRun(target, root, { lang: argValue(args, "lang") });
        if (!r2.ok) fail(`no transcript for ${target}: ${r2.reason}`);
        runDir = r2.dir;
      } else runDir = existsSync14(join27(root, target, "meta.json")) ? join27(root, target) : resolve11(target);
      const r = await extractFrames(runDir, { effort });
      if (!r.ok) {
        if (asJson) process.stdout.write(jsonLine(r));
        fail(r.reason);
      }
      if (asJson) process.stdout.write(jsonLine(r));
      else {
        const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
        process.stdout.write(
          `${r.markdown}
  ${n(r.frames.length, "frame")} in ${r.dir} (${n(r.candidates, "candidate")}, ${n(r.duplicates, "near-duplicate")} dropped, effort ${r.effort})
`
        );
      }
      return;
    }
    const query = args.positional.slice(1).join(" ").trim();
    if (!query) usage("usage: webindex video search <query> [--out <dir>] [--limit <n>] [--json]");
    const hits = searchVideoRuns(root, query, { limit: argInt(args, "limit", { min: 1 }) ?? 10 });
    if (asJson) process.stdout.write(jsonLine({ dir: root, query, hits }));
    else for (const h of hits) process.stdout.write(`[${h.label} ${h.stamp}] ${h.title}${h.chapter ? ` \u2014 ${h.chapter}` : ""}
  ${h.url}
  ${h.text}

`);
    if (!hits.length) fail(`nothing under ${root} matches "${query}" \u2014 \`webindex video fetch <url>\` reads a video first`);
    return;
  }
  if (cmd === "browser") {
    const action = args.positional[0] ?? "";
    const asJson = argBool(args, "json");
    const { runBrowserCommand: runBrowserCommand2 } = await Promise.resolve().then(() => (init_cli(), cli_exports));
    const r = await runBrowserCommand2(
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
        force: argBool(args, "force")
      },
      {
        // A UsageError, not usage(): runBrowserCommand turns it into exit 2 with its JSON.
        stdin: () => {
          if (process.stdin.isTTY) throw new UsageError("usage: webindex browser eval <expr|-> \u2014 `-` reads the expression from a pipe, not a terminal");
          return readFileSync19(0, "utf8");
        }
      }
    );
    if (r.exitCode === 0 || r.exitCode === EXIT_HUMAN) {
      process.stdout.write(asJson ? jsonLine(r.json) : `${r.text}
`);
      if (r.exitCode === EXIT_HUMAN) process.exit(EXIT_HUMAN);
      return;
    }
    if (asJson) process.stdout.write(jsonLine(r.json));
    if (r.exitCode === EXIT_USAGE) usage(r.text);
    fail(r.text);
  }
  if (cmd === "skill") {
    const action = args.positional[0] ?? "";
    const root = resolve11(argValue(args, "root") ?? process.cwd());
    const asJson = argBool(args, "json");
    if (!SKILL_ACTIONS.includes(action)) usage(`usage: webindex skill ${SKILL_ACTIONS.join("|")}`);
    if (action === "init") {
      const name2 = args.positional[1];
      if (!name2) usage("usage: webindex skill init <name> [--root <dir>]");
      const badName = skillNameProblem(name2);
      if (badName) usage(badName);
      const r = scaffoldSkill(root, name2, { exists: existsSync14 });
      for (const e of r.errors) process.stderr.write(`  ${e}
`);
      if (asJson) process.stdout.write(jsonLine(r));
      else if (r.written.length) process.stdout.write(`${r.written.map((p) => `  wrote ${relative4(root, p)}`).join("\n")}
`);
      if (!r.written.length) process.exit(EXIT_FAILURE);
      return;
    }
    const { config, errors: configErrors } = readSkillConfig(root);
    if (!config) {
      for (const e of configErrors) process.stderr.write(`webindex: ${e}
`);
      process.exit(EXIT_FAILURE);
    }
    if (action === "recall") {
      if (!recallPolicy(root)) {
        process.stdout.write("No repin.recall policy in skill.json \u2014 no artifact was compared.\n");
        return;
      }
      const lost = checkArtifactRecall(root, argValue(args, "ref") ?? "HEAD");
      if (lost.length) fail(lost.join("\n"));
      process.stdout.write("Artifact identities and evidence preserved\n");
      return;
    }
    if ((action === "finish" || action === "repin") && !have("gh")) {
      fail(`skill ${action} drives the GitHub CLI (gh), which is not installed \u2014 install it and authenticate (gh auth login, or GH_TOKEN in CI).`);
    }
    if (action === "finish") {
      await finishRepin(root);
      return;
    }
    if (action === "repin") {
      const changes = await repinSkill(root, config);
      process.stdout.write(asJson ? jsonLine({ changes }) : `${changes.join("\n") || "All pins are current"}
`);
      return;
    }
    if (action === "vendor") {
      if (argBool(args, "check")) {
        const statuses = checkPins(root, config);
        if (asJson) process.stdout.write(jsonLine(statuses));
        else
          for (const s of statuses) {
            if (s.ok) process.stdout.write(`  ok   ${s.engine} matches the ${s.tag} pin (${s.engineVersion})
`);
            else for (const p of s.problems) process.stderr.write(`  FAIL ${p}
`);
          }
        if (statuses.some((s) => !s.ok)) process.exit(EXIT_FAILURE);
        return;
      }
      const ref2 = argValue(args, "ref");
      if (!ref2) usage("usage: webindex skill vendor [--engine <name>] --ref <tag>   |   webindex skill vendor --check");
      if (!/^v\d+\.\d+\.\d+$/.test(ref2)) usage(`--ref expects a stable release tag like v1.2.3, got "${ref2}"`);
      const only = argValue(args, "engine");
      const names = only ? [only] : Object.keys(config.engines);
      const fetchFile = async (url) => {
        const res = await httpGet(url, { binary: true, maxBytes: 64 * 1024 * 1024 });
        return res.ok ? res.bytes : void 0;
      };
      for (const n of names) {
        const pin = config.engines[n];
        const r = await vendorEngine(root, config, n, ref2, fetchFile, pin ? await tagCommit(pin.repo, ref2) : void 0);
        for (const w of r.written) process.stdout.write(`  wrote ${relative4(root, w)}
`);
        if (r.errors.length) {
          for (const e of r.errors) process.stderr.write(`webindex: ${e}
`);
          process.exit(EXIT_FAILURE);
        }
        process.stdout.write(`  pinned ${n} ${r.tag} (${r.engineVersion})
`);
      }
      return;
    }
    if (action === "check") {
      const only = argValue(args, "engine");
      const engineNames2 = only ? [only] : Object.keys(config.engines);
      let failedAny = false;
      for (const engineName of engineNames2) {
        const pin = config.engines[engineName];
        if (!pin) fail(`unknown engine ${engineName}`);
        const usageConfig = { ...config, usageFloor: pin.usageFloor ?? config.usageFloor, forks: pin.forks ?? config.forks };
        const dtsFile = pin?.files?.find((f) => f.local.endsWith(".d.mts"))?.local;
        let dts = "";
        try {
          dts = readFileSync19(join27(root, config.vendorDir, dtsFile ?? ""), "utf8");
        } catch {
          fail(`cannot read the vendored declarations for "${engineName}" \u2014 run \`webindex skill vendor --ref <tag>\` first`);
        }
        const report2 = auditEngineUsage(root, usageConfig, dts, engineName);
        if (asJson) {
          process.stdout.write(jsonLine(report2));
        } else {
          for (const c of report2.collisions) process.stderr.write(`  FAIL ${c.file} declares ${c.name}, which the engine already exports
`);
          if (report2.collisions.length)
            process.stderr.write('\n  Re-export it from ./engine.js instead. (`export { X } from "./engine.js"` is fine and is not flagged.)\n');
          for (const s of report2.stale) process.stderr.write(`  FAIL forks entry "${s}" no longer matches anything \u2014 delete it
`);
          if (report2.imported.length < usageConfig.usageFloor) {
            process.stderr.write(`  FAIL only ${report2.imported.length} distinct engine symbols are imported, floor is ${usageConfig.usageFloor}.
`);
            process.stderr.write("       A layer stopped being used. If that was deliberate, lower the floor in the same commit.\n");
          }
        }
        const failed2 = report2.collisions.length > 0 || report2.stale.length > 0 || report2.imported.length < usageConfig.usageFloor;
        failedAny ||= failed2;
        if (!asJson) {
          const forks = report2.tolerated.length ? `, ${report2.tolerated.length} known fork(s) still to adopt` : ", no local re-declarations";
          process.stdout.write(
            `  ok   ${report2.imported.length} engine symbols in use (floor ${usageConfig.usageFloor})${forks}, of a ${report2.surface}-symbol surface.
`
          );
        }
      }
      if (failedAny) process.exit(EXIT_FAILURE);
      return;
    }
    if (action === "bundle") {
      const built = join27(root, "scripts", `${config.name}.mjs`);
      let surface;
      let surfaceProblem;
      const flagList = (v) => v == null || typeof v === "string" || typeof v[Symbol.iterator] !== "function" ? void 0 : [...v];
      if (existsSync14(built)) {
        try {
          const mod = await import(pathToFileURL(built).href);
          const valueFlags = flagList(mod.VALUE_FLAGS);
          const boolFlags = flagList(mod.BOOL_FLAGS);
          const commands = flagList(mod.COMMANDS);
          if (typeof mod.HELP === "string" && valueFlags && boolFlags) {
            surface = { help: mod.HELP, valueFlags, boolFlags, ...commands ? { commands } : {} };
          } else {
            surfaceProblem = "the built CLI exports no usable HELP/VALUE_FLAGS/BOOL_FLAGS \u2014 export them from the CLI entry so the docs\u2194CLI drift gate can read the real surface";
          }
        } catch (e) {
          surfaceProblem = `could not import ${relative4(root, built)} for the drift gate: ${e.message}`;
        }
      }
      const checks = auditSkillBundle(root, config, surface);
      if (surfaceProblem) checks.push({ ok: false, message: surfaceProblem });
      if (asJson) process.stdout.write(jsonLine(checks));
      else for (const c of checks) (c.ok ? process.stdout : process.stderr).write(`  ${c.ok ? "ok  " : "FAIL"} ${c.message}
`);
      const bad = checks.filter((c) => !c.ok).length;
      if (bad) {
        process.stderr.write(`
webindex: ${bad} problem(s) \u2014 the published skill would not install correctly.
`);
        process.exit(EXIT_FAILURE);
      }
      if (!asJson) process.stdout.write(`
  skills/${config.name}/ installs as a complete skill.
`);
      return;
    }
    if (action === "copy") {
      const from = join27(root, "scripts", `${config.name}.mjs`);
      if (!existsSync14(from)) fail(`missing ${relative4(root, from)} \u2014 run the build first`);
      const to = join27(root, "skills", config.name, "scripts", `${config.name}.mjs`);
      ensureDir(join27(to, ".."));
      writeArtifact(to, readFileSync19(from, "utf8"));
      process.stdout.write(`  copied ${relative4(root, from)} -> ${relative4(root, to)}
`);
      return;
    }
    if (action === "doctor") {
      const statuses = checkPins(root, config);
      const rows = statuses.map((s) => ({
        engine: s.engine,
        tag: s.tag ?? "-",
        minRef: config.engines[s.engine]?.minRef ?? "-",
        ok: s.ok,
        problems: s.problems
      }));
      if (asJson) process.stdout.write(jsonLine({ name: config.name, usageFloor: config.usageFloor, forks: Object.keys(config.forks).length, engines: rows }));
      else {
        process.stdout.write(`${config.name}
`);
        for (const r of rows) process.stdout.write(`  ${r.engine.padEnd(12)}${r.tag} (needs >= ${r.minRef})${r.ok ? "" : ` \u2014 ${r.problems[0]}`}
`);
        process.stdout.write(`  forks       ${Object.keys(config.forks).length} still to adopt
`);
      }
      return;
    }
  }
  if (cmd === "doctor") {
    const base2 = firecrawlBase();
    const sx = searxngBase();
    const ol = ollamaBase();
    const qd = qdrantBase();
    const pdfRungs = enabledExtractors();
    const docRungs = enabledDocExtractors();
    const cacheState = (id, spec) => pdfRungs.includes(id) || docRungs.includes(id) ? npxCacheState(spec) : void 0;
    const [fc, sxUp, olUp, qdUp, inspectorCache, anydocCache, ocr, ytdlp] = await Promise.all([
      base2 ? probeFirecrawl(base2) : false,
      sx ? probeSearxng(sx, searxngIsExplicit()) : false,
      probeOllama(ol),
      probeQdrant(qd),
      cacheState("pdf-inspector", PDF_INSPECTOR_SPEC),
      cacheState("anydoc", ANYDOC_SPEC),
      ocrTools(),
      ytdlpVersionAge(videoDeps().run)
    ]);
    const off = (s) => s.toLowerCase() === "off";
    const ytdlpStale = (ytdlp?.ageDays ?? 0) > YTDLP_STALE_DAYS;
    const ytdlpState = ytdlp ? `yt-dlp ${ytdlp.version}${ytdlp.ageDays !== void 0 ? ` (${ytdlp.ageDays} days old${ytdlpStale ? " \u2014 update it: `yt-dlp -U`, or your package manager" : ""})` : ""}` : "";
    const npxRung = (state) => state === "cached" ? "installed (npx cache)" : state === "not cached" ? "downloads on first use (npx)" : state === "no npx" ? "npx not found" : "runs through npx";
    const rungState = (id) => {
      if (id === "pdf-inspector") return npxRung(inspectorCache);
      if (id === "anydoc") return npxRung(anydocCache);
      if (id === "firecrawl") return base2 ? fc ? `answering at ${base2}` : `not reachable at ${base2}` : "disabled";
      if (id === "pdftotext") return have("pdftotext") ? "installed" : "not installed";
      if (id === "ocr") {
        if (ocrBudgetLeft() <= 0) return `off (${envName("OCR_MAX")}=${env("OCR_MAX")})`;
        return ocr.copyablePdf && ocr.tesseract ? "available" : `unavailable (copyable-pdf: ${ocr.copyablePdf ? "yes" : "no"}, tesseract: ${ocr.tesseract ? "yes" : "no"})`;
      }
      if (id === "builtin") return "built-in (OOXML and OpenDocument)";
      if (id === "manual-subs" || id === "auto-subs") return ytdlp ? ytdlpState : "yt-dlp not installed";
      if (id === "whisper") {
        if (!ytdlp) return "yt-dlp not installed";
        if (whisperBudgetLeft() <= 0) return `off (${envName("WHISPER_MAX")}=${env("WHISPER_MAX")})`;
        const tools = { uvx: videoDeps().have("uvx"), ffmpeg: videoDeps().have("ffmpeg") };
        return tools.uvx && tools.ffmpeg ? `available (model ${whisperModel()})` : `unavailable (uvx: ${tools.uvx ? "yes" : "no"}, ffmpeg: ${tools.ffmpeg ? "yes" : "no"})`;
      }
      return "built-in";
    };
    const rungRows = (all, enabled, engineVar) => {
      const honoured = enginesFromEnv(engineVar, all) !== void 0;
      const why = honoured ? `${envName(engineVar)}=${env(engineVar).trim()}` : envName("NO_NPX");
      return [
        ...enabled.map((id) => ({ id, enabled: true, state: rungState(id) })),
        ...all.filter((id) => !enabled.includes(id)).map((id) => ({ id, enabled: false, state: `off (${why})` }))
      ];
    };
    const pdf = rungRows(PDF_EXTRACTORS, pdfRungs, "PDF_ENGINE");
    const doc = rungRows(DOC_EXTRACTORS, docRungs, "DOC_ENGINE");
    const video = rungRows(VIDEO_TRANSCRIBERS, enabledTranscribers(), "VIDEO_ENGINES");
    const browser = await browserDoctor();
    if (argBool(args, "json")) {
      const service = (base3, up, extra = {}) => base3 ? { state: up ? "answering" : "unreachable", base: base3, ...up ? extra : {} } : { state: "disabled" };
      process.stdout.write(
        jsonLine({
          version: ENGINE_VERSION,
          services: {
            searxng: service(sx, sxUp),
            firecrawl: service(base2, fc),
            ollama: service(off(ol) ? void 0 : ol, olUp, { model: embedModel() }),
            qdrant: service(off(qd) ? void 0 : qd, qdUp)
          },
          rungs: { pdf, doc, video },
          ytdlp: ytdlp ? { ...ytdlp, stale: ytdlpStale } : { state: "not installed" },
          browser
        })
      );
      return;
    }
    const rungLines = (label, rows) => rows.map(({ id, state }, i) => `  ${(i ? "" : label).padEnd(12)}${id.padEnd(15)}${state}`);
    const bin = browser.binary;
    const sess = browser.session;
    const browserLines = [
      `  browser     ${bin.state === "found" ? `${bin.kind} at ${bin.path}` : bin.state === "error" ? bin.error : `not found \u2014 ${bin.hint}`}`,
      `              home ${browser.home}${browser.profiles.length ? ` (profiles: ${browser.profiles.join(", ")})` : ""}`,
      `              session ${sess.state === "none" ? "none" : `port ${sess.port}, profile ${sess.profile}, ${sess.launchedByUs ? "launched by webindex" : "attached"}, ${sess.state === "alive" ? "answering" : "not answering"}`}`,
      `              fetch ${browser.fetch.mode === "off" ? `off (${envName("BROWSER_FETCH")}=always|fallback turns it on)` : browser.fetch.mode}, concurrency ${browser.fetch.concurrency}`,
      ...browser.kind ? [
        `              ${browser.kind.error ? `${envName("BROWSER_KIND")}=${browser.kind.value} is invalid: ${browser.kind.error}` : `launches ${browser.kind.value} (${envName("BROWSER_KIND")})`}`
      ] : [],
      ...browser.extensions ? [
        `              extensions ${browser.extensions.error ?? browser.extensions.paths.join(", ")}`,
        ...browser.extensions.note ? [`              note: ${browser.extensions.note}`] : []
      ] : []
    ];
    const lines = [
      `webindex ${ENGINE_VERSION}`,
      `  searxng     ${sx ? sxUp ? `answering at ${sx}` : `not reachable at ${sx} \u2014 \`webindex searxng up\` starts it` : "disabled"}`,
      `  firecrawl   ${base2 ? fc ? `answering at ${base2}` : `not reachable at ${base2} \u2014 the built-in extractor is used instead` : "disabled"}`,
      `  ollama      ${off(ol) ? "disabled" : olUp ? `answering at ${ol} (model ${embedModel()})` : `not reachable at ${ol} \u2014 \`webindex semantic up\` starts it`}`,
      `  qdrant      ${off(qd) ? "disabled" : qdUp ? `answering at ${qd}` : `not reachable at ${qd} \u2014 \`webindex semantic up\` starts it`}`,
      ...rungLines("pdf rungs", pdf),
      ...rungLines("doc rungs", doc),
      ...rungLines("video rungs", video),
      ...browserLines,
      "",
      "  Everything optional degrades to a note \u2014 nothing above is required, and none of it needs a key."
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  fail(`unknown command "${cmd}" \u2014 run \`webindex --help\``);
}
function isStartedFile() {
  try {
    return !!process.argv[1] && pathToFileURL(realpathSync4(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}
if (isInvokedDirectly() || isStartedFile()) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e) => {
      if (e.code === "EPIPE") process.exit(EXIT_OK);
      throw e;
    });
  }
  main().catch((e) => {
    process.stderr.write(`webindex: ${e.message}
`);
    process.exit(EXIT_FAILURE);
  });
}
export {
  BOOL_FLAGS,
  COMMANDS,
  HELP,
  VALUE_FLAGS,
  main,
  mcpPolicy,
  webindexAdapter
};
