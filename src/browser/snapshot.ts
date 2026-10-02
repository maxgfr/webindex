import { UsageError } from "../cli-kit.js";
import { CdpError, type CdpSession } from "./cdp.js";
import { findOverlays } from "./overlay.js";
import type { BrowserSession } from "./session.js";
import { type RefTable, readRefs, writeRefs } from "./state.js";

// The accessibility snapshot: what the agent "sees" of a page.
//
// renderSnapshot is pure and deterministic: it turns the nodes of
// Accessibility.getFullAXTree into a compact text tree, one node per line,
// and hands out stable refs (`e<N>`, backed by the node's backendDOMNodeId) that
// later actions pass back. takeSnapshot fetches the tree from a live session
// and keeps the ref table on disk, so a ref survives from one CLI call to the next.
//
// Refs go to what an agent acts on (controls, headings, iframes, anything
// focusable or editable) and to the structural containers it may want to scope
// a snapshot or an element screenshot to (a table, a figure, an article…).
// --interactive lists only the first kind.
//
// What covers the page (a cookie wall, a modal: see overlay.ts) is rendered
// first, under an `overlay` header, and not again in the tree: a wall that comes
// last in the document is never what a --max-chars cut drops.
//
// A form control with no name, or with the name another one has (two <label>s
// for one field name the first field after both and leave the second unnamed),
// cannot be told apart by its line alone: takeSnapshot looks up its type, name
// and placeholder attributes and prints them after its ref. Never its value.

/** A CDP Accessibility.AXValue, reduced to what we read. */
export interface AXValue {
  type?: string;
  value?: unknown;
}

/** A CDP Accessibility.AXNode, reduced to what we read. */
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
}

export interface RenderOptions {
  /** Only the nodes an agent acts on, flat (no indentation, no text, no `/url` lines, no containers). */
  interactive?: boolean;
  /** Cut the tree at a line boundary once it is longer than this (a first line longer than all of it is cut itself). No limit by default. */
  maxChars?: number;
  /** Render only the subtree of this node. */
  rootBackendId?: number;
  /** The refs seen so far; never mutated, an updated copy is returned. */
  refs: RefTable;
  /** Same-process iframe trees, keyed by the iframe's backendDOMNodeId as a string. */
  frames?: Record<string, AXNode[]>;
  /** The backendDOMNodeIds of the overlays over the page: rendered first, each under its own header. Ignored with rootBackendId. */
  overlays?: number[];
  /** What to print after the ref of a control, by its backendDOMNodeId: see fieldHint. */
  hints?: Record<number, string>;
}

export interface RenderResult {
  text: string;
  refs: RefTable;
  truncated: boolean;
  /** Refs visible in `text`: the controls', and in a full snapshot the containers' too. */
  refCount: number;
  /** The form controls rendered with no name, or with a name another one shares, in document order: their backendDOMNodeIds. */
  unclear: number[];
}

/** A ref the table does not know, or that belongs to a document that is gone. */
export class StaleRefError extends Error {
  constructor(readonly ref: string) {
    super(`ref ${JSON.stringify(ref)} is unknown or stale: take a new snapshot and use the refs it returns`);
    this.name = "StaleRefError";
  }
}

const REF_SHAPE = /^e\d+$/;

/** Refuse what cannot be a ref at all (a CSS selector, a typo) as a usage error, before anything looks it up. */
export function checkRef(ref: string): void {
  if (!REF_SHAPE.test(ref))
    throw new UsageError("expected a ref like e12 from the latest snapshot; CSS selectors: use --selector (screenshot, snapshot, text, wait)");
}

/** No element of the document matches a CSS selector: the page as it is, not the invocation (exit 1). */
export class NoMatchError extends Error {
  constructor(readonly selector: string) {
    super(`no element matches ${selector}`);
    this.name = "NoMatchError";
  }
}

/**
 * The backendNodeId of the first element of the main document a CSS selector
 * matches, through the DOM domain: the page's own document.querySelector,
 * which a page may replace, is never called. NoMatchError when none matches;
 * a UsageError when the browser calls it no selector at all.
 */
