import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ActionError,
  type ActionSession,
  back,
  click,
  evaluate,
  fill,
  forward,
  handleDialog,
  hover,
  PAGE_FUNCTIONS,
  press,
  reload,
  resolveRef,
  screenshot,
  scroll,
  select,
  typeText,
  upload,
} from "../src/browser/actions.js";
import { CdpError } from "../src/browser/cdp.js";
import type { BrowserDeps } from "../src/browser/deps.js";
import { DESCRIBE_SOURCE } from "../src/browser/overlay.js";
import { COLLECT_SOURCE, RiskRefusedError } from "../src/browser/risk.js";
import type { NavigationResult } from "../src/browser/session.js";
import { StaleRefError } from "../src/browser/snapshot.js";
import { readRefs, writeRefs } from "../src/browser/state.js";
import { UsageError } from "../src/cli-kit.js";
import { FakePage, fakeClock } from "./helpers/fake-page.js";

// A tiny page behind a FakePage: elements by backendNodeId, the CDP commands the
// actions send answered from them. The page functions that are pure logic (hit
// test, option matching, element checks) run for real against plain objects.

interface El {
  tag: string;
  type?: string;
  id?: string;
  role?: string;
  text?: string;
  value?: string;
  editable?: boolean;
  multiple?: boolean;
  options?: { value: string; label: string }[];
  quads?: number[][];
  /** The node found at its centre; itself by default. */
  hit?: number;
  /** The address of a link (<a href>). */
  href?: string;
  parent?: number;
  /** What the risk collector reads as its label. */
  label?: string;
  /** Ignores Input.insertText, as a React-controlled input whose state was not updated. */
  stubborn?: boolean;
  /** Reverts whatever it is given. */
  frozen?: boolean;
  /** 11 for a shadow root (3 for a text node); an element by default. */
  nodeType?: number;
  /** A shadow root's host. */
  host?: number;
}

const BOX = [[0, 0, 100, 0, 100, 40, 0, 40]];
const run = (src: string, self: unknown, args: unknown[]): unknown => new Function(`return (${src});`)().apply(self, args);

class World {
  page = new FakePage();
  clock = fakeClock();
  loader = "L1";
  url = "https://a.test/";
  title = "A page";
  els = new Map<number, El>();
  focused: number | undefined;
  /** What `document.activeElement` looks like to the risk collector. */
  active = { role: "textbox", label: "", isSubmit: true, formHasPassword: false, submitLabel: "Search" };
  scrollPos = { x: 0, y: 0 };
  events: string[] = [];
  dialogOpen = false;
  private nodes = new Map<number, unknown>();
  readonly doc = {};

  constructor() {
    const p = this.page;
    p.handle("Page.getFrameTree", () => ({ frameTree: { frame: { id: "F", loaderId: this.loader, url: this.url } } }));
    p.handle("DOM.resolveNode", ({ backendNodeId }) => {
      if (!this.els.has(backendNodeId)) throw new CdpError("DOM.resolveNode", -32000, "No node with given id found");
      return { object: { objectId: `o${backendNodeId}` } };
    });
    p.handle("DOM.getContentQuads", ({ backendNodeId }) => ({ quads: this.el(backendNodeId).quads ?? BOX }));
    p.handle("DOM.getNodeForLocation", () => ({ backendNodeId: this.hitFor ?? 0, frameId: "F" }));
    p.handle("DOM.focus", ({ backendNodeId }) => {
      this.focused = backendNodeId;
    });
    p.handle("Input.insertText", ({ text }) => {
      const el = this.focused === undefined ? undefined : this.els.get(this.focused);
      if (el && !el.stubborn && !el.frozen) el.value = text;
    });
    p.handle("Input.dispatchKeyEvent", (e) => {
      const el = this.focused === undefined ? undefined : this.els.get(this.focused);
      if (el && e.type === "keyDown" && e.text && e.text !== "\r") el.value = (el.value ?? "") + e.text;
    });
    p.handle("Runtime.callFunctionOn", (params) => this.callFunctionOn(params));
    p.handle("Runtime.evaluate", ({ expression }) => {
      if (expression.includes(COLLECT_SOURCE)) return { result: { value: this.active } };
      if (expression.includes("scroll")) return { result: { value: this.scrollPos } };
      if (expression === "document.readyState") return { result: { value: "complete" } };
      return {};
    });
    p.handle("Page.handleJavaScriptDialog", () => {
      if (!this.dialogOpen) throw new CdpError("Page.handleJavaScriptDialog", -32000, "No dialog is showing");
      this.dialogOpen = false;
    });
    p.handle("Page.captureScreenshot", () => ({ data: Buffer.from("PNGDATA").toString("base64") }));
    p.handle("DOM.describeNode", ({ objectId }) => ({ node: { backendNodeId: Number(String(objectId).slice(1)) } }));
    p.handle("Accessibility.getFullAXTree", () => ({ nodes: this.ax }));
    p.handle("Page.getLayoutMetrics", () => ({
      cssLayoutViewport: { pageX: 0, pageY: 500, clientWidth: 1280, clientHeight: 800 },
      cssContentSize: { x: 0, y: 0, width: 1280, height: 4000 },
    }));
  }

  /** The node at the centre of the element being hit-tested. */
  hitFor: number | undefined;
  /** The overlay root the page finds for a node a click landed on instead of its target. */
  overlayRoot: number | undefined;
  /** Whether the page calls that root an overlay, or only something fixed in the way. */
  rootIsOverlay = true;
  /** The accessibility tree, for the controls of an overlay. */
  ax: unknown[] = [];

  el(id: number): El {
    const el = this.els.get(id);
    if (!el) throw new Error(`no element ${id}`);
    return el;
  }

  add(id: number, el: El): void {
    this.els.set(id, el);
  }

  /** A plain object standing in for the DOM node, live over the El (same object every time, so `===` works). */
  node(id: number): any {
    const known = this.nodes.get(id);
    if (known) return known;
    const el = this.el(id);
    const world = this;
    const n: any = {
      nodeType: el.nodeType ?? 1,
      tagName: el.tag,
      id: el.id ?? "",
      ownerDocument: this.doc,
      isContentEditable: !!el.editable,
      multiple: !!el.multiple,
      get type() {
        return el.type ?? (el.tag === "INPUT" ? "text" : "");
      },
      get value() {
        return el.value ?? "";
      },
      get innerText() {
        return el.editable ? (el.value ?? "") : (el.text ?? "");
      },
      get parentNode() {
        return el.parent === undefined ? null : world.node(el.parent);
      },
      get host() {
        return el.host === undefined ? undefined : world.node(el.host);
      },
      getAttribute: (name: string) => (name === "role" ? (el.role ?? null) : name === "type" ? (el.type ?? null) : null),
      options: (el.options ?? []).map((o) => ({ value: o.value, label: o.label, text: o.label, selected: false })),
      selectedIndex: -1,
      dispatchEvent: (e: Event) => {
        world.events.push(e.type);
        return true;
      },
    };
    this.nodes.set(id, n);
    return n;
  }

  private callFunctionOn({ objectId, functionDeclaration, arguments: args = [] }: any): unknown {
    const id = Number(String(objectId).slice(1));
    const el = this.el(id);
    if (functionDeclaration === COLLECT_SOURCE) {
      // A frame is told apart by the real collector (it has no contentDocument here: another origin's), and so is a node that is no element.
      if (el.tag === "IFRAME" || (el.nodeType ?? 1) !== 1) return { result: { value: run(COLLECT_SOURCE, this.node(id), ["click"]) } };
      return { result: { value: { role: el.role ?? "button", label: el.label ?? el.text ?? "", isSubmit: false, formHasPassword: false, submitLabel: "" } } };
    }
    const name = /^function (\w+)/.exec(functionDeclaration)?.[1];
    const argv = args.map((a: any) => (a.objectId ? this.node(Number(String(a.objectId).slice(1))) : a.value));
    switch (name) {
      case "hitTest":
      case "fieldKind":
      case "fileInput":
      case "matchOptions":
        return { result: { value: run(functionDeclaration, this.node(id), argv) } };
      case "applyOptions": {
        const self = this.node(id);
        const value = run(functionDeclaration, self, argv);
        el.value = String((value as string[])[0] ?? "");
        return { result: { value } };
      }
      case "linkHref":
        return { result: { value: el.href ?? null } };
      case "overlayRoot":
        return this.overlayRoot === undefined
          ? { result: { type: "object", subtype: "null", value: null } }
          : { result: { type: "object", subtype: "node", objectId: `o${this.overlayRoot}` } };
      case "overlayInfo":
        return {
          result: { value: { what: run(`function () { ${DESCRIBE_SOURCE} return describe(this); }`, this.node(id), []), overlay: this.rootIsOverlay } },
        };
      case "selectAll":
        this.events.push(`select-all ${id}`);
        return { result: {} };
      case "readValue":
        return { result: { value: el.value ?? "" } };
      case "setValue":
        this.events.push(`set-value ${id}`);
        if (!el.frozen) el.value = argv[0];
        return { result: {} };
      default:
        throw new Error(`unexpected page function ${name}`);
    }
  }
}

