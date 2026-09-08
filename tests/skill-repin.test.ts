import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { githubRepoForRemote } from "../src/skillkit/finish.js";
import { latestStable, repinSkill } from "../src/skillkit/repin.js";
import { preserves } from "../src/skillkit/recall.js";
import { vendorEngine, checkPins } from "../src/skillkit/vendor.js";
import { auditEngineUsage } from "../src/skillkit/usage.js";
import { readSkillConfig } from "../src/skillkit/config.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skill-repin-"));
  roots.push(root);
  writeFileSync(
    join(root, "skill.json"),
    JSON.stringify({ name: "consumer", engines: { codeindex: { repo: "maxgfr/codeindex", minRef: "v2.0.0", meta: "engine.meta.json" } } }),
  );
  const config = readSkillConfig(root).config!;
  mkdirSync(join(root, "src/vendor"), { recursive: true });
  return { root, config };
}
it("selects numeric stable releases regardless of API ordering and ignores asset tags", () => {
  expect(
    latestStable([
      { tag_name: "embed-model-v1" },
      { tag_name: "v2.9.9" },
      { tag_name: "v2.11.0", prerelease: true },
      { tag_name: "v3.0.0", draft: true },
      { tag_name: "v2.10.0" },
    ]),
  ).toBe("v2.10.0");
});
it("refuses an empty stable release set", () => {
  expect(() => latestStable([{ tag_name: "v2.0.0-rc.1" }])).toThrow();
});
it("does not overwrite any installed file on download failure or version mismatch", async () => {
  const { root, config } = fixture();
  const path = join(root, "src/vendor/codeindex-engine.mjs");
  writeFileSync(path, "original");
  const failed = await vendorEngine(root, config, "codeindex", "v2.1.0", async (url) =>
    url.endsWith("engine.mjs") ? Buffer.from('const ENGINE_VERSION = "2.1.0";') : undefined,
  );
  expect(failed.written).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("original");
  const mismatch = await vendorEngine(root, config, "codeindex", "v2.1.0", async () => Buffer.from('const ENGINE_VERSION = "2.0.0";'));
  expect(mismatch.written).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("original");
});
it("fetches all files by immutable commit and refuses moved tags and downgrades", async () => {
  const { root, config } = fixture();
  const commit = "a".repeat(40);
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    return Buffer.from(url.endsWith("engine.mjs") ? 'const ENGINE_VERSION = "2.1.0";' : "export {};");
  };
  expect((await vendorEngine(root, config, "codeindex", "v2.1.0", fetcher, commit)).errors).toEqual([]);
  expect(urls.every((url) => url.includes(`/${commit}/`))).toBe(true);
  expect(checkPins(root, config)[0]?.ok).toBe(true);
  expect((await vendorEngine(root, config, "codeindex", "v2.0.0", fetcher, commit)).errors.join()).toContain("downgrade");
  expect((await vendorEngine(root, config, "codeindex", "v2.1.0", fetcher, "b".repeat(40))).errors.join()).toContain("moved");
});
it("detects a version lie even when the metadata hashes match", async () => {
  const { root, config } = fixture();
  await vendorEngine(root, config, "codeindex", "v2.1.0", async (url) =>
    Buffer.from(url.endsWith("engine.mjs") ? 'const ENGINE_VERSION = "2.1.0";' : "export {};"),
  );
  const path = join(root, "src/vendor/engine.meta.json");
  const meta = JSON.parse(readFileSync(path, "utf8"));
  meta.tag = "v2.2.0";
  meta.engineVersion = "2.2.0";
  writeFileSync(path, JSON.stringify(meta));
  expect(checkPins(root, config)[0]?.ok).toBe(false);
});
it("rejects same-size substitutions, lost evidence and duplicate compensation", () => {
  const p = { paths: [] };
  expect(preserves([{ id: "A" }], [{ id: "B" }], p)).toBe(false);
  expect(preserves([{ id: "A", source: { file: "x.ts", line: 4 } }], [{ id: "A", source: { file: "y.ts", line: 4 } }], p)).toBe(false);
  expect(preserves(["A", "A"], ["A", "B"], p)).toBe(false);
});
it("allows new evidence, reordered members and explicit per-case metric improvements", () => {
  expect(
    preserves(
      [{ id: "A" }, { id: "A", file: "x" }],
      [
        { id: "A", file: "x" },
        { id: "A", file: "y" },
      ],
      { paths: [] },
    ),
  ).toBe(true);
  expect(
    preserves(
      [
        { case: "a", sites: 3 },
        { case: "b", sites: 3 },
      ],
      [
        { case: "a", sites: 2 },
        { case: "b", sites: 4 },
      ],
      { paths: [], growing: ["sites"] },
    ),
  ).toBe(false);
  expect(preserves({ version: "1", sites: 3 }, { version: "2", sites: 4 }, { paths: [], ignoreKeys: ["version"], growing: ["sites"] })).toBe(true);
});

