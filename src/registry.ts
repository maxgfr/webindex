import { contactUa, httpJson } from "./fetch.js";

// Package registries: a library's NAME resolved to its actual coordinates.
//
// This existed nowhere — not in the engine, and not in either consumer that
// needed it. One skill's SKILL.md pushes "with only a name, find the canonical
// repo URL" onto the model and hopes; the other searches the web for
// "<tech> official documentation" and reads whatever ranks. Both are guesses at
// something the registry states outright, and both are how a tool ends up
// documenting a fork, an abandoned mirror, or a name-squatted package.
//
// A registry lookup is one keyless request that answers repository, homepage,
// documentation, current version, licence and — the one nothing else surfaces —
// whether the package is DEPRECATED.

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
  const r = await httpJson("GET", REGISTRY_URL[registry](n), undefined, reqOpts());
  if (!r.ok || !r.data || typeof r.data !== "object") return undefined;
  const d = r.data as Record<string, any>;

  if (registry === "npm") {
    const latest = version ?? d["dist-tags"]?.latest;
    const v = (latest && d.versions?.[latest]) || {};
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
      publishedAt: latest ? d.time?.[latest] : undefined,
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
 * so trying it first resolves most lookups in one request. An explicit
 * `registry` skips the guessing entirely, which a caller who knows the ecosystem
 * should always do.
 */
export async function resolvePackage(name: string, opts: { registry?: RegistryKind; version?: string } = {}): Promise<PackageFacts | undefined> {
  const order: RegistryKind[] = opts.registry ? [opts.registry] : ["npm", "pypi", "crates"];
  for (const r of order) {
    const found = await lookupPackage(r, name, opts.version);
    if (found) return found;
  }
  return undefined;
}
