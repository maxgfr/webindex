import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envName } from "../src/brand.js";
import type { BrowserDeps } from "../src/browser/deps.js";
import { type BrowserSession, openBrowserSession } from "../src/browser/session.js";
import { type AXNode, fieldHint, renderSnapshot, StaleRefError, takeSnapshot } from "../src/browser/snapshot.js";
import { type RefTable, readRefs, writeRefs } from "../src/browser/state.js";
import { UsageError } from "../src/cli-kit.js";
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

describe("hints on unclear form controls", () => {
  const form = () =>
    tree(
      node(1, "textbox", "Username Password"),
      node(2, "textbox", ""),
      node(3, "button", "Add"),
      node(4, "button", "Add"),
      node(5, "link", ""),
      node(6, "checkbox", "Agree"),
      node(7, "radio", undefined),
    );

  it("lists the form controls with no name, or a name another one shares; never a link or a uniquely named one", () => {
    expect(renderSnapshot(form(), { refs: fresh() }).unclear).toEqual([20, 30, 40, 70]);
    expect(renderSnapshot(form(), { refs: fresh(), interactive: true }).unclear).toEqual([20, 30, 40, 70]);
  });

  it("prints a hint right after the ref", () => {
    const r = renderSnapshot(form(), { refs: fresh(), hints: { 20: '(type=password, name="password")', 70: '(type=radio, name="size")' } });
    expect(r.text).toContain('- textbox [ref=e2] (type=password, name="password")');
    expect(r.text).toContain('- radio [ref=e7] (type=radio, name="size")');
    expect(r.text).toContain('- textbox "Username Password" [ref=e1]\n');
  });

  it("builds a hint from the type, name and placeholder (else the id), never the value", () => {
    expect(fieldHint("INPUT", ["type", "password", "name", "password", "value", "hunter2", "placeholder", "Your password", "id", "pw"])).toBe(
      '(type=password, name="password", placeholder="Your password")',
    );
    expect(fieldHint("INPUT", ["id", "q"])).toBe('(type=text, id="q")');
    expect(fieldHint("BUTTON", ["name", "add", "value", "3"])).toBe('(name="add")');
    expect(fieldHint("TEXTAREA", ["placeholder", `a ${"very ".repeat(20)}long "hint"`])).toMatch(/^\(placeholder="a very .{20,}…"\)$/);
    expect(fieldHint("DIV", ["class", "x"])).toBeUndefined();
    expect(fieldHint("INPUT", ["type", "password", "value", "hunter2"])).not.toContain("hunter2");
  });
});

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
    expect(r.text).toBe(lines('- link "Home \\"page\\"" [ref=e1] → /', '- generic "Box" [ref=e2]'));
    expect(r.refCount).toBe(2);
  });

  it("shows a link's url in interactive mode: path and query on the page's origin, the whole url elsewhere, cut at 80", () => {
    const link = (id: number, name: string, url: string) => node(id, "link", name, { properties: [{ name: "url", value: { type: "string", value: url } }] });
    const long = `https://other.test/${"p".repeat(120)}`;
    const r = renderSnapshot(
      tree(link(1, "Docs", "https://a.test/docs?x=1#top"), link(2, "Out", "https://b.test/x"), link(3, "Long", long), node(4, "button", "Go")),
      { refs: fresh(), interactive: true },
    );
    expect(r.text).toBe(
      lines(
        '- link "Docs" [ref=e1] → /docs?x=1#top',
        '- link "Out" [ref=e2] → https://b.test/x',
        `- link "Long" [ref=e3] → ${long.slice(0, 80)}…`,
        '- button "Go" [ref=e4]',
      ),
    );
  });

  it("does not render an opaque-origin url (javascript:, data:) as a relative one, and cuts on whole characters", () => {
    const link = (id: number, name: string, url: string) => node(id, "link", name, { properties: [{ name: "url", value: { type: "string", value: url } }] });
    const emoji = `https://other.test/${"😀".repeat(100)}`;
    const r = renderSnapshot(tree(link(1, "Run", "javascript:void(0)"), link(2, "Em", emoji)), { refs: fresh(), interactive: true });
    expect(r.text.split("\n")[0]).toBe('- link "Run" [ref=e1] → javascript:void(0)');
    expect(r.text.split("\n")[1]).toBe(`- link "Em" [ref=e2] → ${Array.from(emoji).slice(0, 80).join("")}…`);
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

  it("cuts the first line itself when it alone is over the budget, instead of showing nothing", () => {
    // httpbin.org/post: the JSON body is one line, far longer than --max-chars.
    const body = `{ "args": {}, "data": "", ${'"x": "y", '.repeat(200)}}`;
    const r = renderSnapshot(tree(node(1, "StaticText", body), node(2, "button", "After")), { refs: fresh(), maxChars: 90 });
    const [first, marker, ...rest] = r.text.split("\n");
    expect(rest).toEqual([]);
    expect(first).toBe(`- text: ${body.slice(0, 81)}…`);
    expect(first).toHaveLength(90);
    expect(marker).toBe("… [truncated: the first line cut, 1 more line — use `snapshot <ref>` or --interactive]");
    expect(r.truncated).toBe(true);
    expect(r.refCount).toBe(0);
    // The only line, cut: nothing more to count.
    const only = renderSnapshot(tree(node(1, "StaticText", body)), { refs: fresh(), maxChars: 20 });
    expect(only.text).toBe(`- text: ${body.slice(0, 11)}…\n… [truncated: the first line cut — use \`snapshot <ref>\` or --interactive]`);
    // A cut line keeps its ref only if the ref is still in what is shown.
    const named = renderSnapshot(tree(node(1, "button", "b".repeat(40))), { refs: fresh(), maxChars: 30 });
    expect(named.refCount).toBe(0);
    const tail = renderSnapshot(tree(node(1, "button", "b".repeat(40), { properties: [prop("disabled", true)] })), { refs: fresh(), maxChars: 65 });
    expect(tail.text.split("\n")[0]).toBe(`- button "${"b".repeat(40)}" [ref=e1] [di…`);
    expect(tail.refCount).toBe(1);
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
        node(2, "group", "Plain"),
        node(3, "paragraph", "Edit", { properties: [prop("editable", "richtext")] }),
        node(4, "paragraph", "NotEditable", { properties: [prop("editable", false), prop("focusable", "false")] }),
        node(5, "button", "Orphan", { backendDOMNodeId: undefined }),
      ),
      { refs: fresh() },
    );
    expect(r.text).toBe(lines("- generic [ref=e1]", '- group "Plain"', '- paragraph "Edit" [ref=e2]', '- paragraph "NotEditable"', '- button "Orphan"'));
  });

  it("gives refs to structural containers (a table, a figure, an article, main, a form, a named region or image), never listed by interactive", () => {
    const nodes = tree(
      node(1, "table", "Florian Wirtz", {}, [top(node(11, "cell", "Born", { parentId: "1" }))]),
      node(2, "figure", undefined),
      node(3, "article", undefined),
      node(4, "main", undefined),
      node(5, "region", "Results"),
      node(6, "region", undefined),
      node(7, "complementary", undefined),
      node(8, "form", undefined),
      node(9, "image", "Portrait"),
      node(10, "image", undefined),
      node(12, "img", "Logo"),
      node(13, "paragraph", "Plain"),
      node(14, "button", "Go"),
    );
    const r = renderSnapshot(nodes, { refs: fresh() });
    expect(r.text).toBe(
      lines(
        '- table "Florian Wirtz" [ref=e1]',
        '  - cell "Born"',
        "- figure [ref=e2]",
        "- article [ref=e3]",
        "- main [ref=e4]",
        '- region "Results" [ref=e5]',
        "- region",
        "- complementary [ref=e6]",
        "- form [ref=e7]",
        '- image "Portrait" [ref=e8]',
        "- image",
        '- img "Logo" [ref=e9]',
        '- paragraph "Plain"',
        '- button "Go" [ref=e10]',
      ),
    );
    expect(r.refCount).toBe(10);
    // --interactive stays the controls only: a container's ref is for a scoped snapshot or an element screenshot.
    const i = renderSnapshot(nodes, { refs: fresh(), interactive: true });
    expect(i.text).toBe('- button "Go" [ref=e10]');
    expect(i.refCount).toBe(1);
    // The table remembers which refs are containers only: a click on one is refused.
    expect(r.refs.containers).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"]);
    // A ref that is a control is no container, whatever an earlier table said.
    const again = renderSnapshot(nodes, { refs: { ...r.refs, containers: ["e1", "e10"] } });
    expect(again.refs.containers).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"]);
    // A container's ref scopes a snapshot to it.
    expect(renderSnapshot(nodes, { refs: r.refs, rootBackendId: 10 }).text).toBe(lines('- table "Florian Wirtz" [ref=e1]', '  - cell "Born"'));
  });

  it("gives no ref to the editor inside a text field: one ref per field (httpbin.org/forms/post, as Chrome reports it)", () => {
    const r = renderSnapshot(fixture("httpbin-form"), { refs: fresh() });
    expect(r.text).toBe(
      lines(
        "- form [ref=e1]",
        "  - paragraph",
        "    - LabelText",
        "      - text: Customer name:",
        '      - textbox "Customer name:" [ref=e2]: Alice',
        "  - paragraph",
        "    - LabelText",
        "      - text: Telephone:",
        '      - textbox "Telephone:" [ref=e3]',
        "  - paragraph",
        "    - LabelText",
        "      - text: E-mail address:",
        '      - textbox "E-mail address:" [ref=e4]',
        '  - group "Pizza Size"',
        "    - Legend",
        "      - text: Pizza Size",
        "    - paragraph",
        '      - radio "Small" [ref=e5]',
        "    - paragraph",
        '      - radio "Medium" [ref=e6]',
        "    - paragraph",
        '      - radio "Large" [ref=e7]',
        '  - group "Pizza Toppings"',
        "    - Legend",
        "      - text: Pizza Toppings",
        "    - paragraph",
        '      - checkbox "Bacon" [ref=e8]',
        "    - paragraph",
        '      - checkbox "Extra Cheese" [ref=e9]',
        "    - paragraph",
        '      - checkbox "Onion" [ref=e10]',
        "    - paragraph",
        '      - checkbox "Mushroom" [ref=e11]',
        "  - paragraph",
        "    - LabelText",
        "      - text: Preferred delivery time:",
        '      - InputTime "Preferred delivery time:" [ref=e12]',
        '        - spinbutton "Hours Hours" [ref=e13]: 0',
        "          - text: --",
        "        - text: :",
        '        - spinbutton "Minutes Minutes" [ref=e14]: 0',
        "          - text: --",
        '        - button "Show time picker Show time picker" [ref=e15]',
        "  - paragraph",
        "    - LabelText",
        "      - text: Delivery instructions:",
        '      - textbox "Delivery instructions:" [ref=e16]',
        "  - paragraph",
        '    - button "Submit order" [ref=e17]',
        "- form [ref=e18]",
        '  - button "Choose File" [ref=e19]',
        '  - button "Upload" [ref=e20]',
        '  - button "Supprimer" [ref=e21]',
      ),
    );
    expect(renderSnapshot(fixture("httpbin-form"), { refs: fresh(), interactive: true }).text).not.toMatch(/generic/);
  });

  it("keeps the ref of a named or role-bearing control inside a field, and of an editor in no field", () => {
    const editor = (id: number, parent: string, name?: string) => node(id, "generic", name, { parentId: parent, properties: [prop("editable", "plaintext")] });
    const r = renderSnapshot(
      tree(
        // A field with no ref of its own (no backend id): its editor is what can be acted on.
        node(1, "textbox", "Orphan", { backendDOMNodeId: undefined }, [top(editor(11, "1"))]),
        // A named control inside a combobox (a clear button) is a control of its own.
        // An unnamed focusable toggle in a custom ARIA combobox (an icon-only clear button) is not an editor: it keeps its ref.
        node(4, "combobox", "Country", { properties: [prop("focusable", true)] }, [
          top(node(41, "generic", undefined, { parentId: "4", properties: [prop("focusable", true)] })),
        ]),
        node(2, "combobox", "City", { properties: [prop("focusable", true)] }, [
          top(editor(21, "2", "Clear")),
          top(node(22, "button", undefined, { parentId: "2" })),
        ]),
        // A contenteditable region is a field of its own, wherever it sits.
        node(3, "group", "Notes", {}, [top(editor(31, "3"))]),
      ),
      { refs: fresh() },
    );
    expect(r.text).toBe(
      lines(
        '- textbox "Orphan"',
        "  - generic [ref=e1]",
        '- combobox "Country" [ref=e2]',
        "  - generic [ref=e3]",
        '- combobox "City" [ref=e4]',
        '  - generic "Clear" [ref=e5]',
        "  - button [ref=e6]",
        '- group "Notes"',
        "  - generic [ref=e7]",
      ),
    );
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
      { nodeId: "2", role: { value: "group" }, name: { value: "Loop" }, childIds: ["1", "2"], backendDOMNodeId: 2, parentId: "1" },
    ];
    expect(renderSnapshot(nodes, { refs: fresh() }).text).toBe('- group "Loop"');
    expect(renderSnapshot([], { refs: fresh() }).text).toBe("");
  });

  // A page whose consent wall comes last in the document, as lemonde.fr's does.
  const walled = (): AXNode[] => {
    const article = node(2, "article", undefined, { parentId: "0", childIds: ["3", "4"] });
    const heading = node(3, "heading", "The news", { parentId: "2", properties: [prop("level", 1)] });
    const para = node(4, "paragraph", "A long paragraph of the article", { parentId: "2" });
    const wall = node(5, "dialog", "Cookies", { parentId: "0", childIds: ["6", "7"] });
    const accept = node(6, "button", "Accepter et continuer", { parentId: "5" });
    const refuse = node(7, "button", "Refuser", { parentId: "5" });
    return [
      { nodeId: "0", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "5"], backendDOMNodeId: 1 },
      ...article,
      ...heading,
      ...para,
      ...wall,
      ...accept,
      ...refuse,
    ];
  };

  it("renders the overlays first, under their own header, and not again in the tree", () => {
    const r = renderSnapshot(walled(), { refs: fresh(), overlays: [50] });
    expect(r.text).toBe(
      lines(
        "- overlay (covers the page):",
        '  - dialog "Cookies"',
        '    - button "Accepter et continuer" [ref=e1]',
        '    - button "Refuser" [ref=e2]',
        "- article [ref=e3]",
        '  - heading "The news" [level=1] [ref=e4]',
        '  - paragraph "A long paragraph of the article"',
      ),
    );
    expect(r.refCount).toBe(4);
  });

  it("keeps the overlay when --max-chars cuts the page: the tree gets what the overlay leaves", () => {
    const r = renderSnapshot(walled(), { refs: fresh(), overlays: [50], maxChars: 130 });
    expect(r.text.split("\n").slice(0, 4)).toEqual([
      "- overlay (covers the page):",
      '  - dialog "Cookies"',
      '    - button "Accepter et continuer" [ref=e1]',
      '    - button "Refuser" [ref=e2]',
    ]);
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain("The news");
  });

  it("lists an overlay's controls flat, indented under the header, in interactive mode", () => {
    const r = renderSnapshot(walled(), { refs: fresh(), overlays: [50], interactive: true });
    expect(r.text).toBe(
      lines(
        "- overlay (covers the page):",
        '  - button "Accepter et continuer" [ref=e1]',
        '  - button "Refuser" [ref=e2]',
        '- heading "The news" [level=1] [ref=e4]',
      ),
    );
  });

  it("skips an overlay that is not in the tree or renders nothing, and ignores overlays for a subtree", () => {
    const empty = renderSnapshot(walled(), { refs: fresh(), overlays: [999] });
    expect(empty.text).not.toContain("overlay");
    expect(empty.text).toContain('- dialog "Cookies"');
    const nothing = [
      { nodeId: "0", role: { value: "RootWebArea" }, childIds: ["1", "2"], backendDOMNodeId: 1 },
      { nodeId: "1", role: { value: "generic" }, childIds: [], backendDOMNodeId: 10, parentId: "0" },
      ...node(2, "button", "Go", { parentId: "0" }),
    ] as AXNode[];
    expect(renderSnapshot(nothing, { refs: fresh(), overlays: [10] }).text).toBe('- button "Go" [ref=e1]');
    const sub = renderSnapshot(walled(), { refs: fresh(), overlays: [50], rootBackendId: 20 });
    expect(sub.text).not.toContain("overlay");
    expect(sub.text).not.toContain("Accepter");
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
    expect(err.message).toBe('ref "e99" is unknown or stale: take a new snapshot and use the refs it returns');
    // a known ref whose node left the tree is stale too
    writeRefs("T1", { loaderId: "L-main", url: "u", next: 8, refs: { e7: 4242 } });
    await expect(takeSnapshot(s, { ref: "e7" })).rejects.toBeInstanceOf(StaleRefError);
    // and so is any ref once the document changed
    loader = "L-other";
    await expect(takeSnapshot(s, { ref: "e5" })).rejects.toBeInstanceOf(StaleRefError);
  });

  it("refuses what is not a ref (a CSS selector) as a usage error that points at --selector", async () => {
    fake.addTarget("https://a.test/", "T");
    scriptAx({ main: fixture("login-form") });
    const s = await attach();
    const err = await takeSnapshot(s, { ref: "table.infobox" }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toBe("expected a ref like e12 from the latest snapshot; CSS selectors: use --selector (screenshot, snapshot, text, wait)");
    expect(getFull).toEqual([]);
  });

  it("scopes to the element a CSS selector matches, and fails on one that matches nothing", async () => {
    fake.addTarget("https://a.test/", "T");
    scriptAx({ main: fixture("login-form") });
    // Through the DOM domain, never the page's own document.querySelector (a page can replace it).
    fake.handle("DOM.getDocument", () => ({ root: { nodeId: 1, backendNodeId: 1 } }));
    fake.handle("DOM.querySelector", (p: { nodeId: number; selector: string }) => {
      expect(p.nodeId).toBe(1);
      if (p.selector === "div[") throw { code: -32000, message: "DOM Error while querying" };
      return { nodeId: p.selector === "a.reset" ? 116 : 0 };
    });
    const describe = fake.handlerOf("DOM.describeNode");
    fake.handle("DOM.describeNode", (p: { nodeId?: number }, sid) => (p.nodeId === 116 ? { node: { nodeId: 116, backendNodeId: 16 } } : describe?.(p, sid)));
    const s = await attach();
    const r = await takeSnapshot(s, { selector: "a.reset" });
    expect(r.text).toBe(lines("url: https://a.test/", "title: T", '- link "Forgot password?" [ref=e1]', "  - /url: https://example.org/reset"));
    expect(readRefs("T1")?.refs.e1).toBe(16);
    const none = await takeSnapshot(s, { selector: "table.nope" }).catch((e) => e);
    expect(none).not.toBeInstanceOf(UsageError);
    expect(none.message).toBe("no element matches table.nope");
    await expect(takeSnapshot(s, { selector: "div[" })).rejects.toBeInstanceOf(UsageError);
    await expect(takeSnapshot(s, { selector: "a.reset", ref: "e1" })).rejects.toBeInstanceOf(UsageError);
    expect(fake.calls.some((c) => c.method === "Runtime.evaluate" && String(c.params?.expression).includes("querySelector"))).toBe(false);
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

  /** The overlay probe's answers: these backendNodeIds are what it finds on top. */
  const scriptOverlays = (ids: number[]) => {
    fake.handle("Runtime.evaluate", (p: { expression: string }) =>
      p.expression.includes("findOverlays") ? { result: { type: "object", subtype: "array", objectId: "arr" } } : { result: { type: "undefined" } },
    );
    fake.handle("Runtime.getProperties", () => ({
      result: ids.map((_, i) => ({ name: String(i), value: { type: "object", subtype: "node", objectId: `ov${i}` } })),
    }));
    const describe = fake.handlerOf("DOM.describeNode");
    fake.handle("DOM.describeNode", (p: { objectId?: string; backendNodeId?: number }, sid) => {
      if (p.objectId?.startsWith("ov")) return { node: { nodeId: 0, backendNodeId: ids[Number(p.objectId.slice(2))] } };
      return describe?.(p, sid);
    });
  };

  it("shows the overlays the probe finds first, and they survive a small --max-chars", async () => {
    fake.addTarget("https://a.test/", "T");
    const main: AXNode[] = [
      { nodeId: "0", role: { value: "RootWebArea" }, childIds: ["1", "2"], backendDOMNodeId: 1 },
      ...node(1, "link", "x".repeat(200), { parentId: "0" }),
      ...node(2, "dialog", "Consent", { parentId: "0", childIds: ["3"] }),
      ...node(3, "button", "Accept all", { parentId: "2" }),
    ];
    scriptAx({ main });
    scriptOverlays([20]);
    const s = await attach();
    const r = await takeSnapshot(s, { maxChars: 120 });
    expect(r.text.split("\n").slice(2, 5)).toEqual(["- overlay (covers the page):", '  - dialog "Consent"', '    - button "Accept all" [ref=e1]']);
    expect(r.truncated).toBe(true);
    expect(readRefs("T1")?.refs.e1).toBe(30);
    expect(getFull).toEqual([{}]);
  });

  it("fetches the tree once more when the probe sees an overlay the tree does not have yet", async () => {
    fake.addTarget("https://a.test/", "T");
    const before: AXNode[] = [
      { nodeId: "0", role: { value: "RootWebArea" }, childIds: ["1"], backendDOMNodeId: 1 },
      ...node(1, "link", "Home", { parentId: "0" }),
    ];
    const after: AXNode[] = [
      { nodeId: "0", role: { value: "RootWebArea" }, childIds: ["1", "2"], backendDOMNodeId: 1 },
      ...node(1, "link", "Home", { parentId: "0" }),
      ...node(2, "dialog", "Cookies", { parentId: "0", childIds: ["3"] }),
      ...node(3, "button", "Refuse", { parentId: "2" }),
    ];
    scriptAx({ main: before });
    let calls = 0;
    fake.handle("Accessibility.getFullAXTree", (p: { frameId?: string }) => {
      getFull.push(p);
      return { nodes: calls++ === 0 ? before : after };
    });
    scriptOverlays([20]);
    const s = await attach();
    const r = await takeSnapshot(s, {});
    expect(getFull).toEqual([{}, {}]);
    expect(r.text).toContain(lines("- overlay (covers the page):", '  - dialog "Cookies"', '    - button "Refuse" [ref=e1]', '- link "Home" [ref=e2]'));
  });

  it("does not look for overlays in a ref's subtree", async () => {
    fake.addTarget("https://a.test/", "T");
    scriptAx({ main: fixture("login-form") });
    scriptOverlays([20]);
    const s = await attach();
    await takeSnapshot(s, {});
    const before = fake.calls.filter((c) => c.method === "Runtime.getProperties").length;
    await takeSnapshot(s, { ref: "e5" });
    expect(fake.calls.filter((c) => c.method === "Runtime.getProperties").length).toBe(before);
  });

  it("hints the unclear controls from their attributes: one lookup each, 50 at most, never a password's value", async () => {
    fake.addTarget("https://a.test/", "T");
    const many = Array.from({ length: 60 }, (_, i) => node(100 + i, "textbox", ""));
    scriptAx({ main: tree(node(1, "textbox", "Username Password"), node(2, "textbox", ""), ...many) });
    fake.handle("DOM.describeNode", (p: { backendNodeId: number }) => ({
      node: {
        nodeId: 0,
        backendNodeId: p.backendNodeId,
        nodeName: "INPUT",
        attributes: p.backendNodeId === 20 ? ["type", "password", "name", "password", "value", "hunter2"] : ["name", `f${p.backendNodeId}`],
      },
    }));
    const s = await attach();
    const r = await takeSnapshot(s, { interactive: true });
    expect(r.text).toContain('- textbox [ref=e2] (type=password, name="password")');
    expect(r.text).toContain('- textbox "Username Password" [ref=e1]\n');
    expect(r.text).not.toContain("hunter2");
    const lookups = fake.calls.filter((c) => c.method === "DOM.describeNode" && c.params?.backendNodeId !== undefined);
    expect(lookups).toHaveLength(50);
    // Those past the cap are printed as they are.
    expect(r.text).toMatch(/^- textbox \[ref=e62\]$/m);
  });

  it("prints the snapshot without hints when the lookups fail", async () => {
    fake.addTarget("https://a.test/", "T");
    scriptAx({ main: tree(node(2, "textbox", "")) });
    const s = await attach();
    expect((await takeSnapshot(s, {})).text).toContain("- textbox [ref=e1]");
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
