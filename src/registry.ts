import { contactUa, httpGet, httpJson } from "./fetch.js";

// Package registries: a library's NAME resolved to its actual coordinates.
//
// This existed nowhere — not in the engine, and not in either consumer that
// needed it. One skill's SKILL.md pushes "with only a name, find the canonical
// repo URL" onto the model and hopes; the other searches the web for
// "<tech> official documentation" and reads whatever ranks. Both are guesses at
// something the registry states outright, and both are how a tool ends up
// documenting a fork, an abandoned mirror, or a name-squatted package.
//
// A registry lookup uses keyless, bounded requests to answer repository,
// homepage, documentation, current version, licence and — the one nothing else
// surfaces — whether the package is DEPRECATED.

export type RegistryKind = "npm" | "pypi" | "crates";

export interface PackageFacts {
  registry: RegistryKind;
  name: string;
  version?: string;
  description?: string;
  homepage?: string;
  /** Normalised to an https URL where the registry gives something git-shaped. */
  repository?: string;
  /** Where in that repository the package lives — a monorepo's `packages/x`, from npm's `repository.directory`. */
  repositoryDirectory?: string;
  documentation?: string;
  license?: string;
  /** The registry's own deprecation notice, when there is one. */
  deprecated?: string;
  /** Recent downloads, where the registry publishes them. */
  downloads?: number;
  publishedAt?: string;
}

/** One registry's answer: the facts, or its status and why there are none. */
export interface PackageLookup {
  facts?: PackageFacts;
  /** The registry's HTTP status — 404 is "no such package (or version)", 0 is no answer at all. */
  status: number;
  /** Why a request that was not a plain 404 failed, as the runtime or registry said it. */
  error?: string;
}

/** A name resolved across registries — or why it was not. */
export interface PackageResolution {
  facts?: PackageFacts;
  /** Why there are no facts, in words a caller can show. */
  note?: string;
  /** Each registry asked, in order, and what it answered. */
  tried: { registry: RegistryKind; status: number; error?: string }[];
}

const REGISTRIES: readonly RegistryKind[] = ["npm", "pypi", "crates"];
const NPM = (n: string) => `https://registry.npmjs.org/${encodeURIComponent(n).replace(/^%40/, "@")}`;
const PYPI = (n: string, version?: string) => `https://pypi.org/pypi/${encodeURIComponent(n)}/${version ? `${encodeURIComponent(version)}/` : ""}json`;
const CRATES = (n: string) => `https://crates.io/api/v1/crates/${encodeURIComponent(n)}`;

// npm's shorthands, which older packuments still carry verbatim.
const SHORTHAND_HOST: Record<string, string> = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" };

/**
 * Turn whatever a registry calls a repository into a browsable https URL.
 *
 * They are wildly inconsistent — `git+https://…​.git`, `git://`, `git@host:…`,
 * `ssh://git@host:…`, npm's `github:owner/repo`, a bare `owner/repo`, any of
 * them upper-cased or with a `#branch` — and a caller that passes any of those
 * to a browser or a clone gets a different failure for each.
 */
