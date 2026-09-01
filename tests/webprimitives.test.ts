import { afterEach, describe, expect, it, vi } from "vitest";
import { charsetFromContentType, charsetFromHtml, decodeBody } from "../src/charset.js";
import { discoverFeeds, parseFeed, parseSitemap } from "../src/feed.js";
import { httpGet } from "../src/fetch.js";
import { fetchRobots, isAllowed, parseRobots, resetRobotsCache } from "../src/robots.js";
import { extractJsonLd, extractMetaTags, pageMetadata } from "../src/structured.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetRobotsCache();
});

describe("character encoding", () => {
  // The bug: httpGet decoded every body as UTF-8. A Windows-1252 page — most of
  // the pre-2010 European web — came back with every accented character as
  // U+FFFD, the extraction "succeeded", and the quotes taken from it were corrupt.
  // Built byte-wise on purpose. 0x97 is an em dash in Windows-1252 and an unused
  // control character in ISO-8859-1, so a decoder that quietly treats the two as
  // the same thing fails here — which is the actual difference between "we
  // handle encodings" and "we handle accents".
  const latin1 = Buffer.concat([Buffer.from("Une réponse déjà validée ", "latin1"), Buffer.from([0x97]), Buffer.from(" coûts", "latin1")]);

  it("maps every byte of the Windows-1252 table, C1 range included", () => {
    // Pinned on the byte-wise reference decoder: the 32 C1 bytes take their
    // cp1252 meaning (or stay as the raw control for the five unassigned ones),
    // everything else is identity.
    const every = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const out = decodeBody(every, "text/html; charset=windows-1252");
    expect(out.length).toBe(256);
    expect(out.slice(0x80, 0xa0)).toBe("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
    for (let i = 0; i < 0x80; i++) expect(out.charCodeAt(i)).toBe(i);
    for (let i = 0xa0; i < 256; i++) expect(out.charCodeAt(i)).toBe(i);
  });

  it("decodes a 4 MB Windows-1252 body in a single pass", () => {
    const chunk = Buffer.concat([Buffer.from("Une réponse déjà validée ", "latin1"), Buffer.from([0x97, 0x85, 0x80])]);
    const big = Buffer.concat(Array.from({ length: Math.ceil(4_000_000 / chunk.length) }, () => chunk));
    const started = performance.now();
    const out = decodeBody(big, "text/html; charset=windows-1252");
    expect(performance.now() - started).toBeLessThan(100);
    expect(out.slice(0, chunk.length)).toBe("Une réponse déjà validée —…€");
  });

  it("decodes a Windows-1252 body declared in the Content-Type", () => {
    expect(decodeBody(latin1, "text/html; charset=windows-1252")).toBe("Une réponse déjà validée — coûts");
  });

  it("decodes it from a <meta charset> when the header says nothing", () => {
    const page = Buffer.concat([Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>', "latin1"), Buffer.from("café", "latin1")]);
    expect(decodeBody(page, "text/html")).toContain("café");
  });

  it("would have produced mojibake without any of this", () => {
    // The old behaviour, kept as a witness: this is what every such page looked like.
    expect(latin1.toString("utf8")).toContain("�");
    expect(decodeBody(latin1, "text/html; charset=windows-1252")).not.toContain("�");
  });

  it("lets a BOM win over every declaration", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo", "utf8")]);
    // The header lies; the BOM does not.
    expect(decodeBody(bom, "text/html; charset=windows-1252")).toBe("héllo");
  });

  it("leaves ordinary UTF-8 byte-identical", () => {
    const utf8 = Buffer.from("plain ascii and héllo", "utf8");
    expect(decodeBody(utf8, "text/html; charset=utf-8")).toBe("plain ascii and héllo");
    expect(decodeBody(utf8, "text/html")).toBe("plain ascii and héllo");
    expect(decodeBody(utf8, "")).toBe("plain ascii and héllo");
  });

  it("falls back to UTF-8 on a charset nobody has heard of", () => {
    expect(decodeBody(Buffer.from("hello", "utf8"), "text/html; charset=x-made-up")).toBe("hello");
  });

  it("reads the charset out of a header or a document", () => {
    expect(charsetFromContentType("text/html; charset=UTF-8")).toBe("utf-8");
    expect(charsetFromContentType('text/html;charset="Shift_JIS"')).toBe("shift_jis");
    expect(charsetFromContentType("text/html")).toBeUndefined();
    expect(charsetFromHtml('<meta charset="EUC-JP">')).toBe("euc-jp");
    expect(charsetFromHtml('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-2">')).toBe("iso-8859-2");
    expect(charsetFromHtml("<html><body>nothing</body></html>")).toBeUndefined();
  });

  it("flows through httpGet, which is the whole point", async () => {
    installFetchMock(() => ({ bytes: latin1, contentType: "text/html; charset=windows-1252" }));
    expect((await httpGet("https://old.test/page")).body).toContain("réponse");
  });
});

describe("robots.txt", () => {
  const FILE = `
# a comment
User-agent: *
Disallow: /private/
Allow: /private/public-bit
Crawl-delay: 2

User-agent: webindex
Disallow: /nope
Sitemap: https://ex.test/sitemap.xml
`;

  it("picks the group that names us over the wildcard", () => {
    const r = parseRobots(FILE, "webindex");
    expect(isAllowed(r, "https://ex.test/nope/x")).toBe(false);
    // Our group says nothing about /private/, and the `*` group does not apply
    // to us once a more specific group exists.
    expect(isAllowed(r, "https://ex.test/private/x")).toBe(true);
  });

  it("falls back to the wildcard group for anyone else", () => {
    const r = parseRobots(FILE, "SomeOtherBot");
    expect(isAllowed(r, "https://ex.test/private/x")).toBe(false);
    expect(isAllowed(r, "https://ex.test/elsewhere")).toBe(true);
    expect(r.crawlDelayMs).toBe(2000);
  });

  it("lets the longest match win, so Allow can carve an exception", () => {
    const r = parseRobots(FILE, "SomeOtherBot");
    expect(isAllowed(r, "https://ex.test/private/public-bit")).toBe(true);
    expect(isAllowed(r, "https://ex.test/private/other")).toBe(false);
  });

  it("supports * and $ patterns", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/b", "x");
    expect(isAllowed(r, "https://ex.test/paper.pdf")).toBe(false);
    expect(isAllowed(r, "https://ex.test/paper.pdf?v=1")).toBe(true); // $ anchors
    expect(isAllowed(r, "https://ex.test/a/zzz/b")).toBe(false);
  });

  it("treats an empty Disallow as permission, per the spec", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:", "x"), "https://ex.test/anything")).toBe(true);
  });

  it("collects every Sitemap line", () => {
    expect(parseRobots(FILE, "x").sitemaps).toEqual(["https://ex.test/sitemap.xml"]);
  });

  it("allows everything when the file is missing — a 404 is not a prohibition", async () => {
    installFetchMock(() => ({ status: 404, body: "" }));
    const r = await fetchRobots("https://ex.test/page");
    expect(r.absent).toBe(true);
    expect(isAllowed(r, "https://ex.test/anything")).toBe(true);
  });

  it("fetches once per origin, not once per page", async () => {
    const spy = installFetchMock(() => ({ body: "User-agent: *\nDisallow: /x", contentType: "text/plain" }));
    await fetchRobots("https://ex.test/a");
    await fetchRobots("https://ex.test/b");
    await fetchRobots("https://other.test/a");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("structured metadata", () => {
  const PAGE = `<html><head>
    <title>Rate limiting — Example</title>
    <meta property="og:title" content="Rate limiting">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Example">
    <meta name="description" content="How token buckets work">
    <meta property="article:published_time" content="2024-03-01T10:00:00Z">
    <script type="application/ld+json">
      {"@type":"TechArticle","headline":"Token buckets in depth","datePublished":"2024-02-28",
       "author":[{"name":"A. Writer"},{"name":"B. Editor"}]}
    </script>
  </head><body>x</body></html>`;

  it("prefers JSON-LD over OpenGraph, which is written for preview cards", () => {
    const m = pageMetadata(PAGE);
    expect(m.title).toBe("Token buckets in depth");
    expect(m.publishedAt).toBe("2024-02-28");
    expect(m.type).toBe("TechArticle");
    expect(m.authors).toEqual(["A. Writer", "B. Editor"]);
    // …and still takes what only OpenGraph had.
    expect(m.siteName).toBe("Example");
    expect(m.description).toBe("How token buckets work");
  });

  it("falls back to <title> only when nothing structured names the page", () => {
    expect(pageMetadata("<html><head><title>Just a title</title></head></html>").title).toBe("Just a title");
  });

  it("flattens a @graph wrapper and an array, as CMS plugins emit them", () => {
    expect(extractJsonLd('<script type="application/ld+json">{"@graph":[{"@type":"A"},{"@type":"B"}]}</script>')).toHaveLength(2);
    expect(extractJsonLd('<script type="application/ld+json">[{"@type":"A"}]</script>')).toHaveLength(1);
  });

  it("skips a malformed block instead of losing the page", () => {
    const html = `<script type="application/ld+json">{ broken,, }</script><script type="application/ld+json">{"@type":"Good"}</script>`;
    const blocks = extractJsonLd(html);
    expect(blocks).toHaveLength(1);
    expect(pageMetadata(html).type).toBe("Good");
  });

  it("reads meta tags regardless of attribute order and decodes entities", () => {
    const tags = extractMetaTags('<meta content="A &amp; B" name="description"><meta property="og:url" content="https://x.test/">');
    expect(tags.get("description")).toBe("A & B");
    expect(tags.get("og:url")).toBe("https://x.test/");
  });

  it("returns an empty shape for a page that says nothing", () => {
    const m = pageMetadata("<html><body>bare</body></html>");
    expect(m.authors).toEqual([]);
    expect(m.jsonLd).toEqual([]);
    expect(m.title).toBeUndefined();
  });
});

describe("feeds", () => {
  const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>Example blog</title>
    <item><title><![CDATA[First & foremost]]></title><link>https://ex.test/1</link>
      <pubDate>Mon, 04 Mar 2024 10:00:00 GMT</pubDate><description>About one.</description></item>
    <item><title>Second</title><link>https://ex.test/2</link></item>
  </channel></rss>`;

  const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <title>Atom blog</title>
    <entry><title>Entry one</title>
      <link rel="self" href="https://ex.test/feed"/>
      <link rel="alternate" href="https://ex.test/a"/>
      <published>2024-03-01T00:00:00Z</published><summary>Sum.</summary></entry>
  </feed>`;

  it("reads RSS, including CDATA titles", () => {
    const f = parseFeed(RSS)!;
    expect(f.kind).toBe("rss");
    expect(f.title).toBe("Example blog");
    expect(f.items).toHaveLength(2);
    expect(f.items[0]).toMatchObject({ title: "First & foremost", url: "https://ex.test/1", summary: "About one." });
  });

  it("reads Atom and prefers rel=alternate over rel=self", () => {
    const f = parseFeed(ATOM)!;
    expect(f.kind).toBe("atom");
    expect(f.items[0]).toMatchObject({ title: "Entry one", url: "https://ex.test/a", published: "2024-03-01T00:00:00Z" });
  });

  it("reads valid unquoted attributes on Atom links", () => {
    const f = parseFeed("<feed><entry><title>Entry</title><link rel=alternate href=https://ex.test/a></entry></feed>")!;
    expect(f.items[0]?.url).toBe("https://ex.test/a");
  });

  it("names the channel, not its first entry", () => {
    expect(parseFeed(RSS)!.title).toBe("Example blog");
    expect(parseFeed(ATOM)!.title).toBe("Atom blog");
  });

  it("returns undefined for something that is not a feed", () => {
    expect(parseFeed("<html><body>a page</body></html>")).toBeUndefined();
    expect(parseFeed("")).toBeUndefined();
  });

  it("finds the feeds a page advertises, resolved against its URL", () => {
    const html = `<link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://cdn.test/atom">
      <link rel="alternate" type="text/html" href="/other-language">`;
    expect(discoverFeeds(html, "https://ex.test/blog/")).toEqual(["https://ex.test/feed.xml", "https://cdn.test/atom"]);
  });

  it("accepts valid unquoted feed-link attributes", () => {
    expect(discoverFeeds("<link rel=alternate type=application/rss+xml href=/feed.xml>", "https://ex.test/blog/")).toEqual(["https://ex.test/feed.xml"]);
  });

  it("does not advertise JSON Feed, which parseFeed does not support", () => {
    expect(discoverFeeds('<link rel="alternate" type="application/feed+json" href="/feed.json">', "https://ex.test/")).toEqual([]);
  });

  it("scans long valueless attribute runs in linear time", () => {
    const hostile = "a-".repeat(20_000);
    const started = performance.now();
    expect(discoverFeeds(`<link ${hostile}>`, "https://ex.test/")).toEqual([]);
    expect(parseFeed(`<feed><entry><title>T</title><link ${hostile}></entry></feed>`)?.items[0]?.title).toBe("T");
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("sitemaps", () => {
  it("reads a urlset with lastmod", () => {
    const xml = `<urlset><url><loc>https://ex.test/a</loc><lastmod>2024-01-01</lastmod></url><url><loc>https://ex.test/b</loc></url></urlset>`;
    const s = parseSitemap(xml);
    expect(s.urls).toEqual([{ loc: "https://ex.test/a", lastmod: "2024-01-01" }, { loc: "https://ex.test/b" }]);
    expect(s.sitemaps).toEqual([]);
  });

  it("reads an index as children to follow, not as pages", () => {
    const xml = `<sitemapindex><sitemap><loc>https://ex.test/s1.xml</loc></sitemap><sitemap><loc>https://ex.test/s2.xml</loc></sitemap></sitemapindex>`;
    const s = parseSitemap(xml);
    expect(s.sitemaps).toEqual(["https://ex.test/s1.xml", "https://ex.test/s2.xml"]);
    expect(s.urls).toEqual([]);
  });

  it("returns empty for anything unrecognised", () => {
    expect(parseSitemap("<html></html>")).toEqual({ urls: [], sitemaps: [] });
  });
});

describe("the remaining edges", () => {
  it("falls back to a feed item's guid when it has no link", () => {
    const f = parseFeed("<rss><channel><item><title>T</title><guid>https://ex.test/g</guid></item></channel></rss>")!;
    expect(f.items[0]!.url).toBe("https://ex.test/g");
  });

  it("skips a feed entry that has neither a title nor a URL", () => {
    const f = parseFeed("<rss><channel><title>B</title><item><pubDate>x</pubDate></item></channel></rss>")!;
    expect(f.items).toEqual([]);
  });

  it("keeps an Atom link when every candidate is rel=self", () => {
    const f = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>E</title><link rel="self" href="https://ex.test/only"/></entry></feed>')!;
    expect(f.items[0]!.url).toBe("https://ex.test/only");
  });

  it("ignores an advertised feed whose href cannot be resolved", () => {
    expect(discoverFeeds('<link rel="alternate" type="application/rss+xml" href="::::">', "not a base")).toEqual([]);
    expect(discoverFeeds('<link rel="alternate" type="application/rss+xml">', "https://ex.test/")).toEqual([]);
  });

  it("decodes a UTF-16 BOM", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo", "utf16le")]);
    expect(decodeBody(le, "text/html")).toBe("héllo");
  });

  it("keeps an empty robots.txt from meaning anything", async () => {
    installFetchMock(() => ({ body: "   ", contentType: "text/plain" }));
    const r = await fetchRobots("https://ex.test/a");
    expect(r.absent).toBe(true);
  });

  it("imposes nothing when robots.txt has no group for anyone", () => {
    const r = parseRobots("Sitemap: https://ex.test/s.xml\n", "webindex");
    expect(r.absent).toBe(false);
    expect(r.sitemaps).toHaveLength(1);
    expect(isAllowed(r, "https://ex.test/anything")).toBe(true);
  });

  it("allows a URL it cannot parse rather than guessing", () => {
    const r = parseRobots("User-agent: *\nDisallow: /", "x");
    expect(isAllowed(r, "not a url")).toBe(true);
  });

  it("ignores robots lines that are not field:value", () => {
    const r = parseRobots("nonsense line\nUser-agent: *\nDisallow: /x\ncrawl-delay: abc\n", "x");
    expect(isAllowed(r, "https://ex.test/x")).toBe(false);
    expect(r.crawlDelayMs).toBeUndefined();
  });

  it("returns nothing for a robots URL that is not a URL", async () => {
    expect((await fetchRobots("not a url")).absent).toBe(true);
  });

  it("reads a JSON-LD author given as a bare string, and a publisher object", () => {
    const m = pageMetadata('<script type="application/ld+json">{"@type":"Article","author":"Solo","publisher":{"name":"Press"}}</script>');
    expect(m.authors).toEqual(["Solo"]);
    expect(m.siteName).toBe("Press");
  });

  it("ignores a JSON-LD block that is not an object", () => {
    expect(pageMetadata('<script type="application/ld+json">"just a string"</script>').authors).toEqual([]);
    expect(pageMetadata('<script type="application/ld+json">   </script>').jsonLd).toEqual([]);
  });
});

describe("Windows-1252 without trusting the runtime", () => {
  // CI caught this: `new TextDecoder("windows-1252")` gave the em dash on one
  // Node version and U+0097 — the latin1 answer — on another. An engine with a
  // Node 18 floor, vendored into environments it never sees, cannot let "which
  // typographic characters survive" depend on how the runtime was compiled.
  it("maps the whole C1 range the same way on any runtime", () => {
    const c1 = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x80 + i));
    const decoded = decodeBody(c1, "text/html; charset=windows-1252");
    expect(decoded).toContain("€"); // 0x80
    expect(decoded).toContain("—"); // 0x97, the one CI caught
    expect(decoded).toContain("–"); // 0x96
    expect(decoded).toContain("’"); // 0x92
    expect(decoded).toContain("…"); // 0x85
    expect(decoded).toContain("™"); // 0x99
    expect(decoded.length).toBe(32);
  });

  it("decodes a page labelled iso-8859-1 as cp1252, as the HTML spec requires", () => {
    // A page declaring latin1 and using an em dash is common; one that genuinely
    // wants U+0097 is not.
    const bytes = Buffer.from([0x41, 0x97, 0x42]);
    expect(decodeBody(bytes, "text/html; charset=iso-8859-1")).toBe("A—B");
    expect(decodeBody(bytes, "text/html; charset=latin1")).toBe("A—B");
  });

  it("leaves the ASCII and high-latin ranges alone", () => {
    const bytes = Buffer.from([0x41, 0x7f, 0xa0, 0xe9, 0xff]);
    expect(decodeBody(bytes, "text/html; charset=windows-1252")).toBe("A\x7f éÿ");
  });
});