let w: World;
let session: ActionSession & { back(): Promise<NavigationResult>; forward(): Promise<NavigationResult>; reload(): Promise<NavigationResult> };
let deps: Partial<BrowserDeps>;
const files = new Map<string, "file" | "dir">();

const nav = (loaderId: string, url: string) => async (): Promise<NavigationResult> => {
  w.loader = loaderId;
  w.url = url;
  return { url, loaderId };
};

beforeEach(() => {
  w = new World();
  session = {
    page: w.page,
    targetId: "T1",
    loaderId: async () => w.loader,
    currentUrl: async () => w.url,
    title: async () => w.title,
    back: nav("L0", "https://a.test/prev"),
    forward: nav("L2", "https://a.test/next"),
    reload: nav("L3", "https://a.test/"),
  };
  files.clear();
  deps = {
    now: w.clock.now,
    sleep: w.clock.sleep,
    fs: {
      stat: async (p: string) => {
        const kind = files.get(p);
        if (!kind) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: "ENOENT" });
        return { isFile: () => kind === "file", isDirectory: () => kind === "dir", mtimeMs: 0, size: 1 };
      },
    } as unknown as BrowserDeps["fs"],
  };
  writeRefs("T1", { loaderId: "L1", url: "https://a.test/", next: 10, refs: { e1: 101, e2: 102, e3: 103, e4: 104, e5: 105, e6: 106, e9: 999 } });
});

afterEach(() => {
  // Nothing an action registers may outlive it: the MCP server keeps one session for hours.
  expect(w.page.listenerCount()).toBe(0);
});

/** The DOM and Input commands, in order: the shape of an action, without the settle and probe around it. */
const domInput = () => w.page.calls.filter((c) => /^(DOM|Input)\./.test(c.method)).map((c) => c.method);
const mouse = () => w.page.calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params);
const keys = () => w.page.calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params);
const fnCalls = () =>
  w.page.calls.filter((c) => c.method === "Runtime.callFunctionOn").map((c) => /^function (\w+)/.exec(c.params.functionDeclaration)?.[1] ?? "collect");

// --- refs ------------------------------------------------------------------------

describe("resolveRef", () => {
  it("hands back the node and a handle on it", async () => {
    w.add(101, { tag: "BUTTON" });
    expect(await resolveRef(session, "e1")).toEqual({ ref: "e1", backendNodeId: 101, objectId: "o101" });
  });

  it("calls a ref the table does not know stale", async () => {
    await expect(resolveRef(session, "e77")).rejects.toBeInstanceOf(StaleRefError);
    expect(w.page.calls).toEqual([]);
  });

  it("calls every ref stale once the page has navigated since the snapshot, in English only", async () => {
    w.add(101, { tag: "BUTTON" });
    w.loader = "L2";
    const err = await resolveRef(session, "e1").catch((e) => e);
    expect(err).toBeInstanceOf(StaleRefError);
    expect(err.message).toBe('ref "e1" is unknown or stale: take a new snapshot and use the refs it returns');
  });

  it("refuses what is not a ref (a CSS selector) as a usage error, before asking the page anything", async () => {
    for (const bad of ["table.infobox", "#main", "E12", "e", "e1 ", ""]) {
      const err = await resolveRef(session, bad).catch((e) => e);
      expect(err, bad).toBeInstanceOf(UsageError);
      expect(err.message).toBe("expected a ref like e12 from the latest snapshot; CSS selectors: use --selector (screenshot, snapshot, text, wait)");
    }
    expect(w.page.calls).toEqual([]);
  });

  it("calls a ref stale when its node is gone from the document", async () => {
    await expect(resolveRef(session, "e9")).rejects.toBeInstanceOf(StaleRefError);
  });

  it("calls a ref stale when no snapshot was ever taken of the tab", async () => {
    session = { ...session, targetId: "T-unseen" };
    await expect(resolveRef(session, "e1")).rejects.toBeInstanceOf(StaleRefError);
  });

  it("lets a transport failure through: a timeout is not a stale ref", async () => {
    w.page.handle("DOM.resolveNode", () => {
      throw new Error("CDP command timed out: DOM.resolveNode (30000 ms)");
    });
    await expect(resolveRef(session, "e1")).rejects.toThrow(/timed out/);
  });
});

// --- click -----------------------------------------------------------------------

