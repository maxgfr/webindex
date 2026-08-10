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