export async function elementBySelector(page: CdpSession, selector: string): Promise<number> {
  const { root } = await page.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
  let nodeId: number | undefined;
  try {
    ({ nodeId } = await page.send<{ nodeId?: number }>("DOM.querySelector", { nodeId: root.nodeId, selector }));
  } catch (e) {
    if (e instanceof CdpError) throw new UsageError(`${JSON.stringify(selector)} is not a valid CSS selector`);
    throw e;
  }
  if (!nodeId) throw new NoMatchError(selector);
  const { node } = await page.send<{ node?: { backendNodeId?: number } }>("DOM.describeNode", { nodeId });
  if (typeof node?.backendNodeId !== "number" || node.backendNodeId <= 0) throw new NoMatchError(selector);
  return node.backendNodeId;
}

const NAME_MAX = 120;
const OVERLAY_HEADER = "- overlay (covers the page):";
/** How long a tree that lacks an overlay the probe saw is given to catch up, once. */
const OVERLAY_RETRY_MS = 300;
const FRAME_MAX = 10;
const COLLAPSIBLE = new Set(["generic", "none", "presentation", "GenericContainer"]);
const HOISTED = new Set(["RootWebArea", "WebArea"]);
const TEXT_ROLES = new Set(["StaticText", "text"]);
const REF_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "iframe",
  "heading",
]);
/** Containers worth naming, to scope a snapshot or an element screenshot to: always, or only when they have a name. */
const CONTAINER_ROLES = new Set(["table", "figure", "article", "main", "complementary", "form"]);
const NAMED_CONTAINER_ROLES = new Set(["region", "image", "img"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
/** Fields whose editor (a node in the input's user-agent shadow tree) is the field itself, not a control of its own. */
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
/** The form controls an unclear name earns a hint: see fieldHint. */
const HINT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "checkbox", "radio", "button"]);
/** How many controls one snapshot looks up for hints. */
const HINT_MAX = 50;
const HINT_VALUE_MAX = 40;

/**
 * The hint printed after an unclear control's ref, from its element's tag and
 * attributes (a flat [name, value, …] list, as DOM.describeNode gives them):
 * `(type=password, name="password", placeholder="…")`, the id when it has no
 * name. An input's type defaults to text. Its value is never read: a password
 * field's would be the secret itself. Undefined when there is nothing to say.
 */
export function fieldHint(nodeName: string, attributes: string[]): string | undefined {
  const attr = new Map<string, string>();
  for (let i = 0; i + 1 < attributes.length; i += 2) attr.set((attributes[i] as string).toLowerCase(), attributes[i + 1] as string);
  const quote = (v: string) => JSON.stringify(v.length > HINT_VALUE_MAX ? `${v.slice(0, HINT_VALUE_MAX)}…` : v);
  const parts: string[] = [];
  const type = attr.get("type")?.trim().toLowerCase() || (nodeName.toUpperCase() === "INPUT" ? "text" : "");
  if (type) parts.push(`type=${type}`);
  const name = attr.get("name")?.trim();
  if (name) parts.push(`name=${quote(name)}`);
  const placeholder = attr.get("placeholder")?.trim();
  if (placeholder) parts.push(`placeholder=${quote(placeholder)}`);
  const id = attr.get("id")?.trim();
  if (!name && id) parts.push(`id=${quote(id)}`);
  return parts.length ? `(${parts.join(", ")})` : undefined;
}

/** The nearest ancestor printed as a line: its role, and whether it has a ref. */
type Parent = { role: string; ref: boolean } | undefined;
/** A node line: `ref` when it carries one, `act` when it is something to act on (what --interactive lists). */
type Item =
  | { t: "text"; text: string }
  | { t: "break" }
  | { t: "node"; head: string; ref: boolean; act: boolean; url?: string; note: string; children: Item[] };
interface Tree {
  byId: Map<string, AXNode>;
  root: AXNode | undefined;
}

const str = (v: AXValue | undefined): string => (typeof v?.value === "string" ? v.value : typeof v?.value === "number" ? String(v.value) : "");
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

function buildTree(nodes: AXNode[]): Tree {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  return { byId, root: nodes.find((n) => n.parentId === undefined || !byId.has(n.parentId)) };
}

