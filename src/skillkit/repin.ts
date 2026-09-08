/** Shared maintenance commands. GitHub access is confined to the development CLI. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareTags, type SkillConfig } from "./config.js";
import { checkPins, vendorEngine, type PinFile } from "./vendor.js";

export interface Release {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
}
export function latestStable(releases: Release[]): string {
  const tags = releases.filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name)).map((r) => r.tag_name);
  tags.sort((a, b) => compareTags(b, a));
  if (!tags[0]) throw new Error("No stable engine release found");
  return tags[0];
}

export function githubJson(path: string, pages = false): unknown {
  return JSON.parse(execFileSync("gh", ["api", path, ...(pages ? ["--paginate", "--slurp"] : [])], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}
export function releaseCommit(repo: string, tag: string): string {
  const result = githubJson(`repos/${repo}/commits/${tag}`) as { sha?: string };
  if (!result.sha || !/^[a-f0-9]{40}$/.test(result.sha)) throw new Error(`Invalid commit for ${repo}@${tag}`);
  return result.sha;
}
function latest(repo: string): string {
  return latestStable((githubJson(`repos/${repo}/releases?per_page=100`, true) as Release[][]).flat());
}
export async function fetchEngineFile(url: string): Promise<Buffer | undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) return undefined;
  return Buffer.from(await response.arrayBuffer());
}

/** Update all runtime pins plus the exact, development-only maintenance tool. */
export async function repinSkill(root: string, config: SkillConfig): Promise<string[]> {
  const bad = checkPins(root, config).filter((s) => !s.ok);
  if (bad.length) throw new Error(bad.flatMap((s) => s.problems).join("\n"));
  const changes: string[] = [];
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  for (const [name, engine] of Object.entries(config.engines)) {
    const pin = JSON.parse(readFileSync(join(root, config.vendorDir, engine.meta), "utf8")) as PinFile;
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
  // The development CLI follows stable releases independently of the pinned workflow shell.
  const toolTag = latest("maxgfr/webindex");
  const toolCommit = releaseCommit("maxgfr/webindex", toolTag);
  const toolUrl = `https://codeload.github.com/maxgfr/webindex/tar.gz/${toolCommit}`;
  const oldTool = pkg.devDependencies?.["@maxgfr/webindex"];
  if (oldTool !== toolUrl) {
    const installed = JSON.parse(readFileSync(join(root, "node_modules/@maxgfr/webindex/package.json"), "utf8"));
    if (compareTags(toolTag, `v${installed.version}`) < 0) throw new Error("Refusing maintenance-tool downgrade");
    pkg.devDependencies = { ...pkg.devDependencies, "@maxgfr/webindex": toolUrl };
    // GITHUB_TOKEN cannot push workflow-definition changes. The reusable shell
    // is pinned separately and only maintainers advance that reviewed reference.
    changes.push(`skillkit -> ${toolTag} (${toolCommit})`);
  }
  if (changes.length) writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return changes;
}
