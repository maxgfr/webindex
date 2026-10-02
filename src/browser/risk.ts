// The irreversibility guard: a safety net, not the rule.
//
// A click or an Enter that looks like it pays, orders, deletes, publishes or
// sends is refused unless the caller says the user confirmed it, and so is
// submitting a form that holds a password (the human logs in). The match is on
// words in the control's label, in French and English, so it errs on the side of
// asking: a refusal costs one `--confirm`, a missed payment costs money.

import type { CdpSession } from "./cdp.js";

export type RiskAction = "click" | "press";

export interface RiskContext {
  action: RiskAction;
  key?: string;
  role?: string;
  /** Accessible name, text, value, aria-label and title of the target, any of them. */
  label: string;
  /** The click is on a submit control, or Enter would submit the form it is in. */
  isSubmit: boolean;
  formHasPassword: boolean;
  /** The label of the form's submit control: what Enter in a field would press. */
  submitLabel?: string;
}

export interface Risk {
  risky: boolean;
  reason?: string;
}

const PASSWORD_REASON = "form contains a password field — let the human log in";

/**
 * Accent-free lowercase patterns, matched as whole words. French verbs are
 * matched by stem (infinitive, imperative, first person: "payer", "payez",
 * "je paie"), English ones by word.
 */
const IRREVERSIBLE = [
  // pay
  "pay(?:er|ez|ment)?",
  "paie(?:ment)?",
  "purchase",
  "buy",
  "achet(?:er|ez|e)",
  "achat",
  // order
  "order",
  "command(?:er|ez|e)",
  "check\\s*out",
  "place\\s+order",
  // confirm, validate
  "confirm(?:er|ez|e)?",
  "validate",
  "valid(?:er|ez|e)",
  // delete, remove
  "delete",
  "remove",
  "supprim(?:er|ez|e)",
  "suppression",
  // publish, post, send, submit
  "publish",
  "publi(?:er|ez|e|cation)",
  "post",
  "post(?:er|ez)",
  "send",
  "envo(?:y\\w*|i)",
  "submit",
  "soumett\\w*",
  "soumettre",
  "transfer",
  "virement",
  // subscriptions
  "subscribe",
  "unsubscribe",
  "(?:des)?abonn(?:er|ez|e)",
  "resili(?:er|ez|e|ation)",
  "cancel\\s+subscription",
  // signing, booking, giving, depositing
  "sign(?:er|ez)",
  "book",
  "reserv(?:er|ez|e|ation)",
  "donate",
  "faire\\s+un\\s+don",
  "close\\s+account",
  "fermer\\s+le\\s+compte",
  "depos(?:er|ez|e)",
  "deposit",
];

// "sign" is a signature, not "sign in" / "sign out".
const SIGN = "sign(?!\\s*-?\\s*(?:in|out)(?![a-z0-9]))";

const IRREVERSIBLE_RE = new RegExp(`(?<![a-z0-9])(${[...IRREVERSIBLE, SIGN].join("|")})(?![a-z0-9])`);

const norm = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/[‘’]/g, "'").toLowerCase();

/** The irreversible word a label contains, if any. */
function matchLabel(label: string | undefined): string | undefined {
  return label ? IRREVERSIBLE_RE.exec(norm(label))?.[1]?.replace(/\s+/g, " ") : undefined;
}

const ENTER = new Set(["enter", "numpadenter", "return"]);
const SPACE = new Set([" ", "space", "spacebar"]);
/** The key a chord ends with, lowercased: "Control+Enter" → "enter". */
const lastKey = (key: string | undefined): string => {
  const k = key ?? "";
  return k.endsWith("+ ") || k === " " ? " " : (k.split("+").pop()?.toLowerCase() ?? "");
};
/** "Control+Enter", "enter" and "Return" are all Enter. */
const isEnter = (key: string | undefined): boolean => ENTER.has(lastKey(key));
/** " ", "Space" and "Shift+Space" are all Space. */
const isSpace = (key: string | undefined): boolean => SPACE.has(lastKey(key));
/** Roles where Enter activates the focused control itself, as a click would. */
const ACTIVATES = new Set(["button", "link", "menuitem"]);
/** Roles Space activates (or toggles) as a click would. Never a text field: there it types a space. */
const SPACE_ACTIVATES = new Set([...ACTIVATES, "checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio", "option", "tab", "treeitem"]);

