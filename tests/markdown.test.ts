import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/markdown.js";

const md = (html: string, baseUrl?: string) => htmlToMarkdown(html, baseUrl ? { baseUrl } : {});

describe("htmlToMarkdown: blocks", () => {
  it("writes headings and paragraphs, a blank line between blocks", () => {
    expect(md("<h1>Title</h1><p>First paragraph.</p><h2>Section</h2><p>Second  one,\n  wrapped.</p>")).toBe(
      "# Title\n\nFirst paragraph.\n\n## Section\n\nSecond one, wrapped.",
    );
  });

  it("keeps a pretty-printed heading on one line and drops its permalink glyph", () => {
    expect(md('<h2>\n  Rate <em>limits</em>\n  <a class="headerlink" href="#rate">¶</a>\n</h2><p>x</p>', "https://d.test/")).toBe("## Rate *limits*\n\nx");
  });

  it("keeps a heading's link to its own anchor out of the title, as MDN wraps them", () => {
    // nearestHeading would otherwise read "[Syntax](https://…#syntax)" as the section.
    expect(md('<h2 id="syntax"><a href="#syntax">Syntax</a></h2><h3><a href="/elsewhere">Elsewhere</a></h3>', "https://d.test/p")).toBe(
      "## Syntax\n\n### [Elsewhere](https://d.test/elsewhere)",
    );
    // Outside a heading, an in-page link is a table of contents and stays one.
    expect(md('<p><a href="#syntax">Syntax</a></p>', "https://d.test/p")).toBe("[Syntax](https://d.test/p#syntax)");
  });

  it("ends a heading that never closes at the next block, not at the end of the page", () => {
    expect(md("<h2>Setup<p>Install it first.</p><p>Then run it.</p>")).toBe("## Setup\n\nInstall it first.\n\nThen run it.");
  });

  it("writes unordered, ordered and nested lists, honouring start and optional </li>", () => {
    const html = '<ul><li>One<li>Two<ul><li>Two a</li><li>Two b</li></ul></li><li>Three</li></ul><ol start="4"><li>Four</li><li>Five</li></ol><p>After.</p>';
    expect(md(html)).toBe("- One\n- Two\n  - Two a\n  - Two b\n- Three\n\n4. Four\n5. Five\n\nAfter.");
  });

  it("keeps the blank line a nested list needs to start a list rather than continue a paragraph", () => {
    // An ordered list interrupts a paragraph only when it starts at 1.
    expect(md('<ul><li>Steps continued<ol start="4"><li>Fourth</li><li>Fifth</li></ol></li></ul>')).toBe("- Steps continued\n\n  4. Fourth\n  5. Fifth");
    expect(md('<ul><li>Steps<ol start="1"><li>One</li></ol></li></ul>')).toBe("- Steps\n  1. One");
    // A list opening an empty item owes what came before its blank line.
    expect(md('<p>Intro</p><ol start="3"><li><ul><li>x</li></ul></li></ol>')).toBe("Intro\n\n3. - x");
    expect(md("<blockquote><p>quoted</p></blockquote><blockquote><ul><li><ul><li>x</li></ul></li></ul></blockquote>")).toBe("> quoted\n\n> - - x");
  });

  it("keeps two lists side by side apart, switching the marker as CommonMark needs", () => {
    // A blank line alone joins them into one loose list, and renumbers the second.
    expect(md("<ul><li>a</li></ul><ul><li>b</li></ul><ul><li>c</li></ul>")).toBe("- a\n\n+ b\n\n- c");
    expect(md('<ol><li>a</li></ol><p></p><ol start="5"><li>b</li><li>c</li></ol>')).toBe("1. a\n\n5) b\n6) c");
    expect(md("<ul><li>x<ul><li>a</li></ul><ul><li>b</li></ul></li></ul>")).toBe("- x\n  - a\n  + b");
    // Anything between them already keeps them apart.
    expect(md("<ul><li>a</li></ul><h2>H</h2><ul><li>b</li></ul><ol><li>c</li></ol>")).toBe("- a\n\n## H\n\n- b\n\n1. c");
  });

  it("nests a list set straight inside another under the item before it, as a browser shows it", () => {
    expect(md("<ul><li>a</li><ul><li>b</li><li>c</li></ul><li>d</li></ul>")).toBe("- a\n  - b\n  - c\n- d");
    expect(md("<ol><li>one</li><ol><li>sub</li></ol></ol>")).toBe("1. one\n   1. sub");
  });

  it("indents an item's further paragraphs and blocks under its marker", () => {
    const html = "<ol><li><p>Configure.</p><p>Then:</p><pre>make</pre></li><li>Done.</li></ol>";
    expect(md(html)).toBe("1. Configure.\n\n   Then:\n\n   ```\n   make\n   ```\n2. Done.");
  });

  it("prefixes every line of a blockquote, nested ones included", () => {
    expect(md("<blockquote><p>Quoted.</p><p>Still quoted.</p><blockquote>Deeper.</blockquote></blockquote><p>Not quoted.</p>")).toBe(
      "> Quoted.\n>\n> Still quoted.\n>\n> > Deeper.\n\nNot quoted.",
    );
  });

  it("writes a rule as ***, which no list marker or line of text above can turn into something else", () => {
    expect(md("<p>Above</p><hr><p>Below</p>")).toBe("Above\n\n***\n\nBelow");
    expect(md("Above<hr>Below")).toBe("Above\n\n***\n\nBelow");
    // `- ---` is itself a rule, and cut the list in two: Bootstrap's dropdown dividers.
    expect(md("<ul><li>a</li><li><hr></li><li>b</li></ul>")).toBe("- a\n- ***\n- b");
    expect(md("<ul><li><hr>after rule</li></ul>")).toBe("- ***\n\n  after rule");
  });

  it("turns <br> into a hard break, and two of them into a new paragraph", () => {
    expect(md("<p>12 Main St<br>Springfield<br><br>Open daily<br></p>")).toBe("12 Main St  \nSpringfield\n\nOpen daily");
  });
});

