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
  htmlCanonicalUrl,
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

describe("httpJson response cap", () => {
  it("cancels a JSON body over the cap instead of buffering it whole, and reports it", async () => {
    // httpGet streams under a cap; httpJson used res.text(), which buffers
    // whatever the endpoint sends. Firecrawl, Qdrant, Ollama and the Wayback
    // API all come through here.
    const big = JSON.stringify({ data: "x".repeat(200_000) });
    let pulled = 0;
    installFetchMock(() => ({ body: big, contentType: "application/json", chunkSize: 8_192, onPull: (n) => void (pulled += n) }));
    const r = await httpJson("GET", "https://x.test/huge", undefined, { maxBytes: 32_768, retries: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/);
    expect(r.data).toBeUndefined();
    expect(pulled).toBeLessThan(big.length / 2); // the transfer stopped near the cap
  });

  it("still parses a body under the cap", async () => {
    installFetchMock(() => ({ body: JSON.stringify({ ok: 1 }), contentType: "application/json" }));
    const r = await httpJson("GET", "https://x.test/small", undefined, { maxBytes: 32_768 });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ ok: 1 });
  });

  it("answers a body of exactly the cap, and refuses one byte more", async () => {
    // A cap that rejects its own limit is a cap of max-1. Reading only `max`
    // bytes cannot tell "exactly the cap" from "cut off at the cap", so the
    // reader takes one byte more and the check compares against that.
    const exact = JSON.stringify({ ok: 1 });
    installFetchMock(() => ({ body: exact, contentType: "application/json" }));
    const at = await httpJson("GET", "https://x.test/exact", undefined, { maxBytes: exact.length, retries: 0 });
    expect(at.ok).toBe(true);
    expect(at.data).toEqual({ ok: 1 });
    const over = await httpJson("GET", "https://x.test/exact", undefined, { maxBytes: exact.length - 1, retries: 0 });
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/too large/);
  });
});

