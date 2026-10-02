// What the agent does to a page: click, type, fill, select, press, upload,
// scroll, screenshot, evaluate, answer a dialog, move through history.
//
// Every target is a ref (`e12`) from the last accessibility snapshot, resolved
// to its backendDOMNodeId. A ref from a document that has since been replaced
// is refused as stale BEFORE anything else runs — the guard included — so the
// agent is told to look again rather than that its click was risky.
//
// Input is real input wherever it can be: a click is a mouse press and release
// at the centre of the element's box, after checking that the element, and not
// a cookie banner over it, is what sits under that point (a click that would
// land on an overlay is refused with the overlay's controls, for the agent to
// ask the user which one); typing is key events.
// Pages listen for those (and ignore `el.click()` or a bare `value =` more often
// than one would hope); fill keeps the native value setter only as a fallback.
//
// After each action that can change the page, the post-action settle (armed
// before the action, so a navigation it starts is not missed) waits for loads
// and a quiet network. A JavaScript dialog freezes the page: an action that
// opens one returns at once with the dialog in its result, never accepting it —
// the agent decides with handleDialog.

import { isAbsolute } from "node:path";
import { UsageError } from "../cli-kit.js";
import { CdpError, type CdpHandler, type CdpSession } from "./cdp.js";
import { type Challenge, detectChallenge } from "./challenge.js";
import { type BrowserDeps, browserDeps } from "./deps.js";
import { type KeySpec, keyEventsFor, keyName, parseKey } from "./keys.js";
import { DESCRIBE_SOURCE, overlayRootOf } from "./overlay.js";
import { guardAction, OWNER_SOURCE } from "./risk.js";
import type { NavigationResult } from "./session.js";
import { type AXNode, checkRef, elementBySelector, renderSnapshot, StaleRefError } from "./snapshot.js";
import { readRefs, writeRefs } from "./state.js";
import { armSettle, type SettleOptions, settle } from "./wait.js";

/** What the actions need of a session; BrowserSession is one. */
export interface ActionSession {
  /** The current tab's flat CDP session. */
  readonly page: CdpSession;
  readonly targetId: string;
  loaderId(): Promise<string>;
  currentUrl(): Promise<string>;
  title(): Promise<string>;
}

/** A session that can also move through the tab's history. */
export interface HistorySession extends ActionSession {
  back(opts?: { timeoutMs?: number }): Promise<NavigationResult>;
  forward(opts?: { timeoutMs?: number }): Promise<NavigationResult>;
  reload(opts?: { timeoutMs?: number }): Promise<NavigationResult>;
}

export interface DialogInfo {
  /** "alert", "confirm", "prompt" or "beforeunload". */
  type: string;
  message: string;
  /** The CLI dismissed it before its command ended: it is no longer open. */
  dismissed?: boolean;
  /** Someone closed it in the window before the CLI could dismiss it. */
  closed?: boolean;
}

export interface ActionResult {
  ok: true;
  action: string;
  ref?: string;
  /** The main frame loaded another document because of the action. */
  navigated: boolean;
  url: string;
  title: string;
  /** A dialog the action opened; it is still open. */
  dialog?: DialogInfo;
  /** An anti-bot challenge on the page after the action; null when none. */
  challenge?: Challenge | null;
  /** What the action yields: the value a field holds after fill or type, the options select chose, the scroll position. */
  value?: unknown;
  /** fill or type on a password field: its value is never echoed. */
  valueHidden?: true;
  /** The page the move landed on committed but was still loading when the wait ran out. */
  note?: string;
}

export interface ActionOptions {
  deps?: Partial<BrowserDeps>;
  /** How long the post-action settle may wait (5 s by default). */
  settleTimeoutMs?: number;
}

export type MouseButton = "left" | "right" | "middle";

export interface ClickOptions extends ActionOptions {
  /** The user said yes to this very click; skips the irreversibility guard. */
  confirm?: boolean;
  button?: MouseButton;
  clickCount?: 1 | 2;
}

export interface TypeOptions extends ActionOptions {
  /** Press Enter after the text. */
  submit?: boolean;
  /** The user said yes to the Enter this sends (a newline in the text, or `submit`). */
  confirm?: boolean;
}

export interface PressOptions extends ActionOptions {
  confirm?: boolean;
}

export interface HistoryOptions extends ActionOptions {
  /** How long the history move may take to load (30 s by default). */
  timeoutMs?: number;
}

export interface ScreenshotOptions {
  /** Only this element, clipped to its box. */
  ref?: string;
  /** Only the first element this CSS selector matches, clipped to its box. */
  selector?: string;
  /** The whole page, beyond the viewport. */
  full?: boolean;
  format?: "png" | "jpeg";
  /** JPEG quality, 0-100. */
  quality?: number;
}

/** The action could not be done on this page as it is: hidden, covered, the wrong kind of element. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

// --- page functions ----------------------------------------------------------
//
// Run with `this` the target element. They are strings (src has no DOM lib) and
// named, so a test can tell them apart. Keep `${` out of them.

/** `<div#id role="dialog"> "Its text"`: an element as the agent can recognise it in a snapshot. */
const DESCRIBE = DESCRIBE_SOURCE;