describe("htmlToMarkdown: inline", () => {
  it("writes emphasis and strong, keeping their outer whitespace outside the markers", () => {
    expect(md("<p>A <em>very</em> <strong>big </strong>deal, <b><i>really</i></b>.</p>")).toBe("A *very* **big** deal, ***really***.");
  });

  it("moves an emphasis's edge punctuation outside its markers when a letter touches them", () => {
    // "**Note:**This" is not emphasis to CommonMark: a closing marker after
    // punctuation needs a space or punctuation after it. CJK uses no spaces.
    expect(md("<p><strong>Note:</strong>This feature is experimental.</p>")).toBe("**Note**:This feature is experimental.");
    expect(md("<p><strong>注意：</strong>此功能仅在专业版中可用。</p>")).toBe("**注意**：此功能仅在专业版中可用。");
    expect(md("<p>此<strong>「注意」</strong>功能</p>")).toBe("此「**注意**」功能");
    expect(md("<p>Le mot <em>«&nbsp;cœur&nbsp;»</em>vient du latin.</p>")).toBe("Le mot *« cœur* »vient du latin.");
    // Emphasis of nothing but punctuation is its text.
    expect(md("<p>a<b>:</b>b</p>")).toBe("a:b");
    // A space or punctuation beside the marker already lets it parse: left as written.
    expect(md("<p><strong>Note:</strong> This, <em>(x)</em>.</p>")).toBe("**Note:** This, *(x)*.");
  });

  it("adds no markers for an emphasis nested in its own kind", () => {
    expect(md("<p><b>bold <strong>still</strong> bold</b></p>")).toBe("**bold still bold**");
  });

  it("writes inline code verbatim, fenced past any backtick it holds", () => {
    expect(md("<p>Run <code>npm  i</code>, not <code>a `b` c</code> or <kbd>`</kbd>.</p>")).toBe("Run `npm i`, not ``a `b` c`` or `` ` ``.");
    // Text inside code is not escaped: `*` and `_` mean nothing there.
    expect(md("<p><code>a*b_c</code></p>")).toBe("`a*b_c`");
  });

  it("writes links with absolute targets, resolved against the base URL", () => {
    expect(md('<p>See <a href="/docs/start">the guide</a> and <a href="https://x.test/">x</a>.</p>', "https://d.test/a/b")).toBe(
      "See [the guide](https://d.test/docs/start) and [x](https://x.test/).",
    );
  });

  it("resolves against the page's own <base href>, itself resolved against the base URL", () => {
    const html = '<html><head><base href="/v2/"></head><body><p><a href="guide">Guide</a></p></body></html>';
    expect(md(html, "https://d.test/v1/page")).toBe("[Guide](https://d.test/v2/guide)");
  });

  it("resolves a path-relative <base href> against the page once", () => {
    expect(md('<base href="docs/"><a href="g">g</a>', "https://d.test/site/i.html")).toBe("[g](https://d.test/site/docs/g)");
  });

  it("ignores a <base href> that is javascript: or data:, as a browser does", () => {
    const html = '<head><base href="javascript:alert(1)//"></head><p><a href="guide">Guide</a></p>';
    expect(md(html, "https://d.test/v1/page")).toBe("[Guide](https://d.test/v1/guide)");
    expect(md(html.replace("javascript:alert(1)//", "data:text/html,x"), "https://d.test/v1/page")).toBe("[Guide](https://d.test/v1/guide)");
  });

  it("keeps a relative link as written when there is nothing to resolve it against", () => {
    expect(md('<p><a href="guide.html">Guide</a></p>')).toBe("[Guide](guide.html)");
  });

  it("drops a link that goes nowhere, keeping its text", () => {
    expect(md('<p><a href="javascript:void(0)">Menu</a> <a name="top">Top</a> <a href="/x"></a>end</p>', "https://d.test/")).toBe("Menu Top end");
  });

  it("drops a javascript: or data: target hidden behind control characters the URL parser strips", () => {
    const html = '<p><a href="&#1;javascript:alert(1)">x</a> <img src="&#2;data:image/png;base64,AA" alt="i"> <a href=" &#x1F;vbscript:msgbox">y</a></p>';
    expect(md(html)).toBe("x y");
    expect(md(html, "https://d.test/")).toBe("x y");
    expect(md('<p><a href="java&#10;script:alert(1)">z</a></p>', "https://d.test/")).toBe("z");
  });

  it("escapes parentheses only when they do not balance, and encodes spaces", () => {
    expect(md('<p><a href="https://en.wikipedia.org/wiki/Mercury_(planet)">M</a></p>')).toBe("[M](https://en.wikipedia.org/wiki/Mercury_(planet))");
    expect(md('<p><a href="notes (draft">N</a></p>')).toBe("[N](notes%20\\(draft)");
  });

  it("encodes a backslash in a target, which Markdown would read as an escape", () => {
    // The URL parser keeps '\' in a query or fragment; "\*" in a destination is "*".
    expect(md('<p><a href="https://a.com/?q=\\*x">l</a></p>')).toBe("[l](https://a.com/?q=%5C*x)");
    expect(md('<p><a href="#\\_x">f</a> <img src="i\\(1).png" alt="i"></p>', "https://d.test/p")).toBe(
      "[f](https://d.test/p#%5C_x) ![i](https://d.test/i/(1).png)",
    );
  });

  it("links every block of a link wrapped round a card", () => {
    const html = '<a href="/post/1"><h3>Post title</h3><p>The excerpt.</p></a>';
    expect(md(html, "https://blog.test/")).toBe("### [Post title](https://blog.test/post/1)\n\n[The excerpt.](https://blog.test/post/1)");
  });

  it("writes images with absolute sources and their alt text", () => {
    expect(md('<p><img src="/a.png" alt="A [chart]"> <img src="data:image/gif;base64,R0lG" data-src="b.png" alt="lazy"></p>', "https://d.test/x/")).toBe(
      "![A \\[chart\\]](https://d.test/a.png) ![lazy](https://d.test/x/b.png)",
    );
  });

  it("drops a tracking pixel and an image with nowhere to point", () => {
    expect(md('<p>Hi<img src="/px.gif" width="1" height="1"><img alt="nothing"></p>', "https://d.test/")).toBe("Hi");
  });

  it("wraps an image in its link", () => {
    expect(md('<a href="/full.png"><img src="/thumb.png" alt="Diagram"></a>', "https://d.test/")).toBe(
      "[![Diagram](https://d.test/thumb.png)](https://d.test/full.png)",
    );
  });

  it("adds no space between two inline elements set side by side, as htmlToText does", () => {
    expect(md('<p><a href="/a">One</a><a href="/b">Two</a></p>', "https://d.test/")).toBe("[One](https://d.test/a)[Two](https://d.test/b)");
    expect(md('<p><a href="/a">One</a> <a href="/b">Two</a></p>', "https://d.test/")).toBe("[One](https://d.test/a) [Two](https://d.test/b)");
  });

  it("reads per-letter and per-word spans as the words they spell", () => {
    expect(md("<p><span>T</span><span>h</span><span>i</span><span>s</span><span> </span><span>d</span><span>o</span></p>")).toBe("This do");
    expect(md("<p><span>Hello</span> <span>world</span><span>!</span></p>")).toBe("Hello world!");
    expect(md("<p><span>Hello </span><span>world</span>\n<span>again</span></p>")).toBe("Hello world again");
  });

  it("keeps a word whole around inline markup inside it", () => {
    expect(md("<p>un<b>believ</b>able</p>")).toBe("un**believ**able");
    expect(md('<p>un<a href="/x">believ</a>able</p>', "https://d.test/")).toBe("un[believ](https://d.test/x)able");
    expect(md("<p>un<span>believ</span>able</p>")).toBe("unbelievable");
  });

  it("still separates blocks, line breaks, list items and table cells built of spans", () => {
    expect(md("<p><span>One</span></p><p><span>Two</span></p>")).toBe("One\n\nTwo");
    expect(md("<ul><li><span>a</span></li><li><span>b</span></li></ul>")).toBe("- a\n- b");
    expect(md("<p><span>a</span><br><span>b</span></p>")).toBe("a  \nb");
    expect(md("<table><tr><th><span>h</span><span>1</span></th><th>h2</th></tr><tr><td><span>a</span></td><td><span>b</span></td></tr></table>")).toBe(
      "| h1 | h2 |\n| --- | --- |\n| a | b |",
    );
  });
});

