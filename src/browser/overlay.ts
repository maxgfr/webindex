// What covers the page: cookie walls, consent panels, modal dialogs.
//
// One probe, run in the page, decides what an overlay is, for the three places
// that need to know: the snapshot (which shows overlays first, so a cut tree
// never hides the "Accept" the agent has to ask the user about), the click that
// lands on one (which lists the overlay's controls instead of only naming it),
// and the browser read (which drops them from the copy it reads).
//
// What an overlay is, exactly, is said where OVERLAYS_SOURCE is defined: a
// shown dialog or consent vendor's container, or a fixed layer over a large part
// of the screen that is not the page itself, holding a control or some text to
// read (an image ad layer asks nothing of anyone). Only the outermost counts.
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
  'div[class^="didomi-"]',
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
  'div[class^="truste_"]',
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

/** Under this many characters of text, a layer with no control in it says nothing to answer: no overlay. */
export const BARE_TEXT_MAX = 40;
/** The tags that are controls in themselves (a link only with an href, an input unless hidden). */
const CONTROL_TAGS = ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "SUMMARY", "DETAILS"];
const CONTROL_ROLES = [
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "textbox",
  "searchbox",
  "combobox",
  "slider",
  "spinbutton",
];

// --- page functions ----------------------------------------------------------
//
// Strings (src has no DOM lib), run in the page. Keep `${` out of the parts in
// backquotes: only the TypeScript splices below may use it.

/** Helpers the page functions share: up (out of shadow roots too), dialog, consent vendor, pinned. */
const HELPERS = `const up = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || n.host || null;
  const body = document.body;
  const roleOf = (el) => String((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
  const isDialog = (el) =>
    roleOf(el) === "dialog" ||
    roleOf(el) === "alertdialog" ||
    (!!el.getAttribute && el.getAttribute("aria-modal") === "true") ||
    (String(el.tagName || "").toUpperCase() === "DIALOG" && el.open === true);
  const CONSENT = ${JSON.stringify(CONSENT_SELECTORS.join(", "))};
  const isConsent = (el) => {
    try {
      return !!el.matches && el.matches(CONSENT);
    } catch (e) {
      return false;
    }
  };
  const CONTROL_TAGS = ${JSON.stringify(CONTROL_TAGS)};
  const CONTROL_ROLES = ${JSON.stringify(CONTROL_ROLES)};
  /** Something to act on: a native control, a control role, a focusable (tabindex >= 0) or editable element. */
  const isControl = (el) => {
    const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "A") return attr("href") !== null;
    if (tag === "INPUT") return String(attr("type") || "").toLowerCase() !== "hidden";
    if (CONTROL_TAGS.indexOf(tag) >= 0 || CONTROL_ROLES.indexOf(roleOf(el)) >= 0) return true;
    const tab = attr("tabindex");
    if (tab !== null && tab !== "" && Number(tab) >= 0) return true;
    const edit = attr("contenteditable");
    return edit === "" || edit === "true" || edit === "plaintext-only";
  };
  const textLength = (n) => String((typeof n.innerText === "string" ? n.innerText : n.textContent) || "").replace(/\\s+/g, " ").trim().length;
  /**
   * Nothing to answer in it: no control, itself or inside (open shadow roots
   * included), and under ${BARE_TEXT_MAX} characters of text. An ad slot holding
   * an image is one; a cookie wall, a login dialog, a notice to read are not.
   * Never bare: a consent vendor's container (its buttons may be plain divs),
   * nor anything holding a custom element with no open shadow root (a closed
   * one hides its text and controls from here).
   */
  const bare = (el) => {
    let text = textLength(el);
    const stack = [el];
    for (let seen = 0; stack.length > 0; seen++) {
      // Too big to look through: whatever it is, it is no empty layer.
      if (text >= ${BARE_TEXT_MAX} || seen > 5000) return false;
      const n = stack.pop();
      if (n.nodeType === 1 && (isControl(n) || isConsent(n))) return false;
      if (n.nodeType === 1 && String(n.tagName || "").indexOf("-") >= 0 && !n.shadowRoot) return false;
      for (const k of Array.from(n.children || [])) stack.push(k);
      if (n.shadowRoot) {
        for (const k of Array.from(n.shadowRoot.children || [])) {
          text += textLength(k);
          stack.push(k);
        }
      }
    }
    return text < ${BARE_TEXT_MAX};
  };
  /** Fixed or sticky, itself or an ancestor up to the body: what a click's covering node belongs to. */
  const pinned = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  };`;

