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

// The two challenge pages these engines actually serve, captured on 2026-08-21
// from html.duckduckgo.com and www.mojeek.com after a few dozen queries in a
// row. Both were trimmed to the markers that identify them, and neither is an
// error page: DuckDuckGo answered 202 and Mojeek 200, so `res.ok` was TRUE and
// the parsers simply found no result blocks.
const DDG_CHALLENGE = `<!DOCTYPE html><html lang="en"><head><title>
        DuckDuckGo
    </title></head><body>
  <form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html&cc=botnet" method="POST">
    <div class="anomaly-modal__mask"><div class="anomaly-modal__modal" data-testid="anomaly-modal">
      <div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
      <div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div>
      <div class="anomaly-modal__instructions">Select all squares containing a duck:</div>
    </div></div>
  </form>
</body></html>`;

const MOJEEK_CAPTCHA = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Captcha</title></head>
<body data-theme="light" class="home">
<div class="captcha-wrap"><p>JavaScript is required to complete this challenge. Please enable it and reload the page.</p></div>
<script async src="/js/page_specific/challenge.js?v=1.264"></script>
</body></html>`;

const DDG_403 = `If this persists, please <a href="mailto:error-lite+9318@duckduckgo.com?subject=Error getting results">email us</a>.<br />
Our support email address includes an anonymized error code that helps us understand the context of your search.`;

const MOJEEK_403 = `<!DOCTYPE html><html><head><title>403 - Forbidden</title></head><body><h1>403 - Forbidden</h1>
<h2>Sorry your network appears to be sending automated queries so we can't process your search at this time.</h2></body></html>`;

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

