import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// Real result pages, captured from the live endpoints and trimmed to their first
// few results (the region list cut to three entries). Hand-written fixtures are
// not enough on their own: the DDG Lite one spelled `class="result-snippet"`
// with double quotes, the real page uses single ones, and every Lite snippet
// came back empty while this suite stayed green.
const here = dirname(fileURLToPath(import.meta.url));
const capture = (name: string) => readFileSync(join(here, "fixtures", "engines", name), "utf8");
const DDG_LITE = capture("ddg-lite.html");
const DDG_HTML_PAGE = capture("ddg-html.html");
const MOJEEK_PAGE = capture("mojeek.html");
const LITE_URLS = ["https://www.speedtest.net/", "https://fast.com/", "https://www.highspeedinternet.com/tools/speed-test"];

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

  it("keeps a highlighted word whole", () => {
    // The engines wrap matched terms in <b>/<strong>, often mid-word or right
    // before punctuation. Inline markup is not a word break; a block is.
    expect(stripTags("&quot;<b>Foo</b> was here&quot;")).toBe('"Foo was here"');
    expect(stripTags("Holman&#x27;s <b>foo</b>.")).toBe("Holman's foo.");
    expect(stripTags("hostmaster.<strong>microsoft</strong>.<strong>com</strong>")).toBe("hostmaster.microsoft.com");
    expect(stripTags("one<br>two</p><p>three")).toBe("one two three");
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

  it("reads DuckDuckGo Lite's flat table, snippets included", () => {
    // The real page quotes its classes with SINGLE quotes (`class='result-snippet'`).
    const hits = parseDdgLite(DDG_LITE);
    expect(hits.map((h) => h.url)).toEqual(LITE_URLS);
    expect(hits.every((h) => h.snippet.length > 40)).toBe(true);
    expect(hits[1]!.title).toBe("Internet Speed Test | Fast.com");
    expect(hits[1]!.snippet).toMatch(/^Download speed is most relevant for people/);
    expect(hits[1]!.snippet).toContain('When you click the "Show more info" button');
  });

  it("reads a real DuckDuckGo HTML page", () => {
    const hits = parseDdgHtml(DDG_HTML_PAGE);
    expect(hits.map((h) => h.url)).toEqual([
      "https://en.wikipedia.org/wiki/Foo_Fighters",
      "https://www.dictionary.com/e/tech-science/foo/",
      "https://www.britannica.com/topic/Foo-Fighters",
    ]);
    expect(hits[1]!.title).toBe("foo | Meaning & Origin - Dictionary.com");
    expect(hits[1]!.snippet).toMatch(/^"Foo was here" was a popular piece of graffiti/);
  });

  it("reads a real Mojeek page", () => {
    const hits = parseMojeek(MOJEEK_PAGE);
    expect(hits).toHaveLength(6);
    expect(hits[0]).toMatchObject({
      url: "https://learn.microsoft.com/en-us/azure/dns/dns-delegate-domain-azure-dns",
      title: "Tutorial: Host your domain in Azure DNS | Microsoft Learn",
    });
    // Mojeek bolds the matched terms mid-word: a space per tag used to turn
    // this into "azure-dns. com" and "hostmaster. microsoft . com".
    expect(hits[0]!.snippet).toContain("primary name server = ns1-37.azure-dns.com responsible mail addr = azuredns-hostmaster.microsoft.com serial");
    // The "see more results from this site" line is Mojeek's, not the snippet.
    expect(hits.every((h) => !/See more results/.test(h.snippet))).toBe(true);
  });

  it("decodes the entities in an href before reading it", () => {
    // An href is HTML: `&amp;` in it is a plain `&`. Taken raw, the second
    // parameter became `amp;t`, and a DDG redirector whose `uddg` is not first
    // was not unwrapped at all, so the result was dropped as a DDG link.
    expect(parseMojeek(`<a class="title" href="https://www.youtube.com/watch?v=abc&amp;t=10">Video</a><p class="s">x</p>`)[0]!.url).toBe(
      "https://www.youtube.com/watch?v=abc&t=10",
    );
    const ddg = `<a class="result__a" href="//duckduckgo.com/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.org%2Fok&amp;rut=x">ok</a><a class="result__snippet">s</a>`;
    expect(parseDdgHtml(ddg).map((h) => h.url)).toEqual(["https://example.org/ok"]);
  });

  it("drops only the engine's own links, not results that mention it", () => {
    // A query about DuckDuckGo's privacy policy should find duckduckgo.com's
    // privacy policy. What is DDG's own is what STAYS on duckduckgo.com after
    // the redirector is unwrapped: an ad's click-through.
    const ddg = [
      `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fprivacy&amp;rut=x">Privacy</a><a class="result__snippet">a</a>`,
      `<a class="result__a" href="//duckduckgo.com/y.js?ad_domain=shop.test&amp;u3=https%3A%2F%2Fwww.bing.com%2Faclick">Sponsored</a><a class="result__snippet">b</a>`,
      `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fweb.archive.org%2Fweb%2F2020%2Fhttps%3A%2F%2Fduckduckgo.com%2F">Archived</a><a class="result__snippet">c</a>`,
      `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2F%3Fref%3Dduckduckgo.com">Ref</a><a class="result__snippet">d</a>`,
    ].join("\n");
    expect(parseDdgHtml(ddg).map((h) => h.url)).toEqual([
      "https://duckduckgo.com/privacy",
      "https://web.archive.org/web/2020/https://duckduckgo.com/",
      "https://example.org/?ref=duckduckgo.com",
    ]);
    const mojeek = [
      `<a class="title" href="https://blog.mojeek.com/2024/01/x.html">Mojeek blog</a><p class="s">a</p>`,
      `<a class="title" href="https://www.mojeek.com/search?q=site%3Aexample.org">More from example.org</a><p class="s">b</p>`,
      `<a class="title" href="https://en.wikipedia.org/wiki/Mojeek">Mojeek - Wikipedia</a><p class="s">c</p>`,
    ].join("\n");
    expect(parseMojeek(mojeek).map((h) => h.url)).toEqual(["https://blog.mojeek.com/2024/01/x.html", "https://en.wikipedia.org/wiki/Mojeek"]);
  });

  it("matches a class as a whole token, so `sub-title` is not a result", () => {
    const mj = `<a class="title" href="https://a.test/1">A</a><p class="s">a</p><a class="sub-title" href="https://nav.test/">Nav</a><a class="title" href="https://b.test/2">B</a><p class="s">b</p>`;
    expect(parseMojeek(mj).map((h) => h.url)).toEqual(["https://a.test/1", "https://b.test/2"]);
  });

  it("parses a hostile body in linear time", () => {
    // Every result anchor used to scan `[^>]*` to the end of the body when no
    // `>` followed, so a page of unclosed anchors cost O(n²): 48 KB took 4.8 s.
    // These bodies are 200-600 KB, and the bound is generous on purpose: linear
    // work finishes in milliseconds, the quadratic kind in minutes.
    const hostile = [
      `<a class="title" href="https://x.test/">t</a>${'<a class="'.repeat(40_000)}`,
      `<a class="result__a" href="https://x.test/">t</a>${"<a ".repeat(100_000)}`,
      `<a class='result-link' href='https://x.test/'>${"<".repeat(300_000)}</a>`,
      `<a class="title" href="https://x.test/">t</a>${'<p class="s">'.repeat(40_000)}`,
      `<a class="result__a" href="https://x.test/">t</a>${'<a class="result__a" href="https://y.test/">'.repeat(10_000)}`,
    ];
    for (const body of hostile) {
      for (const parse of [parseDdgHtml, parseDdgLite, parseMojeek]) {
        const t0 = performance.now();
        parse(body);
        expect(performance.now() - t0).toBeLessThan(1500);
      }
    }
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
    expect(r.hits.map((h) => h.url)).toEqual(LITE_URLS);
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
    expect(r.hits).toHaveLength(3);
  });

  it("keeps page one's results when a later page fails", async () => {
    let n = 0;
    installFetchMock(() => {
      n++;
      return n === 1 ? { body: DDG_LITE } : { status: 500, body: "" };
    });
    const r = await searchViaKeyless("ddglite", "x", { pages: 3, limit: 50 });
    expect(r.hits).toHaveLength(3);
    expect(r.note).toBeUndefined();
  });

  it("refuses an empty query without a request", async () => {
    const spy = installFetchMock(() => ({ body: DDG_LITE }));
    expect((await searchViaKeyless("ddg", "   ")).note).toBe("Empty query.");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("DuckDuckGo pagination follows the page's own Next form", () => {
  // Both endpoints serve 10 results on a first page, whose Next form posts
  // `s=10, dc=11` plus a `vqd` session token. The arithmetic this replaced sent
  // `s=30` for page two and skipped results 11 to 30.
  const params = (url: string) => new URL(url).searchParams;
  // A later page: new destinations, a Previous form first, then a Next form.
  const PAGE_TWO = DDG_LITE.replaceAll("uddg=https%3A%2F%2F", "uddg=https%3A%2F%2Fp2.")
    .replace('value="Next Page &gt;"', 'value="&lt; Previous Page"')
    .replace('name="s" value="10"', 'name="s" value="0"')
    .replace('name="s" value="10"', 'name="s" value="20"');
  const LAST_PAGE = DDG_LITE.replaceAll("uddg=https%3A%2F%2F", "uddg=https%3A%2F%2Fend.").replaceAll('value="Next Page &gt;"', 'value="&lt; Previous Page"');

  it("asks for the offset the page names, with its dc and vqd", async () => {
    const bodies = [DDG_LITE, PAGE_TWO, LAST_PAGE];
    const spy = installFetchMock(() => ({ body: bodies.shift() ?? "" }));
    const r = await searchViaKeyless("ddglite", "speed test", { pages: 5, limit: 50 });
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(3); // the third page has no Next form: that is the end
    expect(params(urls[1]!).get("s")).toBe("10");
    expect(params(urls[1]!).get("dc")).toBe("11");
    expect(params(urls[1]!).get("vqd")).toBe("4-268808268255134853854469240455883644435");
    expect(params(urls[1]!).get("q")).toBe("speed test");
    // Page two carries a Previous form too; the offset comes from Next.
    expect(params(urls[2]!).get("s")).toBe("20");
    expect(r.hits).toHaveLength(9);
  });

  it("stops at a page with no Next form rather than asking again", async () => {
    const spy = installFetchMock(() => ({ body: LAST_PAGE }));
    const r = await searchViaKeyless("ddglite", "x", { pages: 5, limit: 50 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.hits).toHaveLength(3);
  });

  it("reads the Next form on the HTML endpoint too", async () => {
    const bodies = [DDG_HTML_PAGE, "<html>nothing more</html>"];
    const spy = installFetchMock(() => ({ body: bodies.shift() ?? "" }));
    await searchViaKeyless("ddg", "foo", { pages: 2, limit: 50 });
    const second = String(spy.mock.calls[1]![0]);
    expect(second).toMatch(/^https:\/\/html\.duckduckgo\.com\/html\/\?/);
    expect(params(second).get("s")).toBe("10");
    expect(params(second).get("dc")).toBe("11");
    expect(params(second).get("vqd")).toBe("4-147952856996157918820153826655300912381");
  });

  it("keeps Mojeek's own 1-based offset", async () => {
    const bodies = [MOJEEK_PAGE, "<html>nothing more</html>"];
    const spy = installFetchMock(() => ({ body: bodies.shift() ?? "" }));
    await searchViaKeyless("mojeek", "host:microsoft.com", { pages: 2, limit: 50 });
    expect(params(String(spy.mock.calls[1]![0])).get("s")).toBe("11");
  });
});

describe("an unlocalised query asks DuckDuckGo for no region", () => {
  // `us-en` for a caller who named no locale biased every such query toward
  // American pages. `wt-wt` is DuckDuckGo's own "All Regions".
  it("sends kl=wt-wt when neither a language nor a region was given", async () => {
    const spy = installFetchMock(() => ({ body: "<html></html>" }));
    await searchViaKeyless("ddg", "boulangerie");
    await searchViaKeyless("ddglite", "boulangerie");
    for (const [u] of spy.mock.calls) expect(new URL(String(u)).searchParams.get("kl")).toBe("wt-wt");
  });

  it("still localises when asked", async () => {
    const spy = installFetchMock(() => ({ body: "<html></html>" }));
    await searchViaKeyless("ddg", "boulangerie", { lang: "fr-FR" });
    expect(new URL(String(spy.mock.calls[0]![0])).searchParams.get("kl")).toBe("fr-fr");
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
    // (The marker leads the body: the detector only reads its head.)
    installFetchMock(() => ({ status: 202, body: `<form action="//duckduckgo.com/anomaly.js?sv=html"></form>${DDG_LITE}` }));
    const r = await searchViaKeyless("ddglite", "token bucket");
    expect(r.hits.map((h) => h.url)).toEqual(LITE_URLS);
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

describe("a cascade in which no engine answered says nothing was searched", () => {
  // Blocked is one way of not being asked. Offline, a 5xx, a timeout and a
  // rate limit are others, and each ended in "No results from any engine" with
  // the engines' own notes dropped — the refusal-as-finding this file exists
  // to prevent.
  const ALL = { engines: ["ddg", "ddglite", "mojeek"] as ("ddg" | "ddglite" | "mojeek")[] };
  const offline = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: `getaddrinfo ENOTFOUND ${new URL(u).hostname}` } });
      }),
    );

  it("keeps every engine's failure and closes on 'nothing was searched' when offline", async () => {
    offline();
    const r = await search("x", ALL);
    expect(r.hits).toHaveLength(0);
    expect(r.notes.filter((n) => /^(DuckDuckGo|DuckDuckGo Lite|Mojeek) unreachable/.test(n))).toHaveLength(3);
    expect(r.notes.join(" ")).toContain("ENOTFOUND");
    expect(r.notes.join(" ")).not.toContain("status 0");
    expect(r.notes.at(-1)).toMatch(/nothing was searched/i);
    expect(r.notes.at(-1)).not.toMatch(/^No results from any engine/);
  });

  it.each([
    ["every engine answering 502", () => ({ status: 502, body: "bad gateway" })],
    ["every engine rate-limiting", () => ({ status: 429, body: "" })],
    [
      "a mix of 403, 429 and a captcha",
      (url: string) =>
        url.includes("html.duckduckgo")
          ? { status: 403, body: DDG_403 }
          : url.includes("lite.")
            ? { status: 429, body: "" }
            : { status: 200, body: MOJEEK_CAPTCHA },
    ],
  ])("does the same for %s", async (_label, router) => {
    installFetchMock(router);
    const r = await search("x", ALL);
    expect(r.notes.filter((n) => /DuckDuckGo|Mojeek/.test(n)).length).toBeGreaterThanOrEqual(3);
    expect(r.notes.at(-1)).toMatch(/nothing was searched/i);
  });

  it("names a timeout as a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init?: RequestInit) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError"))),
          ),
      ),
    );
    const r = await searchViaKeyless("ddg", "x", { timeoutMs: 20 });
    expect(r.note).toMatch(/DuckDuckGo unreachable \(timed out after 20 ms\)/);
    expect(r.answered).toBeFalsy();
  });

  it("calls an empty 200 an empty page, not an unreachable host", async () => {
    installFetchMock(() => ({ status: 200, body: "" }));
    const r = await searchViaKeyless("ddg", "x");
    expect(r.note).toBe("DuckDuckGo returned an empty page (HTTP 200).");
    expect(r.answered).toBeFalsy();
  });

  it("says the same in data: each engine's outcome, and searched=false", async () => {
    installFetchMock((url) =>
      url.includes("html.duckduckgo") ? { status: 403, body: DDG_403 } : url.includes("lite.") ? { status: 502, body: "" } : { status: 429, body: "" },
    );
    const r = await search("x", ALL);
    expect(r.searched).toBe(false);
    expect(r.rungs?.map((x) => [x.rung, x.outcome])).toEqual([
      ["searxng", "disabled"],
      ["ddg", "blocked"],
      ["ddglite", "error"],
      ["mojeek", "throttled"],
      ["firecrawl", "disabled"],
    ]);
    offline();
    expect((await search("x", ALL)).rungs?.filter((x) => x.outcome === "unreachable")).toHaveLength(3);
  });

  it("marks a page it could read as answered, results or not", async () => {
    installFetchMock(() => ({ body: "<html>nothing</html>" }));
    expect((await searchViaKeyless("ddg", "x")).answered).toBe(true);
    installFetchMock(() => ({ body: DDG_LITE }));
    expect((await searchViaKeyless("ddglite", "x")).answered).toBe(true);
    installFetchMock(() => ({ status: 202, body: DDG_CHALLENGE }));
    expect((await searchViaKeyless("ddg", "x")).answered).toBeFalsy();
  });
});

