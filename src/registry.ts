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
  documentation?: string;
  license?: string;
  /** The registry's own deprecation notice, when there is one. */
  deprecated?: string;
  /** Recent downloads, where the registry publishes them. */
  downloads?: number;
  publishedAt?: string;
}

const REGISTRY_URL: Record<RegistryKind, (name: string) => string> = {
  npm: (n) => `https://registry.npmjs.org/${encodeURIComponent(n).replace(/^%40/, "@")}`,
  pypi: (n) => `https://pypi.org/pypi/${encodeURIComponent(n)}/json`,
  crates: (n) => `https://crates.io/api/v1/crates/${encodeURIComponent(n)}`,
};

/**
 * Turn whatever a registry calls a repository into a browsable https URL.
 *
 * They are wildly inconsistent — `git+https://…​.git`, `git://`, `git@host:…`,
 * a bare `owner/repo`, or a plain URL — and a caller that passes any of those
 * to a browser or a clone gets a different failure for each.
 */
export function normalizeRepoUrl(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.trim() : typeof (raw as { url?: unknown })?.url === "string" ? String((raw as { url: string }).url).trim() : "";
  if (!s) return undefined;
  let out = s
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(out)) out = `https://github.com/${out}`;
  return /^https?:\/\//i.test(out) ? out : undefined;
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
 * `startQuoted` is the phase to read the first character in — see the caller.
 */
function scanTimeMap(text: string, version: string, startQuoted: boolean): string | undefined {
  let publishedAt: string | undefined;
  let depth = 0;
  let quoted = startQuoted;
  let escaped = false;
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
          if (time && typeof time === "object" && !Array.isArray(time) && typeof time[version] === "string") publishedAt = time[version];
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
  return publishedAt;
}

function npmTimeFromTail(text: string, version: string): string | undefined {
  // A `bytes=-N` suffix cuts the document at an arbitrary byte, so its first
  // character is either inside a JSON string or outside one and there is no way
  // to tell from the bytes alone — get that phase wrong and every quote after it
  // is inverted, which is how a real range landing mid-README hides the `time`
  // map that follows it. There are only two phases, so read the body in the
  // likelier one (a whole document, or a cut that fell outside a string) and fall
  // back to the other. Two linear passes are still linear, and a `time` map found
  // in the wrong phase would have to survive `JSON.parse` and carry this exact
  // version as a string key to be believed at all.
  return scanTimeMap(text, version, false) ?? scanTimeMap(text, version, true);
}

async function npmPublishedAt(packageUrl: string, version: string | undefined): Promise<string | undefined> {
  if (!version) return undefined;
  const tail = await httpGet(packageUrl, {
    ...reqOpts(),
    // Optional enrichment must not inherit the primary lookup's retry budget:
    // package facts are already usable if this suffix is slow or unavailable.
    timeoutMs: 2_500,
    retries: 0,
    headers: { range: `bytes=-${NPM_TIME_TAIL_BYTES}` },
    maxBytes: NPM_TIME_TAIL_BYTES,
  });
  return tail.ok ? npmTimeFromTail(tail.body, version) : undefined;
}

/**
 * Look a package up in one registry.
 *
 * Returns undefined for "no such package", which is different from a failed
 * request — a caller resolving a name across several registries needs to know
 * whether to try the next one or to stop and report a network problem.
 */
export async function lookupPackage(registry: RegistryKind, name: string, version?: string): Promise<PackageFacts | undefined> {
  const n = name.trim();
  if (!n) return undefined;
  // npm's package document can be many megabytes for long-lived packages and
  // legitimately exceeds the shared HTTP safety cap. The version endpoint
  // returns the same facts this API exposes without downloading every release.
  const url = registry === "npm" ? `${REGISTRY_URL.npm(n)}/${encodeURIComponent(version ?? "latest")}` : REGISTRY_URL[registry](n);
  const r = await httpJson("GET", url, undefined, reqOpts());
  if (!r.ok || !r.data || typeof r.data !== "object") return undefined;
  const d = r.data as Record<string, any>;

  if (registry === "npm") {
    // Keep accepting a full packument here for embedders that provide their own
    // fetch implementation, while preferring npm's compact version document.
    const latest = version ?? d["dist-tags"]?.latest ?? d.version;
    const v = (latest && d.versions?.[latest]) || d;
    const publishedAt = await npmPublishedAt(REGISTRY_URL.npm(n), latest);
    // npm marks deprecation on the VERSION, not the package — so a package whose
    // latest release is deprecated looks perfectly healthy at the top level.
    const deprecated = typeof v.deprecated === "string" ? v.deprecated : v.deprecated === true ? "deprecated" : undefined;
    return {
      registry,
      name: d.name ?? n,
      version: latest,
      description: v.description ?? d.description,
      homepage: v.homepage ?? d.homepage,
      repository: normalizeRepoUrl(v.repository ?? d.repository),
      documentation: typeof v.documentation === "string" ? v.documentation : undefined,
      license: typeof v.license === "string" ? v.license : v.license?.type,
      ...(deprecated ? { deprecated } : {}),
      publishedAt: publishedAt ?? (latest ? d.time?.[latest] : undefined),
    };
  }

  if (registry === "pypi") {
    const info = d.info ?? {};
    const urls = info.project_urls ?? {};
    const yanked = Array.isArray(d.urls) && d.urls.length ? d.urls.every((u: Record<string, unknown>) => u.yanked) : false;
    return {
      registry,
      name: info.name ?? n,
      version: info.version,
      description: info.summary,
      homepage: info.home_page || urls.Homepage || urls.homepage,
      repository: normalizeRepoUrl(urls.Source ?? urls.Repository ?? urls["Source Code"] ?? urls.Code ?? info.home_page),
      documentation: info.docs_url || urls.Documentation || urls.documentation,
      license: info.license || undefined,
      ...(yanked ? { deprecated: "every file for this release is yanked" } : {}),
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
    downloads: typeof c.downloads === "number" ? c.downloads : undefined,
    publishedAt: c.updated_at,
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
 */
export async function resolvePackage(name: string, opts: { registry?: RegistryKind; version?: string } = {}): Promise<PackageFacts | undefined> {
  const order: RegistryKind[] = opts.registry ? [opts.registry] : ["npm", "pypi", "crates"];
  for (const r of order) {
    const found = await lookupPackage(r, name, opts.version);
    if (found) return found;
  }
  return undefined;
}
