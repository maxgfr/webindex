import { afterEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { ddgRedirectTarget, keylessEngines, parseDdgHtml, parseDdgLite, parseMojeek, searchViaKeyless, stripTags, throttleReason } from "../src/engines.js";
import { search } from "../src/search.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Shapes taken from what these endpoints actually serve. They are FIXTURES, not
// live traffic: the parsers are the thing rotting on somebody else's schedule,
// so a canary that fails loudly when the markup moves is the point.
const DDG_HTML = `
<div class="results">
  <div class="result results_links">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frfc-editor.org%2Frfc%2Frfc6585&amp;rut=x">RFC 6585 &amp; friends</a>
    <a class="result__snippet" href="#">The <b>429</b> status code indicates too many requests.</a>
  </div>
  <div class="result results_links result--ad">
    <a class="result__a" href="//duckduckgo.com/y.js?ad=1">Sponsored thing</a>
    <a class="result__snippet" href="#">buy things</a>
  </div>
  <div class="result results_links">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbuckets">Token buckets</a>
    <a class="result__snippet" href="#">A bucket refills at a fixed rate.</a>
  </div>
</div>`;

const DDG_LITE = `
<table>
  <tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fone">First result</a></td></tr>
  <tr><td class="result-snippet">Snippet for the first one.</td></tr>
  <tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.test%2Ftwo">Second result</a></td></tr>
  <tr><td class="result-snippet">Snippet for the second.</td></tr>
</table>`;

const MOJEEK = `
<ul class="results-standard">
  <li><a class="title ok" href="https://indie.test/page">An independent index</a>
      <p class="s">Mojeek runs its own crawler.</p></li>
  <li><a class="title" href="//relative.test/x">Protocol-relative href</a>
      <p class="s">Should become https.</p></li>
</ul>`;

describe("stripTags", () => {
  it("removes markup, decodes entities and collapses whitespace", () => {
    expect(stripTags("<b>RFC 6585</b> &amp;\n  friends")).toBe("RFC 6585 & friends");
  });
});

describe("ddgRedirectTarget", () => {
  it("unwraps the uddg redirector so the citation names the real source", () => {
    expect(ddgRedirectTarget("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fq%3D1&rut=x")).toBe("https://example.com/a?q=1");
  });

  it("upgrades a protocol-relative href and passes anything else through", () => {
    expect(ddgRedirectTarget("//example.com/a")).toBe("https://example.com/a");
    expect(ddgRedirectTarget("https://example.com/a")).toBe("https://example.com/a");
  });

  it("keeps the raw href when the encoding is broken rather than throwing", () => {
    expect(ddgRedirectTarget("//duckduckgo.com/l/?uddg=%E0%A4%A")).toContain("duckduckgo.com");
  });
});

describe("throttleReason", () => {
  it("separates 'come back later' from 'this will never work'", () => {
    expect(throttleReason(429)).toEqual({ throttled: true, why: "rate-limited (HTTP 429)" });
    expect(throttleReason(503)).toEqual({ throttled: true, why: "rate-limited (HTTP 503)" });
    expect(throttleReason(404).throttled).toBe(false);
    expect(throttleReason(0).why).toMatch(/unreachable/);
  });
});

describe("result-block parsers", () => {
  it("reads DuckDuckGo HTML, unwrapping links and skipping the engine's own", () => {
    const hits = parseDdgHtml(DDG_HTML);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      url: "https://rfc-editor.org/rfc/rfc6585",
      title: "RFC 6585 & friends",
      snippet: "The 429 status code indicates too many requests.",
    });
    // The ad's href stays on duckduckgo.com, so it is rejected — and crucially
    // the NEXT result keeps its own snippet. An index-zip would have shifted it.
    expect(hits[1]!.url).toBe("https://example.com/buckets");
    expect(hits[1]!.snippet).toBe("A bucket refills at a fixed rate.");
  });

  it("reads DuckDuckGo Lite's flat table", () => {
    const hits = parseDdgLite(DDG_LITE);
    expect(hits.map((h) => h.url)).toEqual(["https://a.test/one", "https://b.test/two"]);
    expect(hits[1]!.snippet).toBe("Snippet for the second.");
  });

  it("reads Mojeek's direct hrefs and upgrades protocol-relative ones", () => {
    const hits = parseMojeek(MOJEEK);
    expect(hits.map((h) => h.url)).toEqual(["https://indie.test/page", "https://relative.test/x"]);
    expect(hits[0]!.snippet).toBe("Mojeek runs its own crawler.");
  });

  it("returns nothing rather than throwing on markup it does not recognise", () => {
    for (const parse of [parseDdgHtml, parseDdgLite, parseMojeek]) {
      expect(parse("<html><body>the layout changed</body></html>")).toEqual([]);
      expect(parse("")).toEqual([]);
    }
  });

  it("honours the limit", () => {
    expect(parseDdgLite(DDG_LITE, 1)).toHaveLength(1);
  });
});

