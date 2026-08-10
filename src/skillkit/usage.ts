// Prove a skill actually uses the engine it vendors — and cannot quietly
// re-fork it.
//
// The engine was extracted precisely because the same code lived in three
// repositories. Nothing stopped it drifting back: one skill vendored a bundle
// exporting the whole MCP transport while running its own 929-line copy beside
// it, with every gate green. Counting imports would not have caught that
// either, because the copy WAS imported — just from the wrong place.
//
// So the check is a prohibition rather than a tally:
//
//   No module under src/ may DECLARE a name the engine already exports.
//
// Re-exporting is fine and expected — that is what a shim does, and it is how
// `from "./util.js"` keeps resolving after the implementation moved. DECLARING
// is the regression: a second implementation now exists in the tree, and an
// import resolves to whichever the author happened to reach for.
//
// A floor on distinct imported symbols rides along, so deleting the last use of
// a layer has to be a decision someone makes on purpose.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { SkillConfig } from "./config.js";

/**
 * `function X` / `const X` / `class X` / `interface X` / `type X =`, with or
 * without a leading `export`.
 *
 * The `export` used to be required, which let a PRIVATE copy of an engine
 * export sit in a tree unflagged — a shadow is a shadow whether or not the
 * module chose to re-export it. Anchored at column 0 under /m, so a local
 * inside a function body is not a candidate.
 *
 * Deliberately NOT `export { X } from "…"`: that is a re-export, which is the
 * whole point of a shim.
 */
const DECL = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|enum)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm;

/**
 * Both an import and an `export … from` count as use.
 *
 * An import is the tree CALLING the engine; an `export … from` is the tree
 * SERVING the engine's implementation under the path its own callers already
 * use — which is what every shim does and is the larger half. Counting only
 * imports reports a repo that successfully deleted its forks as barely using
 * the engine at all.
 *
 * `(?:\.{1,2}\/)*` and not `(?:\.\.\/)*`: the older form matched `../engine.js`
 * but not `./engine.js`, so every top-level shim was invisible to the counter
 * and the floor was met by subdirectories alone.
 */
const USES_ENGINE = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"(?:\.{1,2}\/)*engine\.js"/g;

/** The engine's public surface, read from the vendored declarations rather than hardcoded. */
export function engineExports(dts: string): Set<string> {
  const block = /export\s*\{([\s\S]*?)\}\s*;?\s*$/.exec(dts);
  if (!block) return new Set();
  return new Set(
    (block[1] as string)
      .split(",")
      .map((s) =>
        s
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop(),
      )
      .filter((s): s is string => Boolean(s)),
  );
}

/** Every `.ts` under a directory, skipping the vendor tree itself. */
export function walkSources(dir: string, skip = "vendor", out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== skip) walkSources(p, skip, out);
    } else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

export interface UsageReport {
  /** Names declared here that the engine already exports, and are not a declared fork. */
  collisions: { file: string; name: string }[];
  /** Declared forks that were found — tolerated, and still owed an adoption. */
  tolerated: { file: string; name: string; why: string }[];
  /** Fork entries that no longer match anything: stale bookkeeping. */
  stale: string[];
  /** Distinct engine symbols imported or re-exported across the tree. */
  imported: string[];
  /** Size of the engine's public surface, for context in the report line. */
  surface: number;
}

/**
 * Audit a skill tree against the engine surface it vendors.
 *
 * Returns findings; the CLI decides what is fatal. That split is deliberate —
 * this module reports what is true about the tree, and a build gate is a
 * policy on top of it.
 */
export function auditEngineUsage(root: string, config: SkillConfig, dts: string): UsageReport {
  const surface = engineExports(dts);
  const files = walkSources(join(root, "src"));
  const forks = new Map(Object.entries(config.forks));

  const collisions: UsageReport["collisions"] = [];
  const tolerated: UsageReport["tolerated"] = [];
  const imported = new Set<string>();

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const rel = relative(root, file);
    for (const m of src.matchAll(DECL)) {
      const name = m[1] ?? m[2];
      if (!name || !surface.has(name)) continue;
      const why = forks.get(`${rel}:${name}`);
      if (why) tolerated.push({ file: rel, name, why });
      else collisions.push({ file: rel, name });
    }
    for (const m of src.matchAll(USES_ENGINE)) {
      for (const raw of (m[1] as string).split(",")) {
        const name = raw
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0];
        if (name) imported.add(name);
      }
    }
  }

  // A listed fork nobody can find is stale bookkeeping: the list must shrink as
  // adoption lands, and an entry that matches nothing hides that it did.
  const seen = new Set(tolerated.map((t) => `${t.file}:${t.name}`));
  const stale = [...forks.keys()].filter((k) => !seen.has(k));

  return { collisions, tolerated, stale, imported: [...imported], surface: surface.size };
}