describe("an engine that refuses to answer says so, rather than reporting an empty web", () => {
  // The failure this guards against is the one nobody downstream can detect.
  //
  // A caller asked for a company's website, every engine turned it away, and the
  // only thing that came back was "No results from any engine" — which reads as
  // a company with no web presence. Measured on a real prospecting run: 12
  // French companies searched, 0 results, and every one of them was blocked
  // rather than absent. The whole point of a keyless cascade is that it degrades
  // honestly.
  it("recognises a CAPTCHA served with a 2xx status", async () => {
    // DuckDuckGo answers 202 and Mojeek 200, so `res.ok` is true and the parser
    // just finds nothing. Status alone cannot tell these from a genuinely empty
    // result page — only the body can.
    installFetchMock(() => ({ status: 202, body: DDG_CHALLENGE }));
    const ddg = await searchViaKeyless("ddg", "boulangerie Vincennes");
    expect(ddg.hits).toHaveLength(0);
    expect(ddg.blocked).toBe(true);
    expect(ddg.throttled).toBe(true);
    expect(ddg.note).toMatch(/DuckDuckGo/);
    expect(ddg.note).toMatch(/challenge|captcha/i);
    expect(ddg.note).not.toMatch(/returned no results/);

    installFetchMock(() => ({ status: 200, body: MOJEEK_CAPTCHA }));
    const mojeek = await searchViaKeyless("mojeek", "boulangerie Vincennes");
    expect(mojeek.blocked).toBe(true);
    expect(mojeek.note).toMatch(/Mojeek/);
    expect(mojeek.note).toMatch(/challenge|captcha/i);
  });

  it.each([
    ["ddg" as const, DDG_403],
    ["mojeek" as const, MOJEEK_403],
  ])("treats a 403 from %s as a block, not as an unreachable host", async (engine, body) => {
    // "Unreachable (status 403)" is the wrong fact and it was being discarded on
    // top: the cascade only kept notes from engines it considered throttled, so
    // a 403 vanished entirely.
    installFetchMock(() => ({ status: 403, body }));
    const r = await searchViaKeyless(engine, "x");
    expect(r.hits).toHaveLength(0);
    expect(r.blocked).toBe(true);
    expect(r.throttled).toBe(true);
    expect(r.note).toMatch(/blocked|refus/i);
    expect(r.note).not.toMatch(/unreachable/);
  });

  it("never calls a page BLOCKED when it parsed results out of it", async () => {
    // The detector reads markers out of the body, and I cannot prove by
    // observation that a normal DuckDuckGo results page never carries one —
    // both endpoints were serving challenges throughout the session this was
    // written in, so no genuine result body was available to check against.
    //
    // So it is made structurally impossible instead of assumed: results decide.
    // A page that yielded hits is a page that answered, whatever else is in its
    // markup. Reporting "blocked" over a page full of results would be a worse
    // bug than the one this detector fixes, because it would throw away answers
    // we actually got.
    installFetchMock(() => ({ status: 202, body: `${DDG_LITE}<form action="//duckduckgo.com/anomaly.js?sv=html"></form>` }));
    const r = await searchViaKeyless("ddglite", "token bucket");
    expect(r.hits.map((h) => h.url)).toEqual(["https://a.test/one", "https://b.test/two"]);
    expect(r.blocked).toBeFalsy();
    expect(r.note).toBeUndefined();
  });

  it("still calls a genuinely empty result page empty", async () => {
    // The distinction has to hold in both directions, or the fix trades one lie
    // for another: a query nobody has an answer for is not a block.
    installFetchMock(() => ({ status: 200, body: "<html><body><h1>No results found</h1></body></html>" }));
    const r = await searchViaKeyless("ddg", "asdkjhasdkjhasd");
    expect(r.blocked).toBeFalsy();
    expect(r.throttled).toBeFalsy();
    expect(r.note).toMatch(/returned no results/);
  });

  it("still calls a 404 unreachable — that one really is the host, not the bot policy", async () => {
    installFetchMock(() => ({ status: 404, body: "" }));
    const r = await searchViaKeyless("ddg", "x");
    expect(r.blocked).toBeFalsy();
    expect(r.note).toMatch(/unreachable/);
  });

  it("tells the caller every engine was blocked instead of that the web was empty", async () => {
    // The cascade's closing note is what a caller shows its user. "No results
    // from any engine" over three blocked engines is the sentence that turns a
    // refusal into a finding about the world.
    installFetchMock((url) => (url.includes("mojeek") ? { status: 403, body: MOJEEK_403 } : { status: 202, body: DDG_CHALLENGE }));
    const r = await search("SORARE SAINT-MANDE", { engines: ["ddg", "ddglite", "mojeek"] });
    expect(r.hits).toHaveLength(0);
    expect(r.notes.filter((n) => /blocked|challenge|captcha/i.test(n)).length).toBeGreaterThanOrEqual(3);
    expect(r.notes.at(-1)).toMatch(/every keyless engine|all .* blocked/i);
    expect(r.notes.at(-1)).not.toMatch(/^No results from any engine/);
  });

  it("still says 'no results from any engine' when they answered and found nothing", async () => {
    installFetchMock(() => ({ body: "<html>nothing</html>" }));
    const r = await search("asdkjhasdkjhasd", { engines: ["ddg", "ddglite", "mojeek"] });
    expect(r.notes.at(-1)).toMatch(/No results from any engine/);
  });
});

describe("Mojeek is asked in the territory's language", () => {
  it("carries the locale into the query, like the DuckDuckGo endpoints do", async () => {
    // `search()` promises its callers that a run over a French territory asks in
    // French. Two of the three engines were given `kl`; Mojeek's URL builder
    // dropped it on the floor, so the one engine with its own independent index
    // answered a French prospecting run in whatever it felt like.
    // `lb` (prefer this language) and `rb` (prefer this region) are Mojeek's own
    // documented parameter names, with `lbb`/`rbb` as their boost weights. They
    // are PREFERENCES rather than the `lr`/`reg` restrictions, on purpose: an
    // endpoint that ignores a preference loses nothing, while a restriction that
    // lands wrong empties the result page — which is the failure this whole file
    // is about.
    const spy = installFetchMock(() => ({ body: MOJEEK }));
    await searchViaKeyless("mojeek", "boulangerie Vincennes", { lang: "fr-FR" });
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain("mojeek.com");
    expect(url).toMatch(/[?&]lb=fr\b/);
    expect(url).toMatch(/[?&]rb=FR\b/);
  });

  it("asks for nothing in particular when no locale was given", async () => {
    const spy = installFetchMock(() => ({ body: MOJEEK }));
    await searchViaKeyless("mojeek", "x");
    const url = String(spy.mock.calls[0]![0]);
    expect(url).not.toMatch(/[?&]lb=/);
    expect(url).not.toMatch(/[?&]rb=/);
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
