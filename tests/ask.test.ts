import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askHuman,
  HUMAN_ASK_TIMEOUT_MS,
  type HumanAskRunner,
  humanAskMode,
  humanAskText,
  humanAskTimeoutMs,
  humanCheckLabel,
  humanLang,
  notifyHuman,
  notifyHumanDone,
} from "../src/ask.js";
import { envName } from "../src/brand.js";
import type { ShResult } from "../src/exec.js";

// Every command the question would run, recorded; nothing appears on screen.
interface Call {
  cmd: string;
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}
function runner(answer: (c: Call) => Partial<ShResult>): { run: HumanAskRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: HumanAskRunner = async (cmd, args, opts) => {
    const c = { cmd, args, ...opts };
    calls.push(c);
    const r = answer(c);
    return { ok: (r.status ?? 0) === 0 && !r.missing, status: 0, stdout: "", stderr: "", ...r };
  };
  return { run, calls };
}

const PAGES = [
  { url: "https://www.example.com/a", check: "cloudflare challenge" },
  { url: "https://www.example.com/b", check: "snippet only — challenge" },
  { url: "https://shop.test/p", check: "snippet only — recaptcha" },
];
const EN = { LANG: "en_US.UTF-8" };
const FR = { LANG: "fr_FR.UTF-8" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("humanAskMode", () => {
  it("is ask unless the caller or <PREFIX>_HUMAN_ASK says always or never", () => {
    vi.stubEnv(envName("HUMAN_ASK"), "");
    expect(humanAskMode()).toBe("ask");
    vi.stubEnv(envName("HUMAN_ASK"), " NEVER ");
    expect(humanAskMode()).toBe("never");
    vi.stubEnv(envName("HUMAN_ASK"), "always");
    expect(humanAskMode()).toBe("always");
    vi.stubEnv(envName("HUMAN_ASK"), "sometimes");
    expect(humanAskMode()).toBe("ask");
    expect(humanAskMode("never")).toBe("never");
  });

  it("gives the question 2 minutes by default, 10 s to an hour", () => {
    expect(humanAskTimeoutMs()).toBe(HUMAN_ASK_TIMEOUT_MS);
    vi.stubEnv(envName("HUMAN_ASK_TIMEOUT_MS"), "5");
    expect(humanAskTimeoutMs()).toBe(10_000);
    vi.stubEnv(envName("HUMAN_ASK_TIMEOUT_MS"), "45000");
    expect(humanAskTimeoutMs()).toBe(45_000);
  });
});

describe("humanLang", () => {
  it("reads LC_ALL, then LC_MESSAGES, then LANG, skipping C and POSIX", async () => {
    const { run, calls } = runner(() => ({ stdout: "en_US" }));
    expect(await humanLang({ platform: "linux", env: { LANG: "fr_FR.UTF-8" }, run })).toBe("fr");
    expect(await humanLang({ platform: "linux", env: { LC_ALL: "en_GB.UTF-8", LANG: "fr_FR.UTF-8" }, run })).toBe("en");
    expect(await humanLang({ platform: "linux", env: { LC_ALL: "C", LC_MESSAGES: "fr_CA", LANG: "en_US" }, run })).toBe("fr");
    expect(await humanLang({ platform: "linux", env: { LANG: "fr" }, run })).toBe("fr");
    expect(await humanLang({ platform: "linux", env: { LANG: "fy_NL" }, run })).toBe("en");
    expect(calls).toEqual([]);
  });

  it("asks macOS for the account's AppleLocale when no locale variable says", async () => {
    const { run, calls } = runner(() => ({ stdout: "fr_FR\n" }));
    expect(await humanLang({ platform: "darwin", env: { LANG: "C.UTF-8" }, run, defaultLocale: "en-US" })).toBe("fr");
    expect(calls[0]).toMatchObject({ cmd: "defaults", args: ["read", "-g", "AppleLocale"] });
    const failing = runner(() => ({ status: 1 }));
    expect(await humanLang({ platform: "darwin", env: {}, run: failing.run, defaultLocale: "fr-FR" })).toBe("fr");
  });

  it("falls back to the runtime's locale elsewhere", async () => {
    const { run } = runner(() => ({}));
    expect(await humanLang({ platform: "win32", env: {}, run, defaultLocale: "fr-BE" })).toBe("fr");
    expect(await humanLang({ platform: "linux", env: {}, run, defaultLocale: "de-DE" })).toBe("en");
  });
});

describe("humanAskText", () => {
  it("names each site once, with what stops it and how many pages wait", () => {
    const t = humanAskText(PAGES, "en", "ultrasearch");
    expect(t.title).toBe("ultrasearch");
    expect(t.solve).toBe("Solve it");
    expect(t.later).toBe("Later");
    expect(t.message).toContain("3 pages are stopped by a human check:");
    expect(t.message).toContain("• www.example.com — Cloudflare check, human check (2 pages)");
    expect(t.message).toContain("• shop.test — CAPTCHA");
    expect(t.message).toContain("Later: nothing comes forward");
    expect(t.done(2, 3)).toBe("Got past 2 of 3 page(s) — the run goes on.");
  });

  it("speaks French", () => {
    const t = humanAskText([PAGES[0] as (typeof PAGES)[number]], "fr", "ultrasearch");
    expect(t.message).toContain("Une page est bloquée par une vérification humaine :");
    expect(t.message).toContain("• www.example.com — vérification Cloudflare");
    expect([t.solve, t.later]).toEqual(["Résoudre", "Plus tard"]);
    expect(t.done(1, 1)).toBe("1 page(s) sur 1 débloquée(s) — la suite continue.");
  });

  it("lists five sites and counts the rest", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ url: `https://s${i}.test/`, check: "captcha" }));
    const t = humanAskText(many, "en", "x");
    expect(t.message.match(/^• /gm)).toHaveLength(6);
    expect(t.message).toContain("• and 3 more site(s)");
  });

  it("labels the checks a person would name", () => {
    expect(humanCheckLabel("hcaptcha challenge")).toBe("CAPTCHA");
    expect(humanCheckLabel("datadome challenge")).toBe("DataDome check");
    expect(humanCheckLabel("login wall")).toBe("sign-in");
    expect(humanCheckLabel("cookie/consent wall", "fr")).toBe("bandeau de consentement");
    expect(humanCheckLabel(undefined, "fr")).toBe("vérification anti-robot");
  });
});

