// Will `skills add owner/repo` install something that WORKS?
//
// The installer early-returns the moment it sees a SKILL.md at the repository
// ROOT, and then installs that file ALONE — the sibling scripts/ and
// references/ are dropped. A skill is only bundled whole when its SKILL.md
// lives in a SUBDIRECTORY. So the single most important assertion here is about
// where a file is, which no test of the skill's behaviour would ever catch: the
// repo works perfectly, and what users install is a lone markdown file
// describing an engine that is not there.
//
// The rest is docs↔CLI drift. A skill tells its agent that `--help` is the full
// surface; that is a promise about two artifacts staying in step, and it is
// exactly the kind that rots. Of the three skills in this family, one had the
// gate and two had lost it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { documentedFlags, helpCoversFlag } from "../cli-kit.js";
import type { SkillConfig } from "./config.js";

/**
 * Claude Code matches skill descriptions at <= 1024 characters. 1000 leaves
 * headroom so a later edit cannot silently cross the cap — a description that
 * is one character too long is not truncated, it stops matching.
 */
export const DESC_MAX = 1000;

export interface BundleCheck {
  ok: boolean;
  message: string;
}

/** What the caller must supply about the BUILT CLI, read from its own artifact. */
export interface CliSurface {
  help: string;
  valueFlags: readonly string[];
  boolFlags: readonly string[];
  commands?: readonly string[];
}

/**
 * Audit a skill repository's packaging.
 *
 * Returns one entry per assertion, passing and failing alike. Printing the
 * passes is deliberate: a gate that only speaks when it is angry gives no
 * signal that it is still watching the right things, and this one has silently
 * stopped watching before.
 */
export function auditSkillBundle(root: string, config: SkillConfig, cli?: CliSurface): BundleCheck[] {
  const out: BundleCheck[] = [];
  const check = (ok: boolean, message: string) => out.push({ ok, message });

  const name = config.name;
  const skillDir = join(root, "skills", name);

  // 1. The one that matters most, and that nothing else could catch.
  check(
    !existsSync(join(root, "SKILL.md")),
    existsSync(join(root, "SKILL.md"))
      ? `a SKILL.md exists at the repo ROOT — \`skills add\` would install it alone, dropping the engine. Move it to skills/${name}/SKILL.md`
      : "no root SKILL.md",
  );

  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) {
    check(false, `missing skills/${name}/SKILL.md — the skill package has no SKILL.md`);
    return out;
  }

  const raw = readFileSync(skillMd, "utf8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!fm) {
    check(false, `skills/${name}/SKILL.md has no frontmatter block`);
    return out;
  }
  check(true, "packaged SKILL.md present with frontmatter");

  const front = fm[1] as string;
  const declared = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  check(
    declared === name,
    declared === name ? `frontmatter name "${name}" matches the config` : `frontmatter name "${declared ?? ""}" != skill.json name "${name}"`,
  );

  const desc = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim();
  if (!desc) {
    check(false, "frontmatter has no description");
  } else {
    const len = desc.replace(/^["']|["']$/g, "").length;
    check(
      len <= DESC_MAX,
      len <= DESC_MAX ? `description ${len} chars (<= ${DESC_MAX})` : `description ${len} chars exceeds the ${DESC_MAX}-char headroom cap`,
    );
  }

  // 2. references/ ⇄ SKILL.md, in both directions. A reference nobody links is
  // a reference nobody reads; a link to a missing file is a broken promise
  // shipped to every install.
  const refsDir = join(skillDir, "references");
  if (existsSync(refsDir)) {
    const files = readdirSync(refsDir).filter((f) => f.endsWith(".md"));
    for (const m of new Set(raw.match(/references\/[\w.-]+\.md/g) ?? [])) {
      check(
        existsSync(join(skillDir, m)),
        existsSync(join(skillDir, m)) ? `mentioned ${m} exists` : `${m} is mentioned in SKILL.md but missing from the package`,
      );
    }
    for (const f of files) {
      check(
        raw.includes(`references/${f}`),
        raw.includes(`references/${f}`) ? `references/${f} is linked` : `references/${f} exists but SKILL.md never mentions it`,
      );
    }
  }

  // 3. The embedded engine is byte-identical to the tested one. A packaged copy
  // that has drifted means users run code no test in this repo ever saw.
  const bundleRel = `scripts/${name}.mjs`;
  const rootBundle = join(root, bundleRel);
  const pkgBundle = join(skillDir, bundleRel);
  if (!existsSync(rootBundle)) check(false, `missing ${bundleRel} at the repo root — run the build`);
  else if (!existsSync(pkgBundle)) check(false, `missing skills/${name}/${bundleRel} — run \`skill copy\``);
  else {
    const same = readFileSync(rootBundle).equals(readFileSync(pkgBundle));
    check(
      same,
      same ? `embedded engine is byte-identical to ${bundleRel}` : `skills/${name}/${bundleRel} differs from ${bundleRel} — run \`skill copy\` and commit`,
    );
  }

  if (!cli) return out;

  // 4. Docs ⊆ CLI. A documented flag the engine rejects is a doc bug, and the
  // reader who tries it gets an error from an example that was supposed to work.
  const universe = new Set([...cli.valueFlags, ...cli.boolFlags, "help", "version", ...config.allowedForeignFlags]);
  const docs: [string, string][] = [["SKILL.md", raw]];
  if (existsSync(refsDir)) {
    for (const f of readdirSync(refsDir).filter((f) => f.endsWith(".md"))) docs.push([`references/${f}`, readFileSync(join(refsDir, f), "utf8")]);
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

  // 5. CLI ⊆ --help, using the same matcher the source-layer twin uses.
  const missing = [...cli.valueFlags, ...cli.boolFlags].filter((f) => !helpCoversFlag(cli.help, f));
  check(missing.length === 0, missing.length === 0 ? "--help covers the whole flag surface" : `--help omits: ${missing.map((f) => `--${f}`).join(", ")}`);

  // 6. And every command, for the same reason: one stayed invisible for four
  // releases because HELP and the dispatch table were never compared.
  for (const cmd of cli.commands ?? []) {
    const named = new RegExp(`^\\s+${name} ${cmd}\\b`, "m").test(cli.help);
    check(named, named ? `--help documents \`${name} ${cmd}\`` : `--help never names the \`${cmd}\` command`);
  }

  return out;
}
