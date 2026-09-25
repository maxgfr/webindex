import { env } from "./brand.js";
import type { ForgeKind } from "./forge.js";

// Which forge a HOST is — shared by the ref parser (a GitHub path has exactly
// two segments, a GitLab one ends at `/-/`) and by the forge clients.
//
// Internal on purpose: src/index.ts re-exports forge.ts and repo.ts wholesale,
// and both need this, so it lives in a module neither of them re-exports. The
// public spelling of the question is `forgeKind` in forge.ts.

const KINDS: ReadonlySet<string> = new Set(["github", "gitlab", "gitea"]);

/** A host as a forge knows it: lower-case, and without the `www.` a browser adds. */
export function normalizeForgeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

/**
 * The hosts the user declared in `<PREFIX>_FORGE_HOSTS`, e.g.
 * `salsa.debian.org=gitlab,git.corp.example=github`.
 *
 * Read at call time, like every tunable. An entry that does not parse is
 * skipped rather than fatal — this is configuration, and one typo must not stop
 * every other host from working.
 */
export function configuredForgeHosts(): Map<string, ForgeKind> {
  const out = new Map<string, ForgeKind>();
  for (const entry of (env("FORGE_HOSTS") ?? "").split(/[\s,]+/)) {
    const eq = entry.indexOf("=");
    if (eq < 1) continue;
    const kind = entry
      .slice(eq + 1)
      .trim()
      .toLowerCase();
    if (KINDS.has(kind)) out.set(normalizeForgeHost(entry.slice(0, eq)), kind as ForgeKind);
  }
  return out;
}

/**
 * The forge a host speaks: a declared host first, then the host's own shape.
 *
 * The shape is a routing guess and nothing more. It decides which API layout to
 * ASK, which is harmless on a host that turns out to be something else; it never
 * decides where a token goes — see `tokenHostAllowed` in forge.ts.
 */
export function hostForgeKind(host: string): ForgeKind | undefined {
  const h = normalizeForgeHost(host);
  const declared = configuredForgeHosts().get(h);
  if (declared) return declared;
  if (h === "github.com" || h.endsWith(".github.com") || h.startsWith("github.")) return "github";
  if (h === "gitlab.com" || h.includes("gitlab")) return "gitlab";
  if (h.includes("gitea") || h.includes("codeberg")) return "gitea";
  return undefined;
}