describe("htmlToText", () => {
  it("keeps quoted greater-than signs in attributes out of the text", () => {
    expect(htmlToText(`<div data-mw='{"a > b"}' class="meta"><p>Visible</p></div>`)).toBe("Visible");
  });

  it("preserves headings and links with both attribute quote styles", () => {
    const text = htmlToText(`<h1 class="x" title='a > b'>Title</h1><a href='/p?q=">"'>link</a><p>body</p>`);
    expect(text).toContain("# Title");
    expect(text).toContain("link");
    expect(text).toContain("body");
    expect(text).not.toContain(">");
    expect(text).not.toContain("class=");
  });

  it("keeps prose between a commented-out script opener and a real script", () => {
    // The mirror image of the case below: a comment that quotes "<script>"
    // must not pair with the real </script> further down.
    const text = htmlToText("<!-- <script> --> <p>Important text</p><script>analytics()</script><p>After</p>");
    expect(text).toBe("Important text\nAfter");
  });

  it("does not treat <header> as <head>", () => {
    expect(htmlToText("<header><p>Site</p></header><p>Body</p>")).toBe("Site\nBody");
  });

  it.each(["script", "style"])("keeps prose after a comment opener inside %s", (tag) => {
    const text = htmlToText(`<${tag}>s="<!--";</${tag}><p>Price</p><!-- x -->`);
    expect(text).toContain("Price");
    expect(text).not.toContain("s=");
    expect(text).not.toContain("x");
  });

  it("removes tags even when an attribute quote is unbalanced", () => {
    expect(htmlToText('<p title="oops>Text</p>')).not.toContain("<");
  });

  it("separates unclosed list items and table cells into lines", () => {
    expect(htmlToText("<ul><li>a<li>b</ul>")).toBe("a\nb");
    expect(htmlToText("<td>x<td>y")).toBe("x\ny");
  });

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

  it("keeps a pretty-printed heading's text on its marker line", () => {
    // Templated HTML puts the text on its own line inside <hN>. The marker used
    // to land alone ("##"), and nearestHeading — which needs "## text" — lost
    // the section title for every excerpt under it.
    expect(htmlToText("<h2>\n      What happens next\n  </h2><p>May.</p>")).toBe("## What happens next\nMay.");
    expect(htmlToText("<h2>\n  Multi\n  line\n</h2>")).toBe("## Multi line");
    expect(htmlToText('<h1><span class="mw-page-title-main">Water</span></h1>')).toBe("# Water");
    expect(htmlToText("<h3>Setup <div>guide</div></h3>")).toBe("### Setup guide");
  });

  it("drops a permalink glyph from a heading, but not a heading's own '#'", () => {
    expect(htmlToText('<h2>Options<a class="headerlink" href="#options" title="Permalink">¶</a></h2>')).toBe("## Options");
    expect(htmlToText('<h2>Options<a class="headerlink" href="#options">#</a></h2>')).toBe("## Options");
    expect(htmlToText("<h2>Learn C#</h2>")).toBe("## Learn C#");
  });

  it("ends a heading at the next heading tag, as a browser does", () => {
    // A mismatched close must not pull the article into the heading line.
    expect(htmlToText("<h2>Title</h3><p>Body text.</p><h2>Next</h2>")).toBe("## Title\nBody text.\n## Next");
    expect(htmlToText("<h2>Unclosed<p>Body text.</p>")).toBe("## Unclosed\nBody text.");
  });

  it("adds no whitespace around inline elements", () => {
    expect(htmlToText("<p>un<em>believ</em>able</p>")).toBe("unbelievable");
    expect(htmlToText("<p>H<sub>2</sub>O and g/cm<sup>3</sup></p>")).toBe("H2O and g/cm3");
    expect(htmlToText('<p>By <a href="/lois">Lois Lane</a>, <time>March 4</time>.</p>')).toBe("By Lois Lane, March 4.");
    expect(htmlToText("<p><a href='/e'>Earth</a>'s hydrosphere</p>")).toBe("Earth's hydrosphere");
  });

  it("still separates adjacent inline elements and non-inline tags", () => {
    expect(htmlToText('<a class="topic-tag">widgets</a><a class="topic-tag">ui</a>')).toBe("widgets ui");
    expect(htmlToText("<span>Home</span><span>About</span>")).toBe("Home About");
    expect(htmlToText('left<img src="x.png">right')).toBe("left right");
  });

  it("keeps <pre> blocks verbatim: indentation, blank lines, highlighted tokens", () => {
    expect(htmlToText("<pre><code>def f():\n    return 1\n\n\n\nx = 2</code></pre>")).toBe("def f():\n    return 1\n\n\n\nx = 2");
    const toml =
      '<p>Example:</p><pre><span class="k">[widget]</span>\n<span class="n">timeout</span> = 60\n\n<span class="k">[widget.proxy]</span>\n<span class="w">    </span><span class="n">url</span> = <span class="s">&quot;http://proxy:3128&quot;</span>\n</pre><p>After.</p>';
    expect(htmlToText(toml)).toBe('Example:\n[widget]\ntimeout = 60\n\n[widget.proxy]\n    url = "http://proxy:3128"\nAfter.');
    expect(htmlToText("<pre>\nfirst line<br>second &lt;b&gt;</pre>")).toBe("first line\nsecond <b>");
    // The page's own NULs cannot pose as the placeholder a <pre> block rides in.
    expect(htmlToText("<pre>code</pre><p>\u00000\u0000</p>")).toBe("code\n�0�");
  });

  it("drops an unclosed script or style to the end of the page, as a browser does", () => {
    // A page cut by the response cap inside a __NEXT_DATA__ blob used to hand
    // back megabytes of raw JSON as prose.
    expect(htmlToText("<p>before</p><script>var x = '<p>not</p>';")).toBe("before");
    expect(htmlToText("<p>before</p><style>.a{content:'<p>not</p>'}")).toBe("before");
  });

  it("puts definition-list terms and descriptions on their own lines", () => {
    expect(htmlToText("<dl><dt>Term</dt><dd>Definition</dd><dt>T2</dt><dd>D2</dd></dl>")).toBe("Term\nDefinition\nT2\nD2");
    expect(htmlToText("<figure><img src=x><figcaption>A cyclist</figcaption></figure>Photo: J. Olsen")).toBe("A cyclist\nPhoto: J. Olsen");
  });

  it("drops <select> option lists, which are form widgets rather than prose", () => {
    const html = "<label>Ship to</label><select><option>Afghanistan</option><option>Albania</option></select><p>Free returns.</p>";
    expect(htmlToText(html)).toBe("Ship to\nFree returns.");
    expect(htmlToText(html, { fullPage: true })).toBe("Ship to\nFree returns.");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references", () => {
    expect(decodeEntities("a &amp; b &#39;x&#39; &#x27;y&#x27;")).toBe("a & b 'x' 'y'");
  });

  it("reads numeric references 128–159 as Windows-1252, as the HTML spec does", () => {
    // Word exports and legacy CMSes write their curly quotes and dashes this way;
    // taken literally they are invisible C1 controls and the punctuation vanishes.
    expect(decodeEntities("don&#146;t")).toBe("don’t");
    expect(decodeEntities("&#147;quoted&#148; 1&#150;2 &#128;5 &#x85;")).toBe("“quoted” 1–2 €5 …");
    // The five cp1252 leaves undefined stay what they are.
    expect(decodeEntities("&#129;")).toBe("\u0081");
  });

  it("turns NUL, surrogates and out-of-range references into U+FFFD", () => {
    expect(decodeEntities("a&#0;b")).toBe("a�b");
    expect(decodeEntities("&#xD800;&#xDFFF;")).toBe("��");
    expect(decodeEntities("&#99999999;&#x110000;&#99999999999999999999999;")).toBe("���");
  });

  it("knows HTML's named references beyond the common ones", () => {
    expect(decodeEntities("Le c&oelig;ur, &OElig;uvre, na&iuml;f")).toBe("Le cœur, Œuvre, naïf");
    expect(decodeEntities("&alpha; &beta; &Omega; &epsilon;")).toBe("α β Ω ε");
    expect(decodeEntities("x &le; y &ge; z &ne; &minus;1 &infin; &sum; &radic;")).toBe("x ≤ y ≥ z ≠ −1 ∞ ∑ √");
    expect(decodeEntities("&larr; &rarr; &rArr; &harr;")).toBe("← → ⇒ ↔");
    expect(decodeEntities("a&ensp;b&emsp;c&thinsp;d")).toBe("a b c d");
    expect(decodeEntities("&AMP; &LT; &GT; &QUOT; &COPY; &REG;")).toBe('& < > " © ®');
  });

  it("drops soft hyphens and invisible joiners, which split words for anything searching the text", () => {
    expect(decodeEntities("Einwilligungs&shy;banner Daten&#173;schutz&#xAD;konferenz")).toBe("Einwilligungsbanner Datenschutzkonferenz");
    expect(decodeEntities("a&zwnj;b&zwj;c&lrm;d&rlm;e")).toBe("abcde");
  });

  it("is still single-pass and still case-sensitive", () => {
    expect(decodeEntities("&amp;shy; &#38;oelig; &Dagger; &dagger; &Amp; &unknown;")).toBe("&shy; &oelig; ‡ † &Amp; &unknown;");
  });
});

