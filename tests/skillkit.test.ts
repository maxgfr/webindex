import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetNoWrite, setNoWrite, takeArtifacts } from "../src/no-write.js";
import {
  auditEngineUsage,
  auditSkillBundle,
  checkPins,
  compareTags,
  engineExports,
  readSkillConfig,
  scaffoldSkill,
  sha256,
  vendorEngine,
} from "../src/skillkit/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "webindex-skillkit-"));
  resetNoWrite();
});
afterEach(() => {
  resetNoWrite();
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const CONFIG = {
  name: "reader",
  engines: { webindex: { repo: "maxgfr/webindex", minRef: "v1.15.0", meta: "webindex.meta.json" } },
  usageFloor: 2,
  forks: {},
  allowedForeignFlags: ["profile"],
};

const config = (over: Record<string, unknown> = {}) => {
  write("skill.json", JSON.stringify({ ...CONFIG, ...over }));
  const { config, errors } = readSkillConfig(root);
  if (!config) throw new Error(`unusable config: ${errors.join(" ")}`);
  return config;
};

describe("compareTags", () => {
  it("compares numerically, so v1.10.0 is newer than v1.9.0", () => {
    // A string compare gets this backwards, which silently disarms the
    // staleness gate at exactly the release where it starts to matter.
    expect(compareTags("v1.10.0", "v1.9.0")).toBeGreaterThan(0);
    expect(compareTags("v1.9.0", "v1.10.0")).toBeLessThan(0);
    expect(compareTags("v1.2.3", "1.2.3")).toBe(0);
  });
});

describe("skill.json", () => {
  it("reads a valid config, defaulting the vendor dir", () => {
    expect(config()).toMatchObject({ name: "reader", vendorDir: join("src", "vendor"), usageFloor: 2 });
  });

  it("gives each engine the default file pair, named after it", () => {
    expect(config().engines.webindex?.files).toEqual([
      { remote: "scripts/engine.mjs", local: "webindex-engine.mjs" },
      { remote: "scripts/engine.d.mts", local: "webindex-engine.d.mts" },
    ]);
  });

  it("reports every problem at once, rather than one run per mistake", () => {
    write("skill.json", JSON.stringify({ engines: { a: { repo: "nope", minRef: "1.0" } }, usageFloor: -1 }));
    const { config, errors } = readSkillConfig(root);
    expect(config).toBeUndefined();
    expect(errors.length).toBeGreaterThan(1);
  });

  it("refuses a floor that is not a number rather than defaulting it to zero", () => {
    // Defaulting would turn the gate off silently, which is the exact failure
    // the ratchet exists to prevent.
    write("skill.json", JSON.stringify({ ...CONFIG, usageFloor: "lots" }));
    expect(readSkillConfig(root).errors.join(" ")).toMatch(/usageFloor/);
  });

  it("refuses a minRef that is not a tag", () => {
    write("skill.json", JSON.stringify({ ...CONFIG, engines: { w: { repo: "a/b", minRef: "latest", meta: "m.json" } } }));
    expect(readSkillConfig(root).errors.join(" ")).toMatch(/minRef/);
  });

  it("says what to run when there is no config at all", () => {
    expect(readSkillConfig(root).errors[0]).toMatch(/skill init/);
  });
});

describe("engineExports", () => {
  it("reads the surface from the declaration file's export block", () => {
    const dts = "declare function a(): void;\nexport { a, type B, c as d };\n";
    expect([...engineExports(dts)]).toEqual(["a", "B", "d"]);
  });

  it("returns nothing when there is no export block to read", () => {
    expect(engineExports("declare const x: 1;").size).toBe(0);
  });
});

describe("auditEngineUsage", () => {
  const DTS = "export { fetchAndExtract, rrf, slugify, mapLimit };";

  it("passes a tree that re-exports rather than declares", () => {
    write("src/util.ts", 'export { rrf, slugify } from "./engine.js";');
    write("src/other.ts", 'import { fetchAndExtract, mapLimit } from "./engine.js";');
    const r = auditEngineUsage(root, config(), DTS);
    expect(r.collisions).toEqual([]);
    expect(r.imported.sort()).toEqual(["fetchAndExtract", "mapLimit", "rrf", "slugify"]);
  });

  it("flags a module that DECLARES a name the engine exports", () => {
    write("src/util.ts", "export function rrf() {}\n");
    expect(auditEngineUsage(root, config(), DTS).collisions).toEqual([{ file: join("src", "util.ts"), name: "rrf" }]);
  });

  it("flags a PRIVATE re-declaration too — a shadow is a shadow", () => {
    // The `export` used to be required, which let an unexported copy sit
    // unflagged beside the vendored implementation.
    write("src/util.ts", "function slugify() {}\n");
    expect(auditEngineUsage(root, config(), DTS).collisions).toHaveLength(1);
  });

  it("tolerates a declared fork, and remembers it is owed", () => {
    write("src/util.ts", "export function rrf() {}\n");
    const c = config({ forks: { [`${join("src", "util.ts")}:rrf`]: "ours weights differently; adopt in v2" } });
    const r = auditEngineUsage(root, c, DTS);
    expect(r.collisions).toEqual([]);
    expect(r.tolerated[0]).toMatchObject({ name: "rrf" });
  });

  it("flags a fork entry that no longer matches anything", () => {
    // The list must shrink as adoption lands; an entry nobody can find hides
    // that it did.
    write("src/util.ts", 'export { rrf } from "./engine.js";');
    const c = config({ forks: { "src/util.ts:rrf": "stale" } });
    expect(auditEngineUsage(root, c, DTS).stale).toEqual(["src/util.ts:rrf"]);
  });

  it("counts a root-level shim, not only the ones in subdirectories", () => {
    // The older matcher saw `../engine.js` but not `./engine.js`, so every
    // top-level shim was invisible and the floor was met by subdirs alone.
    write("src/shim.ts", 'export { rrf } from "./engine.js";');
    write("src/deep/other.ts", 'import { slugify } from "../engine.js";');
    expect(auditEngineUsage(root, config(), DTS).imported.sort()).toEqual(["rrf", "slugify"]);
  });

  it("never looks inside the vendor tree", () => {
    write("src/vendor/webindex-engine.d.mts", "export function rrf() {}");
    expect(auditEngineUsage(root, config(), DTS).collisions).toEqual([]);
  });
});

describe("checkPins", () => {
  const pinned = (body: string, tag = "v1.15.0") => {
    write("src/vendor/webindex-engine.mjs", body);
    write("src/vendor/webindex-engine.d.mts", "export {};");
    write(
      "src/vendor/webindex.meta.json",
      JSON.stringify({
        tag,
        engineVersion: tag.slice(1),
        sha256: { "webindex-engine.mjs": sha256(body), "webindex-engine.d.mts": sha256("export {};") },
        syncedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  };

  it("passes when the bytes match the pin", () => {
    pinned('const ENGINE_VERSION = "1.15.0";');
    expect(checkPins(root, config())[0]).toMatchObject({ ok: true, tag: "v1.15.0" });
  });

  it("catches TAMPERED bytes", () => {
    pinned('const ENGINE_VERSION = "1.15.0";');
    write("src/vendor/webindex-engine.mjs", "// edited by hand");
    expect(checkPins(root, config())[0]?.problems[0]).toMatch(/DRIFT in/);
  });

  it("catches a STALE pin, which a hash check cannot", () => {
    // The bytes match their tag perfectly; the tag is simply older than the
    // source needs. Because the bundle is inlined at build time, the repo then
    // ships the old behaviour with every test green.
    pinned('const ENGINE_VERSION = "1.14.0";', "v1.14.0");
    const p = checkPins(root, config())[0];
    expect(p?.ok).toBe(false);
    expect(p?.problems[0]).toMatch(/STALE webindex pin — vendored v1\.14\.0, but this repo's source needs at least v1\.15\.0/);
  });

  it("reports tampering rather than staleness when both are true", () => {
    // "Tampered" is the actionable half; re-pinning fixes staleness anyway.
    pinned('const ENGINE_VERSION = "1.14.0";', "v1.14.0");
    write("src/vendor/webindex-engine.mjs", "// edited");
    expect(checkPins(root, config())[0]?.problems.join(" ")).not.toMatch(/STALE/);
  });

  it("says what to run when there is no pin", () => {
    expect(checkPins(root, config())[0]?.problems[0]).toMatch(/skill vendor --engine webindex --ref/);
  });

  it("catches a vendored file that has gone missing", () => {
    pinned('const ENGINE_VERSION = "1.15.0";');
    rmSync(join(root, "src/vendor/webindex-engine.d.mts"));
    expect(checkPins(root, config())[0]?.problems.join(" ")).toMatch(/is missing/);
  });
});

describe("vendorEngine", () => {
  const fetcher = (files: Record<string, string>) => async (url: string) => {
    const name = url.split("/").pop() as string;
    return files[name] === undefined ? undefined : Buffer.from(files[name] as string);
  };

  it("writes the bytes, records a hash per file and pins the tag", async () => {
    const bundle = 'const ENGINE_VERSION = "1.15.0";';
    const r = await vendorEngine(root, config(), "webindex", "v1.15.0", fetcher({ "engine.mjs": bundle, "engine.d.mts": "export {};" }));
    expect(r.errors).toEqual([]);
    expect(r.engineVersion).toBe("1.15.0");
    const meta = JSON.parse(readFileSync(join(root, "src/vendor/webindex.meta.json"), "utf8"));
    expect(meta.sha256["webindex-engine.mjs"]).toBe(sha256(bundle));
    expect(readFileSync(join(root, "src/vendor/webindex-engine.mjs"), "utf8")).toBe(bundle);
  });

  it("refuses a bundle that disagrees with the tag it is being pinned as", async () => {
    // That disagreement means the release was built from different source than
    // the tag claims, and recording it would create a lie every later check
    // would happily confirm.
    const r = await vendorEngine(root, config(), "webindex", "v1.15.0", fetcher({ "engine.mjs": 'const ENGINE_VERSION = "1.14.0";', "engine.d.mts": "x" }));
    expect(r.errors[0]).toMatch(/reports ENGINE_VERSION=1\.14\.0 but the pinned ref is v1\.15\.0/);
  });

  it("stops at a file it could not fetch", async () => {
    const r = await vendorEngine(root, config(), "webindex", "v1.15.0", fetcher({}));
    expect(r.errors[0]).toMatch(/could not fetch/);
  });

  it("names the engines it knows when asked for one it does not", async () => {
    const r = await vendorEngine(root, config(), "codeindex", "v1.0.0", fetcher({}));
    expect(r.errors[0]).toMatch(/unknown engine "codeindex" — expected one of: webindex/);
  });

  it("survives a UTF-8 bundle byte for byte", async () => {
    // Written as a Buffer rather than a decoded string: the hash has to be over
    // the bytes that were published.
    const bundle = 'const ENGINE_VERSION = "1.15.0"; // — é 👍';
    await vendorEngine(root, config(), "webindex", "v1.15.0", fetcher({ "engine.mjs": bundle, "engine.d.mts": "x" }));
    expect(readFileSync(join(root, "src/vendor/webindex-engine.mjs"), "utf8")).toBe(bundle);
    expect(checkPins(root, config())[0]?.problems.filter((p) => p.includes("DRIFT"))).toEqual([]);
  });
});

describe("auditSkillBundle", () => {
  const packaged = (over: { front?: string; body?: string } = {}) => {
    write("skills/reader/SKILL.md", `---\nname: reader\ndescription: ${over.front ?? "Use it for things."}\n---\n\n${over.body ?? "# reader"}\n`);
    write("scripts/reader.mjs", "// built");
    write("skills/reader/scripts/reader.mjs", "// built");
  };
  const fails = (checks: { ok: boolean; message: string }[]) => checks.filter((c) => !c.ok).map((c) => c.message);

  it("passes a well-shaped package", () => {
    packaged();
    expect(fails(auditSkillBundle(root, config()))).toEqual([]);
  });

  it("refuses a SKILL.md at the repo root, which would install alone", () => {
    // The assertion no behavioural test could make: the repo works perfectly
    // and what users install is a lone markdown file.
    packaged();
    write("SKILL.md", "---\nname: reader\n---\n");
    expect(fails(auditSkillBundle(root, config())).join(" ")).toMatch(/would install it alone, dropping the engine/);
  });

  it("catches a frontmatter name that has drifted from the config", () => {
    write("skills/reader/SKILL.md", "---\nname: readr\ndescription: x\n---\n");
    expect(fails(auditSkillBundle(root, config())).join(" ")).toMatch(/!= skill\.json name "reader"/);
  });

  it("catches a description past the matching cap", () => {
    packaged({ front: "x".repeat(1001) });
    expect(fails(auditSkillBundle(root, config())).join(" ")).toMatch(/exceeds the 1000-char headroom cap/);
  });

  it("catches an embedded engine that has drifted from the tested one", () => {
    packaged();
    write("skills/reader/scripts/reader.mjs", "// stale");
    expect(fails(auditSkillBundle(root, config())).join(" ")).toMatch(/differs from scripts\/reader\.mjs/);
  });

  it("catches a reference that is linked but absent, and one present but unlinked", () => {
    packaged({ body: "See references/missing.md for more." });
    write("skills/reader/references/orphan.md", "# orphan");
    const f = fails(auditSkillBundle(root, config())).join(" ");
    expect(f).toMatch(/references\/missing\.md is mentioned in SKILL\.md but missing/);
    expect(f).toMatch(/references\/orphan\.md exists but SKILL\.md never mentions it/);
  });

  it("catches a documented flag the CLI would reject", () => {
    packaged({ body: "Run it with --nonsense." });
    const f = fails(auditSkillBundle(root, config(), { help: "usage: reader --json", valueFlags: [], boolFlags: ["json"] }));
    expect(f.join(" ")).toMatch(/documents unknown flag --nonsense/);
  });

  it("allows a flag that belongs to another tool, when the config says so", () => {
    packaged({ body: "docker compose --profile semantic up" });
    expect(fails(auditSkillBundle(root, config(), { help: "usage: reader --json", valueFlags: [], boolFlags: ["json"] }))).toEqual([]);
  });

  it("catches a flag the CLI accepts but --help never names", () => {
    packaged();
    const f = fails(auditSkillBundle(root, config(), { help: "usage: reader --json", valueFlags: ["out"], boolFlags: ["json"] }));
    expect(f.join(" ")).toMatch(/--help omits: --out/);
  });

  it("catches a command --help never names", () => {
    packaged();
    const f = fails(auditSkillBundle(root, config(), { help: "  reader gather\n", valueFlags: [], boolFlags: [], commands: ["gather", "verify"] }));
    expect(f.join(" ")).toMatch(/never names the `verify` command/);
  });

  it("reports the passes too, so a silent gate is visible as one", () => {
    packaged();
    expect(auditSkillBundle(root, config()).filter((c) => c.ok).length).toBeGreaterThan(3);
  });
});

describe("scaffoldSkill", () => {
  it("writes the shape a skill repo needs", () => {
    const r = scaffoldSkill(root, "newskill");
    expect(r.errors).toEqual([]);
    expect(r.written.map((p) => p.replace(`${root}/`, "")).sort()).toEqual([
      ".github/workflows/ci.yml",
      ".gitignore",
      "skill.json",
      "skills/newskill/SKILL.md",
      "src/engine.ts",
    ]);
  });

  it("derives the env prefix from the name", () => {
    scaffoldSkill(root, "my-skill");
    expect(readFileSync(join(root, "src/engine.ts"), "utf8")).toContain('envPrefix: "MY_SKILL"');
  });

  it("emits a config this toolchain can actually read", () => {
    scaffoldSkill(root, "newskill");
    const { config, errors } = readSkillConfig(root);
    expect(errors).toEqual([]);
    expect(config?.name).toBe("newskill");
  });

  it("refuses a name that could not be a package or an env prefix", () => {
    expect(scaffoldSkill(root, "Not Valid").errors[0]).toMatch(/not a usable skill name/);
  });

  it("never overwrites, and says what it left alone", () => {
    write("skill.json", "{}");
    const r = scaffoldSkill(root, "newskill", { exists: () => true });
    expect(r.written).toEqual([]);
    expect(r.errors.join(" ")).toMatch(/already exists — left alone/);
  });

  it("writes nothing to disk under the no-write gate", () => {
    setNoWrite(true);
    const r = scaffoldSkill(root, "newskill");
    expect(r.written).toHaveLength(5);
    expect(takeArtifacts()).toHaveLength(5);
    expect(() => readFileSync(join(root, "skill.json"), "utf8")).toThrow();
  });
});