const shown = (label: string) => (label.length > 60 ? `${label.slice(0, 57)}...` : label);

/** Would this action do something that cannot be taken back? Pure: the page is read by riskContext. */
export function assessRisk(ctx: RiskContext): Risk {
  // Space on a control is a click on it; anywhere else it is harmless.
  const spaceClick = ctx.action === "press" && isSpace(ctx.key) && SPACE_ACTIVATES.has(ctx.role ?? "");
  if (ctx.action === "press" && !isEnter(ctx.key) && !spaceClick) return { risky: false };
  if (ctx.isSubmit && ctx.formHasPassword) return { risky: true, reason: PASSWORD_REASON };
  // A click acts on its target; Enter acts on it only if it is a button or link, else on the form's submit control.
  const acts = ctx.action === "click" || spaceClick || ACTIVATES.has(ctx.role ?? "");
  const label = acts ? ctx.label : ctx.isSubmit ? (ctx.submitLabel ?? "") : "";
  const word = matchLabel(label);
  if (word) return { risky: true, reason: `the control "${shown(label)}" looks irreversible (matches "${word}")` };
  return { risky: false };
}

/**
 * Would accepting this JavaScript dialog do something that cannot be taken
 * back? A `confirm("Supprimer définitivement ?")` is the clearest sign a page
 * gives, often behind an icon-only button the click guard could not read. An
 * alert has nothing to accept; dismissing is never risky.
 */
export function assessDialog(type: string, message: string): Risk {
  if (type === "alert") return { risky: false };
  const word = matchLabel(message);
  return word ? { risky: true, reason: `it looks irreversible (matches "${word}")` } : { risky: false };
}

// --- collector ---------------------------------------------------------------

/** What riskContext reports about the target element. */
export interface ElementRisk {
  role: string;
  label: string;
  isSubmit: boolean;
  formHasPassword: boolean;
  submitLabel: string;
}

/**
 * Runs in the page with the top document as its argument: the element that has
 * the focus. `document.activeElement` stops at a shadow host or a frame; this
 * follows open shadow roots and same-origin frames down. A frame whose document
 * cannot be read (another origin's) is where it stops, and the collector then
 * refuses to call it harmless.
 */
export const FOCUS_SOURCE = `function (doc) {
  let el = doc.activeElement;
  for (let i = 0; el && i < 32; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
      continue;
    }
    if (!/^i?frame$/i.test(el.tagName || "")) break;
    let inner = null;
    try { inner = el.contentDocument; } catch (e) { inner = null; }
    if (!inner || !inner.activeElement) break;
    el = inner.activeElement;
  }
  return el;
}`;

/**
 * Runs in the page: the element a node stands for. A text node is its parent
 * element's, a shadow root its host's, and anything inside the user-agent
 * shadow tree of a form control (the editor of a text field, the label of an
 * `<input type=submit>`) the control's: Chrome's hit test lands in there
 * (DOM.getNodeForLocation with includeUserAgentShadowDOM), and none of it is a
 * control of its own. Null when nothing is found (a detached node, a document).
 */
export const OWNER_SOURCE = `(node) => {
  let el = node;
  for (let i = 0; el && el.nodeType !== 1 && i < 64; i++) el = el.nodeType === 11 ? el.host : el.parentElement || el.parentNode;
  for (let i = 0; el && el.nodeType === 1 && i < 8; i++) {
    const root = el.getRootNode ? el.getRootNode() : null;
    const host = root && root.nodeType === 11 ? root.host : null;
    if (!host || !/^(input|textarea|select)$/i.test(host.tagName || "")) break;
    el = host;
  }
  return el && el.nodeType === 1 ? el : null;
}`;

/**
 * Runs in the page with `this` the target (or the focused element) and the
 * action as its argument. Starts from the element the node stands for
 * (OWNER_SOURCE). Returns null if there is no element, and
 * `{ frame, readable }` for a frame: what a click or a key does in there is not
 * this element's to say.
 */
