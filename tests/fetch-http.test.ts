import { afterEach, describe, expect, it, vi } from "vitest";
import {
  htmlToText,
  decodeEntities,
  htmlTitle,
  bestExcerpt,
  capExtract,
  fetchAndExtract,
  httpGet,
  httpJson,
  extractMainHtml,
  looksLikeJunkExtraction,
  rescueViaWayback,
  detectRateLimited,
  parseRetryAfter,
  stripConsentBoilerplate,
  metaDescriptionOf,
} from "../src/fetch.js";
import { installFetchMock, routes } from "./fetchmock.js";

afterEach(() => vi.unstubAllGlobals());

describe("Accept-Language header", () => {
  it("httpGet sends accept-language only when opts.acceptLanguage is given", async () => {
    const spy = installFetchMock(() => ({ body: "ok" }));
    await httpGet("https://x.test/a", { acceptLanguage: "de-DE,de;q=0.9,en;q=0.5" });
    await httpGet("https://x.test/b");
    expect((spy.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "accept-language": "de-DE,de;q=0.9,en;q=0.5" });
    expect((spy.mock.calls[1]![1] as RequestInit).headers).not.toHaveProperty("accept-language");
  });

  it("httpJson sends accept-language when given", async () => {
    const spy = installFetchMock(() => ({ body: "{}", contentType: "application/json" }));
    await httpJson("GET", "https://x.test/j", undefined, { acceptLanguage: "fr-FR,fr;q=0.9,en;q=0.5" });
    expect((spy.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "accept-language": "fr-FR,fr;q=0.9,en;q=0.5" });
  });
});