export const PAGE_FUNCTIONS = {
  /**
   * Where `hit` (the node under the click point) is: true when it stands for the
   * target itself (its own text, its user-agent shadow tree: see OWNER_SOURCE), null
   * when it is inside the target (a button in a card, which the guard then looks
   * at), else a description of what covers the target.
   */
  hitTest: `function hitTest(hit) {
  ${DESCRIBE}
  const owner = ${OWNER_SOURCE};
  const el = hit ? owner(hit) : null;
  if (el === this) return true;
  for (let n = hit; n; n = n.parentNode || n.host) if (n === this) return null;
  if (!el) return "nothing";
  // A target inside a frame: the top document's hit test stops at the frame element.
  if (el.ownerDocument !== this.ownerDocument && /^i?frame$/i.test(el.tagName)) return null;
  return describe(el);
}`,
  /** What fill can do with the element: a field, a contenteditable, or nothing (with a hint at the right action). */
  fieldKind: `function fieldKind() {
  ${DESCRIBE}
  const tag = String(this.tagName || "").toLowerCase();
  if (tag === "textarea") return { kind: "field" };
  if (tag === "input") {
    const type = String(this.type || "text").toLowerCase();
    if (type === "file") return { kind: "other", what: describe(this), hint: "use upload" };
    if (["checkbox", "radio", "submit", "button", "reset", "image", "range", "color", "hidden"].includes(type)) return { kind: "other", what: describe(this), hint: "click it" };
    return { kind: "field", secret: type === "password" };
  }
  if (tag === "select") return { kind: "other", what: describe(this), hint: "use select" };
  if (this.isContentEditable) return { kind: "editable" };
  return { kind: "other", what: describe(this), hint: "" };
}`,
  /** Select the current content, so that inserted text replaces it. */
  selectAll: `function selectAll(kind) {
  if (kind === "editable") {
    const range = document.createRange();
    range.selectNodeContents(this);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else if (typeof this.select === "function") this.select();
}`,
  readValue: `function readValue(kind) {
  return kind === "editable" ? this.innerText : this.value;
}`,
  /**
   * The fallback for controlled inputs (React and the like keep their own copy of
   * the value and hear the prototype's setter, not an assignment on the element).
   */
  setValue: `function setValue(value, kind) {
  if (kind === "editable") {
    this.textContent = value;
    this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  } else {
    const proto = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(this, value);
    else this.value = value;
    this.dispatchEvent(new Event("input", { bubbles: true }));
  }
  this.dispatchEvent(new Event("change", { bubbles: true }));
}`,
  /** Option indexes for the values, by value, then by visible label (exact, then without case); or why not. */
  matchOptions: `function matchOptions(values) {
  ${DESCRIBE}
  if (String(this.tagName || "").toUpperCase() !== "SELECT") return { error: "not-select", what: describe(this) };
  const squash = (s) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim();
  const label = (o) => squash(o.label || o.text);
  const opts = Array.from(this.options);
  const picked = [];
  const missing = [];
  for (const v of values) {
    let i = opts.findIndex((o) => o.value === v);
    if (i < 0) i = opts.findIndex((o) => label(o) === squash(v));
    if (i < 0) i = opts.findIndex((o) => label(o).toLowerCase() === squash(v).toLowerCase());
    if (i < 0) missing.push(v);
    else if (!picked.includes(i)) picked.push(i);
  }
  if (missing.length > 0) return { error: "missing", missing, options: opts.slice(0, 20).map((o) => ({ value: o.value, label: label(o) })), total: opts.length };
  if (picked.length > 1 && !this.multiple) return { error: "single" };
  return { picked };
}`,
  applyOptions: `function applyOptions(picked) {
  const opts = Array.from(this.options);
  if (this.multiple) opts.forEach((o, i) => { o.selected = picked.includes(i); });
  else this.selectedIndex = picked[0];
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return picked.map((i) => opts[i].value);
}`,
  fileInput: `function fileInput() {
  ${DESCRIBE}
  const ok = String(this.tagName || "").toUpperCase() === "INPUT" && String(this.type || "").toLowerCase() === "file";
  return { ok, multiple: !!this.multiple, what: describe(this) };
}`,
} as const;

// --- refs --------------------------------------------------------------------

/** A ref resolved in the live page. The caller owns `objectId` and releases it. */
export interface ResolvedRef {
  ref: string;
  backendNodeId: number;
  objectId: string;
}

/**
 * Turn a ref into the node it names. What is not shaped like a ref (a CSS
 * selector) is a UsageError, before anything is asked. Stale (StaleRefError)
 * when the ref is not in the tab's table, when the table belongs to a document
 * the tab has since left, or when the node is gone from the document. A
 * transport failure is not staleness and goes through unchanged.
 */
export async function resolveRef(session: ActionSession, ref: string): Promise<ResolvedRef> {
  checkRef(ref);
  const table = readRefs(session.targetId);
  const backendNodeId = table && Object.hasOwn(table.refs, ref) ? table.refs[ref] : undefined;
  if (!table || backendNodeId === undefined) throw new StaleRefError(ref);
  if (table.loaderId !== (await session.loaderId())) throw new StaleRefError(ref);
  let objectId: string | undefined;
  try {
    ({
      object: { objectId },
    } = await session.page.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId }));
  } catch (e) {
    if (e instanceof CdpError) throw new StaleRefError(ref);
    throw e;
  }
  if (!objectId) throw new StaleRefError(ref);
  return { ref, backendNodeId, objectId };
}

