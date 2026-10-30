// Asking the person at the machine, before a human handoff brings anything forward.
//
// A handoff (src/browser/read.ts, and a consumer's own batch of them) brings the
// browser forward on a page only a person can get past: a CAPTCHA, an anti-bot
// check, a sign-in. Said on stderr alone, that request reaches nobody when an
// agent runs the command: the agent reads stderr, the person does not, and a
// window simply pops up — or the check times out unseen. So the person is asked
// first, with the one thing every desktop shows whoever is in front of it: a
// native dialog. macOS through `osascript` (`display dialog … giving up after`),
// Linux through `zenity`, `kdialog` or a `notify-send` notification with
// actions, Windows through a PowerShell `WScript.Shell` popup. Each gives up on
// its own after a while (HUMAN_ASK_TIMEOUT_MS, 2 minutes), so a run nobody
// watches never hangs on it; and each is killed a little after that in case it
// does not. Where there is no window, or no tool to ask with, the answer is
// `unavailable` and the caller does what it did before there was a question.
//
// Nothing is ever put into the challenged page itself: an anti-bot script may
// notice a page that changes under it. The question lives outside the browser.
//
// The text follows the person's language — French or English for now — from
// LC_ALL, LC_MESSAGES or LANG, else macOS's AppleLocale, else the runtime's own
// locale. Every command runs through an injectable runner (`run`), so the tests
// see the exact argv without anything appearing on screen.

import { brand, env, envInt } from "./brand.js";
import { canShowWindow } from "./browser/mode.js";
import { have as onPath, type ShResult, shAsync } from "./exec.js";

/**
 * What a handoff does about the person (`<PREFIX>_HUMAN_ASK`): `ask` them first
 * (the default), hand the page over without asking (`always`, as before there
 * was a question), or hand nothing over at all (`never`).
 */
export type HumanAskMode = "ask" | "always" | "never";

/** The caller's choice, else `<PREFIX>_HUMAN_ASK`; anything unknown is `ask`. Read at call time. */
export function humanAskMode(explicit?: string): HumanAskMode {
  const m = (explicit ?? env("HUMAN_ASK"))?.trim().toLowerCase();
  return m === "always" || m === "never" ? m : "ask";
}

/** How long the question waits for an answer, by default: 2 minutes. */
export const HUMAN_ASK_TIMEOUT_MS = 120_000;

/** How long the question waits: `<PREFIX>_HUMAN_ASK_TIMEOUT_MS`, 10 s to an hour, 2 minutes unset. */
export function humanAskTimeoutMs(): number {
  return envInt("HUMAN_ASK_TIMEOUT_MS", HUMAN_ASK_TIMEOUT_MS, 10_000, 3_600_000);
}

/** How long past its own give-up time a dialog may run before it is killed. */
const GRACE_MS = 15_000;

/**
 * The person's answer: `solve` (bring the pages forward now), `later` (bring
 * nothing forward), `no-answer` (the question gave up, or was closed), or
 * `unavailable`: nobody could be asked here — no window, no tool to ask with,
 * or the tool failed — and the caller does what it did before it asked.
 */
export type HumanAnswer = "solve" | "later" | "no-answer" | "unavailable";

export type HumanLang = "en" | "fr";

/** One page waiting for the person. */
export interface HumanAskPage {
  url: string;
  /** What stops it, in any words: "cloudflare challenge", "snippet only — captcha", "login wall". */
  check?: string;
}

