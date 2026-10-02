import { describe, expect, it } from "vitest";
import {
  CONSENT_SELECTORS,
  findOverlays,
  OVERLAY_INFO_SOURCE,
  OVERLAY_ROOT_SOURCE,
  OVERLAYS_SOURCE,
  overlayRootOf,
  READ_DOCUMENT,
} from "../src/browser/overlay.js";
import { FakePage } from "./helpers/fake-page.js";

// The overlay probe runs in the page. Here it runs against a tiny stand-in DOM:
// elements with a box, a computed style and a parent, roots that answer
// elementFromPoint with whatever the test says is on top.

type Style = { display: string; visibility: string; opacity: string; position: string };
type Rect = { left: number; top: number; width: number; height: number };

class Root {
  children: El[] = [];
  /** What elementFromPoint answers, wherever it is asked. */
  top: El | null = null;
  constructor(
    readonly nodeType: 9 | 11,
    readonly host: El | null = null,
  ) {}
  querySelectorAll(sel: string): El[] {
    if (sel !== "*") throw new Error(`unexpected selector ${sel}`);
    return this.children.flatMap((c) => [c, ...c.querySelectorAll("*")]);
  }
  elementFromPoint(): El | null {
    return this.top;
  }
}

class El {
  readonly nodeType = 1;
  children: El[] = [];
  parentElement: El | null = null;
  parentNode: El | Root | null = null;
  shadowRoot: Root | null = null;
  open = false;
  style: Style = { display: "block", visibility: "visible", opacity: "1", position: "static" };
  rect: Rect = { left: 0, top: 0, width: 100, height: 20 };
  textContent = "";
  constructor(
    readonly tagName: string,
    readonly attrs: Record<string, string> = {},
  ) {}
  getAttribute(n: string): string | null {
    return this.attrs[n] ?? null;
  }
  /** Only `#id` selectors, in a list: enough for the consent vendors' ids. */
  matches(sel: string): boolean {
    return sel.split(",").some((s) => s.trim() === `#${this.attrs.id ?? "\u0000"}`);
  }
  querySelectorAll(sel: string): El[] {
    if (sel !== "*") throw new Error(`unexpected selector ${sel}`);
    return this.children.flatMap((c) => [c, ...c.querySelectorAll("*")]);
  }
  getBoundingClientRect() {
    const r = this.rect;
    return { ...r, right: r.left + r.width, bottom: r.top + r.height };
  }
  getRootNode(): El | Root {
    let n: El | Root = this;
    while (n instanceof El && n.parentNode) n = n.parentNode;
    return n;
  }
  add(...kids: El[]): this {
    for (const k of kids) {
      k.parentElement = this;
      k.parentNode = this;
      this.children.push(k);
    }
    return this;
  }
  attachShadow(...kids: El[]): Root {
    const root = new Root(11, this);
    for (const k of kids) {
      k.parentNode = root;
      root.children.push(k);
    }
    this.shadowRoot = root;
    return root;
  }
}

const VW = 1000;
const VH = 800;

function page() {
  const doc = new Root(9);
  const html = new El("HTML");
  const body = new El("BODY");
  html.add(body);
  html.parentNode = doc;
  doc.children.push(html);
  const d = Object.assign(doc, { body, documentElement: html });
  return { doc: d, body };
}

const el = (tag: string, over: { attrs?: Record<string, string>; style?: Partial<Style>; rect?: Partial<Rect>; text?: string } = {}): El => {
  const e = new El(tag, over.attrs ?? {});
  e.style = { ...e.style, ...over.style };
  e.rect = { ...e.rect, ...over.rect };
  e.textContent = over.text ?? "";
  return e;
};

/** Run a page function against the stand-in: `document`, `window` and `getComputedStyle` are the only globals it gets. */
function inPage(src: string, doc: unknown, self?: unknown, ...args: unknown[]): any {
  const win = { innerWidth: VW, innerHeight: VH };
  const gcs = (e: El) => e.style;
  return new Function("document", "window", "getComputedStyle", `return (${src});`)(doc, win, gcs).apply(self, args);
}

const FULL = { left: 0, top: 0, width: VW, height: VH };

