import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { extractFromHtml, extractMainHtml, htmlToText, looksLikeJunkExtraction, stripConsentBoilerplate } from "../src/fetch.js";
import { pdfToText } from "../src/pdf.js";
import { excerptWindows } from "../src/text.js";

describe("looksLikeJunkExtraction (consent / anti-bot detection)", () => {
  it("flags a short cookie-consent wall", () => {
    expect(looksLikeJunkExtraction("We use cookies to improve your experience. Accept all cookies to continue.")).toMatch(/cookie|consent/i);
  });
  it("flags a JavaScript-required shell", () => {
    expect(looksLikeJunkExtraction("Please enable JavaScript to view this site.")).toBeTruthy();
  });
  it("flags a Cloudflare anti-bot interstitial", () => {
    expect(looksLikeJunkExtraction("Attention Required! Cloudflare. Checking your browser before accessing.")).toBeTruthy();
  });
  it("flags Cloudflare's 'Sorry, you have been blocked' page, as extracted", () => {
    // Its only strong-sounding line, "Attention Required! | Cloudflare", is the
    // <title>, which extraction drops; the rest was all weak or unmatched.
    const html = `<!DOCTYPE html><html lang="en-US"><head><title>Attention Required! | Cloudflare</title><meta charset="UTF-8"><script>if (!navigator.cookieEnabled) {}</script></head>
<body><div id="cf-wrapper">
  <div class="cf-alert cf-alert-error cf-cookie-error" id="cookie-alert" data-translate="enable_cookies">Please enable cookies.</div>
  <div id="cf-error-details" class="cf-error-details-wrapper">
    <div class="cf-wrapper cf-header cf-error-overview">
      <h1 data-translate="block_headline">Sorry, you have been blocked</h1>
      <h2 class="cf-subheadline"><span data-translate="unable_to_access">You are unable to access</span> example.com</h2>
    </div>
    <div class="cf-section cf-highlight"><div class="cf-wrapper"><div class="cf-screenshot-container cf-screenshot-full"><span class="cf-no-screenshot error"></span></div></div></div>
    <div class="cf-section cf-wrapper"><div class="cf-columns two">
      <div class="cf-column">
        <h2 data-translate="blocked_why_headline">Why have I been blocked?</h2>
        <p data-translate="blocked_why_detail">This website is using a security service to protect itself from online attacks. The action you just performed triggered the security solution. There are several actions that could trigger this block including submitting a certain word or phrase, a SQL command or malformed data.</p>
      </div>
      <div class="cf-column">
        <h2 data-translate="blocked_resolve_headline">What can I do to resolve this?</h2>
        <p data-translate="blocked_resolve_detail">You can email the site owner to let them know you were blocked. Please include what you were doing when this page came up and the Cloudflare Ray ID found at the bottom of this page.</p>
      </div>
    </div></div>
    <div class="cf-error-footer cf-wrapper"><p class="text-13">
      <span class="cf-footer-item">Cloudflare Ray ID: <strong class="font-semibold">8c1f2e3d4a5b6c7d</strong></span>
      <span class="cf-footer-separator">&bull;</span>
      <span id="cf-footer-item-ip" class="cf-footer-item">Your IP: <button type="button" id="cf-footer-ip-reveal">Click to reveal</button><span class="hidden" id="cf-footer-ip">203.0.113.7</span></span>
      <span class="cf-footer-item"><span>Performance &amp; security by</span> <a rel="noopener noreferrer" href="https://www.cloudflare.com/5xx-error-landing" id="brand_link" target="_blank">Cloudflare</a></span>
    </p></div>
  </div>
</div></body></html>`;
    expect(looksLikeJunkExtraction(htmlToText(extractMainHtml(html)))).toMatch(/anti-bot/);
    expect(looksLikeJunkExtraction(htmlToText(html, { fullPage: true }))).toMatch(/anti-bot/);
    // An article that quotes the wall is still an article.
    const article = [
      "# Why Cloudflare shows 'Sorry, you have been blocked'",
      "The page appears when a site's web application firewall rule matches something in your request, often a word in a form field.",
      "Site owners can look the request up in the firewall events log, searching by the Ray ID the visitor sends them.",
      "Visitors cannot lift the block themselves; clearing cookies or switching networks only helps when the rule keys on them.",
    ].join("\n");
    expect(looksLikeJunkExtraction(article)).toBeUndefined();
  });
  it("flags FR/DE consent walls", () => {
    expect(looksLikeJunkExtraction("Nous utilisons des cookies pour améliorer votre expérience.")).toBeTruthy();
    expect(looksLikeJunkExtraction("Wir verwenden Cookies, um Ihre Erfahrung zu verbessern.")).toBeTruthy();
  });
  it("does NOT flag a long article that merely discusses cookies", () => {
    const article = "This article explains how HTTP cookies work. We use cookies as an example throughout. " + "A cookie is a small piece of data. ".repeat(80);
    expect(article.length).toBeGreaterThan(2000);
    expect(looksLikeJunkExtraction(article)).toBeUndefined();
  });
  it("does NOT flag ordinary short prose with no consent phrasing", () => {
    expect(looksLikeJunkExtraction("Rate limiting caps how many requests a client may make per unit time.")).toBeUndefined();
  });
});