it("verifies CodeIndex lazy module version assignments", async () => {
  const { root, config } = fixture();
  const result = await vendorEngine(
    root,
    config,
    "codeindex",
    "v2.30.0",
    async (url) => Buffer.from(url.endsWith("engine.mjs") ? 'var ENGINE_VERSION;\nfunction init() {\n  ENGINE_VERSION = "2.30.0";\n}\ninit();' : "export {};"),
    "a".repeat(40),
  );
  expect(result.errors).toEqual([]);
  expect(checkPins(root, config)[0]?.ok).toBe(true);
});

it("attributes overlapping names to the engine actually imported", () => {
  const { root, config } = fixture();
  writeFileSync(join(root, "src/engine.ts"), 'export * from "./vendor/webindex-engine.mjs";');
  writeFileSync(join(root, "src/use.ts"), 'import { sh } from "./engine.js";\nimport { walk } from "./vendor/codeindex-engine.mjs";');
  const surface = "export { sh, walk };";
  expect(auditEngineUsage(root, config, surface, "codeindex").imported).toEqual(["walk"]);
  expect(auditEngineUsage(root, config, surface, "webindex").imported).toEqual(["sh"]);
});

it("targets the fork origin for workflow completion", () => {
  expect(githubRepoForRemote("git@github.com:maxgfr/ultra11y.git")).toBe("maxgfr/ultra11y");
  expect(githubRepoForRemote("https://github.com/maxgfr/ultra11y.git")).toBe("maxgfr/ultra11y");
  expect(githubRepoForRemote("ssh://git@github.com/maxgfr/ultra11y")).toBe("maxgfr/ultra11y");
  expect(() => githubRepoForRemote("/local/checkout")).toThrow();
});

it("updates the maintenance dependency without changing workflow definitions", async () => {
  const { root, config } = fixture();
  await vendorEngine(
    root,
    config,
    "codeindex",
    "v2.1.0",
    async (url) => Buffer.from(url.endsWith("engine.mjs") ? 'const ENGINE_VERSION = "2.1.0";' : "export {};"),
    "a".repeat(40),
  );
  mkdirSync(join(root, "node_modules/@maxgfr/webindex"), { recursive: true });
  writeFileSync(join(root, "node_modules/@maxgfr/webindex/package.json"), JSON.stringify({ version: "1.19.3" }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "@maxgfr/webindex": "old-url" } }));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  const workflow = join(root, ".github/workflows/engine-repin.yml");
  writeFileSync(workflow, "a separately reviewed immutable workflow reference");
  mkdirSync(join(root, "bin"));
  const fakeGh = join(root, "bin/gh");
  writeFileSync(
    fakeGh,
    `#!${process.execPath}\nconst path=process.argv[3]; const version=path.includes("codeindex")?"v2.1.0":"v1.19.4"; process.stdout.write(JSON.stringify(path.includes("/releases")?[[{tag_name:version}]]:{sha:"${"b".repeat(40)}"}));\n`,
  );
  chmodSync(fakeGh, 0o755);
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${join(root, "bin")}:${priorPath}`;
    await repinSkill(root, config);
  } finally {
    process.env.PATH = priorPath;
  }
  expect(readFileSync(workflow, "utf8")).toBe("a separately reviewed immutable workflow reference");
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["@maxgfr/webindex"]).toBe(
    `https://codeload.github.com/maxgfr/webindex/tar.gz/${"b".repeat(40)}`,
  );
});
