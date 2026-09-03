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

function jsonObjectAt(text: string, open: number): Record<string, unknown> | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        const parsed = JSON.parse(text.slice(open, i + 1));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function npmTimeFromTail(text: string, version: string): string | undefined {
  const key = /"time"\s*:\s*\{/g;
  let publishedAt: string | undefined;
  for (let match = key.exec(text); match; match = key.exec(text)) {
    const time = jsonObjectAt(text, text.indexOf("{", match.index));
    if (typeof time?.[version] === "string") publishedAt = time[version] as string;
  }
  return publishedAt;
}

async function npmPublishedAt(packageUrl: string, version: string | undefined): Promise<string | undefined> {
  if (!version) return undefined;
  const tail = await httpGet(packageUrl, {
    ...reqOpts(),
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