describe("extractMainHtml (readability-lite)", () => {
  it("keeps the <article> and drops surrounding nav/footer chrome", () => {
    const html = `<html><body>
      <nav>${"menu link ".repeat(50)}</nav>
      <article><h1>Real Title</h1><p>${"the real article body about token buckets ".repeat(20)}</p></article>
      <footer>${"footer junk ".repeat(50)}</footer>
    </body></html>`;
    const main = extractMainHtml(html);
    expect(main).toContain("Real Title");
    expect(main).toContain("token buckets");
    expect(main).not.toContain("menu link");
    expect(main).not.toContain("footer junk");
  });

  it("falls back to the full document when no main region is found", () => {
    const html = "<div><p>just some content with no semantic container at all here</p></div>";
    expect(extractMainHtml(html)).toBe(html);
  });

  it("falls back when the matched region is tiny relative to the page", () => {
    const html = `<main>x</main><div>${"lots of real body content here ".repeat(200)}</div>`;
    expect(extractMainHtml(html)).toBe(html);
  });

  it("keeps every post of a thread, not just the longest one", () => {
    // A page without <main> listing repeated <article>s: an index, a forum
    // thread. Keeping only the longest dropped the question and kept the answer.
    const post = (who: string, words: number) => `<article class="message message--post"><h4>${who}</h4><p>${`${who}-said `.repeat(words)}</p></article>`;
    const html = `<nav>${"menu ".repeat(40)}</nav><h1>Thread</h1>${post("asker", 40)}${post("answerer", 120)}${post("thanks", 5)}<footer>f</footer>`;
    const text = htmlToText(extractMainHtml(html));
    expect(text).toContain("asker-said");
    expect(text).toContain("answerer-said");
    expect(text).toContain("thanks-said");
    expect(text).not.toContain("menu");
  });

  it("still keeps just the story when its siblings are a different kind of block", () => {
    const html = `<article class="story"><p>${"The council voted on the lanes. ".repeat(30)}</p></article><article class="teaser"><p>Unrelated teaser</p></article>`;
    const text = htmlToText(extractMainHtml(html));
    expect(text).toContain("The council voted");
    expect(text).not.toContain("Unrelated teaser");
  });

  it("does not count inline scripts as the text of a region", () => {
    const pricing = `<p>${"Every plan includes backups and SSL. ".repeat(9)}</p>`;
    const chat = `<p>Chat with sales</p><script>window.__CHAT__=${JSON.stringify({ greeting: "Hi! ".repeat(800) })}</script>`;
    const html = `<div class="content">${pricing}</div><div class="chat-content">${chat}</div>`;
    const text = htmlToText(extractMainHtml(html));
    expect(text).toContain("Every plan includes backups");
    expect(text).not.toContain("Chat with sales");
  });

  it("is not talked out of a real region by a data blob outside it", () => {
    // A 200 KB __NEXT_DATA__ outside <main> used to count as page text, so the
    // size gate saw a ~450-char region as a sliver of the page and refused it.
    const html = `<header>${"Product Pricing Docs ".repeat(5)}</header><aside>${"Related link ".repeat(10)}</aside><main><p>${"Pricing starts at ten euros. ".repeat(15)}</p></main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ copy: "lorem ipsum ".repeat(17_000) })}</script>`;
    const text = htmlToText(extractMainHtml(html));
    expect(text).toContain("Pricing starts at ten euros.");
    expect(text).not.toMatch(/Related link|Product Pricing Docs/);
  });

  it("isolates role=main ahead of a wider content wrapper holding the sidebar", () => {
    const sidebar = Array.from({ length: 40 }, (_, i) => `<li><a href="/p${i}">Sidebar page ${i}</a></li>`).join("");
    const html = `<div class="page-content"><div class="sphinxsidebar" role="navigation"><ul>${sidebar}</ul></div><div role="main"><h1>API reference</h1><p>${"The client exposes a single request method. ".repeat(10)}</p></div></div>`;
    const text = htmlToText(extractMainHtml(html));
    expect(text).toContain("API reference");
    expect(text).not.toContain("Sidebar page 7");
  });

  it.each(['<DIV ROLE="main">', '<div role="Main">', "<div ROLE=main>", '<section Role="main">'])("reads %s as role=main, as HTML's case rules do", (open) => {
    const sidebar = Array.from({ length: 60 }, (_, i) => `<li><a href="/p${i}">Sidebar page ${i}</a></li>`).join("");
    const close = open.startsWith("<section") ? "</section>" : "</DIV>";
    const html = `<div class="sidebar"><ul>${sidebar}</ul></div>${open}<h1>API reference</h1><p>${"The client exposes a single request method. ".repeat(30)}</p>${close}`;
    const text = htmlToText(extractMainHtml(html));
    expect(text).toContain("API reference");
    expect(text).not.toContain("Sidebar page 7");
  });

  it("does not take navigation for content because its class starts with main-", () => {
    const html = `<div class="main-nav">${"<a>Section link</a> ".repeat(80)}</div><main-nav>${"<a>Custom nav link</a> ".repeat(80)}</main-nav><div class="entry-content"><p>${"Entry prose about lanes. ".repeat(30)}</p></div>`;
    const text = htmlToText(extractMainHtml(html));
    expect(text).toContain("Entry prose about lanes.");
    expect(text).not.toMatch(/Section link|Custom nav link/);
  });
});

