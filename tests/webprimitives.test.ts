import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { charsetFromContentType, charsetFromHtml, decodeBody, decodeLocal } from "../src/charset.js";
import { discoverFeeds, fetchFeed, fetchSitemap, parseFeed, parseSitemap } from "../src/feed.js";
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

  it("decodes an entire 4 MB Windows-1252 body", () => {
    const chunk = Buffer.concat([Buffer.from("Une réponse déjà validée ", "latin1"), Buffer.from([0x97, 0x85, 0x80])]);
    const repeats = Math.ceil(4_000_000 / chunk.length);
    const big = Buffer.concat(Array.from({ length: repeats }, () => chunk));
    const out = decodeBody(big, "text/html; charset=windows-1252");
    // Timing belongs in bench/charset.bench.ts: shared CI runners can exceed
    // 100 ms without a decoding regression. Check every decoded chunk here.
    expect(out).toBe("Une réponse déjà validée —…€".repeat(repeats));
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

  it("trusts a UTF-8 header over a Latin-1 meta declaration", () => {
    const html = '<meta charset="iso-8859-1"><p>héllo</p>';
    expect(decodeBody(Buffer.from(html, "utf8"), "text/html; charset=utf-8")).toBe(html);
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

  it("reads charset= only from a meta tag's own charset or a content-type pragma", () => {
    // `charset=` inside a description is prose, not a declaration. Matching it
    // anywhere in any meta tag decoded the whole page as UTF-16 — CJK garbage.
    const head = '<meta name="description" content="How to set charset=utf-16 in Java"><meta charset="utf-8">';
    expect(charsetFromHtml(head)).toBe("utf-8");
    expect(charsetFromHtml('<meta content="charset=iso-8859-2" name="keywords"><meta charset=euc-jp>')).toBe("euc-jp");
    expect(charsetFromHtml('<meta content="text/html; charset=iso-8859-2" http-equiv="Content-Type">')).toBe("iso-8859-2");
    // A raw `<` or `>` is valid inside a quoted value; the tag does not end there.
    expect(charsetFromHtml('<meta name="description" content="Learn <meta charset=iso-8859-1> usage"><meta charset="utf-8">')).toBe("utf-8");
    const page = Buffer.from(`<html><head>${head}</head><body>café</body></html>`, "utf8");
    expect(decodeBody(page, "text/html")).toBe(page.toString("utf8"));
  });

  it("treats a meta-declared UTF-16 as UTF-8, as the prescan requires", () => {
    // Bytes an ASCII-compatible scan could read cannot be UTF-16, whatever the
    // tag claims (WHATWG); x-user-defined likewise means windows-1252.
    expect(charsetFromHtml('<meta charset="utf-16">')).toBe("utf-8");
    expect(charsetFromHtml('<meta http-equiv="content-type" content="text/html; charset=UTF-16LE">')).toBe("utf-8");
    expect(charsetFromHtml('<meta charset="x-user-defined">')).toBe("windows-1252");
    const ascii = Buffer.from('<html><head><meta charset="utf-16"></head><body>plain</body></html>', "utf8");
    expect(decodeBody(ascii, "text/html")).toBe(ascii.toString("utf8"));
  });

  it("does not sniff markup in a body that is not HTML", () => {
    // A text/plain document quoting a meta tag is not declaring its encoding.
    const text = Buffer.from('How to declare encoding: <meta charset="iso-8859-1">\nCafé naïve résumé', "utf8");
    expect(decodeBody(text, "text/plain")).toBe(text.toString("utf8"));
    expect(decodeBody(text, "application/json")).toBe(text.toString("utf8"));
  });

  it("rescues undeclared Windows-1252 bytes instead of returning U+FFFD", () => {
    expect(decodeBody(latin1, "text/html")).toBe("Une réponse déjà validée — coûts");
    expect(decodeBody(latin1, "")).toBe("Une réponse déjà validée — coûts");
    // A declaration past the sniff window is as good as none; the rescue still reads it.
    const late = Buffer.concat([Buffer.from(`<script>${"x".repeat(6000)}</script><meta charset="windows-1252"><p>`), Buffer.from("café", "latin1")]);
    expect(decodeBody(late, "text/html")).toContain("<p>café");
    // A UTF-8 header is a declaration, and still wins.
    expect(decodeBody(latin1, "text/html; charset=utf-8")).toContain("�");
  });

  it("does not mistake a UTF-8 body cut mid-character at the cap for Windows-1252", () => {
    const whole = Buffer.from("café au lait — déjà vu é", "utf8");
    const cut = whole.subarray(0, whole.length - 1); // splits the final é
    expect(decodeBody(cut, "text/html").startsWith("café au lait — déjà vu ")).toBe(true);
  });

  it("honours the XML declaration's encoding when the header names none", async () => {
    const xml = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Résumé à jour</title></channel></rss>', "latin1");
    expect(decodeBody(xml, "application/rss+xml")).toContain("Résumé à jour");
    expect(decodeLocal(xml, { sniffHtmlCharset: false })).toContain("Résumé à jour");
    // Not UTF-16 either, when an ASCII scan could read the declaration.
    const ascii = Buffer.from('<?xml version="1.0" encoding="UTF-16"?><rss/>', "utf8");
    expect(decodeBody(ascii, "text/xml")).toBe(ascii.toString("utf8"));
    installFetchMock(() => ({ bytes: xml, contentType: "application/rss+xml" }));
    expect((await fetchFeed("https://old.test/feed.xml"))?.title).toBe("Résumé à jour");
  });
});

describe("decodeLocal", () => {
  it("leaves valid UTF-8 without a declaration unchanged", () => {
    expect(decodeLocal(Buffer.from("plain ascii and héllo", "utf8"))).toBe("plain ascii and héllo");
  });

  it("ignores a quoted meta charset when told the file is plain text", () => {
    // A Markdown file showing `<meta charset="iso-8859-1">` as an example is
    // still UTF-8; sniffing it would turn café into cafÃ©.
    const md = Buffer.from('Example: `<meta charset="iso-8859-1">`\n\ncafé', "utf8");
    expect(decodeLocal(md, { sniffHtmlCharset: false })).toBe(md.toString("utf8"));
    expect(decodeLocal(md)).not.toBe(md.toString("utf8"));
  });

  it("honours a Latin-1 meta charset", () => {
    const html = '<meta charset="iso-8859-1"><p>Une réponse déjà validée</p>';
    expect(decodeLocal(Buffer.from(html, "latin1"))).toBe(html);
  });

  it("honours an http-equiv charset declaration", () => {
    const html = '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><p>Une réponse déjà validée</p>';
    expect(decodeLocal(Buffer.from(html, "latin1"))).toBe(html);
  });

  it("rescues Latin-1 bytes under a stale UTF-8 meta declaration", () => {
    const html = '<meta charset="utf-8"><p>Une réponse déjà validée</p>';
    expect(decodeLocal(Buffer.from(html, "latin1"))).toBe(html);
  });

  it("rescues Latin-1 bytes without a meta declaration", () => {
    expect(decodeLocal(Buffer.from("Une réponse déjà validée", "latin1"))).toBe("Une réponse déjà validée");
  });

  it("decodes UTF-16LE by BOM even when a later meta claims Latin-1", () => {
    const bom = Buffer.from([0xff, 0xfe]);
    expect(decodeLocal(Buffer.concat([bom, Buffer.from("héllo", "utf16le")]))).toBe("héllo");
    const html = 'héllo<meta charset="iso-8859-1">';
    expect(decodeLocal(Buffer.concat([bom, Buffer.from(html, "utf16le")]))).toBe(html);
  });

  it("lets a UTF-8 BOM beat a Latin-1 meta declaration", () => {
    const html = '<meta charset="iso-8859-1"><p>héllo</p>';
    expect(decodeLocal(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html, "utf8")]))).toBe(html);
  });

  it("decodes UTF-16BE by BOM", () => {
    expect(decodeLocal(Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0xe9, 0x00, 0x6c, 0x00, 0x6c, 0x00, 0x6f]))).toBe("héllo");
  });

  it("rescues C1 bytes as Windows-1252 punctuation", () => {
    const bytes = Buffer.concat([Buffer.from("<p>Une réponse ", "latin1"), Buffer.from([0x97]), Buffer.from(" coûts</p>", "latin1")]);
    expect(decodeLocal(bytes)).toBe("<p>Une réponse — coûts</p>");
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

  it("matches wildcards the way the spec and Google's parser do", () => {
    const allowed = (rule: string, path: string) => isAllowed(parseRobots(`User-agent: *\nDisallow: ${rule}`, "x"), `https://ex.test${path}`);
    // Google's documented examples, both ways round.
    for (const p of ["/fish", "/fish.html", "/fishheads/yummy.html"]) expect(allowed("/fish*", p)).toBe(false);
    expect(allowed("/fish*", "/Fish.asp")).toBe(true);
    for (const p of ["/index.php", "/folder/filename.php?parameters", "/filename.php/"]) expect(allowed("/*.php", p)).toBe(false);
    expect(allowed("/*.php", "/")).toBe(true);
    for (const p of ["/filename.php", "/folder/filename.php"]) expect(allowed("/*.php$", p)).toBe(false);
    for (const p of ["/filename.php?parameters", "/filename.php/", "/filename.php5"]) expect(allowed("/*.php$", p)).toBe(true);
    expect(allowed("/fish*.php", "/fishheads/catfish.php?parameters")).toBe(false);
    expect(allowed("/fish*.php", "/Fish.PHP")).toBe(true);
    // Runs of `*`, a `*` at either end, and a `$` that is not at the end.
    expect(allowed("/a**b", "/a-x-b")).toBe(false);
    expect(allowed("*/private", "/x/private")).toBe(false);
    expect(allowed("/*$", "/anything")).toBe(false);
    expect(allowed("/a$b", "/a$b")).toBe(false);
    expect(allowed("/a$b", "/a")).toBe(true);
    expect(allowed("/a*b*c$", "/a-b-c-b")).toBe(true);
    expect(allowed("/a*b*c$", "/a-c-b-c")).toBe(false);
  });

  it("matches a hostile wildcard rule in linear time", () => {
    // `/*a*a*…$` compiled to `.*a.*a…` backtracked O(L^k): one call took
    // seconds, and robots.txt supplies the pattern while the site's own links
    // supply the path. The bounds are generous — the old matcher took minutes.
    const r = parseRobots(`User-agent: *\nDisallow: /${"*a".repeat(10)}$\nDisallow: /${"*a".repeat(40)}*b*c`, "x");
    const started = performance.now();
    expect(isAllowed(r, `https://ex.test/${"a".repeat(2000)}b`)).toBe(true);
    expect(isAllowed(r, `https://ex.test/${"a".repeat(2000)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("compares percent-encoded and literal paths as the same path", () => {
    // WHATWG encodes non-ASCII but leaves `~` alone, so a rule written either
    // way used to miss the URL written the other way.
    const r = parseRobots("User-agent: *\nDisallow: /café\nDisallow: /%7Ejoe\nDisallow: /~ann\nDisallow: /a%2fb\nDisallow: /with space", "x");
    expect(isAllowed(r, "https://ex.test/café/menu")).toBe(false);
    expect(isAllowed(r, "https://ex.test/caf%C3%A9/menu")).toBe(false);
    expect(isAllowed(r, "https://ex.test/~joe/")).toBe(false);
    expect(isAllowed(r, "https://ex.test/%7Eann/")).toBe(false);
    // An encoded reserved character is not the character itself, but its hex
    // case does not matter.
    expect(isAllowed(r, "https://ex.test/a%2Fb")).toBe(false);
    expect(isAllowed(r, "https://ex.test/a/b")).toBe(true);
    expect(isAllowed(r, "https://ex.test/with%20space")).toBe(false);
    // The rules are reported as written.
    expect(r.rules.map((rule) => rule.path)).toContain("/café");
  });

  it("applies a group only when it names our product token exactly", () => {
    const file = (agent: string) => `User-agent: ${agent}\nDisallow: /x\n`;
    // A substring of our name is somebody else's bot.
    expect(isAllowed(parseRobots(file("web"), "webindex"), "https://ex.test/x")).toBe(true);
    expect(isAllowed(parseRobots(file("index"), "webindex"), "https://ex.test/x")).toBe(true);
    // A version, a comment or different case still names us.
    expect(isAllowed(parseRobots(file("WebIndex/1.0"), "webindex"), "https://ex.test/x")).toBe(false);
    expect(isAllowed(parseRobots(file("WEBINDEX"), "webindex"), "https://ex.test/x")).toBe(false);
    // A full User-Agent string is reduced to its product token too, so a
    // `Mozilla` group does not capture every bot that sends one.
    expect(isAllowed(parseRobots(file("Mozilla"), "MyBot/2.1 (compatible; Mozilla/5.0)"), "https://ex.test/x")).toBe(true);
    expect(isAllowed(parseRobots(file("mybot"), "MyBot/2.1 (compatible; Mozilla/5.0)"), "https://ex.test/x")).toBe(false);
  });

  it("splits lines on a bare CR, which the spec allows", () => {
    const r = parseRobots("User-agent: *\rDisallow: /x\rCrawl-delay: 1\r", "webindex");
    expect(isAllowed(r, "https://ex.test/x")).toBe(false);
    expect(r.crawlDelayMs).toBe(1000);
  });

  it("ignores an empty Crawl-delay rather than reading it as zero", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay:\nDisallow: /x", "x").crawlDelayMs).toBeUndefined();
  });
});

describe("fetching robots.txt", () => {
  it("parses the prefix of a file over the size cap, whatever its Content-Length", async () => {
    // RFC 9309 §2.5: parse at least the first 500 KiB. The verdict must not
    // depend on whether the server declared the length or streamed it.
    // Padded so the 512 KiB cap falls inside the last rule.
    const head = "User-agent: *\nDisallow: /nope\n";
    const pad = "# padding line\n".repeat(Math.floor((512 * 1024 - head.length - 20) / 15));
    const body = `${head}${pad}Disallow: /cut${"x".repeat(100)}\nDisallow: /after-the-cap\n`;
    installFetchMock(() => ({ body, contentType: "text/plain", headers: { "content-length": String(Buffer.byteLength(body)) } }));
    const r = await fetchRobots("https://big.test/");
    expect(r.absent).toBe(false);
    expect(isAllowed(r, "https://big.test/nope")).toBe(false);
    // The last line was cut at the cap: half a rule is not a rule.
    expect(r.rules.some((rule) => rule.path.startsWith("/cut"))).toBe(false);
  });

  it("assumes complete disallow when the file is unreachable, as RFC 9309 requires", async () => {
    installFetchMock(() => ({ status: 503, body: "busy", contentType: "text/plain" }));
    const r = await fetchRobots("https://down.test/");
    expect(r).toMatchObject({ unreachable: true, status: 503, absent: false });
    expect(isAllowed(r, "https://down.test/anything")).toBe(false);
  });

  it("treats a network failure the same way", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } });
    });
    const r = await fetchRobots("https://gone.test/");
    expect(r).toMatchObject({ unreachable: true, status: 0 });
    expect(isAllowed(r, "https://gone.test/")).toBe(false);
  });

  it("keeps `absent` for a real 4xx and says which status it was", async () => {
    installFetchMock(() => ({ status: 410, body: "", contentType: "text/plain" }));
    const r = await fetchRobots("https://no-file.test/");
    expect(r).toMatchObject({ absent: true, status: 410 });
    expect(r.unreachable).toBeUndefined();
    expect(isAllowed(r, "https://no-file.test/x")).toBe(true);
  });

  it("forgets an unreachable answer after minutes and a good one after a day", async () => {
    let status = 500;
    const spy = installFetchMock(() => ({ status, body: "User-agent: *\nDisallow: /nope", contentType: "text/plain" }));
    const now = vi.spyOn(Date, "now");
    let t = 1_000_000;
    now.mockImplementation(() => t);
    try {
      expect((await fetchRobots("https://flaky.test/")).unreachable).toBe(true);
      status = 200;
      // Still the failure a moment later: a crawl must not re-ask per page.
      expect((await fetchRobots("https://flaky.test/")).unreachable).toBe(true);
      t += 10 * 60_000;
      const recovered = await fetchRobots("https://flaky.test/");
      expect(recovered.unreachable).toBeUndefined();
      expect(isAllowed(recovered, "https://flaky.test/nope")).toBe(false);
      const calls = spy.mock.calls.length;
      t += 60 * 60_000;
      await fetchRobots("https://flaky.test/");
      expect(spy.mock.calls.length).toBe(calls);
      t += 24 * 60 * 60_000;
      await fetchRobots("https://flaky.test/");
      expect(spy.mock.calls.length).toBe(calls + 1);
    } finally {
      now.mockRestore();
    }
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

  const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

  it("describes the article, not the Organization block the site header emits first", () => {
    // The first node used to win every field: title "The Daily Planet", type
    // Organization, canonical the homepage.
    const m = pageMetadata(readFileSync(join(__dirname, "fixtures", "html", "news.html"), "utf8"));
    expect(m).toMatchObject({
      title: "City council approves new bike lanes",
      type: "NewsArticle",
      canonicalUrl: "https://daily.test/news/2025/bike-lanes",
      siteName: "The Daily Planet",
      authors: ["Lois Lane"],
    });
    expect(pageMetadata(readFileSync(join(__dirname, "fixtures", "html", "product.html"), "utf8"))).toMatchObject({
      type: "Product",
      title: "Trail Runner 3",
      description: "A lightweight trail shoe with a grippy outsole.",
    });
    const site = ld({
      "@graph": [
        { "@type": "WebSite", name: "Site", url: "https://ex.test/" },
        { "@type": "BlogPosting", headline: "Post" },
      ],
    });
    expect(pageMetadata(site)).toMatchObject({ type: "BlogPosting", title: "Post", siteName: "Site" });
    // Chrome alone never stands in for the page: its name is the site's.
    const orgOnly = `${ld({ "@type": "Organization", name: "Org", url: "https://org.test/" })}<meta property="og:title" content="Story"><meta property="og:type" content="article">`;
    expect(pageMetadata(orgOnly)).toMatchObject({ title: "Story", type: "article", siteName: "Org" });
    expect(pageMetadata(orgOnly).canonicalUrl).toBeUndefined();
  });

  it("resolves a Yoast @graph's @id references, and never reports an @id as the canonical", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Person", "@id": "https://blog.test/#/person/1", name: "Jane Doe" },
        {
          "@type": "Article",
          "@id": "https://blog.test/post-slug/#article",
          headline: "Post title",
          author: { "@id": "https://blog.test/#/person/1" },
          image: { "@id": "https://blog.test/post-slug/#primaryimage" },
          publisher: { "@id": "https://blog.test/#organization" },
          datePublished: "2025-01-02",
        },
        {
          "@type": "WebPage",
          "@id": "https://blog.test/post-slug/",
          url: "https://blog.test/post-slug/",
          name: "Post title - Blog",
          description: "What the post says.",
        },
        { "@type": "ImageObject", "@id": "https://blog.test/post-slug/#primaryimage", url: "https://blog.test/img/post.jpg" },
        { "@type": "Organization", "@id": "https://blog.test/#organization", name: "Blog Inc" },
      ],
    };
    expect(pageMetadata(ld(graph))).toMatchObject({
      type: "Article",
      title: "Post title",
      description: "What the post says.",
      authors: ["Jane Doe"],
      imageUrl: "https://blog.test/img/post.jpg",
      siteName: "Blog Inc",
      publishedAt: "2025-01-02",
      canonicalUrl: "https://blog.test/post-slug/",
    });
    expect(pageMetadata(ld({ "@type": "Article", "@id": "https://x.test/p#article", headline: "T" })).canonicalUrl).toBeUndefined();
  });

  it("takes the canonical from <link rel=canonical> first, and resolves relative URLs against baseUrl", () => {
    expect(pageMetadata('<link rel="canonical" href="https://x.test/real"><title>T</title>').canonicalUrl).toBe("https://x.test/real");
    const html = `<link rel="canonical" href="/real"><meta property="og:url" content="https://x.test/og">${ld({ "@type": "Article", url: "https://x.test/ld" })}<meta property="og:image" content="/img/og.png">`;
    expect(pageMetadata(html, { baseUrl: "https://x.test/some/page" })).toMatchObject({
      canonicalUrl: "https://x.test/real",
      imageUrl: "https://x.test/img/og.png",
    });
    // Without a base, a relative URL is reported as written rather than guessed.
    expect(pageMetadata(html).canonicalUrl).toBe("/real");
    // What resolves to no web address is not reported as one.
    expect(pageMetadata('<link rel="canonical" href="javascript:void(0)">', { baseUrl: "https://x.test/" })).not.toHaveProperty("canonicalUrl");
    // A news publisher's Organization subtype still names the site.
    expect(pageMetadata(ld({ "@type": "NewsMediaOrganization", name: "The Planet" })).siteName).toBe("The Planet");
  });

  it("keeps every author a page lists in its own tag", () => {
    const html = '<meta name="citation_author" content="Smith, J"><meta name="citation_author" content="Doe, A"><meta name="citation_author" content="Roe, B">';
    expect(pageMetadata(html).authors).toEqual(["Smith, J", "Doe, A", "Roe, B"]);
    // The first-wins map stays as it was for callers that read one value.
    expect(extractMetaTags(html).get("citation_author")).toBe("Smith, J");
  });

  it("reads an image given as an ImageObject, the shape Google recommends", () => {
    expect(pageMetadata(ld({ "@type": "Article", image: { "@type": "ImageObject", url: "https://x.test/a.jpg" } })).imageUrl).toBe("https://x.test/a.jpg");
    expect(pageMetadata(ld({ "@type": "Article", image: [{ "@type": "ImageObject", contentUrl: "https://x.test/b.jpg" }] })).imageUrl).toBe(
      "https://x.test/b.jpg",
    );
  });

  it("reads meta attributes quote-aware, and not from data-* look-alikes", () => {
    expect(extractMetaTags('<meta name="description" content="Use a -> b to map values">').get("description")).toBe("Use a -> b to map values");
    expect(extractMetaTags('<meta data-content="tracking-id-123" name="description" content="Real description">').get("description")).toBe("Real description");
    expect(extractMetaTags('<meta data-name="x" name="description" content="real">').get("description")).toBe("real");
  });

  it("recovers JSON-LD that browsers' lenient consumers accept", () => {
    // A raw newline in a string, a trailing comma, a CDATA wrapper, an unquoted
    // or parameterised type: each used to cost the whole block.
    expect(extractJsonLd('<script type="application/ld+json">{"@type":"A","description":"line one\nline two"}</script>')).toEqual([
      { "@type": "A", description: "line one line two" },
    ]);
    expect(extractJsonLd('<script type="application/ld+json">{"@type":"B","a":[1,2,],}</script>')).toEqual([{ "@type": "B", a: [1, 2] }]);
    expect(extractJsonLd('<script type="application/ld+json">//<![CDATA[\n{"@type":"C"}\n//]]></script>')).toEqual([{ "@type": "C" }]);
    expect(extractJsonLd('<script type=application/ld+json>{"@type":"D"}</script>')).toEqual([{ "@type": "D" }]);
    expect(extractJsonLd('<script type="application/ld+json; charset=utf-8">{"@type":"E"}</script>')).toEqual([{ "@type": "E" }]);
    expect(extractJsonLd('<script type="application/ld+json">[{"@graph":[{"@type":"F"},{"@type":"G"}]}]</script>')).toEqual([
      { "@type": "F" },
      { "@type": "G" },
    ]);
  });

  it("scans JSON-LD in linear time on a page of unclosed script openers", () => {
    const html = '<script type="application/ld+json">{'.repeat(50_000);
    const started = performance.now();
    expect(extractJsonLd(html)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("reads meta tags in linear time on a page of unterminated ones", () => {
    // `<meta ` x 40k (240 KB) took 4 s: each opener read to the end of the page.
    const started = performance.now();
    expect(pageMetadata(`${"<meta ".repeat(40_000)}${'<meta content="x ">'.repeat(20_000)}`).authors).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
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

  it("discovers JSON Feed, and a type written with parameters", () => {
    const html = `<link rel="alternate" type="application/rss+xml; charset=utf-8" href="/feed.xml">
      <link rel="alternate" type="application/feed+json" href="/feed.json">
      <link rel="alternate" type="application/json" href="/wp-json/wp/v2/pages/42">`;
    // A bare application/json alternate is WordPress's REST API, not a feed.
    expect(discoverFeeds(html, "https://ex.test/")).toEqual(["https://ex.test/feed.xml", "https://ex.test/feed.json"]);
  });

  it("scans long valueless attribute runs in linear time", () => {
    const hostile = "a-".repeat(20_000);
    const started = performance.now();
    expect(discoverFeeds(`<link ${hostile}>`, "https://ex.test/")).toEqual([]);
    expect(parseFeed(`<feed><entry><title>T</title><link ${hostile}></entry></feed>`)?.items[0]?.title).toBe("T");
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("scans unclosed items and link tags in linear time", () => {
    // A lazy `<item[\s\S]*?</item>` re-scanned to the end from every unclosed
    // opener, and `<link\b[^>]*>` did the same from every `<link` with no `>`.
    const started = performance.now();
    expect(parseFeed(`<rss><channel><title>T</title>${"<item><title>x".repeat(40_000)}</channel></rss>`)?.items).toEqual([]);
    expect(discoverFeeds("<link rel=alternate ".repeat(40_000), "https://ex.test/")).toEqual([]);
    expect(parseSitemap(`<urlset>${"<url><loc>https://ex.test/".repeat(40_000)}`).urls).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reads the HTML a description carries escaped, as text", () => {
    const f = parseFeed(`<rss><channel><item><title>&lt;em&gt;Big&lt;/em&gt; news</title><link>https://ex.test/1</link>
      <description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt; &amp;amp; more&lt;/p&gt;</description></item></channel></rss>`)!;
    expect(f.items[0]).toMatchObject({ title: "Big news", summary: "Hello world & more" });
    const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">&lt;em&gt;Atom&lt;/em&gt; one</title>
      <summary type="text">Use &lt;b&gt; for bold</summary><link href="https://ex.test/a"/></entry></feed>`)!;
    // type="text" is text: its angle brackets are the content, not markup.
    expect(atom.items[0]).toMatchObject({ title: "Atom one", summary: "Use <b> for bold" });
  });

  it("keeps the text around a CDATA section, and a section split to carry `]]>`", () => {
    const f = parseFeed(`<rss><channel><item><title><![CDATA[Mixed ]]> tail</title><link>https://ex.test/1</link>
      <description>A <![CDATA[<i>cdata</i>]]> and plain</description></item>
      <item><title><![CDATA[x ]]]]><![CDATA[> y is the end]]></title><link>https://ex.test/2</link></item></channel></rss>`)!;
    expect(f.items[0]).toMatchObject({ title: "Mixed tail", summary: "A cdata and plain" });
    expect(f.items[1]!.title).toBe("x ]]> y is the end");
  });

  it("does not mistake an HTML page for a feed", () => {
    // `\b` matches before `-`, so a `<channel-nav>` element, or `<entry>` in a
    // script, made any page an empty feed — and skipped discovery.
    expect(parseFeed("<!doctype html><html><body><channel-nav></channel-nav><rss-reader></rss-reader></body></html>")).toBeUndefined();
    expect(parseFeed('<!DOCTYPE html><html><script>var t = "<entry>";</script></html>')).toBeUndefined();
    expect(parseFeed("<html><body><feed-list></feed-list></body></html>")).toBeUndefined();
    // …while a feed may open with a BOM, a declaration, a stylesheet PI, comments and a doctype.
    const rss =
      String.fromCharCode(0xfeff) +
      '<?xml version="1.0"?>\n<?xml-stylesheet href="/rss.xsl" type="text/xsl"?><!-- generated -->' +
      '<!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "http://my.netscape.com/publish/formats/rss-0.91.dtd">' +
      "<rss><channel><title>B</title><item><title>One</title></item></channel></rss>";
    expect(parseFeed(rss)?.items).toHaveLength(1);
    expect(parseFeed('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><item><title>R</title></item></rdf:RDF>')?.kind).toBe("rss");
  });

  it("takes an Atom entry's alternate link, resolved against xml:base and the feed's URL", () => {
    const f = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://ex.test/blog/">
        <entry><title>One</title><link rel="related" href="https://other.example/related"/><link rel="alternate" href="post-1"/>
          <content type="html">&lt;p&gt;Body text&lt;/p&gt;</content></entry>
        <entry xml:base="/archive/"><title>Two</title><link href="post-2"/></entry>
      </feed>`,
      "https://ex.test/feed.atom",
    )!;
    expect(f.items[0]).toMatchObject({ url: "https://ex.test/blog/post-1", summary: "Body text" });
    expect(f.items[1]!.url).toBe("https://ex.test/archive/post-2");
    // Without xml:base, a relative href resolves against the feed's own URL.
    expect(parseFeed('<feed><entry><title>E</title><link href="/p/3"/></entry></feed>', "https://ex.test/f.xml")!.items[0]!.url).toBe("https://ex.test/p/3");
  });

  it("reads no element out of a CDATA section or a comment", () => {
    // An article's own markup — a stylesheet link, an SVG title — sits inside
    // content:encoded's CDATA, and is not the entry's link or title.
    const f = parseFeed(`<rss><channel><title>Blog</title><item>
      <content:encoded><![CDATA[<svg><title>Icon</title></svg><link rel="stylesheet" href="/style.css"><p>Body</p>]]></content:encoded>
      <!-- <title>Draft title</title> -->
      <title>Real <!-- not this --> title</title><link>https://ex.test/real</link></item></channel></rss>`)!;
    expect(f.items[0]).toMatchObject({ title: "Real title", url: "https://ex.test/real" });
    expect(f.items[0]!.summary).toBe("Icon Body");
  });

  it("reads Atom xhtml as markup whose entities are text", () => {
    const f =
      parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Use &lt;b&gt; <em>here</em></div></title>
      <link href="https://ex.test/x"/></entry></feed>`)!;
    expect(f.items[0]!.title).toBe("Use <b> here");
  });

  it("uses a guid as the URL only when it is a permalink", () => {
    const f = parseFeed(`<rss><channel>
      <item><title>A</title><guid isPermaLink="false">post-123</guid></item>
      <item><title>B</title><guid isPermaLink="false">https://ex.test/not-a-page</guid></item>
      <item><title>C</title><guid>https://ex.test/c</guid></item></channel></rss>`)!;
    expect(f.items.map((i) => i.url)).toEqual([undefined, undefined, "https://ex.test/c"]);
    expect(f.items[0]!.id).toBe("post-123");
  });

  it("falls back to content:encoded for a summary, and keeps it a summary", () => {
    const long = "word ".repeat(400);
    const f = parseFeed(`<rss><channel><item><title>A</title><content:encoded><![CDATA[<p>${long}</p>]]></content:encoded></item></channel></rss>`)!;
    expect(f.items[0]!.summary!.startsWith("word word")).toBe(true);
    expect(f.items[0]!.summary!.length).toBeLessThanOrEqual(501);
  });

  it("reads JSON Feed", () => {
    const f = parseFeed(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Micro",
        items: [
          { id: "1", url: "https://ex.test/1", title: "First", date_published: "2024-05-01T00:00:00Z", summary: "S" },
          { id: 2, external_url: "/elsewhere", content_html: "<p>Only <b>html</b></p>" },
          { id: "3" },
        ],
      }),
      "https://ex.test/feed.json",
    )!;
    expect(f).toMatchObject({ kind: "json", title: "Micro" });
    expect(f.items).toEqual([
      { id: "1", url: "https://ex.test/1", title: "First", published: "2024-05-01T00:00:00Z", summary: "S" },
      { id: "2", url: "https://ex.test/elsewhere", summary: "Only html" },
    ]);
    // JSON that is not a JSON Feed is not a feed.
    expect(parseFeed('{"version":"1","items":[]}')).toBeUndefined();
    expect(parseFeed("{not json")).toBeUndefined();
  });

  it("resolves a fetched feed's relative links against where it was fetched from", async () => {
    installFetchMock(() => ({ body: '<feed><entry><title>E</title><link href="/p/1"/></entry></feed>', contentType: "application/atom+xml" }));
    expect((await fetchFeed("https://ex.test/blog/atom.xml"))?.items[0]?.url).toBe("https://ex.test/p/1");
  });
});

