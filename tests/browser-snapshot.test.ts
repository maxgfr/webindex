import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envName } from "../src/brand.js";
import type { BrowserDeps } from "../src/browser/deps.js";
import { type BrowserSession, openBrowserSession } from "../src/browser/session.js";
import { type AXNode, renderSnapshot, StaleRefError, takeSnapshot } from "../src/browser/snapshot.js";
import { type RefTable, readRefs, writeRefs } from "../src/browser/state.js";
import { FakeCdp } from "./helpers/fake-cdp.js";
import { scriptBrowser } from "./helpers/fake-browser.js";
import { fakeSpawn } from "./helpers/fake-spawn.js";

const fixture = <T = AXNode[]>(name: string): T => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "browser", `${name}.json`), "utf8"));
const fresh = (): RefTable => ({ loaderId: "L1", url: "https://a.test/", next: 1, refs: {} });
const lines = (...l: string[]) => l.join("\n");

// A tiny AX node builder for the cases the fixtures do not cover.
const node = (id: number, role: string, name: string | undefined, over: Partial<AXNode> = {}, kids: AXNode[] = []): AXNode[] => [
  {
    nodeId: String(id),
    ignored: false,
    role: { type: "role", value: role },
    ...(name !== undefined ? { name: { type: "computedString", value: name } } : {}),
    childIds: kids.map((k) => k.nodeId),
    backendDOMNodeId: id * 10,
    ...over,
  },
  ...kids,
];
const prop = (name: string, value: unknown) => ({ name, value: { type: "x", value } });
const tree = (...inner: AXNode[][]): AXNode[] => {
  const kids = inner.flat().filter((n) => !n.parentId);
  return [{ nodeId: "0", role: { type: "role", value: "RootWebArea" }, childIds: kids.map((k) => k.nodeId), backendDOMNodeId: 1 }, ...inner.flat()];
};
const top = (n: AXNode[]): AXNode => n[0] as AXNode;