function prop(n: AXNode, name: string): unknown {
  return n.properties?.find((p) => p.name === name)?.value?.value;
}
const truthy = (v: unknown): boolean => v === true || v === "true" || (typeof v === "string" && v !== "" && v !== "false");

/** Adjacent text becomes one text item; a break or a node ends the run. */
function merge(items: Item[]): Item[] {
  const out: Item[] = [];
  let run = "";
  const flush = () => {
    const text = squash(run);
    if (text) out.push({ t: "text", text });
    run = "";
  };
  for (const it of items) {
    if (it.t === "text") run += it.text;
    else {
      flush();
      if (it.t === "node") out.push(it);
    }
  }
  flush();
  return out;
}

function states(n: AXNode): string[] {
  const out: string[] = [];
  const checked = prop(n, "checked");
  if (checked === "mixed") out.push("[checked=mixed]");
  else if (truthy(checked)) out.push("[checked]");
  if (truthy(prop(n, "disabled"))) out.push("[disabled]");
  const expanded = prop(n, "expanded");
  if (expanded !== undefined) out.push(`[expanded=${truthy(expanded)}]`);
  if (truthy(prop(n, "selected"))) out.push("[selected]");
  const pressed = prop(n, "pressed");
  if (pressed === "mixed") out.push("[pressed=mixed]");
  else if (truthy(pressed)) out.push("[pressed]");
  if (truthy(prop(n, "required"))) out.push("[required]");
  if (truthy(prop(n, "focused"))) out.push("[focused]");
  return out;
}

class Renderer {
  readonly refs: Record<string, number>;
  /** The refs that name a container only, never a control. */
  readonly containers: Set<string>;
  next: number;
  /** The form controls rendered, in document order, with the name each was shown with. */
  readonly controls: { id: number; name: string }[] = [];
  private readonly seen = new Set<AXNode>();
  private readonly trees = new Map<string, Tree>();

  constructor(
    table: RefTable,
    private readonly frames: Record<string, AXNode[]>,
    private readonly hints: Record<number, string> = {},
  ) {
    this.refs = { ...table.refs };
    this.containers = new Set(table.containers ?? []);
    this.next = table.next;
  }

  private refFor(backendId: number): string {
    for (const [k, v] of Object.entries(this.refs)) if (v === backendId) return k;
    const k = `e${this.next++}`;
    this.refs[k] = backendId;
    return k;
  }

  private frameTree(backendId: number): Tree | undefined {
    const key = String(backendId);
    const nodes = this.frames[key];
    if (!nodes) return undefined;
    let t = this.trees.get(key);
    if (!t) this.trees.set(key, (t = buildTree(nodes)));
    return t;
  }

  /** Find a node by backendDOMNodeId in the main tree, then in the frame trees. */
  find(main: Tree, backendId: number): { tree: Tree; node: AXNode } | undefined {
    for (const t of [main, ...Object.keys(this.frames).map((k) => this.frameTree(Number(k)) as Tree)]) {
      for (const n of t.byId.values()) if (n.backendDOMNodeId === backendId) return { tree: t, node: n };
    }
    return undefined;
  }

  children(tree: Tree, n: AXNode, parent: Parent): Item[] {
    const out: Item[] = [];
    for (const id of n.childIds ?? []) {
      const c = tree.byId.get(id);
      if (c) out.push(...this.collect(tree, c, parent));
    }
    return out;
  }