/** Runs one command and reads what it said; `shAsync` by default. */
export type HumanAskRunner = (cmd: string, args: string[], opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<ShResult>;

export interface HumanAskOptions {
  /** How long the question waits for an answer; HUMAN_ASK_TIMEOUT_MS by default. */
  timeoutMs?: number;
  /** The language of the text; the person's own (humanLang) by default. */
  lang?: HumanLang;
  /** The dialog's title; the brand's name by default. */
  title?: string;
  platform?: NodeJS.Platform;
  /** The environment the locale and the display are read from; process.env by default. */
  env?: Record<string, string | undefined>;
  /** Test seam: runs each command. */
  run?: HumanAskRunner;
  /** Test seam: whether a command is on PATH (the Linux tools). */
  have?: (cmd: string) => boolean;
  /** Test seam: the runtime's locale, the last word on the language. */
  defaultLocale?: string;
}

const isFrench = (locale: string): boolean => /^fr(?:$|[_.@-])/i.test(locale.trim());

/**
 * The person's language: LC_ALL, then LC_MESSAGES, then LANG — the first one
 * set to a real locale (not C or POSIX) decides — else, on macOS, the
 * AppleLocale of the account, else the runtime's own locale. French or English.
 */
export async function humanLang(opts: Pick<HumanAskOptions, "platform" | "env" | "run" | "defaultLocale"> = {}): Promise<HumanLang> {
  const e = opts.env ?? process.env;
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const v = e[key]?.trim();
    if (!v || /^(?:C|POSIX)(?:$|[.@])/i.test(v)) continue;
    return isFrench(v) ? "fr" : "en";
  }
  if ((opts.platform ?? process.platform) === "darwin") {
    const r = await (opts.run ?? shAsync)("defaults", ["read", "-g", "AppleLocale"], { timeoutMs: 5000 });
    if (r.ok && r.stdout.trim()) return isFrench(r.stdout) ? "fr" : "en";
  }
  return isFrench(opts.defaultLocale ?? Intl.DateTimeFormat().resolvedOptions().locale) ? "fr" : "en";
}

const VENDORS: Record<string, string> = {
  cloudflare: "Cloudflare",
  turnstile: "Cloudflare",
  datadome: "DataDome",
  perimeterx: "PerimeterX",
  akamai: "Akamai",
  imperva: "Imperva",
  arkose: "Arkose",
};