describe("the in-page overlay probe", () => {
  it("finds a visible dialog, alertdialog, aria-modal element and open <dialog>, and skips hidden ones", () => {
    const { doc, body } = page();
    const dialog = el("DIV", { attrs: { role: "dialog" } });
    const alert = el("DIV", { attrs: { role: "alertdialog" } });
    const modal = el("SECTION", { attrs: { "aria-modal": "true" } });
    const native = el("DIALOG");
    native.open = true;
    const closed = el("DIALOG");
    const hidden = el("DIV", { attrs: { role: "dialog" }, style: { display: "none" } });
    const invisible = el("DIV", { attrs: { role: "dialog" }, style: { visibility: "hidden" } });
    const transparent = el("DIV", { attrs: { role: "dialog" }, style: { opacity: "0" } });
    const empty = el("DIV", { attrs: { role: "dialog" }, rect: { width: 0, height: 0 } });
    body.add(dialog, alert, modal, native, closed, hidden, invisible, transparent, empty);
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([dialog, alert, modal, native]);
  });

  it("finds a fixed element over a large part of the viewport that is on top", () => {
    const { doc, body } = page();
    const wall = el("DIV", { style: { position: "fixed" }, rect: FULL, text: "We value your privacy" });
    const box = el("DIV", { rect: { left: 300, top: 200, width: 400, height: 400 } });
    wall.add(box);
    const article = el("ARTICLE", { rect: { left: 0, top: 0, width: VW, height: 3000 }, text: "A long article ".repeat(100) });
    body.add(article, wall);
    doc.top = box; // the centre point lands inside the wall
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([wall]);
  });

  it("counts an element whose ancestor (up to the body's child) is fixed, never one only sticky", () => {
    const { doc, body } = page();
    const sticky = el("DIV", { style: { position: "sticky" }, rect: { left: 0, top: 0, width: VW, height: VH } });
    body.add(sticky);
    doc.top = sticky;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([]);
    const shell = el("DIV", { style: { position: "fixed" }, rect: { left: 0, top: 0, width: 0, height: 0 } });
    const panel = el("DIV", { rect: { left: 0, top: 300, width: VW, height: 500 } });
    shell.add(panel);
    body.add(shell);
    doc.top = panel;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([panel]);
  });

  it("ignores a fixed element that is under something else, too small, a narrow side column, or holds the page's main content", () => {
    const { doc, body } = page();
    const under = el("DIV", { style: { position: "fixed" }, rect: FULL });
    const small = el("DIV", { style: { position: "fixed" }, rect: { left: 0, top: 700, width: VW, height: 100 } });
    const sidebar = el("NAV", { style: { position: "fixed" }, rect: { left: 0, top: 0, width: 300, height: VH } });
    const app = el("DIV", { style: { position: "fixed" }, rect: FULL });
    app.add(el("MAIN"));
    const other = el("DIV");
    body.add(under, small, sidebar, app, other);
    doc.top = other;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([]);
    // On top, the app shell is still not an overlay: it holds the main landmark.
    doc.top = app;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([]);
    // Nor is a static element, however big.
    const big = el("DIV", { rect: FULL });
    body.add(big);
    doc.top = big;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([]);
  });

  it("ignores a fixed layer that holds most of the page's text: that is the page, not something over it", () => {
    const { doc, body } = page();
    const layer = el("DIV", { style: { position: "fixed" }, rect: FULL, text: "x".repeat(900) });
    body.add(layer, el("P", { text: "y".repeat(100) }));
    (body as El).textContent = "x".repeat(900) + "y".repeat(100);
    doc.top = layer;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([]);
  });

  it("keeps the outermost overlay only: a dialog inside a fixed backdrop is the backdrop's", () => {
    const { doc, body } = page();
    const backdrop = el("DIV", { style: { position: "fixed" }, rect: FULL });
    const dialog = el("DIV", { attrs: { role: "dialog" }, rect: { left: 300, top: 200, width: 400, height: 300 } });
    backdrop.add(dialog);
    body.add(backdrop);
    doc.top = dialog;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([backdrop]);
  });

  it("looks into open shadow roots, asking the shadow root what is on top", () => {
    const { doc, body } = page();
    const host = el("CMP-ROOT", { rect: { width: 0, height: 0 } });
    const banner = el("DIV", { style: { position: "fixed" }, rect: FULL });
    const root = host.attachShadow(banner);
    body.add(host);
    doc.top = host; // the document only sees the host
    root.top = banner;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([banner]);
  });

  it("does not take a fixed half-screen column for an overlay: over the middle means strictly across it", () => {
    const { doc, body } = page();
    const column = el("DIV", { style: { position: "fixed" }, rect: { left: 0, top: 0, width: VW / 2, height: VH } });
    body.add(column);
    doc.top = column;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([]);
  });

  it("skips what is inside a layer it rejected as the page itself", () => {
    const { doc, body } = page();
    const app = el("DIV", { style: { position: "fixed" }, rect: FULL, text: "x".repeat(1000) });
    const feed = el("DIV", { rect: { left: 350, top: 0, width: 650, height: VH }, text: "x".repeat(550) });
    app.add(el("NAV", { rect: { left: 0, top: 0, width: 350, height: VH }, text: "x".repeat(450) }), feed);
    body.add(app);
    (body as El).textContent = "x".repeat(1000);
    doc.top = feed;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([]);
    // A dialog inside it still counts.
    const modal = el("DIV", { attrs: { role: "dialog" }, rect: { left: 300, top: 200, width: 400, height: 300 } });
    feed.add(modal);
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([modal]);
  });

  it("takes no hidden dialog: under an ancestor at opacity 0, aria-hidden or inert, or off the screen", () => {
    const { doc, body } = page();
    const faded = el("DIV", { style: { opacity: "0", position: "fixed" }, rect: FULL });
    faded.add(el("DIV", { attrs: { role: "dialog" } }));
    const muted = el("DIV", { attrs: { "aria-hidden": "true" } });
    muted.add(el("DIV", { attrs: { role: "dialog" } }));
    const inert = el("DIV", { attrs: { inert: "" } });
    inert.add(el("DIV", { attrs: { role: "dialog" } }));
    const drawer = el("DIV", {
      attrs: { role: "dialog", "aria-modal": "true" },
      style: { position: "fixed" },
      rect: { left: VW, top: 0, width: 300, height: VH },
    });
    body.add(faded, muted, inert, drawer);
    doc.top = null;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([]);
  });

  it("looks past a presentational root (not in the accessibility tree) to the dialog inside it", () => {
    const { doc, body } = page();
    const root = el("DIV", { attrs: { role: "presentation" }, style: { position: "fixed" }, rect: FULL });
    const backdrop = el("DIV", { attrs: { "aria-hidden": "true" }, style: { position: "fixed" }, rect: FULL });
    const dialog = el("DIV", { attrs: { role: "dialog" }, rect: { left: 300, top: 240, width: 400, height: 240 } });
    root.add(backdrop, dialog);
    body.add(root);
    doc.top = dialog;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([dialog]);
  });

  it("takes a consent vendor's visible container for an overlay whatever its size", () => {
    const { doc, body } = page();
    const bar = el("DIV", { attrs: { id: "onetrust-banner-sdk" }, style: { position: "fixed" }, rect: { left: 0, top: 680, width: VW, height: 120 } });
    const gone = el("DIV", { attrs: { id: "CybotCookiebotDialog" }, style: { display: "none" } });
    body.add(el("P"), bar, gone);
    doc.top = null;
    expect(inPage(OVERLAYS_SOURCE, doc)).toEqual([bar]);
  });

  it("finds nothing without a body or a viewport, and at most five overlays", () => {
    expect(inPage(OVERLAYS_SOURCE, { body: null })).toEqual([]);
    const { doc, body } = page();
    for (let i = 0; i < 8; i++) body.add(el("DIV", { attrs: { role: "dialog" } }));
    expect(inPage(OVERLAYS_SOURCE, doc)).toHaveLength(5);
  });
});

