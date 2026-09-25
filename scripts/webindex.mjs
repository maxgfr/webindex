#!/usr/bin/env node

// src/skillkit/recall.ts
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
function preserves(before, after, policy, key = "") {
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return false;
    const candidates = before.map((old) => after.flatMap((next, i) => preserves(old, next, policy, key) ? [i] : []));
    const owner = /* @__PURE__ */ new Map();
    const assign = (row, seen) => {
      for (const candidate of candidates[row] ?? []) {
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
    return candidates.every((_, row) => assign(row, /* @__PURE__ */ new Set()));
  }
  if (before !== null && typeof before === "object") {
    if (after === null || typeof after !== "object" || Array.isArray(after)) return false;
    return Object.entries(before).every(([k, value]) => policy.ignoreKeys?.includes(k) || preserves(value, after[k], policy, k));
  }
  if (typeof before === "number" && typeof after === "number") {
    if (policy.growing?.includes(key)) return after >= before;
    if (policy.shrinking?.includes(key)) return after <= before;
  }
  return Object.is(before, after);
}
function checkArtifactRecall(root, ref = "HEAD") {
  const config = JSON.parse(readFileSync(join(root, "skill.json"), "utf8"));
  const policy = config.repin?.recall;
  if (!policy) return [];
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const files = git(["ls-tree", "-r", "--name-only", ref, "--", ...policy.paths]).trim().split("\n").filter(Boolean);
  if (!files.length) throw new Error("No baseline artifacts matched the declared recall paths");
  const lost = [];
  for (const file of files) {
    const before = git(["show", `${ref}:${file}`]);
    let after;
    try {
      after = readFileSync(join(root, file), "utf8");
    } catch {
      lost.push(`${file}: deleted`);
      continue;
    }
    if (before === after) continue;
    if (file.endsWith(".json")) {
      try {
        if (preserves(JSON.parse(before), JSON.parse(after), policy)) continue;
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
        await new Promise((resolve5) => setTimeout(resolve5, 2e3));
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
import { join as join3 } from "path";
import { readFileSync as readFileSync3 } from "fs";

// src/no-write.ts
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs";

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

// src/no-write.ts
var flagged = false;
function isNoWrite() {
  return flagged || envFlag("NO_WRITE");
}
var collected = [];
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
var tmpCounter = 0;
function writeFileAtomic(path, content) {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
}

// src/run.ts
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
  const name = typeof raw.name === "string" && raw.name ? raw.name : void 0;
  if (!name) errors.push(`${SKILL_CONFIG}: "name" must be a non-empty string.`);
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
      name,
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
import { createHash } from "crypto";
import { readFileSync as readFileSync4 } from "fs";
import { join as join5 } from "path";
var sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
function checkPins(root, config) {
  return Object.entries(config.engines).map(([name, pin]) => {
    const problems = [];
    const metaPath = join5(root, config.vendorDir, pin.meta);
    const meta = readJsonSafe(metaPath);
    if (!meta?.tag || !meta.sha256) {
      return {
        engine: name,
        ok: false,
        problems: [`no readable pin at ${config.vendorDir}/${pin.meta} \u2014 run \`skill vendor --engine ${name} --ref <tag>\` first.`]
      };
    }
    for (const f of pin.files ?? []) {
      const local = join5(root, config.vendorDir, f.local);
      let actual;
      try {
        actual = sha256(readFileSync4(local));
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
        `STALE ${name} pin \u2014 vendored ${meta.tag}, but this repo's source needs at least ${pin.minRef}. Run \`skill vendor --engine ${name} --ref ${pin.minRef}\` (or newer).`
      );
    }
    return { engine: name, ok: problems.length === 0, tag: meta.tag, engineVersion: meta.engineVersion, problems };
  });
}
async function vendorEngine(root, config, name, ref, fetchFile, commit) {
  const pin = config.engines[name];
  if (!pin) return { written: [], errors: [`unknown engine "${name}" \u2014 expected one of: ${Object.keys(config.engines).join(", ")}.`] };
  if (!/^v\d+\.\d+\.\d+$/.test(ref)) return { written: [], errors: [`invalid stable release tag ${ref}`] };
  if (compareTags(ref, pin.minRef) < 0) return { written: [], errors: [`${ref} is below the minimum ${pin.minRef}`] };
  if (commit !== void 0 && !/^[a-f0-9]{40}$/.test(commit)) return { written: [], errors: ["invalid upstream commit"] };
  const vendorDir = join5(root, config.vendorDir);
  const current2 = readJsonSafe(join5(vendorDir, pin.meta));
  if (current2?.tag && compareTags(ref, current2.tag) < 0) return { written: [], errors: [`refusing downgrade from ${current2.tag} to ${ref}`] };
  const staged = [];
  const sums = {};
  for (const f of pin.files ?? []) {
    const url = `https://raw.githubusercontent.com/${pin.repo}/${commit ?? ref}/${f.remote}`;
    const buf = await fetchFile(url);
    if (!buf) return { written: [], errors: [`could not fetch ${url}`] };
    staged.push({ local: join5(vendorDir, f.local), buf });
    sums[f.local] = sha256(buf);
  }
  const engineVersion = /(?:^|\n)\s*(?:(?:var|const|let)\s+)?ENGINE_VERSION\s*=\s*"([^"]+)"/.exec(staged[0]?.buf.toString("utf8") ?? "")?.[1];
  if (!engineVersion || `v${engineVersion}` !== ref)
    return {
      written: [],
      errors: [
        `the ${name} bundle reports ENGINE_VERSION=${engineVersion ?? "?"} but the pinned ref is ${ref} \u2014 refusing to record a pin that disagrees with its bytes.`
      ]
    };
  if (current2?.tag === ref && (current2.commit && commit && current2.commit !== commit || Object.entries(current2.sha256).some(([file, hash]) => sums[file] !== hash))) {
    return { written: [], errors: [`upstream moved the existing ${ref} pin`] };
  }
  const meta = { tag: ref, engineVersion, sha256: sums, syncedAt: (/* @__PURE__ */ new Date()).toISOString(), ...commit ? { commit } : {} };
  ensureDir(vendorDir);
  for (const file of staged) writeFileAtomic(file.local, file.buf);
  const metaPath = join5(vendorDir, pin.meta);
  writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}
`);
  return { written: [...staged.map((f) => f.local), metaPath], errors: [], tag: ref, engineVersion };
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
  for (const [name, engine] of Object.entries(config.engines)) {
    const pin = JSON.parse(readFileSync5(join6(root, config.vendorDir, engine.meta), "utf8"));
    const tag = latest(engine.repo);
    if (compareTags(tag, pin.tag) < 0) throw new Error(`Refusing downgrade of ${name}: ${pin.tag} -> ${tag}`);
    if (engine.dependency && pkg.devDependencies?.[engine.dependency] !== tag.slice(1)) {
      pkg.devDependencies = { ...pkg.devDependencies, [engine.dependency]: tag.slice(1) };
      changes.push(`${engine.dependency} -> ${tag}`);
    }
    if (tag === pin.tag && pin.commit) continue;
    const result = await vendorEngine(root, config, name, tag, fetchEngineFile, releaseCommit(engine.repo, tag));
    if (result.errors.length) throw new Error(result.errors.join("\n"));
    if (engine.dependency) pkg.devDependencies[engine.dependency] = tag.slice(1);
    changes.push(`${name}: ${pin.tag} -> ${tag}`);
  }
  const toolTag = latest("maxgfr/webindex");
  const toolCommit = releaseCommit("maxgfr/webindex", toolTag);
  const toolUrl = `https://codeload.github.com/maxgfr/webindex/tar.gz/${toolCommit}`;
  const oldTool = pkg.devDependencies?.["@maxgfr/webindex"];
  if (oldTool !== toolUrl) {
    const installed = JSON.parse(readFileSync5(join6(root, "node_modules/@maxgfr/webindex/package.json"), "utf8"));
    if (compareTags(toolTag, `v${installed.version}`) < 0) throw new Error("Refusing maintenance-tool downgrade");
    pkg.devDependencies = { ...pkg.devDependencies, "@maxgfr/webindex": toolUrl };
    changes.push(`skillkit -> ${toolTag} (${toolCommit})`);
  }
  if (changes.length) writeFileSync2(pkgPath, `${JSON.stringify(pkg, null, 2)}
`);
  return changes;
}

// src/cli.ts
import { existsSync as existsSync7, readFileSync as readFileSync12 } from "fs";
import { basename as basename4, extname, join as join15, relative as relative2, resolve as resolve4 } from "path";
import { pathToFileURL } from "url";

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
var UTF16_LABELS = /* @__PURE__ */ new Set(["utf-16", "utf-16le", "utf-16be", "unicode", "unicodefeff", "unicodefffe", "ucs-2", "csunicode", "iso-10646-ucs-2"]);
function prescanLabel(label) {
  const lower = label.toLowerCase();
  if (UTF16_LABELS.has(lower)) return "utf-8";
  return lower === "x-user-defined" ? "windows-1252" : lower;
}
var META_TAG = /<meta\b(?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*(?:>|$)/gi;
var TAG_ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s"'=<>`]+)))?/g;
function metaAttributes(tag) {
  const attrs = /* @__PURE__ */ new Map();
  for (const m of tag.slice(5).matchAll(TAG_ATTRIBUTE)) {
    const value = m[2] ?? m[3] ?? m[4];
    const name = m[1].toLowerCase();
    if (value !== void 0 && !attrs.has(name)) attrs.set(name, value);
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
var XML_DECLARATION = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/;
function charsetFromXmlDeclaration(bytes) {
  const label = XML_DECLARATION.exec(bytes.subarray(0, 256).toString("latin1"))?.[1];
  return label ? prescanLabel(label) : void 0;
}
var isUtf8Label = (label) => label === "utf-8" || label === "utf8";
var SNIFFABLE_MIME = /* @__PURE__ */ new Set(["", "text/html", "application/xhtml+xml", "application/octet-stream"]);
function decodeUtf8OrCp1252(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text;
  try {
    text = decoder.decode(bytes, { stream: true });
  } catch {
    return decodeCp1252(bytes);
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
}
var CP1252_C1 = [
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
var CP1252_LABELS = /* @__PURE__ */ new Set([
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
var CP1252_C1_RANGE = /[\x80-\x9f]/g;
var cp1252C1 = (c) => String.fromCharCode(CP1252_C1[c.charCodeAt(0) - 128]);
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

// src/version.ts
var ENGINE_VERSION = "1.20.0";

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
  return new Promise((resolve5) => {
    let child;
    try {
      child = spawn(binaryName(cmd), args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve5({ ok: false, stdout: "", error: e.message });
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve5(r);
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
import { mkdtempSync, readFileSync as readFileSync6, rmSync, writeFileSync as writeFileSync3, existsSync } from "fs";
import { join as join7 } from "path";
import { tmpdir } from "os";
var DEFAULT_TIMEOUT_MS = 3e5;
var DEFAULT_MAX_DOCS = 3;
var DEFAULT_LANG = "eng";
var spent = 0;
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
var toolsProbe;
async function ocrPdf(bytes) {
  if (ocrBudgetLeft() <= 0) return void 0;
  const { copyablePdf, tesseract } = await ocrTools();
  if (!copyablePdf || !tesseract) return void 0;
  const dir = mkdtempSync(join7(tmpdir(), `${brand().name}-ocr-`));
  try {
    const input = join7(dir, "in.pdf");
    const output = join7(dir, "out.pdf");
    writeFileSync3(input, bytes);
    const lang = env("OCR_LANG") || DEFAULT_LANG;
    const r = await runWithInput("copyable-pdf", ["-o", output, "-m", "-l", lang, input], Buffer.alloc(0), envInt("OCR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
    spent++;
    if (!r.ok) return void 0;
    const md = output.replace(/\.pdf$/, ".md");
    return existsSync(md) ? readFileSync6(md, "utf8") : void 0;
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

// src/entities.ts
var NAMED = `
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
var INVISIBLE = /* @__PURE__ */ new Set([173, 8203, 8204, 8205, 8206, 8207, 8288, 65279]);
var charFor = (cp) => INVISIBLE.has(cp) ? "" : String.fromCodePoint(cp);
var ENTITY_BY_NAME = /* @__PURE__ */ new Map();
{
  const parts = NAMED.trim().split(/\s+/);
  for (let i = 0; i < parts.length; i += 2) ENTITY_BY_NAME.set(parts[i], charFor(Number.parseInt(parts[i + 1], 16)));
  ENTITY_BY_NAME.set("nbsp", " ");
}
var ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;
function numericChar(n) {
  if (n >= 128 && n <= 159) return String.fromCodePoint(CP1252_C1[n - 128]);
  if (n === 0 || !(n <= 1114111) || n >= 55296 && n <= 57343) return "\uFFFD";
  return charFor(n);
}
function decodeEntities(s) {
  return s.replace(ENTITY_RE, (m, ref) => {
    if (ref[0] !== "#") return ENTITY_BY_NAME.get(ref) ?? m;
    return numericChar(ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
  });
}

// src/html.ts
var BLOCK_TAGS = /* @__PURE__ */ new Set([
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
var INLINE_TAGS = /* @__PURE__ */ new Set([
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
var TAG_RE = /<[a-zA-Z!/?][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
var LOOSE_TAG_RE = /<[a-zA-Z!/?][^<>]*>/g;
var tagName = (tag) => /^<\/?([a-zA-Z][^\s/>]*)/.exec(tag)?.[1]?.toLowerCase() ?? "";
var CLOSE_TAG_RE = /* @__PURE__ */ new Map();
function closeTagRe(name) {
  let re = CLOSE_TAG_RE.get(name);
  if (!re) CLOSE_TAG_RE.set(name, re = new RegExp(`</${name}\\s*>`, "gi"));
  return re;
}
function htmlAttributes(tag) {
  const attrs = /* @__PURE__ */ new Map();
  for (const m of tag.matchAll(/(?<![^\s"'<>/=])([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}
function dropElements(html, names, toEof = /* @__PURE__ */ new Set()) {
  const open = new RegExp(`<!--|<(${names.join("|")})(?=[\\s/>])`, "gi");
  const unclosed = /* @__PURE__ */ new Set();
  let out = "";
  let last = 0;
  let m;
  while (m = open.exec(html)) {
    const name = m[1]?.toLowerCase() ?? "!--";
    if (unclosed.has(name)) continue;
    let end;
    if (name === "!--") {
      const close = html.indexOf("-->", m.index + 2);
      end = close < 0 ? -1 : close + 3;
    } else {
      const close = closeTagRe(name);
      close.lastIndex = open.lastIndex;
      const c = close.exec(html);
      end = c ? c.index + c[0].length : toEof.has(name) ? html.length : -1;
    }
    if (end < 0) {
      unclosed.add(name);
      continue;
    }
    out += html.slice(last, m.index) + " ";
    last = open.lastIndex = end;
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
  const regions = [...names].flatMap((name) => balancedRegions(html, name, (open) => hasRole.test(open))).sort((a, b) => a.from - b.from);
  let out = "";
  let last = 0;
  for (const r of regions) {
    if (r.from < last) continue;
    out += `${html.slice(last, r.from)} `;
    last = r.to;
  }
  return last === 0 ? html : out + html.slice(last);
}
var CHROME_ROLES = ["navigation", "banner", "contentinfo"];
var HIDDEN_ELEMENTS = ["script", "style", "noscript", "head", "svg", "template", "select", "datalist"];
var CHROME_ELEMENTS = ["nav", "footer"];
var RAW_TEXT_ELEMENTS = /* @__PURE__ */ new Set(["script", "style"]);

// src/url.ts
var TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|gclsrc$|dclid$|msclkid$|yclid$|twclid$|ttclid$|li_fat_id$|mkt_tok$|_gl$|mc_|ref_src$|ref_url$|spm$|_hsenc$|_hsmi$|igshid$|igsh$)/i;
var SHARE_SI_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/;
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
var LOCAL_FILE_DOMAIN = "local file";
var FNV_OFFSET_HI = 3421674724;
var FNV_OFFSET_LO = 2216829733;
var FNV_PRIME_LOW = 435;
var laneHi = 0;
var laneLo = 0;
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

// src/text.ts
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
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
  "ne",
  "vs",
  // German question scaffolding: the locale layer targets DE as well as FR.
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
var NON_ASCII = /[\u0080-\uffff]/;
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
function slugify(input, opts = {}) {
  const max = opts.max ?? 120;
  const normalized = input.toLowerCase().replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/\.git$/, "");
  const s = normalized.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/[\u0080-\uffff]/.test(normalized) && s.length <= max) return s || (opts.fallback ?? "");
  const tag = fnv1a64(normalized).toString(16).padStart(16, "0").slice(0, 8);
  const head = s.slice(0, Math.max(0, max - tag.length - 1)).replace(/-+$/, "");
  return head ? `${head}-${tag}` : tag;
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
  return `${b.name}/${b.version ?? "1.x"} (+${b.contactUrl ?? `https://github.com/maxgfr/${b.name}`})`;
}
function defaultUa() {
  return brand().defaultUa === "contact" ? contactUa() : browserUa();
}
var RETRY_STATUS = /* @__PURE__ */ new Set([429, 503, 502, 504]);
var maxAttempts = () => envInt("MAX_ATTEMPTS", 2, 1, 5);
var defaultRetryMs = () => envInt("RETRY_MS", 600, 0, 5e3);
var defaultTimeoutMs = () => envInt("TIMEOUT_MS", 2e4, 1e3, 3e5);
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
var RETRY_AFTER_CAP_MS = 5e3;
function retryDelayMs(retryAfterMs) {
  if (retryAfterMs === void 0) return defaultRetryMs();
  return retryAfterMs <= RETRY_AFTER_CAP_MS ? retryAfterMs : void 0;
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
var PERMANENT_CODES = /* @__PURE__ */ new Set([
  "ENOTFOUND",
  "ERR_INVALID_URL",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
]);
var PERMANENT_MESSAGE = /redirect count exceeded|scheme must be|unknown scheme|bad port|invalid url|failed to parse url/i;
function isPermanentFailure(e) {
  const err = e;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string" && PERMANENT_CODES.has(code)) return true;
  return [err?.message, err?.cause?.message].some((m) => typeof m === "string" && PERMANENT_MESSAGE.test(m));
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
  const read2 = await readCappedBytes(res, max + 1);
  const bytes = read2.subarray(0, max);
  return { bytes, bytesRead: bytes.length, truncated: read2.length > max };
}
var DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
function isBinaryDocument(contentType) {
  return /application\/pdf/i.test(contentType) || docFormatForContentType(contentType) !== void 0;
}
var REDIRECT_STATUS = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
async function authorizedGet(url, init, authorize) {
  let target = url;
  const fail2 = (error) => ({ failure: { ok: false, status: 0, body: "", contentType: "", url: target, error } });
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
    if (redirects >= 20) return fail2("Too many redirects (maximum 20)");
    try {
      const next = new URL(location, target);
      if (!/^https?:$/.test(next.protocol)) return fail2(`Unsupported redirect protocol: ${next.protocol}`);
      if (next.origin !== new URL(target).origin) {
        delete headers.authorization;
        delete headers.cookie;
        delete headers["proxy-authorization"];
      }
      target = next.href;
    } catch {
      return fail2(`Invalid redirect URL from ${target}`);
    }
  }
}
async function httpGet(url, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, body: "", contentType: "", url };
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
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
      const max = opts.maxBytes ?? (isBinaryDocument(meta.contentType) ? opts.maxDocumentBytes : void 0) ?? DEFAULT_MAX_RESPONSE_BYTES;
      const declared = Number(res.headers.get("content-length"));
      const prefixUseless = opts.binary || isBinaryDocument(meta.contentType) || Object.keys(opts.headers ?? {}).some((k) => k.toLowerCase() === "range");
      if (Number.isFinite(declared) && declared > max && prefixUseless) {
        ctrl.abort();
        return { ok: false, status: res.status, body: "", bytesRead: 0, truncated: true, ...meta, error: `response too large: ${declared} bytes > ${max} cap` };
      }
      const { bytes, bytesRead, truncated } = res.status === 304 ? { bytes: Buffer.alloc(0), bytesRead: 0, truncated: false } : await readMeasuredBody(res, max);
      countFetch(bytes.length, false);
      const keepBytes = opts.binary || isBinaryDocument(meta.contentType) && !truncated;
      const result = {
        ok: res.ok,
        status: res.status,
        // Decoded per the response's own encoding, not assumed UTF-8. A
        // Windows-1252 page used to come back with every accented character
        // replaced by U+FFFD, and nothing anywhere noticed.
        body: opts.binary ? "" : decodeBody(bytes, meta.contentType),
        bytes: keepBytes ? bytes : void 0,
        bytesRead,
        truncated,
        ...meta
      };
      const wait = RETRY_STATUS.has(res.status) && attempt < attempts - 1 ? retryDelayMs(meta.retryAfterMs) : void 0;
      if (wait !== void 0) {
        last = result;
        await sleep(wait);
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, body: "", contentType: "", url, error: timedOut ? `timed out after ${timeoutMs} ms` : networkFailure(e) };
      if (timedOut || isPermanentFailure(e)) break;
      if (attempt < attempts - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
async function httpJson(method, url, body, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, data: void 0 };
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
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
      last = { ok: false, status: 0, data: void 0, error: timedOut ? `timed out after ${timeoutMs} ms` : networkFailure(e) };
      if (timedOut || isPermanentFailure(e)) break;
      if (attempt < attempts - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
var INLINE_FORMAT = /* @__PURE__ */ new Set([...INLINE_TAGS, "br", "scp"]);
var INLINE_FORMAT_TAG = /<(\/?)([a-zA-Z][\w.-]*(?::[\w.-]+)?)(?=[\s/>])([^<>]*)>/g;
function cleanInline(s) {
  const text = decodeEntities(String(s));
  const opened = /* @__PURE__ */ new Set();
  const closed = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(INLINE_FORMAT_TAG)) (m[1] ? closed : opened).add(m[2].toLowerCase());
  return text.replace(INLINE_FORMAT_TAG, (tag, slash, rawName, attrs) => {
    const name = rawName.toLowerCase();
    if (name.startsWith("mml:") || name.startsWith("jats:")) return "";
    if (!INLINE_FORMAT.has(name)) return tag;
    if (name === "br") return " ";
    const markup = attrs.trim().replace(/\/$/, "") !== "" || name === "wbr" || (slash ? opened : closed).has(name);
    return markup ? "" : tag;
  }).replace(/\s+/g, " ").trim();
}
var NUL = "\0";
var PRE_SLOT = (i) => `
${NUL}${i}${NUL}
`;
function preSlotIndex(line) {
  if (line.length < 3 || line[0] !== NUL || line[line.length - 1] !== NUL) return void 0;
  const i = Number(line.slice(1, -1));
  return Number.isInteger(i) ? i : void 0;
}
function setAsidePre(html, blocks) {
  const open = /<pre(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const close = closeTagRe("pre");
  let out = "";
  let last = 0;
  let m;
  while (m = open.exec(html)) {
    close.lastIndex = open.lastIndex;
    const c = close.exec(html);
    if (!c) break;
    const inner = html.slice(open.lastIndex, c.index);
    const text = decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(LOOSE_TAG_RE, "")).replace(/\r\n?/g, "\n").replace(/^\n/, "").trimEnd();
    blocks.push(text);
    out += html.slice(last, m.index) + PRE_SLOT(blocks.length - 1);
    last = open.lastIndex = c.index + c[0].length;
  }
  return last === 0 ? html : out + html.slice(last);
}
var HEADING_OPEN = /<h([1-6])(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
var HEADING_BOUNDARY = /<\/h[1-6]\s*>|<h[1-6](?=[\s/>])/gi;
var PERMALINK = /<a\b[^<>]*>\s*(?:(?:¶|#|§|🔗|&para;|&#182;|&#x[bB]6;|&sect;)\s*)?<\/a\s*>/gi;
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
  let s = dropElements(html.includes(NUL) ? html.split(NUL).join("\uFFFD") : html, hidden, RAW_TEXT_ELEMENTS);
  if (!opts.fullPage) s = dropLandmarks(s, CHROME_ROLES);
  const pre = [];
  s = flattenHeadings(setAsidePre(s, pre));
  let prevEnd = -1;
  let prevClosed = false;
  s = s.replace(TAG_RE, (tag, at) => {
    const closing = tag[1] === "/";
    const adjacent = at === prevEnd && prevClosed && !closing;
    prevEnd = at + tag.length;
    prevClosed = closing;
    const name = tagName(tag);
    if (/^h[1-6]$/.test(name)) {
      return closing ? "\n" : "\n" + "#".repeat(Number(name[1])) + " ";
    }
    if (BLOCK_TAGS.has(name) || name === "br" || name === "hr") return "\n";
    if (INLINE_TAGS.has(name)) return adjacent ? " " : "";
    return " ";
  });
  s = s.replace(LOOSE_TAG_RE, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map((l) => {
    const t = l.trim();
    const slot = preSlotIndex(t);
    return slot === void 0 ? t : pre[slot] ?? t;
  }).filter((l) => l.length > 0).join("\n");
}
var NOT_TITLE = ["script", "style", "template", "svg"];
function firstElementText(html, name) {
  const open = new RegExp(`<${name}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "i").exec(html);
  if (!open) return void 0;
  const close = closeTagRe(name);
  close.lastIndex = open.index + open[0].length;
  const c = close.exec(html);
  if (!c) return void 0;
  const inner = html.slice(open.index + open[0].length, c.index).replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ");
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
  const clean2 = dropElements(html, NOT_TITLE);
  return firstElementText(clean2, "title") ?? metaContent(clean2, ["og:title", "twitter:title"]) ?? firstElementText(clean2, "h1");
}
function htmlCanonicalUrl(html) {
  const clean2 = dropElements(html, ["script", "style", "template"]);
  const end = clean2.search(/<\/head\s*>|<body(?=[\s/>])/i);
  const head = end < 0 ? clean2 : clean2.slice(0, end);
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
function absoluteCanonical(href, base) {
  if (!href) return void 0;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : void 0;
  } catch {
    return void 0;
  }
}
var visibleLength = (h) => h.replace(/<[^<>]*>/g, " ").replace(/\s+/g, " ").trim().length;
var ROLE_MAIN = /\srole\s*=\s*["']?main(?=["'\s/>])/i;
var ROLE_MAIN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])[^<>]*\srole\s*=\s*["']?main(?=["'\s/>])/g;
var CONTENT_WORDS = /* @__PURE__ */ new Set(["content", "article", "post", "entry", "story", "main", "prose"]);
var CHROME_WORDS = /* @__PURE__ */ new Set([
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
function isContentContainer(open) {
  const attrs = htmlAttributes(open);
  for (const token of `${attrs.get("id") ?? ""} ${attrs.get("class") ?? ""}`.toLowerCase().split(/\s+/)) {
    if (token === "markdown-body") return true;
    const words = token.split(/\W+/);
    if (words.some((w) => CONTENT_WORDS.has(w)) && !words.some((w) => CHROME_WORDS.has(w))) return true;
  }
  return false;
}
function blockKind(open) {
  const tag = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(open)?.[1]?.toLowerCase() ?? "";
  const firstClass = (htmlAttributes(open).get("class") ?? "").trim().split(/\s+/)[0];
  return `${tag} ${firstClass.replace(/\d+/g, "0")}`;
}
function extractMainHtml(html) {
  const clean2 = dropElements(html, ["script", "style", "template", "svg"]);
  const roleMainTags = /* @__PURE__ */ new Set(["main"]);
  for (const m of clean2.matchAll(ROLE_MAIN_TAG)) roleMainTags.add(m[1].toLowerCase());
  const tiers = [
    { tags: [...roleMainTags], isCandidate: (open) => /^<main[\s/>]/i.test(open) || ROLE_MAIN.test(open) },
    { tags: ["article"], isCandidate: () => true },
    { tags: ["div", "section"], isCandidate: isContentContainer }
  ];
  for (const tier of tiers) {
    const regions = tier.tags.flatMap((tag) => balancedRegions(clean2, tag, tier.isCandidate)).sort((a, b) => a.start - b.start);
    if (!regions.length) continue;
    const outer = [];
    let reach = -1;
    for (const r of regions) {
      if (r.start < reach) continue;
      reach = r.end;
      outer.push({ ...r, len: visibleLength(clean2.slice(r.start, r.end)) });
    }
    let best = outer[0];
    for (const r of outer) if (r.len > best.len) best = r;
    const kind = blockKind(best.open);
    const kept = outer.filter((r) => r === best || blockKind(r.open) === kind);
    const keptLen = kept.reduce((n, r) => n + r.len, 0);
    if (keptLen < 500 && keptLen < visibleLength(clean2) * 0.3) return html;
    if (kept.length === 1) return clean2.slice(best.start, best.end);
    return kept.map((r) => `<div>${clean2.slice(r.start, r.end)}</div>`).join("\n");
  }
  return html;
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
  if (!wantsPdf && !wantsDoc && !opts.authorizeUrl && !opts.fullPage) {
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
  const fetchOpts = { ...base, maxDocumentBytes: PDF_FETCH_OPTS.maxBytes, headers: opts.headers, authorizeUrl: opts.authorizeUrl, timeoutMs: opts.timeoutMs };
  let res = await httpGet(url, fetchOpts);
  const toldToWait = (res.retryAfterMs ?? 0) > RETRY_AFTER_CAP_MS;
  if (!res.ok && !toldToWait && brand().defaultUa === "contact" && (res.status === 403 || res.status === 429)) {
    res = await httpGet(url, { ...fetchOpts, userAgent: browserUa(), acceptLanguage: opts.acceptLanguage ?? "en-US,en;q=0.9" });
  }
  if (res.status === 304) {
    return { text: "", finalUrl: res.url, status: 304, etag: res.etag ?? opts.headers?.["if-none-match"], lastModified: res.lastModified };
  }
  if (!res.ok) {
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
  if (res.truncated && (wantsPdf || wantsDoc || isBinaryDocument(res.contentType))) {
    return { text: "", finalUrl: res.url, status: res.status, note: `Fetched ${url} but the document exceeds the response size cap.` };
  }
  if (wantsPdf || /application\/pdf/i.test(res.contentType)) {
    const bytes = res.bytes ?? (await httpGet(url, { ...PDF_FETCH_OPTS, headers: opts.headers, authorizeUrl: opts.authorizeUrl, timeoutMs: opts.timeoutMs })).bytes;
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
  const docFmt = wantsDoc ?? docFormatForContentType(res.contentType);
  if (docFmt) {
    const bytes = res.bytes ?? (await httpGet(url, { ...DOC_FETCH_OPTS, headers: opts.headers, authorizeUrl: opts.authorizeUrl, timeoutMs: opts.timeoutMs })).bytes;
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
  const mime = res.contentType.split(";")[0].trim().toLowerCase();
  const ambiguousType = !mime || mime === "application/octet-stream";
  const isHtml = /^(?:text\/html|application\/xhtml\+xml)$/.test(mime) || ambiguousType && /^\s*<(?:!doctype\s+html\b|html\b|head\b|body\b|article\b|main\b|p\b|h[1-6]\b)/i.test(res.body);
  const stripped = isHtml ? htmlToText(opts.fullPage ? res.body : extractMainHtml(res.body), opts) : res.body;
  const consent = isHtml && opts.stripConsent && !opts.fullPage ? stripConsentBoilerplate(stripped) : { text: stripped, dropped: 0 };
  const title = isHtml ? pageTitle(res.body) : void 0;
  const canonical = isHtml ? absoluteCanonical(htmlCanonicalUrl(res.body), res.url) : void 0;
  const metaDescription = isHtml ? metaDescriptionOf(res.body) : void 0;
  const cut = res.truncated ? `Read only the first ${res.bytesRead} bytes of ${url} (the response size cap), so this text is a prefix.` : void 0;
  return {
    text: consent.text,
    consentDropped: consent.dropped,
    title,
    canonical,
    metaDescription,
    ...opts.keepHtml && isHtml ? { html: res.body } : {},
    finalUrl: res.url,
    status: res.status,
    note: [firecrawlNote, cut].filter(Boolean).join(" ") || void 0,
    ...res.truncated ? { truncated: true } : {},
    ...validators
  };
}
var CONSENT_PATTERNS = [
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
var CONSENT_ACTIONS = [
  /\b(?:accept|reject|decline|agree|allow|manage|preferences|settings|choices)\b/i,
  /\b(?:opt[ -]out|we use cookies|this (?:site|website) uses cookies|by continuing)\b/i,
  /\b(?:learn more|privacy policy|cookie policy)\b/i
];
var BANNER_VOICE = /\b(?:we|us|our)\b[^.]{0,60}?\b(?:cookies?|partners|consent|tracking)\b|\bby (?:clicking|continuing|using|browsing)\b|\bthis (?:site|website) uses cookies\b|\bnous (?:utilisons|et nos partenaires)\b|\ben cliquant sur\b|\bwir (?:verwenden|nutzen|setzen|und unsere partner)\b|\bmit (?:dem )?klick auf\b/i;
var BUTTON_LABEL = /^(?:tout (?:accepter|refuser)|(?:accepter|refuser) tout|accepter et (?:fermer|continuer)|continuer sans accepter|(?:param[ée]trer|g[ée]rer|personnaliser|accepter|refuser) (?:les|mes) cookies|alle (?:cookies )?(?:akzeptieren|ablehnen)|nur (?:notwendige|essenzielle)(?: cookies)?|cookie-einstellungen|einstellungen verwalten|akzeptieren und schlie(?:ß|ss)en)$/i;
var BUTTON_LENGTH = 40;
var NOTICE_LENGTH = 400;
function stripConsentBoilerplate(text) {
  let dropped = 0;
  const kept = text.split("\n").filter((line) => {
    const t = line.trim();
    const hits = CONSENT_PATTERNS.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
    const isBanner = BUTTON_LABEL.test(t) || hits >= 1 && t.length <= BUTTON_LENGTH && (hits >= 2 || CONSENT_ACTIONS.some((re) => re.test(t))) || hits >= 1 && t.length < NOTICE_LENGTH && BANNER_VOICE.test(t);
    if (isBanner) dropped++;
    return !isBanner;
  });
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

// src/stack.ts
import { spawnSync } from "child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync7, writeFileSync as writeFileSync4 } from "fs";
import { tmpdir as tmpdir2 } from "os";
import { dirname, join as join8 } from "path";
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
  return env("CACHE_DIR") ?? brand().cacheDir ?? join8(tmpdir2(), brand().name);
}
function ensureComposeMaterialized() {
  const base = join8(cacheRoot(), "compose");
  const composePath = join8(base, "docker-compose.yml");
  const settingsPath = join8(base, "docker", "searxng", "settings.yml");
  const firecrawlEnvPath = join8(base, "docker", "firecrawl", "firecrawl.env");
  writeIfChanged(composePath, renderAsset(COMPOSE_YAML));
  writeIfChanged(settingsPath, renderAsset(SEARXNG_SETTINGS_YAML));
  writeIfChanged(firecrawlEnvPath, renderAsset(FIRECRAWL_ENV));
  return composePath;
}
function writeIfChanged(path, content) {
  try {
    if (existsSync2(path) && readFileSync7(path, "utf8") === content) return;
    mkdirSync2(dirname(path), { recursive: true });
    writeFileSync4(path, content);
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

// src/pool.ts
async function mapLimit(items, limit, fn) {
  const width = Math.max(1, Math.floor(limit));
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
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
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
async function probeOllama(base = ollamaBase()) {
  const key = base.replace(/\/+$/, "");
  if (key.toLowerCase() === "off") return false;
  const cached = probed.get(key);
  if (cached !== void 0) return cached;
  const r = await httpJson("GET", `${key}/api/tags`, void 0, { timeoutMs: 2e3, retries: 0 });
  probed.set(key, r.ok);
  return r.ok;
}
async function embed(texts, opts = {}) {
  const model = opts.model ?? embedModel();
  if (texts.length === 0) return { vectors: [], model };
  const base = (opts.base ?? ollamaBase()).replace(/\/+$/, "");
  if (base.toLowerCase() === "off") return { vectors: [], model, note: "embeddings are disabled (OLLAMA=off)." };
  if (!await probeOllama(base)) {
    return { vectors: [], model, note: `no embedding server at ${base} \u2014 \`${brand().cli} semantic up\` starts Ollama and pulls ${model}.` };
  }
  const batches = [];
  const width = embedBatch();
  for (let i = 0; i < texts.length; i += width) batches.push(texts.slice(i, i + width));
  let note;
  const results = await mapLimit(batches, opts.concurrency ?? embedConcurrency(), async (batch) => {
    const r = await httpJson("POST", `${base}/api/embed`, { model, input: batch }, { timeoutMs: 6e4 });
    const got = r.ok ? r.data?.embeddings : void 0;
    if (!got || got.length !== batch.length) {
      note ??= `embedding failed at ${base} (${r.error ?? `status ${r.status}`}) \u2014 is \`${model}\` pulled? \`${brand().cli} semantic up\` pulls it.`;
      return void 0;
    }
    return got;
  });
  if (results.some((r) => r === void 0)) return { vectors: [], model, ...note ? { note } : {} };
  return { vectors: results.flat(), model };
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

// src/rank.ts
function rrf(lists, keyOf, k = 60) {
  const score = /* @__PURE__ */ new Map();
  for (const list of lists) {
    list.forEach((item, idx) => {
      const key = keyOf(item);
      score.set(key, (score.get(key) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return score;
}
var indexTokenCache = /* @__PURE__ */ new WeakMap();
function bm25Tokenize(text) {
  if (!text) return [];
  const out = [];
  for (const raw of text.split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 2) continue;
    if (isStopword(raw)) continue;
    const t = foldCached(raw);
    if (t.length >= 2) out.push(t);
  }
  return out;
}
var FOLD_CACHE_MAX = 5e4;
var foldCache = /* @__PURE__ */ new Map();
function foldCached(raw) {
  const hit = foldCache.get(raw);
  if (hit !== void 0) return hit;
  const t = foldTerm(raw);
  if (foldCache.size >= FOLD_CACHE_MAX) foldCache.clear();
  foldCache.set(raw, t);
  return t;
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
  const tokenCache = /* @__PURE__ */ new WeakMap();
  let totalLen = 0;
  for (const doc of docs) {
    const toks = docTokens(doc, titleWeight, headingWeight);
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
function simhash(text) {
  const toks = bm25Tokenize(text);
  if (!toks.length) return 0n;
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
  return BigInt(hi >>> 0) << 32n | BigInt(lo >>> 0);
}
var MASK32 = 0xffffffffn;
function popcount32(n) {
  let x = n - (n >>> 1 & 1431655765);
  x = (x & 858993459) + (x >>> 2 & 858993459);
  return Math.imul(x + (x >>> 4) & 252645135, 16843009) >>> 24;
}
function hammingDistance(a, b) {
  let x = a ^ b;
  let count = popcount32(Number(x & MASK32)) + popcount32(Number(x >> 32n & MASK32));
  x >>= 64n;
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

// src/vector.ts
function qdrantBase() {
  return env("QDRANT") ?? "http://localhost:6333";
}
var clean = (base) => base.replace(/\/+$/, "");
var probed2 = /* @__PURE__ */ new Map();
async function probeQdrant(base = qdrantBase()) {
  const key = clean(base);
  if (key.toLowerCase() === "off") return false;
  const cached = probed2.get(key);
  if (cached !== void 0) return cached;
  const r = await httpJson("GET", `${key}/collections`, void 0, { timeoutMs: 2e3, retries: 0 });
  probed2.set(key, r.ok);
  return r.ok;
}
async function hybridSearch(question, docs, opts = {}) {
  if (docs.length === 0) return { hits: [] };
  const embedding = embed([question, ...docs.map((d) => [d.title, d.headings, d.body].filter(Boolean).join("\n"))], {
    ...opts.base !== void 0 ? { base: opts.base } : {},
    ...opts.model !== void 0 ? { model: opts.model } : {}
  });
  const index = buildBm25Index(question, docs);
  const lexical = docs.map((doc) => ({ doc, score: bm25Score(index, doc) })).sort((a, b) => b.score - a.score).map((s) => s.doc);
  const embedded = await embedding;
  let dense = [];
  let note = embedded.note;
  if (embedded.vectors.length === docs.length + 1) {
    const q = embedded.vectors[0];
    const scored = docs.map((doc, i) => ({ doc, sim: cosine(q, embedded.vectors[i + 1]) }));
    dense = scored.sort((a, b) => b.sim - a.sim).map((s) => s.doc);
  } else if (!note) {
    note = "the dense lane returned an unexpected number of vectors \u2014 ranking lexically only.";
  }
  const lists = dense.length ? [lexical, dense] : [lexical];
  const fused = rrf(lists, (d) => d.id, opts.k ?? envInt("RRF_K", 60));
  const lexRank = new Map(lexical.map((d, i) => [d.id, i + 1]));
  const denseRank = new Map(dense.map((d, i) => [d.id, i + 1]));
  const hits = [...docs].map((doc) => ({
    doc,
    score: fused.get(doc.id) ?? 0,
    ...lexRank.has(doc.id) ? { lexicalRank: lexRank.get(doc.id) } : {},
    ...denseRank.has(doc.id) ? { denseRank: denseRank.get(doc.id) } : {}
  })).sort((a, b) => b.score - a.score);
  return { hits: opts.limit ? hits.slice(0, opts.limit) : hits, ...note ? { note } : {} };
}

// src/feed.ts
function attributeValue(attrs, name) {
  for (const match of attrs.matchAll(/([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    if (match[2] === void 0 && match[3] === void 0 && match[4] === void 0) continue;
    if (match[1]?.toLowerCase() === name.toLowerCase()) return match[2] ?? match[3] ?? match[4] ?? "";
  }
  return void 0;
}
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
  const links = [...block.matchAll(/<link\b([^>]*)>/gi)].map((match) => match[1]);
  const firstHref = links.map((attrs) => attributeValue(attrs, "href")).find(Boolean);
  if (firstHref) {
    const alts = links.filter((attrs) => {
      const rels = attributeValue(attrs, "rel")?.toLowerCase().split(/\s+/) ?? [];
      return !rels.some((rel) => ["self", "edit", "replies", "enclosure"].includes(rel));
    });
    for (const attrs of alts) {
      const href = attributeValue(attrs, "href");
      if (href) return decodeEntities(href).trim();
    }
    return decodeEntities(firstHref).trim();
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
    const rels = attributeValue(attrs, "rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!rels.includes("alternate")) continue;
    const type = attributeValue(attrs, "type")?.toLowerCase();
    if (type !== "application/rss+xml" && type !== "application/atom+xml") continue;
    const href = attributeValue(attrs, "href");
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
    const r = await httpGet(next, { accept: "application/xml,text/xml,*/*", timeoutMs: 1e4, authorizeUrl: opts.authorizeUrl });
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
var guardedCaches = /* @__PURE__ */ new WeakMap();
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
  let p = scopedCache.get(origin);
  if (!p) {
    p = (async () => {
      const r = await httpGet(`${origin}/robots.txt`, { accept: "text/plain", timeoutMs: 5e3, maxBytes: 512 * 1024, authorizeUrl: opts.authorizeUrl });
      if (!r.ok || !r.body.trim()) return EMPTY;
      return parseRobots(r.body, env("ROBOTS_UA") ?? brand().name);
    })();
    scopedCache.set(origin, p);
  }
  return p;
}

// src/crawl.ts
var nextFree = /* @__PURE__ */ new Map();
function hostDelayMs() {
  return envInt("POLITE_DELAY_MS", 400, 0, 5e3);
}
function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
async function awaitHostSlot(url, delayMs = hostDelayMs(), now = Date.now()) {
  const host = hostOf(url);
  if (!host || delayMs <= 0) return 0;
  const free = nextFree.get(host) ?? 0;
  const waited = Math.max(0, free - now);
  nextFree.set(host, Math.max(free, now) + delayMs);
  if (waited > 0) await sleep(waited);
  return waited;
}
function backOffHost(url, ms, now = Date.now()) {
  const host = hostOf(url);
  if (!host || ms <= 0) return;
  nextFree.set(host, Math.max(nextFree.get(host) ?? 0, now + ms));
}
function linksFrom(html, baseUrl) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const raw = decodeEntities(m[1] ?? m[2] ?? "").trim();
    if (!raw || raw.startsWith("#")) continue;
    if (/^(mailto|tel|javascript|data):/i.test(raw)) continue;
    try {
      const abs = new URL(raw, baseUrl);
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
function crawlConcurrency() {
  return envInt("CRAWL_CONCURRENCY", 4, 1, 16);
}
async function crawlSite(seed, opts = {}) {
  const maxPages = Math.max(1, opts.maxPages ?? 20);
  const maxDepth = Math.max(0, opts.maxDepth ?? 2);
  const width = crawlConcurrency();
  const notes = [];
  const disallowed = [];
  const pages = [];
  const NONE = { rules: [], sitemaps: [], absent: true };
  const authorizeOrigin = async (url) => {
    if (opts.crossOrigin || sameOrigin(url, seed)) return true;
    notes.push(`${url}: destination is outside the crawl origin.`);
    return false;
  };
  const robotsFor = (url) => opts.ignoreRobots ? Promise.resolve(NONE) : fetchRobots(url, { authorizeUrl: authorizeOrigin });
  const robots = await robotsFor(seed);
  if (opts.ignoreRobots) notes.push("robots.txt was not consulted (ignoreRobots) \u2014 only correct on a site you own.");
  else if (robots.absent) notes.push("no robots.txt \u2014 nothing was refused, but nothing was granted either.");
  if (robots.crawlDelayMs && opts.delayMs === void 0) notes.push(`honouring the declared Crawl-delay of ${robots.crawlDelayMs}ms.`);
  const delayFor = (r) => opts.delayMs ?? r.crawlDelayMs ?? hostDelayMs();
  const authorizeUrl = async (url) => {
    if (!await authorizeOrigin(url)) return false;
    const r = await robotsFor(url);
    if (!opts.ignoreRobots && !isAllowed(r, url)) {
      if (!disallowed.includes(url)) disallowed.push(url);
      return false;
    }
    await awaitHostSlot(url, delayFor(r));
    return true;
  };
  const seen = /* @__PURE__ */ new Set([canonicalizeUrl(seed)]);
  const admit = (url, depth, into) => {
    const canon = canonicalizeUrl(url);
    if (seen.has(canon)) return false;
    if (!opts.crossOrigin && !sameOrigin(url, seed)) return false;
    seen.add(canon);
    into.push({ url, depth });
    return true;
  };
  let sitemap = opts.useSitemap !== false && maxDepth > 0 ? fetchSitemap(seed, { sitemaps: robots.sitemaps, authorizeUrl }) : void 0;
  const fetchOne = async (item) => {
    const got = await fetchAndExtract(item.url, { keepHtml: item.depth < maxDepth, authorizeUrl });
    if (got.retryAfterMs) backOffHost(got.finalUrl, Math.min(got.retryAfterMs, 6e4));
    if (!got.text) return `${item.url}: ${got.note ?? "nothing readable"}`;
    const page = {
      url: got.finalUrl,
      depth: item.depth,
      ...got.title ? { title: got.title } : {},
      text: got.text,
      extractor: got.extractor ?? "native",
      links: got.html ? linksFrom(got.html, got.finalUrl) : []
    };
    return page;
  };
  let wave = [{ url: seed, depth: 0 }];
  while (wave.length && pages.length < maxPages) {
    const batch = [];
    let cursor = 0;
    while (cursor < wave.length && batch.length < maxPages - pages.length) {
      const slice = wave.slice(cursor, cursor + (maxPages - pages.length - batch.length));
      const files = await Promise.all(slice.map((it) => robotsFor(it.url)));
      slice.forEach((item, i) => {
        const r = files[i];
        if (!opts.ignoreRobots && !isAllowed(r, item.url)) disallowed.push(item.url);
        else batch.push({ item, robots: r });
      });
      cursor += slice.length;
    }
    const leftover = wave.slice(cursor);
    const settled = new Array(batch.length);
    let streamed = 0;
    const streamReady = () => {
      while (streamed < settled.length && settled[streamed] !== void 0) {
        const done = settled[streamed++];
        if (typeof done !== "string") opts.onPage?.(done);
      }
    };
    const results = await mapLimit(batch, width, async (a, i) => {
      const got = await fetchOne(a.item);
      settled[i] = got;
      streamReady();
      return got;
    });
    const next = [];
    if (sitemap) {
      const sm = await sitemap;
      sitemap = void 0;
      let added = 0;
      for (const entry of sm.urls) if (admit(entry.loc, 1, next)) added++;
      if (added) notes.push(`seeded ${added} URL(s) from the sitemap.`);
    }
    for (const r of results) {
      if (typeof r === "string") {
        notes.push(r);
        continue;
      }
      pages.push(r);
      if (r.depth >= maxDepth) continue;
      for (const link of r.links) admit(link, r.depth + 1, next);
    }
    wave = [...leftover, ...next];
  }
  const pending = wave.map((q) => q.url);
  if (pending.length) notes.push(`stopped at the ${maxPages}-page budget with ${pending.length} URL(s) still queued.`);
  return { pages, pending, disallowed, notes };
}

// src/tables.ts
function fragmentText(html) {
  return decodeEntities(html.replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ").replace(LOOSE_TAG_RE, " "));
}
var collapse = (s) => s.replace(/\s+/g, " ").trim();
function spanAttr(attrs, name) {
  const n = Number.parseInt(attrs.get(name) ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : 1;
}
var MAX_SLOTS = 1e6;
function expand(rows) {
  const grid = rows.map(() => []);
  let slots = 0;
  for (let r = 0; r < rows.length; r++) {
    const out = grid[r];
    let c = 0;
    for (const cell of rows[r]) {
      while (out[c] !== void 0) c++;
      const down = Math.min(cell.rowspan, rows.length - r);
      slots += down * cell.colspan;
      if (slots > MAX_SLOTS) return void 0;
      for (let j = 0; j < down; j++) for (let i = 0; i < cell.colspan; i++) grid[r + j][c + i] = cell.text;
      c += cell.colspan;
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
    const name = m[2].toLowerCase();
    if (top && (buried || name === "table" && !closing && stack.length >= MAX_DEPTH)) {
      if (name === "table") buried += closing ? -1 : 1;
      top.text(" ");
      continue;
    }
    if (name === "table") {
      if (!closing) stack.push(new OpenTable(order++));
      else if (top) closeTable(stack, done);
      continue;
    }
    if (!top) continue;
    if (name === "td" || name === "th") {
      if (closing) top.endCell();
      else top.startCell(name === "th", htmlAttributes(m[0]));
    } else if (name === "tr") {
      top.endRow();
      if (!closing) top.startRow();
    } else if (name === "caption") {
      top.endRow();
      top.inCaption = !closing;
    } else {
      top.endRow();
      top.inHead = name === "thead" && !closing;
    }
  }
  while (stack.length) closeTable(stack, done);
  return done.sort((a, b) => a.order - b.order).map((d) => d.table);
}
var NOT_RENDERED = ["script", "style", "template", "svg", "select", "datalist"];
var MAX_DEPTH = 8;
var OpenTable = class {
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
function closeTable(stack, done) {
  const t = stack.pop();
  t.endRow();
  const caption = collapse(t.caption.join(""));
  const table = buildTable(t.rows, caption);
  if (table) done.push({ order: t.order, table });
  const flat = [caption, ...t.rows.flatMap((r) => r.cells.map((c) => c.text))].filter(Boolean).join(" ");
  stack[stack.length - 1]?.nested(flat);
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

// src/changed.ts
import { createHash as createHash2 } from "crypto";
function contentHash(body) {
  return createHash2("sha256").update(body).digest("hex");
}
var FINGERPRINT_MAX_BYTES = 64 * 1024 * 1024;
function read(url, opts, headers) {
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
  return observation(url, await read(url, opts));
}
async function hasChanged(url, previous, opts = {}) {
  const headers = {};
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  const res = await read(url, opts, Object.keys(headers).length ? headers : void 0);
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
import { readdirSync, readFileSync as readFileSync8, statSync } from "fs";
import { dirname as dirname2, join as join9, relative, resolve } from "path";
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
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join9(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== skip) walkSources(p, skip, out);
    } else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}
function auditEngineUsage(root, config, dts, engineName) {
  const surface = engineExports(dts);
  const files = walkSources(join9(root, "src"));
  const forks = new Map(Object.entries(config.forks));
  const collisions = [];
  const tolerated = [];
  const imported = /* @__PURE__ */ new Set();
  for (const file of files) {
    const src = readFileSync8(file, "utf8");
    const rel = relative(root, file);
    for (const m of src.matchAll(DECL)) {
      const name = m[1] ?? m[2];
      if (!name || !surface.has(name)) continue;
      const why = forks.get(`${rel}:${name}`);
      if (why) tolerated.push({ file: rel, name, why });
      else collisions.push({ file: rel, name });
    }
    for (const m of src.matchAll(USES_ENGINE)) {
      if (engineName) {
        const spec = m[2] ?? "";
        if (spec.endsWith("-engine.mjs")) {
          if (!spec.endsWith(`/vendor/${engineName}-engine.mjs`) && !spec.endsWith(`vendor/${engineName}-engine.mjs`)) continue;
        } else {
          let shim = "";
          try {
            shim = readFileSync8(resolve(dirname2(file), spec.replace(/\.js$/, ".ts")), "utf8");
          } catch {
            continue;
          }
          if (!shim.includes(`vendor/${engineName}-engine.mjs`)) continue;
        }
      }
      for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (name && surface.has(name)) imported.add(name);
      }
    }
  }
  const seen = new Set(tolerated.map((t) => `${t.file}:${t.name}`));
  const stale = [...forks.keys()].filter((k) => !seen.has(k));
  return { collisions, tolerated, stale, imported: [...imported], surface: surface.size };
}

// src/skillkit/bundle.ts
import { existsSync as existsSync3, readdirSync as readdirSync2, readFileSync as readFileSync9 } from "fs";
import { join as join10 } from "path";

// src/cli-kit.ts
import { basename } from "path";
var EXIT_FAILURE = 1;
var EXIT_USAGE = 2;
var UsageError = class extends Error {
  exitCode = EXIT_USAGE;
};
function parseArgs(argv, spec) {
  const commands = new Set(spec.commands);
  const valueFlags = new Set(spec.valueFlags);
  const boolFlags = new Set(spec.boolFlags);
  if (argv.length === 0) return { kind: "help" };
  if (isHelpWord(argv[0])) return { kind: "help" };
  if (isVersionWord(argv[0])) return { kind: "version" };
  const command = argv[0];
  if (!commands.has(command)) {
    throw new UsageError(`unknown command "${command}" \u2014 run --help for the supported commands`);
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
      if (isHelpWord(arg)) return { kind: "help" };
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
  return { kind: "command", command, positional, values, bools };
}
function isHelpWord(a) {
  return a === "--help" || a === "-h" || a === "help";
}
function isVersionWord(a) {
  return a === "--version" || a === "-v" || a === "version";
}
function argValue(p, name) {
  return p.values[name];
}
function argBool(p, name) {
  return p.bools.has(name);
}
function argInt(p, name) {
  const raw = p.values[name];
  if (raw === void 0) return void 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new UsageError(`--${name} expects a whole number, got "${raw}"`);
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

// src/skillkit/bundle.ts
var DESC_MAX = 1e3;
function auditSkillBundle(root, config, cli) {
  const out = [];
  const check = (ok, message) => out.push({ ok, message });
  const name = config.name;
  const skillDir = join10(root, "skills", name);
  check(
    !existsSync3(join10(root, "SKILL.md")),
    existsSync3(join10(root, "SKILL.md")) ? `a SKILL.md exists at the repo ROOT \u2014 \`skills add\` would install it alone, dropping the engine. Move it to skills/${name}/SKILL.md` : "no root SKILL.md"
  );
  const skillMd = join10(skillDir, "SKILL.md");
  if (!existsSync3(skillMd)) {
    check(false, `missing skills/${name}/SKILL.md \u2014 the skill package has no SKILL.md`);
    return out;
  }
  const raw = readFileSync9(skillMd, "utf8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!fm) {
    check(false, `skills/${name}/SKILL.md has no frontmatter block`);
    return out;
  }
  check(true, "packaged SKILL.md present with frontmatter");
  const front = fm[1];
  const declared = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  check(
    declared === name,
    declared === name ? `frontmatter name "${name}" matches the config` : `frontmatter name "${declared ?? ""}" != skill.json name "${name}"`
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
  const refsDir = join10(skillDir, "references");
  if (existsSync3(refsDir)) {
    const files = readdirSync2(refsDir).filter((f) => f.endsWith(".md"));
    for (const m of new Set(raw.match(/references\/[\w.-]+\.md/g) ?? [])) {
      check(
        existsSync3(join10(skillDir, m)),
        existsSync3(join10(skillDir, m)) ? `mentioned ${m} exists` : `${m} is mentioned in SKILL.md but missing from the package`
      );
    }
    for (const f of files) {
      check(
        raw.includes(`references/${f}`),
        raw.includes(`references/${f}`) ? `references/${f} is linked` : `references/${f} exists but SKILL.md never mentions it`
      );
    }
  }
  const bundleRel = `scripts/${name}.mjs`;
  const rootBundle = join10(root, bundleRel);
  const pkgBundle = join10(skillDir, bundleRel);
  if (!existsSync3(rootBundle)) check(false, `missing ${bundleRel} at the repo root \u2014 run the build`);
  else if (!existsSync3(pkgBundle)) check(false, `missing skills/${name}/${bundleRel} \u2014 run \`skill copy\``);
  else {
    const same = readFileSync9(rootBundle).equals(readFileSync9(pkgBundle));
    check(
      same,
      same ? `embedded engine is byte-identical to ${bundleRel}` : `skills/${name}/${bundleRel} differs from ${bundleRel} \u2014 run \`skill copy\` and commit`
    );
  }
  if (!cli) return out;
  const universe = /* @__PURE__ */ new Set([...cli.valueFlags, ...cli.boolFlags, "help", "version", ...config.allowedForeignFlags]);
  const docs = [["SKILL.md", raw]];
  if (existsSync3(refsDir)) {
    for (const f of readdirSync2(refsDir).filter((f2) => f2.endsWith(".md"))) docs.push([`references/${f}`, readFileSync9(join10(refsDir, f), "utf8")]);
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
import { join as join11 } from "path";
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
var engineShim = (name, prefix) => `// The vendored engine, configured for this skill.
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
// see \u2014 it must identify ${name}, not the shared engine underneath.
import { configure } from "./vendor/webindex-engine.mjs";

configure({
  name: "${name}",
  envPrefix: "${prefix}",
  cli: "${name}",
  contactUrl: "https://github.com/maxgfr/${name}",
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
      - run: npx webindex skill check
      - run: npx webindex skill bundle
      - run: npx webindex skill vendor --check
`;
var gitignore = `node_modules/
coverage/
*.tsbuildinfo
`;
function scaffoldSkill(root, name, opts = {}) {
  const errors = [];
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return { written: [], errors: [`"${name}" is not a usable skill name \u2014 lower-case letters, digits and hyphens, starting with a letter.`] };
  }
  const prefix = name.toUpperCase().replace(/-/g, "_");
  const files = {
    [SKILL_CONFIG]: `${enginesJson(name, opts.engineRepo ?? "maxgfr/webindex", opts.minRef ?? "v1.15.0")}
`,
    [join11("src", "engine.ts")]: engineShim(name, prefix),
    [join11("skills", name, "SKILL.md")]: `---
name: ${name}
description: TODO \u2014 one sentence saying WHEN to use this skill, under 1000 characters.
---

# ${name}

TODO
`,
    [join11(".github", "workflows", "ci.yml")]: ci(),
    ".gitignore": gitignore
  };
  const written = [];
  const exists = opts.exists;
  for (const [rel, content] of Object.entries(files)) {
    const path = join11(root, rel);
    if (exists?.(path)) {
      errors.push(`${rel} already exists \u2014 left alone.`);
      continue;
    }
    ensureDir(join11(path, ".."));
    written.push(writeArtifact(path, content));
  }
  return { written, errors };
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
  nb: "no",
  // Bokmål → Norway
  nn: "no",
  // Nynorsk → Norway
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
var DDG_LANG_ALIASES = {
  nb: "no",
  // Bokmål
  nn: "no",
  // Nynorsk
  ja: "jp"
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
  const l = DDG_LANG_ALIASES[baseLang(lang)] ?? baseLang(lang);
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
  if (status === 403) return { throttled: true, why: "blocked this client as automated traffic (HTTP 403)" };
  return { throttled: false, why: `unreachable (status ${status})` };
}
function looksLikeChallenge(body) {
  if (body.length > 4e4) return false;
  const head = body.slice(0, 4e3).toLowerCase();
  return /<title>[^<]*captcha/.test(head) || head.includes("anomaly-modal") || head.includes("/anomaly.js") || head.includes("captcha-wrap") || head.includes("sending automated queries");
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
function mojeekLocaleParams(locale) {
  if (!locale) return "";
  return `&lb=${encodeURIComponent(locale.lang)}&lbb=100&rb=${encodeURIComponent(locale.region)}&rbb=10`;
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
    url: (q, p, _kl, locale) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}${p > 0 ? `&s=${p * 10 + 1}` : ""}${mojeekLocaleParams(locale)}`,
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
  const locale = opts.lang || opts.region ? { lang: baseLang(opts.lang), region: resolveRegion(opts.lang, opts.region).toUpperCase() } : void 0;
  const seen = /* @__PURE__ */ new Set();
  const hits = [];
  for (let p = 0; p < pages && hits.length < limit; p++) {
    const r = await httpGet(spec.url(q, p, kl, locale), { accept: "text/html", acceptLanguage, timeoutMs: opts.timeoutMs ?? 12e3 });
    if (!r.ok || !r.body) {
      if (p > 0) break;
      const { throttled, why } = throttleReason(r.status);
      return { hits: [], note: `${spec.label} ${why}.`, throttled, ...r.status === 403 ? { blocked: true } : {} };
    }
    const before = hits.length;
    const parsed = spec.parse(r.body, limit * 2);
    if (parsed.length === 0 && looksLikeChallenge(r.body)) {
      if (p > 0) break;
      return {
        hits: [],
        note: `${spec.label} served an anti-bot challenge (HTTP ${r.status}) instead of results \u2014 blocked, not empty.`,
        throttled: true,
        blocked: true
      };
    }
    for (const f of parsed) {
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
  const keyless = keylessEngines(opts);
  let asked = 0;
  let blocked = 0;
  for (const engine of keyless) {
    const r = await searchViaKeyless(engine, q, { limit: opts.limit, pages: opts.pages, lang: opts.lang, region: opts.region });
    if (r.hits.length) {
      return { hits: r.hits.map((h) => ({ ...h, via: engine })), notes };
    }
    asked++;
    if (r.blocked) blocked++;
    if (r.throttled && r.note) notes.push(r.note);
  }
  const fc = await searchViaFirecrawl(q, opts.limit ?? 10, opts);
  const hits = (fc.hits ?? []).map((h) => ({ url: h.url, title: h.title, snippet: h.description, via: "firecrawl" }));
  if (fc.why) notes.push(fc.why);
  if (!hits.length) {
    notes.push(
      asked > 0 && blocked === asked ? `Every keyless engine blocked this client (${keyless.join(", ")}) \u2014 nothing was searched, which is not the same as nothing being there. Try again later, or run \`${brand().cli} stack up\` for a local SearXNG.` : `No results from any engine. \`${brand().cli} stack up\` starts SearXNG and Firecrawl locally.`
    );
  }
  return { hits, notes };
}

// src/cache.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync10, readdirSync as readdirSync3, rmSync as rmSync2, statSync as statSync2 } from "fs";
import { join as join12 } from "path";
import { tmpdir as tmpdir3 } from "os";
var DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
function cacheDir() {
  return env("CACHE_DIR") ?? brand().cacheDir ?? join12(tmpdir3(), userScoped(brand().name), "cache");
}
function userScoped(name) {
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  return uid === void 0 ? name : `${name}-${uid}`;
}
function cachePath(url, acceptLanguage = "", extractor = "native", variant = "") {
  const canon = canonicalizeUrl(url);
  const domain = domainOf(url).replace(/[^a-z0-9.-]/gi, "_") || "url";
  const key = `${canon}\0${acceptLanguage}\0${extractor}${variant ? `\0${variant}` : ""}`;
  return join12(cacheDir(), `${domain}-${fnv1a64(key).toString(16)}.json`);
}
var VARIANTS = ["", "consent", "full"];
var PLAIN = [""];
function variantOf(opts) {
  return opts.fullPage ? "full" : opts.stripConsent ? "consent" : "";
}
var PDF_CACHE_NS = "pdf";
var DOC_CACHE_NS = "doc";
async function currentExtractor(opts, url) {
  if (looksLikePdfUrl(url)) return PDF_CACHE_NS;
  if (docFormatForUrl(url)) return DOC_CACHE_NS;
  if (opts.fullPage) return "native";
  const base = firecrawlBase(opts);
  return base && await probeFirecrawl(base, firecrawlIsExplicit(opts)) ? "firecrawl" : "native";
}
var DOCUMENT_NAMESPACES = [PDF_CACHE_NS, DOC_CACHE_NS, "pdf-inspector", "pdftotext", "anydoc", "ocr"];
var WRITTEN_NAMESPACES = ["native", "firecrawl", ...DOCUMENT_NAMESPACES];
function namespaceFor(result, predicted) {
  return result.documentType ?? (predicted === PDF_CACHE_NS || predicted === DOC_CACHE_NS ? predicted : result.extractor ?? "native");
}
function readAnyNamespace(url, acceptLanguage, namespaces = WRITTEN_NAMESPACES, variants = PLAIN) {
  let best;
  for (const ns of namespaces) {
    for (const variant of ns === "native" ? variants : PLAIN) {
      const hit = readCache(url, acceptLanguage, ns, variant);
      if (hit && (!best || hit.cachedAt > best.cachedAt)) best = hit;
    }
  }
  return best;
}
function readAnyCopy(url, acceptLanguage, variant) {
  return readAnyNamespace(url, acceptLanguage, WRITTEN_NAMESPACES, [variant]) ?? readAnyNamespace(url, acceptLanguage, WRITTEN_NAMESPACES, VARIANTS);
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
  const meta = cachePath(url, acceptLanguage, extractor, extractor === "native" ? variant : "");
  return { meta, body: meta.replace(/\.json$/, ".body") };
}
function readCache(url, acceptLanguage = "", extractor = "native", variant = "") {
  const { meta, body } = entryPaths(url, acceptLanguage, extractor, variant);
  if (!existsSync4(meta)) return void 0;
  try {
    const entry = JSON.parse(readFileSync10(meta, "utf8"));
    if (typeof entry.cachedAt !== "number") return void 0;
    const text = existsSync4(body) ? readFileSync10(body, "utf8") : entry.text;
    if (!text?.trim()) return void 0;
    return { ...entry, text };
  } catch {
    return void 0;
  }
}
function writeCache(url, res, now, acceptLanguage = "", extractor = "native", variant = "") {
  if (isNoWrite()) return;
  const dir = cacheDir();
  const { meta, body } = entryPaths(url, acceptLanguage, extractor, variant);
  const { text, note: _note, ...rest } = res;
  const write = () => {
    ensureDir2(dir);
    writeFileAtomic(body, text ?? "");
    writeFileAtomic(meta, JSON.stringify({ ...rest, cachedAt: now }));
  };
  try {
    write();
  } catch {
    ensured.delete(dir);
    try {
      write();
    } catch {
    }
  }
}
var ensured = /* @__PURE__ */ new Set();
function ensureDir2(dir) {
  if (ensured.has(dir)) return;
  mkdirSync3(dir, { recursive: true });
  ensured.add(dir);
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
    const { note: _stored, ...rest } = entry;
    const about = note ?? (entry.truncated ? `The cached text of ${url} is a prefix: the page overran the response size cap.` : void 0);
    return { ...rest, cached: true, ...about ? { note: about } : {} };
  };
  if (offline) {
    const stored = readAnyCopy(url, lang, variant);
    if (stored) return served(stored);
    return { text: "", finalUrl: url, status: 0, note: `Offline: ${url} is not in the cache (drop --offline, or warm it with a normal run).` };
  }
  const ns = await currentExtractor(opts, url);
  const store = (result) => {
    const target = namespaceFor(result, ns);
    const entry = ns === "firecrawl" && target === "native" ? { ...result, fallbackFrom: "firecrawl" } : result;
    writeCache(url, entry, now, lang, target, variant);
  };
  const hit = refresh ? void 0 : lookup(url, lang, ns, variant);
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
  res ??= await fetchAndExtract(url, opts);
  if (res.text?.trim()) {
    store(res);
    return res;
  }
  const stale = hit ?? readAnyCopy(url, lang, variant);
  if (stale) return served(stale, `${url} returned ${res.status || "no response"}; served the cached copy from ${new Date(stale.cachedAt).toISOString()}.`);
  return res;
}
function lookup(url, acceptLanguage, ns, variant) {
  const best = readAnyNamespace(url, acceptLanguage, [.../* @__PURE__ */ new Set([ns, ...DOCUMENT_NAMESPACES])], [variant]);
  if (ns !== "firecrawl") return best;
  const fallback = readCache(url, acceptLanguage, "native", variant);
  return fallback?.fallbackFrom === "firecrawl" && (!best || fallback.cachedAt > best.cachedAt) ? fallback : best;
}
var WRITER_TMP = /\.\d+\.\d+\.tmp$/;
function ownFile(name) {
  const tmp = WRITER_TMP.exec(name);
  const base = tmp ? name.slice(0, tmp.index) : name;
  const ext = base.endsWith(".json") ? "json" : base.endsWith(".body") ? "body" : void 0;
  if (!ext) return void 0;
  const stem = base.slice(0, -5);
  const dash = stem.lastIndexOf("-");
  if (dash < 1 || !/^[0-9a-f]{1,16}$/.test(stem.slice(dash + 1)) || !/^[\w.-]+$/.test(stem.slice(0, dash))) return void 0;
  return { kind: tmp ? "tmp" : ext, stem };
}
function readEntryMeta(abs) {
  try {
    const entry = JSON.parse(readFileSync10(abs, "utf8"));
    return entry && typeof entry.cachedAt === "number" && typeof entry.finalUrl === "string" ? entry : void 0;
  } catch {
    return void 0;
  }
}
var ORPHAN_GRACE_MS = 10 * 60 * 1e3;
function sizeOf(abs) {
  try {
    return statSync2(abs).size;
  } catch {
    return 0;
  }
}
function cacheStats(now = Date.now()) {
  const dir = cacheDir();
  const out = { dir, entries: 0, bytes: 0, fresh: 0, stale: 0, ttlMs: ttlMs() };
  if (!existsSync4(dir)) return out;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  for (const name of readdirSync3(dir)) {
    const own = ownFile(name);
    if (!own) continue;
    const abs = join12(dir, name);
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
  if (!existsSync4(dir) || isNoWrite()) return 0;
  const names = readdirSync3(dir);
  const present = new Set(names);
  const remove = (name) => {
    try {
      rmSync2(join12(dir, name), { force: true });
      return true;
    } catch {
      return false;
    }
  };
  const abandoned = (name) => {
    try {
      return all || now - statSync2(join12(dir, name)).mtimeMs > ORPHAN_GRACE_MS;
    } catch {
      return false;
    }
  };
  let removed = 0;
  for (const name of names) {
    const own = ownFile(name);
    if (!own) continue;
    if (own.kind === "json") {
      const entry = readEntryMeta(join12(dir, name));
      if (!entry || !all && isCacheFresh(entry, now) || !remove(name)) continue;
      remove(`${own.stem}.body`);
      removed++;
    } else if (own.kind === "body" ? !present.has(`${own.stem}.json`) && abandoned(name) : abandoned(name)) {
      remove(name);
    }
  }
  return removed;
}

// src/structured.ts
var openTag = (name) => new RegExp(`<${name}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "gi");
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
function flattenJsonLd(v, out) {
  if (Array.isArray(v)) for (const x of v) flattenJsonLd(x, out);
  else if (v && typeof v === "object" && Array.isArray(v["@graph"])) {
    for (const x of v["@graph"]) out.push(x);
  } else out.push(v);
}
function extractJsonLd(html) {
  const out = [];
  const open = openTag("script");
  const close = closeTagRe("script");
  let m;
  while (m = open.exec(html)) {
    close.lastIndex = open.lastIndex;
    const c = close.exec(html);
    if (!c) break;
    const type = (htmlAttributes(m[0]).get("type") ?? "").split(";")[0].trim().toLowerCase();
    if (type === "application/ld+json") {
      const raw = html.slice(open.lastIndex, c.index).replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
      const parsed = raw ? parseJsonLd(raw) : void 0;
      if (parsed !== void 0) flattenJsonLd(parsed, out);
    }
    open.lastIndex = c.index + c[0].length;
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
var typesOf = (n) => allStrings(n["@type"]).map((t) => t.slice(Math.max(t.lastIndexOf("/"), t.lastIndexOf(":")) + 1));
function rank(n) {
  const types = typesOf(n);
  if (!types.length) return 1;
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
    if (!out.authors.length) out.authors.push(...new Set(names(n.author)));
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
  for (const [key, v] of entries) if (authorKeys.has(key) && !out.authors.includes(v)) out.authors.push(v);
  set("title", htmlTitle(html));
  if (opts.baseUrl) {
    for (const k of ["canonicalUrl", "imageUrl"]) {
      if (out[k] === void 0) continue;
      const abs = resolveUrl(out[k], opts.baseUrl);
      if (abs) out[k] = abs;
      else delete out[k];
    }
  }
  return out;
}
function resolveUrl(url, base) {
  try {
    const abs = new URL(url, base);
    return abs.protocol === "http:" || abs.protocol === "https:" ? abs.href : void 0;
  } catch {
    return void 0;
  }
}

// src/repo.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync4, readdirSync as readdirSync4, rmSync as rmSync3, statSync as statSync3 } from "fs";
import { tmpdir as tmpdir4 } from "os";
import { basename as basename2, join as join13, resolve as resolve2 } from "path";

// src/exec.ts
import { spawn as spawn2, spawnSync as spawnSync2 } from "child_process";
var STDOUT_CAP = 24 * 1024 * 1024;
var defaultTimeoutMs2 = () => envInt("SH_TIMEOUT_MS", 6e4, 1e3);
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
var havePresence = /* @__PURE__ */ new Map();
function have(cmd) {
  let hit = havePresence.get(cmd);
  if (hit === void 0) {
    const probe = spawnSync2(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
    hit = probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
    havePresence.set(cmd, hit);
  }
  return hit;
}
function shAsync(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs2();
  return new Promise((resolve5) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve5(r);
    };
    const child = spawn2(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      if (stdout.length < STDOUT_CAP) stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < STDOUT_CAP) stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, status: 124, stdout, stderr: stderr || `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (e) => done(toResult(null, stdout, stderr, e)));
    child.on("close", (code) => done(toResult(code, stdout, stderr)));
  });
}

// src/repo.ts
function resolveRepo(raw) {
  const trimmed = raw.trim();
  if (trimmed) {
    const asPath = resolve2(trimmed);
    if (existsSync5(asPath) && statSync3(asPath).isDirectory()) {
      return { raw: trimmed, host: "local", isLocal: true, slug: `local-${slugify(`${basename2(asPath)}-${asPath}`)}` };
    }
  }
  const file = /^file:\/\/(\/.*)$/.exec(trimmed);
  if (file) {
    const p = file[1].replace(/\.git$/, "").replace(/\/+$/, "");
    return {
      raw: trimmed,
      host: "file",
      ...basename2(p) ? { repo: basename2(p) } : {},
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
  const host = typeof ref === "string" ? ref : ref.host;
  const kind = forgeKind(host);
  if (kind === "github") return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  if (kind === "gitlab") return `https://${host}/api/v4`;
  return `https://${host}/api/v1`;
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
var canonCache = /* @__PURE__ */ new Map();
function ghUsable(host) {
  return /(^|\.)github\.com$/i.test(host) && !envFlag("NO_GH") && have("gh");
}
function splitSlug(full, fallback) {
  const i = full.indexOf("/");
  return i > 0 ? { owner: full.slice(0, i), repo: full.slice(i + 1) } : fallback;
}
function canonicalRepoRef(ref, opts = {}) {
  const fallback = { owner: ref.owner ?? "", repo: ref.repo ?? "" };
  if (!ref.owner || !ref.repo || forgeKind(ref.host) !== "github") return Promise.resolve(fallback);
  const key = `${ref.host}/${ref.owner}/${ref.repo}`;
  let hit = canonCache.get(key);
  if (!hit) {
    hit = (async () => {
      if (ghUsable(ref.host)) {
        const r2 = await shAsync("gh", ["api", `repos/${ref.owner}/${ref.repo}`, "--jq", ".full_name"], { timeoutMs: opts.timeoutMs ?? 15e3 });
        if (r2.ok && r2.stdout.includes("/")) return splitSlug(r2.stdout.trim(), fallback);
      }
      const r = await httpJson("GET", `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}`, void 0, reqOpts("github", opts));
      const full = r.ok ? r.data?.full_name : void 0;
      return typeof full === "string" && full.includes("/") ? splitSlug(full, fallback) : fallback;
    })();
    canonCache.set(key, hit);
  }
  return hit;
}
async function canonicalRepo(ref, opts = {}) {
  if (!ref.owner || !ref.repo) return void 0;
  const { owner, repo } = await canonicalRepoRef(ref, opts);
  return `${owner}/${repo}`;
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
  let depth = 0;
  let quoted = phase !== "outside";
  let escaped = phase === "escape";
  const open = [];
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
      if (open.length < MAX_OPEN_TIME_MAPS && opensTimeMap(text, i)) open.push({ at: i, depth });
      depth++;
    } else if (c === "}") {
      depth--;
      const top = open[open.length - 1];
      if (top?.depth === depth) {
        open.pop();
        try {
          const time = JSON.parse(text.slice(top.at, i + 1));
          if (time && typeof time === "object" && !Array.isArray(time) && typeof time[version] === "string") publishedAt = time[version];
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
      while (open.length && open[open.length - 1].depth > depth) open.pop();
    }
  }
  return publishedAt;
}
function npmTimeFromTail(text, version) {
  return scanTimeMap(text, version, "outside") ?? scanTimeMap(text, version, "string") ?? scanTimeMap(text, version, "escape");
}
async function npmPublishedAt(packageUrl, version) {
  if (!version) return void 0;
  const tail = await httpGet(packageUrl, {
    ...reqOpts2(),
    // Optional enrichment must not inherit the primary lookup's retry budget:
    // package facts are already usable if this suffix is slow or unavailable.
    timeoutMs: 2500,
    retries: 0,
    headers: { range: `bytes=-${NPM_TIME_TAIL_BYTES}` },
    maxBytes: NPM_TIME_TAIL_BYTES
  });
  return tail.ok ? npmTimeFromTail(tail.body, version) : void 0;
}
async function lookupPackage(registry, name, version) {
  const n = name.trim();
  if (!n) return void 0;
  const url = registry === "npm" ? `${REGISTRY_URL.npm(n)}/${encodeURIComponent(version ?? "latest")}` : REGISTRY_URL[registry](n);
  const r = await httpJson("GET", url, void 0, reqOpts2());
  if (!r.ok || !r.data || typeof r.data !== "object") return void 0;
  const d = r.data;
  if (registry === "npm") {
    const latest2 = version ?? d["dist-tags"]?.latest ?? d.version;
    const v = latest2 && d.versions?.[latest2] || d;
    const stated = latest2 ? d.time?.[latest2] : void 0;
    const publishedAt = typeof stated === "string" ? stated : await npmPublishedAt(REGISTRY_URL.npm(n), latest2);
    const deprecated = typeof v.deprecated === "string" ? v.deprecated : v.deprecated === true ? "deprecated" : void 0;
    return {
      registry,
      name: d.name ?? n,
      version: latest2,
      description: v.description ?? d.description,
      homepage: v.homepage ?? d.homepage,
      repository: normalizeRepoUrl(v.repository ?? d.repository),
      documentation: typeof v.documentation === "string" ? v.documentation : void 0,
      license: typeof v.license === "string" ? v.license : v.license?.type,
      ...deprecated ? { deprecated } : {},
      publishedAt
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

// src/mcp/protocol.ts
var PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
var LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
var ASSUMED_HTTP_PROTOCOL = "2025-03-26";
var RICH_TOOLS_SINCE = "2025-06-18";
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
  if (o === "" || o === "null") return false;
  if (LOOPBACK_ORIGIN.test(o)) return true;
  return allowed.some((a) => a === "*" || a.toLowerCase() === o.toLowerCase());
}

// src/mcp/resources.ts
import { existsSync as existsSync6, readdirSync as readdirSync5, readFileSync as readFileSync11, realpathSync, statSync as statSync4 } from "fs";
import { basename as basename3, dirname as dirname3, join as join14, resolve as resolve3, sep } from "path";
import { fileURLToPath } from "url";
var skillName = () => brand().name;
var URI_SCHEME = "skill://";
function resolveSkillRoot(moduleDir) {
  const here = moduleDir ?? dirname3(fileURLToPath(import.meta.url));
  const name = brand().name;
  const candidates = [resolve3(here, ".."), resolve3(here, "..", "skills", name), resolve3(here, "..", "..", "skills", name)];
  return candidates.find((dir) => existsSync6(join14(dir, "SKILL.md")));
}
function listResources(moduleDir) {
  const root = resolveSkillRoot(moduleDir);
  if (!root) return [];
  const out = [describe(root, "SKILL.md", `${skillName()}: the skill`)];
  const refDir = join14(root, "references");
  if (!existsSync6(refDir)) return out;
  for (const file of readdirSync5(refDir).sort()) {
    if (!file.endsWith(".md")) continue;
    out.push(describe(root, join14("references", file), `${skillName()} reference: ${basename3(file, ".md")}`));
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
  const target = resolve3(root, rel);
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
  if (!statSync4(targetReal).isFile()) throw new ResourceError(`not a file: ${uri}`);
  return { uri, mimeType: "text/markdown", text: readFileSync11(targetReal, "utf8") };
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
  const summary = firstProse(join14(root, rel));
  if (summary) decl.description = summary;
  return decl;
}
function firstProse(file) {
  let text;
  try {
    text = readFileSync11(file, "utf8");
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
  const active = /* @__PURE__ */ new Map();
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
          const request2 = active.get(target);
          if (request2) request2.cancelled = true;
        }
      }
      return;
    }
    const id = msg.id;
    const request = { cancelled: false };
    active.set(id, request);
    const reply = (out) => {
      if (request.cancelled) return;
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
    } finally {
      if (active.get(id) === request) active.delete(id);
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
      const normalized = Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          decl.inputSchema.properties[key]?.type === "number" && typeof value === "string" ? Number(value) : value
        ])
      );
      const { text: raw, artifact } = await adapter.callTool(name, normalized);
      const text = capResponse(raw, name, maxBytes, artifact, adapter.capAdvice);
      const capped = text !== raw;
      const structured = protocol >= RICH_TOOLS_SINCE ? structuredContentFor(text, capped, decl.outputSchema !== void 0) : void 0;
      reply({ result: { content: [{ type: "text", text }], ...structured ? { structuredContent: structured } : {} } });
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
  let active = 0;
  const waiting = [];
  const runHandler = async (msg, send2) => {
    while (active >= MAX_IN_FLIGHT) await new Promise((resolve5) => waiting.push(resolve5));
    active++;
    try {
      await server.handle(msg, send2);
    } finally {
      active--;
      waiting.shift()?.();
    }
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
            await mapLimit(parsed, MAX_IN_FLIGHT, (m) => runHandler(m, (r) => void out.push(r)));
            if (out.length) emit(JSON.stringify(out) + "\n");
          })().catch(reportInternal(send))
        );
        continue;
      }
      if (parsed === null || typeof parsed !== "object") {
        send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
        continue;
      }
      track(runHandler(parsed, send).catch(reportInternal(send)));
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
  return new Promise((resolve5, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, bind, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
      const host = bind.includes(":") ? `[${bind}]` : bind;
      resolve5({
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
  return new Promise((resolve5, reject) => {
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
      else resolve5(Buffer.concat(chunks).toString("utf8"));
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
                          [--engine ddg|ddglite|mojeek|off] [--searxng <base>|off]
  webindex fetch <url> [--json] [--firecrawl <base>|off] [--lang <tag>] [--full-page]
                       [--cache] [--refresh] [--offline] [--timeout <ms>]
  webindex extract <file> [--json] [--full-page]
  webindex rank --query <q> [--docs <file.json|->] [--limit <n>] [--json]
  webindex repo <ref> [--json]
  webindex issues <ref> [--terms "<words>"] [--limit <n>] [--json]
  webindex prs <ref> [--terms "<words>"] [--limit <n>] [--json]
  webindex releases <ref> [--limit <n>] [--json]
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
             engines (DuckDuckGo, DDG Lite, Mojeek \u2014 no key, no container),
             then Firecrawl. Prints what it found, or says which backend was
             missing and how to start it \u2014 those are different answers.
  fetch      Fetch a URL and print the extracted text. Routes PDFs and office
             documents to their ladders automatically. Uses Firecrawl when
             available, with built-in extraction as fallback. HTML is reduced
             to main content with consent banners dropped. Caching is opt-in:
             --cache reuses a fresh copy for the TTL (24 h) and revalidates a
             stale one with a conditional GET, so an unchanged page costs a
             304; --refresh re-fetches and rewrites the entry; --offline
             serves only what the cache holds. --json adds finalUrl (after
             redirects), canonical, documentType and cached.
  extract    Same extraction, on a file already on disk. For both, --full-page
             keeps the whole HTML page through the built-in reader: navigation,
             footer and consent banners included.
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
             Dev-time only \u2014 it reads a repo, it never runs inside one.
  doctor     Report which optional helpers are reachable and which extraction
             rungs are available on this machine.

ENVIRONMENT
  WEBINDEX_FIRECRAWL     Firecrawl base URL, or "off"  (default http://localhost:3002)
  WEBINDEX_PDF_ENGINE    force one PDF rung: native|pdf-inspector|anydoc|firecrawl|pdftotext|ocr
  WEBINDEX_DOC_ENGINE    force one office rung, or "none" to disable
  WEBINDEX_NO_NPX        skip the rungs that would install through npx
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
  "timeout"
];
var BOOL_FLAGS = ["json", "allow-remote", "all", "check", "markdown", "cross-origin", "full-page", "cache", "refresh", "offline"];
var COMMANDS = [
  "search",
  "fetch",
  "extract",
  "rank",
  "repo",
  "issues",
  "prs",
  "releases",
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
  "stack"
];
var SPEC = { commands: COMMANDS, valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS };
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
function argTimeout(args) {
  const ms = argInt(args, "timeout");
  if (ms !== void 0 && ms < 1) throw new UsageError(`--timeout expects a positive number of milliseconds, got "${ms}"`);
  return ms;
}
function toolTimeoutMs(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(3e5, Math.max(1, Math.round(n))) : void 0;
}
async function extractLocal(path, fullPage = false) {
  let bytes;
  try {
    bytes = readFileSync12(path);
  } catch (e) {
    throw new ToolError(`cannot read ${path}: ${e.message}`);
  }
  const asUrl = pathToFileURL(path).href;
  if (looksLikePdfUrl(asUrl) || bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    const r = await extractPdf(bytes);
    return { text: r.text, extractor: r.via ?? "none", reason: r.reason, consentDropped: 0 };
  }
  const fmt = docFormatForUrl(asUrl);
  if (fmt) {
    const r = await extractDocument(bytes, fmt);
    return { text: r.text, extractor: r.via ?? "none", reason: r.reason, consentDropped: 0 };
  }
  const extension = extname(path).toLowerCase();
  const explicitText = [".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".xml", ".yaml", ".yml"].includes(extension);
  const raw = decodeLocal(bytes, { sniffHtmlCharset: !explicitText });
  const looksHtml = !explicitText && ([".html", ".htm", ".xhtml"].includes(extension) || /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(raw));
  const text = looksHtml ? htmlToText(fullPage ? raw : extractMainHtml(raw), { fullPage }) : raw;
  const consent = looksHtml && !fullPage ? stripConsentBoilerplate(text) : { text, dropped: 0 };
  return { text: consent.text, extractor: looksHtml ? "native" : "plain", consentDropped: consent.dropped };
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
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(`${where}[${i}] is not an object`);
    const url = d.url;
    if (typeof url !== "string" || !url) throw new Error(`${where}[${i}] has no url`);
    for (const field of ["title", "headings", "text"]) {
      if (d[field] !== void 0 && typeof d[field] !== "string") throw new Error(`${where}[${i}].${field} must be a string`);
    }
    if (d.score !== void 0 && (typeof d.score !== "number" || !Number.isFinite(d.score))) {
      throw new Error(`${where}[${i}].score must be a finite number`);
    }
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
        description: "Fetch a URL and return its readable text. Handles HTML, PDFs (pdf-inspector \u2192 anydoc \u2192 Firecrawl \u2192 pdftotext \u2192 native \u2192 OCR) and office documents, and uses Firecrawl when available, with built-in extraction as fallback. Returns the extracted text, then a trailer with the final URL after redirects, the page's canonical URL and title, any note, and which rung produced it \u2014 never raw bytes. Accepts URLs from the host's native search (including ChatGPT or Claude) or supplied directly; webindex_search is optional.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The http(s) URL to fetch." },
            lang: { type: "string", description: "Accept-Language tag, e.g. fr-FR." },
            fullPage: { type: "boolean", description: "Keep the whole page: no main-content isolation, no consent-banner filter." },
            timeoutMs: { type: "number", description: "Give up on a silent host after this many ms (default 20000). A timed-out request is not retried." },
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
            fullPage: { type: "boolean", description: "Keep the whole page: no main-content isolation, no consent-banner filter." }
          },
          required: ["path"]
        }
      },
      {
        name: "webindex_rank",
        title: "Rank candidate documents against a question",
        description: "Order a pool of documents by relevance to a question: BM25F (title and headings weighted above body), then SimHash collapse of near-duplicates, then MMR so the top of the list says several different things rather than restating one. Returns the ranking with a score, the matched query terms, and what was collapsed \u2014 deterministic, no model, no network. Use it after gathering pages from any search provider to decide what to actually read. Scores measure relevance within this pool, not factual accuracy.",
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
        description: "Turn text into vectors with the local Ollama, which needs no key and sends nothing off the machine. Returns one vector per input, in input order. Answers with a note rather than an error when the service is not running.",
        inputSchema: {
          type: "object",
          properties: { texts: { type: "array", items: { type: "string" }, description: "The texts to embed." } },
          required: ["texts"]
        }
      },
      {
        name: "webindex_crawl",
        title: "Walk a site, within a budget",
        description: "Follow links from a seed page, breadth-first, honouring robots.txt at EVERY hop and staying on the seed's origin. `max` pages is required \u2014 enumerating someone else's site is the one operation here that can inconvenience them, so the budget is not optional. Returns each page's URL, title and text.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The seed page." },
            max: { type: "number", description: "Hard ceiling on pages fetched. Required." },
            depth: { type: "number", description: "How many links deep to follow (default 2)." }
          },
          required: ["url", "max"]
        }
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
      webindex_rank: "lower `limit`, or send shorter `text` per document \u2014 the ranking only needs enough to score",
      webindex_tables: "this page's tables are enormous; fetch it and read the file instead of inlining them",
      webindex_embed: "send fewer `texts` \u2014 a vector per input is large, and they are rarely worth reading inline",
      webindex_crawl: "lower `max`, or `depth` \u2014 a crawl's whole output is the sum of its pages"
    },
    async callTool(name, args) {
      if (name === "webindex_fetch") {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an http(s) URL.");
        const fullPage = args.fullPage === true;
        const r = await cachedFetchAndExtract(
          url,
          { acceptLanguage: args.lang ? String(args.lang) : void 0, fullPage, stripConsent: !fullPage, timeoutMs: toolTimeoutMs(args.timeoutMs) },
          args.cache === true
        );
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
        const r = await extractLocal(String(args.path ?? ""), args.fullPage === true);
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
          throw new InvalidParamsError(e.message);
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
        if (!tables.length) throw new ToolError(`${url} has no tables \u2014 use webindex_fetch for its text.`);
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
          throw new ToolError("`max` is required and must be a positive whole number \u2014 a crawl without a budget is not one.");
        const r = await crawlSite(url, { maxPages: max, ...args.depth !== void 0 ? { maxDepth: Number(args.depth) } : {} });
        if (!r.pages.length) throw new ToolError(`nothing readable from ${url}${r.notes.length ? ` \u2014 ${r.notes[0]}` : ""}`);
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
      throw new ToolError(`unknown tool: ${name}`);
    }
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
async function dispatch(argv) {
  const parsed = parseArgs(argv, SPEC);
  if (parsed.kind === "help") {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(ENGINE_VERSION + "\n");
    return;
  }
  const args = parsed;
  const cmd = args.command;
  if (cmd === "search") {
    const q = positionalText(args);
    if (!q) usage("usage: webindex search <query>");
    const engine = argValue(args, "engine");
    if (engine && engine !== "off" && !isKeylessEngine(engine)) fail(`unknown --engine "${engine}" \u2014 expected one of ${KEYLESS_ENGINES.join(", ")}, or off`);
    const r = await search(q, {
      limit: argInt(args, "limit"),
      pages: argInt(args, "pages"),
      lang: argValue(args, "lang"),
      searxng: argValue(args, "searxng"),
      firecrawl: argValue(args, "firecrawl"),
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
    const url = args.positional[0];
    if (!url) usage("usage: webindex fetch <url>");
    if (!/^https?:\/\//i.test(url)) fail("fetch needs an http(s) URL");
    const fullPage = argBool(args, "full-page");
    const refresh = argBool(args, "refresh");
    const offline = argBool(args, "offline");
    if (refresh && offline) usage("--refresh and --offline contradict each other: one always fetches, the other never does");
    setCacheMode({ refresh, offline });
    const r = await cachedFetchAndExtract(
      url,
      {
        acceptLanguage: argValue(args, "lang"),
        firecrawl: argValue(args, "firecrawl"),
        fullPage,
        stripConsent: !fullPage,
        timeoutMs: argTimeout(args)
      },
      argBool(args, "cache") || refresh
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
            consentDropped: r.consentDropped ?? 0
          },
          null,
          2
        ) + "\n"
      );
    } else if (r.text) {
      process.stdout.write(r.text + "\n");
    }
    if (!r.text) fail(`nothing readable at ${url}${r.note ? ` \u2014 ${r.note}` : ""}`);
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
          { file: basename4(path), extractor: r.extractor, chars: r.text.length, reason: r.reason, text: r.text, fullPage, consentDropped: r.consentDropped },
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
    if (transport === "stdio") {
      await runStdioServer(webindexAdapter());
      return;
    }
    if (transport !== "http") fail(`unknown transport "${transport}" \u2014 expected stdio or http`);
    const port = argInt(args, "port") ?? 7340;
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail("invalid --port");
    let running;
    try {
      running = await startHttpServer(webindexAdapter(), { port, bind: argValue(args, "bind"), allowRemote: argBool(args, "allow-remote") });
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
    const question = argValue(args, "query");
    if (!question) usage("usage: webindex rank --query <question> --docs <file.json|-> [--limit <n>] [--json]");
    const src = argValue(args, "docs") ?? "-";
    let payload;
    try {
      payload = src === "-" ? readFileSync12(0, "utf8") : readFileSync12(src, "utf8");
    } catch (e) {
      fail(`cannot read ${src === "-" ? "stdin" : src}: ${e.message}`);
    }
    let docs;
    try {
      docs = parseRankDocs(payload, "--docs");
    } catch (e) {
      fail(e.message);
    }
    const limit = argInt(args, "limit");
    const r = rankDocuments(question, docs, limit);
    if (argBool(args, "json")) {
      process.stdout.write(jsonLine(r));
    } else {
      process.stdout.write(
        r.ranked.map((x) => `${x.rank}. [${x.score.toFixed(3)}] ${x.title ?? x.url}
   ${x.url}${x.matched.length ? `
   matched: ${x.matched.join(", ")}` : ""}`).join("\n\n") + "\n"
      );
      if (r.collapsed) process.stderr.write(`${r.collapsed} near-duplicate(s) collapsed.
`);
    }
    if (!r.queryTerms.length) {
      process.stderr.write("The question has no rankable terms once stopwords are removed \u2014 the order is arbitrary.\n");
      process.exit(1);
    }
    return;
  }
  if (cmd === "repo" || cmd === "issues" || cmd === "prs" || cmd === "releases" || cmd === "package") {
    const target = positionalText(args);
    if (!target) usage(`usage: webindex ${cmd} <${cmd === "package" ? "name" : "repo"}> [--json]`);
    const asJson = argBool(args, "json");
    const limit = argInt(args, "limit");
    const emit = (obj, human) => process.stdout.write(asJson ? jsonLine(obj) : `${human.join("\n")}
`);
    if (cmd === "package") {
      const reg = argValue(args, "registry");
      const p = await resolvePackage(target, {
        ...reg ? { registry: reg } : {},
        ...argValue(args, "version") ? { version: argValue(args, "version") } : {}
      });
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
    const r = cmd === "releases" ? await listReleases(ref, { ...limit ? { limit } : {} }) : await searchIssues(ref, (argValue(args, "terms") ?? "").split(/\s+/).filter(Boolean), cmd === "prs" ? "pr" : "issue", {
      ...limit ? { limit } : {}
    });
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
    const target = positionalText(args);
    if (!target) usage(`usage: webindex ${cmd} <url>`);
    if (!/^https?:\/\//i.test(target)) fail("expected an http(s) URL");
    const asJson = argBool(args, "json");
    const emit = (obj, human) => process.stdout.write(asJson ? jsonLine(obj) : `${human.join("\n")}
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
      const s = await fetchSitemap(target, { sitemaps: robots.sitemaps, max: argInt(args, "max") });
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
    const m = pageMetadata(page.body, { baseUrl: page.url });
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
    const action = args.positional[0] ?? "status";
    if (action !== "status" && action !== "clean") usage("usage: webindex cache status|clean [--all]");
    if (action === "clean") {
      const all = argBool(args, "all");
      if (isNoWrite()) {
        process.stdout.write(`no-write mode: nothing removed from ${cacheDir()}
`);
        return;
      }
      const removed = cacheClean(all);
      process.stdout.write(`${removed} entr${removed === 1 ? "y" : "ies"} removed (${all ? "all" : "stale only"}) from ${cacheDir()}
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
        ...s.oldest ? [`  oldest   ${s.oldest}`, `  newest   ${s.newest}`] : []
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
    const r = await crawlSite(seed, {
      maxPages: max,
      ...argInt(args, "depth") !== void 0 ? { maxDepth: argInt(args, "depth") } : {},
      crossOrigin: argBool(args, "cross-origin")
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
    const url = positionalText(args);
    if (!url) usage("usage: webindex tables <url>");
    if (!/^https?:\/\//i.test(url)) fail("tables needs an http(s) URL");
    const page = await httpGet(url, { accept: "text/html,*/*" });
    if (!page.ok) fail(`could not fetch ${url} (status ${page.status})`);
    const tables = extractTables(page.body);
    if (!tables.length) fail(`no tables on ${url}`);
    process.stdout.write(argBool(args, "json") ? jsonLine(tables) : `${tables.map(tableToMarkdown).join("\n\n")}
`);
    return;
  }
  if (cmd === "embed") {
    const text = positionalText(args);
    if (!text) usage("usage: webindex embed <text>");
    const r = await embed([text]);
    if (!r.vectors.length) fail(r.note ?? "the embedding server returned nothing");
    process.stdout.write(
      argBool(args, "json") ? jsonLine({ model: r.model, dimensions: r.vectors[0]?.length ?? 0, vector: r.vectors[0] }) : `${(r.vectors[0] ?? []).join(" ")}
`
    );
    return;
  }
  if (cmd === "hybrid") {
    const question = argValue(args, "query");
    if (!question) usage("usage: webindex hybrid --query <question> --docs <file.json|->");
    const src = argValue(args, "docs") ?? "-";
    let payload;
    try {
      payload = src === "-" ? readFileSync12(0, "utf8") : readFileSync12(src, "utf8");
    } catch (e) {
      fail(`cannot read ${src === "-" ? "stdin" : src}: ${e.message}`);
    }
    let docs;
    try {
      docs = parseRankDocs(payload, "--docs");
    } catch (e) {
      fail(e.message);
    }
    const r = await hybridSearch(
      question,
      docs.map((d, i) => ({ id: d.url ?? String(i), title: d.title ?? "", headings: "", body: d.text ?? "" })),
      { ...argInt(args, "limit") !== void 0 ? { limit: argInt(args, "limit") } : {} }
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
  if (cmd === "skill") {
    const action = args.positional[0] ?? "";
    const root = resolve4(argValue(args, "root") ?? process.cwd());
    const asJson = argBool(args, "json");
    if (action === "init") {
      const name = args.positional[1];
      if (!name) usage("usage: webindex skill init <name> [--root <dir>]");
      const r = scaffoldSkill(root, name, { exists: existsSync7 });
      for (const e of r.errors) process.stderr.write(`  ${e}
`);
      process.stdout.write(asJson ? jsonLine(r) : `${r.written.map((p) => `  wrote ${relative2(root, p)}`).join("\n")}
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
      process.stdout.write(asJson ? jsonLine({ changes }) : `${changes.join("\n") || "All pins are current"}
`);
      return;
    }
    if (action === "vendor") {
      if (argBool(args, "list")) {
        for (const [name, pin] of Object.entries(config.engines)) {
          const meta = JSON.parse(readFileSync12(join15(root, config.vendorDir, pin.meta), "utf8"));
          process.stdout.write(`${name} ${pin.repo} ${meta.tag}
`);
        }
        return;
      }
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
      const ref = argValue(args, "ref");
      if (!ref) usage("usage: webindex skill vendor [--engine <name>] --ref <tag>   |   webindex skill vendor --check");
      const only = argValue(args, "engine");
      const names = only ? [only] : Object.keys(config.engines);
      const fetchFile = async (url) => {
        const res = await httpGet(url, { binary: true, maxBytes: 64 * 1024 * 1024 });
        return res.ok ? res.bytes : void 0;
      };
      for (const n of names) {
        const pin = config.engines[n];
        const r = await vendorEngine(root, config, n, ref, fetchFile, pin ? releaseCommit(pin.repo, ref) : void 0);
        for (const w of r.written) process.stdout.write(`  wrote ${relative2(root, w)}
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
      const engineNames = only ? [only] : Object.keys(config.engines);
      let failedAny = false;
      for (const engineName of engineNames) {
        const pin = config.engines[engineName];
        if (!pin) fail(`unknown engine ${engineName}`);
        const usageConfig = { ...config, usageFloor: pin.usageFloor ?? config.usageFloor, forks: pin.forks ?? config.forks };
        const dtsFile = pin?.files?.find((f) => f.local.endsWith(".d.mts"))?.local;
        let dts = "";
        try {
          dts = readFileSync12(join15(root, config.vendorDir, dtsFile ?? ""), "utf8");
        } catch {
          fail(`cannot read the vendored declarations for "${engineName}" \u2014 run \`webindex skill vendor --ref <tag>\` first`);
        }
        const report = auditEngineUsage(root, usageConfig, dts, engineName);
        if (asJson) {
          process.stdout.write(jsonLine(report));
        } else {
          for (const c of report.collisions) process.stderr.write(`  FAIL ${c.file} declares ${c.name}, which the engine already exports
`);
          if (report.collisions.length)
            process.stderr.write('\n  Re-export it from ./engine.js instead. (`export { X } from "./engine.js"` is fine and is not flagged.)\n');
          for (const s of report.stale) process.stderr.write(`  FAIL forks entry "${s}" no longer matches anything \u2014 delete it
`);
          if (report.imported.length < usageConfig.usageFloor) {
            process.stderr.write(`  FAIL only ${report.imported.length} distinct engine symbols are imported, floor is ${usageConfig.usageFloor}.
`);
            process.stderr.write("       A layer stopped being used. If that was deliberate, lower the floor in the same commit.\n");
          }
        }
        const failed = report.collisions.length > 0 || report.stale.length > 0 || report.imported.length < usageConfig.usageFloor;
        failedAny ||= failed;
        if (!asJson) {
          const forks = report.tolerated.length ? `, ${report.tolerated.length} known fork(s) still to adopt` : ", no local re-declarations";
          process.stdout.write(
            `  ok   ${report.imported.length} engine symbols in use (floor ${usageConfig.usageFloor})${forks}, of a ${report.surface}-symbol surface.
`
          );
        }
      }
      if (failedAny) process.exit(EXIT_FAILURE);
      return;
    }
    if (action === "bundle") {
      const built = join15(root, "scripts", `${config.name}.mjs`);
      let surface;
      let surfaceProblem;
      const flagList = (v) => v == null || typeof v === "string" || typeof v[Symbol.iterator] !== "function" ? void 0 : [...v];
      if (existsSync7(built)) {
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
          surfaceProblem = `could not import ${relative2(root, built)} for the drift gate: ${e.message}`;
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
      const from = join15(root, "scripts", `${config.name}.mjs`);
      if (!existsSync7(from)) fail(`missing ${relative2(root, from)} \u2014 run the build first`);
      const to = join15(root, "skills", config.name, "scripts", `${config.name}.mjs`);
      ensureDir(join15(to, ".."));
      writeArtifact(to, readFileSync12(from, "utf8"));
      process.stdout.write(`  copied ${relative2(root, from)} -> ${relative2(root, to)}
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
    usage("usage: webindex skill check|bundle|vendor|copy|doctor|init");
  }
  if (cmd === "doctor") {
    const base = firecrawlBase();
    const sx = searxngBase();
    const ol = ollamaBase();
    const qd = qdrantBase();
    const [fc, sxUp, olUp, qdUp] = await Promise.all([base ? probeFirecrawl(base) : false, sx ? probeSearxng(sx) : false, probeOllama(ol), probeQdrant(qd)]);
    const off = (s) => s.toLowerCase() === "off";
    const ocr = await ocrTools();
    const lines = [
      `webindex ${ENGINE_VERSION}`,
      `  searxng     ${sx ? sxUp ? `answering at ${sx}` : `not reachable at ${sx} \u2014 \`webindex searxng up\` starts it` : "disabled"}`,
      `  firecrawl   ${base ? fc ? `answering at ${base}` : `not reachable at ${base} \u2014 the built-in extractor is used instead` : "disabled"}`,
      `  ollama      ${off(ol) ? "disabled" : olUp ? `answering at ${ol} (model ${embedModel()})` : `not reachable at ${ol} \u2014 \`webindex semantic up\` starts it`}`,
      `  qdrant      ${off(qd) ? "disabled" : qdUp ? `answering at ${qd}` : `not reachable at ${qd} \u2014 \`webindex semantic up\` starts it`}`,
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
if (isInvokedDirectly()) {
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
  webindexAdapter
};
