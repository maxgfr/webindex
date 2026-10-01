// Anti-bot and captcha challenge detection.
//
// classifyChallenge is a pure function over what one probe of the page saw;
// detectChallenge is the thin collector that builds that probe. Nothing here is
// specific to a site: the signatures are those of the vendors themselves.

import type { CdpSession } from "./cdp.js";

export type ChallengeKind = "datadome" | "cloudflare" | "recaptcha" | "hcaptcha" | "arkose" | "perimeterx" | "akamai" | "imperva" | "generic";

export interface Challenge {
  kind: ChallengeKind;
  /** A full-page interstitial the page cannot be used through, as opposed to a widget inside a normal page. */
  blocking: boolean;
  /** What matched, for the agent and the logs. */
  signals: string[];
}

export interface ChallengeSignature {
  url: string;
  title: string;
  /** The first ~4 KB of `document.body.innerText`. */
  text?: string;
  frameUrls?: string[];
  scriptUrls?: string[];
  /** Names (never values) of the cookies script can see. */
  cookieNames?: string[];
  /** Which of CHALLENGE_SELECTORS matched an element. */
  selectors?: string[];
  /** The document's HTTP status, when the page exposes it. */
  status?: number;
}

/** The selectors the collector looks for. */
export const CHALLENGE_SELECTORS = [
  "#challenge-form",
  ".cf-turnstile",
  ".g-recaptcha",
  ".h-captcha",
  "#px-captcha",
  'iframe[src*="datadome"]',
  "#sec-if-cpt-container",
] as const;

/** Under this much text, a page with a challenge on it is nothing but the challenge. */
const LITTLE_TEXT = 200;
/** A generic phrase in a page this long is prose that mentions captchas, not a challenge. */
const PHRASE_TEXT_MAX = 1500;
const BLOCKED_STATUS = new Set([403, 429, 503]);

/** One reason to think a vendor is in play. */
interface Evidence {
  signal: string;
  /** Evidence that is a challenge page by itself (an interstitial title, a challenge frame), not a widget. */
  interstitial?: boolean;
  /** Present on ordinary pages of a protected site too (a cookie, a tag): counts only on a page that looks blocked. */
  weak?: boolean;
}

interface Haystack {
  title: string;
  text: string;
  urls: string[];
  cookies: string[];
  selectors: string[];
}

/** Lowercase, accent-free, with typographic apostrophes straightened. */
const norm = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/[‘’]/g, "'").toLowerCase();

const urlHas = (h: Haystack, needle: string): string | undefined => h.urls.find((u) => u.includes(needle));
const selHas = (h: Haystack, needle: string): boolean => h.selectors.some((s) => s.includes(needle));

function add(out: Evidence[], cond: unknown, e: Evidence): void {
  if (cond) out.push(e);
}

type Rule = (h: Haystack) => Evidence[];

const datadome: Rule = (h) => {
  const out: Evidence[] = [];
  const frame = urlHas(h, "captcha-delivery.com");
  add(out, frame, { signal: "captcha-delivery.com", interstitial: true });
  add(out, selHas(h, "datadome"), { signal: "datadome frame" });
  add(out, h.cookies.includes("datadome"), { signal: "datadome cookie", weak: true });
  add(out, urlHas(h, "datadome.co"), { signal: "datadome.co script", weak: true });
  return out;
};

const cloudflare: Rule = (h) => {
  const out: Evidence[] = [];
  const t = h.title.trim();
  add(out, t.includes("just a moment") || t.startsWith("un instant") || t.includes("attention required! | cloudflare"), {
    signal: `title "${h.title.trim()}"`,
    interstitial: true,
  });
  add(out, selHas(h, "#challenge-form"), { signal: "#challenge-form", interstitial: true });
  add(out, urlHas(h, "cf-chl") || urlHas(h, "__cf_chl"), { signal: "cf-chl", interstitial: true });
  add(out, urlHas(h, "/cdn-cgi/challenge-platform/") && !urlHas(h, "turnstile"), { signal: "/cdn-cgi/challenge-platform/", interstitial: true });
  add(
    out,
    h.cookies.some((c) => c.startsWith("cf-chl") || c.startsWith("__cf_chl")),
    { signal: "cf-chl cookie", weak: true },
  );
  add(out, selHas(h, ".cf-turnstile"), { signal: ".cf-turnstile" });
  add(out, urlHas(h, "challenges.cloudflare.com"), { signal: "challenges.cloudflare.com" });
  return out;
};

