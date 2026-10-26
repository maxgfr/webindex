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

// --- handing a page to the human -------------------------------------------------

/**
 * A read that may hand its page to the human (`fetch --human`): on a blocking
 * challenge, or a consent or sign-in wall, the tab is brought up in the visible
 * dedicated browser, the human is told which page needs them, and the read
 * waits until the wall is gone, then reads the page from that same tab.
 */
export interface HumanHandoff {
  /** How long the human has to get past the wall; 5 minutes by default. */
  timeoutMs?: number;
  /** Where the request to the human goes: a line on stderr by default. */
  tell?: (message: string) => void;
}

/**
 * How a handoff went, on a read that met a wall a human could get past:
 * `cleared` the human got past it and the page was read, `timeout` the wall was
 * still up when the time ran out, `no-window` nobody could be shown the page
 * (no display, a headless browser, a CI run) so nobody was waited for.
 */
export type HumanOutcome = "cleared" | "timeout" | "no-window";

/**
 * Whether a window this process opens has someone to look at it: macOS and
 * Windows always, Linux only under X11 or Wayland — and never in a CI run,
 * where a wait for a human would only hang the job.
 */
export function canShowWindow(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): boolean {
  const ci = env.CI?.trim().toLowerCase();
  if (ci && ci !== "false" && ci !== "0") return false;
  if (platform === "darwin" || platform === "win32") return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** A sign-in page in its own words: the page is there, behind a login only the human has. */
const LOGIN_WALL =
  /\b(?:sign|log) ?in (?:to (?:continue|read|view|see|access|keep reading)|or (?:sign up|register|create an account))\b|\byou (?:must|need to|have to) (?:be )?(?:signed|logged) ?in\b|\bplease (?:sign|log) ?in\b/i;
/** A page this long with a sign-in prompt in it is a page, not a wall. */
const LOGIN_WALL_MAX = 1500;

/**
 * The wall in front of a page that a human at the window can get past — a
 * consent wall, an anti-bot interstitial, a sign-in page — or undefined. A
 * JavaScript-required shell is not one: the browser runs the script itself.
 */
export function humanWall(text: string): string | undefined {
  const junk = looksLikeJunkExtraction(text);
  if (junk && !junk.startsWith("JavaScript")) return junk;
  const t = text.trim();
  return t && t.length < LOGIN_WALL_MAX && LOGIN_WALL.test(t.slice(0, 800)) ? "login wall" : undefined;
}