describe("askHuman on macOS", () => {
  const mac = (stdout: string, extra: Partial<ShResult> = {}) => runner((c) => (c.cmd === "osascript" ? { stdout, ...extra } : {}));

  it("shows one dialog, argv-borne, with Later and Solve it (the default), a beep, and a give-up time", async () => {
    const { run, calls } = mac("Solve it\n");
    expect(await askHuman(PAGES, { platform: "darwin", env: EN, run, timeoutMs: 30_000, title: "ultrasearch" })).toBe("solve");
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c?.cmd).toBe("osascript");
    const script = c?.args.filter((_, i, a) => a[i - 1] === "-e").join("\n") ?? "";
    expect(script).toContain("beep");
    expect(script).toContain("activate");
    expect(script).toContain("default button 2");
    expect(script).toContain("giving up after");
    // The strings ride in argv, after the script: nothing in a URL is ever AppleScript.
    expect(c?.args.slice(-5)).toEqual([expect.stringContaining("www.example.com"), "ultrasearch", "Later", "Solve it", "30"]);
    expect(script).not.toContain("example.com");
    expect(c?.timeoutMs).toBeGreaterThan(30_000);
  });

  it("reads Later, a give-up, a dismissal and a failure", async () => {
    expect(await askHuman(PAGES, { platform: "darwin", env: EN, run: mac("Later").run })).toBe("later");
    expect(await askHuman(PAGES, { platform: "darwin", env: EN, run: mac("gave-up").run })).toBe("no-answer");
    expect(await askHuman(PAGES, { platform: "darwin", env: EN, run: mac("", { status: 1, stderr: "execution error: User canceled. (-128)" }).run })).toBe(
      "no-answer",
    );
    expect(await askHuman(PAGES, { platform: "darwin", env: EN, run: mac("", { status: 124 }).run })).toBe("no-answer");
    expect(await askHuman(PAGES, { platform: "darwin", env: EN, run: mac("", { status: 1, stderr: "No user interaction allowed. (-1713)" }).run })).toBe(
      "unavailable",
    );
    expect(await askHuman(PAGES, { platform: "darwin", env: EN, run: mac("", { status: 127, missing: true }).run })).toBe("unavailable");
    // Failing once the dialog may have been up: nothing comes forward on it.
    expect(await askHuman(PAGES, { platform: "darwin", env: EN, run: mac("", { status: 1, stderr: "AppleEvent timed out. (-1712)" }).run })).toBe("no-answer");
    expect(await askHuman(PAGES, { platform: "darwin", env: EN, run: mac("something else").run })).toBe("no-answer");
  });

  it("asks in French for a French locale", async () => {
    const { run, calls } = mac("Résoudre");
    expect(await askHuman(PAGES, { platform: "darwin", env: FR, run })).toBe("solve");
    expect(calls[0]?.args.slice(-3, -1)).toEqual(["Plus tard", "Résoudre"]);
  });

  it("asks nobody in a CI run, or about nothing", async () => {
    const { run, calls } = mac("Solve it");
    expect(await askHuman(PAGES, { platform: "darwin", env: { CI: "true" }, run })).toBe("unavailable");
    expect(await askHuman([], { platform: "darwin", env: EN, run })).toBe("unavailable");
    expect(calls).toEqual([]);
  });
});

