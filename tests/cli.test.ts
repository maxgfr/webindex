import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, webindexAdapter } from "../src/cli.js";
import { ToolError } from "../src/mcp/server.js";
import { LATEST_PROTOCOL } from "../src/mcp/protocol.js";
import { STACK_SERVICES } from "../src/stack.js";
import { installFetchMock } from "./fetchmock.js";
import { envName } from "../src/brand.js";

// Every stack service the engine knows, except `all` — the CLI spells that one
// `stack`. Derived rather than typed out, because a hand-written list is exactly
// how `semantic` stayed in STACK_SERVICES, in stackControl and in the README for
// four releases while the CLI had no route for it and no test noticed.
const SERVICE_ROUTES = STACK_SERVICES.filter((s) => s !== "all");

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

  it("documents every command it actually dispatches", async () => {
    // This started life as the opposite assertion — `search` was advertised
    // nowhere because the engine could not do it. Now it can, so the gate
    // flips: help and dispatch must not drift apart in either direction.
    await run(["--help"]);
    const help = stdout();
    for (const cmd of [
      "search",
      "fetch",
      "extract",
      "rank",
      "repo",
      "issues",
      "prs",
      "releases",
      "package",
      "meta",
      "robots",
      "sitemap",
      "feed",
      "mcp",
      ...SERVICE_ROUTES,
      "stack",
      "cache",
      "doctor",
      "version",
    ]) {
      expect(help, cmd).toMatch(new RegExp(`^\\s+webindex ${cmd}\\b`, "m"));
    }
  });

  it("routes every service the engine declares, not a hand-written subset", async () => {
    // The inverse of the assertion above, and the one that was missing: HELP
    // could stay honest while the dispatch quietly knew fewer commands. An
    // unrouted name falls through to the unknown-command branch, which exits 1
    // WITHOUT the `usage:` line the stack branch prints.
    for (const cmd of SERVICE_ROUTES) {
      out = [];
      err = [];
      expect(await run([cmd, "restart"]), cmd).toBe(1);
      expect(stderr(), cmd).toMatch(/usage: webindex/);
    }
  });
});