describe("htmlToMarkdown: code blocks", () => {
  it("keeps a <pre> verbatim: indentation, blank lines and markup-free text", () => {
    const html = '<pre>def f():\n    return 1\n\n<span class="k">print</span>(f() &lt; 2)</pre>';
    expect(md(html)).toBe("```\ndef f():\n    return 1\n\nprint(f() < 2)\n```");
  });

  it.each([
    ['<pre><code class="language-ts">let a = 1</code></pre>', "ts"],
    ['<pre class="prettyprint lang-js">x()</pre>', "js"],
    ['<div class="highlight-python notranslate"><div class="highlight"><pre>x = 1</pre></div></div>', "python"],
    ['<div class="highlight highlight-source-rust notranslate"><pre>fn main() {}</pre></div>', "rust"],
    ['<pre><code class="hljs language-c++">int x;</code></pre>', "c++"],
    ['<pre class="brush: js notranslate"><code>map(f)</code></pre>', "js"],
    ['<pre><code class="language-none">plain</code></pre>', ""],
  ])("names the language a highlighter class gives: %s", (html, lang) => {
    expect(md(html).split("\n")[0]).toBe("```" + lang);
  });

  it("fences past any run of backticks the code holds", () => {
    expect(md("<pre>```\nnested\n```</pre>")).toBe("````\n```\nnested\n```\n````");
  });

  it("reads an unclosed <pre> as text rather than losing the rest of the page", () => {
    expect(md("<p>Intro</p><pre>code line\n<p>After</p>")).toContain("After");
  });
});