export function normalizeRepoUrl(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.trim() : typeof (raw as { url?: unknown })?.url === "string" ? String((raw as { url: string }).url).trim() : "";
  if (!s) return undefined;
  const short = /^(github|gitlab|bitbucket):([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#.*)?$/i.exec(s);
  if (short) return `https://${SHORTHAND_HOST[short[1]!.toLowerCase()]}/${short[2]}`;
  let out = s
    // A fragment names a branch or an anchor, never the repository.
    .replace(/#.*$/s, "")
    .replace(/^git\+/i, "")
    .replace(/^git:\/\//i, "https://")
    // ssh://[user@]host[:port]/path, then the scp-like ssh://[user@]host:path.
    .replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//i, "https://$1/")
    .replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+):/i, "https://$1/")
    .replace(/^[\w.-]+@([^:/]+):/, "https://$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(out)) out = `https://github.com/${out}`;
  return /^https?:\/\//i.test(out) ? out.replace(/^https?:\/\//i, (scheme) => scheme.toLowerCase()) : undefined;
}

function reqOpts() {
  return { timeoutMs: 12_000, userAgent: contactUa(), accept: "application/json" };
}

// npm keeps publication timestamps on the package document, not on
// `/<version>`. That document can be tens of megabytes because it also contains
// every version and the README. Its `time` map is near the end, so a bounded
// suffix request preserves the public fact without bringing the huge document
// back into memory. A registry/proxy that ignores Range safely degrades to no
// timestamp when its full response exceeds the same cap.
//
// Two sizes, because the map is near the end but not AT it: measured, it opens
// 80–190 KB from the end of the biggest packuments (react, typescript, next).
// 256 KiB finds it for them; 2 MiB is read only when a real range (a 206) came
// back without a closed map. Reading 2 MiB first cost ~1.5 MB per lookup and,
// on a 5 Mbit/s link, never finished inside the budget at all.
const NPM_TIME_TAIL_FIRST_BYTES = 256 * 1024;
const NPM_TIME_TAIL_BYTES = 2 * 1024 * 1024;

const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** Whether the unquoted `{` at `i` is the one that opens a `time` map. */
function opensTimeMap(text: string, i: number): boolean {
  // Looked up BACKWARDS over the key, which costs a fixed handful of characters,
  // rather than forwards from a `"time":{` match — the direction that made
  // finding the map cost a scan of everything after it.
  let j = i - 1;
  while (j >= 0 && isWs(text[j])) j--;
  if (text[j] !== ":") return false;
  j--;
  while (j >= 0 && isWs(text[j])) j--;
  return j >= 5 && text.slice(j - 5, j + 1) === '"time"';
}

/**
 * The state a JSON reader can be in at an arbitrary byte of a document.
 *
 * `outside` is between tokens; `string` is inside a string literal; `escape` is
 * inside one directly after a backslash, so the NEXT character is consumed by
 * the escape rather than read. A byte range can start in any of the three —
 * `escape` is what a cut landing between the two bytes of a `\\` produces —
 * and no other state changes how quotes and braces are read. `\uXXXX` needs no
 * state of its own: its hex digits are neither quote nor brace nor backslash,
 * so reading them as ordinary string characters gives the same answer.
 */
type ScanPhase = "outside" | "string" | "escape";

// At most this many `time` maps may be open at once. A real packument has ONE,
// at the top level; a body full of `"time":{` that never closes has as many as
// it has bytes, and without a ceiling each one costs an entry that is never
// popped. Past the ceiling the body simply yields no timestamp, which is what it
// was always going to yield.
const MAX_OPEN_TIME_MAPS = 16;

/**
 * Read a `time` map out of the body in ONE pass, tracking brace depth and string
 * state and closing each map on the brace that actually balances it.
 *
 * The previous shape — match every `"time":{`, then scan forward from each to
 * find its close — is quadratic on exactly the input this is fed. The body is a
 * PARTIAL document by construction, so a marker routinely has no matching brace
 * and costs a scan to the end; 2 MiB of unclosed markers, which a package's own
 * README (carried verbatim in its packument) is enough to put there, pins the
 * event loop for minutes inside a step budgeted 2.5 seconds.
 *
 * Reading string state as it goes also makes it stricter for free: a `"time":{`
 * sitting inside a README string is no longer a candidate at all.
 *
 * `phase` is the state to read the first character in — see the caller.
 */
function scanTimeMap(text: string, version: string, phase: ScanPhase): { publishedAt?: string; closed: boolean } {
  let publishedAt: string | undefined;
  let closed = false;
  let depth = 0;
  let quoted = phase !== "outside";
  let escaped = phase === "escape";
  // Open `time` maps, innermost last. Depths are relative: a suffix that starts
  // mid-document closes braces it never opened, so `depth` legitimately goes
  // negative and only the DIFFERENCE between an open and its close matters.
  const open: { at: number; depth: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
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
          if (time && typeof time === "object" && !Array.isArray(time)) {
            closed = true;
            if (typeof time[version] === "string") publishedAt = time[version];
          }
        } catch (err) {
          // A `time` map that does not parse is one more thing this body cannot
          // tell us; the rest of it still can. Only malformed JSON is expected
          // here — anything else came from this scanner, not from the body, and
          // swallowing it would hide a real defect behind a missing timestamp.
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
      // Candidates the document can no longer close: a suffix carries more `}`
      // than `{`, and an entry left above the current depth would otherwise
      // match a brace that has nothing to do with it.
      while (open.length && open[open.length - 1]!.depth > depth) open.pop();
    }
  }
  return { publishedAt, closed };
}

/**
 * The version's publication time out of a suffix, and whether any `time` map in
 * it closed at all — a closed map without this version is an answer ("not
 * there"); no closed map means the suffix began inside it.
 */
function npmTimeFromTail(text: string, version: string): { publishedAt?: string; closed: boolean } {
  // A `bytes=-N` suffix cuts the document at an arbitrary byte, so the state its
  // first character belongs to cannot be told from the bytes alone — get it
  // wrong and every quote after it is inverted, which is how a real range
  // landing mid-README hides the `time` map that follows it. There are exactly
  // three such states, so read the body in the likeliest one and fall back
  // through the rest. Three linear passes are still linear, and a `time` map
  // found in the wrong phase would have to survive `JSON.parse` and carry this
  // exact version as a string key to be believed at all.
  let closed = false;
  for (const phase of ["outside", "string", "escape"] as const) {
    const found = scanTimeMap(text, version, phase);
    if (found.publishedAt) return found;
    closed ||= found.closed;
  }
  return { closed };
}

async function npmPublishedAt(packageUrl: string, version: string | undefined): Promise<string | undefined> {
  if (!version) return undefined;
  for (const bytes of [NPM_TIME_TAIL_FIRST_BYTES, NPM_TIME_TAIL_BYTES]) {
    const tail = await httpGet(packageUrl, {
      ...reqOpts(),
      // Optional enrichment must not inherit the primary lookup's retry budget:
      // package facts are already usable if this suffix is slow or unavailable.
      timeoutMs: 2_500,
      retries: 0,
      headers: { range: `bytes=-${bytes}` },
      maxBytes: bytes,
    });
    if (!tail.ok) return undefined;
    const found = npmTimeFromTail(tail.body, version);
    // Reading further back helps only when the registry honoured the range (a
    // 206) and no map closed in it. A 200 is the document's HEAD, however much
    // of it is read.
    if (found.publishedAt || found.closed || tail.status !== 206) return found.publishedAt;
  }
  return undefined;
}

type JsonAnswer = Awaited<ReturnType<typeof httpJson>>;

/** The answer's JSON object, or undefined when it did not bring one. */
function record(r: JsonAnswer): Record<string, any> | undefined {
  return r.ok && r.data && typeof r.data === "object" && !Array.isArray(r.data) ? (r.data as Record<string, any>) : undefined;
}

// The answers that mean "there is no such package, or no such version of it":
// a 404, a 410 for a removed project, and the 400 crates.io gives a version
// string that cannot exist (`^18`). Each lets the next registry answer.
const ABSENT: ReadonlySet<number> = new Set([400, 404, 410]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** No facts: an ABSENT status says "no such package or version"; anything else says why. */
function miss(r: JsonAnswer): PackageLookup {
  if (ABSENT.has(r.status)) return { status: r.status };
  // A registry's own words when it gave some, which name the cause better than a number.
  const said = r.data && typeof r.data === "object" ? (str(r.data.errors?.[0]?.detail) ?? str(r.data.message) ?? str(r.data.error)) : undefined;
  return { status: r.status, error: r.error ?? said ?? (r.ok ? "the registry answered with something other than a package record" : `status ${r.status}`) };
}

/**
 * Look a package up in one registry.
 *
 * Returns undefined for "no such package" AND for a request that failed;
 * `lookupPackageResult` tells the two apart, which a caller resolving a name
 * across several registries needs — to try the next one, or to stop and report
 * a network problem.
 *
 * With `version`, it is that version or nothing: every registry is asked for
 * it by name, and one that does not have it answers 404.
 */
export async function lookupPackage(registry: RegistryKind, name: string, version?: string): Promise<PackageFacts | undefined> {
  return (await lookupPackageResult(registry, name, version)).facts;
}

/** `lookupPackage`, with the registry's status and, for anything but a 404, why it failed. */
export async function lookupPackageResult(registry: RegistryKind, name: string, version?: string): Promise<PackageLookup> {
  if (!REGISTRIES.includes(registry)) return { status: 0, error: `unknown registry "${String(registry)}" — expected ${REGISTRIES.join(", ")}` };
  const n = name.trim();
  if (!n) return { status: 0, error: "no package name given" };
  const v = version?.trim() || undefined;
  if (registry === "npm") return npmLookup(n, v);
  if (registry === "pypi") return pypiLookup(n, v);
  return cratesLookup(n, v);
}

async function npmLookup(n: string, version: string | undefined): Promise<PackageLookup> {
  // npm's package document can be many megabytes for long-lived packages and
  // legitimately exceeds the shared HTTP safety cap. The version endpoint
  // returns the same facts this API exposes without downloading every release,
  // and resolves a dist-tag ("next", "beta") to the version it stands for.
  const r = await httpJson("GET", `${NPM(n)}/${encodeURIComponent(version ?? "latest")}`, undefined, reqOpts());
  const d = record(r);
  if (!d) return miss(r);
  // The compact document names its own version. A full packument — what an
  // embedder's own fetch may answer with — names it by tag, or by key.
  const asked = version ?? "latest";
  const tags = d["dist-tags"] ?? {};
  const resolved: string | undefined =
    str(d.version) ?? (typeof tags[asked] === "string" ? tags[asked] : undefined) ?? (d.versions?.[asked] ? asked : undefined);
  const v = (resolved && d.versions?.[resolved]) || d;
  // A full packument states the publication time outright; the compact version
  // document does not. Buying it again from the suffix would cost a range read
  // against a 2.5s budget for a date this response already carries.
  const stated = resolved ? d.time?.[resolved] : undefined;
  const publishedAt = typeof stated === "string" ? stated : await npmPublishedAt(NPM(n), resolved);
  // npm marks deprecation on the VERSION, not the package — so a package whose
  // latest release is deprecated looks perfectly healthy at the top level.
  const deprecated = typeof v.deprecated === "string" ? v.deprecated : v.deprecated === true ? "deprecated" : undefined;
  const repository = v.repository ?? d.repository;
  const directory = str(repository?.directory);
  return {
    status: r.status,
    facts: {
      registry: "npm",
      name: d.name ?? n,
      version: resolved,
      description: v.description ?? d.description,
      homepage: v.homepage ?? d.homepage,
      repository: normalizeRepoUrl(repository),
      ...(directory ? { repositoryDirectory: directory } : {}),
      documentation: typeof v.documentation === "string" ? v.documentation : undefined,
      license: typeof v.license === "string" ? v.license : v.license?.type,
      ...(deprecated ? { deprecated } : {}),
      publishedAt,
    },
  };
}

// A homepage is taken for the repository only when it IS one: most PyPI
// homepages are documentation sites.
const FORGE_URL = /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/[^/]+\/[^/]+/i;
// project_urls labels, normalised, in the order they name a repository.
const PYPI_REPO_LABELS = ["source", "sourcecode", "repository", "code", "github", "gitlab"];

/**
 * project_urls with its labels normalised — "Source Code", "source_code" and
 * PEP 753's lower-case "source" are one label, and matching them by exact case
 * missed the repository of numpy, pandas and scikit-learn.
 */
function projectUrls(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object") return out;
  for (const [label, url] of Object.entries(raw as Record<string, unknown>)) {
    const key = label.toLowerCase().replace(/[^a-z]/g, "");
    if (typeof url === "string" && url.trim() && !out.has(key)) out.set(key, url.trim());
  }
  return out;
}

// PEP 639's `license_expression` first, which modern packages set instead of
// `license`; then `license` only when it is a name — some packages put the whole
// licence TEXT there, tens of kilobytes of it; then the Trove classifiers.
function pypiLicense(info: Record<string, any>, classifiers: string[]): string | undefined {
  const expression = str(info.license_expression);
  if (expression) return expression;
  const license = str(info.license);
  if (license && license.length <= 100 && !license.includes("\n")) return license;
  const named = classifiers.filter((c) => c.startsWith("License ::")).map((c) => c.split("::").pop()!.trim());
  return named.filter(Boolean).join(", ") || undefined;
}

async function pypiLookup(n: string, version: string | undefined): Promise<PackageLookup> {
  const r = await httpJson("GET", PYPI(n, version), undefined, reqOpts());
  const d = record(r);
  if (!d) return miss(r);
  const info: Record<string, any> = d.info ?? {};
  const urls = projectUrls(info.project_urls);
  const classifiers: string[] = Array.isArray(info.classifiers) ? info.classifiers.filter((c: unknown): c is string => typeof c === "string") : [];
  const homepage = str(info.home_page) ?? urls.get("homepage");
  const labelled = PYPI_REPO_LABELS.map((k) => urls.get(k)).find(Boolean);
  const repository = labelled ?? [info.home_page, urls.get("homepage")].find((u): u is string => typeof u === "string" && FORGE_URL.test(u));
  const filesYanked = Array.isArray(d.urls) && d.urls.length ? d.urls.every((u: Record<string, unknown>) => u.yanked) : false;
  const yanked =
    info.yanked === true
      ? `this release is yanked${str(info.yanked_reason) ? `: ${str(info.yanked_reason)}` : ""}`
      : filesYanked
        ? "every file for this release is yanked"
        : undefined;
  const inactive = classifiers.find((c) => /^Development Status :: 7 - Inactive/.test(c));
  const deprecated = yanked ?? (inactive ? `the project declares itself inactive (${inactive})` : undefined);
  return {
    status: r.status,
    facts: {
      registry: "pypi",
      name: info.name ?? n,
      version: info.version,
      description: info.summary,
      homepage,
      repository: normalizeRepoUrl(repository),
      documentation: str(info.docs_url) ?? urls.get("documentation") ?? urls.get("docs"),
      license: pypiLicense(info, classifiers),
      ...(deprecated ? { deprecated } : {}),
    },
  };
}

async function cratesLookup(n: string, version: string | undefined): Promise<PackageLookup> {
  // The crate record embeds EVERY version, feature maps included — 441 KB for
  // serde, and past the 4 MiB cap for web-sys, which then "did not exist".
  // `include=default_version` keeps the crate and its default version only; a
  // pinned version is asked for by name, since it may not be the default.
  const [crateAnswer, pinnedAnswer] = await Promise.all([
    httpJson("GET", `${CRATES(n)}?include=default_version`, undefined, reqOpts()),
    version ? httpJson("GET", `${CRATES(n)}/${encodeURIComponent(version)}`, undefined, reqOpts()) : undefined,
  ]);
  const d = record(crateAnswer);
  if (!d) return miss(crateAnswer);
  let v: Record<string, any> | undefined;
  if (pinnedAnswer) {
    const pinned = record(pinnedAnswer);
    if (!pinned) return miss(pinnedAnswer);
    v = pinned.version ?? {};
  }
  const c: Record<string, any> = d.crate ?? {};
  // With `include=default_version`, max_stable_version is null and
  // newest_version a "0.0.0" placeholder — the default version is the answer.
  const listed = Array.isArray(d.versions) ? str(d.versions[0]?.num) : undefined;
  const newest = str(c.newest_version) === "0.0.0" ? undefined : str(c.newest_version);
  const num = version ? (str(v?.num) ?? version) : (str(c.default_version) ?? listed ?? str(c.max_stable_version) ?? newest);
  v ??= Array.isArray(d.versions) ? d.versions.find((x: Record<string, unknown> | null) => x?.num === num) : undefined;
  // The licence and the publication date belong to a VERSION, which is why the
  // crate record alone never carried a licence.
  const yanked = v?.yanked === true ? `this version is yanked${str(v.yank_message) ? `: ${str(v.yank_message)}` : ""}` : undefined;
  return {
    status: crateAnswer.status,
    facts: {
      registry: "crates",
      name: c.name ?? n,
      version: num,
      description: str(c.description) ?? str(v?.description),
      homepage: str(c.homepage) ?? str(v?.homepage),
      repository: normalizeRepoUrl(c.repository ?? v?.repository),
      documentation: str(c.documentation) ?? str(v?.documentation),
      license: str(v?.license),
      downloads: typeof c.downloads === "number" ? c.downloads : undefined,
      publishedAt: str(v?.created_at) ?? (version ? undefined : str(c.updated_at)),
      ...(yanked ? { deprecated: yanked } : {}),
    },
  };
}

/**
 * Resolve a bare library name across the registries, in the order most likely to
 * be right, and return the first that knows it.
 *
 * Order is deliberate rather than alphabetical: npm has by far the most names,
 * so trying it first resolves most lookups without probing another registry. An
 * explicit `registry` skips the guessing entirely, which a caller who knows the
 * ecosystem should always do.
 *
 * Undefined when no registry has it — or when one could not be asked;
 * `resolvePackageResult` says which.
 */
export async function resolvePackage(name: string, opts: { registry?: RegistryKind; version?: string } = {}): Promise<PackageFacts | undefined> {
  return (await resolvePackageResult(name, opts)).facts;
}

/**
 * `resolvePackage`, with the reason when it finds nothing.
 *
 * Only a definite 404 hands the name on to the next registry. A registry that
 * is down, rate-limited or unreachable STOPS the walk: the next ecosystem's
 * namesake is a different project, and "npm is down" answered with PyPI's
 * `react` (python-react 4.3.0) was a wrong answer that looked like a right one.
 */
export async function resolvePackageResult(name: string, opts: { registry?: RegistryKind; version?: string } = {}): Promise<PackageResolution> {
  if (!name.trim()) return { tried: [], note: "no package name given" };
  const order = opts.registry ? [opts.registry] : REGISTRIES;
  const tried: PackageResolution["tried"] = [];
  for (const registry of order) {
    const r = await lookupPackageResult(registry, name, opts.version);
    tried.push({ registry, status: r.status, ...(r.error ? { error: r.error } : {}) });
    if (r.facts) return { facts: r.facts, tried };
    if (!REGISTRIES.includes(registry)) return { tried, note: r.error };
    if (!ABSENT.has(r.status)) {
      const why = r.status ? ` (status ${r.status})` : "";
      return { tried, note: `${registry} could not be asked${why}: ${r.error ?? "no answer"} — retry, or name the registry the package is on.` };
    }
  }
  const at = opts.version ? ` at version ${opts.version}` : "";
  // Registries resolve exact versions (npm also dist-tags), never a range.
  const range =
    opts.version && /[\^~<>=*|\s]|^[xX]$|\.[xX]\b/.test(opts.version) ? " (a version range is not resolved — pass an exact version, or an npm dist-tag)" : "";
  return { tried, note: `no registry knows a package called "${name.trim()}"${at}${range}` };
}
