// A leaf: no imports, so the browser fallback's test (browser/mode.ts) can use it
// without loading fetch.ts. Re-exported from fetch.ts, where it has always been public.

// Consent walls, "enable JavaScript" shells and anti-bot interstitials extract
// to a short block of boilerplate that would otherwise pass as a source's full
// text. Flag such an extraction (returning a short reason) so the gatherer keeps
// only the search snippet instead. A genuine article ABOUT cookies or CAPTCHAs
// is long, so the length gate never trips it.
//
// Short is not enough, though, and neither is one loose phrase. "Access denied"
// is the title of every database-error help page, and "verify you are on Node
// 18" is an install step: a phrase alone flagged them, and rescueViaWayback
// threw the good archived page away. So a pattern is STRONG — worded as only
// the wall itself words it — or weak, and a page is flagged on a strong one
// plus either a second signal or almost nothing else on the page.
const JUNK_PATTERNS: [RegExp, string, "strong" | "weak"][] = [
  [/\b(accept|manage)\s+(all\s+)?cookies\b/i, "cookie/consent wall", "strong"],
  [/\bwe use cookies\b/i, "cookie/consent wall", "strong"],
  [/\bcookie (policy|settings|consent|preferences)\b/i, "cookie/consent wall", "weak"],
  [/\b(accept|reject|allow|decline) all\b/i, "cookie/consent wall", "weak"],
  [/\b(please )?enable javascript\b/i, "JavaScript-required shell", "strong"],
  [/\bjavascript is (disabled|required|not enabled)\b/i, "JavaScript-required shell", "strong"],
  [
    /\bverify(ing)? (that )?(you are|you're) (a )?(human|not a (ro)?bot)\b|\bmaking sure (you are|you're) not a (ro)?bot\b|\bare you a (human|robot)\b|\bhuman verification\b/i,
    "anti-bot interstitial",
    "strong",
  ],
  [/\battention required\b.*cloudflare|\bunusual traffic from your (computer )?network\b|\bchecking your browser\b/i, "anti-bot interstitial", "strong"],
  // Akamai's and Cloudflare's denials carry an incident reference; without one
  // the phrase is as likely a permission-error article.
  [/\baccess denied\b[\s\S]{0,300}?(\breference #|\bray id\b|\bpermission to access\b)/i, "anti-bot interstitial", "strong"],
  // Cloudflare's WAF block page. Its "Attention Required!" is the <title>,
  // which extraction drops, so the body's own wording has to carry it.
  [/\bsorry, you have been blocked\b|\byou are unable to access\b[\s\S]{0,300}?\bray id\b/i, "anti-bot interstitial", "strong"],
  [/\baccess denied\b|\benable cookies\b/i, "anti-bot interstitial", "weak"],
  // FR / DE (the locale layer targets non-EN markets)
  [/\bnous utilisons des cookies\b|\baccepter (tous )?les cookies\b|\bactiver javascript\b/i, "cookie/consent wall (fr)", "strong"],
  [/\bwir verwenden cookies\b|\bcookies akzeptieren\b|\bjavascript aktivieren\b/i, "cookie/consent wall (de)", "strong"],
];

// A challenge page in its own template's words: the heading it opens with or a
// sentence no article would carry. Unlike the rules above these DECIDE on their
// own — prose does not overrule them — because the template ships prose of its
// own: Anubis explains itself in three long paragraphs, which outvoted its one
// strong phrase and let wiki.openfoodfacts.org's challenge pass as the page.
// Tried on the head only, so an article quoting a challenge deep down is safe.
const CHALLENGE_PAGES: [RegExp, string][] = [
  // Anubis (TecharoHQ): its <h1>, and its explanation of itself.
  [/^\W*(?:#+\s*)?making sure you(?:'|’| a)re not a bot\b/i, "anti-bot proof-of-work challenge"],
  [/\bset up anubis to protect (?:the|this) server\b|\bprotected by anubis\b/i, "anti-bot proof-of-work challenge"],
  // Apple's forums interstitial and its kin.
  [/^\W*(?:#+\s*)?security verification in progress\b|\bplease wait while we verify your browser\b/i, "anti-bot interstitial"],
];
// Challenge templates are short pages; a document past this is not one.
const CHALLENGE_MAX_CHARS = 4000;

/**
 * The challenge page a text is, by its template's own wording, or undefined.
 * Decisive: no amount of surrounding prose makes it a document.
 */
export function challengePage(text: string): string | undefined {
  const t = text.trim();
  if (!t || t.length >= CHALLENGE_MAX_CHARS) return undefined;
  const head = t.slice(0, 800);
  return CHALLENGE_PAGES.find(([re]) => re.test(head))?.[1];
}

export function looksLikeJunkExtraction(text: string): string | undefined {
  const t = text.trim();
  const challenge = challengePage(t);
  if (challenge) return challenge;
  if (t.length >= 2000) return undefined; // a real article is long — never flag it
  const head = t.slice(0, 800);
  const hits = JUNK_PATTERNS.filter(([re]) => re.test(head));
  const strong = hits.find(([, , kind]) => kind === "strong");
  if (!strong) return undefined;
  if (hits.length >= 2) return strong[1];
  // A strong phrase alone decides only on a page with nothing else to it:
  // fewer than three lines of prose that no pattern accounts for.
  const prose = t.split("\n").filter((l) => l.trim().length >= 60 && !JUNK_PATTERNS.some(([re]) => re.test(l))).length;
  return prose < 3 ? strong[1] : undefined;
}