describe("the in-page overlay root of a node", () => {
  it("is the probe's overlay that holds the node", () => {
    const { doc, body } = page();
    const wall = el("DIV", { style: { position: "fixed" }, rect: FULL });
    const button = el("BUTTON");
    wall.add(el("DIV").add(button));
    body.add(wall);
    doc.top = button;
    expect(inPage(OVERLAY_ROOT_SOURCE, doc, button)).toBe(wall);
  });

  it("else the nearest dialog, else the outermost fixed or sticky ancestor, else nothing", () => {
    const { doc, body } = page();
    const bar = el("DIV", { style: { position: "fixed" }, rect: { left: 0, top: 700, width: VW, height: 100 } });
    const inner = el("DIV", { style: { position: "fixed" } });
    const text = el("SPAN");
    bar.add(inner.add(text));
    const pop = el("DIV", { attrs: { role: "dialog" }, rect: { width: 0, height: 0 } });
    const link = el("A");
    pop.add(link);
    const plain = el("P");
    body.add(bar, pop, plain);
    doc.top = plain;
    expect(inPage(OVERLAY_ROOT_SOURCE, doc, text)).toBe(bar);
    expect(inPage(OVERLAY_ROOT_SOURCE, doc, link)).toBe(pop);
    expect(inPage(OVERLAY_ROOT_SOURCE, doc, plain)).toBeNull();
  });

  it("walks out of a shadow root to its host", () => {
    const { doc, body } = page();
    const host = el("X-BANNER", { style: { position: "fixed" } });
    const btn = el("BUTTON");
    host.attachShadow(btn);
    body.add(host);
    doc.top = null;
    expect(inPage(OVERLAY_ROOT_SOURCE, doc, btn)).toBe(host);
  });
});

