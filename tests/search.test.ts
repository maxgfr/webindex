import { afterEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { probeSearxng, resetSearxngProbeCache, search, searchViaSearxng, searxngBase, searxngIsExplicit, SEARXNG_DEFAULT_BASE } from "../src/search.js";
import { installFetchMock, routes, type MockResponse } from "./fetchmock.js";

// The probe is memoised per base for the life of the process, so each case that
// needs its own verdict uses its own host. (tests/setup.ts sets
// <PREFIX>_SEARXNG=off globally; an explicit base overrides it.)
let n = 0;
const nextBase = () => `http://sx${++n}.test`;

afterEach(() => {
  vi.unstubAllGlobals();
  resetSearxngProbeCache();
});

const page = (results: unknown[], extra: Record<string, unknown> = {}): MockResponse => ({
  body: JSON.stringify({ results, ...extra }),
  contentType: "application/json",
});

const hit = (url: string, title = "t", content = "c") => ({ url, title, content });

describe("searxngBase", () => {
  it("prefers the option, then the env var, then the localhost default", () => {
    expect(searxngBase({ searxng: "http://flag.test:8888/" })).toBe("http://flag.test:8888");
    process.env[envName("SEARXNG")] = "http://env.test:8888";
    expect(searxngBase()).toBe("http://env.test:8888");
    delete process.env[envName("SEARXNG")];
    expect(searxngBase()).toBe(SEARXNG_DEFAULT_BASE);
    process.env[envName("SEARXNG")] = "off"; // restore the suite-wide default
  });

  it('treats the literal "off" as disabled, from either source', () => {
    expect(searxngBase({ searxng: "off" })).toBeNull();
    expect(searxngBase({ searxng: "OFF" })).toBeNull();
    expect(searxngBase()).toBeNull(); // <PREFIX>_SEARXNG=off from tests/setup.ts
  });

  it("knows whether the base was chosen or inherited", () => {
    // Drives the wording of the unreachable note: someone who NAMED an instance
    // gets an error, someone on the default gets an invitation to start one.
    expect(searxngIsExplicit({ searxng: "http://x.test" })).toBe(true);
    delete process.env[envName("SEARXNG")];
    expect(searxngIsExplicit()).toBe(false);
    process.env[envName("SEARXNG")] = "off";
  });
});

describe("probeSearxng", () => {
  it("counts any HTTP answer as up, including a 404", async () => {
    // A reverse proxy in front of SearXNG may not route /healthz. Something
    // answered on that port; that is what the probe is for.
    installFetchMock(() => ({ status: 404, body: "nope" }));
    await expect(probeSearxng(nextBase())).resolves.toBe(true);
  });

  it("counts a refused connection as down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(probeSearxng(nextBase())).resolves.toBe(false);
  });

  it("probes a given base only once per process", async () => {
    const spy = installFetchMock(() => ({ body: "ok" }));
    const base = nextBase();
    await probeSearxng(base);
    await probeSearxng(base);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("searchViaSearxng", () => {
  it("returns candidates, not page text", async () => {
    const base = nextBase();
    installFetchMock(routes([["/search", page([hit("https://a.test/1", "First", "About one")])]]));
    const r = await searchViaSearxng("q", { searxng: base });
    expect(r.hits).toEqual([{ url: "https://a.test/1", title: "First", snippet: "About one", via: "searxng" }]);
  });

  it("asks for JSON and safe search, and passes the language through", async () => {
    const base = nextBase();
    const spy = installFetchMock(routes([["/search", page([])]]));
    await searchViaSearxng("rate limiting", { searxng: base, lang: "fr-FR" });
    const url = String(spy.mock.calls.at(-1)![0]);
    expect(url).toContain("q=rate%20limiting");
    expect(url).toContain("format=json");
    expect(url).toContain("safesearch=1");
    expect(url).toContain("language=fr-FR");
  });

  it("falls back to the URL when a result has no title", async () => {
    const base = nextBase();
    installFetchMock(routes([["/search", page([{ url: "https://a.test/1", title: "   " }])]]));
    const r = await searchViaSearxng("q", { searxng: base });
    expect(r.hits[0]).toMatchObject({ title: "https://a.test/1", snippet: "" });
  });

  it("skips a result with no usable url", async () => {
    const base = nextBase();
    installFetchMock(routes([["/search", page([{ title: "no url" }, hit("https://a.test/1")])]]));
    const r = await searchViaSearxng("q", { searxng: base });
    expect(r.hits.map((h) => h.url)).toEqual(["https://a.test/1"]);
  });

  it("stops at the requested limit", async () => {
    const base = nextBase();
    installFetchMock(routes([["/search", page([hit("https://a.test/1"), hit("https://a.test/2"), hit("https://a.test/3")])]]));
    const r = await searchViaSearxng("q", { searxng: base, limit: 2 });
    expect(r.hits).toHaveLength(2);
  });

  it("walks pages and dedupes across them by canonical URL", async () => {
    // Page 2 repeats page 1's link with tracking params. Counting it twice
    // would push a genuinely new result off the end of the limit.
    const base = nextBase();
    installFetchMock((url) =>
      url.includes("pageno=2") ? page([hit("https://a.test/1?utm_source=x"), hit("https://a.test/2")]) : page([hit("https://a.test/1")]),
    );
    const r = await searchViaSearxng("q", { searxng: base, pages: 2 });
    expect(r.hits.map((h) => h.url)).toEqual(["https://a.test/1", "https://a.test/2"]);
  });

  it("stops paginating as soon as a page adds nothing new", async () => {
    const base = nextBase();
    const spy = installFetchMock(routes([["/search", page([hit("https://a.test/1")])]])); // every page identical
    const r = await searchViaSearxng("q", { searxng: base, pages: 5 });
    expect(r.hits).toHaveLength(1);
    // 1 probe + page 1 + page 2 (the repeat that ends it) — not five pages.
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("distinguishes a throttled instance from an empty web", async () => {
    // SearXNG answers 200 with zero results when ITS upstreams have blocked it.
    // Reported as "nothing found", that is a false negative the caller acts on.
    const base = nextBase();
    installFetchMock(routes([["/search", page([], { unresponsive_engines: [["google", "too many requests"], ["brave"]] })]]));
    const r = await searchViaSearxng("q", { searxng: base });
    expect(r.hits).toEqual([]);
    expect(r.notes.join(" ")).toContain("google (too many requests)");
    expect(r.notes.join(" ")).toContain("brave (unavailable)");
    expect(r.notes.join(" ")).toContain("not an empty web");
  });

  it("says plainly when there is genuinely nothing", async () => {
    const base = nextBase();
    installFetchMock(routes([["/search", page([])]]));
    const r = await searchViaSearxng("q", { searxng: base });
    expect(r.notes).toEqual(["SearXNG returned no results."]);
  });

  it("names rate limiting rather than reporting no results", async () => {
    const base = nextBase();
    installFetchMock((url) => (url.includes("/search") ? { status: 429, body: "slow down" } : { body: "ok" }));
    const r = await searchViaSearxng("q", { searxng: base });
    expect(r.notes[0]).toContain("rate-limited (HTTP 429)");
  });

  it("blames the instance's json setting when the body is not JSON", async () => {
    // The single most common misconfiguration: `format: json` is off by default
    // on public instances, and the reply is an HTML results page.
    const base = nextBase();
    installFetchMock(routes([["/search", { body: "<html>results</html>" }]]));
    const r = await searchViaSearxng("q", { searxng: base });
    expect(r.notes[0]).toContain("format: json");
  });

  it("tells someone on the default base how to start one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    delete process.env[envName("SEARXNG")];
    const r = await searchViaSearxng("q");
    process.env[envName("SEARXNG")] = "off";
    // The command carries the consumer's brand, not "webindex".
    expect(r.notes[0]).toContain("webindex-tests searxng up");
  });

  it("does not invite someone who named their own instance to start ours", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await searchViaSearxng("q", { searxng: nextBase() });
    expect(r.notes[0]).toMatch(/not reachable/);
    expect(r.notes[0]).not.toContain("searxng up");
  });

  it("reports being switched off as a fact, not a failure", async () => {
    const r = await searchViaSearxng("q", { searxng: "off" });
    expect(r.hits).toEqual([]);
    expect(r.notes[0]).toContain(`${envName("SEARXNG")}=off`);
  });
});

describe("search", () => {
  it("returns SearXNG's hits without touching Firecrawl", async () => {
    const base = nextBase();
    const spy = installFetchMock(routes([["/search", page([hit("https://a.test/1")])]]));
    const r = await search("q", { searxng: base }); // firecrawl is off suite-wide
    expect(r.hits.map((h) => h.via)).toEqual(["searxng"]);
    expect(spy.mock.calls.every(([u]) => !String(u).includes("3002"))).toBe(true);
  });

  it("falls back to Firecrawl when SearXNG finds nothing", async () => {
    const sx = nextBase();
    const fc = "http://fcsearch.test";
    installFetchMock((url) => {
      if (url.startsWith(sx)) return page([]);
      if (url.includes("/search"))
        return {
          body: JSON.stringify({ success: true, data: { web: [{ url: "https://b.test/1", title: "B", description: "d" }] } }),
          contentType: "application/json",
        };
      return { body: "ok" };
    });
    const r = await search("q", { searxng: sx, firecrawl: fc });
    expect(r.hits).toEqual([{ url: "https://b.test/1", title: "B", snippet: "d", via: "firecrawl" }]);
    // The SearXNG note survives the fallback: the caller can still see it was empty.
    expect(r.notes.join(" ")).toContain("SearXNG returned no results");
  });

  it("distinguishes 'nothing found' from 'nothing running'", async () => {
    // Both produce zero hits. Conflating them makes a tool report an empty web
    // when the real answer is that the user never started the stack.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await search("q", { searxng: nextBase(), firecrawl: "http://fcdown.test" });
    expect(r.hits).toEqual([]);
    expect(r.notes.at(-1)).toContain("webindex-tests stack up");
  });

  it("refuses an empty query without hitting the network", async () => {
    const spy = installFetchMock(() => ({ body: "ok" }));
    expect(await search("   ")).toEqual({ hits: [], notes: ["Empty query."] });
    expect(spy).not.toHaveBeenCalled();
  });
});