describe("htmlToText", () => {
  it("strips script/style/nav and keeps heading + prose", () => {
    const html = `<html><head><title>T</title></head><body>
      <nav>menu junk</nav>
      <script>var x = 1;</script>
      <h2>Configuration</h2>
      <p>The timeout option controls retries.</p>
      <footer>copyright</footer></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("## Configuration");
    expect(text).toContain("The timeout option controls retries.");
    expect(text).not.toContain("menu junk");
    expect(text).not.toContain("var x");
    expect(text).not.toContain("copyright");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references", () => {
    expect(decodeEntities("a &amp; b &#39;x&#39; &#x27;y&#x27;")).toBe("a & b 'x' 'y'");
  });
});

describe("htmlTitle", () => {
  it("extracts and decodes the title", () => {
    expect(htmlTitle("<title>Foo &amp; Bar</title>")).toBe("Foo & Bar");
    expect(htmlTitle("<body>no title</body>")).toBeUndefined();
  });
});

describe("bestExcerpt", () => {
  it("returns the window most relevant to the question", () => {
    const text = ["Intro line about nothing.", "## Token bucket", "A token bucket refills tokens at a steady rate.", "Unrelated trailing line."].join("\n");
    const ex = bestExcerpt(text, "how does a token bucket refill");
    expect(ex.toLowerCase()).toContain("token bucket");
  });
});

describe("capExtract", () => {
  it("keeps everything on deep, truncates on standard", () => {
    const long = "x\n".repeat(10000);
    expect(capExtract(long, "deep")).toBe(long);
    expect(capExtract(long, "standard").length).toBeLessThan(long.length);
    expect(capExtract(long, "standard")).toContain("… [truncated]");
  });
});

describe("fetchAndExtract", () => {
  it("returns cleaned text + title for an html page", async () => {
    installFetchMock(routes([["example.com", { body: "<title>Doc</title><h1>Hi</h1><p>body text</p>" }]]));
    const r = await fetchAndExtract("https://example.com/x");
    expect(r.title).toBe("Doc");
    expect(r.text).toContain("body text");
  });
  it("returns a note (not a throw) on a failed fetch", async () => {
    installFetchMock(() => ({ status: 500, body: "" }));
    const r = await fetchAndExtract("https://example.com/x");
    expect(r.text).toBe("");
    expect(r.note).toMatch(/Could not fetch/);
  });

  it("extracts a content-type-only PDF (no .pdf in the URL) by re-fetching the bytes", async () => {
    const pdf = "%PDF-1.4\nstream\nBT (PdfBodyText) Tj ET\nendstream\n"; // all-ASCII → latin1==utf8
    installFetchMock(routes([["x.test/paper", { body: pdf, contentType: "application/pdf" }]]));
    const r = await fetchAndExtract("https://x.test/paper");
    expect(r.text).toContain("PdfBodyText");
  });

  it("returns a note when a PDF yields no extractable text", async () => {
    installFetchMock(routes([["x.test/scan.pdf", { body: "%PDF-1.4 no text operators here", contentType: "application/pdf" }]]));
    const r = await fetchAndExtract("https://x.test/scan.pdf");
    expect(r.text).toBe("");
    expect(r.note).toMatch(/could not extract text/i);
  });
});

describe("extractMainHtml", () => {
  it("isolates the <main> region and drops the surrounding chrome", () => {
    const main = `<p>${"real article prose about rate limiting and token buckets. ".repeat(20)}</p>`;
    const html = `<body><nav>menu</nav><main>${main}</main><footer>copyright junk</footer></body>`;
    const out = extractMainHtml(html);
    expect(out).toContain("token buckets");
    expect(out).not.toContain("copyright junk");
  });

  it("falls back to the whole document when the matched region is too small", () => {
    const big = "filler ".repeat(400); // makes the page large so a tiny main is <30%
    const html = `<body><p>${big}</p><main>tiny</main></body>`;
    expect(extractMainHtml(html)).toBe(html); // size gate → unchanged
  });
});

describe("looksLikeJunkExtraction", () => {
  it("flags a short consent/JS/anti-bot wall in EN, FR and DE", () => {
    expect(looksLikeJunkExtraction("We use cookies to improve your experience. Accept all cookies")).toMatch(/cookie/i);
    expect(looksLikeJunkExtraction("Please enable JavaScript to continue")).toMatch(/javascript/i);
    expect(looksLikeJunkExtraction("Nous utilisons des cookies pour améliorer.")).toMatch(/fr/);
    expect(looksLikeJunkExtraction("Wir verwenden Cookies auf dieser Seite.")).toMatch(/de/);
  });

  it("never flags a long genuine article, even one that mentions cookies", () => {
    const article = "This article explains HTTP cookies in depth. We use cookies as an example. " + "x ".repeat(1200);
    expect(looksLikeJunkExtraction(article)).toBeUndefined();
  });
});

describe("rescueViaWayback", () => {
  it("returns undefined when the availability API reports no snapshot", async () => {
    installFetchMock(routes([["archive.org/wayback/available", { body: JSON.stringify({ archived_snapshots: {} }), contentType: "application/json" }]]));
    expect(await rescueViaWayback("https://gone.test/x")).toBeUndefined();
  });

  it("returns undefined when the snapshot page is itself a junk/consent wall", async () => {
    installFetchMock((url) => {
      if (url.includes("archive.org/wayback/available"))
        return {
          body: JSON.stringify({ archived_snapshots: { closest: { available: true, url: "https://web.archive.org/snap", timestamp: "2020" } } }),
          contentType: "application/json",
        };
      if (url.includes("web.archive.org/snap")) return { body: "<body>We use cookies. Accept all cookies to continue.</body>" };
      return undefined;
    });
    expect(await rescueViaWayback("https://gone.test/x")).toBeUndefined();
  });

  it("recovers text + snapshot metadata from a usable Wayback snapshot", async () => {
    const body = `<body><article><p>${"recovered archival prose about rate limiting. ".repeat(30)}</p></article></body>`;
    installFetchMock((url) => {
      if (url.includes("archive.org/wayback/available"))
        return {
          body: JSON.stringify({ archived_snapshots: { closest: { available: true, url: "https://web.archive.org/snap", timestamp: "20200102" } } }),
          contentType: "application/json",
        };
      if (url.includes("web.archive.org/snap")) return { body };
      return undefined;
    });
    const r = await rescueViaWayback("https://gone.test/x");
    expect(r?.text).toContain("recovered archival prose");
    expect(r?.snapshotUrl).toBe("https://web.archive.org/snap");
    expect(r?.timestamp).toBe("20200102");
  });
});

describe("the byte cap is a cap on the download, not on the value", () => {
  // The regression this guards: httpGet used to do `await res.arrayBuffer()` and
  // then `.subarray(0, max)`. Every byte the server sent was allocated first and
  // trimmed afterwards, so `maxBytes` bounded the returned string while the
  // process still paid for the whole response. On a hostile or merely large URL
  // that is the difference between 4 MB and however much the origin feels like
  // sending.
  it("cancels the transfer once the cap is reached", async () => {
    let produced = 0;
    const CAP = 1024;
    installFetchMock(() => ({
      body: "x".repeat(512 * 1024),
      chunkSize: 256,
      onPull: (n) => {
        produced += n;
      },
    }));

    const r = await httpGet("https://big.test/page", { maxBytes: CAP });

    expect(r.body.length).toBe(CAP);
    // The producer must stop right after the cap — one chunk of slack, not 512×.
    expect(produced).toBeLessThanOrEqual(CAP + 256);
    expect(produced).toBeLessThan(512 * 1024);
  });

  it("refuses a body the server already declared over the cap, without reading it", async () => {
    let produced = 0;
    installFetchMock(() => ({
      body: "y".repeat(8192),
      chunkSize: 256,
      headers: { "content-length": "8192" },
      onPull: (n) => {
        produced += n;
      },
    }));

    const r = await httpGet("https://huge.test/page", { maxBytes: 1024 });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/response too large: 8192 bytes > 1024 cap/);
    expect(produced).toBe(0); // not a single byte of body was pulled
  });

  it("caps binary bodies the same way", async () => {
    const r = await (async () => {
      installFetchMock(() => ({ bytes: Buffer.alloc(64 * 1024, 7), chunkSize: 512 }));
      return httpGet("https://big.test/doc.bin", { maxBytes: 2048, binary: true });
    })();
    expect(r.bytes?.length).toBe(2048);
  });
});

describe("cache validators and throttling signals", () => {
  it("surfaces ETag and Last-Modified so a stale entry can be revalidated", async () => {
    installFetchMock(() => ({
      body: "hello",
      headers: { etag: '"abc123"', "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT" },
    }));
    const r = await httpGet("https://x.test/a");
    expect(r.etag).toBe('"abc123"');
    expect(r.lastModified).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
  });

  it("passes caller headers through, which is what conditional GET rides on", async () => {
    const spy = installFetchMock(() => ({ status: 304, body: "" }));
    const r = await httpGet("https://x.test/a", { headers: { "If-None-Match": '"abc123"' } });
    expect((spy.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "if-none-match": '"abc123"' });
    // 304 has no body by definition — that is a valid answer, not a short read.
    expect(r.status).toBe(304);
    expect(r.body).toBe("");
  });

  it("reads a 403 with an exhausted quota as rate limiting, and a plain 403 as not", async () => {
    installFetchMock(() => ({ status: 403, body: "", headers: { "x-ratelimit-remaining": "0" } }));
    expect((await httpGet("https://api.test/a")).rateLimited).toBe(true);

    installFetchMock(() => ({ status: 403, body: "" }));
    expect((await httpGet("https://api.test/b")).rateLimited).toBe(false);
  });

  // Driven directly rather than through httpGet: the retry loop sleeps for the
  // delay it just parsed and then parses the SAME header again, by which time an
  // HTTP-date has passed and correctly reads as 0. That is right for the loop and
  // useless for pinning the parser.
  it("parses Retry-After as delta-seconds or as an HTTP-date", () => {
    const h = (v: string) => new Headers({ "retry-after": v });
    expect(parseRetryAfter(h("2"))).toBe(2000);
    expect(parseRetryAfter(h("0"))).toBe(0);
    expect(parseRetryAfter(h("-5"))).toBe(0); // never negative
    expect(parseRetryAfter(h("900"), 5000)).toBe(5000); // clamped
    expect(parseRetryAfter(new Headers())).toBeUndefined(); // absent ≠ zero
    expect(parseRetryAfter(h("not-a-date"))).toBeUndefined();

    const ms = parseRetryAfter(h(new Date(Date.now() + 3000).toUTCString()));
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it("detectRateLimited separates an exhausted quota from a plain refusal", () => {
    expect(detectRateLimited(429, new Headers())).toBe(true);
    expect(detectRateLimited(403, new Headers({ "x-ratelimit-remaining": "0" }))).toBe(true);
    expect(detectRateLimited(403, new Headers({ "x-ratelimit-remaining": "57" }))).toBe(false);
    expect(detectRateLimited(403, new Headers())).toBe(false);
    expect(detectRateLimited(200, new Headers())).toBe(false);
  });
});

describe("stripConsentBoilerplate", () => {
  it("drops banner lines and counts them, keeping the article", () => {
    const text = [
      "# Rate limiting",
      "We use cookies and similar tracking technologies to personalise ads.",
      "Accept all",
      "Reject all",
      "A token bucket refills at a fixed rate and caps at its burst size.",
      "Manage preferences",
    ].join("\n");
    const r = stripConsentBoilerplate(text);
    expect(r.dropped).toBe(4);
    expect(r.text).toContain("token bucket refills");
    expect(r.text).toContain("# Rate limiting");
    expect(r.text).not.toMatch(/Accept all|Reject all|tracking technolog|Manage preferences/);
  });

  it("keeps real prose that merely mentions cookies once", () => {
    // The failure mode worth guarding: an article ABOUT cookies losing the
    // sentence someone wanted to cite. One hit on a long line is not a banner.
    const line =
      "The session cookie is signed with the server key, which is why rotating that key logs everybody out at once and why you should stage the rotation.";
    const r = stripConsentBoilerplate(line);
    expect(r.dropped).toBe(0);
    expect(r.text).toBe(line);
  });

  it("leaves text with no banners byte-identical", () => {
    const text = "# Title\n\nordinary prose\nmore prose";
    expect(stripConsentBoilerplate(text)).toEqual({ text, dropped: 0 });
  });
});

describe("metaDescriptionOf", () => {
  it("reads name=description in either attribute order, then og:description", () => {
    expect(metaDescriptionOf('<meta name="description" content="A token bucket primer">')).toBe("A token bucket primer");
    expect(metaDescriptionOf('<meta content="Reversed attrs" name="description">')).toBe("Reversed attrs");
    expect(metaDescriptionOf('<meta property="og:description" content="OG fallback">')).toBe("OG fallback");
  });

  it("prefers name=description over og:description", () => {
    const html = '<meta property="og:description" content="og"><meta name="description" content="primary">';
    expect(metaDescriptionOf(html)).toBe("primary");
  });

  it("collapses whitespace and decodes entities", () => {
    expect(metaDescriptionOf('<meta name="description" content="a &amp; b\n   c">')).toBe("a & b c");
  });

  it("returns undefined when there is none, or it is empty", () => {
    expect(metaDescriptionOf("<html><body>no head</body></html>")).toBeUndefined();
    expect(metaDescriptionOf('<meta name="description" content="   ">')).toBeUndefined();
  });
});