describe("a search is bounded in time", () => {
  // Every rung went through the default retry: a 429 was asked twice (the
  // cascade's next rung IS the retry), and with no overall deadline one
  // search() could outlast any MCP host's patience.
  const ALL = { engines: ["ddg", "ddglite", "mojeek"] as ("ddg" | "ddglite" | "mojeek")[] };
  const hanging = () =>
    vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError"))),
        ),
    );

  it("asks a throttling engine once, and moves on", async () => {
    const spy = installFetchMock(() => ({ status: 429, body: "" }));
    await search("x", ALL);
    expect(spy).toHaveBeenCalledTimes(3);
    installFetchMock(() => ({ status: 503, body: "" }));
    const one = vi.mocked(globalThis.fetch);
    await searchViaKeyless("mojeek", "x");
    expect(one).toHaveBeenCalledTimes(1);
  });

  it("stops at the overall budget and says which rungs it never reached", async () => {
    const spy = hanging();
    vi.stubGlobal("fetch", spy);
    const t0 = performance.now();
    const r = await search("x", { ...ALL, timeoutMs: 150 });
    expect(performance.now() - t0).toBeLessThan(3000); // not 3 × 12 s
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.rungs?.map((x) => [x.rung, x.outcome])).toEqual([
      ["searxng", "disabled"],
      ["ddg", "unreachable"],
      ["ddglite", "not-tried"],
      ["mojeek", "not-tried"],
      ["firecrawl", "disabled"],
    ]);
    expect(r.notes.join(" ")).toMatch(/Stopped before ddglite, mojeek: the 150 ms budget ran out/);
    expect(r.searched).toBe(false);
  });

  it("does not start once the caller's signal has fired", async () => {
    const spy = installFetchMock(() => ({ body: DDG_LITE }));
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await search("x", { ...ALL, signal: ctrl.signal });
    expect(spy).not.toHaveBeenCalled();
    expect(r.hits).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/cancelled/);
  });

  it("checks the signal between rungs and between pages", async () => {
    const ctrl = new AbortController();
    const spy = installFetchMock(() => {
      ctrl.abort(); // the caller gives up while page one is in flight
      return { body: "<html>nothing</html>" };
    });
    const r = await search("x", { ...ALL, signal: ctrl.signal });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.rungs?.find((x) => x.rung === "ddglite")?.outcome).toBe("not-tried");

    const later = new AbortController();
    const paged = installFetchMock(() => {
      later.abort();
      return { body: DDG_LITE };
    });
    const walked = await searchViaKeyless("ddglite", "x", { pages: 3, limit: 50, signal: later.signal });
    expect(paged).toHaveBeenCalledTimes(1); // page two never asked
    expect(walked.hits).toHaveLength(3); // page one's results stand
  });
});