describe("askHuman on Linux", () => {
  const DESKTOP = { ...EN, DISPLAY: ":0" };

  it("asks with zenity first: its exit code is the answer", async () => {
    for (const [status, answer] of [
      [0, "solve"],
      [1, "later"],
      [5, "no-answer"],
    ] as const) {
      const { run, calls } = runner(() => ({ status }));
      expect(await askHuman(PAGES, { platform: "linux", env: DESKTOP, run, have: () => true, timeoutMs: 20_000 })).toBe(answer);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.cmd).toBe("zenity");
      expect(calls[0]?.args).toEqual(expect.arrayContaining(["--question", "--no-markup", "--ok-label=Solve it", "--cancel-label=Later", "--timeout=20"]));
    }
  });

  it("falls to kdialog, then to a notification with actions", async () => {
    const k = runner(() => ({ status: 0 }));
    expect(await askHuman(PAGES, { platform: "linux", env: DESKTOP, run: k.run, have: (c) => c === "kdialog" })).toBe("solve");
    expect(k.calls[0]?.args).toEqual(expect.arrayContaining(["--yes-label", "Solve it", "--no-label", "Later", "--warningyesno"]));
    const n = runner(() => ({ stdout: "later\n" }));
    expect(await askHuman(PAGES, { platform: "linux", env: DESKTOP, run: n.run, have: (c) => c === "notify-send" })).toBe("later");
    expect(n.calls[0]?.args).toEqual(expect.arrayContaining(["--action=solve=Solve it", "--action=later=Later", "--wait"]));
    const closed = runner(() => ({ stdout: "" }));
    expect(await askHuman(PAGES, { platform: "linux", env: DESKTOP, run: closed.run, have: (c) => c === "notify-send" })).toBe("no-answer");
  });

  it("is unavailable with nothing to ask with, or no display", async () => {
    const { run, calls } = runner(() => ({}));
    expect(await askHuman(PAGES, { platform: "linux", env: DESKTOP, run, have: () => false })).toBe("unavailable");
    expect(await askHuman(PAGES, { platform: "linux", env: EN, run, have: () => true })).toBe("unavailable");
    // An old notify-send without --action fails: unavailable, not "later".
    const old = runner(() => ({ status: 1, stderr: "Unknown option --action" }));
    expect(await askHuman(PAGES, { platform: "linux", env: DESKTOP, run: old.run, have: (c) => c === "notify-send" })).toBe("unavailable");
    expect(calls).toEqual([]);
  });
});

describe("askHuman on Windows", () => {
  it("asks with a PowerShell popup whose text rides in the environment", async () => {
    for (const [stdout, answer] of [
      ["6", "solve"],
      ["7", "later"],
      ["-1", "no-answer"],
      ["", "unavailable"],
    ] as const) {
      const { run, calls } = runner(() => ({ stdout }));
      expect(await askHuman(PAGES, { platform: "win32", env: FR, run, timeoutMs: 60_000 })).toBe(answer);
      expect(calls[0]?.cmd).toBe("powershell.exe");
      expect(calls[0]?.args.at(-1)).toContain("WScript.Shell");
      expect(calls[0]?.args.join(" ")).not.toContain("example.com");
      expect(calls[0]?.env?.HUMAN_ASK_TEXT).toContain("Oui : résoudre · Non : plus tard");
      expect(calls[0]?.env?.HUMAN_ASK_SECS).toBe("60");
    }
  });
});

describe("notifyHuman", () => {
  it("posts a macOS notification, a notify-send one on Linux, and nothing on Windows or in CI", async () => {
    const mac = runner(() => ({}));
    expect(await notifyHuman("done", { platform: "darwin", env: EN, run: mac.run, title: "ultrasearch" })).toBe(true);
    expect(mac.calls[0]?.cmd).toBe("osascript");
    expect(mac.calls[0]?.args.slice(-2)).toEqual(["done", "ultrasearch"]);
    const linux = runner(() => ({}));
    expect(await notifyHuman("done", { platform: "linux", env: { DISPLAY: ":0" }, run: linux.run, have: () => true })).toBe(true);
    expect(linux.calls[0]?.cmd).toBe("notify-send");
    const none = runner(() => ({}));
    expect(await notifyHuman("done", { platform: "win32", env: {}, run: none.run })).toBe(false);
    expect(await notifyHuman("done", { platform: "darwin", env: { CI: "1" }, run: none.run })).toBe(false);
    expect(none.calls).toEqual([]);
  });

  it("says how it went, in the person's language", async () => {
    const { run, calls } = runner(() => ({}));
    expect(await notifyHumanDone(2, 2, { platform: "darwin", env: FR, run })).toBe(true);
    expect(calls[0]?.args.at(-2)).toBe("2 page(s) sur 2 débloquée(s) — la suite continue.");
  });
});