/**
 * In the page: the visible overlays of the document, outermost only, in
 * document order, at most five. Elements, so the caller can name them by
 * backendNodeId.
 *
 * A consent vendor's container counts when it is shown: on screen, with no
 * ancestor hidden, transparent, aria-hidden or inert. So does a dialog out of
 * the flow of the page (fixed or absolute, itself or an ancestor, as a modal
 * <dialog> is): one in the flow (a news ticker marked up as a modal dialog, as
 * lemonde.fr's is) covers nothing. Any other element
 * counts when it is fixed (itself or an ancestor; sticky is layout, not an
 * overlay), covers 30% of the viewport, is wide (60%) or strictly across its
 * middle, and is on top at its centre. Such a layer that holds the main landmark
 * or most of the page's text is the page itself (an app shell): neither it nor
 * anything in it is taken for an overlay, a dialog apart. A presentational root
 * (role none or presentation, absent from the accessibility tree) is looked
 * through, to the dialog inside it. Whatever it is, one that is bare (no
 * control in it, almost no text: an image ad layer) is no overlay.
 */
export const OVERLAYS_SOURCE = `function findOverlays() {
  ${HELPERS}
  const found = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!body || !(vw > 0) || !(vh > 0)) return found;
  const isMain = (el) => String(el.tagName || "").toUpperCase() === "MAIN" || roleOf(el) === "main";
  const holdsMain = (el) => isMain(el) || Array.prototype.some.call(el.querySelectorAll("*"), isMain);
  const textOf = (el) => String(el.textContent || "").length;
  const pageText = textOf(body);
  const fixed = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) if (getComputedStyle(n).position === "fixed") return true;
    return false;
  };
  /** Out of the flow of the page, itself or an ancestor: what can be over something. */
  const floating = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "absolute") return true;
    }
    return false;
  };
  const hiddenUp = (el) => {
    for (let n = el; n && n.nodeType === 1; n = up(n)) {
      if (n.getAttribute && (n.getAttribute("aria-hidden") === "true" || n.getAttribute("inert") !== null)) return true;
      const cs = getComputedStyle(n);
      if (cs.display === "none" || Number(cs.opacity) === 0) return true;
    }
    return false;
  };
  const shown = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
    return !hiddenUp(el);
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
    // A side column is no overlay: one is wide, or strictly across the middle of the screen.
    const middle = a.left < vw / 2 && a.left + a.w > vw / 2 && a.top < vh / 2 && a.top + a.h > vh / 2;
    if (a.w < 0.6 * vw && !middle) return false;
    const root = el.getRootNode ? el.getRootNode() : document;
    const at = (root && root.elementFromPoint ? root : document).elementFromPoint(a.left + a.w / 2, a.top + a.h / 2);
    for (let n = at; n; n = up(n)) if (n === el) return true;
    return false;
  };
  const kids = (n) => Array.from((n && n.children) || []);
  const visit = (el, inShell) => {
    let shell = inShell;
    let take = false;
    const role = roleOf(el);
    if (isConsent(el)) take = shown(el) && !holdsMain(el);
    else if (isDialog(el)) take = floating(el) && shown(el) && !holdsMain(el);
    else if (!inShell && role !== "presentation" && role !== "none") {
      const a = area(el);
      if (a && fixed(el) && shown(el) && covers(el, a)) {
        if (holdsMain(el) || (pageText > 0 && textOf(el) > 0.6 * pageText)) shell = true;
        else take = true;
      }
    }
    // An overlay is taken whole: what is inside it is its own. A bare one is none, nor is anything inside it.
    if (take && bare(el)) return;
    if (take) {
      found.push(el);
      return;
    }
    for (const k of kids(el)) visit(k, shell);
    if (el.shadowRoot) for (const k of kids(el.shadowRoot)) visit(k, shell);
  };
  for (const k of kids(body)) visit(k, false);
  return found.slice(0, 5);
}`;

