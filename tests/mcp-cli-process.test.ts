import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserWorld } from "./helpers/browser-world.js";
import { scriptBrowser } from "./helpers/fake-browser.js";
import { FakeCdp } from "./helpers/fake-cdp.js";

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

  it("reads a page or a document from stdin for `-`", () => {
    const env = { ...process.env, WEBINDEX_CACHE_DIR: dir, WEBINDEX_NO_NPX: "1" };
    const tables = spawnSync(process.execPath, [binary, "tables", "-", "--json"], {
      input: "<table><tr><th>a</th></tr><tr><td>1</td></tr></table>",
      encoding: "utf8",
      timeout: 10_000,
      env,
    });
    expect(tables.status, tables.stderr).toBe(0);
    expect(JSON.parse(tables.stdout)[0]).toEqual({ headers: ["a"], rows: [["1"]] });

    const extracted = spawnSync(process.execPath, [binary, "extract", "-"], {
      input: "<html><body><article><p>Read from a pipe, not a file.</p></article></body></html>",
      encoding: "utf8",
      timeout: 10_000,
      env,
    });
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(extracted.stdout).toContain("Read from a pipe, not a file.");
  });

  it("runs under whatever name the file was saved as", () => {
    // Only a file NAMED webindex ran: a release asset saved as
    // webindex-1.20.0.mjs printed nothing at all and exited 0.
    const renamed = join(dir, "webindex-1.2.3.mjs");
    copyFileSync(binary, renamed);
    const child = spawnSync(process.execPath, [renamed, "version"], { encoding: "utf8", timeout: 10_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("does not run when it is imported rather than started", () => {
    // The skill-bundle gate imports a built CLI to read its flag tables.
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(binary).href)}); console.log(typeof m.HELP);`],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("string\n");
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

describe("browser output through a pipe", () => {
  /** Run the built CLI with its stdout on a pipe (as `… | jq` has it), and read all of it. */
  const piped = (args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [binary, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (c: string) => {
        stdout += c;
      });
      child.stderr.setEncoding("utf8").on("data", (c: string) => {
        stderr += c;
      });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

  it("writes all of a large result before it exits 3 on a blocking challenge", async () => {
    const fake = await FakeCdp.start();
    const home = mkdtempSync(join(tmpdir(), "webindex-pipe-"));
    try {
      scriptBrowser(fake);
      const world = new BrowserWorld(fake);
      fake.addTarget("https://a.test/", "A page");
      world.blocking = true;
      // A page far over a pipe's buffer: 6000 buttons, each a line of the snapshot.
      const buttons = Array.from({ length: 6000 }, (_, i) => ({
        nodeId: String(i + 2),
        parentId: "1",
        role: { value: "button" },
        name: { value: `Button number ${i} of a very long page` },
        backendDOMNodeId: 100 + i,
      }));
      fake.handle("Accessibility.getFullAXTree", () => ({
        nodes: [{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "A" }, childIds: buttons.map((b) => b.nodeId), backendDOMNodeId: 1 }, ...buttons],
      }));
      const r = await piped(["browser", "open", "https://b.test/", "--cdp", String(fake.port), "--json", "--snapshot", "--max-chars", "1000000"], {
        WEBINDEX_BROWSER_DIR: home,
      });
      expect(r.status, r.stderr).toBe(3);
      expect(r.stdout.length).toBeGreaterThan(200_000);
      const json = JSON.parse(r.stdout);
      expect(json).toMatchObject({ ok: true, challenge: { blocking: true } });
      expect(json.snapshot.text).toContain("Button number 5999 of a very long page");
    } finally {
      await fake.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
