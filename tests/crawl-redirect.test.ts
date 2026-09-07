import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crawlSite, linksFrom, resetHostSchedule } from "../src/crawl.js";
import { fetchRobots, resetRobotsCache } from "../src/robots.js";

describe("crawl redirects over HTTP", () => {
  let server: Server;
  let base: string;
  let requests: string[];
  let redirectSitemap: boolean;
  let redirectRobots: boolean;

  beforeEach(async () => {
    requests = [];
    redirectSitemap = false;
    redirectRobots = false;
    resetRobotsCache();
    resetHostSchedule();
    server = createServer((req, res) => {
      const path = req.url ?? "/";
      requests.push(`${req.headers.host}${path}`);
      if (path === "/robots.txt") {
        if (redirectRobots) {
          res.writeHead(302, { location: base.replace("127.0.0.1", "localhost") + "/foreign-policy" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /private");
        return;
      }
      if (path === "/foreign-policy") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /private");
        return;
      }
      const redirects: Record<string, string> = {
        "/start": "/dir/index",
        "/jump": "/private",
        "/outside": base.replace("127.0.0.1", "localhost") + "/private",
        "/loop": "/loop",
        ...(redirectSitemap ? { "/sitemap.xml": "/private" } : {}),
      };
      if (redirects[path]) {
        res.writeHead(302, { location: redirects[path] });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(path === "/dir/index" ? '<p>Index page</p><a href="child?a=1&amp;b=2">Child</a>' : "<p>Document content</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetRobotsCache();
    resetHostSchedule();
  });

  it("resolves links from the final URL and decodes HTML entities", async () => {
    const result = await crawlSite(`${base}/start`, { useSitemap: false, delayMs: 0, maxPages: 3, maxDepth: 1 });
    expect(result.pages.map((page) => page.url)).toEqual([`${base}/dir/index`, `${base}/dir/child?a=1&b=2`]);
    expect(result.pages[0]?.links).toEqual([`${base}/dir/child?a=1&b=2`]);
  });

  it("never requests a redirect destination forbidden by robots", async () => {
    const result = await crawlSite(`${base}/jump`, { useSitemap: false, delayMs: 0, maxPages: 1, maxDepth: 0 });
    expect(requests.some((path) => path.endsWith("/private"))).toBe(false);
    expect(result.pages).toEqual([]);
    expect(result.disallowed).toEqual([`${base}/private`]);
  });

  it("does not contact an out-of-origin redirect destination", async () => {
    const result = await crawlSite(`${base}/outside`, { useSitemap: false, delayMs: 0, maxPages: 1, maxDepth: 0 });
    expect(requests.some((path) => path.startsWith("localhost:"))).toBe(false);
    expect(result.pages).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/origin/i);
  });

  it("consults the destination origin's robots before following an allowed cross-origin redirect", async () => {
    const result = await crawlSite(`${base}/outside`, { useSitemap: false, crossOrigin: true, delayMs: 0, maxPages: 1, maxDepth: 0 });
    expect(requests.some((path) => path.startsWith("localhost:") && path.endsWith("/robots.txt"))).toBe(true);
    expect(requests.some((path) => path.endsWith("/private"))).toBe(false);
    expect(result.disallowed).toEqual([base.replace("127.0.0.1", "localhost") + "/private"]);
  });

  it("stops redirect loops within twenty hops without returning a page", async () => {
    const result = await crawlSite(`${base}/loop`, { useSitemap: false, delayMs: 0, maxPages: 1, maxDepth: 0 });
    expect(result.pages).toEqual([]);
    expect(requests.filter((path) => path.endsWith("/loop")).length).toBeLessThanOrEqual(21);
    expect(result.notes.join(" ")).toMatch(/redirect/i);
  });

  it("does not let robots.txt itself redirect outside the crawl origin", async () => {
    redirectRobots = true;
    const result = await crawlSite(`${base}/start`, { useSitemap: false, delayMs: 0, maxDepth: 0 });
    expect(requests.some((path) => path.startsWith("localhost:"))).toBe(false);
    expect(result.pages).toHaveLength(1);
    expect(result.notes.join(" ")).toMatch(/outside.*origin/i);
  });

  it("keeps unrestricted robots cache entries separate from crawl policy", async () => {
    redirectRobots = true;
    expect((await fetchRobots(base)).absent).toBe(false);
    requests.length = 0;
    const result = await crawlSite(`${base}/start`, { useSitemap: false, delayMs: 0, maxDepth: 0 });
    expect(requests.some((path) => path.endsWith("/robots.txt"))).toBe(true);
    expect(requests.some((path) => path.startsWith("localhost:"))).toBe(false);
    expect(result.notes.join(" ")).toMatch(/outside.*origin/i);
  });

  it("can follow robots.txt across origins when crossOrigin is enabled", async () => {
    redirectRobots = true;
    const result = await crawlSite(`${base}/private`, { crossOrigin: true, useSitemap: false, delayMs: 0, maxDepth: 0 });
    expect(requests.some((path) => path.startsWith("localhost:") && path.endsWith("/foreign-policy"))).toBe(true);
    expect(requests.some((path) => path.endsWith("/private"))).toBe(false);
    expect(result.disallowed).toEqual([`${base}/private`]);
  });

  it("applies robots restrictions to sitemap redirects as well as page redirects", async () => {
    redirectSitemap = true;
    const result = await crawlSite(`${base}/start`, { delayMs: 0, maxPages: 3, maxDepth: 1 });
    expect(requests.some((path) => path.endsWith("/private"))).toBe(false);
    expect(result.disallowed).toEqual([`${base}/private`]);
  });

  it("decodes numeric entities and preserves an apostrophe inside a double-quoted href", () => {
    expect(linksFrom('<a href="/search?q=l\'article&#38;page=2">link</a>', base)).toEqual([`${base}/search?q=l%27article&page=2`]);
  });
});
