import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runWithInput, binaryName } from "../src/pdf/exec.js";

// Real spawns, except where a case stands in for Windows: there the call spawn
// receives is what is under test, and nothing is actually run.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// `node` itself is the one binary guaranteed to exist wherever these tests run,
// so every case drives it rather than a tool that may or may not be installed
// (which is exactly the non-determinism the PDF ladder's own tests avoid).
const NODE = process.execPath;
const script = (body: string) => ["--input-type=module", "-e", body];

describe("runWithInput", () => {
  it("pipes the input to stdin and returns stdout", async () => {
    const r = await runWithInput(NODE, script("process.stdin.pipe(process.stdout)"), Buffer.from("a PDF's bytes"), 30_000);
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("a PDF's bytes");
  });

  it("reports a non-zero exit instead of throwing", async () => {
    const r = await runWithInput(NODE, script("process.exit(3)"), Buffer.alloc(0), 30_000);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("exit 3");
  });

  // The ladder turns this into "rung unavailable" and remembers it, which is how
  // a machine without npm or poppler still gets an answer.
  it("reports a missing binary as `not installed`", async () => {
    const r = await runWithInput("webindex-no-such-binary-xyz", [], Buffer.alloc(0), 30_000);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not installed");
  });

  it("kills a hung tool at the timeout rather than hanging the run", async () => {
    const r = await runWithInput(NODE, script("setTimeout(() => {}, 60_000)"), Buffer.alloc(0), 300);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out after/);
  });

  // A tool that rejects the input closes stdin early; the resulting EPIPE must
  // not surface as a crash.
  it("survives a tool that closes stdin without reading it", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const r = await runWithInput(NODE, script("process.stdout.write('done'); process.stdin.destroy();"), big, 30_000);
    expect(r.stdout).toContain("done");
  });

  // npx runs the real tool as a grandchild (npx → sh → node) and copyable-pdf
  // spawns pdftoppm and tesseract. SIGKILL on the direct child left those
  // running, holding the pipes, and the process could not exit until they did.
  it("kills the tool's children with it at the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webindex-tree-"));
    const pidFile = join(dir, "grandchild.pid");
    const grandchild = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
      require('node:fs').writeFileSync(process.argv[1], String(g.pid));
      setTimeout(() => {}, 30000);
    `;
    try {
      const started = performance.now();
      const r = await runWithInput(NODE, ["-e", grandchild, pidFile], Buffer.alloc(0), 1500);
      expect(r.error).toMatch(/timed out after/);
      expect(performance.now() - started).toBeLessThan(4000);
      const pid = Number(readFileSync(pidFile, "utf8"));
      let alive = true;
      for (let i = 0; i < 40 && alive; i++) {
        try {
          process.kill(pid, 0);
          alive = !(process.platform === "linux" && / Z /.test(readFileSync(`/proc/${pid}/stat`, "latin1")));
        } catch {
          alive = false;
        }
        if (alive) await new Promise((res) => setTimeout(res, 50));
      }
      expect(alive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drains stderr so a chatty tool cannot deadlock on a full pipe", async () => {
    const r = await runWithInput(NODE, script("process.stderr.write('x'.repeat(200_000)); process.stdout.write('ok')"), Buffer.alloc(0), 30_000);
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("ok");
  });
});

describe("binaryName", () => {
  const platform = process.platform;
  const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p, configurable: true });

  it("passes names through unchanged off Windows", () => {
    setPlatform("darwin");
    expect(binaryName("npx")).toBe("npx");
    expect(binaryName("pdftotext")).toBe("pdftotext");
    setPlatform(platform);
  });

  // Windows ships npx as a .cmd shim, which `spawn` will not resolve on its own.
  it("resolves npx to its .cmd shim on Windows", () => {
    setPlatform("win32");
    expect(binaryName("npx")).toBe("npx.cmd");
    expect(binaryName("pdftotext")).toBe("pdftotext"); // a real .exe needs no shim
    setPlatform(platform);
  });
});

// Since the CVE-2024-27980 fix (Node 18.20.2 / 20.12.2 / 22.x), spawn refuses
// a .cmd or .bat without a shell: EINVAL. runWithInput turned that into a
// failed run, so both npx rungs were marked unavailable on every Windows run.
describe("the npx shim on Windows", () => {
  const platform = process.platform;
  const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p, configurable: true });
  const spawnMock = vi.mocked(spawn);

  /** What runWithInput asked spawn for, on a pretend Windows — the spawn itself is refused. */
  async function spawnedOnWindows(cmd: string, args: string[]) {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("not really spawning");
    });
    setPlatform("win32");
    try {
      await runWithInput(cmd, args, Buffer.alloc(0), 1000);
    } finally {
      setPlatform(platform);
    }
    return spawnMock.mock.calls.at(-1)!;
  }

  it("runs npx.cmd through a shell, with every argument quoted for cmd.exe", async () => {
    const [file, args, opts] = await spawnedOnWindows("npx", ["-y", "--prefer-offline", "@firecrawl/anydoc@0.1", "-", 'say "hi"']);
    expect(file).toBe('"npx.cmd"');
    expect(args).toEqual(['"-y"', '"--prefer-offline"', '"@firecrawl/anydoc@0.1"', '"-"', '"say ""hi"""']);
    expect(opts).toMatchObject({ shell: true });
  });

  it("spawns a real executable directly, with its arguments untouched", async () => {
    const [file, args, opts] = await spawnedOnWindows("pdftotext", ["-layout", "-", "-"]);
    expect(file).toBe("pdftotext");
    expect(args).toEqual(["-layout", "-", "-"]);
    expect(opts).not.toMatchObject({ shell: true });
  });
});