describe("what the overlay root is", () => {
  const info = (doc: unknown, self: El) => inPage(OVERLAY_INFO_SOURCE, doc, self);

  it("is an overlay when the probe finds it, when it is a dialog, or a consent vendor's", () => {
    const { doc, body } = page();
    const wall = el("DIV", { style: { position: "fixed" }, rect: FULL, text: "Cookies" });
    const dialog = el("DIV", { attrs: { role: "dialog" }, rect: { width: 0, height: 0 } });
    const vendor = el("DIV", { attrs: { id: "usercentrics-root" }, rect: { width: 0, height: 0 } });
    body.add(wall, dialog, vendor);
    doc.top = wall;
    expect(info(doc, wall)).toEqual({ what: '<div> "Cookies"', overlay: true });
    expect(info(doc, dialog).overlay).toBe(true);
    expect(info(doc, vendor).overlay).toBe(true);
  });

  it("is no overlay when it is only a fixed bar, a sticky header or a chat bubble", () => {
    const { doc, body } = page();
    const header = el("HEADER", { style: { position: "sticky" }, rect: { left: 0, top: 0, width: VW, height: 80 }, text: "Shop" });
    body.add(header);
    doc.top = header;
    expect(info(doc, header)).toEqual({ what: '<header> "Shop"', overlay: false });
  });
});

describe("findOverlays", () => {
  it("evaluates the probe, turns each element into its backendNodeId and releases what it held", async () => {
    const p = new FakePage();
    p.handle("Runtime.evaluate", () => ({ result: { type: "object", subtype: "array", objectId: "arr" } }));
    p.handle("Runtime.getProperties", () => ({
      result: [
        { name: "0", value: { type: "object", subtype: "node", objectId: "n1" } },
        { name: "1", value: { type: "object", subtype: "node", objectId: "n2" } },
        { name: "length", value: { type: "number", value: 2 } },
        { name: "__proto__", value: { type: "object", objectId: "proto" } },
      ],
    }));
    p.handle("DOM.describeNode", ({ objectId }) => ({ node: { backendNodeId: objectId === "n1" ? 41 : 42 } }));
    expect(await findOverlays(p)).toEqual([41, 42]);
    const evaluate = p.calls.find((c) => c.method === "Runtime.evaluate")?.params;
    expect(evaluate.expression).toContain(OVERLAYS_SOURCE);
    expect(evaluate.returnByValue).toBe(false);
    expect(p.calls.at(-1)).toEqual({ method: "Runtime.releaseObjectGroup", params: { objectGroup: evaluate.objectGroup } });
  });

  it("never throws: a page that throws, answers nothing, or will not describe a node has no overlay", async () => {
    const throwing = new FakePage();
    throwing.handle("Runtime.evaluate", () => {
      throw new Error("Execution context was destroyed");
    });
    expect(await findOverlays(throwing)).toEqual([]);
    const silent = new FakePage();
    expect(await findOverlays(silent)).toEqual([]);
    const thrown = new FakePage();
    thrown.handle("Runtime.evaluate", () => ({ exceptionDetails: { text: "boom" }, result: { type: "object", objectId: "x" } }));
    expect(await findOverlays(thrown)).toEqual([]);
    const stubborn = new FakePage();
    stubborn.handle("Runtime.evaluate", () => ({ result: { type: "object", objectId: "arr" } }));
    stubborn.handle("Runtime.getProperties", () => ({ result: [{ name: "0", value: { objectId: "n1" } }] }));
    stubborn.handle("DOM.describeNode", () => {
      throw new Error("Could not find node");
    });
    expect(await findOverlays(stubborn)).toEqual([]);
  });
});

