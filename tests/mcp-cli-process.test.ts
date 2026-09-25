import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("the built CLI as a process", () => {
  it("stops quietly when the reader of its output goes away", () => {
    // `webindex extract big.txt | head -1`: head exits after one line, the next
    // write fails with EPIPE, and an unhandled stream error used to end the
    // run in a Node stack trace on the user's terminal.
    const big = join(dir, "big.txt");
    writeFileSync(big, Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join("\n"));
    const child = spawnSync("sh", ["-c", `"${process.execPath}" "${binary}" extract "${big}" | head -1`], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, WEBINDEX_CACHE_DIR: dir },
    });
    expect(child.stdout).toBe("line 0\n");
    expect(child.stderr).not.toMatch(/EPIPE|Unhandled|node:events/);
  });

  it("answers `version` without loading the HTTP server it only needs for `mcp --transport http`", () => {
    // node:http is the costliest builtin to import — ~40 ms of a 130 ms cold
    // start, undici included — and every command paid it because the MCP HTTP
    // transport imported it at module scope.
    const probe = join(dir, "probe.cjs");
    writeFileSync(
      probe,
      `process.on("exit", () => process.stderr.write("LOADED " + JSON.stringify(process.moduleLoadList.filter((m) => /^NativeModule (http|https|_http_\\w+)$/.test(m))) + "\\n"));`,
    );
    const child = spawnSync(process.execPath, ["--require", probe, binary, "version"], { encoding: "utf8", timeout: 10_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toContain("LOADED []");
  });
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
