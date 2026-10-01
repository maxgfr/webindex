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

/** Accent-free lowercase phrases, matched as whole words. */
const IRREVERSIBLE = [
  "pay",
  "payer",
  "paiement",
  "payment",
  "purchase",
  "buy",
  "acheter",
  "order",
  "commander",
  "checkout",
  "place order",
  "confirm",
  "confirmer",
  "validate",
  "valider",
  "delete",
  "supprimer",
  "remove",
  "publish",
  "publier",
  "post",
  "poster",
  "send",
  "envoyer",
  "submit",
  "soumettre",
  "transfer",
  "virement",
  "subscribe",
  "s'abonner",
  "unsubscribe",
  "se desabonner",
  "resilier",
  "cancel subscription",
  "signer",
  "book",
  "reserver",
  "donate",
  "faire un don",
  "close account",
  "fermer le compte",
  "deposer",
  "deposit",
];

// "sign" is a signature, not "sign in" / "sign out".
const SIGN = "sign(?!\\s*-?\\s*(?:in|out)(?![a-z0-9]))";

const phrase = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
const IRREVERSIBLE_RE = new RegExp(`(?<![a-z0-9])(${[...IRREVERSIBLE.map(phrase), SIGN].sort((a, b) => b.length - a.length).join("|")})(?![a-z0-9])`);

const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase();

/** The irreversible word a label contains, if any. */
function matchLabel(label: string | undefined): string | undefined {
  return label ? IRREVERSIBLE_RE.exec(norm(label))?.[1]?.replace(/\s+/g, " ") : undefined;
}

const ENTER = new Set(["Enter", "NumpadEnter"]);
/** Roles where Enter activates the focused control itself, as a click would. */
const ACTIVATES = new Set(["button", "link", "menuitem"]);

const shown = (label: string) => (label.length > 60 ? `${label.slice(0, 57)}...` : label);

/** Would this action do something that cannot be taken back? Pure: the page is read by riskContext. */
export function assessRisk(ctx: RiskContext): Risk {
  if (ctx.action === "press" && !ENTER.has(ctx.key ?? "")) return { risky: false };
  if (ctx.isSubmit && ctx.formHasPassword) return { risky: true, reason: PASSWORD_REASON };
  // A click acts on its target; Enter acts on it only if it is a button or link, else on the form's submit control.
  const acts = ctx.action === "click" || ACTIVATES.has(ctx.role ?? "");
  const label = acts ? ctx.label : ctx.isSubmit ? (ctx.submitLabel ?? "") : "";
  const word = matchLabel(label);
  if (word) return { risky: true, reason: `the control "${shown(label)}" looks irreversible (matches "${word}")` };
  return { risky: false };
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

const BLANK: ElementRisk = { role: "", label: "", isSubmit: false, formHasPassword: false, submitLabel: "" };

/** Runs in the page with `this` the target element and the action as its argument. */
const COLLECT = `function (action) {
  const el = this;
  if (!el || el.nodeType !== 1) return null;
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().slice(0, 200);
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const buttonInput = tag === "input" && ["button", "submit", "reset", "image"].includes(type);
  const labelOf = (e) => {
    const t = e.tagName.toLowerCase();
    const ty = (e.getAttribute("type") || "").toLowerCase();
    const by = (e.getAttribute("aria-labelledby") || "").split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent).filter(Boolean).join(" ");
    const value = t === "input" && ["button", "submit", "reset", "image"].includes(ty) ? e.value : "";
    return norm([e.getAttribute("aria-label"), by, e.getAttribute("title"), value, t === "input" ? "" : e.innerText || e.textContent].filter(Boolean).join(" "));
  };
  const explicit = (el.getAttribute("role") || "").toLowerCase();
  let role = explicit;
  if (!role) {
    if (tag === "button" || buttonInput) role = "button";
    else if (tag === "a" && el.hasAttribute("href")) role = "link";
    else if (tag === "textarea" || (tag === "input" && !["checkbox", "radio"].includes(type))) role = "textbox";
    else if (tag === "input") role = type;
    else if (tag === "select") role = "combobox";
    else role = tag;
  }
  const form = el.form || el.closest("form");
  const formHasPassword = !!(form && form.querySelector("input[type=password]"));
  const submitter = form ? form.querySelector("button[type=submit], input[type=submit], input[type=image], button:not([type])") : null;
  const isSubmitControl = !!form && (el === submitter || (tag === "button" && (type === "" || type === "submit")) || (tag === "input" && (type === "submit" || type === "image")));
  const isSubmit = action === "press" ? !!form && tag !== "textarea" && (role === "button" || buttonInput ? isSubmitControl : true) : isSubmitControl;
  return { role, label: labelOf(el), isSubmit, formHasPassword, submitLabel: submitter ? labelOf(submitter) : "" };
}`;

/**
 * Read what assessRisk needs from the page. For a click that is the node named
 * by `backendNodeId`; for a key press, the focused element.
 */
export async function riskContext(page: CdpSession, backendNodeId: number | undefined, action: RiskAction, _key?: string): Promise<ElementRisk> {
  let value: unknown;
  if (action === "press") {
    const r = await page.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression: `(${COLLECT}).call(document.activeElement, ${JSON.stringify(action)})`,
      returnByValue: true,
    });
    value = r.result?.value;
  } else {
    if (backendNodeId === undefined) throw new Error("a click needs a backendNodeId to inspect");
    const { object } = await page.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId });
    try {
      const r = await page.send<{ result?: { value?: unknown } }>("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: COLLECT,
        arguments: [{ value: action }],
        returnByValue: true,
      });
      value = r.result?.value;
    } finally {
      if (object.objectId) await page.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    }
  }
  return typeof value === "object" && value !== null ? { ...BLANK, ...(value as Partial<ElementRisk>) } : BLANK;
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
  if (opts.action === "press" && !ENTER.has(opts.key ?? "")) return;
  const el = await riskContext(page, opts.backendNodeId, opts.action, opts.key);
  const risk = assessRisk({ action: opts.action, ...(opts.key !== undefined ? { key: opts.key } : {}), ...el });
  if (risk.risky)
    throw new RiskRefusedError(opts.action, risk.reason ?? "looks irreversible", opts.action === "press" ? el.submitLabel || el.label : el.label, opts.key);
}