  collect(tree: Tree, n: AXNode, parent: Parent = undefined): Item[] {
    if (this.seen.has(n)) return [];
    this.seen.add(n);
    const role = str(n.role);
    if (n.ignored) return this.children(tree, n, parent);
    if (role === "InlineTextBox") return [];
    if (role === "LineBreak") return [{ t: "break" }];
    if (TEXT_ROLES.has(role)) {
      const boxes = (n.childIds ?? []).map((id) => str(tree.byId.get(id)?.name)).join("");
      return [{ t: "text", text: str(n.name) || boxes }];
    }
    if (HOISTED.has(role)) return this.children(tree, n, parent);

    const name = squash(str(n.name));
    const hasRole = REF_ROLES.has(role.toLowerCase());
    const acts = n.backendDOMNodeId !== undefined && (hasRole || truthy(prop(n, "focusable")) || truthy(prop(n, "editable")));
    const container = CONTAINER_ROLES.has(role) || (NAMED_CONTAINER_ROLES.has(role) && name !== "");
    const wantsRef = acts || (n.backendDOMNodeId !== undefined && container);
    // The editor inside a text field's user-agent shadow tree: the field's ref already acts on it.
    const editor = acts && !hasRole && !name && truthy(prop(n, "editable")) && parent?.ref === true && FIELD_ROLES.has(parent.role);
    if ((COLLAPSIBLE.has(role) && !name && !wantsRef) || editor) return [{ t: "break" }, ...this.children(tree, n, parent), { t: "break" }];

    const isFrame = role.toLowerCase() === "iframe";
    const shown = isFrame ? "iframe" : role;
    let head = `- ${shown}`;
    if (name) head += ` "${(name.length > NAME_MAX ? `${name.slice(0, NAME_MAX)}…` : name).replace(/"/g, '\\"')}"`;
    const level = prop(n, "level");
    if (level !== undefined && role === "heading") head += ` [level=${String(level)}]`;
    if (wantsRef) {
      const ref = this.refFor(n.backendDOMNodeId as number);
      if (acts) this.containers.delete(ref);
      else this.containers.add(ref);
      head += ` [ref=${ref}]`;
      const id = n.backendDOMNodeId as number;
      if (acts && HINT_ROLES.has(role)) this.controls.push({ id, name });
      const hint = this.hints[id];
      if (hint) head += ` ${hint}`;
    }
    for (const s of states(n)) head += ` ${s}`;

    let kids: Item[];
    let note = "";
    const inner = isFrame && n.backendDOMNodeId !== undefined ? this.frameTree(n.backendDOMNodeId) : undefined;
    if (isFrame) {
      if (inner?.root) kids = merge(this.collect(inner, inner.root, undefined));
      else {
        kids = [];
        note = " (cross-origin, not expanded)";
      }
    } else kids = merge(this.children(tree, n, { role, ref: wantsRef }));
    const value = VALUE_ROLES.has(role) ? squash(str(n.value)) : "";
    // The name is on the line already, and so is a field's value (the text of its editor).
    kids = kids.filter((k) => !(k.t === "text" && ((name && k.text === name) || (value && k.text === value))));

    const rawUrl = role === "link" ? prop(n, "url") : undefined;
    const url = typeof rawUrl === "string" ? rawUrl : "";
    return [
      { t: "node", head: value ? `${head}${note}: ${value}` : `${head}${note}`, ref: wantsRef, act: acts, ...(url ? { url } : {}), note, children: kids },
    ];
  }
}

interface Line {
  text: string;
  ref: boolean;
}

function nested(items: Item[], depth: number, out: Line[]): void {
  const pad = "  ".repeat(depth);
  for (const it of items) {
    if (it.t === "text") out.push({ text: `${pad}- text: ${it.text}`, ref: false });
    else if (it.t === "node") {
      out.push({ text: pad + it.head, ref: it.ref });
      if (it.url) out.push({ text: `${pad}  - /url: ${it.url}`, ref: false });
      nested(it.children, depth + 1, out);
    }
  }
}

function flat(items: Item[], out: Line[]): void {
  for (const it of items) {
    if (it.t !== "node") continue;
    if (it.act) out.push({ text: it.head, ref: true });
    flat(it.children, out);
  }
}

/**
 * Render AX nodes as a compact text tree (2 spaces per level, one node per line),
 * giving refs to what an agent can act on and to the structural containers. In
 * `interactive` mode only the nodes to act on are printed, flat; no landmark
 * context is added, to keep it cheap.
 */
