// What covers the page: cookie walls, consent panels, modal dialogs.
//
// One probe, run in the page, decides what an overlay is, for the three places
// that need to know: the snapshot (which shows overlays first, so a cut tree
// never hides the "Accept" the agent has to ask the user about), the click that
// lands on one (which lists the overlay's controls instead of only naming it),
// and the browser read (which drops them from the copy it reads).
//
// An overlay is a visible element that is a dialog (role dialog or alertdialog,
// aria-modal, an open <dialog>), or that is fixed or sticky (itself or an
// ancestor) and covers at least 30% of the viewport, wide or over its middle,
// with nothing else on top at its centre. A layer that holds the page's main
// landmark or most of its text is the page itself (an app shell), not
// something over it. Only the outermost of nested overlays counts.
//
// Nothing here is specific to a site: the consent vendors' containers are
// listed the way challenge.ts lists the challenge vendors.

import type { CdpSession } from "./cdp.js";

/** The containers the common consent-management platforms inject: never page content. */
export const CONSENT_SELECTORS: readonly string[] = [
  // OneTrust
  "#onetrust-consent-sdk",
  "#onetrust-banner-sdk",
  "#onetrust-pc-sdk",
  // Didomi
  "#didomi-host",
  "#didomi-notice",
  '[class^="didomi-"]',
  // Sourcepoint
  '[id^="sp_message_container"]',
  // Quantcast Choice
  ".qc-cmp2-container",
  "#qc-cmp2-container",
  // Cookiebot
  "#CybotCookiebotDialog",
  "#CybotCookiebotDialogBodyUnderlay",
  // Usercentrics
  "#usercentrics-root",
  "#usercentrics-cmp-ui",
  // TrustArc
  "#truste-consent-track",
  "#consent_blackbar",
  '[class^="truste_"]',
  // consentmanager.net, Commanders Act, Axeptio, Iubenda, Complianz, CookieYes, Osano, Borlabs, Google Funding Choices
  "#cmpbox",
  "#cmpbox2",
  "#tc-privacy-wrapper",
  "#axeptio_overlay",
  "#iubenda-cs-banner",
  "#cmplz-cookiebanner-container",
  ".cky-consent-container",
  ".osano-cm-window",
  "#BorlabsCookieBox",
  ".fc-consent-root",
  // The IAB TCF / GPP locator frames
  'iframe[name="__tcfapiLocator"]',
  'iframe[name="__cmpLocator"]',
  'iframe[name="__gppLocator"]',
];

// --- page functions ----------------------------------------------------------
//
// Strings (src has no DOM lib), run in the page. Keep `${` out of the parts in
// backquotes: only the TypeScript splices below may use it.

/** Helpers both page functions share: up (out of shadow roots too), dialog, pinned. */
const HELPERS = `const up = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || n.host || null;
  const body = document.body;
  const roleOf = (el) => String((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
  const isDialog = (el) =>
    roleOf(el) === "dialog" ||
    roleOf(el) === "alertdialog" ||
    (!!el.getAttribute && el.getAttribute("aria-modal") === "true") ||
    (String(el.tagName || "").toUpperCase() === "DIALOG" && el.open === true);
  const pinned = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  };`;

/**
 * In the page: the visible overlays of the document, outermost first in document
 * order, at most five. Elements, so the caller can name them by backendNodeId.
 */
export const OVERLAYS_SOURCE = `function findOverlays() {
  ${HELPERS}
  const out = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!body || !(vw > 0) || !(vh > 0)) return out;
  const isMain = (el) => String(el.tagName || "").toUpperCase() === "MAIN" || roleOf(el) === "main";
  const holdsMain = (el) => isMain(el) || Array.prototype.some.call(el.querySelectorAll("*"), isMain);
  const pageText = String(body.textContent || "").length;
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  /** The part of the viewport the element covers, or null when it is under 30%. */
  const area = (el) => {
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const w = Math.min(r.right, vw) - left;
    const h = Math.min(r.bottom, vh) - top;
    return w > 0 && h > 0 && w * h >= 0.3 * vw * vh ? { left, top, w, h } : null;
  };
  const covers = (el, a) => {
    // A side column is no overlay: one is wide, or over the middle of the screen.
    const middle = a.left <= vw / 2 && a.left + a.w >= vw / 2 && a.top <= vh / 2 && a.top + a.h >= vh / 2;
    if (a.w < 0.6 * vw && !middle) return false;
    const root = el.getRootNode ? el.getRootNode() : document;
    const at = (root && root.elementFromPoint ? root : document).elementFromPoint(a.left + a.w / 2, a.top + a.h / 2);
    for (let n = at; n; n = up(n)) if (n === el) return true;
    return false;
  };
  const found = [];
  const walk = (root) => {
    const els = root.querySelectorAll("*");
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      let hit = false;
      if (isDialog(el)) hit = shown(el);
      else {
        const a = area(el);
        hit = !!a && shown(el) && pinned(el) && covers(el, a) && !(pageText > 0 && String(el.textContent || "").length > 0.6 * pageText);
      }
      if (hit && !holdsMain(el)) found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(body);
  const inside = (el, other) => {
    for (let n = up(el); n; n = up(n)) if (n === other) return true;
    return false;
  };
  for (const el of found) if (!found.some((o) => o !== el && inside(el, o))) out.push(el);
  return out.slice(0, 5);
}`;

/**
 * In the page, with `this` the node a click landed on instead of its target:
 * the overlay it belongs to. The probe's overlay holding it; else its nearest
 * dialog; else its outermost fixed or sticky ancestor; else null.
 */