/**
 * Not awaited: a page frozen by a dialog would hold the answer back until the
 * dialog is closed, and a leaked handle costs nothing next to a hung action.
 */
function release(page: CdpSession, objectId: string): void {
  page.send("Runtime.releaseObject", { objectId }).catch(() => {});
}

async function withRef<T>(session: ActionSession, ref: string, fn: (node: ResolvedRef) => Promise<T>): Promise<T> {
  const node = await resolveRef(session, ref);
  try {
    return await fn(node);
  } finally {
    release(session.page, node.objectId);
  }
}

type ExceptionDetails = { text?: string; exception?: { description?: string; value?: unknown } };
type RemoteObject = { type?: string; subtype?: string; value?: unknown; unserializableValue?: string; description?: string };

const exceptionText = (d: ExceptionDetails): string =>
  d.exception?.description?.split("\n")[0] ?? (d.exception?.value !== undefined ? String(d.exception.value) : undefined) ?? d.text ?? "page error";

/** Run a page function on an element and return its result by value. */
async function callOn<T>(page: CdpSession, objectId: string, fn: string, args: { value?: unknown; objectId?: string }[] = []): Promise<T> {
  const r = await page.send<{ result?: RemoteObject; exceptionDetails?: ExceptionDetails }>("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new ActionError(`the page threw: ${exceptionText(r.exceptionDetails)}`);
  return r.result?.value as T;
}

const an = (what: string): string => (/^<[aeiou]/i.test(what) ? "an" : "a");

// --- perform: settle, dialogs, result ----------------------------------------

interface Performed {
  navigated: boolean;
  dialog?: DialogInfo;
  /** The url of the frame that opened the dialog, from the event: known without asking the frozen page. */
  dialogUrl?: string;
  value?: unknown;
  valueHidden?: true;
  note?: string;
}

function watchDialogs(page: CdpSession) {
  let seen: DialogInfo | undefined;
  let url: string | undefined;
  let wake: (v: null) => void = () => {};
  const opened = new Promise<null>((resolve) => {
    wake = resolve;
  });
  const handler: CdpHandler = (p) => {
    if (!seen) {
      seen = { type: String(p?.type ?? "alert"), message: String(p?.message ?? "") };
      if (typeof p?.url === "string") url = p.url;
    }
    wake(null);
  };
  page.on("Page.javascriptDialogOpening", handler);
  return {
    opened,
    seen: () => seen,
    url: () => url,
    stop: () => page.off("Page.javascriptDialogOpening", handler),
  };
}

const settleOpts = (opts: ActionOptions): SettleOptions => ({
  ...(opts.deps ? { deps: opts.deps } : {}),
  ...(opts.settleTimeoutMs !== undefined ? { timeoutMs: opts.settleTimeoutMs } : {}),
});

/** What a send from an act that was cut short meets: nothing more of it reaches the page. */
class CutShortError extends Error {}

/** The page, as an act sees it: once `stopped`, every send is refused instead of sent. */
function stoppable(page: CdpSession, stopped: () => boolean): CdpSession {
  return {
    sessionId: page.sessionId,
    send: <T>(method: string, params?: object, o?: { timeoutMs?: number }): Promise<T> =>
      stopped() ? Promise.reject(new CutShortError(`${method} not sent: the action was cut short`)) : page.send<T>(method, params, o),
    on: (m, h) => page.on(m, h),
    off: (m, h) => page.off(m, h),
    once: (m, o) => page.once(m, o),
  };
}

/**
 * Run the action between arming the settle and awaiting it. A dialog that opens
 * while the action runs ends the wait at once: the page is frozen, and the
 * command that opened it (a mouse release, an evaluate) only answers once the
 * dialog is closed. The act is handed a page that refuses every send from then
 * on, so the rest of it (the next keys, a second click) does not run once the
 * dialog is answered, in the middle of whatever the agent does next.
 */
async function perform(session: ActionSession, opts: ActionOptions, act: (page: CdpSession) => Promise<unknown>): Promise<Performed> {
  const dialogs = watchDialogs(session.page);
  let stopped = false;
  try {
    const armed = await armSettle(session, settleOpts(opts));
    try {
      const running = act(stoppable(session.page, () => stopped));
      running.catch(() => {}); // outrun by a dialog, its failure no longer matters
      const first = await Promise.race([running.then((value) => ({ value })), dialogs.opened]);
      if (!first) {
        const url = dialogs.url();
        return { navigated: false, dialog: dialogs.seen() as DialogInfo, ...(url !== undefined ? { dialogUrl: url } : {}) };
      }
      const { navigated } = await armed.done();
      const dialog = dialogs.seen();
      const url = dialogs.url();
      return { navigated, ...(dialog ? { dialog } : {}), ...(url !== undefined ? { dialogUrl: url } : {}), value: first.value };
    } finally {
      stopped = true;
      armed.cancel();
    }
  } finally {
    dialogs.stop();
  }
}

const TARGET_INFO_TIMEOUT_MS = 2000;

/**
 * Where the tab is. Behind a dialog the renderer answers nothing (Page.getFrameTree
 * would wait out its timeout), so the url and title come from the browser side:
 * Target.getTargetInfo, else the dialog's own url and the session's title.
 */
async function whereIs(session: ActionSession, p: Performed): Promise<{ url: string; title: string }> {
  if (!p.dialog) return { url: await session.currentUrl(), title: await session.title() };
  try {
    const { targetInfo } = await session.page.send<{ targetInfo?: { url?: string; title?: string } }>(
      "Target.getTargetInfo",
      { targetId: session.targetId },
      { timeoutMs: TARGET_INFO_TIMEOUT_MS },
    );
    if (targetInfo?.url !== undefined) return { url: targetInfo.url, title: targetInfo.title ?? "" };
  } catch {
    /* not answered on this session: fall back */
  }
  return { url: p.dialogUrl ?? "", title: await session.title().catch(() => "") };
}

async function finish(session: ActionSession, action: string, ref: string | undefined, p: Performed): Promise<ActionResult> {
  const { url, title } = await whereIs(session, p);
  // A dialog freezes the page: a probe would hang until it is answered.
  const challenge = p.dialog ? null : await detectChallenge(session);
  return {
    ok: true,
    action,
    ...(ref !== undefined ? { ref } : {}),
    navigated: p.navigated,
    url,
    title,
    ...(p.dialog ? { dialog: p.dialog } : {}),
    challenge,
    ...(p.value !== undefined ? { value: p.value } : {}),
    ...(p.valueHidden ? { valueHidden: true } : {}),
    ...(p.note ? { note: p.note } : {}),
  };
}

// --- geometry ----------------------------------------------------------------

type Quad = number[];

const area = (q: Quad): number => {
  let s = 0;
  for (let i = 0; i < 4; i++) s += (q[i * 2] as number) * (q[((i + 1) % 4) * 2 + 1] as number) - (q[((i + 1) % 4) * 2] as number) * (q[i * 2 + 1] as number);
  return Math.abs(s) / 2;
};

/** Scroll the element into view and return its boxes on screen (viewport coordinates); none → not visible. */
async function visibleQuads(page: CdpSession, node: { ref: string; backendNodeId: number }): Promise<Quad[]> {
  await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
  let quads: Quad[] = [];
  try {
    quads = (await page.send<{ quads?: Quad[] }>("DOM.getContentQuads", { backendNodeId: node.backendNodeId })).quads ?? [];
  } catch (e) {
    // "Could not compute content quads": display:none, or not rendered at all.
    if (!(e instanceof CdpError)) throw e;
  }
  const shown = quads.filter((q) => q.length === 8 && area(q) > 0);
  if (shown.length === 0) throw new ActionError(`${node.ref}: element is not visible (it has no box on the page)`);
  return shown;
}

/** In whole pixels: DOM.getNodeForLocation refuses a fractional point, and the mouse must land where the hit test looked. */
async function centreOf(page: CdpSession, node: ResolvedRef): Promise<{ x: number; y: number }> {
  const q = (await visibleQuads(page, node))[0] as Quad;
  return {
    x: Math.round(((q[0] as number) + (q[2] as number) + (q[4] as number) + (q[6] as number)) / 4),
    y: Math.round(((q[1] as number) + (q[3] as number) + (q[5] as number) + (q[7] as number)) / 4),
  };
}

/** How many of an overlay's controls a refused click lists. */
const OVERLAY_CONTROLS_MAX = 12;

/**
 * Why a click was refused when `hitObjectId` (what it would land on) is not the
 * target. What covers it is named, and its controls are listed with refs from
 * the tab's own table, saved, so the next command can use them. When it is an
 * overlay (a cookie wall, a dialog), which one to press — accepting tracking,
 * refusing it, closing — is the user's; a sticky header is only in the way.
 */
async function coveredError(page: CdpSession, targetId: string, ref: string, hitObjectId: string, where: string, at: string): Promise<ActionError> {
  const root = await overlayRootOf(page, hitObjectId);
  if (!root) return new ActionError(`${ref} is covered by ${where} at ${at}: close or move it out of the way, then retry`);
  let controls: string[] = [];
  try {
    const table = readRefs(targetId);
    if (table) {
      await page.send("Accessibility.enable");
      const { nodes = [] } = await page.send<{ nodes?: AXNode[] }>("Accessibility.getFullAXTree", {});
      const r = renderSnapshot(nodes, { refs: table, rootBackendId: root.backendNodeId, interactive: true });
      writeRefs(targetId, r.refs);
      controls = r.text ? r.text.split("\n") : [];
    }
  } catch {
    /* named without its controls */
  }
  const shown = controls.slice(0, OVERLAY_CONTROLS_MAX);
  const more = controls.length - shown.length;
  const listed = ["its controls:", ...shown, ...(more > 0 ? [`… ${more} more — take a snapshot to see them`] : [])].join("\n");
  // Only a real overlay (a cookie wall, a dialog) is a choice to put to the user; a sticky header or a chat bubble is only in the way.
  if (!root.overlay)
    return new ActionError(`${ref} is covered by ${root.what} at ${at}: close or move it out of the way, then retry${shown.length ? `; ${listed}` : ""}`);
  const list = shown.length ? listed : "none of its controls is in the accessibility tree — take a snapshot";
  return new ActionError(
    `${ref} is covered by an overlay (${root.what}) at ${at}; ${list}\naccepting tracking/consent or closing it is the user's choice — ask before choosing`,
  );
}

/**
 * Throw unless a click at x,y lands on the element or inside it. Returns the
 * node it lands on when that is a descendant (a button inside a card): the
 * control the click really activates, for the guard to look at.
 */
async function hitTarget(page: CdpSession, targetId: string, node: ResolvedRef, x: number, y: number): Promise<number | undefined> {
  const at = `(${Math.round(x)}, ${Math.round(y)})`;
  const unreachable = () =>
    new ActionError(`${node.ref} is not reachable at its centre ${at}: the browser finds nothing there to click; scroll, or take a new snapshot`);
  /** A CDP error answer here means "no node there" or "that node is gone": unreachable. Transport errors go through. */
  const ask = async <T>(method: string, params: object): Promise<T> => {
    try {
      return await page.send<T>(method, params);
    } catch (e) {
      throw e instanceof CdpError ? unreachable() : e;
    }
  };
  // The box (and the mouse) are in viewport coordinates; DOM.getNodeForLocation takes the document's.
  const m = await page.send<LayoutMetrics>("Page.getLayoutMetrics");
  const vp = m.cssLayoutViewport ?? m.layoutViewport ?? { pageX: 0, pageY: 0 };
  const point = { x: Math.round(x + vp.pageX), y: Math.round(y + vp.pageY), includeUserAgentShadowDOM: true };
  const hit = (await ask<{ backendNodeId?: number }>("DOM.getNodeForLocation", point)).backendNodeId;
  if (hit === undefined) throw unreachable();
  if (hit === node.backendNodeId) return undefined;
  const objectId = (await ask<{ object?: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: hit })).object?.objectId;
  if (!objectId) throw unreachable();
  try {
    const where = await callOn<string | true | null>(page, node.objectId, PAGE_FUNCTIONS.hitTest, [{ objectId }]);
    // The target itself, reached through its own text or user-agent shadow tree: its guard has run already.
    if (where === true) return undefined;
    if (where) throw await coveredError(page, targetId, node.ref, objectId, where, at);
  } finally {
    release(page, objectId);
  }
  return hit;
}

