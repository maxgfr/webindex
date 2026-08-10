import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envName } from "../src/brand.js";
import { ensureDir, isNoWrite, resetNoWrite, setNoWrite, takeArtifacts, writeArtifact, writeFileAtomic } from "../src/no-write.js";

// Purpose-written rather than ported: upstream this module is covered through
// the CLI and the MCP handlers, neither of which lives in the engine. What the
// engine has to guarantee is narrower and worth pinning directly — under the
// gate, nothing reaches the filesystem, and the caller still gets a path back.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webindex-nowrite-"));
  resetNoWrite();
});

afterEach(() => {
  resetNoWrite();
  rmSync(dir, { recursive: true, force: true });
});

describe("the gate", () => {
  it("is off by default", () => {
    expect(isNoWrite()).toBe(false);
  });

  it("can be set by the caller", () => {
    setNoWrite(true);
    expect(isNoWrite()).toBe(true);
  });

  it("can be set by the environment, which is the only lever an MCP host has", () => {
    process.env[envName("NO_WRITE")] = "1";
    expect(isNoWrite()).toBe(true);
  });

  it("reads through the configured brand prefix", () => {
    // The point of the whole exercise: three skills, three prefixes, one engine.
    process.env.WEBINDEX_NO_WRITE = "1";
    expect(isNoWrite()).toBe(false);
    delete process.env.WEBINDEX_NO_WRITE;
  });
});

describe("writeArtifact", () => {
  it("writes to disk when the gate is open", () => {
    const p = join(dir, "REPORT.md");
    expect(writeArtifact(p, "hello")).toBe(p);
    expect(readFileSync(p, "utf8")).toBe("hello");
    expect(takeArtifacts()).toEqual([]);
  });

  it("collects instead of writing when the gate is closed", () => {
    setNoWrite(true);
    const p = join(dir, "REPORT.md");
    expect(writeArtifact(p, "hello")).toBe(p); // caller shape is unchanged
    expect(existsSync(p)).toBe(false); // but nothing reached the disk
    expect(takeArtifacts()).toEqual([{ path: p, content: "hello" }]);
  });

  it("lets the last write win, as a real filesystem would", () => {
    // An enrich step rewrites a document a gather already produced; a stale
    // copy in the stream would contradict the fresh one.
    setNoWrite(true);
    const p = join(dir, "DOSSIER.md");
    writeArtifact(p, "first");
    writeArtifact(p, "second");
    expect(takeArtifacts()).toEqual([{ path: p, content: "second" }]);
  });

  it("drains, so a second take returns nothing", () => {
    setNoWrite(true);
    writeArtifact(join(dir, "a.md"), "a");
    expect(takeArtifacts()).toHaveLength(1);
    expect(takeArtifacts()).toEqual([]);
  });
});

describe("writeFileAtomic", () => {
  it("leaves no temp file behind on success", () => {
    // A stray sibling .tmp is not cosmetic: a run directory is read back by an
    // agent and by the next command, and both enumerate it.
    const p = join(dir, "manifest.json");
    writeFileAtomic(p, "{}");
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
  });

  it("replaces existing content rather than appending to it", () => {
    const p = join(dir, "index.json");
    writeFileAtomic(p, "old and longer");
    writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
  });

  it("cleans up its temp file when the rename cannot happen", () => {
    // Renaming onto a DIRECTORY fails on every platform, which is the cheapest
    // way to reach the failure path without stubbing node:fs.
    const target = join(dir, "occupied");
    ensureDir(target);
    expect(() => writeFileAtomic(target, "x")).toThrow();
    expect(readdirSync(dir)).toEqual(["occupied"]);
  });

  it("is what writeArtifact uses, so every artifact is torn-read-proof", () => {
    const p = join(dir, "REPORT.md");
    writeArtifact(p, "body");
    expect(readFileSync(p, "utf8")).toBe("body");
    expect(readdirSync(dir)).toEqual(["REPORT.md"]);
  });
});

describe("ensureDir", () => {
  it("creates the directory when the gate is open", () => {
    const d = join(dir, "nested", "deep");
    ensureDir(d);
    expect(existsSync(d)).toBe(true);
  });

  it("creates nothing when the gate is closed", () => {
    setNoWrite(true);
    const d = join(dir, "nested", "deep");
    ensureDir(d);
    expect(existsSync(d)).toBe(false);
  });
});

describe("resetNoWrite", () => {
  it("clears both the switch and anything collected under it", () => {
    setNoWrite(true);
    writeArtifact(join(dir, "a.md"), "a");
    resetNoWrite();
    expect(isNoWrite()).toBe(false);
    expect(takeArtifacts()).toEqual([]);
  });
});
