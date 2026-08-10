// `skill.json` — one file per skill repo, replacing four.
//
// Every skill in this family carries roughly six hundred lines of packaging
// scripts, and the configuration they need was scattered across all of them:
// the engines table lived inside sync-engine.mjs, the fork ratchet in a sibling
// engine-forks.json, the usage floor in an env var read by
// verify-engine-usage.mjs, and the foreign-flag allowlist as a `const` in
// verify-skill-bundle.mjs. Four places, three of which are code — so changing a
// pin meant editing a script.
//
// Here it is data, in one reviewable file. The scripts become one binary that
// reads it.
//
// Everything is validated on read rather than trusted, because this file is
// what CI gates on: a typo'd key that silently defaults would turn a gate off
// without anyone noticing, which is the failure mode the ratchet exists to
// prevent in the first place.

import { join } from "node:path";
import { readJsonSafe } from "../run.js";

export const SKILL_CONFIG = "skill.json";

export interface EnginePin {
  /** `owner/name` on GitHub, where the built artifacts are fetched from. */
  repo: string;
  /**
   * The oldest release this repo's SOURCE is written against.
   *
   * Bumped in the SAME commit that deletes a local copy in favour of an engine
   * export. It exists because a hash check catches a TAMPERED vendor but not a
   * STALE one: a repo pinned three releases back passes cleanly, and since the
   * bundle is inlined at build time it then ships the old behaviour with every
   * test green, measuring the wrong code.
   */
  minRef: string;
  /** The pin file under the vendor dir. Distinct per engine so re-pinning one leaves the other alone. */
  meta: string;
  /** `{ remote, local }` pairs. Defaults to the engine bundle and its declarations. */
  files?: { remote: string; local: string }[];
}

export interface SkillConfig {
  /** The skill's name. Must match package.json and the SKILL.md frontmatter. */
  name: string;
  /** Where vendored engines land. Defaults to `src/vendor`. */
  vendorDir: string;
  engines: Record<string, EnginePin>;
  /**
   * Floor on distinct engine symbols imported across src/.
   *
   * A ratchet: raise it when a layer lands, never lower it to make a red run
   * pass. A drop means a layer stopped being used, which is a decision someone
   * has to make on purpose rather than a detail that slips through.
   */
  usageFloor: number;
  /**
   * Declarations that shadow an engine export and have NOT been adopted, with
   * why. Entries may leave, never arrive — so the next fork is an argued
   * decision rather than a quiet copy.
   */
  forks: Record<string, string>;
  /** Flags belonging to OTHER tools that the docs legitimately quote. */
  allowedForeignFlags: string[];
}

export const DEFAULT_FILES = [
  { remote: "scripts/engine.mjs", local: "{name}-engine.mjs" },
  { remote: "scripts/engine.d.mts", local: "{name}-engine.d.mts" },
];

export interface ConfigResult {
  config?: SkillConfig;
  errors: string[];
}

/**
 * Read and validate a repo's `skill.json`.
 *
 * Returns errors rather than throwing, because every caller is a CLI command
 * that wants to print all of them at once — a config with three mistakes should
 * cost one run, not three.
 */
export function readSkillConfig(root: string): ConfigResult {
  const path = join(root, SKILL_CONFIG);
  const raw = readJsonSafe<Record<string, unknown>>(path);
  if (!raw) return { errors: [`no readable ${SKILL_CONFIG} at ${path} — run \`skill init\` to scaffold one.`] };

  const errors: string[] = [];
  const name = typeof raw.name === "string" && raw.name ? raw.name : undefined;
  if (!name) errors.push(`${SKILL_CONFIG}: "name" must be a non-empty string.`);

  const engines: Record<string, EnginePin> = {};
  const rawEngines = raw.engines;
  if (!rawEngines || typeof rawEngines !== "object") {
    errors.push(`${SKILL_CONFIG}: "engines" must be an object of { repo, minRef, meta }.`);
  } else {
    for (const [key, value] of Object.entries(rawEngines as Record<string, unknown>)) {
      const e = value as Partial<EnginePin>;
      if (typeof e?.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(e.repo)) {
        errors.push(`${SKILL_CONFIG}: engines.${key}.repo must be "owner/name".`);
        continue;
      }
      if (typeof e.minRef !== "string" || !/^v\d+\.\d+\.\d+/.test(e.minRef)) {
        errors.push(`${SKILL_CONFIG}: engines.${key}.minRef must be a "vX.Y.Z" tag.`);
        continue;
      }
      const meta = typeof e.meta === "string" && e.meta ? e.meta : `${key}.meta.json`;
      const files = Array.isArray(e.files) && e.files.length ? e.files : DEFAULT_FILES.map((f) => ({ ...f, local: f.local.replace("{name}", key) }));
      engines[key] = { repo: e.repo, minRef: e.minRef, meta, files };
    }
    if (!Object.keys(engines).length && !errors.length) errors.push(`${SKILL_CONFIG}: "engines" is empty — nothing to vendor or police.`);
  }

  // A floor that is not a number is a floor that is off. Refuse rather than
  // default to 0, which would pass every run silently.
  const floor = raw.usageFloor;
  if (floor !== undefined && (typeof floor !== "number" || !Number.isInteger(floor) || floor < 0)) {
    errors.push(`${SKILL_CONFIG}: "usageFloor" must be a non-negative integer.`);
  }

  const forks = raw.forks;
  if (forks !== undefined && (typeof forks !== "object" || forks === null || Array.isArray(forks))) {
    errors.push(`${SKILL_CONFIG}: "forks" must be an object of "path:Name" -> reason.`);
  }

  const foreign = raw.allowedForeignFlags;
  if (foreign !== undefined && (!Array.isArray(foreign) || foreign.some((f) => typeof f !== "string"))) {
    errors.push(`${SKILL_CONFIG}: "allowedForeignFlags" must be an array of strings.`);
  }

  if (errors.length) return { errors };

  return {
    config: {
      name: name as string,
      vendorDir: typeof raw.vendorDir === "string" && raw.vendorDir ? raw.vendorDir : join("src", "vendor"),
      engines,
      usageFloor: typeof floor === "number" ? floor : 0,
      forks: (forks as Record<string, string>) ?? {},
      allowedForeignFlags: (foreign as string[]) ?? [],
    },
    errors: [],
  };
}

/**
 * Compare two `vX.Y.Z` tags, like a sort comparator.
 *
 * Numeric per component. A string compare puts v1.10.0 BEFORE v1.9.0, and
 * getting it backwards here silently disarms the staleness gate at exactly the
 * release where it starts to matter.
 */
export function compareTags(a: string, b: string): number {
  const parts = (t: string) =>
    String(t)
      .replace(/^v/, "")
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