// --- actions -----------------------------------------------------------------

const BUTTONS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

/**
 * Click like a person: scroll the element into view, aim at the centre of its
 * first box, check nothing covers it there, then move, press and release the
 * mouse. Refused by the irreversibility guard unless `confirm`.
 */
export async function click(session: ActionSession, ref: string, opts: ClickOptions = {}): Promise<ActionResult> {
  const button = opts.button ?? "left";
  const count = opts.clickCount ?? 1;
  if (!(button in BUTTONS)) throw new UsageError(`unknown mouse button "${button}" — use left, right or middle`);
  if (count !== 1 && count !== 2) throw new UsageError(`clickCount is 1 or 2, not ${count}`);
  const page = session.page;
  return withRef(session, ref, async (node) => {
    await guardAction(page, { backendNodeId: node.backendNodeId, action: "click", ...(opts.confirm ? { confirm: true } : {}) });
    const { x, y } = await centreOf(page, node);
    // The ref may name a container (a card, a row) whose centre is a "Delete" button: that button is what acts.
    const inner = await hitTarget(page, session.targetId, node, x, y);
    if (inner !== undefined && !opts.confirm) await guardAction(page, { backendNodeId: inner, action: "click" });
    const p = await perform(session, opts, async (pg) => {
      await pg.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
      for (let n = 1; n <= count; n++) {
        await pg.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: BUTTONS[button], clickCount: n });
        await pg.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: n });
      }
    });
    return finish(session, "click", ref, p);
  });
}