// Realistic page shapes, each reduced from a real template (news CMS, Sphinx,
// XenForo, Discourse, GitHub, a shop, MediaWiki, a Next.js app, consent
// managers). Every assertion is a substring a reader would quote or a piece of
// chrome that must not be quoted instead.
describe("extraction on realistic pages", () => {
  const page = (name: string) => readFileSync(join(__dirname, "fixtures", "html", `${name}.html`), "utf8");
  const extract = (name: string) => htmlToText(extractMainHtml(page(name)));

  it("blog index: keeps every post preview", () => {
    const text = extract("blogindex");
    for (const title of ["How we rebuilt our rate limiter", "Upgrading to Postgres 16 with zero downtime", "What we changed about on-call"])
      expect(text).toContain(title);
    expect(text).not.toMatch(/Careers|© Acme/);
  });

  it("forum thread: keeps the question, the answer and the follow-up", () => {
    const text = extract("forum");
    for (const marker of ["QUESTION-MARKER", "ANSWER-MARKER", "FOLLOWUP-MARKER"]) expect(text).toContain(marker);
    expect(text).not.toMatch(/What's new|XenForo/);
  });

  it("Discourse crawler view: the posts inside <noscript> still come through", () => {
    const text = extract("discourse");
    expect(text).toContain("What am I doing wrong?");
    expect(text).toContain("setInterval is not a clock.");
    expect(text).not.toMatch(/Log In|Categories|JavaScript is required/);
  });

  it("example.org as a browser renders it: every letter in its own <span>, read as words", () => {
    // The live page since 2026: /s.js wraps each letter for a cross-fade.
    const html = page("example-org-spans");
    const en =
      "This domain is for use in documentation examples without needing permission. This is not a service, avoid relying on it for testing and monitoring purposes.";
    const fr =
      "L’usage de ce domaine est réservé à des exemples de documentation, sans autorisation préalable. Il ne s’agit pas d’un service ; son utilisation à des fins de test ou de surveillance est à éviter.";
    const text = extractFromHtml(html, "https://example.org/").text;
    expect(text).toBe(`${en}\n${fr}\nLearn more`);
    const md = extractFromHtml(html, "https://example.org/", { format: "markdown" }).text;
    expect(md).toContain(en);
    expect(md).toContain(fr);
    expect(md).toContain("[Learn more](https://iana.org/help/example-domains)");
  });

  it("Next.js app: the pricing copy, not the chat widget or the data blob", () => {
    const text = extract("nextjs");
    expect(text).toContain("Start free, pay as you grow.");
    expect(text).not.toMatch(/Chat with sales|lorem ipsum|Cloudy Product/);
  });

  it("Sphinx docs: the article, without the sidebar or the breadcrumb", () => {
    const text = extract("docs");
    expect(text).toContain("Widget reads its settings from");
    expect(text).not.toMatch(/Installation|API reference|Docs »|Built with Sphinx/);
  });

  it("cookie-law article: the consent filter keeps every paragraph", () => {
    const r = stripConsentBoilerplate(extract("cookie_en_article"));
    expect(r.dropped).toBe(0);
    expect(r.text).toContain("Under the GDPR, a site must obtain informed consent");
    expect(r.text).toContain("Advertising partners frequently rely on third-party cookies");
  });

  it("news page: the consent banner outside <main> never reaches the text", () => {
    const text = extract("news");
    expect(text).toContain("The city council voted");
    expect(text).not.toMatch(/We use cookies|Accept all|Manage preferences|The Daily Planet\. All rights/);
  });

  it("news page: headings on their marker lines, no space before punctuation", () => {
    const text = extract("news");
    expect(text).toContain("# City council approves new bike lanes\n");
    expect(text).toContain("## What happens next\n");
    expect(text).toContain("By Lois Lane, March 4, 2025");
    expect(text).toContain("Councillor Perry White, will cost");
    expect(text).toContain("along Main Street and River Road, begins in May.");
    expect(text).not.toMatch(/ ,|^#+$/m);
    // The section title now reaches the excerpt that sits under it.
    expect(excerptWindows(text, "when does construction begin on Main Street")[0]?.heading).toBe("What happens next");
  });

  it("MediaWiki: formulas and links read as rendered", () => {
    const text = extract("wiki");
    expect(text).toContain("chemical formula H2O.");
    expect(text).toContain("odorless,[1] and nearly colorless chemical substance, and");
    expect(text).toContain("Earth's hydrosphere");
    expect(text).toContain("0.997 g/cm3");
  });

  it("Sphinx docs: the code sample keeps its indentation and blank line", () => {
    const text = extract("docs");
    expect(text).toContain('retries = 5\n\n[widget.proxy]\n    url = "http://proxy:3128"');
    expect(text).toContain("# Configuration\n");
    expect(text).toContain("## Options\n");
    expect(text).toContain("timeout\nSeconds before a request is abandoned. Defaults to 30.");
    expect(text).not.toContain("¶");
  });

  it("GitHub README: highlighted code reads as code, topics stay apart", () => {
    const text = extract("readme");
    expect(text).toContain('import { widget } from "widget";\n\nconst w = widget({\n  size: 3,\n  color: "red",\n});');
    // GitHub serves each topic tag on a line of its own; the whitespace
    // between them is in the page, not guessed from the tags.
    expect(text).toMatch(/widgets\s+ui/);
    expect(text).toContain("Supports Node 18+ and every evergreen browser.");
  });

  it("shop page: no option lists, and spec terms apart from their values", () => {
    const text = extract("product");
    expect(text).toContain("The Trail Runner 3 is built for technical terrain.");
    expect(text).toContain("Stack height\n30 mm / 24 mm");
    expect(text).not.toMatch(/Afghanistan|Bolivia|EU 44/);
  });

  it("FR/DE and wiki pages: named references read as letters, soft hyphens vanish", () => {
    const de = extract("cookie_de");
    expect(de).toContain("# Neue Regeln für Einwilligungsbanner");
    expect(de).toContain("Die Datenschutzkonferenz");
    expect(extract("cookie_fr")).toContain("Le cœur de la réforme");
    const wiki = extract("wiki");
    expect(wiki).not.toMatch(/&[a-z]+;/);
    expect(wiki).toContain("(εr). The Greek letter α is often used for thermal diffusivity, and μ for viscosity (about 0.89 mPa·s");
  });

  it("MediaWiki: the article body under role=main, without the side panel", () => {
    const text = extract("wiki");
    expect(text).toContain("inorganic compound");
    expect(text).not.toMatch(/Random article|About Wikipedia/);
  });
});

describe("pdfToText (dependency-free, best-effort)", () => {
  function pdf(streamBody: Buffer, filter = ""): Buffer {
    return Buffer.concat([
      Buffer.from(`%PDF-1.5\n4 0 obj\n<< ${filter}/Length ${streamBody.length} >>\nstream\n`, "latin1"),
      streamBody,
      Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
    ]);
  }

  it("extracts text from an uncompressed content stream", () => {
    const stream = Buffer.from("BT /F1 24 Tf 72 720 Td (Hello World) Tj ET", "latin1");
    expect(pdfToText(pdf(stream))).toContain("Hello World");
  });

  it("inflates a FlateDecode stream and extracts text", () => {
    const content = Buffer.from("BT /F1 12 Tf 72 700 Td (Compressed PDF text here) Tj ET", "latin1");
    const deflated = deflateSync(content);
    expect(pdfToText(pdf(deflated, "/Filter /FlateDecode "))).toContain("Compressed PDF text here");
  });

  it("joins a TJ array into words", () => {
    const stream = Buffer.from("BT [(Token)-250(bucket)-250(rate)] TJ ET", "latin1");
    const out = pdfToText(pdf(stream));
    expect(out).toContain("Token");
    expect(out).toContain("bucket");
    expect(out).toContain("rate");
  });

  it("returns empty (never throws) on non-PDF garbage", () => {
    expect(pdfToText(Buffer.from("this is not a pdf at all"))).toBe("");
  });
});