const perimeterx: Rule = (h) => {
  const out: Evidence[] = [];
  add(out, selHas(h, "px-captcha"), { signal: "#px-captcha", interstitial: true });
  add(out, h.text.includes("press & hold") || h.text.includes("appuyez et maintenez"), { signal: "Press & Hold", interstitial: true });
  add(out, urlHas(h, "captcha.px-cdn.net"), { signal: "captcha.px-cdn.net" });
  const tag = urlHas(h, "px-cdn.net") ?? urlHas(h, "px-cloud.net");
  add(out, tag, { signal: "px script", weak: true });
  add(
    out,
    h.cookies.some((c) => c === "_px3" || c === "_pxvid" || c === "_pxhd"),
    { signal: "_px cookie", weak: true },
  );
  return out;
};

const akamai: Rule = (h) => {
  const out: Evidence[] = [];
  add(out, h.title.includes("access denied") && h.text.includes("reference #"), { signal: "Access Denied + Reference #", interstitial: true });
  add(out, urlHas(h, "sec-if-cpt") || selHas(h, "sec-if-cpt") || selHas(h, "sec-cpt"), { signal: "sec-if-cpt", interstitial: true });
  add(out, urlHas(h, "edgesuite.net") || h.text.includes("edgesuite.net"), { signal: "edgesuite.net" });
  add(out, h.cookies.includes("sec_cpt"), { signal: "sec_cpt cookie", weak: true });
  return out;
};

const imperva: Rule = (h) => {
  const out: Evidence[] = [];
  add(out, h.text.includes("incapsula incident id"), { signal: "Incapsula incident ID", interstitial: true });
  add(out, urlHas(h, "_incapsula_resource") || h.text.includes("_incapsula_resource"), { signal: "_Incapsula_Resource" });
  add(
    out,
    h.cookies.some((c) => c.startsWith("incap_ses")),
    { signal: "incap_ses cookie", weak: true },
  );
  return out;
};

const arkose: Rule = (h) => {
  const out: Evidence[] = [];
  const u = urlHas(h, "arkoselabs.com") ?? urlHas(h, "funcaptcha");
  add(out, u, { signal: u?.includes("funcaptcha") ? "funcaptcha" : "arkoselabs.com" });
  return out;
};

const hcaptcha: Rule = (h) => {
  const out: Evidence[] = [];
  add(out, urlHas(h, "hcaptcha.com"), { signal: "hcaptcha.com" });
  add(out, selHas(h, ".h-captcha"), { signal: ".h-captcha" });
  return out;
};

const recaptcha: Rule = (h) => {
  const out: Evidence[] = [];
  add(out, urlHas(h, "google.com/recaptcha") || urlHas(h, "recaptcha.net"), { signal: "recaptcha frame" });
  add(out, selHas(h, ".g-recaptcha"), { signal: ".g-recaptcha" });
  return out;
};

/**
 * Vendors in order of precedence: the first one with evidence wins, and every
 * vendor beats the generic fallback. Specific interstitial vendors come first
 * (a Cloudflare page also loads Turnstile, a DataDome one may load reCAPTCHA),
 * widget-only vendors last.
 */
const VENDORS: [Exclude<ChallengeKind, "generic">, Rule][] = [
  ["datadome", datadome],
  ["cloudflare", cloudflare],
  ["perimeterx", perimeterx],
  ["akamai", akamai],
  ["imperva", imperva],
  ["arkose", arkose],
  ["hcaptcha", hcaptcha],
  ["recaptcha", recaptcha],
];

const GENERIC_PHRASES = [
  "captcha",
  "are you a robot",
  "are you human",
  "verify you are human",
  "verify you're human",
  "unusual traffic",
  "checking your browser",
  "verifiez que vous etes humain",
  "je ne suis pas un robot",
];

function genericEvidence(h: Haystack, sig: ChallengeSignature): Evidence[] {
  const out: Evidence[] = [];
  const inTitle = GENERIC_PHRASES.find((p) => h.title.includes(p));
  add(out, inTitle, { signal: `title mentions "${inTitle}"` });
  if (h.text.length < PHRASE_TEXT_MAX) {
    const inText = GENERIC_PHRASES.find((p) => h.text.includes(p));
    add(out, inText, { signal: `text mentions "${inText}"` });
  }
  add(out, urlHas(h, "captcha"), { signal: "captcha frame" });
  add(out, sig.status !== undefined && BLOCKED_STATUS.has(sig.status) && sig.status !== 503 && h.text.trim().length < LITTLE_TEXT, {
    signal: `status ${sig.status} with almost no text`,
  });
  return out;
}