describe("htmlToMarkdown: tables", () => {
  it("writes a data table as a GFM table", () => {
    const html =
      "<p>Plans:</p><table><tr><th>Plan</th><th>Price</th></tr><tr><td>Free</td><td>$0</td></tr><tr><td>Pro | Team</td><td>$9</td></tr></table><p>End.</p>";
    expect(md(html)).toBe("Plans:\n\n| Plan | Price |\n| --- | --- |\n| Free | $0 |\n| Pro \\| Team | $9 |\n\nEnd.");
  });

  it("writes a layout table's cells as blocks, not as one enormous row", () => {
    const html = '<table role="presentation"><tr><td><h1>Site</h1></td></tr><tr><td><p>Article text.</p><ul><li>point</li></ul></td></tr></table>';
    expect(md(html)).toBe("# Site\n\nArticle text.\n\n- point");
    const nested = "<table><tr><td><table><tr><th>K</th></tr><tr><td>V</td></tr></table></td><td><p>Side</p></td></tr></table>";
    expect(md(nested)).toBe("| K |\n| --- |\n| V |\n\nSide");
  });

  it("keeps a code block verbatim when a table only lays it out, as Pygments' line numbers do", () => {
    const html =
      '<div class="highlight-python"><table class="highlighttable"><tr><td class="linenos"><div class="linenodiv"><pre>1\n2</pre></div></td>' +
      '<td class="code"><div class="highlight"><pre>def f():\n    return 1</pre></div></td></tr></table></div>';
    expect(md(html)).toContain("```python\ndef f():\n    return 1\n```");
  });

  it("escapes a cell's own syntax, as it does a paragraph's", () => {
    const html = "<table><caption>Engines [1]</caption><tr><th>*API*</th></tr><tr><td>Accepts &lt;length&gt; | a\\b</td></tr></table>";
    expect(md(html)).toBe("**Engines \\[1\\]**\n\n| \\*API\\* |\n| --- |\n| Accepts \\<length> \\| a\\\\b |");
  });

  it("puts a table inside a list item under the item's indentation", () => {
    expect(md("<ul><li>Limits:<table><tr><th>A</th></tr><tr><td>1</td></tr></table></li></ul>")).toBe("- Limits:\n\n  | A |\n  | --- |\n  | 1 |");
  });
});

