import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, webindexAdapter } from "../src/cli.js";
import { ToolError } from "../src/mcp/server.js";
import { LATEST_PROTOCOL } from "../src/mcp/protocol.js";

// The CLI is a program, so these drive main() directly and capture what it
// writes. The built binary is exercised separately by consumer-smoke; this suite
// is about argument handling and the shape of the output.
//
// Note main() is imported, which runs cli.ts's module-scope configure() once.
// tests/setup.ts reconfigures to the throwaway test brand in beforeEach, which
// runs after imports — so the test brand wins and nothing leaks between cases.

let out: string[];
let err: string[];
let dir: string;

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: any) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: any) => (err.push(String(c)), true));
  dir = mkdtempSync(join(tmpdir(), "webindex-cli-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => vi.restoreAllMocks());

const stdout = () => out.join("");
const stderr = () => err.join("");

/** main() calls process.exit on failure; catch it so the case can assert. */
async function run(argv: string[]): Promise<number> {
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__exit__${code ?? 0}`);
  }) as never);
  try {
    await main(argv);
    return 0;
  } catch (e) {
    const m = /^__exit__(\d+)$/.exec((e as Error).message);
    if (m) return Number(m[1]);
    throw e;
  } finally {
    exit.mockRestore();
  }
}

describe("help and version", () => {
  it("prints help with no arguments, and does not fail", async () => {
    expect(await run([])).toBe(0);
    expect(stdout()).toContain("webindex v");
    expect(stdout()).toContain("USAGE");
  });

  it("answers --help, -h and help identically", async () => {
    const shapes = [];
    for (const a of [["--help"], ["-h"], ["help"]]) {
      out = [];
      await run(a);
      shapes.push(stdout());
    }
    expect(new Set(shapes).size).toBe(1);
  });

  it("prints a bare semver for version", async () => {
    await run(["version"]);
    expect(stdout().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("does not promise a search command it cannot deliver", async () => {
    // The discovery layer has not landed. Advertising `search` would be a lie,
    // and this asserts the help text stays honest as the engine grows.
    await run(["--help"]);
    expect(stdout()).not.toMatch(/^\s+webindex search/m);
  });
});

describe("extract", () => {
  it("reads an HTML file as clean text", async () => {
    const f = join(dir, "page.html");
    writeFileSync(f, "<html><body><article><h1>Rate limiting</h1><p>Token buckets smooth bursts.</p></article></body></html>");
    expect(await run(["extract", f])).toBe(0);
    expect(stdout()).toContain("Rate limiting");
    expect(stdout()).toContain("Token buckets");
    expect(stdout()).not.toContain("<article>");
  });

  it("passes plain text through untouched", async () => {
    const f = join(dir, "notes.txt");
    writeFileSync(f, "just some notes");
    await run(["extract", f]);
    expect(stdout().trim()).toBe("just some notes");
  });

  it("reports which rung produced the text under --json", async () => {
    const f = join(dir, "page.html");
    writeFileSync(f, "<html><body><p>hello</p></body></html>");
    await run(["extract", f, "--json"]);
    const j = JSON.parse(stdout());
    expect(j).toMatchObject({ file: "page.html", extractor: "native" });
    expect(j.chars).toBeGreaterThan(0);
  });

  it("fails with a readable message on a missing file", async () => {
    expect(await run(["extract", join(dir, "nope.html")])).toBe(1);
    expect(stderr()).toMatch(/cannot read/);
  });

  it("needs a path", async () => {
    expect(await run(["extract"])).toBe(1);
    expect(stderr()).toMatch(/usage: webindex extract/);
  });
});

describe("fetch argument handling", () => {
  it("refuses a non-http argument rather than guessing", async () => {
    expect(await run(["fetch", "example.com"])).toBe(1);
    expect(stderr()).toMatch(/http\(s\) URL/);
  });

  it("needs a url", async () => {
    expect(await run(["fetch"])).toBe(1);
    expect(stderr()).toMatch(/usage: webindex fetch/);
  });

  it("does not mistake a flag for the url", async () => {
    expect(await run(["fetch", "--json"])).toBe(1);
    expect(stderr()).toMatch(/usage: webindex fetch/);
  });
});

describe("doctor", () => {
  it("reports every optional helper without needing any of them", async () => {
    process.env.WEBINDEX_TEST_FIRECRAWL = "off";
    expect(await run(["doctor"])).toBe(0);
    const s = stdout();
    expect(s).toMatch(/firecrawl/);
    expect(s).toMatch(/pdf rungs/);
    expect(s).toMatch(/doc rungs/);
    expect(s).toMatch(/ocr/);
  });
});

describe("unknown input", () => {
  it("names the unknown command and points at help", async () => {
    expect(await run(["frobnicate"])).toBe(1);
    expect(stderr()).toMatch(/unknown command "frobnicate"/);
    expect(stderr()).toMatch(/--help/);
  });

  it("rejects an unknown mcp transport", async () => {
    expect(await run(["mcp", "--transport", "carrier-pigeon"])).toBe(1);
    expect(stderr()).toMatch(/unknown transport/);
  });

  it("rejects an out-of-range port", async () => {
    expect(await run(["mcp", "--transport", "http", "--port", "99999"])).toBe(1);
    expect(stderr()).toMatch(/invalid --port/);
  });
});

describe("the MCP tools", () => {
  const adapter = webindexAdapter();

  it("declares both tools with a required argument each", () => {
    const tools = adapter.listTools(LATEST_PROTOCOL);
    expect(tools.map((t) => t.name)).toEqual(["webindex_fetch", "webindex_extract"]);
    for (const t of tools) expect(t.inputSchema.required.length).toBeGreaterThan(0);
  });

  it("fetches a URL and says which rung produced the text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html><body><article><p>token buckets</p></article></body></html>", { status: 200, headers: { "content-type": "text/html" } }),
      ),
    );
    const r = await adapter.callTool("webindex_fetch", { url: "https://acme.test/p" });
    expect(r.text).toContain("token buckets");
    expect(r.text).toMatch(/extractor: \w+$/);
    vi.unstubAllGlobals();
  });

  it("refuses a non-http url as a tool error, not a crash", async () => {
    // A ToolError comes back as a readable isError result; anything else would
    // surface as an internal error the model cannot act on.
    await expect(adapter.callTool("webindex_fetch", { url: "file:///etc/passwd" })).rejects.toBeInstanceOf(ToolError);
    await expect(adapter.callTool("webindex_fetch", {})).rejects.toBeInstanceOf(ToolError);
  });

  it("extracts a local file", async () => {
    const f = join(dir, "doc.html");
    writeFileSync(f, "<html><body><p>from disk</p></body></html>");
    const r = await adapter.callTool("webindex_extract", { path: f });
    expect(r.text).toContain("from disk");
  });

  it("reports an unknown tool as a tool error", async () => {
    await expect(adapter.callTool("webindex_nope", {})).rejects.toBeInstanceOf(ToolError);
  });

  it("carries narrowing advice for both tools", () => {
    // The engine detects an oversized response; only this adapter knows how to
    // make it smaller.
    for (const t of adapter.listTools(LATEST_PROTOCOL)) expect(adapter.capAdvice?.[t.name]).toBeTruthy();
  });
});