describe("click", () => {
  it("scrolls, finds the box, hit-tests and sends a real press and release at its centre", async () => {
    w.add(101, { tag: "BUTTON", text: "Next", quads: [[10, 20, 110, 20, 110, 60, 10, 60]] });
    w.hitFor = 101;
    const r = await click(session, "e1", { deps });
    expect(domInput()).toEqual([
      "DOM.resolveNode",
      "DOM.resolveNode",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getContentQuads",
      "DOM.getNodeForLocation",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
    expect(mouse()).toEqual([
      { type: "mouseMoved", x: 60, y: 40, button: "none", buttons: 0 },
      { type: "mousePressed", x: 60, y: 40, button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", x: 60, y: 40, button: "left", buttons: 0, clickCount: 1 },
    ]);
    // The hit test takes document coordinates: the box's, plus the scroll (pageY 500 here); the mouse takes the viewport's.
    expect(w.page.calls.find((c) => c.method === "DOM.getNodeForLocation")?.params).toEqual({ x: 60, y: 540, includeUserAgentShadowDOM: true });
    expect(r).toEqual({ ok: true, action: "click", ref: "e1", navigated: false, url: "https://a.test/", title: "A page", challenge: null });
  });

  it("aims at whole pixels: Chrome refuses a fractional point to DOM.getNodeForLocation", async () => {
    w.add(101, { tag: "BUTTON", text: "Next", quads: [[58, 58, 86.59375, 58, 86.59375, 79, 58, 79]] });
    w.hitFor = 101;
    await click(session, "e1", { deps });
    expect(w.page.calls.find((c) => c.method === "DOM.getNodeForLocation")?.params).toEqual({ x: 72, y: 569, includeUserAgentShadowDOM: true });
    expect(mouse().map(({ x, y }) => [x, y])).toEqual([
      [72, 69],
      [72, 69],
      [72, 69],
    ]);
  });

  it("arms the settle before the mouse goes down, and releases the handles it took", async () => {
    w.add(101, { tag: "BUTTON" });
    w.hitFor = 101;
    await click(session, "e1", { deps });
    const methods = w.page.methods();
    expect(methods.indexOf("Network.enable")).toBeLessThan(methods.indexOf("Input.dispatchMouseEvent"));
    expect(w.page.calls.filter((c) => c.method === "Runtime.releaseObject").map((c) => c.params.objectId)).toContain("o101");
  });

  it("accepts a hit on a descendant of the target, checked in the page", async () => {
    w.add(101, { tag: "BUTTON" });
    w.add(150, { tag: "SPAN", parent: 101 });
    w.hitFor = 150;
    await click(session, "e1", { deps });
    expect(fnCalls()).toContain("hitTest");
    expect(mouse()).toHaveLength(3);
  });

  it("clicks an <input type=submit>: the hit on its user-agent shadow root is the input itself", async () => {
    // What Chrome answers on the-internet.herokuapp.com/upload: the hit test lands on the input's shadow root, no element.
    w.add(101, { tag: "INPUT", type: "submit", label: "Upload" });
    w.add(151, { tag: "#document-fragment", nodeType: 11, host: 101 });
    w.hitFor = 151;
    const r = await click(session, "e1", { deps });
    expect(r).toMatchObject({ ok: true, action: "click", ref: "e1" });
    expect(mouse()).toHaveLength(3);
    // Guarded once, on the input: its shadow root is no control of its own.
    expect(fnCalls().filter((f) => f === "collect")).toHaveLength(1);
  });

  it("refuses a click that lands on the text of a web component's own shadow tree: it cannot be read as the host", async () => {
    // <x-del role=button> with only "Delete" in its open shadow root: the host's own label reads "" in Chrome.
    w.add(101, { tag: "X-DEL", role: "button", label: "" });
    w.add(151, { tag: "#document-fragment", nodeType: 11, host: 101 });
    w.add(152, { tag: "#text", nodeType: 3, parent: 151 });
    w.hitFor = 152;
    const err = await click(session, "e1", { deps }).catch((e) => e);
    expect(err).toBeInstanceOf(RiskRefusedError);
    expect(err.message).toMatch(/it is not an element/);
    expect(mouse()).toEqual([]);
  });

  it("still refuses an <input type=button> that deletes, and does not click", async () => {
    w.add(101, { tag: "INPUT", type: "button", label: "Supprimer" });
    w.add(151, { tag: "#document-fragment", nodeType: 11, host: 101 });
    w.hitFor = 151;
    const err = await click(session, "e1", { deps }).catch((e) => e);
    expect(err).toBeInstanceOf(RiskRefusedError);
    expect(err.message).toMatch(/refused to click on "Supprimer"/);
    expect(mouse()).toEqual([]);
  });

  it("refuses to click through something covering the target, and names it", async () => {
    w.add(101, { tag: "BUTTON" });
    w.add(200, { tag: "DIV", id: "consent", role: "dialog", text: "We use cookies   to improve your experience" });
    w.hitFor = 200;
    const err = await click(session, "e1", { deps }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.message).toMatch(/e1 is covered by <div#consent role="dialog"> "We use cookies to improve your experience"/);
    expect(mouse()).toEqual([]);
  });

  /** A consent wall (300) with these buttons (301…), as the accessibility tree has it. */
  const wall = (labels: string[]) => {
    w.add(300, { tag: "DIV", id: "consent", role: "dialog", text: "We use cookies to improve your experience and for ads, with our 812 partners" });
    w.add(310, { tag: "BUTTON", parent: 300 });
    w.ax = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3"], backendDOMNodeId: 1 },
      { nodeId: "2", role: { value: "button" }, name: { value: "Buy" }, backendDOMNodeId: 101, parentId: "1" },
      { nodeId: "3", role: { value: "dialog" }, name: { value: "Cookies" }, backendDOMNodeId: 300, parentId: "1", childIds: labels.map((_, i) => `b${i}`) },
      ...labels.map((l, i) => ({ nodeId: `b${i}`, role: { value: "button" }, name: { value: l }, backendDOMNodeId: 301 + i, parentId: "3" })),
    ];
    w.overlayRoot = 300;
    w.hitFor = 310;
  };

  it("lists the controls of the overlay a click lands on, with refs it can use at once, and leaves the choice to the user", async () => {
    w.add(101, { tag: "BUTTON" });
    wall(["Accept all", "Refuse"]);
    const err = await click(session, "e1", { deps }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.message).toBe(
      [
        'e1 is covered by an overlay (<div#consent role="dialog"> "We use cookies to improve your experience and for ads, wi...") at (50, 20); its controls:',
        '- button "Accept all" [ref=e10]',
        '- button "Refuse" [ref=e11]',
        "accepting tracking/consent or closing it is the user's choice — ask before choosing",
      ].join("\n"),
    );
    // The refs are the tab's own, saved: the next command can click them.
    expect(readRefs("T1")?.refs).toMatchObject({ e1: 101, e10: 301, e11: 302 });
    expect(readRefs("T1")?.next).toBe(12);
    expect(mouse()).toEqual([]);
  });

  it("caps the controls it lists, and says how many more there are", async () => {
    w.add(101, { tag: "BUTTON" });
    wall(Array.from({ length: 20 }, (_, i) => `Partner ${i + 1}`));
    const err = await click(session, "e1", { deps }).catch((e) => e);
    const lines = String(err.message).split("\n");
    expect(lines.filter((l) => l.startsWith("- button"))).toHaveLength(12);
    expect(lines).toContain("… 8 more — take a snapshot to see them");
  });

  it("does not call a sticky header or a chat bubble an overlay, nor speak of consent: it says what is in the way, with its controls", async () => {
    w.add(101, { tag: "BUTTON" });
    wall(["Cart"]);
    w.add(300, { tag: "HEADER", text: "Shop" });
    w.rootIsOverlay = false;
    const err = await click(session, "e1", { deps }).catch((e) => e);
    expect(err.message).toBe(
      ['e1 is covered by <header> "Shop" at (50, 20): close or move it out of the way, then retry; its controls:', '- button "Cart" [ref=e10]'].join("\n"),
    );
    expect(err.message).not.toMatch(/overlay|consent/);
  });

  it("names the overlay without controls when the accessibility tree has none of it", async () => {
    w.add(101, { tag: "BUTTON" });
    wall([]);
    w.ax = [];
    const err = await click(session, "e1", { deps }).catch((e) => e);
    expect(err.message).toMatch(
      /^e1 is covered by an overlay \(<div#consent role="dialog">.*\) at \(50, 20\); none of its controls is in the accessibility tree — take a snapshot\naccepting tracking/,
    );
  });

  it("tells a covered link's click to open its url directly", async () => {
    w.add(101, { tag: "A", href: "https://shop.test/cart" });
    wall(["Cart"]);
    const err = await click(session, "e1", { deps }).catch((e) => e);
    expect(err.message).toMatch(/accepting tracking\/consent or closing it is the user's choice — ask before choosing/);
    expect(err.message).toMatch(/\nor open its URL directly: `webindex-tests browser open https:\/\/shop\.test\/cart` \(navigating doesn't accept anything\)$/);
  });

  it("gives no url hint when the covered target is no link", async () => {
    w.add(101, { tag: "BUTTON" });
    wall(["Cart"]);
    const err = await click(session, "e1", { deps }).catch((e) => e);
    expect(err.message).not.toMatch(/open its URL/);
  });

  it("calls an element without a box not visible", async () => {
    w.add(101, { tag: "BUTTON", quads: [] });
    await expect(click(session, "e1", { deps })).rejects.toThrow(/element is not visible/);
    w.add(101, { tag: "BUTTON", quads: [[5, 5, 5, 5, 5, 5, 5, 5]] });
    await expect(click(session, "e1", { deps })).rejects.toThrow(/element is not visible/);
    expect(mouse()).toEqual([]);
  });

  it("aims at the first quad that has an area", async () => {
    w.add(101, {
      tag: "A",
      quads: [
        [0, 0, 0, 0, 0, 10, 0, 10],
        [200, 100, 240, 100, 240, 120, 200, 120],
      ],
    });
    w.hitFor = 101;
    await click(session, "e1", { deps });
    expect(mouse()[0]).toMatchObject({ x: 220, y: 110 });
  });

  it("refuses an irreversible click unless confirmed, before touching the page", async () => {
    w.add(101, { tag: "BUTTON", label: "Pay 49,00 €" });
    w.hitFor = 101;
    await expect(click(session, "e1", { deps })).rejects.toBeInstanceOf(RiskRefusedError);
    expect(domInput()).toEqual(["DOM.resolveNode", "DOM.resolveNode"]);
    await click(session, "e1", { deps, confirm: true });
    expect(mouse()).toHaveLength(3);
  });

  it("refuses a container's ref, even confirmed: what it would press is whatever control sits at its centre", async () => {
    writeRefs("T1", { loaderId: "L1", url: "https://a.test/", next: 10, refs: { e1: 101, e2: 102 }, containers: ["e1"] });
    w.add(101, { tag: "TABLE" });
    w.add(102, { tag: "BUTTON", text: "Go" });
    const err = await click(session, "e1", { deps, confirm: true }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toBe("e1 is a container — click a control inside it (take a snapshot of e1)");
    expect(mouse()).toEqual([]);
    w.hitFor = 102;
    await click(session, "e2", { deps });
    expect(mouse()).toHaveLength(3);
  });

  it("reports a stale ref as stale, not as a guard refusal", async () => {
    w.add(101, { tag: "BUTTON", label: "Delete account" });
    w.loader = "L2";
    await expect(click(session, "e1", { deps })).rejects.toBeInstanceOf(StaleRefError);
  });

  it("presses the right button, and double-clicks as two clicks in a row", async () => {
    w.add(101, { tag: "DIV" });
    w.hitFor = 101;
    await click(session, "e1", { deps, button: "right" });
    expect(mouse().slice(1)).toEqual([
      { type: "mousePressed", x: 50, y: 20, button: "right", buttons: 2, clickCount: 1 },
      { type: "mouseReleased", x: 50, y: 20, button: "right", buttons: 0, clickCount: 1 },
    ]);
    w.page.calls.length = 0;
    await click(session, "e1", { deps, clickCount: 2, button: "middle" });
    expect(mouse().map((m) => `${m.type} ${m.clickCount ?? ""} ${m.buttons}`)).toEqual([
      "mouseMoved  0",
      "mousePressed 1 4",
      "mouseReleased 1 0",
      "mousePressed 2 4",
      "mouseReleased 2 0",
    ]);
  });

  it("reports the navigation the click set off", async () => {
    w.add(101, { tag: "A" });
    w.hitFor = 101;
    w.page.handle("Input.dispatchMouseEvent", (e) => {
      if (e.type !== "mouseReleased") return;
      w.page.emit("Page.frameStartedLoading", { frameId: "F" });
      w.loader = "L2";
      w.url = "https://a.test/next";
      w.page.emit("Page.frameNavigated", { frame: { id: "F", loaderId: "L2", url: w.url } });
      w.page.emit("Page.lifecycleEvent", { frameId: "F", loaderId: "L2", name: "load" });
    });
    const r = await click(session, "e1", { deps });
    expect(r).toMatchObject({ navigated: true, url: "https://a.test/next" });
  });

  it("returns the dialog the click opened instead of waiting on a page it froze", async () => {
    w.add(101, { tag: "BUTTON" });
    w.hitFor = 101;
    w.page.handle("Input.dispatchMouseEvent", (e) => {
      if (e.type !== "mouseReleased") return;
      w.dialogOpen = true;
      w.page.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Leave the page?", url: w.url });
      return new Promise(() => {}); // the renderer blocks until the dialog is answered
    });
    const r = await click(session, "e1", { deps });
    expect(r.dialog).toEqual({ type: "confirm", message: "Leave the page?" });
    expect(r.challenge).toBeNull();
    // The page is frozen: no probe may be sent into it.
    expect(w.page.calls.filter((c) => c.method === "Runtime.evaluate")).toEqual([]);
  });

  it("puts a challenge the page shows afterwards in the result", async () => {
    w.add(101, { tag: "BUTTON" });
    w.hitFor = 101;
    w.page.handle("Runtime.evaluate", ({ expression }) => {
      if (expression.includes("document.cookie"))
        return { result: { value: { url: w.url, title: "Just a moment...", text: "", scriptUrls: [], iframeSrcs: [], cookieNames: [], selectors: [] } } };
      return { result: { value: "complete" } };
    });
    const r = await click(session, "e1", { deps });
    expect(r.challenge).toMatchObject({ kind: "cloudflare", blocking: true });
  });

  it("lets go of its listeners when the mouse event fails", async () => {
    w.add(101, { tag: "BUTTON" });
    w.hitFor = 101;
    w.page.handle("Input.dispatchMouseEvent", () => {
      throw new Error("CDP connection closed (Input.dispatchMouseEvent)");
    });
    await expect(click(session, "e1", { deps })).rejects.toThrow(/connection closed/);
  });
});

describe("hover", () => {
  it("moves the mouse over the element and does nothing else", async () => {
    w.add(101, { tag: "LI", quads: [[0, 0, 20, 0, 20, 20, 0, 20]] });
    const r = await hover(session, "e1", { deps });
    expect(domInput()).toEqual(["DOM.resolveNode", "DOM.scrollIntoViewIfNeeded", "DOM.getContentQuads", "Input.dispatchMouseEvent"]);
    expect(mouse()).toEqual([{ type: "mouseMoved", x: 10, y: 10, button: "none", buttons: 0 }]);
    expect(r).toMatchObject({ action: "hover", ref: "e1" });
  });
});

// --- typing ----------------------------------------------------------------------

describe("typeText", () => {
  it("focuses, then sends each character as a key", async () => {
    w.add(102, { tag: "INPUT", value: "" });
    const r = await typeText(session, "e2", "hé!", { deps });
    expect(domInput().slice(0, 2)).toEqual(["DOM.resolveNode", "DOM.focus"]);
    expect(keys().map((k) => `${k.type} ${k.key}`)).toEqual(["keyDown h", "keyUp h", "keyDown é", "keyUp é", "keyDown !", "keyUp !"]);
    expect(w.el(102).value).toBe("hé!");
    expect(r).toMatchObject({ action: "type", ref: "e2" });
    // No Enter, no guard.
    expect(w.page.calls.some((c) => c.method === "Runtime.evaluate" && c.params.expression.includes(COLLECT_SOURCE))).toBe(false);
  });

  it("turns a newline into Enter, which the guard sees first", async () => {
    w.add(102, { tag: "TEXTAREA", value: "" });
    await typeText(session, "e2", "a\r\nb", { deps });
    expect(keys().map((k) => `${k.type} ${k.key}`)).toEqual(["keyDown a", "keyUp a", "keyDown Enter", "keyUp Enter", "keyDown b", "keyUp b"]);
    expect(w.page.calls.some((c) => c.method === "Runtime.evaluate" && c.params.expression.includes(COLLECT_SOURCE))).toBe(true);
  });

  it("refuses to type an Enter into a login form, before typing anything", async () => {
    w.add(102, { tag: "INPUT", type: "password", value: "" });
    w.active = { ...w.active, formHasPassword: true, submitLabel: "Log in" };
    await expect(typeText(session, "e2", "hunter2\n", { deps })).rejects.toBeInstanceOf(RiskRefusedError);
    await expect(typeText(session, "e2", "hunter2", { deps, submit: true })).rejects.toBeInstanceOf(RiskRefusedError);
    expect(keys()).toEqual([]);
  });

  it("submits with Enter after the text, when asked and confirmed", async () => {
    w.add(102, { tag: "INPUT", type: "password", value: "" });
    w.active = { ...w.active, formHasPassword: true };
    const r = await typeText(session, "e2", "pw", { deps, submit: true, confirm: true });
    expect(keys().map((k) => `${k.type} ${k.key}`)).toEqual(["keyDown p", "keyUp p", "keyDown w", "keyUp w", "keyDown Enter", "keyUp Enter"]);
    // A password field's value is never echoed.
    expect(r.value).toBeUndefined();
    expect(r.valueHidden).toBe(true);
  });

  it("echoes what the field holds afterwards", async () => {
    w.add(102, { tag: "INPUT", value: "Jane " });
    const r = await typeText(session, "e2", "Doe", { deps });
    expect(r.value).toBe("Jane Doe");
    expect(r.valueHidden).toBeUndefined();
  });

  it("echoes nothing when the field can no longer be read (the Enter left the page)", async () => {
    w.add(102, { tag: "INPUT", value: "" });
    const base = w.page.handlerOf("Runtime.callFunctionOn");
    w.page.handle("Runtime.callFunctionOn", (p: any) => {
      if (/^function readValue/.test(p.functionDeclaration)) throw new CdpError("Runtime.callFunctionOn", -32000, "Cannot find context with specified id");
      return base?.(p);
    });
    const r = await typeText(session, "e2", "x", { deps });
    expect(r.value).toBeUndefined();
    expect(r.valueHidden).toBeUndefined();
  });
});

describe("fill", () => {
  it("selects what is there and inserts the text in one go", async () => {
    w.add(102, { tag: "INPUT", value: "old" });
    const r = await fill(session, "e2", "new value", { deps });
    expect(fnCalls()).toEqual(["fieldKind", "selectAll", "readValue"]);
    expect(w.page.calls.find((c) => c.method === "Input.insertText")?.params).toEqual({ text: "new value" });
    expect(w.el(102).value).toBe("new value");
    expect(r).toMatchObject({ action: "fill", ref: "e2", value: "new value" });
  });

  it("echoes the value the field ended with, as the page reformatted it, but never a password's", async () => {
    w.add(102, { tag: "INPUT", value: "" });
    w.page.handle("Input.insertText", () => {
      w.el(102).value = "06 12 34 56 78";
    });
    expect((await fill(session, "e2", "0612345678", { deps })).value).toBe("06 12 34 56 78");
    w.add(103, { tag: "INPUT", type: "password", value: "" });
    w.page.handle("Input.insertText", ({ text }) => {
      w.el(103).value = text;
    });
    const secret = await fill(session, "e3", "hunter2", { deps });
    expect(w.el(103).value).toBe("hunter2");
    expect(secret.value).toBeUndefined();
    expect(secret.valueHidden).toBe(true);
    expect(JSON.stringify(secret)).not.toContain("hunter2");
  });

  it("falls back to the native value setter when the inserted text does not stick", async () => {
    w.add(102, { tag: "INPUT", value: "", stubborn: true });
    await fill(session, "e2", "Paris", { deps });
    expect(fnCalls()).toEqual(["fieldKind", "selectAll", "readValue", "setValue", "readValue"]);
    expect(w.events).toContain("set-value 102");
    expect(w.el(102).value).toBe("Paris");
  });

  it("takes a value the page only reformatted (a mask) as filled", async () => {
    w.add(102, { tag: "INPUT", value: "" });
    w.page.handle("Input.insertText", () => {
      w.el(102).value = "06 12 34 56 78";
    });
    await fill(session, "e2", "0612345678", { deps });
    expect(fnCalls()).not.toContain("setValue");
  });

  it("fails when the field still holds something else after the fallback", async () => {
    w.add(102, { tag: "INPUT", value: "x", frozen: true });
    const err = await fill(session, "e2", "y", { deps }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.message).toMatch(/could not fill e2: it holds "x"/);
  });

  it("clears a field with Delete when the text is empty", async () => {
    w.add(102, { tag: "INPUT", value: "old" });
    w.page.handle("Input.dispatchKeyEvent", (e) => {
      if (e.key === "Delete" && e.type === "rawKeyDown") w.el(102).value = "";
    });
    await fill(session, "e2", "", { deps });
    expect(keys().map((k) => k.key)).toEqual(["Delete", "Delete"]);
    expect(w.page.calls.some((c) => c.method === "Input.insertText")).toBe(false);
  });

  it("fills a contenteditable", async () => {
    w.add(102, { tag: "DIV", editable: true, value: "" });
    await fill(session, "e2", "Hello", { deps });
    expect(w.el(102).value).toBe("Hello");
  });

  it("refuses what is not a text field, pointing at the right action", async () => {
    w.add(103, { tag: "SELECT", options: [] });
    await expect(fill(session, "e3", "x", { deps })).rejects.toThrow(/e3 is a <select>.*use select/);
    w.add(104, { tag: "INPUT", type: "checkbox" });
    await expect(fill(session, "e4", "x", { deps })).rejects.toThrow(/e4 is an? <input type="checkbox">.*click/);
    w.add(105, { tag: "INPUT", type: "file" });
    await expect(fill(session, "e5", "x", { deps })).rejects.toThrow(/use upload/);
    w.add(106, { tag: "BUTTON", text: "Go" });
    await expect(fill(session, "e6", "x", { deps })).rejects.toThrow(/not a text field/);
    expect(w.page.calls.some((c) => c.method === "DOM.focus")).toBe(false);
  });
});

// --- select ----------------------------------------------------------------------

describe("select", () => {
  const COUNTRIES = [
    { value: "", label: "Choose…" },
    { value: "fr", label: "France" },
    { value: "de", label: "Germany" },
    { value: "it", label: "Italy" },
  ];

  it("picks an option by value and fires input and change", async () => {
    w.add(103, { tag: "SELECT", options: COUNTRIES });
    const r = await select(session, "e3", ["de"], { deps });
    expect(r.value).toEqual(["de"]);
    expect(w.events).toEqual(["input", "change"]);
    expect(w.node(103).selectedIndex).toBe(2);
  });

  it("picks an option by its visible label, ignoring case and spacing", async () => {
    w.add(103, { tag: "SELECT", options: COUNTRIES });
    expect((await select(session, "e3", ["  italy "], { deps })).value).toEqual(["it"]);
  });

  it("selects several options in a multiple select, and only those", async () => {
    w.add(103, { tag: "SELECT", multiple: true, options: COUNTRIES });
    const r = await select(session, "e3", ["fr", "Italy"], { deps });
    expect(r.value).toEqual(["fr", "it"]);
    expect(w.node(103).options.map((o: { selected: boolean }) => o.selected)).toEqual([false, true, false, true]);
  });

  it("lists the options when a value matches none, and changes nothing", async () => {
    w.add(103, { tag: "SELECT", options: COUNTRIES });
    const err = await select(session, "e3", ["Spain"], { deps }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.message).toMatch(/no option "Spain" in e3; options: "" \(Choose…\), "fr" \(France\), "de" \(Germany\), "it" \(Italy\)/);
    expect(w.events).toEqual([]);
  });

  it("shows only the first 20 options of a long list", async () => {
    w.add(103, { tag: "SELECT", options: Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: `L${i}` })) });
    const err = await select(session, "e3", ["zz"], { deps }).catch((e) => e);
    expect(err.message).toContain('"v19" (L19)');
    expect(err.message).not.toContain('"v20"');
    expect(err.message).toMatch(/… and 10 more/);
  });

  it("refuses several values for a single select", async () => {
    w.add(103, { tag: "SELECT", options: COUNTRIES });
    await expect(select(session, "e3", ["fr", "de"], { deps })).rejects.toThrow(/takes one value/);
  });

  it("refuses what is not a <select>, suggesting clicks on the options", async () => {
    w.add(106, { tag: "DIV", role: "combobox", text: "Country" });
    await expect(select(session, "e6", ["fr"], { deps })).rejects.toThrow(
      /e6 is a <div role="combobox"> "Country", not a <select>: click it, then click the option/,
    );
  });

  it("wants at least one value", async () => {
    await expect(select(session, "e3", [], { deps })).rejects.toBeInstanceOf(UsageError);
  });
});

// --- keys ------------------------------------------------------------------------

describe("press", () => {
  it("sends the key to the focused element", async () => {
    const r = await press(session, "Escape", { deps });
    expect(keys().map((k) => `${k.type} ${k.key}`)).toEqual(["rawKeyDown Escape", "keyUp Escape"]);
    expect(r).toMatchObject({ ok: true, action: "press", navigated: false });
    expect(r.ref).toBeUndefined();
  });

  it("refuses Enter in a form with a password field unless confirmed", async () => {
    w.active = { ...w.active, formHasPassword: true, submitLabel: "Sign in" };
    const err = await press(session, "Enter", { deps }).catch((e) => e);
    expect(err).toBeInstanceOf(RiskRefusedError);
    expect(err.message).toMatch(/password/);
    expect(keys()).toEqual([]);
    await press(session, "Enter", { deps, confirm: true });
    expect(keys()).toHaveLength(2);
  });

  it("guards a modified or aliased Enter too", async () => {
    w.active = { ...w.active, formHasPassword: true };
    await expect(press(session, "Control+Enter", { deps })).rejects.toBeInstanceOf(RiskRefusedError);
    await expect(press(session, "return", { deps })).rejects.toBeInstanceOf(RiskRefusedError);
    await expect(press(session, "\n", { deps })).rejects.toBeInstanceOf(RiskRefusedError);
  });

  it("rejects an unknown key before sending anything", async () => {
    await expect(press(session, "Hyperspace", { deps })).rejects.toBeInstanceOf(UsageError);
    expect(w.page.calls).toEqual([]);
  });
});

// --- files -----------------------------------------------------------------------

describe("upload", () => {
  it("sets the files on the input by backend node id", async () => {
    w.add(105, { tag: "INPUT", type: "file", multiple: true });
    files.set("/tmp/a.jpg", "file");
    files.set("/tmp/b.jpg", "file");
    const r = await upload(session, "e5", ["/tmp/a.jpg", "/tmp/b.jpg"], { deps });
    expect(w.page.calls.find((c) => c.method === "DOM.setFileInputFiles")?.params).toEqual({ files: ["/tmp/a.jpg", "/tmp/b.jpg"], backendNodeId: 105 });
    expect(r).toMatchObject({ action: "upload", ref: "e5", value: { files: 2 } });
  });

  it("refuses an element that is not a file input", async () => {
    w.add(106, { tag: "BUTTON", text: "Add photos" });
    files.set("/tmp/a.jpg", "file");
    await expect(upload(session, "e6", ["/tmp/a.jpg"], { deps })).rejects.toThrow(/e6 is a <button> "Add photos", not an <input type="file">/);
    expect(w.page.calls.some((c) => c.method === "DOM.setFileInputFiles")).toBe(false);
  });

  it("wants absolute paths to files that exist", async () => {
    w.add(105, { tag: "INPUT", type: "file" });
    files.set("/tmp/dir", "dir");
    await expect(upload(session, "e5", ["a.jpg"], { deps })).rejects.toThrow(/absolute/);
    await expect(upload(session, "e5", ["/tmp/missing.jpg"], { deps })).rejects.toThrow(/no such file: \/tmp\/missing.jpg/);
    await expect(upload(session, "e5", ["/tmp/dir"], { deps })).rejects.toThrow(/not a file: \/tmp\/dir/);
    await expect(upload(session, "e5", [], { deps })).rejects.toBeInstanceOf(UsageError);
    expect(w.page.calls.some((c) => c.method === "DOM.setFileInputFiles")).toBe(false);
  });

  it("refuses several files for an input that takes one", async () => {
    w.add(105, { tag: "INPUT", type: "file" });
    files.set("/tmp/a.jpg", "file");
    files.set("/tmp/b.jpg", "file");
    await expect(upload(session, "e5", ["/tmp/a.jpg", "/tmp/b.jpg"], { deps })).rejects.toThrow(/takes one file/);
  });
});

// --- scroll ----------------------------------------------------------------------

describe("scroll", () => {
  it("scrolls the window by most of a screen, and reports where it ended", async () => {
    w.scrollPos = { x: 0, y: 640 };
    const r = await scroll(session, "down", { deps });
    const expr = w.page.calls.find((c) => c.method === "Runtime.evaluate")?.params.expression;
    expect(expr).toMatch(/scrollBy\(\{ top: Math\.round\(innerHeight \* 0\.8\)/);
    expect(r).toMatchObject({ action: "scroll", value: { x: 0, y: 640 } });
    await scroll(session, "up", { deps });
    await scroll(session, "top", { deps });
    await scroll(session, "bottom", { deps });
    const exprs = w.page.calls.filter((c) => c.method === "Runtime.evaluate" && c.params.expression.includes("scroll")).map((c) => c.params.expression);
    expect(exprs[1]).toMatch(/-Math\.round/);
    expect(exprs[2]).toMatch(/scrollTo\(\{ top: 0/);
    expect(exprs[3]).toMatch(/scrollHeight/);
  });

  it("scrolls a ref into view", async () => {
    w.add(101, { tag: "SECTION" });
    const r = await scroll(session, "e1", { deps });
    expect(w.page.calls.find((c) => c.method === "DOM.scrollIntoViewIfNeeded")?.params).toEqual({ backendNodeId: 101 });
    expect(r).toMatchObject({ ref: "e1", value: { x: 0, y: 0 } });
  });

  it("rejects anything else", async () => {
    await expect(scroll(session, "sideways", { deps })).rejects.toBeInstanceOf(UsageError);
  });
});

// --- screenshot ------------------------------------------------------------------

describe("screenshot", () => {
  const shot = () => w.page.calls.find((c) => c.method === "Page.captureScreenshot")?.params;

  it("captures the viewport as PNG by default", async () => {
    const buf = await screenshot(session);
    expect(buf.toString()).toBe("PNGDATA");
    expect(shot()).toEqual({ format: "png" });
  });

  it("takes a JPEG quality, and only for JPEG", async () => {
    await screenshot(session, { format: "jpeg", quality: 60 });
    expect(shot()).toEqual({ format: "jpeg", quality: 60 });
    w.page.calls.length = 0;
    await screenshot(session, { format: "png", quality: 60 });
    expect(shot()).toEqual({ format: "png" });
  });

  it("clips to the element's box, in page coordinates", async () => {
    w.add(101, {
      tag: "IMG",
      quads: [
        [10, 20, 110, 20, 110, 70, 10, 70],
        [10, 70, 60, 70, 60, 90, 10, 90],
      ],
    });
    await screenshot(session, { ref: "e1" });
    expect(w.page.methods().slice(0, 3)).toEqual(["DOM.resolveNode", "DOM.scrollIntoViewIfNeeded", "DOM.getContentQuads"]);
    expect(shot()).toEqual({ format: "png", clip: { x: 10, y: 520, width: 100, height: 70, scale: 1 } });
  });

  it("renders beyond the viewport an element taller than it (an infobox), so its lower part is not blank", async () => {
    // The viewport is 1280 by 800: the element runs 1100 px past its top.
    w.add(101, { tag: "TABLE", quads: [[900, 0, 1210, 0, 1210, 1100, 900, 1100]] });
    await screenshot(session, { ref: "e1" });
    expect(shot()).toEqual({ format: "png", captureBeyondViewport: true, clip: { x: 900, y: 500, width: 310, height: 1100, scale: 1 } });
  });

  it("captures the whole page beyond the viewport", async () => {
    await screenshot(session, { full: true });
    expect(shot()).toEqual({ format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1280, height: 4000, scale: 1 } });
  });

  it("refuses an element with no box, a stale ref, and a ref with --full", async () => {
    w.add(101, { tag: "DIV", quads: [] });
    await expect(screenshot(session, { ref: "e1" })).rejects.toThrow(/element is not visible/);
    await expect(screenshot(session, { ref: "e77" })).rejects.toBeInstanceOf(StaleRefError);
    await expect(screenshot(session, { ref: "e1", full: true })).rejects.toBeInstanceOf(UsageError);
  });

  /** document.querySelector in the page: these selectors match these elements. */
  /** DOM.querySelector on the document: these selectors match these elements (nodeId = backendNodeId + 1000). */
  const selectors = (found: Record<string, number>) => {
    w.page.handle("DOM.getDocument", () => ({ root: { nodeId: 1 } }));
    w.page.handle("DOM.querySelector", ({ selector }) => {
      if (selector.endsWith("[")) throw new CdpError("DOM.querySelector", -32000, "DOM Error while querying");
      const id = found[selector];
      return { nodeId: id === undefined ? 0 : id + 1000 };
    });
    w.page.handle("DOM.describeNode", ({ objectId, nodeId }) => ({
      node: { backendNodeId: nodeId !== undefined ? nodeId - 1000 : Number(String(objectId).slice(1)) },
    }));
  };

  it("clips to the element a CSS selector matches, and lets the handle it took go", async () => {
    w.add(150, { tag: "TABLE", quads: [[10, 20, 310, 20, 310, 420, 10, 420]] });
    selectors({ "table.infobox": 150 });
    await screenshot(session, { selector: "table.infobox" });
    expect(shot()).toEqual({ format: "png", clip: { x: 10, y: 520, width: 300, height: 400, scale: 1 } });
    // The DOM domain, not the page's own document.querySelector, which a page can replace.
    expect(w.page.methods()).toEqual(expect.arrayContaining(["DOM.getDocument", "DOM.querySelector"]));
    expect(w.page.methods()).not.toContain("Runtime.evaluate");
  });

  it("fails on a selector that matches nothing (exit 1), and refuses a bad one, or one with a ref or --full (usage)", async () => {
    selectors({});
    const none = await screenshot(session, { selector: "table.nope" }).catch((e) => e);
    expect(none).toBeInstanceOf(Error);
    expect(none).not.toBeInstanceOf(UsageError);
    expect(none.message).toBe("no element matches table.nope");
    await expect(screenshot(session, { selector: "div[" })).rejects.toBeInstanceOf(UsageError);
    await expect(screenshot(session, { selector: "table", ref: "e1" })).rejects.toBeInstanceOf(UsageError);
    await expect(screenshot(session, { selector: "table", full: true })).rejects.toBeInstanceOf(UsageError);
    expect(w.page.methods()).not.toContain("Page.captureScreenshot");
  });

  it("refuses a CSS selector given as a ref, pointing at --selector", async () => {
    await expect(screenshot(session, { ref: "table.infobox" })).rejects.toThrow(/expected a ref like e12.*use --selector/);
  });
});

// --- evaluate --------------------------------------------------------------------

describe("evaluate", () => {
  const answer = (r: unknown) =>
    w.page.handle("Runtime.evaluate", ({ expression }) =>
      expression === "EXPR" ? r : expression === "document.readyState" ? { result: { value: "complete" } } : {},
    );

  it("returns the value, by value, awaiting a promise", async () => {
    answer({ result: { type: "object", value: { a: [1, 2] } } });
    const r = await evaluate(session, "EXPR", { deps });
    expect(w.page.calls.find((c) => c.params?.expression === "EXPR")?.params).toEqual({ expression: "EXPR", returnByValue: true, awaitPromise: true });
    expect(r).toMatchObject({ ok: true, action: "evaluate", value: { a: [1, 2] } });
  });

  it("keeps undefined out of the result", async () => {
    answer({ result: { type: "undefined" } });
    expect("value" in (await evaluate(session, "EXPR", { deps }))).toBe(false);
  });

  it("describes what cannot travel by value", async () => {
    answer({ result: { type: "function", description: "() => 1" } });
    expect((await evaluate(session, "EXPR", { deps })).value).toBe("() => 1");
    answer({ result: { type: "object", subtype: "node", value: {}, description: "button#go.primary" } });
    expect((await evaluate(session, "EXPR", { deps })).value).toBe("button#go.primary");
    answer({ result: { type: "number", unserializableValue: "NaN", description: "NaN" } });
    expect((await evaluate(session, "EXPR", { deps })).value).toBe("NaN");
  });

  it("explains a result the browser refused to serialise", async () => {
    w.page.handle("Runtime.evaluate", ({ expression }) => {
      if (expression === "EXPR") throw new CdpError("Runtime.evaluate", -32000, "Object reference chain is too long");
      return {};
    });
    await expect(evaluate(session, "EXPR", { deps })).rejects.toThrow(/cannot be returned as JSON.*Object reference chain is too long/);
  });

  it("turns a page exception into an error carrying its text", async () => {
    answer({
      result: { type: "object" },
      exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: nope is not defined\n    at <anonymous>:1:1" } },
    });
    const err = await evaluate(session, "EXPR", { deps }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.message).toBe("evaluation failed: ReferenceError: nope is not defined");
    answer({ exceptionDetails: { text: "Uncaught SyntaxError" } });
    await expect(evaluate(session, "EXPR", { deps })).rejects.toThrow("evaluation failed: Uncaught SyntaxError");
  });

  it("captures an alert the script opened", async () => {
    w.page.handle("Runtime.evaluate", ({ expression }) => {
      if (expression !== "EXPR") return {};
      w.page.emit("Page.javascriptDialogOpening", { type: "alert", message: "hi" });
      return new Promise(() => {});
    });
    const r = await evaluate(session, "EXPR", { deps });
    expect(r.dialog).toEqual({ type: "alert", message: "hi" });
    expect("value" in r).toBe(false);
  });
});

// --- dialogs and history ---------------------------------------------------------

describe("handleDialog", () => {
  it("accepts or dismisses the open dialog", async () => {
    w.dialogOpen = true;
    const r = await handleDialog(session, true, "Bob", { deps });
    expect(w.page.calls.find((c) => c.method === "Page.handleJavaScriptDialog")?.params).toEqual({ accept: true, promptText: "Bob" });
    expect(r).toMatchObject({ ok: true, action: "dialog" });
    w.dialogOpen = true;
    await handleDialog(session, false, undefined, { deps });
    expect(w.page.calls.filter((c) => c.method === "Page.handleJavaScriptDialog")[1]?.params).toEqual({ accept: false });
  });

  it("answers before it asks the page anything: behind a dialog the page answers nothing", async () => {
    w.dialogOpen = true;
    const from = w.page.calls.length;
    await handleDialog(session, false, undefined, { deps });
    expect(w.page.calls[from]?.method).toBe("Page.handleJavaScriptDialog");
  });

  it("says so clearly when no dialog is open", async () => {
    const err = await handleDialog(session, true, undefined, { deps }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.message).toBe("no dialog is open");
  });

  it("lets other failures through", async () => {
    w.page.handle("Page.handleJavaScriptDialog", () => {
      throw new Error("CDP connection closed (Page.handleJavaScriptDialog)");
    });
    await expect(handleDialog(session, true, undefined, { deps })).rejects.toThrow(/connection closed/);
  });
});

describe("back, forward, reload", () => {
  it("pass on the note of a move whose page committed but is still loading", async () => {
    const note = "still loading after 50 ms — take a snapshot or `webindex-tests browser wait --load`";
    session.reload = async () => {
      w.loader = "L3";
      return { url: "https://a.test/", loaderId: "L3", note };
    };
    expect(await reload(session, { deps })).toMatchObject({ action: "reload", navigated: true, note });
    expect(await back(session, { deps })).not.toHaveProperty("note");
  });

  it("wrap the session's history moves in an action result", async () => {
    expect(await back(session, { deps })).toEqual({
      ok: true,
      action: "back",
      navigated: true,
      url: "https://a.test/prev",
      title: "A page",
      challenge: null,
    });
    expect(await forward(session, { deps })).toMatchObject({ action: "forward", navigated: true, url: "https://a.test/next" });
    expect(await reload(session, { deps })).toMatchObject({ action: "reload", navigated: true });
  });

  it("report a same-document move as no navigation", async () => {
    session.back = async () => ({ url: "https://a.test/#top", loaderId: w.loader });
    expect((await back(session, { deps })).navigated).toBe(false);
  });
});

// --- page functions --------------------------------------------------------------

describe("page functions", () => {
  it("are named, so the browser and the tests can tell them apart", () => {
    for (const [name, src] of Object.entries(PAGE_FUNCTIONS)) expect(src.startsWith(`function ${name}(`), name).toBe(true);
  });

  it("hitTest walks out of shadow roots to the host", () => {
    const host: any = { nodeType: 1, tagName: "MY-BUTTON", parentNode: null };
    const root: any = { nodeType: 11, parentNode: null, host };
    const inner: any = { nodeType: 1, tagName: "SPAN", parentNode: root };
    expect(run(PAGE_FUNCTIONS.hitTest, host, [inner])).toBeNull();
  });

  it("hitTest calls the target's own text and user-agent shadow tree the target, and an element inside it a descendant", () => {
    const input: any = { nodeType: 1, tagName: "INPUT", parentNode: null };
    const uaRoot: any = { nodeType: 11, parentNode: null, host: input };
    expect(run(PAGE_FUNCTIONS.hitTest, input, [uaRoot])).toBe(true);
    expect(run(PAGE_FUNCTIONS.hitTest, input, [{ nodeType: 3, parentNode: uaRoot, parentElement: null }])).toBe(true);
    // A text field's editor: an element, but of the field's user-agent tree.
    const editor: any = { nodeType: 1, tagName: "DIV", parentNode: uaRoot, getRootNode: () => uaRoot };
    expect(run(PAGE_FUNCTIONS.hitTest, input, [editor])).toBe(true);
    const button: any = { nodeType: 1, tagName: "BUTTON", parentNode: null };
    expect(run(PAGE_FUNCTIONS.hitTest, button, [{ nodeType: 3, parentNode: button, parentElement: button }])).toBe(true);
    // A control inside a web component's own shadow tree (a Delete button in a card) is what acts: the guard looks at it.
    const card: any = { nodeType: 1, tagName: "MY-CARD", parentNode: null };
    const open: any = { nodeType: 11, parentNode: null, host: card };
    card.shadowRoot = open;
    const del: any = { nodeType: 1, tagName: "BUTTON", parentNode: open, getRootNode: () => open };
    expect(run(PAGE_FUNCTIONS.hitTest, card, [del])).toBeNull();
    // Its text too: an author's shadow tree is guarded as what it is, never taken for the host.
    expect(run(PAGE_FUNCTIONS.hitTest, card, [{ nodeType: 3, parentNode: open, parentElement: null }])).toBeNull();
  });

  it("hitTest lets a click into a frame through: the hit test stops at the frame element", () => {
    const target: any = { nodeType: 1, tagName: "BUTTON", parentNode: null, ownerDocument: { frame: true } };
    const frame: any = { nodeType: 1, tagName: "IFRAME", parentNode: null, ownerDocument: {}, getAttribute: () => null };
    expect(run(PAGE_FUNCTIONS.hitTest, target, [frame])).toBeNull();
  });

  it("hitTest describes a text node by its parent, and nothing at all as such", () => {
    const target: any = { nodeType: 1, tagName: "BUTTON", parentNode: null };
    const cover: any = { nodeType: 1, tagName: "P", id: "", parentNode: null, getAttribute: () => null, innerText: "Promo" };
    const text: any = { nodeType: 3, parentNode: cover, parentElement: cover };
    expect(run(PAGE_FUNCTIONS.hitTest, target, [text])).toBe('<p> "Promo"');
    expect(run(PAGE_FUNCTIONS.hitTest, target, [null])).toBe("nothing");
  });
});

// --- edges -----------------------------------------------------------------------

describe("edges", () => {
  it("rejects a bad mouse button or click count before touching the page", async () => {
    await expect(click(session, "e1", { deps, button: "side" as never })).rejects.toBeInstanceOf(UsageError);
    await expect(click(session, "e1", { deps, clickCount: 3 as never })).rejects.toBeInstanceOf(UsageError);
    expect(w.page.calls).toEqual([]);
  });

  it("calls an element the browser cannot lay out not visible, and lets other quad failures through", async () => {
    w.add(101, { tag: "BUTTON" });
    w.page.handle("DOM.getContentQuads", () => {
      throw new CdpError("DOM.getContentQuads", -32000, "Could not compute content quads.");
    });
    await expect(hover(session, "e1", { deps })).rejects.toThrow(/element is not visible/);
    w.page.handle("DOM.getContentQuads", () => {
      throw new Error("CDP connection closed (DOM.getContentQuads)");
    });
    await expect(hover(session, "e1", { deps })).rejects.toThrow(/connection closed/);
  });

  it("turns an exception in a page function into an action error", async () => {
    w.add(102, { tag: "INPUT" });
    w.page.handle("Runtime.callFunctionOn", () => ({ exceptionDetails: { text: "Uncaught", exception: { value: "denied" } } }));
    await expect(fill(session, "e2", "x", { deps })).rejects.toThrow("the page threw: denied");
  });

  it("does not echo what a password field holds", async () => {
    w.add(102, { tag: "INPUT", type: "password", value: "secret", frozen: true });
    const err = await fill(session, "e2", "other", { deps }).catch((e) => e);
    expect(err.message).toMatch(/it holds something else/);
    expect(err.message).not.toContain("secret");
  });

  it("shortens a long value it could not replace", async () => {
    w.add(102, { tag: "TEXTAREA", value: "z".repeat(200), frozen: true });
    const err = await fill(session, "e2", "short", { deps }).catch((e) => e);
    expect(err.message).toContain(`"${"z".repeat(77)}..."`);
  });

  it("reports a stat failure other than a missing file", async () => {
    w.add(105, { tag: "INPUT", type: "file" });
    deps.fs = { stat: async () => Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })) } as never;
    await expect(upload(session, "e5", ["/tmp/a.jpg"], { deps })).rejects.toThrow("cannot read /tmp/a.jpg: EACCES: permission denied");
  });

  it("turns a page exception while scrolling into an action error", async () => {
    w.page.handle("Runtime.evaluate", ({ expression }) =>
      expression.includes("scrollBy") ? { exceptionDetails: { text: "Uncaught TypeError" } } : { result: { value: "complete" } },
    );
    await expect(scroll(session, "down", { deps })).rejects.toThrow("the page threw: Uncaught TypeError");
  });

  it("checks the screenshot format and quality", async () => {
    await expect(screenshot(session, { format: "gif" as never })).rejects.toBeInstanceOf(UsageError);
    await expect(screenshot(session, { format: "jpeg", quality: 101 })).rejects.toBeInstanceOf(UsageError);
    await expect(screenshot(session, { format: "jpeg", quality: 7.5 })).rejects.toBeInstanceOf(UsageError);
  });

  it("falls back to the older layout metrics fields", async () => {
    w.add(101, { tag: "IMG", quads: [[0, 0, 10, 0, 10, 10, 0, 10]] });
    w.page.handle("Page.getLayoutMetrics", () => ({ layoutViewport: { pageX: 5, pageY: 7 }, contentSize: { x: 0, y: 0, width: 800, height: 900 } }));
    await screenshot(session, { ref: "e1" });
    await screenshot(session, { full: true });
    const clips = w.page.calls.filter((c) => c.method === "Page.captureScreenshot").map((c) => c.params.clip);
    expect(clips).toEqual([
      { x: 5, y: 7, width: 10, height: 10, scale: 1 },
      { x: 0, y: 0, width: 800, height: 900, scale: 1 },
    ]);
  });

  it("lets a CDP failure of evaluate that is not about serialising through", async () => {
    w.page.handle("Runtime.evaluate", ({ expression }) => {
      if (expression === "EXPR") throw new CdpError("Runtime.evaluate", -32000, "Execution context was destroyed.");
      return {};
    });
    await expect(evaluate(session, "EXPR", { deps })).rejects.toBeInstanceOf(CdpError);
    w.page.handle("Runtime.evaluate", () => ({}));
    expect("value" in (await evaluate(session, "EXPR", { deps }))).toBe(false);
  });

  it("passes a navigation timeout to the history move", async () => {
    const seen: unknown[] = [];
    session.reload = async (o?: unknown) => {
      seen.push(o);
      return { url: w.url, loaderId: "L9" };
    };
    await reload(session, { deps, timeoutMs: 1234 });
    await reload(session, { deps });
    expect(seen).toEqual([{ timeoutMs: 1234 }, {}]);
  });
});

// --- review fixes: guard gaps, dialogs, reachability ------------------------------

describe("typeText only types into text fields", () => {
  it("refuses a button: Space on it would click it past the guard", async () => {
    w.add(101, { tag: "BUTTON", text: "Pay now" });
    const err = await typeText(session, "e1", " ", { deps }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.message).toMatch(/e1 is a <button> "Pay now", not a text field/);
    expect(w.page.calls.some((c) => c.method === "DOM.focus")).toBe(false);
    expect(keys()).toEqual([]);
  });
});

describe("keys that land on another control after a Tab", () => {
  const PAY = { role: "button", label: "Pay 30 €", isSubmit: false, formHasPassword: false, submitLabel: "" };
  const tabMovesFocusToPay = () =>
    w.page.handle("Input.dispatchKeyEvent", (e) => {
      if (e.key === "Tab" && e.type === "rawKeyDown") w.active = PAY;
    });

  it("guards an Enter typed after a Tab against the control that now has focus", async () => {
    w.add(102, { tag: "INPUT", value: "" });
    tabMovesFocusToPay();
    await expect(typeText(session, "e2", "x\t\n", { deps })).rejects.toBeInstanceOf(RiskRefusedError);
    expect(keys().some((k) => k.key === "Enter")).toBe(false);
  });

  it("guards a Space typed after a Tab, and a submit Enter after one", async () => {
    w.add(102, { tag: "INPUT", value: "" });
    tabMovesFocusToPay();
    await expect(typeText(session, "e2", "x\t ", { deps })).rejects.toBeInstanceOf(RiskRefusedError);
    expect(keys().some((k) => k.key === " ")).toBe(false);
    w.active = { ...PAY, role: "textbox", label: "" };
    await expect(typeText(session, "e2", "x\t", { deps, submit: true })).rejects.toBeInstanceOf(RiskRefusedError);
    expect(keys().some((k) => k.key === "Enter")).toBe(false);
  });

  it("lets them through once confirmed", async () => {
    w.add(102, { tag: "INPUT", value: "" });
    tabMovesFocusToPay();
    await typeText(session, "e2", "x\t\n", { deps, confirm: true });
    expect(keys().some((k) => k.key === "Enter")).toBe(true);
  });

  it("guards press Space on a focused risky button", async () => {
    w.active = PAY;
    await expect(press(session, "Space", { deps })).rejects.toBeInstanceOf(RiskRefusedError);
    await expect(press(session, " ", { deps })).rejects.toBeInstanceOf(RiskRefusedError);
    expect(keys()).toEqual([]);
  });
});

describe("an action outrun by a dialog stops", () => {
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("types nothing more once the dialog is answered", async () => {
    w.add(102, { tag: "INPUT", value: "" });
    let unblock = () => {};
    let first = true;
    w.page.handle("Input.dispatchKeyEvent", () => {
      if (!first) return;
      first = false;
      w.dialogOpen = true;
      w.page.emit("Page.javascriptDialogOpening", { type: "alert", message: "typed a", url: w.url });
      return new Promise<void>((r) => {
        unblock = r;
      });
    });
    const r = await typeText(session, "e2", "abc", { deps, submit: true, confirm: true });
    expect(r.dialog).toEqual({ type: "alert", message: "typed a" });
    await handleDialog(session, true, undefined, { deps });
    unblock();
    await flush();
    expect(keys()).toHaveLength(1);
  });

  it("does not send the second click of a double click", async () => {
    w.add(101, { tag: "BUTTON" });
    w.hitFor = 101;
    let unblock = () => {};
    w.page.handle("Input.dispatchMouseEvent", (e) => {
      if (e.type !== "mouseReleased" || e.clickCount !== 1) return;
      w.page.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Sure?" });
      return new Promise<void>((r) => {
        unblock = r;
      });
    });
    await click(session, "e1", { deps, clickCount: 2 });
    unblock();
    await flush();
    expect(mouse().map((m) => `${m.type} ${m.clickCount ?? ""}`)).toEqual(["mouseMoved ", "mousePressed 1", "mouseReleased 1"]);
  });
});

describe("the result of an action that opened a dialog", () => {
  const openDialogOnRelease = () =>
    w.page.handle("Input.dispatchMouseEvent", (e) => {
      if (e.type !== "mouseReleased") return;
      w.page.emit("Page.javascriptDialogOpening", { type: "alert", message: "hi", url: "https://a.test/from-dialog" });
      return new Promise(() => {});
    });

  it("reads url and title from the browser side, not from the frozen page", async () => {
    w.add(101, { tag: "BUTTON" });
    w.hitFor = 101;
    openDialogOnRelease();
    session.currentUrl = () => Promise.reject(new Error("the renderer is frozen"));
    w.page.handle("Target.getTargetInfo", ({ targetId }) => ({ targetInfo: { targetId, url: "https://a.test/info", title: "Info title" } }));
    const r = await click(session, "e1", { deps });
    expect(w.page.calls.find((c) => c.method === "Target.getTargetInfo")?.params).toEqual({ targetId: "T1" });
    expect(r).toMatchObject({ url: "https://a.test/info", title: "Info title", dialog: { type: "alert", message: "hi" } });
    const afterAct = w.page.methods().slice(w.page.methods().lastIndexOf("Input.dispatchMouseEvent"));
    expect(afterAct).not.toContain("Page.getFrameTree");
  });

  it("falls back to the dialog's url and the session title", async () => {
    w.add(101, { tag: "BUTTON" });
    w.hitFor = 101;
    openDialogOnRelease();
    session.currentUrl = () => Promise.reject(new Error("the renderer is frozen"));
    w.page.handle("Target.getTargetInfo", () => {
      throw new CdpError("Target.getTargetInfo", -32000, "Not allowed");
    });
    const r = await click(session, "e1", { deps });
    expect(r).toMatchObject({ url: "https://a.test/from-dialog", title: "A page" });
  });
});

describe("click guards the control it actually lands on", () => {
  it("refuses a container whose centre is an irreversible button", async () => {
    w.add(101, { tag: "DIV", label: "Mes annonces" });
    w.add(150, { tag: "BUTTON", parent: 101, label: "Supprimer" });
    w.hitFor = 150;
    await expect(click(session, "e1", { deps })).rejects.toBeInstanceOf(RiskRefusedError);
    expect(mouse()).toEqual([]);
    await click(session, "e1", { deps, confirm: true });
    expect(mouse()).toHaveLength(3);
  });

  it("refuses a click that lands on a frame it cannot look into (a payment button), unless confirmed", async () => {
    w.add(101, { tag: "DIV", label: "Your basket" });
    w.add(150, { tag: "IFRAME", parent: 101 });
    w.hitFor = 150;
    const err = await click(session, "e1", { deps }).catch((e) => e);
    expect(err).toBeInstanceOf(RiskRefusedError);
    expect(err.message).toMatch(/cannot inspect the content of this frame \(e\.g\. a payment button\)/);
    expect(mouse()).toEqual([]);
    await click(session, "e1", { deps, confirm: true });
    expect(mouse()).toHaveLength(3);
  });

  it("refuses a click on a frame's own ref", async () => {
    w.add(101, { tag: "IFRAME" });
    w.hitFor = 101;
    await expect(click(session, "e1", { deps })).rejects.toThrow(/cannot inspect the content of this frame/);
    expect(mouse()).toEqual([]);
  });
});

describe("a click point that reaches nothing", () => {
  it("is an action error, whatever the browser answers", async () => {
    w.add(101, { tag: "BUTTON" });
    w.page.handle("DOM.getNodeForLocation", () => {
      throw new CdpError("DOM.getNodeForLocation", -32000, "No node found at given location");
    });
    await expect(click(session, "e1", { deps })).rejects.toThrow(/e1 is not reachable at its centre/);
    w.page.handle("DOM.getNodeForLocation", () => ({}));
    await expect(click(session, "e1", { deps })).rejects.toThrow(/e1 is not reachable at its centre/);
    w.page.handle("DOM.getNodeForLocation", () => ({ backendNodeId: 4242 }));
    await expect(click(session, "e1", { deps })).rejects.toThrow(/e1 is not reachable at its centre/);
    w.add(4242, { tag: "DIV" });
    const resolve = w.page.calls.length;
    w.page.handle("DOM.resolveNode", ({ backendNodeId }) => (backendNodeId === 4242 ? { object: {} } : { object: { objectId: `o${backendNodeId}` } }));
    await expect(click(session, "e1", { deps })).rejects.toThrow(/e1 is not reachable at its centre/);
    expect(w.page.calls.length).toBeGreaterThan(resolve);
    expect(mouse()).toEqual([]);
  });
});