describe("htmlToMarkdown: what is not the page", () => {
  it("drops scripts, styles, templates and comments", () => {
    expect(md("<p>Kept</p><script>var x = '<p>no</p>';</script><style>p{}</style><template><p>no</p></template><!-- <p>no</p> -->")).toBe("Kept");
  });

  it("takes no <script> quoted in an attribute for one, and keeps the page after it", () => {
    // With no real </script> after it, the quoted opener ran to the end of the
    // page and left the half-eaten <img> behind.
    const html =
      '<h1>Scripts</h1><figure><img src="/d.png" alt="how a <script> tag works"><figcaption>Timeline</figcaption></figure><h2>Defer</h2><p>Later.</p>';
    expect(md(html, "https://d.test/")).toBe("# Scripts\n\n![how a \\<script> tag works](https://d.test/d.png)\n\nTimeline\n\n## Defer\n\nLater.");
  });

  it("drops navigation, footers and chrome landmarks unless fullPage", () => {
    const html = '<nav><a href="/">Home</a></nav><div role="navigation">Crumbs</div><p>Body</p><footer>Legal</footer>';
    expect(md(html)).toBe("Body");
    const full = htmlToMarkdown(html, { fullPage: true, baseUrl: "https://d.test/" });
    expect(full).toContain("[Home](https://d.test/)");
    expect(full).toContain("Crumbs");
    expect(full).toContain("Legal");
  });
});

