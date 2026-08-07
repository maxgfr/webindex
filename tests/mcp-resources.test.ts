import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { listResources, readResource, resolveSkillRoot, ResourceError, skillName } from "../src/mcp/resources.js";

// webindex ships no SKILL.md of its own — it is an engine, not a skill — so the
// payload these cases serve is a synthetic one under tests/fixtures. That is the
// right shape anyway: what is under test is the RESOLUTION and the containment,
// neither of which should depend on any particular skill's documentation.
const PAYLOAD = resolve(__dirname, "fixtures", "skill-payload");
const PAYLOAD_MODULE_DIR = join(PAYLOAD, "scripts");

const temps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "webindex-res-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("skill root resolution", () => {
  // The three layouts this same code runs from. Each is a real directory shape,
  // not a mock: the failure this guards against is a bundle that finds its
  // documentation in the repo and not once installed.
  it("finds the payload from an installed skill (<payload>/scripts/x.mjs)", () => {
    const root = tmp();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "# skill\n\nBody.\n");
    expect(resolveSkillRoot(join(root, "scripts"))).toBe(root);
  });

  it("finds the payload from a repo-root bundle (<repo>/scripts/x.mjs)", () => {
    const repo = tmp();
    const payload = join(repo, "skills", skillName());
    mkdirSync(join(repo, "scripts"), { recursive: true });
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, "SKILL.md"), "# skill\n\nBody.\n");
    expect(resolveSkillRoot(join(repo, "scripts"))).toBe(payload);
  });

  it("finds the payload from the source tree (<repo>/src/mcp/)", () => {
    // The layout the suite itself runs as in a consuming skill: the module sits
    // two levels down from the repo root, and the payload is beside it under
    // skills/<brand name>/.
    const repo = tmp();
    const payload = join(repo, "skills", skillName());
    mkdirSync(join(repo, "src", "mcp"), { recursive: true });
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, "SKILL.md"), "# skill\n\nBody.\n");
    expect(resolveSkillRoot(join(repo, "src", "mcp"))).toBe(payload);
  });

  it("returns undefined rather than throwing when there is no payload", () => {
    expect(resolveSkillRoot(join(tmp(), "scripts"))).toBeUndefined();
  });
});

describe("resources/list", () => {
  it("serves SKILL.md plus every reference the skill actually ships", () => {
    const uris = listResources(PAYLOAD_MODULE_DIR).map((r) => r.uri);
    expect(uris[0]).toBe("skill://SKILL.md");
    expect(uris).toContain("skill://references/citation-format.md");
    // Sorted and unique, so a client's list is stable across calls.
    expect(new Set(uris).size).toBe(uris.length);
    expect(uris.slice(1)).toEqual([...uris.slice(1)].sort());
  });

  it("describes each resource with prose from the file, not its title repeated", () => {
    for (const r of listResources(PAYLOAD_MODULE_DIR)) {
      expect(r.mimeType, r.uri).toBe("text/markdown");
      expect(r.title, r.uri).toBeTruthy();
      expect(r.description, r.uri).toBeTruthy();
      expect(r.description!.startsWith("#"), r.uri).toBe(false);
      expect(r.description!.length, r.uri).toBeLessThanOrEqual(300);
    }
  });

  it("is empty, not fatal, when the payload is missing", () => {
    // A skill installed without its documentation must still serve its tools.
    expect(listResources(join(tmp(), "scripts"))).toEqual([]);
  });
});

describe("resources/read", () => {
  it("returns the real file off disk", () => {
    const got = readResource("skill://SKILL.md", PAYLOAD_MODULE_DIR);
    expect(got.mimeType).toBe("text/markdown");
    expect(got.text).toContain("probe");
    expect(got.text.length).toBeGreaterThan(300);
  });

  it("reads a reference by its listed uri", () => {
    for (const decl of listResources(PAYLOAD_MODULE_DIR)) {
      expect(readResource(decl.uri, PAYLOAD_MODULE_DIR).text.length, decl.uri).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown scheme", () => {
    expect(() => readResource("file:///etc/passwd", PAYLOAD_MODULE_DIR)).toThrow(ResourceError);
  });

  it("rejects traversal out of the skill root", () => {
    expect(() => readResource("skill://../../package.json", PAYLOAD_MODULE_DIR)).toThrow(/escapes the skill root|no such resource/);
  });

  it("rejects a symlink that points out of the skill root", () => {
    // Normalising the path string is not enough: this one only escapes once
    // the filesystem resolves it, which is why containment is checked on the
    // realpath. Relevant because this server can be reached over HTTP.
    const root = tmp();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "# skill\n\nBody.\n");
    const secret = join(tmp(), "secret.md");
    writeFileSync(secret, "top secret");
    symlinkSync(secret, join(root, "escape.md"));

    expect(() => readResource("skill://escape.md", join(root, "scripts"))).toThrow(/escapes the skill root/);
  });

  it("rejects a directory and a file that is not there", () => {
    expect(() => readResource("skill://references", PAYLOAD_MODULE_DIR)).toThrow(/not a file/);
    expect(() => readResource("skill://references/nope.md", PAYLOAD_MODULE_DIR)).toThrow(/no such resource/);
  });

  it("explains itself when there is no payload at all", () => {
    expect(() => readResource("skill://SKILL.md", join(tmp(), "scripts"))).toThrow(/no skill payload/);
  });
});