describe("overlayRootOf", () => {
  it("runs the root finder on the hit node and names the root", async () => {
    const p = new FakePage();
    p.handle("Runtime.callFunctionOn", ({ objectId, functionDeclaration }) => {
      if (objectId === "hit") {
        expect(functionDeclaration).toBe(OVERLAY_ROOT_SOURCE);
        return { result: { type: "object", subtype: "node", objectId: "root" } };
      }
      expect(functionDeclaration).toBe(OVERLAY_INFO_SOURCE);
      return { result: { type: "object", value: { what: '<div#cmp role="dialog"> "We use cookies"', overlay: true } } };
    });
    p.handle("DOM.describeNode", ({ objectId }) => ({ node: { backendNodeId: objectId === "root" ? 77 : 0 } }));
    expect(await overlayRootOf(p, "hit")).toEqual({ backendNodeId: 77, what: '<div#cmp role="dialog"> "We use cookies"', overlay: true });
    expect(p.methods().at(-1)).toBe("Runtime.releaseObjectGroup");
  });

  it("is undefined when there is no root, or the page fails", async () => {
    const none = new FakePage();
    none.handle("Runtime.callFunctionOn", () => ({ result: { type: "object", subtype: "null", value: null } }));
    expect(await overlayRootOf(none, "hit")).toBeUndefined();
    const failing = new FakePage();
    failing.handle("Runtime.callFunctionOn", () => {
      throw new Error("No node with given id");
    });
    expect(await overlayRootOf(failing, "hit")).toBeUndefined();
  });
});

describe("the consent-free document", () => {
  it("names the containers of the common consent vendors in one list", () => {
    for (const s of [
      "#onetrust-consent-sdk",
      "#onetrust-banner-sdk",
      "#didomi-host",
      'div[class^="didomi-"]',
      'div[class^="truste_"]',
      '[id^="sp_message_container"]',
      ".qc-cmp2-container",
      "#CybotCookiebotDialog",
      "#usercentrics-root",
      "#truste-consent-track",
      'iframe[name="__tcfapiLocator"]',
    ]) {
      expect(CONSENT_SELECTORS).toContain(s);
    }
  });

  it("never names <body> or <html> by a class prefix (a scroll lock such as didomi-popup-open)", () => {
    for (const s of CONSENT_SELECTORS) expect(s, s).not.toMatch(/^\[class/);
  });

  it("reads an inert copy of the document (parsed, never cloned in the live page) with the overlays, dialogs and vendor containers dropped, and unmarks the live page", () => {
    expect(READ_DOCUMENT).not.toContain("cloneNode");
    expect(READ_DOCUMENT).toContain("new DOMParser()");
    expect(READ_DOCUMENT).toContain("outerHTML");
    expect(READ_DOCUMENT).toMatch(/finally \{[^}]*removeAttribute/);
    // body and html are never dropped, whatever matches them.
    expect(READ_DOCUMENT).toMatch(/el === parsed\.body \|\| el === parsed\.documentElement/);
    expect(READ_DOCUMENT).toContain(OVERLAYS_SOURCE);
    for (const s of CONSENT_SELECTORS) expect(READ_DOCUMENT).toContain(JSON.stringify(s));
  });
});