describe("htmlToMarkdown: escaping", () => {
  it("escapes the text's own syntax so it reads back as the same text", () => {
    expect(md("<p>5 * 3 = 15, see [1], a `tick`, a \\ and &lt;b&gt;bold&lt;/b&gt; &amp;copy;</p>")).toBe(
      "5 \\* 3 = 15, see \\[1\\], a \\`tick\\`, a \\\\ and \\<b>bold\\</b> \\&copy;",
    );
  });

  it("leaves an underscore inside a word alone, and escapes one at a word's edge", () => {
    expect(md("<p>Set rate_limit_ms, not _private or __init__.</p>")).toBe("Set rate_limit_ms, not \\_private or \\_\\_init\\_\\_.");
  });

  it("escapes a line start that would read as a block marker", () => {
    const html =
      "<p># not a heading</p><p>1986. A good year</p><p>- not a bullet</p><p>&gt; not a quote</p><p>+ plus</p><p>===</p><p>C# is fine</p><p>+1 too</p>";
    expect(md(html).split("\n\n")).toEqual([
      "\\# not a heading",
      "1986\\. A good year",
      "\\- not a bullet",
      "\\> not a quote",
      "\\+ plus",
      "\\===",
      "C# is fine",
      "+1 too",
    ]);
  });

  it("escapes a heading's trailing hashes, which would read as its closing sequence", () => {
    expect(md("<h2>Section #</h2>")).toBe("## Section \\#");
    // A title of nothing but hashes (a glossary's "#" section) was an empty heading.
    expect(md("<h2>#</h2>")).toBe("## \\#");
    expect(md("<h3>##</h3>")).toBe("### \\##");
    expect(md("<h2>C#</h2>")).toBe("## C#");
  });

  it("escapes a '!' written straight before a link, which would make it an image", () => {
    expect(md('<p>Warning!<a href="https://x.test/">read this</a> Wow! <a href="https://x.test/">ok</a></p>')).toBe(
      "Warning\\![read this](https://x.test/) Wow! [ok](https://x.test/)",
    );
  });

  it("escapes a doubled tilde, which GFM reads as strikethrough", () => {
    expect(md("<p>~~gone~~ ~5 minutes</p>")).toBe("\\~\\~gone\\~\\~ ~5 minutes");
  });

  it("escapes every tilde that could close a strikethrough, single ones too, as GitHub strikes ~text~", () => {
    // A tilde with a space before it only opens, and an opener with no closer is text.
    expect(md("<p>Price ~5~ now</p>")).toBe("Price ~5\\~ now");
    expect(md("<p>Installed in C:\\PROGRA~1\\MICROS~1\\Office</p>")).toBe("Installed in C:\\\\PROGRA\\~1\\\\MICROS\\~1\\\\Office");
    // Where a run of text starts against the one before, or inside an
    // emphasis whose marker will stand before it, its first tilde can close too.
    expect(md("<p>~<span>~x~</span>~</p>")).toBe("~\\~x\\~\\~");
    expect(md("<p>costs ~5 or <em>~ 10</em></p>")).toBe("costs ~5 or *\\~ 10*");
    expect(md("<p>a <span>~b</span></p>")).toBe("a ~b");
  });

  it("escapes syntax an element splits in two, which joins up again in the Markdown", () => {
    // Each run of text is escaped on its own: a '<' at the end of one, a tag
    // name at the start of the next, was a live tag once written side by side.
    expect(md("<p>&lt;<span>script</span>&gt;alert(1)&lt;/script&gt;</p>")).toBe("\\<script>alert(1)\\</script>");
    expect(md('<p>Use the &lt;<span class="tag">img</span> src=x onerror=alert(1)&gt; element</p>')).toBe("Use the \\<img src=x onerror=alert(1)> element");
    expect(md("<p>&amp;<span>amp;</span> and &amp;<b>#38;</b></p>")).toBe("\\&amp; and \\&**#38;**");
    expect(md('<h2>&lt;<a href="#s">script</a>&gt;</h2>', "https://d.test/")).toBe("## \\<script>");
    // A '<' or '&' with a space after it was never syntax, and stays as written.
    expect(md("<p>a &lt; <b>b</b> &amp; c</p>")).toBe("a < **b** & c");
  });
});