/** What stops a page, said the way a person names it: "CAPTCHA", "Cloudflare check", "sign-in". */
export function humanCheckLabel(check: string | undefined, lang: HumanLang = "en"): string {
  const t = (check ?? "").toLowerCase();
  const fr = lang === "fr";
  if (/captcha/.test(t)) return "CAPTCHA";
  const vendor = /\b(cloudflare|turnstile|datadome|perimeterx|akamai|imperva|arkose)\b/.exec(t)?.[1];
  if (vendor) return fr ? `vérification ${VENDORS[vendor]}` : `${VENDORS[vendor]} check`;
  if (/\b(?:log|sign) ?-?in\b|\bsignin\b/.test(t)) return fr ? "connexion requise" : "sign-in";
  if (/consent|cookie/.test(t)) return fr ? "bandeau de consentement" : "consent wall";
  return fr ? "vérification anti-robot" : "human check";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The words of the question, and of the notification once it is done. */
export interface HumanAskText {
  title: string;
  message: string;
  /** The default button. */
  solve: string;
  later: string;
  /** What the notification says once the person is through: `cleared` of `total` pages. */
  done(cleared: number, total: number): string;
}

/** The sites listed by name; the rest are counted. */
const SITES_SHOWN = 5;

/**
 * The question, for `pages`: which sites are stopped and by what, how many
 * pages wait, and what each answer does. One line per site, at most five.
 */
export function humanAskText(pages: HumanAskPage[], lang: HumanLang = "en", title: string = brand().name): HumanAskText {
  const fr = lang === "fr";
  const sites = new Map<string, { labels: Set<string>; pages: number }>();
  for (const p of pages) {
    const host = hostOf(p.url);
    const site = sites.get(host) ?? { labels: new Set<string>(), pages: 0 };
    site.labels.add(humanCheckLabel(p.check, lang));
    site.pages++;
    sites.set(host, site);
  }
  const lines = [...sites].slice(0, SITES_SHOWN).map(([host, s]) => {
    const n = s.pages > 1 ? ` (${s.pages} pages)` : "";
    return `• ${host} — ${[...s.labels].join(", ")}${n}`;
  });
  const more = sites.size - SITES_SHOWN;
  if (more > 0) lines.push(fr ? `• et ${more} autre(s) site(s)` : `• and ${more} more site(s)`);
  const n = pages.length;
  const head = fr
    ? n === 1
      ? "Une page est bloquée par une vérification humaine :"
      : `${n} pages sont bloquées par une vérification humaine :`
    : n === 1
      ? "A page is stopped by a human check:"
      : `${n} pages are stopped by a human check:`;
  const solve = fr ? "Résoudre" : "Solve it";
  const later = fr ? "Plus tard" : "Later";
  const what = fr
    ? `${solve} : le navigateur passe au premier plan sur chaque page, l'une après l'autre ; passez la vérification et la suite se fait toute seule.\n${later} : rien ne s'affiche, les pages restent de côté pour plus tard.`
    : `${solve}: the browser comes forward on each page in turn; get past the check there and the rest goes on by itself.\n${later}: nothing comes forward; the pages are left for later.`;
  return {
    title,
    message: `${head}\n${lines.join("\n")}\n\n${what}`,
    solve,
    later,
    done: (cleared, total) =>
      fr ? `${cleared} page(s) sur ${total} débloquée(s) — la suite continue.` : `Got past ${cleared} of ${total} page(s) — the run goes on.`,
  };
}

interface Asking {
  text: HumanAskText;
  secs: number;
  timeoutMs: number;
  run: HumanAskRunner;
  has: (cmd: string) => boolean;
}

// macOS: argv carries every string, so nothing in a URL can break out of the script.
const MAC_DIALOG = [
  "on run argv",
  // osascript is no app of its own: brought to the front, or the dialog may open behind the window in use.
  "activate",
  "beep",
  "set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {item 3 of argv, item 4 of argv} default button 2 with icon caution giving up after ((item 5 of argv) as integer)",
  'if gave up of r then return "gave-up"',
  "return button returned of r",
  "end run",
];

async function askMac(a: Asking): Promise<HumanAnswer> {
  const { text } = a;
  const args = [...MAC_DIALOG.flatMap((l) => ["-e", l]), text.message, text.title, text.later, text.solve, String(a.secs)];
  const r = await a.run("osascript", args, { timeoutMs: a.timeoutMs + GRACE_MS });
  if (r.status === 124) return "no-answer";
  // No osascript, or no session to show a dialog in (-1713, "No user interaction allowed": SSH, a daemon):
  // nobody could be asked. Any other failure came after the dialog may have been up — Escape or Cmd-. is
  // -128 — and is read as no answer: nothing comes forward on a question that may have been seen.
  if (r.missing || /-1713\b/.test(r.stderr)) return "unavailable";
  if (!r.ok) return "no-answer";
  const out = r.stdout.trim();
  if (out === text.solve) return "solve";
  if (out === text.later) return "later";
  return "no-answer";
}

async function askLinux(a: Asking): Promise<HumanAnswer> {
  const { text } = a;
  if (a.has("zenity")) {
    const r = await a.run(
      "zenity",
      [
        "--question",
        "--no-markup",
        `--title=${text.title}`,
        `--text=${text.message}`,
        `--ok-label=${text.solve}`,
        `--cancel-label=${text.later}`,
        `--timeout=${a.secs}`,
      ],
      { timeoutMs: a.timeoutMs + GRACE_MS },
    );
    // 0 the default button, 1 the other, 5 the timeout; anything else is zenity failing.
    if (!r.missing) {
      if (r.status === 0) return "solve";
      if (r.status === 1) return "later";
      if (r.status === 5 || r.status === 124) return "no-answer";
    }
  }
  if (a.has("kdialog")) {
    // No timeout of its own: killed at the question's, which reads as no answer.
    const r = await a.run("kdialog", ["--title", text.title, "--yes-label", text.solve, "--no-label", text.later, "--warningyesno", text.message], {
      timeoutMs: a.timeoutMs,
    });
    if (!r.missing) {
      if (r.status === 0) return "solve";
      if (r.status === 1) return "later";
      if (r.status === 124) return "no-answer";
    }
  }
  if (a.has("notify-send")) {
    // A notification with two actions; --action needs libnotify 0.7.10 (2021), and an older one fails, which is `unavailable`.
    const r = await a.run(
      "notify-send",
      [
        `--app-name=${text.title}`,
        "--urgency=critical",
        `--expire-time=${a.timeoutMs}`,
        `--action=solve=${text.solve}`,
        `--action=later=${text.later}`,
        "--wait",
        text.title,
        text.message,
      ],
      { timeoutMs: a.timeoutMs + GRACE_MS },
    );
    if (r.status === 124) return "no-answer";
    if (r.ok) {
      const out = r.stdout.trim();
      return out === "solve" ? "solve" : out === "later" ? "later" : "no-answer";
    }
  }
  return "unavailable";
}

// Windows: a WScript.Shell popup — Yes / No in the system's own words, a timeout of its own (-1), system-modal so it is on top.
const WIN_POPUP =
  "$s = New-Object -ComObject WScript.Shell; [Console]::Out.Write($s.Popup($env:HUMAN_ASK_TEXT, [int]$env:HUMAN_ASK_SECS, $env:HUMAN_ASK_TITLE, 4132))";

async function askWindows(a: Asking, lang: HumanLang): Promise<HumanAnswer> {
  const { text } = a;
  const legend =
    lang === "fr"
      ? `Oui : ${text.solve.toLowerCase()} · Non : ${text.later.toLowerCase()}`
      : `Yes: ${text.solve.toLowerCase()} · No: ${text.later.toLowerCase()}`;
  const r = await a.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_POPUP], {
    timeoutMs: a.timeoutMs + GRACE_MS,
    env: { ...process.env, HUMAN_ASK_TEXT: `${text.message}\n\n${legend}`, HUMAN_ASK_SECS: String(a.secs), HUMAN_ASK_TITLE: text.title },
  });
  if (r.status === 124) return "no-answer";
  if (!r.ok) return "unavailable";
  const out = r.stdout.trim();
  return out === "6" ? "solve" : out === "7" ? "later" : out === "-1" ? "no-answer" : "unavailable";
}