describe("search", () => {
  const up = (body: unknown) => {
    const spy = vi.fn(async (input: any) => {
      const url = String(input);
      const payload = url.includes("/search") ? JSON.stringify(body) : "ok";
      return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  };

  it("prints one hit per block, and keeps the notes off stdout", async () => {
    // `webindex search q | head` has to be a usable URL list, so the reason a
    // result set is short goes to stderr rather than into the middle of it.
    up({ results: [{ url: "https://a.test/1", title: "First", content: "About one" }], unresponsive_engines: [["google", "429"]] });
    expect(await run(["search", "rate", "limiting", "--searxng", "http://sxcli.test"])).toBe(0);
    expect(stdout()).toContain("First\n  https://a.test/1");
    expect(stdout()).not.toContain("throttled");
    expect(stderr()).toContain("throttled");
  });

  it("treats the words before a flag as one query, not several", async () => {
    const spy = up({ results: [] });
    await run(["search", "rate", "limiting", "--limit", "3", "--searxng", "http://sxcli2.test"]);
    const asked = spy.mock.calls.map((c) => String(c[0])).find((u) => u.includes("q="))!;
    expect(asked).toContain("q=rate%20limiting");
    expect(asked).not.toContain("q=rate%20limiting%203");
  });

  it("emits machine-readable hits with --json", async () => {
    up({ results: [{ url: "https://a.test/1", title: "First", content: "c" }] });
    await run(["search", "q", "--json", "--searxng", "http://sxcli3.test"]);
    const parsed = JSON.parse(stdout());
    expect(parsed.hits[0]).toMatchObject({ url: "https://a.test/1", via: "searxng" });
  });

  it("exits non-zero when it found nothing, so a script can tell", async () => {
    up({ results: [] });
    expect(await run(["search", "q", "--searxng", "http://sxcli4.test"])).toBe(1);
    expect(stderr()).toContain("stack up");
  });

  it("asks for a query rather than searching for nothing", async () => {
    expect(await run(["search"])).toBe(1);
    expect(stderr()).toContain("usage: webindex search");
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

  it("declares its tools, each with a required argument and cap advice", () => {
    const tools = adapter.listTools(LATEST_PROTOCOL);
    expect(tools.map((t) => t.name)).toEqual([
      "webindex_search",
      "webindex_fetch",
      "webindex_extract",
      "webindex_rank",
      "webindex_repo",
      "webindex_issues",
      "webindex_releases",
      "webindex_package",
      "webindex_meta",
      "webindex_robots",
      "webindex_sitemap",
      "webindex_feed",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.required.length, t.name).toBeGreaterThan(0);
      // An oversized response is WITHHELD, not truncated, and the replacement
      // names the argument to narrow — which only works if every tool has one.
      expect(adapter.capAdvice?.[t.name], t.name).toBeTruthy();
    }
  });

  it("says which backend was missing rather than reporting an empty web", async () => {
    // A search tool that returns "no results" when nothing is running teaches
    // the model the answer does not exist. It has to fail loudly instead.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(adapter.callTool("webindex_search", { query: "rate limiting" })).rejects.toThrow(/stack up/);
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

describe("the container stack", () => {
  it("prints where the compose file was written", async () => {
    expect(await run(["stack", "path"])).toBe(0);
    expect(stdout().trim()).toMatch(/docker-compose\.yml$/);
  });

  it("rejects an action that is not up, down or status", async () => {
    for (const cmd of [...SERVICE_ROUTES, "stack"]) {
      out = [];
      err = [];
      expect(await run([cmd, "restart"]), cmd).toBe(1);
      expect(stderr(), cmd).toMatch(/usage: webindex/);
    }
  });

  it("offers `path` only on stack, since the other two drive one service", async () => {
    expect(await run(["searxng", "path"])).toBe(1);
    expect(stderr()).toMatch(/up\|down\|status$/m);
  });
});

describe("the fetch cache", () => {
  it("reports an empty cache without failing", async () => {
    process.env[envName("CACHE_DIR")] = join(dir, "empty-cache");
    expect(await run(["cache", "status"])).toBe(0);
    expect(stdout()).toMatch(/entries\s+0 \(0 fresh, 0 stale\)/);
  });

  it("emits machine-readable stats with --json", async () => {
    process.env[envName("CACHE_DIR")] = join(dir, "empty-cache");
    await run(["cache", "status", "--json"]);
    const j = JSON.parse(stdout());
    expect(j).toMatchObject({ entries: 0, fresh: 0, stale: 0 });
    expect(typeof j.ttlMs).toBe("number");
  });

  it("says how many entries it evicted", async () => {
    process.env[envName("CACHE_DIR")] = join(dir, "empty-cache");
    expect(await run(["cache", "clean", "--all"])).toBe(0);
    expect(stdout()).toMatch(/0 entries removed \(all\)/);
  });

  it("rejects an action it does not have", async () => {
    expect(await run(["cache", "purge"])).toBe(1);
    expect(stderr()).toMatch(/usage: webindex cache status\|clean/);
  });
});

describe("rank", () => {
  const DOCS = JSON.stringify([
    {
      url: "https://spec.test/rfc",
      title: "RFC 6585 Additional HTTP Status Codes",
      text: "The 429 Too Many Requests status code indicates the user has sent too many requests. The response MAY include a Retry-After header.",
    },
    { url: "https://blog.test/a", title: "Rate limiting explained", text: "A token bucket refills at a fixed rate and caps at a burst size." },
    { url: "https://unrelated.test/c", title: "Sourdough", text: "Fermentation depends on hydration and ambient dough temperature." },
  ]);

  const withDocs = (json: string) => {
    const f = join(dir, "docs.json");
    writeFileSync(f, json);
    return f;
  };

  it("puts the document that answers the question first and the off-topic one last", async () => {
    expect(await run(["rank", "--query", "http 429 retry-after", "--docs", withDocs(DOCS)])).toBe(0);
    const lines = stdout().trim().split("\n");
    expect(lines[0]).toContain("RFC 6585");
    expect(stdout()).toMatch(/https:\/\/unrelated\.test\/c/);
    expect(stdout().indexOf("spec.test")).toBeLessThan(stdout().indexOf("unrelated.test"));
  });

  it("emits ranked entries, matched terms and the collapse count with --json", async () => {
    await run(["rank", "--query", "token bucket", "--docs", withDocs(DOCS), "--json"]);
    const j = JSON.parse(stdout());
    expect(j.ranked[0]).toMatchObject({ rank: 1, url: "https://blog.test/a" });
    expect(j.ranked[0].matched).toEqual(expect.arrayContaining(["token", "bucket"]));
    expect(typeof j.collapsed).toBe("number");
    expect(j.queryTerms).toEqual(expect.arrayContaining(["token", "bucket"]));
  });

  it("honours --limit", async () => {
    await run(["rank", "--query", "http 429", "--docs", withDocs(DOCS), "--limit", "1", "--json"]);
    expect(JSON.parse(stdout()).ranked).toHaveLength(1);
  });

  it("scores relative to the pool, so the best document is always 1", async () => {
    await run(["rank", "--query", "token bucket", "--docs", withDocs(DOCS), "--json"]);
    expect(JSON.parse(stdout()).ranked[0].score).toBe(1);
  });

  it("asks for a question rather than ranking against nothing", async () => {
    expect(await run(["rank", "--docs", withDocs(DOCS)])).toBe(1);
    expect(stderr()).toContain("usage: webindex rank");
  });

  it("refuses a payload that is not a list of documents", async () => {
    expect(await run(["rank", "--query", "x", "--docs", withDocs('{"not":"an array"}')])).toBe(1);
    expect(stderr()).toMatch(/non-empty JSON array/);

    expect(await run(["rank", "--query", "x", "--docs", withDocs('[{"text":"no url here"}]')])).toBe(1);
    expect(stderr()).toMatch(/has no url/);
  });

  it("says so when the question has no rankable terms left", async () => {
    // "what is the of" is all stopwords — the order would be arbitrary, and
    // silently returning one would look like a ranking.
    expect(await run(["rank", "--query", "what is the of", "--docs", withDocs(DOCS)])).toBe(1);
    expect(stderr()).toMatch(/no rankable terms/);
  });
});

describe("the forge, registry and page-metadata commands", () => {
  const json = (o: unknown) => ({ body: JSON.stringify(o), contentType: "application/json" });

  it("prints a repository's record, and flags an archived one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ full_name: "a/b", archived: true, stargazers_count: 12, license: { spdx_id: "MIT" }, default_branch: "main" }), {
            status: 200,
          }),
      ),
    );
    expect(await run(["repo", "github.com/a/b"])).toBe(0);
    expect(stdout()).toContain("ARCHIVED");
    expect(stdout()).toContain("MIT");
  });

  it("refuses free text rather than inventing a repository", async () => {
    expect(await run(["repo", "some", "words"])).toBe(1);
    expect(stderr()).toMatch(/does not name a repository/);
  });

  it("lists issues, and says when a quota — not the web — was the problem", async () => {
    installFetchMock((url) =>
      url.includes("/repos/")
        ? json({ full_name: "a/b" })
        : { status: 403, body: JSON.stringify({ message: "API rate limit exceeded" }), contentType: "application/json" },
    );
    expect(await run(["issues", "github.com/a/b", "--terms", "timeout"])).toBe(1);
    expect(stderr()).toMatch(/rate-limited/);
  });

  it("prints releases", async () => {
    installFetchMock((url) =>
      url.includes("/repos/") && !url.includes("releases")
        ? json({ full_name: "a/b" })
        : json([{ tag_name: "v1.2.3", name: "v1.2.3", html_url: "u", body: "notes" }]),
    );
    expect(await run(["releases", "github.com/a/b"])).toBe(0);
    expect(stdout()).toContain("v1.2.3");
  });

  it("resolves a package name to its real coordinates", async () => {
    installFetchMock(() =>
      json({ name: "p", "dist-tags": { latest: "2.0.0" }, versions: { "2.0.0": { repository: { url: "git+https://github.com/a/b.git" }, license: "MIT" } } }),
    );
    expect(await run(["package", "p", "--json"])).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ registry: "npm", version: "2.0.0", repository: "https://github.com/a/b" });
  });

  it("says so when no registry knows the name", async () => {
    installFetchMock(() => ({ status: 404, body: "{}", contentType: "application/json" }));
    expect(await run(["package", "nope-xyz"])).toBe(1);
    expect(stderr()).toMatch(/no registry knows/);
  });

  it("prints what a page says about itself", async () => {
    installFetchMock(() => ({
      body: '<html><head><meta property="og:title" content="T"><meta property="article:published_time" content="2024-01-01"></head></html>',
    }));
    expect(await run(["meta", "https://ex.test/a"])).toBe(0);
    expect(stdout()).toContain("title      T");
    expect(stdout()).toContain("2024-01-01");
  });

  it("exits non-zero when robots.txt forbids the URL, so it composes in a shell", async () => {
    installFetchMock(() => ({ body: "User-agent: *\nDisallow: /private", contentType: "text/plain" }));
    expect(await run(["robots", "https://ex.test/private/x"])).toBe(1);
    expect(stdout()).toContain("allowed   no");

    out = [];
    installFetchMock(() => ({ body: "User-agent: *\nDisallow: /private", contentType: "text/plain" }));
    expect(await run(["robots", "https://ex.test/public"])).toBe(0);
  });

  it("lists the URLs a sitemap declares", async () => {
    installFetchMock((url) => (url.endsWith("robots.txt") ? { status: 404, body: "" } : { body: "<urlset><url><loc>https://ex.test/p1</loc></url></urlset>" }));
    expect(await run(["sitemap", "https://ex.test/x"])).toBe(0);
    expect(stdout()).toContain("https://ex.test/p1");
  });

  it("parses a feed directly, and discovers one from a page", async () => {
    installFetchMock(() => ({ body: "<rss><channel><title>B</title><item><title>One</title><link>https://ex.test/1</link></item></channel></rss>" }));
    expect(await run(["feed", "https://ex.test/feed.xml"])).toBe(0);
    expect(stdout()).toContain("One");

    out = [];
    installFetchMock((url) =>
      url.includes("feed.xml")
        ? { body: "<rss><channel><title>B</title><item><title>Found</title><link>https://ex.test/2</link></item></channel></rss>" }
        : { body: '<link rel="alternate" type="application/rss+xml" href="/feed.xml">' },
    );
    expect(await run(["feed", "https://ex.test/page"])).toBe(0);
    expect(stdout()).toContain("Found");
  });

  it("says a page advertises no feed rather than printing nothing", async () => {
    installFetchMock(() => ({ body: "<html><body>no feed here</body></html>" }));
    expect(await run(["feed", "https://ex.test/page"])).toBe(1);
    expect(stderr()).toMatch(/advertises no feed/);
  });

  it("insists on an http(s) URL for the page-level lookups", async () => {
    for (const cmd of ["meta", "robots", "sitemap", "feed"]) {
      err = [];
      expect(await run([cmd, "not-a-url"]), cmd).toBe(1);
      expect(stderr(), cmd).toMatch(/expected an http\(s\) URL/);
    }
  });
});

describe("the empty and JSON shapes of the lookup commands", () => {
  const json = (o: unknown) => ({ body: JSON.stringify(o), contentType: "application/json" });

  it("prints em dashes rather than 'undefined' when a page declares nothing", async () => {
    installFetchMock(() => ({ body: "<html><body>bare</body></html>" }));
    await run(["meta", "https://ex.test/a"]);
    expect(stdout()).not.toContain("undefined");
    expect(stdout()).toMatch(/title\s+—/);
  });

  it("emits every lookup as JSON on demand", async () => {
    installFetchMock(() => ({ body: '<html><head><meta property="og:title" content="T"></head></html>' }));
    await run(["meta", "https://ex.test/a", "--json"]);
    expect(JSON.parse(stdout())).toMatchObject({ title: "T" });

    out = [];
    installFetchMock(() => ({ body: "User-agent: *\nDisallow: /x", contentType: "text/plain" }));
    await run(["robots", "https://ex.test/ok", "--json"]);
    expect(JSON.parse(stdout())).toMatchObject({ allowed: true, absent: false });

    out = [];
    installFetchMock((url) => (url.endsWith("robots.txt") ? { status: 404, body: "" } : { body: "<urlset><url><loc>https://ex.test/p</loc></url></urlset>" }));
    await run(["sitemap", "https://ex.test/x", "--json"]);
    expect(JSON.parse(stdout()).urls).toHaveLength(1);
  });

  it("reports a repository with no optional fields without inventing any", async () => {
    installFetchMock(() => json({ full_name: "a/b" }));
    await run(["repo", "github.com/a/b"]);
    expect(stdout()).not.toContain("ARCHIVED");
    expect(stdout()).not.toContain("undefined");
  });

  it("fails when a page cannot be fetched at all", async () => {
    installFetchMock(() => ({ status: 500, body: "" }));
    expect(await run(["meta", "https://ex.test/a"])).toBe(1);
    expect(stderr()).toMatch(/could not fetch/i);
  });

  it("says when a site has no sitemap, rather than printing an empty list", async () => {
    installFetchMock(() => ({ status: 404, body: "" }));
    expect(await run(["sitemap", "https://ex.test/x"])).toBe(1);
    expect(stderr()).toMatch(/no sitemap found/);
  });

  it("asks for a target rather than looking nothing up", async () => {
    for (const cmd of ["repo", "package", "meta", "robots", "sitemap", "feed"]) {
      err = [];
      expect(await run([cmd]), cmd).toBe(1);
      expect(stderr(), cmd).toMatch(/usage: webindex/);
    }
  });

  it("honours --registry, skipping the guessing", async () => {
    const seen: string[] = [];
    installFetchMock((url) => {
      seen.push(new URL(url).hostname);
      return json({ info: { name: "x", version: "9" } });
    });
    await run(["package", "x", "--registry", "pypi", "--json"]);
    expect(seen).toEqual(["pypi.org"]);
    expect(JSON.parse(stdout()).registry).toBe("pypi");
  });

  it("prints issues when they exist, with the state in the line", async () => {
    installFetchMock((url) =>
      url.includes("/search/") ? json({ items: [{ number: 9, title: "Bug", html_url: "u", state: "open" }] }) : json({ full_name: "a/b" }),
    );
    expect(await run(["issues", "github.com/a/b", "--terms", "bug"])).toBe(0);
    expect(stdout()).toContain("#9 Bug [open]");
  });

  it("searches pull requests when asked for prs", async () => {
    let q = "";
    installFetchMock((url) => {
      if (url.includes("/search/")) {
        q = url;
        return json({ items: [{ number: 2, title: "PR", html_url: "u", state: "open" }] });
      }
      return json({ full_name: "a/b" });
    });
    await run(["prs", "github.com/a/b", "--terms", "fix"]);
    expect(decodeURIComponent(q)).toContain("is:pr");
  });
});
