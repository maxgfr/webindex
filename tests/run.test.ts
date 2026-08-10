import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetNoWrite, setNoWrite, takeArtifacts } from "../src/no-write.js";
import { readJsonSafe, readManifest, runId, shq, writeManifest } from "../src/run.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webindex-run-"));
  resetNoWrite();
});

afterEach(() => {
  resetNoWrite();
  rmSync(dir, { recursive: true, force: true });
});

describe("runId", () => {
  it("stamps local time, zero-padded", () => {
    // 3 March 2024, 04:05:06 local — every component needs its pad.
    expect(runId(new Date(2024, 2, 3, 4, 5, 6))).toBe("run-20240303-040506");
  });

  it("sorts lexicographically in chronological order", () => {
    // What makes `ls` order runs correctly for free. September before October
    // is the pair a missing month pad gets backwards.
    const sep = runId(new Date(2024, 8, 1, 0, 0, 0));
    const oct = runId(new Date(2024, 9, 1, 0, 0, 0));
    expect([oct, sep].sort()).toEqual([sep, oct]);
  });
});

describe("shq", () => {
  it("leaves every shell metacharacter literal", () => {
    // Single quotes are the only POSIX context with zero expansion — this is
    // the whole reason the function exists rather than a backslash escape.
    expect(shq("a$b`c`|d;e&&f")).toBe("'a$b`c`|d;e&&f'");
  });

  it("closes and reopens around an embedded single quote", () => {
    expect(shq("it's")).toBe(`'it'"'"'s'`);
  });

  it("collapses newlines so an emitted command stays one line", () => {
    // A runbook is copy-pasted; a command that wraps gets pasted half-executed.
    expect(shq("two\nlines")).toBe("'two lines'");
    expect(shq("crlf\r\nlines")).toBe("'crlf lines'");
  });

  it("survives a question that is entirely quotes", () => {
    expect(shq("'''")).toBe(`''"'"''"'"''"'"''`);
  });
});

describe("readJsonSafe", () => {
  it("parses a readable file", () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, '{"a":1}');
    expect(readJsonSafe<{ a: number }>(p)).toEqual({ a: 1 });
  });

  it("collapses absent and malformed onto the same answer", () => {
    // Both mean "this worklist is not ready" to every caller, and a hard error
    // on the malformed one would strand a run the prerequisite can regenerate.
    const bad = join(dir, "half-written.json");
    writeFileSync(bad, '{"pairs":[');
    expect(readJsonSafe(bad)).toBeUndefined();
    expect(readJsonSafe(join(dir, "absent.json"))).toBeUndefined();
  });

  it("does not throw on a directory", () => {
    expect(readJsonSafe(dir)).toBeUndefined();
  });
});

describe("the manifest", () => {
  it("round-trips through the default filename", () => {
    writeManifest(dir, { question: "why", sources: 3 });
    expect(readManifest<{ question: string; sources: number }>(dir)).toEqual({ question: "why", sources: 3 });
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  });

  it("honours a caller's filename", () => {
    writeManifest(dir, { cells: [] }, "drill-plan.json");
    expect(readManifest(dir, "drill-plan.json")).toEqual({ cells: [] });
    expect(readManifest(dir)).toBeUndefined();
  });

  it("writes indented JSON with a trailing newline", () => {
    // These files land in diffs and in agent context; a one-line blob is
    // unreviewable and a missing newline makes every rewrite a two-line change.
    writeManifest(dir, { a: 1 });
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe('{\n  "a": 1\n}\n');
  });

  it("passes through the no-write gate", () => {
    setNoWrite(true);
    const p = writeManifest(dir, { a: 1 });
    expect(existsSync(p)).toBe(false);
    expect(takeArtifacts()).toEqual([{ path: join(dir, "manifest.json"), content: '{\n  "a": 1\n}\n' }]);
  });

  it("reads back undefined when a run has none", () => {
    expect(readManifest(dir)).toBeUndefined();
  });
});