describe("renderSnapshot", () => {
  it("renders a login form: roles, names, values, states, urls, merged text", () => {
    const r = renderSnapshot(fixture("login-form"), { refs: fresh() });
    expect(r.text).toBe(
      lines(
        '- heading "Sign in" [level=1] [ref=e1]',
        '- textbox "Email" [ref=e2] [required]: alice@example.org',
        '- checkbox "Remember me" [ref=e3] [checked]',
        '- button "Continue" [ref=e4]',
        '- link "Forgot password?" [ref=e5]',
        "  - /url: https://example.org/reset",
        "- text: Some paragraph text",
      ),
    );
    expect(r.refCount).toBe(5);
    expect(r.truncated).toBe(false);
    expect(r.refs).toEqual({ loaderId: "L1", url: "https://a.test/", next: 6, refs: { e1: 10, e2: 12, e3: 13, e4: 14, e5: 16 } });
  });

  it("hoists ignored nodes and unnamed wrappers, escapes quotes, keeps text of sibling wrappers apart", () => {
    const r = renderSnapshot(fixture("nested-generic"), { refs: fresh() });
    expect(r.text).toBe(
      lines('- navigation "Main"', '  - link "Home \\"page\\"" [ref=e1]', "    - /url: /", '- generic "Box" [ref=e2]', "- text: Foo", "- text: Bar"),
    );
  });

  it("renders only nodes with refs, flat, with interactive", () => {
    const r = renderSnapshot(fixture("nested-generic"), { refs: fresh(), interactive: true });
    expect(r.text).toBe(lines('- link "Home \\"page\\"" [ref=e1]', '- generic "Box" [ref=e2]'));
    expect(r.refCount).toBe(2);
  });

  it("reuses refs already seen and does not mutate the table it is given", () => {
    const input = fresh();
    const first = renderSnapshot(fixture("login-form"), { refs: input });
    expect(input).toEqual(fresh());
    const second = renderSnapshot(fixture("login-form"), { refs: first.refs });
    expect(second.text).toBe(first.text);
    expect(second.refs).toEqual(first.refs);
    // a new node gets the next number, known ones keep theirs
    const more = renderSnapshot(fixture("login-form"), { refs: { ...first.refs, refs: { e1: 12 }, next: 2 } });
    expect(more.text.split("\n")[0]).toBe('- heading "Sign in" [level=1] [ref=e2]');
    expect(more.text.split("\n")[1]).toBe('- textbox "Email" [ref=e1] [required]: alice@example.org');
  });

  it("renders only the subtree under rootBackendId", () => {
    const refs = renderSnapshot(fixture("login-form"), { refs: fresh() }).refs;
    expect(renderSnapshot(fixture("login-form"), { refs, rootBackendId: 16 }).text).toBe(
      lines('- link "Forgot password?" [ref=e5]', "  - /url: https://example.org/reset"),
    );
    expect(renderSnapshot(fixture("login-form"), { refs: fresh(), rootBackendId: 12 }).text).toBe('- textbox "Email" [ref=e1] [required]: alice@example.org');
    expect(renderSnapshot(fixture("login-form"), { refs: fresh(), rootBackendId: 999 }).text).toBe("");
  });

  it("cuts at a line boundary and says how much is left", () => {
    const r = renderSnapshot(fixture("long-list"), { refs: fresh(), maxChars: 60 });
    expect(r.text).toBe(
      lines("- list", "  - listitem", '    - link "Item 1" [ref=e1]', "… [truncated: 22 more lines — use `snapshot <ref>` or --interactive]"),
    );
    expect(r.truncated).toBe(true);
    expect(r.refCount).toBe(1);
    expect(r.refs.next).toBe(13);
    const all = renderSnapshot(fixture("long-list"), { refs: fresh() });
    expect(all.truncated).toBe(false);
    expect(all.text.split("\n")).toHaveLength(25);
  });

  it("expands a same-origin iframe from frames and flags the others", () => {
    const { main, frames } = fixture<{ main: AXNode[]; frames: Record<string, AXNode[]> }>("iframes");
    const r = renderSnapshot(main, { refs: fresh(), frames });
    expect(r.text).toBe(
      lines(
        '- button "Open" [ref=e1]',
        "- iframe [ref=e2]",
        '  - textbox "Search" [ref=e3]',
        "  - text: Inside",
        "- iframe [ref=e4] (cross-origin, not expanded)",
      ),
    );
    expect(renderSnapshot(main, { refs: fresh() }).text).toBe(
      lines('- button "Open" [ref=e1]', "- iframe [ref=e2] (cross-origin, not expanded)", "- iframe [ref=e3] (cross-origin, not expanded)"),
    );
    expect(renderSnapshot(main, { refs: fresh(), frames, interactive: true }).text).toBe(
      lines('- button "Open" [ref=e1]', "- iframe [ref=e2]", '- textbox "Search" [ref=e3]', "- iframe [ref=e4] (cross-origin, not expanded)"),
    );
    expect(renderSnapshot(main, { refs: fresh(), frames, rootBackendId: 102 }).text).toBe('- textbox "Search" [ref=e1]');
  });

  it("collapses whitespace in names, truncates long ones and escapes quotes", () => {
    const long = "a".repeat(130);
    const r = renderSnapshot(
      tree(node(1, "button", '  Hello\n   "big"  world '), node(2, "link", long), node(3, "button", undefined, { name: { type: "x", value: "" } })),
      { refs: fresh() },
    );
    expect(r.text).toBe(lines('- button "Hello \\"big\\" world" [ref=e1]', `- link "${"a".repeat(120)}…" [ref=e2]`, "- button [ref=e3]"));
  });

  it("prints every state, and the value of value roles only", () => {
    const r = renderSnapshot(
      tree(
        node(1, "checkbox", "A", { properties: [prop("checked", "mixed"), prop("disabled", true), prop("focused", true)] }),
        node(2, "button", "B", { properties: [prop("expanded", false), prop("pressed", true), prop("selected", true)] }),
        node(3, "combobox", "C", { properties: [prop("expanded", true), prop("checked", "false")], value: { type: "string", value: " one\ntwo " } }),
        node(4, "button", "D", { value: { type: "string", value: "ignored" }, properties: [prop("pressed", "mixed"), prop("disabled", false)] }),
        node(5, "slider", "E", { value: { type: "string", value: "" } }),
      ),
      { refs: fresh() },
    );
    expect(r.text).toBe(
      lines(
        '- checkbox "A" [ref=e1] [checked=mixed] [disabled] [focused]',
        '- button "B" [ref=e2] [expanded=false] [selected] [pressed]',
        '- combobox "C" [ref=e3] [expanded=true]: one two',
        '- button "D" [ref=e4] [pressed=mixed]',
        '- slider "E" [ref=e5]',
      ),
    );
  });

  it("gives refs to focusable and editable nodes, not to plain ones, and skips nodes without a backend id", () => {
    const r = renderSnapshot(
      tree(
        node(1, "generic", undefined, { properties: [prop("focusable", true)] }),
        node(2, "region", "Plain"),
        node(3, "paragraph", "Edit", { properties: [prop("editable", "richtext")] }),
        node(4, "paragraph", "NotEditable", { properties: [prop("editable", false), prop("focusable", "false")] }),
        node(5, "button", "Orphan", { backendDOMNodeId: undefined }),
      ),
      { refs: fresh() },
    );
    expect(r.text).toBe(lines("- generic [ref=e1]", '- region "Plain"', '- paragraph "Edit" [ref=e2]', '- paragraph "NotEditable"', '- button "Orphan"'));
  });

  it("builds text from inline boxes when a static text has no name, and drops empty text", () => {
    const box = (id: number, text: string, parent: string) => node(id, "InlineTextBox", text, { parentId: parent });
    const r = renderSnapshot(
      tree(
        node(1, "StaticText", undefined, {}, [top(box(11, "Inline ", "1")), top(box(12, "only", "1"))]),
        node(2, "StaticText", "   "),
        node(3, "LineBreak", undefined),
        node(4, "paragraph", undefined, {}, [top(node(41, "StaticText", "kept", { parentId: "4" }))]),
        node(5, "button", "Go", { ignored: true }, [top(node(51, "StaticText", "hidden-parent", { parentId: "5" }))]),
      ),
      { refs: fresh() },
    );
    expect(r.text).toBe(lines("- text: Inline only", "- paragraph", "  - text: kept", "- text: hidden-parent"));
  });

  it("survives a cyclic or dangling tree", () => {
    const nodes: AXNode[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "404"], backendDOMNodeId: 1 },
      { nodeId: "2", role: { value: "region" }, name: { value: "Loop" }, childIds: ["1", "2"], backendDOMNodeId: 2, parentId: "1" },
    ];
    expect(renderSnapshot(nodes, { refs: fresh() }).text).toBe('- region "Loop"');
    expect(renderSnapshot([], { refs: fresh() }).text).toBe("");
  });

  it("parses the url property only for links and tolerates a url that is not a string", () => {
    const r = renderSnapshot(tree(node(1, "link", "x", { properties: [prop("url", 5)] }), node(2, "link", "y", { properties: [prop("url", "")] })), {
      refs: fresh(),
    });
    expect(r.text).toBe(lines('- link "x" [ref=e1]', '- link "y" [ref=e2]'));
  });
});