describe("htmlTitle", () => {
  it("extracts and decodes the title", () => {
    expect(htmlTitle("<title>Foo &amp; Bar</title>")).toBe("Foo & Bar");
    expect(htmlTitle("<body>no title</body>")).toBeUndefined();
  });

  it("never takes an icon's <svg><title> for the page's", () => {
    expect(htmlTitle("<svg><title>icon</title></svg><title>Real</title>")).toBe("Real");
    expect(htmlTitle('<body><svg viewBox="0 0 1 1"><title>Search icon</title></svg><main>x</main></body>')).toBeUndefined();
    expect(htmlTitle("<title>A&nbsp;\n  B</title>")).toBe("A B");
  });

  it("stays linear on a page of unclosed <title> openers", () => {
    const started = performance.now();
    expect(htmlTitle("<title>x ".repeat(100_000))).toBeUndefined();
    expect(htmlCanonicalUrl("<link rel=canonical ".repeat(100_000))).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("htmlCanonicalUrl", () => {
  it("finds the canonical past a large inlined stylesheet", () => {
    // Next/Gatsby inline their critical CSS in <head>; a fixed 60 KB window
    // stopped before the <link> that followed it.
    const css = `.a{color:red}`.repeat(6_000);
    expect(htmlCanonicalUrl(`<head><style>${css}</style><link rel="canonical" href="https://x.test/real"></head>`)).toBe("https://x.test/real");
  });

  it("reads rel as a token list and ignores a commented-out canonical", () => {
    expect(htmlCanonicalUrl('<!-- <link rel="canonical" href="https://x.test/old"> --><link href="https://x.test/new" rel="alternate canonical">')).toBe(
      "https://x.test/new",
    );
    expect(htmlCanonicalUrl('<meta content="https://x.test/og" property="og:url">')).toBe("https://x.test/og");
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
  it("uses the whole source page with fullPage even when Firecrawl offers cleaned markdown", async () => {
    const body = "<nav>Home About</nav><article><p>Source article text</p><p>Accept all cookies</p></article>";
    installFetchMock(
      routes([
        ["/scrape", { body: JSON.stringify({ success: true, data: { markdown: "Source article text" } }), contentType: "application/json" }],
        ["fc-full.test", { body: "ok" }],
        ["x.test/source", { body, contentType: "text/html" }],
      ]),
    );
    const normal = await fetchAndExtract("https://x.test/source", { firecrawl: "http://fc-full.test" });
    expect(normal).toMatchObject({ text: "Source article text", extractor: "firecrawl" });
    const full = await fetchAndExtract("https://x.test/source", { firecrawl: "http://fc-full.test", fullPage: true });
    expect(full.text).toContain("Home About");
    expect(full.text).toContain("Accept all cookies");
    expect(full.consentDropped).toBe(0);
  });

  it("keeps navigation with fullPage while preserving opt-in library consent filtering", async () => {
    const body = `<nav>Home About</nav><article><h1>Rate limiting</h1><p>${"Token buckets smooth bursts. ".repeat(20)}</p><p>Accept all cookies</p></article><aside>Related reading</aside>`;
    installFetchMock(routes([["x.test/full-page", { body, contentType: "text/html" }]]));
    const normal = await fetchAndExtract("https://x.test/full-page");
    expect(normal.text).not.toMatch(/Home|About|Related reading/);
    expect(normal.text).toContain("Accept all cookies");
    const full = await fetchAndExtract("https://x.test/full-page", { fullPage: true });
    expect(full.text).toContain("Home About");
    expect(full.text).toContain("Related reading");
    expect(full.text).toContain("Accept all cookies");
    expect(full.consentDropped).toBe(0);
    const clean = await fetchAndExtract("https://x.test/full-page", { stripConsent: true });
    expect(clean.text).not.toContain("Accept all cookies");
    expect(clean.consentDropped).toBe(1);
    const fullDespiteConsent = await fetchAndExtract("https://x.test/full-page", { fullPage: true, stripConsent: true });
    expect(fullDespiteConsent.text).toBe(full.text);
    expect(fullDespiteConsent.consentDropped).toBe(0);
  });

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

  it("says so when an HTML page was cut at the size cap, and keeps the cut script out of the text", async () => {
    // A Next.js page whose __NEXT_DATA__ runs past the 4 MB cap: the script
    // never closes, and its JSON used to come back as megabytes of "prose"
    // with nothing saying the page was incomplete.
    const article = `<div class="wrap"><h1>Launch notes</h1><p>${"The release ships a new scheduler. ".repeat(30)}</p></div>`;
    const body = `<html><body>${article}<script id="__NEXT_DATA__" type="application/json">{"payload":"${"PAYLOADTOKEN ".repeat(420_000)}"}</script></body></html>`;
    installFetchMock(routes([["x.test/huge", { body, contentType: "text/html" }]]));
    const r = await fetchAndExtract("https://x.test/huge");
    expect(r.text).toContain("The release ships a new scheduler.");
    expect(r.text).not.toContain("PAYLOADTOKEN");
    expect(r.note).toMatch(/Read only the first \d+ bytes of https:\/\/x\.test\/huge \(the response size cap\), so this text is a prefix/);
  });

  it("resolves a relative canonical against the final URL, so it can be cited", async () => {
    installFetchMock(routes([["x.test/blog/post", { body: '<link rel="canonical" href="/blog/post-slug"><p>Body</p>', contentType: "text/html" }]]));
    expect((await fetchAndExtract("https://x.test/blog/post?utm_source=a")).canonical).toBe("https://x.test/blog/post-slug");
  });

  it("drops a canonical that resolves to no http(s) URL", async () => {
    installFetchMock(routes([["x.test/p", { body: '<link rel="canonical" href="javascript:void(0)"><p>Body</p>', contentType: "text/html" }]]));
    expect((await fetchAndExtract("https://x.test/p")).canonical).toBeUndefined();
  });

  it("titles a page without <title> from og:title, then its first <h1>, never from an icon", async () => {
    installFetchMock(
      routes([
        [
          "x.test/og",
          { body: '<meta property="og:title" content="From OG"><svg><title>Search icon</title></svg><main><h1>Heading</h1></main>', contentType: "text/html" },
        ],
        [
          "x.test/h1",
          { body: '<svg><title>Search icon</title></svg><main><h1 class="t">\n  The <em>real</em> heading\n</h1><p>x</p></main>', contentType: "text/html" },
        ],
      ]),
    );
    expect((await fetchAndExtract("https://x.test/og")).title).toBe("From OG");
    expect((await fetchAndExtract("https://x.test/h1")).title).toBe("The real heading");
  });

  it("adds no truncation note to a page that arrived whole", async () => {
    installFetchMock(routes([["x.test/small", { body: "<p>whole</p>", contentType: "text/html" }]]));
    expect((await fetchAndExtract("https://x.test/small")).note).toBeUndefined();
  });

  it("extracts a content-type-only PDF (no .pdf in the URL) from the bytes it already has — one download, not two", async () => {
    const pdf = "%PDF-1.4\nstream\nBT (PdfBodyText) Tj ET\nendstream\n"; // all-ASCII → latin1==utf8
    const spy = installFetchMock(routes([["x.test/paper", { body: pdf, contentType: "application/pdf" }]]));
    const r = await fetchAndExtract("https://x.test/paper");
    expect(r.text).toContain("PdfBodyText");
    // The URL said nothing, so the first request went out as a text fetch; the
    // response's content-type said PDF, and the bytes were kept rather than
    // pulled again. A 16 MB paper used to cost two transfers here.
    expect(spy.mock.calls.filter((c) => String(c[0]) === "https://x.test/paper")).toHaveLength(1);
  });

  it("keeps the raw bytes of a content-type-only office document as well", async () => {
    const spy = installFetchMock(
      routes([
        [
          "x.test/deck",
          { bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
        ],
      ]),
    );
    const r = await httpGet("https://x.test/deck");
    expect(r.bytes?.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not carry bytes for an ordinary page — the decoded body is the payload", async () => {
    installFetchMock(routes([["x.test/page", { body: "<p>hi</p>", contentType: "text/html" }]]));
    expect((await httpGet("https://x.test/page")).bytes).toBeUndefined();
  });

  it("refetches a content-type-only PDF that overran the text cap, rather than extracting a truncated one", async () => {
    // Found by diffing against the pre-refactor bundle. A text fetch caps at
    // 4 MB and a PDF fetch at 16, so a 5 MB PDF nobody announced arrives here
    // cut in half. Keeping those bytes replaced the refetch that gets the whole
    // file with an extraction that cannot succeed — the document simply stopped
    // being readable. Under the cap, one download is still enough.
    const big = Buffer.concat([Buffer.from(`%PDF-1.4\n${"% padding\n".repeat(60)}`), Buffer.from("\nstream\nBT (TailMarker) Tj ET\nendstream\n")]);
    let calls = 0;
    installFetchMock((url) => {
      if (!url.includes("x.test/big")) return undefined;
      calls++;
      // The second request comes from the PDF path, whose cap is larger: serve
      // the whole file then, and a body the text cap must cut on the first.
      return { bytes: big, contentType: "application/pdf" };
    });
    // A tiny cap stands in for the real 4 MB one, so the fixture stays small.
    const capped = await httpGet("https://x.test/big", { maxBytes: 64 });
    expect(capped.bytes).toBeUndefined(); // truncated ⇒ not handed on
    calls = 0;
    const whole = await httpGet("https://x.test/big", { maxBytes: 1_000_000 });
    expect(whole.bytes?.length).toBe(big.length); // complete ⇒ handed on
    expect(calls).toBe(1);
  });

  it("says when a page's text was cut at the response cap", async () => {
    const page = Buffer.from(`<html><body><article><p>${"Token buckets refill at a steady rate. ".repeat(140_000)}</p></article></body></html>`);
    for (const headers of [{ "content-length": String(page.length) }, undefined]) {
      installFetchMock(() => ({ bytes: page, contentType: "text/html", headers, chunkSize: 256 * 1024 }));
      const r = await fetchAndExtract("https://x.test/long-read");
      expect(r.text).toContain("Token buckets refill");
      expect(r.truncated).toBe(true);
      expect(r.note).toMatch(/prefix/);
    }
    installFetchMock(() => ({ body: "<p>short</p>", contentType: "text/html" }));
    const whole = await fetchAndExtract("https://x.test/short");
    expect(whole.truncated).toBeUndefined();
    expect(whole.note).toBeUndefined();
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

describe("HTML scans stay linear on hostile markup", () => {
  // Every shape below used to cost O(n²): a scan that, from each opener, read
  // to the end of the input looking for a terminator that never came. About
  // 1 MB of any of them froze the process — CLI and MCP server alike — for
  // over a minute. The bounds are an order of magnitude above the linear cost
  // and two below the quadratic one, so a slow CI box cannot flake them.
  const within = (ms: number, fn: () => unknown) => {
    const started = performance.now();
    fn();
    expect(performance.now() - started).toBeLessThan(ms);
  };

  it.each([
    ["a '<' in prose with no '>' after it", "<p>" + "if a<b then ".repeat(80_000)],
    ["unclosed <nav> openers", "<nav>x ".repeat(150_000)],
    ["unclosed comment openers", "<!-- x ".repeat(150_000)],
    ["unclosed <svg> openers", "<svg>x ".repeat(150_000)],
    ["an unterminated attribute quote per tag", '<a title="x '.repeat(80_000)],
    ["unclosed <h2> openers", "<h2>x ".repeat(150_000)],
    ["headings closed only at the very end", `${"<h2>x ".repeat(150_000)}</h2>`],
    ["unclosed <pre> openers", "<pre>x ".repeat(150_000)],
    ["unclosed <script> openers", "<p>a</p><script>x ".repeat(100_000)],
    ["adjacent inline elements", "<a>x</a>".repeat(150_000)],
    ["a heading anchor holding a long run of whitespace", `<h2><a href="#x">${" ".repeat(300_000)}x</a></h2>`],
  ])("htmlToText: %s", (_label, html) => {
    within(2000, () => htmlToText(html));
  });

  it("extractMainHtml: thousands of unclosed content containers", () => {
    within(2000, () => extractMainHtml(`<div class="comment-content"><p>${"word ".repeat(40)}</p>`.repeat(20_000)));
  });

  it("extractMainHtml: deeply nested content containers", () => {
    const n = 20_000;
    within(2000, () => extractMainHtml(`${'<div class="post"><p>word word</p>'.repeat(n)}${"</div>".repeat(n)}`));
  });

  it("extractMainHtml: one opening tag holding a long unbroken attribute run", () => {
    within(2000, () => extractMainHtml(`<div ${"a".repeat(300_000)}><p>text</p></div>`));
  });

  it("extractMainHtml: many unclosed <main>/<article> openers", () => {
    within(2000, () => extractMainHtml(`<main><article><p>${"word ".repeat(20)}</p>`.repeat(20_000)));
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

  it("refuses a document the server already declared over the cap, without reading it", async () => {
    // A prefix of a PDF is useless, so there is nothing worth downloading.
    let produced = 0;
    installFetchMock(() => ({
      body: "y".repeat(8192),
      contentType: "application/pdf",
      chunkSize: 256,
      headers: { "content-length": "8192" },
      onPull: (n) => {
        produced += n;
      },
    }));

    const r = await httpGet("https://huge.test/paper", { maxBytes: 1024 });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/response too large: 8192 bytes > 1024 cap/);
    expect(produced).toBe(0); // not a single byte of body was pulled
  });

  it("refuses an over-long answer to a Range request unread, since the range was ignored", async () => {
    let produced = 0;
    installFetchMock(() => ({ body: "z".repeat(8192), headers: { "content-length": "8192" }, onPull: (n) => void (produced += n) }));
    const r = await httpGet("https://huge.test/tail", { maxBytes: 1024, headers: { Range: "bytes=-1024" } });
    expect(r).toMatchObject({ ok: false, truncated: true });
    expect(produced).toBe(0);
  });

  it("reads the capped prefix of a text body whatever its Content-Length says", async () => {
    // The same page used to fail outright with a Content-Length and come back
    // as a prefix when chunked — readable or not on an irrelevant header.
    for (const headers of [{ "content-length": "8192" }, undefined]) {
      let produced = 0;
      installFetchMock(() => ({ body: "y".repeat(8192), chunkSize: 256, headers, onPull: (n) => void (produced += n) }));
      const r = await httpGet("https://huge.test/page", { maxBytes: 1024 });
      expect(r).toMatchObject({ ok: true, truncated: true, bytesRead: 1024 });
      expect(r.body).toBe("y".repeat(1024));
      expect(produced).toBeLessThanOrEqual(1024 + 256); // still cancelled at the cap
    }
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

  it("does not retry through a Retry-After longer than it is willing to wait, and reports the real value", async () => {
    // Retrying after 5 s knowingly sent a request the server had said not to
    // send for an hour, and the clamped 5000 hid the hour from every caller.
    const spy = installFetchMock(() => ({ status: 429, body: "", headers: { "retry-after": "3600" } }));
    const r = await httpGet("https://api.test/limited", { retries: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, status: 429, rateLimited: true, retryAfterMs: 3_600_000 });
  });

  it("still waits out a short Retry-After and tries again", async () => {
    let calls = 0;
    installFetchMock(() => (++calls === 1 ? { status: 503, body: "", headers: { "retry-after": "0" } } : { body: "back" }));
    expect(await httpGet("https://api.test/busy", { retries: 1 })).toMatchObject({ ok: true, body: "back" });
    expect(calls).toBe(2);
  });

  it("carries the throttle up through fetchAndExtract so a caller can back off", async () => {
    installFetchMock(() => ({ status: 429, body: "", headers: { "retry-after": "3600" } }));
    const r = await fetchAndExtract("https://api.test/limited");
    expect(r).toMatchObject({ text: "", status: 429, rateLimited: true, retryAfterMs: 3_600_000 });
    expect(r.note).toMatch(/rate-limited \(HTTP 429, retry after 3600 s\)/);
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
  it("keeps short prose, headings and fragments that merely mention cookies byte-identical", () => {
    const text = "HTTP cookies persist between requests.\n# Cookies\nSession cookie";
    expect(stripConsentBoilerplate(text)).toEqual({ text, dropped: 0 });
  });

  it("keeps a short line that names a regulation without asking for anything", () => {
    // Seen on MDN's cookies guide: a list item naming the GDPR is content, not
    // a banner. A topic word is the hit; it must not also count as the action.
    const text = "The General Data Privacy Regulation (GDPR) in the European Union\nCCPA compliance";
    expect(stripConsentBoilerplate(text)).toEqual({ text, dropped: 0 });
  });

  it("drops short consent actions and notices among real prose and counts them", () => {
    const text = [
      "A token bucket refills at a fixed rate.",
      "Accept all cookies",
      "We use cookies to improve your experience",
      "Reject all",
      "Manage preferences",
      "Cookie settings",
      "This website uses cookies",
      "Requests consume tokens from the bucket.",
    ].join("\n");
    expect(stripConsentBoilerplate(text)).toEqual({
      text: "A token bucket refills at a fixed rate.\nRequests consume tokens from the bucket.",
      dropped: 6,
    });
  });

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

  it.each([
    // An article ABOUT cookie law names two topics per sentence. Two hits used
    // to be enough on any line, so these were exactly the paragraphs removed.
    "Under the GDPR, a site must obtain informed consent before it sets any cookie that is not strictly necessary, and it must let users withdraw that consent as easily as they gave it.",
    "Legislation or regulations that cover the use of cookies include the General Data Privacy Regulation (GDPR) in the European Union and the California Consumer Privacy Act (CCPA).",
    'That is why so many sites show a cookie banner with an "Accept all" and a "Reject all" button: the banner is the site\'s mechanism for recording consent.',
    "Advertising partners frequently rely on third-party cookies and other tracking technologies to follow users across sites.",
    // One topic word plus a generic verb, on a line far longer than a button.
    "Allow the cookies to cool on the tray for 5 minutes.",
    "Store cookies in an airtight tin; accept that they soften after a day.",
    "Accept all incoming connections on port 443 and reject all others.",
    "Informed consent: participants may opt out at any time.",
  ])("keeps prose that merely talks about consent: %s", (line) => {
    expect(stripConsentBoilerplate(line)).toEqual({ text: line, dropped: 0 });
  });

  it("still drops a long notice written in the banner's own voice", () => {
    const text = [
      'We use cookies and similar technologies to improve your experience and for advertising. By clicking "Accept all", you consent to our use of cookies.',
      "We and our partners store and/or access information on a device, such as cookies, and process personal data.",
      "By continuing to browse this site, you agree to the use of cookies.",
      "Article prose.",
    ].join("\n");
    expect(stripConsentBoilerplate(text)).toEqual({ text: "Article prose.", dropped: 3 });
  });

  it("drops FR and DE banner notices and buttons, but not bare words", () => {
    const banner = [
      "Nous utilisons des cookies et des technologies similaires pour mesurer l'audience, personnaliser les contenus et la publicité. Vous pouvez accepter ou refuser ces cookies.",
      "Accepter et fermer",
      "Continuer sans accepter",
      "Paramétrer les cookies",
      "Tout accepter",
      "Tout refuser",
      "Wir verwenden Cookies und ähnliche Technologien, um Inhalte zu personalisieren und Werbung anzuzeigen. Mit „Alle akzeptieren“ stimmen Sie der Verarbeitung zu.",
      "Alle akzeptieren",
      "Alle ablehnen",
      "Nur notwendige Cookies",
      "Cookie-Einstellungen",
    ];
    const prose = [
      "# Einstellungen",
      "Die Datenschutzkonferenz hat neue Leitlinien für Cookie-Banner veröffentlicht.",
      "Le cœur de la réforme reste la durée de cotisation.",
    ];
    const r = stripConsentBoilerplate([...banner, ...prose].join("\n"));
    expect(r).toEqual({ text: prose.join("\n"), dropped: banner.length });
  });

  it("runs in linear time on a long line full of first-person words", () => {
    const line = "we ".repeat(300_000) + "cookies";
    const started = performance.now();
    stripConsentBoilerplate(`${line}\n${"our us ".repeat(100_000)}`);
    expect(performance.now() - started).toBeLessThan(2000);
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