/**
 * Decide from a probe whether the page is, or carries, an anti-bot challenge.
 * `blocking` separates an interstitial (vendor interstitial title or frame,
 * status 403/429/503, almost no text) from a widget inside a normal page (a
 * reCAPTCHA checkbox on a login form).
 */
export function classifyChallenge(sig: ChallengeSignature): Challenge | null {
  const text = norm((sig.text ?? "").slice(0, 4096));
  const h: Haystack = {
    title: norm(sig.title),
    text,
    urls: [...(sig.frameUrls ?? []), ...(sig.scriptUrls ?? [])].map(norm),
    cookies: (sig.cookieNames ?? []).map(norm),
    selectors: (sig.selectors ?? []).map(norm),
  };
  const statusBlocked = sig.status !== undefined && BLOCKED_STATUS.has(sig.status);
  const littleText = sig.text !== undefined && sig.text.trim().length < LITTLE_TEXT;
  const blockedish = statusBlocked || littleText;

  const finish = (kind: ChallengeKind, ev: Evidence[]): Challenge => ({
    kind,
    blocking: ev.some((e) => e.interstitial) || blockedish,
    signals: ev.map((e) => e.signal),
  });

  for (const [kind, rule] of VENDORS) {
    const ev = rule(h);
    // Weak evidence alone is just the vendor's tag on an ordinary page.
    if (ev.some((e) => !e.weak) || (ev.length > 0 && blockedish)) return finish(kind, ev);
  }
  const ev = genericEvidence(h, sig);
  return ev.length > 0 ? finish("generic", ev) : null;
}

// --- collector ---------------------------------------------------------------

const PROBE_TIMEOUT_MS = 3000;

/** One evaluate: everything classifyChallenge reads that only the page knows. */
const PROBE = `(() => {
  const sel = ${JSON.stringify(CHALLENGE_SELECTORS)}.filter((s) => { try { return !!document.querySelector(s); } catch { return false; } });
  const nav = performance.getEntriesByType("navigation")[0];
  return {
    url: location.href,
    title: document.title || "",
    text: (document.body ? document.body.innerText : "").slice(0, 4096),
    scriptUrls: Array.from(document.scripts, (s) => s.src).filter(Boolean),
    iframeSrcs: Array.from(document.querySelectorAll("iframe"), (f) => f.src).filter(Boolean),
    cookieNames: document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean),
    selectors: sel,
    status: nav && nav.responseStatus > 0 ? nav.responseStatus : undefined,
  };
})()`;

interface FrameNode {
  frame?: { url?: string };
  childFrames?: FrameNode[];
}

function frameUrls(node: FrameNode | undefined, out: string[] = []): string[] {
  if (!node) return out;
  if (node.frame?.url) out.push(node.frame.url);
  for (const c of node.childFrames ?? []) frameUrls(c, out);
  return out;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Look at the current page for a challenge. Never throws: a page that cannot be inspected reports none. */
export async function detectChallenge(session: { page: CdpSession }): Promise<Challenge | null> {
  try {
    const r = await session.page.send<{ result?: { value?: unknown } }>(
      "Runtime.evaluate",
      { expression: PROBE, returnByValue: true },
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    const v = r.result?.value;
    if (typeof v !== "object" || v === null) return null;
    const p = v as Record<string, unknown>;
    let tree: string[] = [];
    try {
      tree = frameUrls((await session.page.send<{ frameTree?: FrameNode }>("Page.getFrameTree")).frameTree);
    } catch {
      /* the iframes the probe saw still count */
    }
    return classifyChallenge({
      url: typeof p.url === "string" ? p.url : "",
      title: typeof p.title === "string" ? p.title : "",
      text: typeof p.text === "string" ? p.text : undefined,
      frameUrls: [...strings(p.iframeSrcs), ...tree],
      scriptUrls: strings(p.scriptUrls),
      cookieNames: strings(p.cookieNames),
      selectors: strings(p.selectors),
      status: typeof p.status === "number" ? p.status : undefined,
    });
  } catch {
    return null;
  }
}