/** Move the mouse over the element (menus that open on hover). */
export async function hover(session: ActionSession, ref: string, opts: ActionOptions = {}): Promise<ActionResult> {
  const page = session.page;
  return withRef(session, ref, async (node) => {
    const { x, y } = await centreOf(page, node);
    const p = await perform(session, opts, (pg) => pg.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 }));
    return finish(session, "hover", ref, p);
  });
}

async function dispatchKeys(page: CdpSession, spec: KeySpec): Promise<void> {
  for (const e of keyEventsFor(spec)) await page.send("Input.dispatchKeyEvent", e);
}

type FieldKind = { kind: "field" | "editable" | "other"; what?: string; hint?: string; secret?: boolean };

/** The element as a text field, or an ActionError pointing at the action that fits it. */
async function textField(page: CdpSession, node: ResolvedRef): Promise<FieldKind & { kind: "field" | "editable" }> {
  const field = await callOn<FieldKind>(page, node.objectId, PAGE_FUNCTIONS.fieldKind);
  if (field.kind === "other") {
    const what = field.what ?? "element";
    throw new ActionError(`${node.ref} is ${an(what)} ${what}, not a text field${field.hint ? `: ${field.hint}` : ""}`);
  }
  return field as FieldKind & { kind: "field" | "editable" };
}

/**
 * Focus a text field and type the text key by key, for fields that react to each
 * keystroke (autocomplete, masks). Only text fields: Space on a focused button
 * would click it. A newline is Enter, and so is `submit` after the text: the
 * guard sees it before anything is typed, and again right before each Enter —
 * and each Space after a Tab — since a Tab moves focus to another control.
 */
