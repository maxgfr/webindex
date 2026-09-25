import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { awaitHostSlot, backOffHost, crawlSite, hostDelayMs, linksFrom, resetHostSchedule } from "../src/crawl.js";
import { resetRobotsCache } from "../src/robots.js";
import { installFetchMock } from "./fetchmock.js";

beforeEach(() => {
  resetHostSchedule();
  resetRobotsCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetHostSchedule();
  resetRobotsCache();
});

const html = (body: string) => ({ status: 200, body: `<html><body>${body}</body></html>`, contentType: "text/html" });

describe("per-host politeness", () => {
  it("lets the first request through without waiting", async () => {
    expect(await awaitHostSlot("https://a.test/1", 100, 1000)).toBe(0);
  });

  it("makes the next request to the same host wait out the delay", async () => {
    await awaitHostSlot("https://a.test/1", 100, 1000);
    // A second caller arriving immediately must wait the full delay.
    expect(await awaitHostSlot("https://a.test/2", 0, 1000)).toBe(0); // delay 0 disables
    resetHostSchedule();
    await awaitHostSlot("https://a.test/1", 100, 1000);
    const waited = await awaitHostSlot("https://a.test/2", 1, 1000);
    expect(waited).toBe(100);
  });

  it("claims the slot before awaiting, so two concurrent callers serialise", async () => {
    // The bug a naive "sleep if too soon" has: both read the same free time,
    // both decide they may go, and both leave together. Claiming first is what
    // makes the third caller wait 2x rather than 1x.
    const [a, b, c] = await Promise.all([
      awaitHostSlot("https://a.test/1", 50, 0),
      awaitHostSlot("https://a.test/2", 50, 0),
      awaitHostSlot("https://a.test/3", 50, 0),
    ]);
    expect([a, b, c]).toEqual([0, 50, 100]);
  });

  it("never makes one host wait on another", async () => {
    await awaitHostSlot("https://a.test/1", 500, 0);
    expect(await awaitHostSlot("https://b.test/1", 500, 0)).toBe(0);
  });

  it("applies a back-off to every request queued for that host, not just the one that got it", async () => {
    backOffHost("https://a.test/1", 300, 0);
    expect(await awaitHostSlot("https://a.test/2", 1, 0)).toBe(300);
  });

  it("backs the whole host off when a crawled page answers with Retry-After", async () => {
    // httpGet honours Retry-After for the request that received it; the rest
    // of the walk to that host must honour it too.
    installFetchMock((url) => (url.includes("/robots.txt") ? undefined : { status: 429, body: "", headers: { "retry-after": "30" } }));
    const r = await crawlSite("https://rl.test/", { maxPages: 1, useSitemap: false, ignoreRobots: true, delayMs: 0 });
    expect(r.pages).toEqual([]);
    vi.useFakeTimers();
    try {
      const waited = awaitHostSlot("https://rl.test/next", 1);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await waited).toBeGreaterThan(29_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a delay of zero and an unparseable URL", async () => {
    expect(await awaitHostSlot("https://a.test", 0, 0)).toBe(0);
    expect(await awaitHostSlot("not a url", 100, 0)).toBe(0);
  });

  it("reads the consumer's own politeness knob", () => {
    process.env[envName("POLITE_DELAY_MS")] = "900";
    expect(hostDelayMs()).toBe(900);
  });
});

describe("linksFrom", () => {
  it("resolves relative links against the page", () => {
    expect(linksFrom('<a href="/b">b</a><a href="c">c</a>', "https://a.test/dir/page")).toEqual(["https://a.test/b", "https://a.test/dir/c"]);
  });

  it("drops what is not a page", () => {
    // new URL() accepts mailto: and tel: happily and hands back something no
    // fetch can use.
    expect(linksFrom('<a href="mailto:x@y.z">m</a><a href="tel:123">t</a><a href="javascript:void(0)">j</a>', "https://a.test/")).toEqual([]);
  });

  it("collapses fragments and duplicates to one link", () => {
    expect(linksFrom('<a href="/b#one">1</a><a href="/b#two">2</a><a href="/b">3</a>', "https://a.test/")).toEqual(["https://a.test/b"]);
  });

  it("survives a malformed href", () => {
    expect(linksFrom('<a href="http://[bad">x</a><a href="/ok">y</a>', "https://a.test/")).toEqual(["https://a.test/ok"]);
  });

  it("reads an unquoted href, which minified HTML is full of", () => {
    expect(linksFrom("<a href=/about>About</a><a class=x href=docs/intro>Intro</a>", "https://a.test/dir/")).toEqual([
      "https://a.test/about",
      "https://a.test/dir/docs/intro",
    ]);
  });

  it("reads href itself, not a data-href that comes first", () => {
    expect(linksFrom('<a data-href="/tracking" href="/real">x</a>', "https://a.test/")).toEqual(["https://a.test/real"]);
  });

  it("resolves against the page's <base href>", () => {
    const html = '<head><base href="https://a.test/docs/"></head><a href="child">c</a><a href="/root">r</a>';
    expect(linksFrom(html, "https://a.test/dir/page")).toEqual(["https://a.test/docs/child", "https://a.test/root"]);
    // A relative base resolves against the page; a broken one is ignored.
    expect(linksFrom('<base href="../up/"><a href="x">x</a>', "https://a.test/a/b/page")).toEqual(["https://a.test/a/up/x"]);
    expect(linksFrom('<base href="http://[bad"><a href="x">x</a>', "https://a.test/a/page")).toEqual(["https://a.test/a/x"]);
  });

  it("does not follow links that are commented out or live in a script", () => {
    const html = '<!-- <a href="/old-admin">old</a> --><script>var s = \'<a href="/in-script">\';</script><a href="/live">live</a>';
    expect(linksFrom(html, "https://a.test/")).toEqual(["https://a.test/live"]);
  });

  it("reads image-map areas, and not <abbr> or <link>", () => {
    expect(linksFrom('<map><area href="/region"></map><abbr href="/no">x</abbr><link href="/style.css">', "https://a.test/")).toEqual([
      "https://a.test/region",
    ]);
  });

  it("scans a page of unclosed anchors in linear time", () => {
    // `<a\b[^>]*?\bhref…` rescanned to the end of the page from every `<a`
    // start: 400 KB of `<a x` took ten seconds.
    const started = performance.now();
    expect(linksFrom("<a x".repeat(100_000), "https://a.test/")).toEqual([]);
    expect(linksFrom(`<a href="${"<a ".repeat(50_000)}`, "https://a.test/")).toEqual([]);
    expect(linksFrom('<a title="'.repeat(50_000), "https://a.test/")).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("crawlSite", () => {
  /** A small site: / links to /a and /b; /a links to /deep. */
  const site = (extra: Record<string, string> = {}) =>
    installFetchMock((url) => {
      if (url.includes("robots.txt")) return { status: 404, body: "", contentType: "text/plain" };
      if (url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      if (extra[url]) return html(extra[url] as string);
      if (url === "https://s.test/") return html('<p>root</p><a href="/a">a</a><a href="/b">b</a>');
      if (url === "https://s.test/a") return html('<p>page a</p><a href="/deep">deep</a>');
      if (url === "https://s.test/b") return html("<p>page b</p>");
      if (url === "https://s.test/deep") return html("<p>deep</p>");
      if (url.startsWith("https://other.test")) return html("<p>elsewhere</p>");
      return undefined;
    });

  it("walks breadth-first from the seed", async () => {
    site();
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 2, useSitemap: false, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/", "https://s.test/a", "https://s.test/b", "https://s.test/deep"]);
    expect(r.pages.map((p) => p.depth)).toEqual([0, 1, 1, 2]);
  });

  it("stops at the page budget and says what it left", async () => {
    // A budget that ran out and a site that ended look identical from outside.
    site();
    const r = await crawlSite("https://s.test/", { maxPages: 2, maxDepth: 2, useSitemap: false, delayMs: 0 });
    expect(r.pages).toHaveLength(2);
    // /a was read before the budget ran out, so its own link is queued too —
    // pending is the real frontier, not just what the seed pointed at.
    expect(r.pending).toEqual(["https://s.test/b", "https://s.test/deep"]);
    expect(r.notes.join(" ")).toMatch(/stopped at the 2-page budget with 2 URL\(s\) still queued/);
  });

  it("stops at the depth limit", async () => {
    site();
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).not.toContain("https://s.test/deep");
  });

  it("reads only the seed at depth 0", async () => {
    site();
    const r = await crawlSite("https://s.test/", { maxDepth: 0, useSitemap: false, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/"]);
  });

  it("stays on the seed's origin unless told otherwise", async () => {
    site({ "https://s.test/": '<a href="/a">a</a><a href="https://other.test/x">out</a>' });
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/", "https://s.test/a"]);
  });

  it("crosses origins when asked", async () => {
    site({ "https://s.test/": '<a href="https://other.test/x">out</a>' });
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, useSitemap: false, crossOrigin: true, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toContain("https://other.test/x");
  });

  it("visits a URL once however many pages link to it", async () => {
    site({ "https://s.test/": '<a href="/a">1</a><a href="/a">2</a><a href="/a#x">3</a>' });
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(r.pages.filter((p) => p.url.endsWith("/a"))).toHaveLength(1);
  });

  it("asks robots at EVERY hop, and reports what it was refused", async () => {
    // The difference between this and `fetch`: following one citation is not
    // crawling and does not ask; enumerating is, and does.
    installFetchMock((url) => {
      if (url.includes("robots.txt")) return { status: 200, body: "User-agent: *\nDisallow: /b", contentType: "text/plain" };
      if (url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      if (url === "https://s.test/") return html('<a href="/a">a</a><a href="/b">b</a>');
      return html("<p>ok</p>");
    });
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/", "https://s.test/a"]);
    expect(r.disallowed).toEqual(["https://s.test/b"]);
  });

  it("honours a declared Crawl-delay, and says that it did", async () => {
    installFetchMock((url) => {
      if (url.includes("robots.txt")) return { status: 200, body: "User-agent: *\nCrawl-delay: 0.001", contentType: "text/plain" };
      if (url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      return html("<p>ok</p>");
    });
    const r = await crawlSite("https://s.test/", { maxPages: 1, maxDepth: 0, useSitemap: false });
    expect(r.notes.join(" ")).toMatch(/honouring the declared Crawl-delay of 1ms/);
  });

  it("seeds the frontier from the sitemap, which is the site's own statement of what to find", async () => {
    installFetchMock((url) => {
      if (url.includes("robots.txt")) return { status: 404, body: "", contentType: "text/plain" };
      if (url.includes("sitemap.xml"))
        return { status: 200, body: "<urlset><url><loc>https://s.test/listed</loc></url></urlset>", contentType: "application/xml" };
      return html("<p>ok</p>");
    });
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toContain("https://s.test/listed");
    expect(r.notes.join(" ")).toMatch(/seeded 1 URL\(s\) from the sitemap/);
  });

  it("says when there was no robots.txt at all", async () => {
    site();
    const r = await crawlSite("https://s.test/", { maxPages: 1, maxDepth: 0, useSitemap: false, delayMs: 0 });
    expect(r.notes.join(" ")).toMatch(/no robots\.txt/);
  });

  it("names ignoring robots as the deliberate act it is", async () => {
    site();
    const r = await crawlSite("https://s.test/", { maxPages: 1, maxDepth: 0, useSitemap: false, ignoreRobots: true, delayMs: 0 });
    expect(r.notes.join(" ")).toMatch(/only correct on a site you own/);
  });

  it("notes a page it could not read rather than dropping it silently", async () => {
    installFetchMock((url) => {
      if (url.includes("robots.txt") || url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      if (url === "https://s.test/") return html('<a href="/gone">g</a>');
      return { status: 500, body: "", contentType: "text/plain" };
    });
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(r.pages).toHaveLength(1);
    expect(r.notes.join(" ")).toContain("https://s.test/gone");
  });

  it("streams each page to the caller as it lands", async () => {
    site();
    const seen: string[] = [];
    await crawlSite("https://s.test/", { maxPages: 3, maxDepth: 1, useSitemap: false, delayMs: 0, onPage: (p) => seen.push(p.url) });
    expect(seen).toEqual(["https://s.test/", "https://s.test/a", "https://s.test/b"]);
  });
});

describe("crawlSite concurrency", () => {
  const LEAVES = 10;
  /** A hub with LEAVES children; each child answers after `latencyOf(i)` ms. */
  function wideSite(latencyOf: (i: number) => number, extra: (url: string) => ReturnType<Parameters<typeof installFetchMock>[0]> = () => undefined) {
    const inner = installFetchMock((url) => {
      if (url.includes("robots.txt") || url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      const custom = extra(url);
      if (custom) return custom;
      if (url === "https://s.test/") return html(Array.from({ length: LEAVES }, (_, i) => `<a href="/p${i}">${i}</a>`).join(""));
      const m = /\/p(\d+)$/.exec(url);
      if (m) return html(`<p>leaf ${m[1]}</p>`);
      return html("<p>elsewhere</p>");
    });
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const m = /\/p(\d+)$/.exec(url);
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        if (m) await new Promise((r) => setTimeout(r, latencyOf(Number(m[1]))));
        return await inner(input, init);
      } finally {
        inFlight--;
      }
    });
    return { inner, peak: () => peak };
  }

  it("keeps up to <PREFIX>_CRAWL_CONCURRENCY pages in flight, and never more", async () => {
    vi.stubEnv(envName("CRAWL_CONCURRENCY"), "3");
    const s = wideSite(() => 10);
    const r = await crawlSite("https://s.test/", { maxPages: 20, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(r.pages).toHaveLength(1 + LEAVES);
    expect(s.peak()).toBe(3);
  });

  it("is single-file at a concurrency of 1", async () => {
    vi.stubEnv(envName("CRAWL_CONCURRENCY"), "1");
    const s = wideSite(() => 2);
    await crawlSite("https://s.test/", { maxPages: 20, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(s.peak()).toBe(1);
  });

  it("lists pages, and streams them, in frontier order whatever order the answers arrived in", async () => {
    // The first link is the slowest, so arrival order is the reverse of link
    // order. Consumers number their sources from what they are handed: two runs
    // over one site must agree, so the network's timing cannot leak into either
    // the result or the callback. onPage fired in arrival order until a diff
    // against the sequential implementation caught it.
    wideSite((i) => (LEAVES - i) * 3);
    const arrived: string[] = [];
    const r = await crawlSite("https://s.test/", { maxPages: 20, maxDepth: 1, useSitemap: false, delayMs: 0, onPage: (p) => arrived.push(p.url) });
    const expected = ["https://s.test/", ...Array.from({ length: LEAVES }, (_, i) => `https://s.test/p${i}`)];
    expect(r.pages.map((p) => p.url)).toEqual(expected);
    expect(arrived).toEqual(expected);
  });

  it("streams a page as soon as everything ahead of it has been streamed", async () => {
    // Ordering the callback must not turn it into "wait for the whole wave":
    // the fast leaves behind a slow one are held, but everything before the
    // slow one goes out while it is still in flight.
    const seenWhileSlowInFlight: string[] = [];
    let slowResolved = false;
    // p3 answers last by a wide margin; p0..p2 answer immediately.
    wideSite((i) => (i === 3 ? 200 : 1));
    await crawlSite("https://s.test/", {
      maxPages: 20,
      maxDepth: 1,
      useSitemap: false,
      delayMs: 0,
      onPage: (p) => {
        if (p.url.endsWith("/p3")) slowResolved = true;
        if (!slowResolved) seenWhileSlowInFlight.push(p.url);
      },
    });
    // The seed and the three leaves before the slow one were all handed over
    // before it landed — the callback streams, it does not batch.
    expect(seenWhileSlowInFlight).toEqual(["https://s.test/", "https://s.test/p0", "https://s.test/p1", "https://s.test/p2"]);
  });

  it("never fetches past the page budget, even with a wide wave", async () => {
    const s = wideSite(() => 1);
    const r = await crawlSite("https://s.test/", { maxPages: 5, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(r.pages).toHaveLength(5);
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/", "https://s.test/p0", "https://s.test/p1", "https://s.test/p2", "https://s.test/p3"]);
    expect(r.pending).toEqual(Array.from({ length: LEAVES - 4 }, (_, i) => `https://s.test/p${i + 4}`));
    const pageFetches = s.inner.mock.calls.map((c) => String(c[0])).filter((u) => !/robots|sitemap/.test(u));
    expect(pageFetches).toHaveLength(5);
  });

  it("leaves a URL the budget never reached pending, rather than judging it against robots", async () => {
    // Found by diffing against the sequential implementation. Evaluating the
    // whole wave up front moved a robots-refused URL out of `pending` and into
    // `disallowed` even when the budget stopped long before it — which reads as
    // "you may not have this page" instead of "we ran out of budget", and is
    // the difference a caller acts on.
    installFetchMock((url) => {
      if (url.includes("robots.txt")) return { status: 200, body: "User-agent: *\nDisallow: /private", contentType: "text/plain" };
      if (url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      if (url === "https://s.test/") return html('<a href="/a">a</a><a href="/b">b</a><a href="/private">no</a>');
      return html("<p>ok</p>");
    });
    const r = await crawlSite("https://s.test/", { maxPages: 2, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/", "https://s.test/a"]);
    expect(r.pending).toEqual(["https://s.test/b", "https://s.test/private"]);
    expect(r.disallowed).toEqual([]);
    // …and with room to reach it, it IS reported as refused.
    resetRobotsCache();
    const full = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(full.disallowed).toEqual(["https://s.test/private"]);
  });

  it("does not ask a host for robots.txt when the budget will never reach it", async () => {
    // The other half of the same defect: a cross-origin wave used to fetch
    // every host's robots.txt up front, contacting hosts the crawl then never
    // visited. A crawl that stops at 2 pages must not knock on 3 doors.
    const spy = installFetchMock((url) => {
      if (url.includes("robots.txt")) return { status: 404, body: "", contentType: "text/plain" };
      if (url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      if (url === "https://s.test/") return html('<a href="https://one.test/x">1</a><a href="https://two.test/x">2</a><a href="https://three.test/x">3</a>');
      return html("<p>ok</p>");
    });
    const r = await crawlSite("https://s.test/", { maxPages: 2, maxDepth: 1, useSitemap: false, crossOrigin: true, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/", "https://one.test/x"]);
    const hosts = spy.mock.calls.map((c) => String(c[0])).filter((u) => u.endsWith("/robots.txt"));
    expect(hosts).toEqual(["https://s.test/robots.txt", "https://one.test/robots.txt"]);
  });

  it("spends a budget slot lost to an unreadable page on the next URL in line", async () => {
    // With 3 pages allowed and /p0 broken, the walk must go on to /p2 rather
    // than stop with the budget unspent — the rest of the wave is still queued.
    wideSite(
      () => 1,
      (url) => (url === "https://s.test/p0" ? { status: 500, body: "", contentType: "text/plain" } : undefined),
    );
    const r = await crawlSite("https://s.test/", { maxPages: 3, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/", "https://s.test/p1", "https://s.test/p2"]);
    expect(r.pending[0]).toBe("https://s.test/p3");
    expect(r.notes.join(" ")).toContain("https://s.test/p0");
  });

  it("reads each origin's OWN robots.txt when crossing origins", async () => {
    // A cross-origin walk used to apply the seed's file everywhere and never
    // read the other host's. Here the seed allows everything and the other
    // host refuses /x: only its own file can say so.
    const spy = installFetchMock((url) => {
      if (url === "https://s.test/robots.txt") return { status: 404, body: "", contentType: "text/plain" };
      if (url === "https://other.test/robots.txt") return { status: 200, body: "User-agent: *\nDisallow: /x", contentType: "text/plain" };
      if (url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      if (url === "https://s.test/") return html('<a href="https://other.test/x">x</a><a href="https://other.test/y">y</a>');
      return html("<p>ok</p>");
    });
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, useSitemap: false, crossOrigin: true, delayMs: 0 });
    expect(r.disallowed).toEqual(["https://other.test/x"]);
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/", "https://other.test/y"]);
    expect(spy.mock.calls.map((c) => String(c[0]))).toContain("https://other.test/robots.txt");
  });

  it("fetches the sitemap while the seed page is in flight, not before it", async () => {
    const order: string[] = [];
    installFetchMock((url) => {
      order.push(url);
      if (url.includes("robots.txt")) return { status: 404, body: "", contentType: "text/plain" };
      if (url.includes("sitemap.xml"))
        return { status: 200, body: "<urlset><url><loc>https://s.test/listed</loc></url></urlset>", contentType: "application/xml" };
      return html("<p>ok</p>");
    });
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/", "https://s.test/listed"]);
    // Both requests were issued before either answered: the seed fetch did not
    // wait for the sitemap to come back.
    expect(order.slice(0, 3)).toEqual(["https://s.test/robots.txt", "https://s.test/sitemap.xml", "https://s.test/"]);
  });
});

describe("crawlSite request ceiling", () => {
  const dead = (n: number) => `<urlset>${Array.from({ length: n }, (_, i) => `<url><loc>https://s.test/dead-${i}</loc></url>`).join("")}</urlset>`;

  it("counts failed fetches against a request ceiling, so a dead sitemap cannot run the crawl on", async () => {
    // The budget buys pages; a URL that fails costs no page. With the sitemap
    // seeding the frontier, 300 dead entries meant 300 requests for `max: 3`.
    const asked: string[] = [];
    installFetchMock((url) => {
      if (url.includes("robots.txt")) return { status: 404, body: "", contentType: "text/plain" };
      if (url.endsWith("/sitemap.xml")) return { body: dead(300), contentType: "application/xml" };
      asked.push(url);
      if (url === "https://s.test/") return html('<a href="/a">a</a>');
      if (url === "https://s.test/a") return html("<p>a</p>");
      return { status: 404, body: "", contentType: "text/plain" };
    });
    const r = await crawlSite("https://s.test/", { maxPages: 3, maxDepth: 1, delayMs: 0 });
    expect(asked).toHaveLength(9);
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/"]);
    expect(r.notes.filter((n) => /Could not fetch/.test(n))).toHaveLength(8);
    expect(r.notes.join(" ")).toMatch(/stopped after 9 page requests, 8 of them failed/);
    // Only as many sitemap entries are queued as the ceiling could ever reach.
    expect(r.notes.join(" ")).toMatch(/seeded 8 URL\(s\) from the sitemap; 292 more are past this crawl's request ceiling/);
    expect(r.pending).toContain("https://s.test/a");
  });

  it("lets a caller set the ceiling", async () => {
    installFetchMock((url) => {
      if (url.includes("robots.txt")) return { status: 404, body: "", contentType: "text/plain" };
      if (url.endsWith("/sitemap.xml")) return { body: dead(20), contentType: "application/xml" };
      if (url === "https://s.test/") return html("<p>seed</p>");
      return { status: 500, body: "", contentType: "text/plain" };
    });
    const r = await crawlSite("https://s.test/", { maxPages: 3, maxDepth: 1, delayMs: 0, maxRequests: 12 });
    expect(r.notes.join(" ")).toMatch(/stopped after 12 page requests, 11 of them failed/);
  });

  it("reads a budget that is not a number as the default, not as zero", async () => {
    installFetchMock((url) => (url.includes("robots.txt") || url.includes("sitemap") ? { status: 404, body: "" } : html("<p>ok</p>")));
    const r = await crawlSite("https://s.test/", { maxPages: Number("ten"), maxDepth: Number.NaN, useSitemap: false, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/"]);
    expect(r.notes.join(" ")).not.toMatch(/NaN/);
  });
});

describe("crawlSite redirects", () => {
  it("follows the seed's own redirect to another origin, and walks that one", async () => {
    // http→https and apex→www are how most sites answer their own name. The
    // origin guard is there to stop the walk wandering, not to refuse the
    // site the caller named: it gave 0 pages and a note.
    installFetchMock((url) => {
      if (url.includes("robots.txt") || url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      if (url === "http://s.test/") return { status: 301, headers: { location: "https://www.s.test/" } };
      if (url === "https://www.s.test/") return html('<a href="/a">a</a><a href="http://s.test/old">old</a>');
      if (url === "https://www.s.test/a") return html("<p>a</p>");
      return undefined;
    });
    const r = await crawlSite("http://s.test/", { maxPages: 5, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://www.s.test/", "https://www.s.test/a"]);
    expect(r.notes.join(" ")).toMatch(/redirected to https:\/\/www\.s\.test\/.*https:\/\/www\.s\.test/);
  });

  it("reads the redirected site's own robots.txt and sitemap", async () => {
    installFetchMock((url) => {
      if (url === "https://s.test/robots.txt") return { body: "User-agent: *\nDisallow: /private\nSitemap: https://s.test/sm.xml", contentType: "text/plain" };
      if (url === "https://s.test/sm.xml")
        return {
          body: "<urlset><url><loc>https://s.test/listed</loc></url><url><loc>https://s.test/private</loc></url></urlset>",
          contentType: "application/xml",
        };
      if (url.startsWith("http://s.test/")) return { status: 301, headers: { location: url.replace("http:", "https:") } };
      return html("<p>ok</p>");
    });
    const r = await crawlSite("http://s.test/", { maxPages: 5, maxDepth: 1, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/", "https://s.test/listed"]);
    expect(r.disallowed).toEqual(["https://s.test/private"]);
    expect(r.notes.join(" ")).not.toMatch(/no robots\.txt|outside the crawl origin/);
  });

  it("reads a page once however many URLs redirect to it", async () => {
    const asked: string[] = [];
    installFetchMock((url) => {
      if (url.includes("robots.txt") || url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      asked.push(new URL(url).pathname);
      if (url === "https://s.test/") return { status: 301, headers: { location: "/home" } };
      if (url === "https://s.test/home") return html('<a href="/home">home</a><a href="/x">x</a><a href="/y">y</a>');
      if (url.endsWith("/x") || url.endsWith("/y")) return { status: 301, headers: { location: "/t" } };
      if (url.endsWith("/t")) return html('<p>t</p><a href="/home">home</a>');
      return undefined;
    });
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 2, useSitemap: false, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/home", "https://s.test/t"]);
    expect(asked.filter((p) => p === "/home")).toHaveLength(1);
    expect(r.notes.join(" ")).toMatch(/https:\/\/s\.test\/y redirected to https:\/\/s\.test\/t, already read/);
  });
});

describe("crawlSite politeness", () => {
  it("holds the host's other requests for a Retry-After the retry is waiting out", async () => {
    // httpGet sleeps out a short Retry-After for its own retry; the crawl's
    // other workers had already claimed their slots and went out inside the
    // window the server asked us to stay away.
    vi.stubEnv(envName("CRAWL_CONCURRENCY"), "4");
    const log: { path: string; at: number; status: number }[] = [];
    let throttled = false;
    installFetchMock((url) => {
      if (url.includes("robots.txt") || url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      if (url === "https://s.test/") return html('<a href="/r1">1</a><a href="/r2">2</a><a href="/r3">3</a><a href="/r4">4</a>');
      const path = new URL(url).pathname;
      if (path === "/r1" && !throttled) {
        throttled = true;
        log.push({ path, at: Date.now(), status: 429 });
        return { status: 429, body: "", contentType: "text/plain", headers: { "retry-after": "1" } };
      }
      log.push({ path, at: Date.now(), status: 200 });
      return html("<p>ok</p>");
    });
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, useSitemap: false, delayMs: 30 });
    expect(r.pages).toHaveLength(5);
    const t429 = log.find((l) => l.status === 429)!.at;
    for (const l of log.filter((x) => x.status === 200)) expect(l.at - t429, l.path).toBeGreaterThanOrEqual(950);
  });

  it("will not wait out a Crawl-delay past its ceiling, and says so instead of sleeping", async () => {
    // Honoured literally, `Crawl-delay: 3600` sleeps an hour per page; past
    // 2^31 ms setTimeout overflows to 1 ms and the site gets hammered.
    const asked: string[] = [];
    installFetchMock((url) => {
      if (url.includes("robots.txt")) return { body: "User-agent: *\nCrawl-delay: 3000000", contentType: "text/plain" };
      asked.push(url);
      return html("<p>ok</p>");
    });
    const started = performance.now();
    const r = await crawlSite("https://s.test/", { maxPages: 2, useSitemap: false });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(asked).toEqual([]);
    expect(r.pages).toEqual([]);
    expect(r.pending).toEqual(["https://s.test/"]);
    expect(r.notes.join(" ")).toMatch(/Crawl-delay of 3000000 s.*over the 60 s/);
  });

  it("lets <PREFIX>_MAX_CRAWL_DELAY_MS move that ceiling", async () => {
    installFetchMock((url) => (url.includes("robots.txt") ? { body: "User-agent: *\nCrawl-delay: 0.05", contentType: "text/plain" } : html("<p>ok</p>")));
    vi.stubEnv(envName("MAX_CRAWL_DELAY_MS"), "10");
    expect((await crawlSite("https://s.test/", { maxPages: 1, useSitemap: false })).pages).toEqual([]);
    resetRobotsCache();
    vi.stubEnv(envName("MAX_CRAWL_DELAY_MS"), "100");
    expect((await crawlSite("https://s.test/", { maxPages: 1, useSitemap: false })).pages).toHaveLength(1);
  });

  it("waits out a delay longer than one timer can hold, rather than none of it", async () => {
    // setTimeout fires a delay past 2^31-1 ms after 1 ms, with a warning.
    vi.useFakeTimers();
    try {
      await awaitHostSlot("https://big.test/1", 3_000_000_000, 0);
      let done = false;
      const second = awaitHostSlot("https://big.test/2", 1, 0).then((waited) => {
        done = true;
        return waited;
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000_000_000);
      expect(await second).toBe(3_000_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the site's robots.txt errors, as RFC 9309 requires, and says why", async () => {
    const asked: string[] = [];
    installFetchMock((url) => {
      if (url.includes("robots.txt")) return { status: 503, body: "", contentType: "text/plain" };
      asked.push(url);
      return html("<p>ok</p>");
    });
    const r = await crawlSite("https://s.test/", { maxPages: 5, delayMs: 0 });
    expect(asked).toEqual([]);
    expect(r.pages).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/robots\.txt at https:\/\/s\.test answered HTTP 503.*RFC 9309/);
    expect(r.notes.join(" ")).not.toMatch(/no robots\.txt/);
  });

  it("names why robots.txt was not read: missing, or switched off", async () => {
    installFetchMock((url) => (url.includes("robots.txt") || url.includes("sitemap") ? { status: 410, body: "" } : html("<p>ok</p>")));
    const missing = await crawlSite("https://s.test/", { maxPages: 1, maxDepth: 0, delayMs: 0 });
    expect(missing.notes.join(" ")).toMatch(/no robots\.txt \(HTTP 410\)/);
    process.env[envName("NO_ROBOTS")] = "1";
    const off = await crawlSite("https://s.test/", { maxPages: 1, maxDepth: 0, delayMs: 0 });
    expect(off.notes.join(" ")).toMatch(/NO_ROBOTS/);
    expect(off.notes.join(" ")).not.toMatch(/no robots\.txt/);
  });
});

describe("crawlSite scope", () => {
  it("does not spend a request on a link to an image, media or an archive", async () => {
    const asked: string[] = [];
    installFetchMock((url) => {
      if (url.includes("robots.txt") || url.includes("sitemap")) return { status: 404, body: "", contentType: "text/plain" };
      asked.push(new URL(url).pathname);
      if (url === "https://s.test/")
        return html(
          '<a href="/img/photo.PNG">p</a><a href="/archive.zip">z</a><a href="/v.mp4?x=1">v</a><a href="/f.woff2">f</a><a href="/paper.pdf">d</a><a href="/page">g</a>',
        );
      return html("<p>ok</p>");
    });
    const r = await crawlSite("https://s.test/", { maxPages: 10, maxDepth: 1, useSitemap: false, delayMs: 0 });
    expect(asked).toEqual(["/", "/paper.pdf", "/page"]);
    // Still links the page has; just not pages to read.
    expect(r.pages[0]!.links).toContain("https://s.test/archive.zip");
    expect(r.notes.join(" ")).toMatch(/skipped 4 link\(s\) to images, media, fonts or archives/);
  });

  /** /docs/ links to two pages of its own; the sitemap lists the shop, and one docs page. */
  const sectioned = () =>
    installFetchMock((url) => {
      if (url.includes("robots.txt")) return { status: 404, body: "", contentType: "text/plain" };
      if (url.endsWith("/sitemap.xml"))
        return {
          body: `<urlset>${Array.from({ length: 10 }, (_, i) => `<url><loc>https://s.test/shop/item-${i}</loc></url>`).join("")}<url><loc>https://s.test/docs/api</loc></url></urlset>`,
          contentType: "application/xml",
        };
      if (url === "https://s.test/docs/") return html('<a href="/docs/install">i</a><a href="/docs/usage">u</a><a href="/shop/">shop</a>');
      if (url === "https://s.test/") return html('<a href="/docs/usage">u</a><a href="/shop/">shop</a>');
      return html("<p>ok</p>");
    });

  it("keeps a section seed's own links ahead of the sitemap, and the sitemap to that section", async () => {
    // The sitemap is the whole site's list: seeded ahead of a /docs/ seed's
    // own links, it spent the budget on the shop.
    sectioned();
    const r = await crawlSite("https://s.test/docs/", { maxPages: 3, maxDepth: 1, delayMs: 0 });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/docs/", "https://s.test/docs/install", "https://s.test/docs/usage"]);
    resetRobotsCache();
    const all = await crawlSite("https://s.test/docs/", { maxPages: 20, maxDepth: 1, delayMs: 0 });
    const urls = all.pages.map((p) => p.url);
    expect(urls).toContain("https://s.test/docs/api");
    expect(urls.filter((u) => u.includes("/shop/item"))).toEqual([]);
    expect(all.notes.join(" ")).toMatch(/seeded 1 URL\(s\) from the sitemap.*10 outside \/docs\//);
  });

  it("stays under an explicit prefix, links and sitemap alike", async () => {
    sectioned();
    const r = await crawlSite("https://s.test/", { maxPages: 20, maxDepth: 2, delayMs: 0, prefix: "/docs/" });
    expect(r.pages.map((p) => p.url)).toEqual(["https://s.test/", "https://s.test/docs/api", "https://s.test/docs/usage"]);
  });
});