export function renderSnapshot(nodes: AXNode[], opts: RenderOptions): RenderResult {
  const r = new Renderer(opts.refs, opts.frames ?? {}, opts.hints);
  const main = buildTree(nodes);
  const all: Line[] = [];
  let items: Item[] = [];
  if (opts.rootBackendId !== undefined) {
    const hit = r.find(main, opts.rootBackendId);
    if (hit) items = merge(r.collect(hit.tree, hit.node));
  } else {
    // Collected first, so the tree below finds them seen and leaves them out.
    for (const id of opts.overlays ?? []) {
      const hit = r.find(main, id);
      if (!hit) continue;
      const lines: Line[] = [];
      const over = merge(r.collect(hit.tree, hit.node));
      if (opts.interactive) flat(over, lines);
      else nested(over, 1, lines);
      if (lines.length === 0) continue;
      all.push({ text: OVERLAY_HEADER, ref: false }, ...(opts.interactive ? lines.map((l) => ({ ...l, text: `  ${l.text}` })) : lines));
    }
    if (main.root) items = merge(r.collect(main, main.root));
  }

  if (opts.interactive) flat(items, all);
  else nested(items, 0, all);

  let kept = all;
  let tail = "";
  if (opts.maxChars !== undefined) {
    let used = 0;
    let n = 0;
    for (const l of all) {
      const cost = l.text.length + (n > 0 ? 1 : 0);
      if (used + cost > opts.maxChars) break;
      used += cost;
      n++;
    }
    const hint = "use `snapshot <ref>` or --interactive";
    if (n === 0 && all.length > 0) {
      // One line over the whole budget (a JSON body on one line): show its start rather than nothing at all.
      const first = all[0] as Line;
      const text = `${first.text.slice(0, Math.max(0, opts.maxChars - 1))}…`;
      const ref = first.ref && /\[ref=e\d+\]/.test(text);
      const more = all.length - 1;
      kept = [{ text, ref }];
      tail = `… [truncated: the first line cut${more ? `, ${more} more line${more === 1 ? "" : "s"}` : ""} — ${hint}]`;
    } else if (n < all.length) {
      kept = all.slice(0, n);
      tail = `… [truncated: ${all.length - n} more lines — ${hint}]`;
    }
  }
  const text = [...kept.map((l) => l.text), ...(tail ? [tail] : [])].join("\n");
  return {
    text,
    refs: {
      loaderId: opts.refs.loaderId,
      url: opts.refs.url,
      next: r.next,
      refs: r.refs,
      ...(r.containers.size ? { containers: [...r.containers].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) } : {}),
    },
    truncated: tail !== "",
    refCount: kept.filter((l) => l.ref).length,
    unclear: unclearControls(r.controls),
  };
}

/** The controls with no name, or a name another control shares. */
function unclearControls(controls: { id: number; name: string }[]): number[] {
  const count = new Map<string, number>();
  for (const c of controls) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  return controls.filter((c) => c.name === "" || (count.get(c.name) ?? 0) > 1).map((c) => c.id);
}

/**
 * The hints of the unclear controls, HINT_MAX at most: one DOM.describeNode
 * each (attributes only, no page script runs), in parallel. A lookup that
 * fails leaves that control without one.
 */
async function lookupHints(page: CdpSession, ids: number[]): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  await Promise.all(
    ids.slice(0, HINT_MAX).map(async (backendNodeId) => {
      try {
        const { node } = await page.send<{ node?: { nodeName?: string; attributes?: string[] } }>("DOM.describeNode", { backendNodeId });
        const hint = fieldHint(node?.nodeName ?? "", node?.attributes ?? []);
        if (hint) out[backendNodeId] = hint;
      } catch {
        /* no hint for this one */
      }
    }),
  );
  return out;
}

// --- collector ----------------------------------------------------------------

export interface SnapshotOptions {
  interactive?: boolean;
  maxChars?: number;
  /** Render only this ref's subtree. */
  ref?: string;
  /** Render only the subtree of the first element this CSS selector matches. */
  selector?: string;
}

export interface SnapshotResult {
  text: string;
  url: string;
  title: string;
  loaderId: string;
  refCount: number;
  truncated: boolean;
}

interface FrameNode {
  frame: { id: string };
  childFrames?: FrameNode[];
}

function frameIds(t: FrameNode, into = new Set<string>()): Set<string> {
  into.add(t.frame.id);
  for (const c of t.childFrames ?? []) frameIds(c, into);
  return into;
}