describe("searchViaKeyless", () => {
  it("queries the engine and returns its hits", async () => {
    const spy = installFetchMock(() => ({ body: DDG_LITE }));
    const r = await searchViaKeyless("ddglite", "token bucket");
    expect(r.hits.map((h) => h.url)).toEqual(["https://a.test/one", "https://b.test/two"]);
    expect(String(spy.mock.calls[0]![0])).toContain("lite.duckduckgo.com");
    expect(String(spy.mock.calls[0]![0])).toContain("q=token%20bucket");
  });

  it("reports a throttle as retryable and a 404 as not", async () => {
    installFetchMock(() => ({ status: 429, body: "" }));
    const limited = await searchViaKeyless("ddg", "x");
    expect(limited.throttled).toBe(true);
    expect(limited.note).toMatch(/DuckDuckGo rate-limited \(HTTP 429\)/);

    installFetchMock(() => ({ status: 404, body: "" }));
    const gone = await searchViaKeyless("ddg", "x");
    expect(gone.throttled).toBe(false);
    expect(gone.note).toMatch(/unreachable/);
  });

  it("stops paginating when a page adds nothing new", async () => {
    // An engine that ignores the offset parameter re-serves page one. Walking to
    // the requested depth would then cost one request per page for the same ten
    // results — so a page that adds no NEW canonical URL ends the walk.
    const spy = installFetchMock(() => ({ body: DDG_LITE }));
    const r = await searchViaKeyless("ddglite", "x", { pages: 5, limit: 50 });
    expect(spy).toHaveBeenCalledTimes(2); // page 1, page 2 adds nothing, stop
    expect(r.hits).toHaveLength(2);
  });

  it("keeps page one's results when a later page fails", async () => {
    let n = 0;
    installFetchMock(() => {
      n++;
      return n === 1 ? { body: DDG_LITE } : { status: 500, body: "" };
    });
    const r = await searchViaKeyless("ddglite", "x", { pages: 3, limit: 50 });
    expect(r.hits).toHaveLength(2);
    expect(r.note).toBeUndefined();
  });

  it("refuses an empty query without a request", async () => {
    const spy = installFetchMock(() => ({ body: DDG_LITE }));
    expect((await searchViaKeyless("ddg", "   ")).note).toBe("Empty query.");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("keylessEngines", () => {
  it("defaults to all of them, and an explicit list wins", () => {
    vi.stubEnv(envName("ENGINES"), "");
    expect(keylessEngines()).toEqual(["ddg", "ddglite", "mojeek"]);
    expect(keylessEngines({ engines: ["mojeek"] })).toEqual(["mojeek"]);
  });

  it("is switched off by <PREFIX>_ENGINES=off — the network opt-out", () => {
    vi.stubEnv(envName("ENGINES"), "off");
    expect(keylessEngines()).toEqual([]);
  });

  it("reads a comma list and ignores a name it does not know", () => {
    vi.stubEnv(envName("ENGINES"), "mojeek, ddglite, googol");
    expect(keylessEngines()).toEqual(["mojeek", "ddglite"]);
  });
});

describe("the search cascade", () => {
  it("falls through to a keyless engine when the local stack is not running", async () => {
    // SearXNG and Firecrawl are off in tests/setup.ts, which is exactly the
    // "no Docker on this machine" case the keyless rung exists for.
    installFetchMock(() => ({ body: DDG_LITE }));
    const r = await search("token bucket", { engines: ["ddglite"] });
    expect(r.hits.map((h) => h.via)).toEqual(["ddglite", "ddglite"]);
    expect(r.hits[0]!.url).toBe("https://a.test/one");
  });

  it("tries each engine in order and stops at the first with hits", async () => {
    const seen: string[] = [];
    installFetchMock((url) => {
      seen.push(new URL(url).hostname);
      return url.includes("mojeek") ? { body: MOJEEK } : { body: "<html>nothing</html>" };
    });
    const r = await search("x", { engines: ["ddg", "ddglite", "mojeek"] });
    expect(seen).toEqual(["html.duckduckgo.com", "lite.duckduckgo.com", "www.mojeek.com"]);
    expect(r.hits[0]!.via).toBe("mojeek");
  });

  it("surfaces a throttle but does not repeat 'no results' three times", async () => {
    installFetchMock((url) => (url.includes("html.duckduckgo") ? { status: 429, body: "" } : { body: "<html>nothing</html>" }));
    const r = await search("x", { engines: ["ddg", "ddglite", "mojeek"] });
    expect(r.hits).toHaveLength(0);
    expect(r.notes.filter((n) => /rate-limited/.test(n))).toHaveLength(1);
    expect(r.notes.filter((n) => /returned no results/.test(n))).toHaveLength(0);
    expect(r.notes.at(-1)).toMatch(/No results from any engine/);
  });

  it("skips the keyless rung entirely when it is switched off", async () => {
    const spy = installFetchMock(() => ({ body: DDG_LITE }));
    const r = await search("x", { engines: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(r.hits).toHaveLength(0);
  });
});
