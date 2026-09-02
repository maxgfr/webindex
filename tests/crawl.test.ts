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