/**
 * Ask the person whether to bring `pages` forward now — once, for all of them:
 * a native dialog naming the sites and what stops them, "Later" and "Solve it"
 * (the default), that gives up on its own after `timeoutMs`. Never throws.
 * `unavailable` with no window anyone can see (no display, a CI run), with
 * nothing to ask with, or when the dialog itself failed.
 */
export async function askHuman(pages: HumanAskPage[], opts: HumanAskOptions = {}): Promise<HumanAnswer> {
  const platform = opts.platform ?? process.platform;
  const e = opts.env ?? process.env;
  if (!pages.length || !canShowWindow(platform, e)) return "unavailable";
  const run = opts.run ?? ((cmd, args, o) => shAsync(cmd, args, o));
  try {
    const lang = opts.lang ?? (await humanLang({ platform, env: e, run, ...(opts.defaultLocale ? { defaultLocale: opts.defaultLocale } : {}) }));
    const timeoutMs = opts.timeoutMs ?? humanAskTimeoutMs();
    const asking: Asking = {
      text: humanAskText(pages, lang, opts.title),
      secs: Math.max(1, Math.round(timeoutMs / 1000)),
      timeoutMs,
      run,
      has: opts.have ?? onPath,
    };
    if (platform === "darwin") return await askMac(asking);
    if (platform === "win32") return await askWindows(asking, lang);
    return await askLinux(asking);
  } catch {
    return "unavailable";
  }
}

/**
 * Say one short thing to the person in a notification that goes away by
 * itself: macOS Notification Center, `notify-send` on Linux. True when it was
 * shown; false where there is nothing to show it with (Windows included) — it
 * is a courtesy, never a question, and never throws.
 */
export async function notifyHuman(message: string, opts: Omit<HumanAskOptions, "timeoutMs" | "lang" | "defaultLocale"> = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  if (!canShowWindow(platform, opts.env ?? process.env)) return false;
  const run = opts.run ?? ((cmd, args, o) => shAsync(cmd, args, o));
  const title = opts.title ?? brand().name;
  try {
    if (platform === "darwin") {
      const script = ["on run argv", 'display notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"', "end run"];
      return (await run("osascript", [...script.flatMap((l) => ["-e", l]), message, title], { timeoutMs: 10_000 })).ok;
    }
    if (platform !== "win32" && (opts.have ?? onPath)("notify-send")) {
      return (await run("notify-send", [`--app-name=${title}`, "--expire-time=6000", title, message], { timeoutMs: 10_000 })).ok;
    }
  } catch {
    /* a courtesy: never the caller's failure */
  }
  return false;
}

/**
 * The notification that ends a handoff the person said yes to: they got past
 * `cleared` of `total` pages and the run goes on — in their language.
 */
export async function notifyHumanDone(cleared: number, total: number, opts: Omit<HumanAskOptions, "timeoutMs"> = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  const e = opts.env ?? process.env;
  if (!canShowWindow(platform, e)) return false;
  const run = opts.run ?? ((cmd, args, o) => shAsync(cmd, args, o));
  const lang =
    opts.lang ?? (await humanLang({ platform, env: e, run, ...(opts.defaultLocale ? { defaultLocale: opts.defaultLocale } : {}) }).catch(() => "en" as const));
  const { lang: _l, defaultLocale: _d, ...rest } = opts;
  return notifyHuman(humanAskText([], lang, opts.title).done(cleared, total), { ...rest, platform, env: e, run });
}