// --- collector ----------------------------------------------------------------

let fake: FakeCdp;
let home: string;
const open: BrowserSession[] = [];
let loader = "L-main";
const getFull: { frameId?: string }[] = [];

beforeEach(async () => {
  fake = await FakeCdp.start();
  scriptBrowser(fake);
  home = mkdtempSync(join(tmpdir(), "wi-snapshot-"));
  process.env[envName("BROWSER_DIR")] = home;
  loader = "L-main";
  getFull.length = 0;
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.detach();
  await fake.close();
  rmSync(home, { recursive: true, force: true });
});

const deps = (): Partial<BrowserDeps> => ({ spawn: fakeSpawn({ port: fake.port }).spawn, detectBrowser: () => ({ kind: "chrome", path: "/fake/chrome" }) });
const attach = async () => {
  const s = await openBrowserSession({ cdp: fake.port, deps: deps() });
  open.push(s);
  return s;
};
/** Script the accessibility side of the fake: the main tree, optional frame trees and the frames the page owns. */
const scriptAx = (opts: { main: AXNode[]; frames?: Record<string, AXNode[]>; owner?: Record<number, string>; childFrames?: string[] }) => {
  fake.handle("Accessibility.enable", () => ({}));
  fake.handle("Accessibility.getFullAXTree", (p: { frameId?: string }) => {
    getFull.push(p);
    if (p.frameId === undefined) return { nodes: opts.main };
    const f = opts.frames?.[p.frameId];
    if (!f) throw { code: -32000, message: "Frame with the given id was not found." };
    return { nodes: f };
  });
  fake.handle("DOM.describeNode", (p: { backendNodeId: number }) => {
    const frameId = opts.owner?.[p.backendNodeId];
    if (frameId === undefined) throw { code: -32000, message: "Could not find node with given id" };
    return { node: { nodeId: 0, backendNodeId: p.backendNodeId, frameId } };
  });
  fake.handle("Page.getFrameTree", () => ({
    frameTree: {
      frame: { id: "T1", loaderId: loader, url: "https://a.test/", securityOrigin: "", mimeType: "text/html" },
      childFrames: (opts.childFrames ?? []).map((id) => ({ frame: { id, loaderId: "x", url: "https://a.test/in" }, childFrames: [] })),
    },
  }));
};

