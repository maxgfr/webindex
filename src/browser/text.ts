// `browser text`: what the current tab says, as text, without loading anything.
//
// The whole tab reads as `fetch --browser` reads a page (read.ts): one evaluate
// of READ_DOCUMENT serialises an inert copy of the rendered document with the
// overlays, dialogs and consent vendors' containers taken out — so a cookie
// wall covering the page is not what comes back — and extractFromHtml keeps the
// main content, consent lines dropped. One element (a ref, or the first match
// of a CSS selector) reads as the page shows it: its innerText, or its markup
// as Markdown. Nothing is clicked, typed or navigated; no field's value is read.

import { type ExtractResult, extractFromHtml } from "../fetch.js";
import { type ActionSession, resolveRef } from "./actions.js";
import { CdpError } from "./cdp.js";
import { READ_DOCUMENT } from "./overlay.js";
import { elementBySelector, NoMatchError } from "./snapshot.js";

export interface PageTextOptions {
  /** One element, by its ref from the latest snapshot. */
  ref?: string;
  /** One element: the first this CSS selector matches. */
  selector?: string;
  /** Markdown instead of plain text. */
  markdown?: boolean;
  /** Cut the text at this many characters. No limit by default. */
  maxChars?: number;
}

export interface PageText {
  url: string;
  title: string;
  ref?: string;
  selector?: string;
  /** The text, cut at maxChars. */
  text: string;
  /** How long the whole text is. */
  chars: number;
  truncated: boolean;
}

/** An element's text as the page shows it, and its markup for Markdown. */
const ELEMENT_TEXT = `function elementText() {
  const text = typeof this.innerText === "string" ? this.innerText : this.textContent || "";
  return { text, html: typeof this.outerHTML === "string" ? this.outerHTML : "" };
}`;

type Remote = { result?: { value?: unknown }; exceptionDetails?: { text?: string } };

/** The objectId of the element a ref or a selector names; the caller releases it. */
async function elementObject(session: ActionSession, opts: PageTextOptions): Promise<string> {
  if (opts.ref !== undefined) return (await resolveRef(session, opts.ref)).objectId;
  const selector = opts.selector as string;
  const backendNodeId = await elementBySelector(session.page, selector);
  try {
    const { object } = await session.page.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId });
    if (object.objectId) return object.objectId;
  } catch (e) {
    if (!(e instanceof CdpError)) throw e;
  }
  throw new NoMatchError(selector);
}

async function readElement(session: ActionSession, opts: PageTextOptions, url: string): Promise<string> {
  const objectId = await elementObject(session, opts);
  try {
    const r = await session.page.send<Remote>("Runtime.callFunctionOn", { objectId, functionDeclaration: ELEMENT_TEXT, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`the page threw: ${r.exceptionDetails.text ?? "page error"}`);
    const got = (r.result?.value ?? {}) as { text?: unknown; html?: unknown };
    if (opts.markdown && typeof got.html === "string") return extractFromHtml(got.html, url, { format: "markdown", fullPage: true }).text;
    return typeof got.text === "string" ? got.text : "";
  } finally {
    session.page.send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

async function readDocument(session: ActionSession, opts: PageTextOptions): Promise<{ text: string; url: string }> {
  const got = await session.page.send<Remote>("Runtime.evaluate", { expression: READ_DOCUMENT, returnByValue: true });
  const value = (got.result?.value ?? {}) as { html?: unknown; url?: unknown };
  const url = typeof value.url === "string" ? value.url : await session.currentUrl();
  const html = typeof value.html === "string" ? value.html : "";
  const r: Pick<ExtractResult, "text"> = extractFromHtml(html, url, { format: opts.markdown ? "markdown" : "text", stripConsent: true });
  return { text: r.text, url };
}

/**
 * The text of the current tab (its main content), or of one element of it.
 * StaleRefError for a ref the tab no longer has, NoMatchError for a selector
 * that matches nothing.
 */
export async function readPageText(session: ActionSession, opts: PageTextOptions = {}): Promise<PageText> {
  const element = opts.ref !== undefined || opts.selector !== undefined;
  let url = await session.currentUrl();
  let text: string;
  if (element) text = await readElement(session, opts, url);
  else ({ text, url } = await readDocument(session, opts));
  text = text.trim();
  const title = await session.title();
  const max = opts.maxChars;
  if (max !== undefined && !(Number.isInteger(max) && max >= 1)) throw new RangeError(`maxChars must be a whole number, 1 or more, not ${max}`);
  const truncated = max !== undefined && text.length > max;
  return {
    url,
    title,
    ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
    ...(opts.selector !== undefined ? { selector: opts.selector } : {}),
    text: truncated ? text.slice(0, max).trimEnd() : text,
    chars: text.length,
    truncated,
  };
}
