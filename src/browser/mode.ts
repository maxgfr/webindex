import { env } from "../brand.js";
import { looksLikeJunkExtraction } from "../junk.js";

/** When fetchAndExtract renders a page in the browser: every time, only when the built-in read fails, or never. */
export type BrowserFetchMode = "always" | "fallback" | "off";

/** The caller's choice, else `<PREFIX>_BROWSER_FETCH`; anything unknown is off. Read at call time. */
export function browserFetchMode(explicit?: BrowserFetchMode): BrowserFetchMode {
  const m = (explicit ?? env("BROWSER_FETCH"))?.toLowerCase();
  return m === "always" || m === "fallback" ? m : "off";
}

/** Statuses a real browser may get past: refused, throttled, or no answer at all. */
const RENDER_STATUS = new Set([0, 401, 403, 429, 503]);

/**
 * Why a built-in read of a web page deserves a second one in the browser, or
 * undefined when it does not: the fallback's one test. fetchAndExtract asks it
 * of the read it just made, the cache of a read it holds — one it fails is not
 * served while the fallback is on.
 */
export function worthRendering(res: { status: number; text: string }): string | undefined {
  if (RENDER_STATUS.has(res.status)) return res.status ? `got HTTP ${res.status}` : "got no answer";
  // Any other failure (a 404, a 500) would be the same in a browser; so would a 304.
  if (res.status < 200 || res.status >= 300) return undefined;
  const junk = looksLikeJunkExtraction(res.text);
  if (junk) return `read a ${junk}`;
  return res.text.trim().length < 200 ? "found almost no text" : undefined;
}
