import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let binary: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "webindex-mcp-process-"));
  binary = join(dir, "webindex.mjs");
  await build({
    config: false,
    entry: { webindex: resolve("src/cli.ts") },
    outDir: dir,
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    bundle: true,
    splitting: false,
    dts: false,
    target: "node18",
    platform: "node",
    silent: true,
  });
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("MCP process survival", () => {
  it.each(["missing.txt", "."])("answers an unreadable local path (%s) and keeps serving", (path) => {
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "webindex_extract", arguments: { path: join(dir, path) } } },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ];
    const child = spawnSync(process.execPath, [binary, "mcp"], {
      input: frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, WEBINDEX_CACHE_DIR: dir, WEBINDEX_NO_NPX: "1" },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const responses = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(responses).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 1, result: expect.objectContaining({ isError: true }) }), { jsonrpc: "2.0", id: 2, result: {} }]),
    );
    expect(responses).toHaveLength(2);
  });
});
