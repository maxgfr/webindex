import { env } from "../brand.js";

/** When fetchAndExtract renders a page in the browser: every time, only when the built-in read fails, or never. */
export type BrowserFetchMode = "always" | "fallback" | "off";

/** The caller's choice, else `<PREFIX>_BROWSER_FETCH`; anything unknown is off. Read at call time. */
export function browserFetchMode(explicit?: BrowserFetchMode): BrowserFetchMode {
  const m = (explicit ?? env("BROWSER_FETCH"))?.toLowerCase();
  return m === "always" || m === "fallback" ? m : "off";
}