/** Fetch the trees of the same-process iframes (breadth first, nested ones too). A failure leaves that frame unexpanded. */
async function collectFrames(session: BrowserSession, main: AXNode[]): Promise<Record<string, AXNode[]>> {
  const out: Record<string, AXNode[]> = {};
  let known: Set<string>;
  try {
    const { frameTree } = await session.page.send<{ frameTree: FrameNode }>("Page.getFrameTree");
    known = frameIds(frameTree);
  } catch {
    return out;
  }
  const queue = [main];
  let fetched = 0;
  for (let list = queue.shift(); list; list = queue.shift()) {
    for (const n of list) {
      if (n.ignored || n.backendDOMNodeId === undefined || str(n.role).toLowerCase() !== "iframe" || fetched >= FRAME_MAX) continue;
      try {
        const { node } = await session.page.send<{ node: { frameId?: string } }>("DOM.describeNode", { backendNodeId: n.backendDOMNodeId });
        if (!node.frameId || !known.has(node.frameId)) continue;
        const { nodes } = await session.page.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", { frameId: node.frameId });
        fetched++;
        out[String(n.backendDOMNodeId)] = nodes;
        queue.push(nodes);
      } catch {
        /* leave this iframe unexpanded */
      }
    }
  }
  return out;
}

/**
 * Snapshot the current tab and persist its ref table. Throws StaleRefError for
 * a ref that is not in it, NoMatchError for a selector that matches nothing.
 */
export async function takeSnapshot(session: BrowserSession, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  if (opts.ref !== undefined && opts.selector !== undefined) throw new UsageError("a snapshot is scoped to a ref or to a selector, not both");
  if (opts.ref !== undefined) checkRef(opts.ref);
  const loaderId = await session.loaderId();
  const url = await session.currentUrl();
  const title = await session.title();
  const saved = readRefs(session.targetId);
  const table: RefTable = saved && saved.loaderId === loaderId ? { ...saved, url } : { loaderId, url, next: 1, refs: {} };

  let rootBackendId: number | undefined;
  if (opts.ref !== undefined) {
    rootBackendId = Object.hasOwn(table.refs, opts.ref) ? table.refs[opts.ref] : undefined;
    if (rootBackendId === undefined) throw new StaleRefError(opts.ref);
  } else if (opts.selector !== undefined) rootBackendId = await elementBySelector(session.page, opts.selector);

  await session.page.send("Accessibility.enable");
  const fetchTree = async () => (await session.page.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {})).nodes;
  let nodes = await fetchTree();
  const overlays = rootBackendId === undefined ? await findOverlays(session.page) : [];
  // An overlay injected while the tree was taken may not be in it yet: one more look, a moment later.
  if (overlays.some((id) => !nodes.some((n) => n.backendDOMNodeId === id))) {
    await new Promise((r) => setTimeout(r, OVERLAY_RETRY_MS));
    nodes = await fetchTree();
  }
  const frames = await collectFrames(session, nodes);
  const hasRoot = rootBackendId === undefined || [nodes, ...Object.values(frames)].some((l) => l.some((n) => n.backendDOMNodeId === rootBackendId));
  if (!hasRoot) {
    if (opts.ref !== undefined) throw new StaleRefError(opts.ref);
    throw new Error(`the element ${opts.selector} matches is not in the accessibility tree: scope to an ancestor, or take the whole snapshot`);
  }

  const render = (hints?: Record<number, string>) =>
    renderSnapshot(nodes, {
      refs: table,
      frames,
      ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
      ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      ...(rootBackendId !== undefined ? { rootBackendId } : {}),
      ...(overlays.length ? { overlays } : {}),
      ...(hints ? { hints } : {}),
    });
  let r = render();
  // Rendered again, from the same table, once the unclear controls' hints are known: the same refs, with hints.
  if (r.unclear.length) {
    const hints = await lookupHints(session.page, r.unclear);
    if (Object.keys(hints).length) r = render(hints);
  }
  writeRefs(session.targetId, r.refs);
  return { text: `url: ${url}\ntitle: ${title}\n${r.text}`, url, title, loaderId, refCount: r.refCount, truncated: r.truncated };
}