describe("the notes name the switch the user actually threw", () => {
  it("reports engine names it does not know, instead of dropping the rung in silence", async () => {
    vi.stubEnv(envName("ENGINES"), "duckduckgo,mojek");
    const spy = installFetchMock(() => ({ body: DDG_LITE }));
    const r = await search("x");
    expect(spy).not.toHaveBeenCalled();
    expect(r.notes.join(" ")).toMatch(new RegExp(`${envName("ENGINES")} names no engine .*duckduckgo, mojek`));
    expect(r.notes.at(-1)).toMatch(/No search backend was enabled/);
    expect(r.notes.at(-1)).not.toMatch(/No results/);
  });

  it("still reports the one it ignored when the others work", async () => {
    vi.stubEnv(envName("ENGINES"), "ddglite,googol");
    installFetchMock(() => ({ body: DDG_LITE }));
    const r = await search("x");
    expect(r.hits).toHaveLength(3);
    expect(r.notes.join(" ")).toContain("googol");
  });

  it("names the flag as well as the variable when SearXNG is off", async () => {
    const r = await search("x", { searxng: "off", engines: [] });
    expect(r.notes[0]).toMatch(/--searxng off/);
    expect(r.notes[0]).toContain(`${envName("SEARXNG")}=off`);
  });

  it("does not call a run with every backend switched off a search that found nothing", async () => {
    const r = await search("x", { engines: [] });
    expect(r.notes.at(-1)).toMatch(/No search backend was enabled/);
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

  it("keeps the language but boosts no region under --region wt", async () => {
    // `wt` is "no region": boosting a country called WT would be a guess.
    const spy = installFetchMock(() => ({ body: MOJEEK }));
    await searchViaKeyless("mojeek", "x", { lang: "fr", region: "wt" });
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toMatch(/[?&]lb=fr\b/);
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
    expect(r.hits.map((h) => h.via)).toEqual(["ddglite", "ddglite", "ddglite"]);
    expect(r.hits[0]!.url).toBe(LITE_URLS[0]);
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
    expect(r.searched).toBe(true);
    expect(r.rungs?.map((x) => [x.rung, x.outcome, x.hits])).toEqual([
      ["searxng", "disabled", undefined],
      ["ddg", "empty", undefined],
      ["ddglite", "empty", undefined],
      ["mojeek", "hits", 2],
      ["firecrawl", "disabled", undefined],
    ]);
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