export const COLLECT_SOURCE = `function (action) {
  const el = (${OWNER_SOURCE})(this);
  if (!el) return null;
  if (/^i?frame$/i.test(el.tagName || "")) {
    let inner = null;
    try { inner = el.contentDocument; } catch (e) { inner = null; }
    return { frame: true, readable: !!inner };
  }
  // The element's own document: it may sit in a same-origin frame, or a shadow root.
  const doc = el.ownerDocument || document;
  const BTN = "button,[role=button],input[type=submit],input[type=image],input[type=button]";
  const PW = "input[type=password]";
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().slice(0, 200);
  // The control the user means: a click on a span inside a button is a click on the button.
  const ctl = el.closest(BTN) || el;
  const tag = ctl.tagName.toLowerCase();
  const type = (ctl.getAttribute("type") || "").toLowerCase();
  const buttonInput = tag === "input" && ["button", "submit", "reset", "image"].includes(type);
  const buttonish = tag === "button" || buttonInput || (ctl.getAttribute("role") || "").toLowerCase() === "button";
  const labelOf = (e) => {
    const t = e.tagName.toLowerCase();
    const ty = (e.getAttribute("type") || "").toLowerCase();
    const isBtn = t === "button" || (t === "input" && ["button", "submit", "reset", "image"].includes(ty)) || (e.getAttribute("role") || "") === "button";
    const root = e.getRootNode ? e.getRootNode() : doc;
    const byId = (id) => (root && root.getElementById ? root.getElementById(id) : null) || doc.getElementById(id);
    const by = (e.getAttribute("aria-labelledby") || "").split(/\\s+/).map((id) => (byId(id) || {}).textContent).filter(Boolean).join(" ");
    const alts = Array.from(e.querySelectorAll("img[alt],svg title"), (n) => n.getAttribute("alt") || n.textContent);
    const labels = isBtn && e.labels ? Array.from(e.labels, (l) => l.textContent) : [];
    const value = t === "input" && ["button", "submit", "reset", "image"].includes(ty) ? e.value : "";
    return norm([e.getAttribute("aria-label"), by, e.getAttribute("title"), e.getAttribute("alt"), value, t === "input" ? "" : e.innerText || e.textContent, ...alts, ...labels].filter(Boolean).join(" "));
  };
  const explicit = (ctl.getAttribute("role") || "").toLowerCase();
  let role = explicit;
  if (!role) {
    if (tag === "button" || buttonInput) role = "button";
    else if (tag === "a" && ctl.hasAttribute("href")) role = "link";
    else if (tag === "textarea" || (tag === "input" && !["checkbox", "radio"].includes(type))) role = "textbox";
    else if (tag === "input") role = type;
    else if (tag === "select") role = "combobox";
    else role = tag;
  }
  // The form, or with none (a single-page login) the nearest few ancestors holding a password field.
  const form = ctl.form || ctl.closest("form");
  let scope = form;
  if (!scope) {
    // Out of a shadow root to its host: a login widget's password may sit in its own root.
    const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    let a = up(ctl);
    for (let i = 0; a && i < 5 && a !== doc.body && a !== doc.documentElement; i++, a = up(a)) {
      if (a.querySelector(PW)) { scope = a; break; }
    }
  }
  const formHasPassword = !!scope && (form ? Array.from(form.elements).some((x) => x.type === "password") || !!form.querySelector(PW) : true);
  const submitter = form ? form.querySelector("button[type=submit], input[type=submit], input[type=image], button:not([type])") : scope ? scope.querySelector(BTN) : null;
  const label = labelOf(ctl);
  const toggle = /show|hide|reveal|afficher|masquer|visib/i.test(label);
  const nativeSubmit = !!form && ((tag === "button" && (type === "" || type === "submit")) || (tag === "input" && (type === "submit" || type === "image")));
  let isSubmit;
  if (buttonish) isSubmit = !toggle && (nativeSubmit || formHasPassword);
  else isSubmit = action === "press" && tag !== "textarea" && (!!form || formHasPassword);
  return { role, label, isSubmit, formHasPassword, submitLabel: submitter ? labelOf(submitter) : "" };
}`;