export const OVERLAY_ROOT_SOURCE = `function overlayRoot() {
  ${HELPERS}
  const overlays = (${OVERLAYS_SOURCE})();
  for (let n = this; n; n = up(n)) if (overlays.indexOf(n) >= 0) return n;
  let outer = null;
  for (let n = this; n && n !== body && n !== document.documentElement; n = up(n)) {
    if (n.nodeType !== 1) continue;
    if (isDialog(n)) return n;
    if (pinned(n) && !pinned(up(n) || body)) outer = n;
  }
  return outer;
}`;

/** `<div#id role="dialog"> "Its text"`: an element as the agent can recognise it in a snapshot. */
export const DESCRIBE_SOURCE = `const describe = (el) => {
    const tag = String(el.tagName || "").toLowerCase();
    const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
    const role = attr("role");
    const type = tag === "input" ? attr("type") : null;
    const text = String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    const shown = text.length > 60 ? text.slice(0, 57) + "..." : text;
    return "<" + tag + (el.id ? "#" + el.id : "") + (role ? ' role="' + role + '"' : "") + (type ? ' type="' + type + '"' : "") + ">" + (shown ? ' "' + shown + '"' : "");
  };`;

const DESCRIBE_THIS = `function describeOverlay() {
  ${DESCRIBE_SOURCE}
  return describe(this);
}`;

/**
 * One evaluate: the document as rendered, read from a copy with the overlays,
 * the dialogs and the consent vendors' containers taken out. The live page is
 * only marked for the time of the copy (an attribute of a random name, removed
 * at once), never changed. A dropped element that holds the main landmark stays.
 */
export const READ_DOCUMENT = `(() => {
  const findOverlays = ${OVERLAYS_SOURCE};
  const root = document.documentElement;
  if (!root) return { html: "", url: location.href };
  let overlays = [];
  try {
    overlays = findOverlays();
  } catch (e) {}
  const mark = "data-overlay-" + Math.random().toString(36).slice(2, 10);
  for (const el of overlays) if (el.getRootNode && el.getRootNode() === document) el.setAttribute(mark, "");
  let copy;
  try {
    copy = root.cloneNode(true);
  } finally {
    for (const el of overlays) if (el.removeAttribute) el.removeAttribute(mark);
  }
  const drop = ["[" + mark + "]", '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', "dialog", ${CONSENT_SELECTORS.map((s) => JSON.stringify(s)).join(", ")}];
  const main = (el) => el.tagName === "MAIN" || el.getAttribute("role") === "main" || !!el.querySelector("main, [role=main]");
  for (const sel of drop) {
    let els = [];
    try {
      els = Array.from(copy.querySelectorAll(sel));
    } catch (e) {}
    for (const el of els) if (!main(el)) el.remove();
  }
  return { html: copy.outerHTML, url: location.href };
})()`;

// --- collectors ----------------------------------------------------------------

const GROUP = "overlay-probe";
const PROBE_TIMEOUT_MS = 5000;

type Remote = { type?: string; subtype?: string; objectId?: string; value?: unknown };

async function backendIdOf(page: CdpSession, objectId: string): Promise<number | undefined> {
  const { node } = await page.send<{ node?: { backendNodeId?: number } }>("DOM.describeNode", { objectId }, { timeoutMs: PROBE_TIMEOUT_MS });
  return typeof node?.backendNodeId === "number" && node.backendNodeId > 0 ? node.backendNodeId : undefined;
}

/** Whatever the probe left behind goes, failure or not. */
function releaseGroup(page: CdpSession): void {
  page.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => {});
}

/** The backendNodeIds of the page's overlays. Never throws: a page that cannot say has none. */
export async function findOverlays(page: CdpSession): Promise<number[]> {
  try {
    const r = await page.send<{ result?: Remote; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression: `(${OVERLAYS_SOURCE})()`, returnByValue: false, objectGroup: GROUP },
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (r.exceptionDetails || !r.result?.objectId) return [];
    const { result = [] } = await page.send<{ result?: { name: string; value?: Remote }[] }>(
      "Runtime.getProperties",
      { objectId: r.result.objectId, ownProperties: true },
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    const ids: number[] = [];
    for (const p of result) {
      if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue;
      const id = await backendIdOf(page, p.value.objectId);
      if (id !== undefined) ids.push(id);
    }
    return ids;
  } catch {
    return [];
  } finally {
    releaseGroup(page);
  }
}

/** The overlay the node `objectId` (what a click landed on) belongs to, named; undefined when none or when the page cannot say. */
export async function overlayRootOf(page: CdpSession, objectId: string): Promise<{ backendNodeId: number; what: string } | undefined> {
  try {
    const call = (id: string, fn: string, byValue: boolean) =>
      page.send<{ result?: Remote; exceptionDetails?: unknown }>(
        "Runtime.callFunctionOn",
        { objectId: id, functionDeclaration: fn, returnByValue: byValue, objectGroup: GROUP },
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
    const root = await call(objectId, OVERLAY_ROOT_SOURCE, false);
    const rootId = root.result?.objectId;
    if (root.exceptionDetails || !rootId) return undefined;
    const backendNodeId = await backendIdOf(page, rootId);
    if (backendNodeId === undefined) return undefined;
    const named = await call(rootId, DESCRIBE_THIS, true);
    const what = typeof named.result?.value === "string" ? named.result.value : "an element";
    return { backendNodeId, what };
  } catch {
    return undefined;
  } finally {
    releaseGroup(page);
  }
}