export async function typeText(session: ActionSession, ref: string, text: string, opts: TypeOptions = {}): Promise<ActionResult> {
  const chars = [...text.replace(/\r\n?/g, "\n")];
  const page = session.page;
  const confirm = opts.confirm ? { confirm: true } : {};
  return withRef(session, ref, async (node) => {
    const field = await textField(page, node);
    await page.send("DOM.focus", { backendNodeId: node.backendNodeId });
    if (opts.submit || chars.includes("\n")) await guardAction(page, { action: "press", key: "Enter", ...confirm });
    const p = await perform(session, opts, async (pg) => {
      let tabbed = false;
      const type = async (spec: KeySpec) => {
        if (spec.key === "Enter" || (tabbed && spec.key === " ")) await guardAction(pg, { action: "press", key: keyName(spec), ...confirm });
        if (spec.key === "Tab") tabbed = true;
        await dispatchKeys(pg, spec);
      };
      for (const c of chars) await type(parseKey(c));
      if (opts.submit) await type(parseKey("Enter"));
    });
    return finish(session, "type", ref, { ...p, ...(await echo(page, node, field, p)) });
  });
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const alnum = (s: string): string =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/** The field holds the text: exactly, or as the page reformatted it (a mask adding spaces, a contenteditable's trailing newline). */
function holds(actual: unknown, want: string): boolean {
  if (typeof actual !== "string") return false;
  if (actual === want || squash(actual) === squash(want)) return true;
  const a = alnum(want);
  return a !== "" && alnum(actual) === a;
}

/**
 * What a text field holds after fill or type, to echo: never a password's, and
 * nothing when it cannot be read any more (an Enter that left the page, a dialog).
 */
async function echo(page: CdpSession, node: ResolvedRef, field: FieldKind, p: Performed): Promise<{ value?: unknown; valueHidden?: true }> {
  if (field.secret) return { valueHidden: true };
  if (p.dialog || p.navigated) return {};
  try {
    const value = await callOn<unknown>(page, node.objectId, PAGE_FUNCTIONS.readValue, [{ value: field.kind }]);
    return typeof value === "string" ? { value } : {};
  } catch {
    return {};
  }
}

/**
 * Replace the content of a text field (input, textarea, contenteditable) with
 * `text` in one insertion, as a paste would. If the value does not take — a
 * controlled input that did not hear it — set it through the native setter and
 * fire input and change. Throws if the field still holds something else.
 */
export async function fill(session: ActionSession, ref: string, text: string, opts: ActionOptions = {}): Promise<ActionResult> {
  const page = session.page;
  return withRef(session, ref, async (node) => {
    const field = await textField(page, node);
    const kind = { value: field.kind };
    const p = await perform(session, opts, async (pg) => {
      const read = () => callOn<unknown>(pg, node.objectId, PAGE_FUNCTIONS.readValue, [kind]);
      await pg.send("DOM.focus", { backendNodeId: node.backendNodeId });
      await callOn(pg, node.objectId, PAGE_FUNCTIONS.selectAll, [kind]);
      if (text === "") await dispatchKeys(pg, parseKey("Delete"));
      else await pg.send("Input.insertText", { text });
      const first = await read();
      if (holds(first, text)) return first;
      await callOn(pg, node.objectId, PAGE_FUNCTIONS.setValue, [{ value: text }, kind]);
      const now = await read();
      if (holds(now, text)) return now;
      const shown = field.secret ? "something else" : JSON.stringify(typeof now === "string" && now.length > 80 ? `${now.slice(0, 77)}...` : now);
      throw new ActionError(`could not fill ${ref}: it holds ${shown} (an input mask, a maxlength or a script rewrites it); try typeText`);
    });
    // The value the field ended with (a mask may have reformatted it); never a password's.
    return finish(session, "fill", ref, field.secret ? { ...p, value: undefined, valueHidden: true } : p);
  });
}

type Match = {
  error?: "not-select" | "missing" | "single";
  what?: string;
  missing?: string[];
  options?: { value: string; label: string }[];
  total?: number;
  picked?: number[];
};

/**
 * Choose options of a native `<select>` by value or visible label, then fire
 * input and change. A custom dropdown is not a select: click it, then the option.
 */
export async function select(session: ActionSession, ref: string, values: string[], opts: ActionOptions = {}): Promise<ActionResult> {
  if (values.length === 0) throw new UsageError("select needs at least one value (an option's value or its visible label)");
  const page = session.page;
  return withRef(session, ref, async (node) => {
    const m = await callOn<Match>(page, node.objectId, PAGE_FUNCTIONS.matchOptions, [{ value: values }]);
    if (m.error === "not-select") {
      const what = m.what ?? "element";
      throw new ActionError(`${ref} is ${an(what)} ${what}, not a <select>: click it, then click the option you want in a new snapshot`);
    }
    if (m.error === "missing") {
      const listed = (m.options ?? []).map((o) => `${JSON.stringify(o.value)} (${o.label})`);
      const more = (m.total ?? 0) - listed.length;
      const missing = (m.missing ?? []).map((v) => JSON.stringify(v)).join(", ");
      throw new ActionError(`no option ${missing} in ${ref}; options: ${listed.join(", ")}${more > 0 ? `, … and ${more} more` : ""}`);
    }
    if (m.error === "single") throw new ActionError(`${ref} takes one value, not ${values.length}`);
    const p = await perform(session, opts, (pg) => callOn<string[]>(pg, node.objectId, PAGE_FUNCTIONS.applyOptions, [{ value: m.picked ?? [] }]));
    return finish(session, "select", ref, p);
  });
}

/**
 * Press a key (or a chord: "Control+A") on whatever has focus. Enter goes
 * through the guard: in a form it submits.
 */
export async function press(session: ActionSession, key: string, opts: PressOptions = {}): Promise<ActionResult> {
  const spec = parseKey(key);
  const page = session.page;
  await guardAction(page, { action: "press", key: keyName(spec), ...(opts.confirm ? { confirm: true } : {}) });
  const p = await perform(session, opts, (pg) => dispatchKeys(pg, spec));
  return finish(session, "press", undefined, p);
}

/**
 * Put files on an `<input type="file">`. The paths must be absolute and exist.
 * The page may read the files and clear the input at once, so its `files` is
 * not checked afterwards: snapshot again to see what the page made of them.
 */
export async function upload(session: ActionSession, ref: string, files: string[], opts: ActionOptions = {}): Promise<ActionResult> {
  if (files.length === 0) throw new UsageError("upload needs at least one file");
  const { fs } = browserDeps(opts.deps);
  for (const f of files) {
    if (!isAbsolute(f)) throw new UsageError(`upload takes absolute paths, not ${JSON.stringify(f)}`);
    let st: { isFile(): boolean };
    try {
      st = await fs.stat(f);
    } catch (e) {
      throw new UsageError((e as NodeJS.ErrnoException).code === "ENOENT" ? `no such file: ${f}` : `cannot read ${f}: ${(e as Error).message}`);
    }
    if (!st.isFile()) throw new UsageError(`not a file: ${f}`);
  }
  const page = session.page;
  return withRef(session, ref, async (node) => {
    const input = await callOn<{ ok: boolean; multiple: boolean; what: string }>(page, node.objectId, PAGE_FUNCTIONS.fileInput);
    if (!input.ok) {
      throw new ActionError(
        `${ref} is ${an(input.what)} ${input.what}, not an <input type="file">: look in the snapshot for the file input itself (often next to or inside this control)`,
      );
    }
    if (files.length > 1 && !input.multiple) throw new ActionError(`${ref} takes one file, not ${files.length}`);
    const p = await perform(session, opts, (pg) => pg.send("DOM.setFileInputFiles", { files, backendNodeId: node.backendNodeId }));
    return finish(session, "upload", ref, { ...p, value: { files: files.length } });
  });
}

const POSITION = "({ x: Math.round(scrollX), y: Math.round(scrollY) })";
const SCROLLS: Record<string, string> = {
  down: 'scrollBy({ top: Math.round(innerHeight * 0.8), behavior: "instant" })',
  up: 'scrollBy({ top: -Math.round(innerHeight * 0.8), behavior: "instant" })',
  top: 'scrollTo({ top: 0, behavior: "instant" })',
  bottom: 'scrollTo({ top: (document.scrollingElement || document.documentElement).scrollHeight, behavior: "instant" })',
};

async function evalValue(page: CdpSession, expression: string): Promise<unknown> {
  const r = await page.send<{ result?: RemoteObject; exceptionDetails?: ExceptionDetails }>("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new ActionError(`the page threw: ${exceptionText(r.exceptionDetails)}`);
  return r.result?.value;
}

/** Scroll the window ("up"/"down" by most of a screen, "top", "bottom") or a ref into view. The value is the window's scroll position. */
export async function scroll(session: ActionSession, target: string, opts: ActionOptions = {}): Promise<ActionResult> {
  const how = SCROLLS[target];
  if (how) {
    const p = await perform(session, opts, (pg) => evalValue(pg, `(() => { ${how}; return ${POSITION}; })()`));
    return finish(session, "scroll", undefined, p);
  }
  if (!/^e\d+$/.test(target)) throw new UsageError(`scroll takes a ref (e12) or one of up, down, top, bottom — not ${JSON.stringify(target)}`);
  return withRef(session, target, async (node) => {
    const p = await perform(session, opts, async (pg) => {
      await pg.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
      return evalValue(pg, POSITION);
    });
    return finish(session, "scroll", target, p);
  });
}

type Rect = { x: number; y: number; width: number; height: number };
type LayoutMetrics = {
  cssLayoutViewport?: { pageX: number; pageY: number; clientWidth?: number; clientHeight?: number };
  layoutViewport?: { pageX: number; pageY: number; clientWidth?: number; clientHeight?: number };
  cssContentSize?: Rect;
  contentSize?: Rect;
};

/**
 * Capture the viewport, one element (clipped to its box), or the full page.
 * Not an action: nothing on the page changes, so there is no settle.
 */
export async function screenshot(session: ActionSession, opts: ScreenshotOptions = {}): Promise<Buffer> {
  if (opts.ref !== undefined && opts.selector !== undefined) throw new UsageError("a screenshot is of the element a ref or a --selector names, not both");
  if ((opts.ref !== undefined || opts.selector !== undefined) && opts.full)
    throw new UsageError("a screenshot is of one element (a ref or a --selector) or of the full page, not both");
  if (opts.ref !== undefined) checkRef(opts.ref);
  const format = opts.format ?? "png";
  if (format !== "png" && format !== "jpeg") throw new UsageError(`screenshot format is png or jpeg, not ${JSON.stringify(format)}`);
  if (opts.quality !== undefined && !(Number.isInteger(opts.quality) && opts.quality >= 0 && opts.quality <= 100))
    throw new UsageError(`screenshot quality is a whole number from 0 to 100, not ${opts.quality}`);
  const page = session.page;
  const params: Record<string, unknown> = { format, ...(format === "jpeg" && opts.quality !== undefined ? { quality: opts.quality } : {}) };
  if (opts.ref !== undefined || opts.selector !== undefined) {
    const quads =
      opts.ref !== undefined
        ? await withRef(session, opts.ref, (node) => visibleQuads(page, node))
        : await visibleQuads(page, { ref: opts.selector as string, backendNodeId: await elementBySelector(page, opts.selector as string) });
    const xs = quads.flatMap((q) => q.filter((_, i) => i % 2 === 0));
    const ys = quads.flatMap((q) => q.filter((_, i) => i % 2 === 1));
    // Quads are in viewport coordinates, the clip in page coordinates.
    const m = await page.send<LayoutMetrics>("Page.getLayoutMetrics");
    const vp = m.cssLayoutViewport ?? m.layoutViewport ?? { pageX: 0, pageY: 0 };
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const right = Math.max(...xs);
    const bottom = Math.max(...ys);
    // Past the viewport the browser paints nothing unless asked: an infobox taller than the window would come out blank below its edge.
    const w = "clientWidth" in vp ? vp.clientWidth : undefined;
    const h = "clientHeight" in vp ? vp.clientHeight : undefined;
    if (x < 0 || y < 0 || (w !== undefined && right > w) || (h !== undefined && bottom > h)) params.captureBeyondViewport = true;
    params.clip = { x: x + vp.pageX, y: y + vp.pageY, width: right - x, height: bottom - y, scale: 1 };
  } else if (opts.full) {
    const m = await page.send<LayoutMetrics>("Page.getLayoutMetrics");
    const size = m.cssContentSize ?? m.contentSize ?? { x: 0, y: 0, width: 0, height: 0 };
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
  }
  const { data } = await page.send<{ data: string }>("Page.captureScreenshot", params);
  return Buffer.from(data, "base64");
}

/** A result that cannot travel as JSON comes back as the browser's description of it ("button#go", "() => 1", "NaN"). */
function remoteValue(r: RemoteObject | undefined): unknown {
  if (!r) return undefined;
  if (r.subtype === "node") return r.description;
  if ("value" in r) return r.value;
  if (r.unserializableValue !== undefined) return r.unserializableValue;
  if (r.type === "undefined") return undefined;
  return r.description;
}

/**
 * Evaluate a JavaScript expression in the page (promises are awaited) and
 * return its value. A page exception is an error carrying its message.
 */
export async function evaluate(session: ActionSession, expression: string, opts: ActionOptions = {}): Promise<ActionResult> {
  const p = await perform(session, opts, async (pg) => {
    let r: { result?: RemoteObject; exceptionDetails?: ExceptionDetails };
    try {
      r = await pg.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    } catch (e) {
      if (e instanceof CdpError && /reference chain|serializ|by value/i.test(e.message))
        throw new ActionError(`the result cannot be returned as JSON (${e.message}): return plain data, e.g. only the fields you need`);
      throw e;
    }
    if (r.exceptionDetails) throw new ActionError(`evaluation failed: ${exceptionText(r.exceptionDetails)}`);
    return remoteValue(r.result);
  });
  return finish(session, "evaluate", undefined, p);
}

/**
 * Accept or dismiss the JavaScript dialog the page shows (`promptText` answers a
 * prompt). The answer goes first, before the settle is armed: until the dialog
 * is closed the page answers nothing, and arming would wait out its timeouts.
 */
export async function handleDialog(session: ActionSession, accept: boolean, promptText?: string, opts: ActionOptions = {}): Promise<ActionResult> {
  try {
    await session.page.send("Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) });
  } catch (e) {
    if (e instanceof CdpError && /no dialog/i.test(e.message)) throw new ActionError("no dialog is open");
    throw e;
  }
  const p = await perform(session, opts, async () => {});
  return finish(session, "dialog", undefined, p);
}

/** A history move or a reload, which the session already waits to load; then a quiet network, and the result. */
async function history(session: HistorySession, action: string, move: (o: { timeoutMs?: number }) => Promise<NavigationResult>, opts: HistoryOptions) {
  const before = await session.loaderId();
  const nav = await move(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});
  await settle(session, settleOpts(opts));
  return finish(session, action, undefined, { navigated: nav.loaderId !== before, ...(nav.note ? { note: nav.note } : {}) });
}

export function back(session: HistorySession, opts: HistoryOptions = {}): Promise<ActionResult> {
  return history(session, "back", (o) => session.back(o), opts);
}

export function forward(session: HistorySession, opts: HistoryOptions = {}): Promise<ActionResult> {
  return history(session, "forward", (o) => session.forward(o), opts);
}

export function reload(session: HistorySession, opts: HistoryOptions = {}): Promise<ActionResult> {
  return history(session, "reload", (o) => session.reload(o), opts);
}
