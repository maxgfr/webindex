import { challengePage, looksLikeJunkExtraction } from "./junk.js";

// What a read must carry before it is worth citing — the layer over
// `looksLikeJunkExtraction` that consumers kept to themselves.
//
// The junk detector rates "enable cookies" WEAK, so on its own it never fires on
// PubMed's "Cookies must be enabled. Enable cookies for pubmed.ncbi.nlm.nih.gov
// and reload this page to continue." — and 38 such notices once went into a
// dossier as their own text. The patterns below are the walls the junk detector
// does not know, and the length floor is the net under all of them: a page that
// carries fewer than MIN_USEFUL_CHARS characters of prose is not a document
// anyone can check a claim against, whatever it says. Pure: no I/O, no cache.

/** Below this many characters of prose (headings excluded), a read is not content. */
export const MIN_USEFUL_CHARS = 300;

// [pattern, kind]. Each one is a wall ON ITS OWN — unlike the junk detector's
// weak rules — so they are only ever tried on a SHORT text (see wallPattern): an
// article that discusses cookie walls is long, a cookie wall is not.
const LOCAL_WALLS: [RegExp, string][] = [
  [/\bcookies? (must|need to|have to|should) be (enabled|turned on|allowed)\b/i, "cookie wall"],
  [/\benable cookies (for|on|in)\b[\s\S]{0,160}?\b(reload|refresh|continue)\b/i, "cookie wall"],
  [/\b(your browser|this browser) (does not|doesn't) (accept|support) cookies\b/i, "cookie wall"],
  [/\bwe value your privacy\b[\s\S]{0,600}?\b(accept|agree|consent)\b/i, "cookie/consent wall"],
  [/\b(accept|allow) all cookies\b[\s\S]{0,400}?\b(reject|decline|manage|settings|preferences)\b/i, "cookie/consent wall"],
  [/\b(please )?(enable|turn on) javascript\b[\s\S]{0,120}?\b(to continue|to proceed|and reload|and refresh|to view|to use)\b/i, "JavaScript-required shell"],
  [/\byou need to enable javascript to run this app\b/i, "JavaScript-required shell"],
  [/\bpour continuer,? (veuillez )?activer (les cookies|javascript)\b|\bles cookies doivent être activés\b/i, "cookie wall (fr)"],
];

// Only a short text can be a wall: the same ceiling the junk detector applies.
const WALL_MAX_CHARS = 2000;

/** Characters of prose in a read: heading lines dropped, whitespace collapsed. */
export function usefulChars(text: string): number {
  return text
    .split("\n")
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim().length;
}

// A wall talks TO the reader — "you", "your browser", "accept", "enable",
// "reload" — while the prose of a document talks about its subject. Lines of
// the second kind are what a wall verdict has to outweigh.
const ADDRESSES_READER = /\b(you|your|yours|vous|votre|vos)\b/i;
const ADDRESSES_READER_DE = /\b(Sie|Ihr|Ihre|Ihnen)\b/;
const IMPERATIVE =
  /^\W*(please\s+)?(accept|allow|agree|enable|turn on|reload|refresh|click|tap|continue|manage|reject|decline|sign in|log in|subscribe|veuillez|acceptez|activez|cliquez|continuer)\b/i;

/**
 * True when the text is mostly a document's own prose: three lines or more of
 * 60+ characters that neither address the reader nor are a known wall phrase,
 * carrying at least 60 % of the text. A cookie banner or a "please enable
 * JavaScript" line above three real paragraphs does not make the page a wall —
 * nor does an article that discusses cookie walls, which the junk detector's
 * own rule (two pattern hits are a wall, whatever surrounds them) calls one.
 */
export function proseOutweighsWall(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => l.length >= 60 && !ADDRESSES_READER.test(l) && !ADDRESSES_READER_DE.test(l) && !IMPERATIVE.test(l) && !LOCAL_WALLS.some(([re]) => re.test(l)),
    );
  if (lines.length < 3) return false;
  const prose = lines.reduce((n, l) => n + l.length, 0);
  return prose >= 0.6 * text.replace(/\s+/g, " ").trim().length;
}

/**
 * The wall a text IS, by its wording: the junk detector's verdict first, then
 * the local patterns — either one overruled when the text is mostly real prose
 * (`proseOutweighsWall`). No length rule — a consumer re-checking a dossier
 * gathered before the floor existed may legitimately hold a short snippet.
 */
export function wallPattern(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  // A challenge template carries prose of its own; it never outweighs the page being one.
  const challenge = challengePage(t);
  if (challenge) return challenge;
  const junk = looksLikeJunkExtraction(t);
  const local = junk || t.length >= WALL_MAX_CHARS ? undefined : LOCAL_WALLS.find(([re]) => re.test(t.slice(0, 800)))?.[1];
  const wall = junk ?? local;
  return wall && !proseOutweighsWall(t) ? wall : undefined;
}

/**
 * Why a fresh read is not content, or undefined when it is: a wall by its
 * wording, or a page too thin to carry a claim. The name a read is refused or
 * demoted under, so it reads in a sentence: "extracted to a cookie wall".
 */
export function looksLikeWall(text: string): string | undefined {
  const wall = wallPattern(text);
  if (wall) return wall;
  const n = usefulChars(text);
  return n < MIN_USEFUL_CHARS ? `near-empty page (${n} useful characters)` : undefined;
}

/** True when `looksLikeWall`'s verdict is a wall by wording, not just a thin page. */
export function isWordedWall(reason: string | undefined): boolean {
  return !!reason && !reason.startsWith("near-empty page");
}

// Where a read lands when the host put a challenge in front of the page: the
// path of an anti-bot interstitial, an "abuse detection" apology or a CAPTCHA
// gate, never of a document. Matched on the path (and the query, where some
// vendors put their marker), so a page ABOUT CAPTCHAs is not one.
const CHALLENGE_URLS: RegExp[] = [
  /\/apology_objects?\//i, // fda.gov and other Akamai-fronted sites: abuse-detection-apology.html
  /\/abuse[-_]detection\b/i,
  /\/verify[-_]human\//i, // developer.apple.com/forums/verify-human/verify.html
  /\/cdn-cgi\/challenge-platform\//i, // Cloudflare
  /[?&]__cf_chl_\w*=/i,
  /\/\.within\.website\/x\/cmd\/anubis\//i, // Anubis
  /\/\.well-known\/sgcaptcha\b/i, // SiteGround
  /\/_incapsula_resource\b/i, // Imperva
  /\/distil_r_(?:captcha|blocked)\b/i, // Distil
  // A gate at the site's root; anywhere deeper (/wiki/CAPTCHA) it is a topic.
  /^\/(?:captcha|bot[-_]?check|are[-_]you[-_](?:a[-_])?(?:human|robot))(?:\/|\.html?\b|$|\?)/i,
];

/**
 * "anti-bot challenge page" when a URL is where a host parks a request it will
 * not serve — the address a blocked read was redirected to — or undefined. A
 * read that ends there did not reach the page it asked for, whatever its status.
 */
export function challengeUrl(url: string): string | undefined {
  let target: string;
  try {
    const u = new URL(url);
    target = `${u.pathname}${u.search}`;
  } catch {
    return undefined;
  }
  return CHALLENGE_URLS.some((re) => re.test(target)) ? "anti-bot challenge page" : undefined;
}