/**
 * In the page, with `this` the node a click landed on instead of its target:
 * what covers the target. The probe's overlay holding it; else its nearest
 * dialog; else its outermost fixed or sticky ancestor; else null. Whether that
 * is an overlay is OVERLAY_INFO_SOURCE's to say.
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

/**
 * In the page, with `this` what covers a click's target: its description, and
 * whether it is an overlay (one the probe finds, a dialog, a consent vendor's
 * container, never a bare one) or only something fixed in the way: a sticky
 * header, a chat bubble, an image ad layer.
 */
export const OVERLAY_INFO_SOURCE = `function overlayInfo() {
  ${HELPERS}
  ${DESCRIBE_SOURCE}
  const overlays = (${OVERLAYS_SOURCE})();
  return { what: describe(this), overlay: (overlays.indexOf(this) >= 0 || isDialog(this) || isConsent(this)) && !bare(this) };
}`;

/**
 * One evaluate: the document as rendered, read from an inert copy with the
 * overlays, the dialogs and the consent vendors' containers taken out. The live
 * page is only marked for the time it takes to serialise it (an attribute of a
 * random name, removed in a finally); the copy is parsed by DOMParser, where no
 * script, custom element or image load runs. <body>, <html> and anything that
 * holds the main landmark are never dropped. Where the page forbids parsing
 * (Trusted Types), the serialised page is read as it is.
 */
export const READ_DOCUMENT = `(() => {
  const findOverlays = ${OVERLAYS_SOURCE};
  const root = document.documentElement;
  if (!root) return { html: "", url: location.href };
  const mark = "data-overlay-" + Math.random().toString(36).slice(2, 10);
  let overlays = [];
  let html = "";
  try {
    try {
      overlays = findOverlays();
    } catch (e) {}
    for (const el of overlays) if (el.getRootNode && el.getRootNode() === document) el.setAttribute(mark, "");
    html = root.outerHTML;
  } finally {
    for (const el of overlays) if (el.removeAttribute) el.removeAttribute(mark);
  }
  let parsed;
  try {
    parsed = new DOMParser().parseFromString(html, "text/html");
  } catch (e) {
    return { html, url: location.href };
  }
  const drop = ["[" + mark + "]", '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', "dialog", ${CONSENT_SELECTORS.map((s) => JSON.stringify(s)).join(", ")}];
  const keep = (el) =>
    el === parsed.body || el === parsed.documentElement || el.tagName === "MAIN" || el.getAttribute("role") === "main" || !!el.querySelector("main, [role=main]");
  for (const sel of drop) {
    let els = [];
    try {
      els = Array.from(parsed.querySelectorAll(sel));
    } catch (e) {}
    for (const el of els) if (!keep(el)) el.remove();
  }
  return { html: parsed.documentElement.outerHTML, url: location.href };
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
    const elements = result.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId).map((p) => p.value?.objectId as string);
    const ids = (await Promise.all(elements.map((id) => backendIdOf(page, id)))).filter((id): id is number => id !== undefined);
    return ids;
  } catch {
    return [];
  } finally {
    releaseGroup(page);
  }
}

/** What covers a click's target, given the node it landed on: named, and whether it is an overlay. Undefined when nothing does, or when the page cannot say. */
export async function overlayRootOf(page: CdpSession, objectId: string): Promise<{ backendNodeId: number; what: string; overlay: boolean } | undefined> {
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
    const info = (await call(rootId, OVERLAY_INFO_SOURCE, true)).result?.value as { what?: unknown; overlay?: unknown } | undefined;
    return { backendNodeId, what: typeof info?.what === "string" ? info.what : "an element", overlay: info?.overlay === true };
  } catch {
    return undefined;
  } finally {
    releaseGroup(page);
  }
}