describe("takeSnapshot", () => {
  it("fetches the tree, prints url and title, and persists the refs", async () => {
    fake.addTarget("https://a.test/", "Login page");
    scriptAx({ main: fixture("login-form") });
    const s = await attach();
    const r = await takeSnapshot(s, {});
    expect(r.url).toBe("https://a.test/");
    expect(r.title).toBe("Login page");
    expect(r.loaderId).toBe("L-main");
    expect(r.refCount).toBe(5);
    expect(r.truncated).toBe(false);
    expect(r.text.split("\n").slice(0, 3)).toEqual(["url: https://a.test/", "title: Login page", '- heading "Sign in" [level=1] [ref=e1]']);
    expect(readRefs("T1")).toEqual({ loaderId: "L-main", url: "https://a.test/", next: 6, refs: { e1: 10, e2: 12, e3: 13, e4: 14, e5: 16 } });
    expect(fake.calls.map((c) => c.method)).toContain("Accessibility.enable");
  });

  it("keeps the same refs across calls on the same document, and starts over after a navigation", async () => {
    fake.addTarget("https://a.test/", "T");
    scriptAx({ main: fixture("login-form") });
    const s = await attach();
    writeRefs("T1", { loaderId: "L-main", url: "https://a.test/", next: 3, refs: { e2: 14 } });
    const again = await takeSnapshot(s, {});
    expect(again.text).toContain('- button "Continue" [ref=e2]');
    expect(again.text).toContain('- heading "Sign in" [level=1] [ref=e3]');
    loader = "L-next";
    const after = await takeSnapshot(s, {});
    expect(after.text).toContain('- heading "Sign in" [level=1] [ref=e1]');
    expect(readRefs("T1")?.loaderId).toBe("L-next");
  });

  it("starts a fresh table when the saved one has no loader", async () => {
    fake.addTarget("https://a.test/", "T");
    scriptAx({ main: fixture("login-form") });
    const s = await attach();
    expect(readRefs("T1")).toBeNull();
    expect((await takeSnapshot(s, { interactive: true })).text).toContain('- heading "Sign in" [level=1] [ref=e1]');
  });

  it("renders the subtree of a known ref and rejects an unknown one with StaleRefError", async () => {
    fake.addTarget("https://a.test/", "T");
    scriptAx({ main: fixture("login-form") });
    const s = await attach();
    await takeSnapshot(s, {});
    const sub = await takeSnapshot(s, { ref: "e5" });
    expect(sub.text).toBe(lines("url: https://a.test/", "title: T", '- link "Forgot password?" [ref=e5]', "  - /url: https://example.org/reset"));
    const err = await takeSnapshot(s, { ref: "e99" }).catch((e) => e);
    expect(err).toBeInstanceOf(StaleRefError);
    expect(err.message).toMatch(/e99/);
    expect(err.message).toMatch(/new snapshot/);
    // a known ref whose node left the tree is stale too
    writeRefs("T1", { loaderId: "L-main", url: "u", next: 8, refs: { e7: 4242 } });
    await expect(takeSnapshot(s, { ref: "e7" })).rejects.toBeInstanceOf(StaleRefError);
    // and so is any ref once the document changed
    loader = "L-other";
    await expect(takeSnapshot(s, { ref: "e5" })).rejects.toBeInstanceOf(StaleRefError);
  });

  it("applies interactive and maxChars", async () => {
    fake.addTarget("https://a.test/", "T");
    scriptAx({ main: fixture("long-list") });
    const s = await attach();
    const r = await takeSnapshot(s, { interactive: true, maxChars: 70 });
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("[truncated:");
    expect(r.text).toContain('- link "Item 1" [ref=e1]');
  });

  it("expands iframes of the same process and leaves the others, never throwing", async () => {
    fake.addTarget("https://a.test/", "T");
    const { main, frames } = fixture<{ main: AXNode[]; frames: Record<string, AXNode[]> }>("iframes");
    scriptAx({ main, frames: { F30: frames["30"] as AXNode[] }, owner: { 30: "F30", 40: "F40" }, childFrames: ["F30"] });
    const s = await attach();
    const r = await takeSnapshot(s, {});
    expect(r.text).toContain(lines("- iframe [ref=e2]", '  - textbox "Search" [ref=e3]', "  - text: Inside", "- iframe [ref=e4] (cross-origin, not expanded)"));
    expect(getFull).toEqual([{}, { frameId: "F30" }]);
    // ref into the frame
    expect((await takeSnapshot(s, { ref: "e3" })).text).toContain('- textbox "Search" [ref=e3]');
  });

  it("leaves a frame unexpanded when describeNode or the frame fetch fails", async () => {
    fake.addTarget("https://a.test/", "T");
    const { main } = fixture<{ main: AXNode[] }>("iframes");
    scriptAx({ main, owner: { 40: "GONE" }, childFrames: ["GONE"] }); // 30: describeNode fails; 40: frame fetch fails
    const s = await attach();
    const r = await takeSnapshot(s, {});
    expect(r.text).toContain("- iframe [ref=e2] (cross-origin, not expanded)");
    expect(r.text).toContain("- iframe [ref=e3] (cross-origin, not expanded)");
  });
});