type PageResult = { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

/** The collector could not tell what the element is: the one inspection failure that is a refusal. */
class UninspectableError extends Error {}

const FRAME_REASON = "cannot inspect the content of this frame (e.g. a payment button)";

/** The collector's answer, or an error: a page that cannot be read must not look harmless. */
function collected(r: PageResult): ElementRisk {
  if (r.exceptionDetails)
    throw new UninspectableError(`could not inspect the target: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "page error"}`);
  const v = r.result?.value;
  if (typeof v !== "object" || v === null) throw new UninspectableError("could not inspect the target: it is not an element");
  // Another origin's frame is a page of its own (a PayPal or Google Pay button is one); a same-origin one's elements have refs of their own.
  if ((v as { frame?: unknown }).frame === true) {
    const readable = (v as { readable?: unknown }).readable === true;
    throw new UninspectableError(readable ? `${FRAME_REASON} — click the element inside it instead, from the snapshot` : FRAME_REASON);
  }
  return { role: "", label: "", isSubmit: false, formHasPassword: false, submitLabel: "", ...(v as Partial<ElementRisk>) };
}

/**
 * Read what assessRisk needs from the page. For a click that is the node named
 * by `backendNodeId`; for a key press, the focused element, down through shadow
 * roots and same-origin frames. Throws when the target cannot be inspected: a
 * frame of another origin cannot.
 */
export async function riskContext(page: CdpSession, backendNodeId: number | undefined, action: RiskAction, _key?: string): Promise<ElementRisk> {
  if (action === "press") {
    return collected(
      await page.send<PageResult>("Runtime.evaluate", {
        expression: `(${COLLECT_SOURCE}).call((${FOCUS_SOURCE})(document), ${JSON.stringify(action)})`,
        returnByValue: true,
      }),
    );
  }
  if (backendNodeId === undefined) throw new Error("a click needs a backendNodeId to inspect");
  const { object } = await page.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId });
  try {
    return collected(
      await page.send<PageResult>("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: COLLECT_SOURCE,
        arguments: [{ value: action }],
        returnByValue: true,
      }),
    );
  } finally {
    if (object.objectId) await page.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  }
}

// --- guard -------------------------------------------------------------------

export class RiskRefusedError extends Error {
  constructor(
    readonly action: RiskAction,
    readonly reason: string,
    readonly label: string,
    readonly key?: string,
  ) {
    const what = action === "press" ? `press ${key ?? "a key"}` : "click";
    super(`refused to ${what}${label ? ` on "${shown(label)}"` : ""}: ${reason}; ask the user, then retry with --confirm / confirm: true`);
    this.name = "RiskRefusedError";
  }
}

export interface GuardOptions {
  backendNodeId?: number;
  action: RiskAction;
  key?: string;
  /** The user said yes to exactly this action. */
  confirm?: boolean;
}

/** Resolve if the action may go ahead; throw RiskRefusedError if it looks irreversible and was not confirmed. */
export async function guardAction(page: CdpSession, opts: GuardOptions): Promise<void> {
  if (opts.confirm) return;
  if (opts.action === "press" && !isEnter(opts.key) && !isSpace(opts.key)) return;
  let el: ElementRisk;
  try {
    el = await riskContext(page, opts.backendNodeId, opts.action, opts.key);
  } catch (e) {
    // Fail closed: an element that cannot be read cannot be called harmless. A transport or DOM error (a timeout,
    // a stale node) is not about the element: it propagates unchanged, and the action does not run either.
    if (!(e instanceof UninspectableError)) throw e;
    throw new RiskRefusedError(opts.action, e.message, "", opts.key);
  }
  const risk = assessRisk({ action: opts.action, ...(opts.key !== undefined ? { key: opts.key } : {}), ...el });
  if (risk.risky) {
    // Name the control that would act: the target itself, unless the key submits the form it sits in.
    const onTarget = opts.action === "click" || (isSpace(opts.key) ? SPACE_ACTIVATES : ACTIVATES).has(el.role);
    throw new RiskRefusedError(opts.action, risk.reason ?? "looks irreversible", onTarget ? el.label : el.submitLabel || el.label, opts.key);
  }
}