describe("fetching sitemaps", () => {
  const urlset = (...locs: string[]) => `<urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;
  const index = (...locs: string[]) => `<sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}</sitemapindex>`;

  it("reads the children of a named index before guessing /sitemap.xml", async () => {
    const asked: string[] = [];
    installFetchMock((url) => {
      asked.push(new URL(url).pathname);
      if (url.endsWith("/sitemap_index.xml")) return { body: index("https://ex.test/a.xml", "https://ex.test/b.xml"), contentType: "application/xml" };
      if (url.endsWith("/a.xml")) return { body: urlset("https://ex.test/p1"), contentType: "application/xml" };
      if (url.endsWith("/b.xml")) return { body: urlset("https://ex.test/p2"), contentType: "application/xml" };
      return { status: 404, body: "" };
    });
    const s = await fetchSitemap("https://ex.test/", { sitemaps: ["https://ex.test/sitemap_index.xml"] });
    expect(s.urls.map((u) => u.loc)).toEqual(["https://ex.test/p1", "https://ex.test/p2"]);
    expect(asked).toEqual(["/sitemap_index.xml", "/a.xml", "/b.xml"]);
    expect(s.unfetched).toEqual([]);
  });

  it("guesses /sitemap.xml only when robots named none, or the named ones gave nothing", async () => {
    const asked: string[] = [];
    installFetchMock((url) => {
      asked.push(new URL(url).pathname);
      if (url.endsWith("/small.xml")) return { body: urlset("https://ex.test/p"), contentType: "application/xml" };
      if (url.endsWith("/sitemap.xml")) return { body: urlset("https://ex.test/fallback"), contentType: "application/xml" };
      return { status: 404, body: "" };
    });
    await fetchSitemap("https://ex.test/", { sitemaps: ["https://ex.test/small.xml"] });
    expect(asked).toEqual(["/small.xml"]);
    asked.length = 0;
    const s = await fetchSitemap("https://ex.test/", { sitemaps: ["https://ex.test/gone.xml"] });
    expect(asked).toEqual(["/gone.xml", "/sitemap.xml"]);
    expect(s.urls.map((u) => u.loc)).toEqual(["https://ex.test/fallback"]);
  });

  it("names the child sitemaps the budget did not reach", async () => {
    installFetchMock((url) =>
      url.endsWith("/index.xml")
        ? { body: index("https://ex.test/1.xml", "https://ex.test/2.xml", "https://ex.test/3.xml"), contentType: "application/xml" }
        : { body: urlset(url.replace(".xml", "-page")), contentType: "application/xml" },
    );
    const s = await fetchSitemap("https://ex.test/", { sitemaps: ["https://ex.test/index.xml"], max: 2 });
    expect(s.urls.map((u) => u.loc)).toEqual(["https://ex.test/1-page"]);
    expect(s.unfetched).toEqual(["https://ex.test/2.xml", "https://ex.test/3.xml"]);
  });

  it("reads a gzipped sitemap", async () => {
    installFetchMock(() => ({ bytes: gzipSync(Buffer.from(urlset("https://ex.test/g1", "https://ex.test/g2"))), contentType: "application/x-gzip" }));
    const s = await fetchSitemap("https://ex.test/", { sitemaps: ["https://ex.test/sitemap.xml.gz"] });
    expect(s.urls.map((u) => u.loc)).toEqual(["https://ex.test/g1", "https://ex.test/g2"]);
  });

  it("reads a sitemap up to the protocol's 50 MB, whatever its Content-Length", async () => {
    // 4 MB was the generic text cap: a valid 5 MB sitemap with a declared
    // length was refused outright, and gave zero URLs with no note.
    const locs = Array.from({ length: 60_000 }, (_, i) => `https://ex.test/page-with-a-long-enough-path/${i}`);
    const body = urlset(...locs);
    expect(body.length).toBeGreaterThan(4 * 1024 * 1024);
    installFetchMock(() => ({ body, contentType: "application/xml", headers: { "content-length": String(body.length) } }));
    const s = await fetchSitemap("https://ex.test/", { sitemaps: ["https://ex.test/big.xml"] });
    expect(s.urls).toHaveLength(60_000);
  });

  it("says when a sitemap is over the protocol's size", async () => {
    installFetchMock(() => ({ body: urlset("https://ex.test/p"), contentType: "application/xml", headers: { "content-length": String(60 * 1024 * 1024) } }));
    const s = await fetchSitemap("https://ex.test/", { sitemaps: ["https://ex.test/huge.xml"] });
    expect(s.notes?.join(" ")).toMatch(/huge\.xml.*50 MB/);
  });

  it("refuses a gzipped sitemap that inflates past 50 MB, or arrived cut short", async () => {
    // Capped on the way out: a small gzip can inflate a thousandfold.
    const bomb = gzipSync(Buffer.alloc(51 * 1024 * 1024, 0x20));
    installFetchMock(() => ({ bytes: bomb, contentType: "application/x-gzip" }));
    const s = await fetchSitemap("https://ex.test/", { sitemaps: ["https://ex.test/bomb.xml.gz"] });
    expect(s.urls).toEqual([]);
    expect(s.notes?.join(" ")).toMatch(/bomb\.xml\.gz decompresses past the 50 MB/);
    installFetchMock(() => ({ bytes: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01]), contentType: "application/x-gzip" }));
    const cut = await fetchSitemap("https://ex.test/", { sitemaps: ["https://ex.test/cut.xml.gz"] });
    expect(cut.notes?.join(" ")).toMatch(/cut\.xml\.gz is not valid gzip/);
  });

  it("says nothing of a sitemap the caller's own policy refused", async () => {
    installFetchMock(() => ({ body: urlset("https://ex.test/p"), contentType: "application/xml" }));
    const s = await fetchSitemap("https://ex.test/", { sitemaps: ["https://ex.test/s.xml"], authorizeUrl: async () => false });
    expect(s).toMatchObject({ urls: [], sitemaps: [] });
    expect(s.notes).toBeUndefined();
  });

  it("reads a plain-text sitemap, one URL per line", () => {
    expect(parseSitemap("https://ex.test/a\r\n\nhttps://ex.test/b\nnot a url\n").urls).toEqual([{ loc: "https://ex.test/a" }, { loc: "https://ex.test/b" }]);
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