describe("htmlToMarkdown stays linear on hostile markup", () => {
  // The shapes that made htmlToText quadratic, plus the ones peculiar to a
  // writer with stacks: closes that search for an opener, prefixes that grow
  // with depth, wrappers that copy what they wrap. Linear work here is tens of
  // milliseconds; the bound is generous so that only a superlinear pass fails
  // it on a slow shared runner.
  const within = (ms: number, fn: () => unknown) => {
    const started = performance.now();
    fn();
    expect(performance.now() - started).toBeLessThan(ms);
  };

  it.each([
    ["a '<' in prose with no '>' after it", "<p>" + "if a<b then ".repeat(80_000)],
    ["unclosed comment openers", "<!-- x ".repeat(150_000)],
    ["an unterminated attribute quote per tag", '<a title="x '.repeat(80_000)],
    ["script openers quoted in attributes", '<img alt="<script>">'.repeat(100_000)],
    ["unclosed <h2> openers", "<h2>x ".repeat(150_000)],
    ["a heading of hashes and spaces", `<h2>${"## ".repeat(100_000)}#x</h2>`],
    ["headings closed only at the very end", `${"<h2>x ".repeat(150_000)}</h2>`],
    ["unclosed <pre> openers", "<pre>x ".repeat(150_000)],
    ["unclosed links", '<a href="/x">x '.repeat(100_000)],
    ["unclosed emphasis", "<b>x <i>y ".repeat(100_000)],
    ["closes with no opener", "</b></a></code></li></ul></blockquote>x".repeat(50_000)],
    ["unclosed lists", "<ul><li>x".repeat(60_000)],
    ["unclosed blockquotes", "<blockquote>x ".repeat(100_000)],
    ["deep blockquotes, then their closes", `${"<blockquote><p>x</p>".repeat(30_000)}${"</blockquote>".repeat(30_000)}`],
    ["a list above a pile of blockquotes, then stray </li>s", `<ul>${"<blockquote>".repeat(30_000)}${"</li>".repeat(30_000)}`],
    ["emphasis ending in punctuation against a letter", "<p>" + "a<b>「x:</b>y<i><b>(:</b></i>z".repeat(40_000)],
    ["one emphasis of punctuation against letters", `<p>a<b>${":".repeat(300_000)}</b>b`],
    ["one emphasis holding thousands of breaks", `<b>${"<br>".repeat(150_000)}x</b>`],
    ["a code span of backticks", `<code>${"`".repeat(300_000)}</code>`],
    ["a pre of whitespace", `<pre>${" ".repeat(300_000)}x${" \n".repeat(100_000)}</pre>`],
    ["unclosed tables", "<table><tr><td>x".repeat(40_000)],
    ["nested tables", `${"<table><tr><td>x".repeat(10_000)}${"</td></tr></table>".repeat(10_000)}`],
    ["many small tables", "<table><tr><th>a</th></tr><tr><td>b</td></tr></table>".repeat(20_000)],
    ["many tables before one far-off code block", `${"<table><tr><td>a</td></tr></table>".repeat(20_000)}<pre>x</pre>`],
    ["unclosed divs round a pre", `${'<div class="highlight-x">'.repeat(50_000)}<pre>x</pre>`],
    ["a link wrapped round thousands of blocks", `<a href="/x">${"<p>word</p>".repeat(60_000)}</a>`],
    ["underscores and tildes", "<p>" + "_~".repeat(200_000)],
    ["runs of text that end in '<' or an entity's start", "<p>" + "&amp;a1<i>&lt;</i>".repeat(80_000)],
    ["runs of text that start with a tilde, in emphasis and out", "<p>" + "<b><i>~x</i></b>a<span>~</span> ~".repeat(50_000)],
    ["one run holding an entity's name to its end", `<p>${"&a&#".repeat(50_000)}&${"a".repeat(300_000)}<b>x</b>`],
  ])("%s", (_label, html) => {
    within(10_000, () => htmlToMarkdown(html, { baseUrl: "https://d.test/" }));
  });
});
