import type { BrowserSession } from "./session.js";
import { type RefTable, readRefs, writeRefs } from "./state.js";

// The accessibility snapshot: what the agent "sees" of a page.
//
// renderSnapshot is pure and deterministic: it turns the nodes of
// Accessibility.getFullAXTree into a compact text tree, one node per line,
// and hands out stable refs (`e<N>`, backed by the node's backendDOMNodeId) that
// later actions pass back. takeSnapshot fetches the tree from a live session
// and keeps the ref table on disk, so a ref survives from one CLI call to the next.

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
  /** Only nodes that have a ref, flat (no indentation, no text, no `/url` lines). */
  interactive?: boolean;
  /** Cut the tree at a line boundary once it is longer than this (a first line longer than all of it is cut itself). No limit by default. */
  maxChars?: number;
  /** Render only the subtree of this node. */
  rootBackendId?: number;
  /** The refs seen so far; never mutated, an updated copy is returned. */
  refs: RefTable;
  /** Same-process iframe trees, keyed by the iframe's backendDOMNodeId as a string. */
  frames?: Record<string, AXNode[]>;
}

export interface RenderResult {
  text: string;
  refs: RefTable;
  truncated: boolean;
  /** Refs visible in `text`. */
  refCount: number;
}

/** A ref the table does not know, or that belongs to a document that is gone. */
export class StaleRefError extends Error {
  constructor(readonly ref: string) {
    super(`ref ${JSON.stringify(ref)} is unknown or stale: take a new snapshot (refais un snapshot) and use the refs it returns`);
    this.name = "StaleRefError";
  }
}

const NAME_MAX = 120;
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
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
/** Fields whose editor (a node in the input's user-agent shadow tree) is the field itself, not a control of its own. */
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** The nearest ancestor printed as a line: its role, and whether it has a ref. */
type Parent = { role: string; ref: boolean } | undefined;
type Item = { t: "text"; text: string } | { t: "break" } | { t: "node"; head: string; ref: boolean; url?: string; note: string; children: Item[] };
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
  next: number;
  private readonly seen = new Set<AXNode>();
  private readonly trees = new Map<string, Tree>();

  constructor(
    table: RefTable,
    private readonly frames: Record<string, AXNode[]>,
  ) {
    this.refs = { ...table.refs };
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
    const wantsRef = n.backendDOMNodeId !== undefined && (hasRole || truthy(prop(n, "focusable")) || truthy(prop(n, "editable")));
    // The editor inside a text field's user-agent shadow tree: the field's ref already acts on it.
    const editor = wantsRef && !hasRole && !name && truthy(prop(n, "editable")) && parent?.ref === true && FIELD_ROLES.has(parent.role);
    if ((COLLAPSIBLE.has(role) && !name && !wantsRef) || editor) return [{ t: "break" }, ...this.children(tree, n, parent), { t: "break" }];

    const isFrame = role.toLowerCase() === "iframe";
    const shown = isFrame ? "iframe" : role;
    let head = `- ${shown}`;
    if (name) head += ` "${(name.length > NAME_MAX ? `${name.slice(0, NAME_MAX)}…` : name).replace(/"/g, '\\"')}"`;
    const level = prop(n, "level");
    if (level !== undefined && role === "heading") head += ` [level=${String(level)}]`;
    if (wantsRef) head += ` [ref=${this.refFor(n.backendDOMNodeId as number)}]`;
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
    return [{ t: "node", head: value ? `${head}${note}: ${value}` : `${head}${note}`, ref: wantsRef, ...(url ? { url } : {}), note, children: kids }];
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
    if (it.ref) out.push({ text: it.head, ref: true });
    flat(it.children, out);
  }
}

/**
 * Render AX nodes as a compact text tree (2 spaces per level, one node per line),
 * giving refs to what an agent can act on. In `interactive` mode only the nodes
 * with refs are printed, flat; no landmark context is added, to keep it cheap.
 */
export function renderSnapshot(nodes: AXNode[], opts: RenderOptions): RenderResult {
  const r = new Renderer(opts.refs, opts.frames ?? {});
  const main = buildTree(nodes);
  let items: Item[] = [];
  if (opts.rootBackendId !== undefined) {
    const hit = r.find(main, opts.rootBackendId);
    if (hit) items = merge(r.collect(hit.tree, hit.node));
  } else if (main.root) items = merge(r.collect(main, main.root));

  const all: Line[] = [];
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
    refs: { loaderId: opts.refs.loaderId, url: opts.refs.url, next: r.next, refs: r.refs },
    truncated: tail !== "",
    refCount: kept.filter((l) => l.ref).length,
  };
}

// --- collector ----------------------------------------------------------------

export interface SnapshotOptions {
  interactive?: boolean;
  maxChars?: number;
  /** Render only this ref's subtree. */
  ref?: string;
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

/** Snapshot the current tab and persist its ref table. Throws StaleRefError for a ref that is not in it. */
export async function takeSnapshot(session: BrowserSession, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  const loaderId = await session.loaderId();
  const url = await session.currentUrl();
  const title = await session.title();
  const saved = readRefs(session.targetId);
  const table: RefTable = saved && saved.loaderId === loaderId ? { ...saved, url } : { loaderId, url, next: 1, refs: {} };

  let rootBackendId: number | undefined;
  if (opts.ref !== undefined) {
    rootBackendId = Object.hasOwn(table.refs, opts.ref) ? table.refs[opts.ref] : undefined;
    if (rootBackendId === undefined) throw new StaleRefError(opts.ref);
  }

  await session.page.send("Accessibility.enable");
  const { nodes } = await session.page.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {});
  const frames = await collectFrames(session, nodes);
  const hasRoot = rootBackendId === undefined || [nodes, ...Object.values(frames)].some((l) => l.some((n) => n.backendDOMNodeId === rootBackendId));
  if (!hasRoot) throw new StaleRefError(opts.ref as string);

  const r = renderSnapshot(nodes, {
    refs: table,
    frames,
    ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
    ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
    ...(rootBackendId !== undefined ? { rootBackendId } : {}),
  });
  writeRefs(session.targetId, r.refs);
  return { text: `url: ${url}\ntitle: ${title}\n${r.text}`, url, title, loaderId, refCount: r.refCount, truncated: r.truncated };
}
