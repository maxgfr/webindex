// `<cli> browser <action> …`: the command line over the browser, one action per call.
//
// Library-safe: nothing here prints, exits or reads stdin. runBrowserCommand
// returns what to print and the exit code, and src/cli.ts prints it — 0 done,
// 1 ran and failed (a stale ref, a timeout, a guard refusal, a page error),
// 2 the invocation was wrong. Stdin, for `eval -`, is handed in.
//
// Every command that touches a page runs inside withPage: under the browser
// lock, reconnected to the tab the last call left, detached at the end — the
// browser stays up for the next call. `status`, `close`, `network` and
// `profile` never launch a browser.

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { brand, envName } from "../brand.js";
import { UsageError } from "../cli-kit.js";
import { isNoWrite } from "../no-write.js";
import * as actions from "./actions.js";
import type { ActionOptions, ActionResult, DialogInfo } from "./actions.js";
import type { Challenge } from "./challenge.js";
import { detectChallenge } from "./challenge.js";
import { type BrowserDeps, browserDeps } from "./deps.js";
import { clearNetworkLog, getNetworkEntry, listNetwork, NetworkRecorder } from "./network.js";
import { importProfile, profileDir, resetProfile } from "./profile.js";
import { type BrowserSession, type BrowserStatus, type BrowserTab, browserStatus, closeBrowser, type OpenOptions, withPage } from "./session.js";
import { type SnapshotOptions, type SnapshotResult, takeSnapshot } from "./snapshot.js";
import { readSession } from "./state.js";
import { settle, type WaitCondition, waitFor } from "./wait.js";

/** The flags a browser command reads, already parsed and checked by the caller. */
export interface BrowserCliFlags {
  json?: boolean;
  /** open: work in a fresh tab. */
  newTab?: boolean;
  headless?: boolean;
  /** Dedicated profile name (`default`). */
  profile?: string;
  /** An already-running browser: port, host:port or URL, loopback only. */
  cdp?: string;
  /** Record the JSON the page fetches while the command runs. */
  capture?: boolean;
  /** Append the snapshot taken after the command. */
  snapshot?: boolean;
  interactive?: boolean;
  maxChars?: number;
  /** The user said yes to this very action: past the irreversibility guard. */
  confirm?: boolean;
  submit?: boolean;
  text?: string;
  gone?: string;
  selector?: string;
  url?: string;
  idle?: boolean;
  load?: boolean;
  clear?: boolean;
  ms?: number;
  /** wait, back, forward, reload: how long, in ms. */
  timeout?: number;
  full?: boolean;
  out?: string;
  all?: boolean;
  force?: boolean;
}

export interface BrowserCliDeps {
  browser?: Partial<BrowserDeps>;
  /** Stdin as text, read only for `eval -`. */
  stdin?: () => string;
  /** Where relative paths (upload, --out) are resolved; process.cwd() by default. */
  cwd?: string;
}

export interface BrowserCliResult {
  /** What `--json` prints: one document. */
  json: unknown;
  /** What is printed without --json; on failure, the message for stderr. */
  text: string;
  exitCode: 0 | 1 | 2;
  /** A screenshot written to disk. */
  image?: { path: string };
}

const USAGE = {
  open: "open <url> [--new-tab] [--headless] [--profile <n>] [--capture] [--snapshot]",
  attach: "attach <port|url>",
  status: "status",
  close: "close [--all]",
  snapshot: "snapshot [<ref>] [--interactive] [--max-chars <n>]",
  click: "click <ref> [--confirm]",
  hover: "hover <ref>",
  type: "type <ref> <text> [--submit] [--confirm]",
  fill: "fill <ref> <text>",
  select: "select <ref> <value…>",
  press: "press <key> [--confirm]",
  upload: "upload <ref> <file…>",
  scroll: "scroll <ref|up|down|top|bottom>",
  wait: "wait --text <s> | --gone <s> | --selector <css> | --url <pattern> | --idle | --load | --clear | --ms <n> [--timeout <ms>]",
  eval: "eval <expr|->",
  screenshot: "screenshot [<ref>] [--full] [--out <file>]",
  network: "network [list|get <n>|clear]",
  tabs: "tabs [list|new [<url>]|select <tN>|close <tN>]",
  back: "back [--timeout <ms>]",
  forward: "forward [--timeout <ms>]",
  reload: "reload [--timeout <ms>]",
  dialog: "dialog accept [<prompt text>] | dismiss",
  profile: "profile import <chrome|brave|chromium|edge|path> [--force] | reset | path",
} as const;

type Action = keyof typeof USAGE;

/** Every action `<cli> browser` takes. */
export const BROWSER_ACTIONS = Object.keys(USAGE) as Action[];

const SNAPSHOT_MAX_CHARS = 20_000;

interface Ctx {
  action: Action;
  args: string[];
  flags: BrowserCliFlags;
  deps: BrowserCliDeps;
}

type Out = Omit<BrowserCliResult, "exitCode">;

const cliName = (): string => brand().cli;
const usageError = (action: Action): UsageError => new UsageError(`usage: ${cliName()} browser ${USAGE[action]}`);

/** Throw the action's usage unless it got between `min` and `max` arguments. */
function arity(ctx: Ctx, min: number, max = min): void {
  if (ctx.args.length < min || ctx.args.length > max) throw usageError(ctx.action);
}

/**
 * Run one `browser` action. Never throws and never prints: a bad invocation is
 * exit 2, any failure exit 1, each with its message in `text`.
 */
export async function runBrowserCommand(action: string, args: string[], flags: BrowserCliFlags = {}, deps: BrowserCliDeps = {}): Promise<BrowserCliResult> {
  try {
    if (!Object.hasOwn(HANDLERS, action)) throw new UsageError(`usage: ${cliName()} browser ${BROWSER_ACTIONS.join("|")}`);
    const out = await HANDLERS[action as Action]({ action: action as Action, args, flags, deps });
    return { ...out, exitCode: 0 };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { json: { ok: false, error }, text: error, exitCode: e instanceof UsageError ? 2 : 1 };
  }
}

// --- shared pieces -----------------------------------------------------------

function onPage<T>(ctx: Ctx, fn: (s: BrowserSession) => Promise<T>, extra: Partial<OpenOptions> = {}): Promise<T> {
  const { cdp, profile, headless } = ctx.flags;
  const opts: OpenOptions = {
    ...(cdp !== undefined ? { cdp } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(headless ? { headless } : {}),
    ...(ctx.deps.browser ? { deps: ctx.deps.browser } : {}),
    ...extra,
  };
  return withPage(opts, fn);
}

const actOpts = (ctx: Ctx): ActionOptions => (ctx.deps.browser ? { deps: ctx.deps.browser } : {});

const snapOpts = (ctx: Ctx, ref?: string): SnapshotOptions => ({
  maxChars: ctx.flags.maxChars ?? SNAPSHOT_MAX_CHARS,
  ...(ctx.flags.interactive ? { interactive: true } : {}),
  ...(ref !== undefined ? { ref } : {}),
});

/** Run `fn` with a NetworkRecorder on the page when --capture asks; how many JSON responses it kept. */
async function capturing<T>(ctx: Ctx, s: BrowserSession, fn: () => Promise<T>): Promise<{ value: T; captured?: number }> {
  if (!ctx.flags.capture) return { value: await fn() };
  const rec = new NetworkRecorder(s);
  await rec.start();
  let stopped = false;
  try {
    const value = await fn();
    stopped = true;
    return { value, captured: (await rec.stop()).length };
  } finally {
    // On a throw: detach, and keep what was recorded before it.
    if (!stopped) await rec.stop().catch(() => {});
  }
}

const show = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "undefined" : JSON.stringify(v));
const pretty = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "undefined" : JSON.stringify(v, null, 2));

const where = (url: string, title: string): string => `${url}${title ? ` — ${title}` : ""}`;

const dialogLine = (d: DialogInfo): string =>
  `dialog ${d.type}: ${JSON.stringify(d.message)} — it is still open: \`${cliName()} browser dialog accept|dismiss\``;

const challengeLine = (c: Challenge): string =>
  `challenge: ${c.kind}${c.blocking ? " (blocking)" : ""} — let the human solve it, then \`${cliName()} browser wait --clear\``;

const capturedLine = (n: number): string => `captured ${n} JSON response${n === 1 ? "" : "s"} — \`${cliName()} browser network list\``;

function actionText(r: ActionResult, captured: number | undefined, snap: SnapshotResult | undefined): string {
  const lines = [`${r.action}${r.ref !== undefined ? ` ${r.ref}` : ""}: ${r.navigated ? "navigated to " : ""}${where(r.url, r.title)}`];
  // What the action yields (the options chosen, the scroll position); an empty protocol answer says nothing.
  if (r.value !== undefined && !(typeof r.value === "object" && r.value !== null && Object.keys(r.value).length === 0)) lines.push(`  value: ${show(r.value)}`);
  if (r.dialog) lines.push(dialogLine(r.dialog));
  if (r.challenge) lines.push(challengeLine(r.challenge));
  if (captured !== undefined) lines.push(capturedLine(captured));
  if (snap) lines.push("", snap.text);
  return lines.join("\n");
}

/**
 * An action that can change the page: run it (recording the network with
 * --capture), then take the snapshot --snapshot asks for — unless a dialog is
 * open, which freezes the page until it is answered.
 */
function mutate(ctx: Ctx, run: (s: BrowserSession, o: ActionOptions) => Promise<ActionResult>): Promise<Out> {
  return onPage(ctx, async (s) => {
    const { value: r, captured } = await capturing(ctx, s, () => run(s, actOpts(ctx)));
    const snap = ctx.flags.snapshot && !r.dialog ? await takeSnapshot(s, snapOpts(ctx)) : undefined;
    return {
      json: { ...r, ...(captured !== undefined ? { captured } : {}), ...(snap ? { snapshot: snap } : {}) },
      text: actionText(r, captured, snap),
    };
  });
}

/** The ref and the rest of the arguments joined with one space (the text of type and fill). */
function refAndText(ctx: Ctx): [string, string] {
  if (ctx.args.length < 2) throw usageError(ctx.action);
  return [ctx.args[0] as string, ctx.args.slice(1).join(" ")];
}

const confirm = (ctx: Ctx) => (ctx.flags.confirm ? { confirm: true } : {});
const historyOpts = (ctx: Ctx) => (ctx.flags.timeout !== undefined ? { timeoutMs: ctx.flags.timeout } : {});

function tabLines(tabs: BrowserTab[]): string {
  return tabs.map((t) => `${t.active ? "*" : " "} ${t.id}  ${where(t.url, t.title)}`).join("\n");
}

function statusText(st: BrowserStatus): string {
  if (!st.alive) return st.port === undefined ? "no browser session" : `no browser answers on port ${st.port} any more`;
  const owner = st.launchedByUs ? `launched by ${brand().name}` : "attached, not ours: close only forgets it";
  const head = `browser on port ${st.port} (${owner}), profile ${st.profile}${st.headless ? ", headless" : ""}`;
  return [head, tabLines(st.tabs ?? [])].filter(Boolean).join("\n");
}

/** The current tab of the saved session, for the commands that read its files only. */
function currentTarget(): string {
  const saved = readSession();
  if (!saved) throw new Error(`no browser session: \`${cliName()} browser open <url> --capture\` records what a page fetches`);
  return saved.targetId;
}

// --- the actions ---------------------------------------------------------------

const HANDLERS: Record<Action, (ctx: Ctx) => Promise<Out>> = {
  async open(ctx) {
    arity(ctx, 1);
    const url = ctx.args[0] as string;
    return onPage(
      ctx,
      async (s) => {
        const { value: nav, captured } = await capturing(ctx, s, async () => {
          const nav = await s.navigate(url);
          await settle(s, actOpts(ctx));
          return nav;
        });
        const title = await s.title();
        const challenge = await detectChallenge(s);
        const snap = ctx.flags.snapshot ? await takeSnapshot(s, snapOpts(ctx)) : undefined;
        const lines = [`${where(nav.url, title)}${nav.status !== undefined ? ` (HTTP ${nav.status})` : ""}`];
        if (challenge) lines.push(challengeLine(challenge));
        if (captured !== undefined) lines.push(capturedLine(captured));
        if (snap) lines.push("", snap.text);
        return {
          json: {
            ok: true,
            url: nav.url,
            title,
            ...(nav.status !== undefined ? { status: nav.status } : {}),
            tab: s.targetId,
            challenge,
            ...(captured !== undefined ? { captured } : {}),
            ...(snap ? { snapshot: snap } : {}),
          },
          text: lines.join("\n"),
        };
      },
      ctx.flags.newTab ? { newTab: true } : {},
    );
  },

  async attach(ctx) {
    arity(ctx, 1);
    // resolveEndpoint checks the address is loopback and answers; the session
    // it saves is marked as not ours, so `close` never shuts that browser down.
    const st = await withPage({ cdp: ctx.args[0] as string, ...(ctx.deps.browser ? { deps: ctx.deps.browser } : {}) }, (s) => s.status());
    return { json: st, text: statusText(st) };
  },

  async status(ctx) {
    arity(ctx, 0);
    const st = await browserStatus(ctx.deps.browser ? { deps: ctx.deps.browser } : {});
    return { json: st, text: statusText(st) };
  },

  async close(ctx) {
    arity(ctx, 0);
    const had = readSession();
    const r = await closeBrowser({
      ...(ctx.flags.all ? { all: true } : {}),
      ...(ctx.flags.profile !== undefined ? { profile: ctx.flags.profile } : {}),
      ...(ctx.deps.browser ? { deps: ctx.deps.browser } : {}),
    });
    const text = r.closed
      ? "closed the browser"
      : had && !had.launchedByUs
        ? `forgot the browser on port ${had.port}; it is not ours, so it was left running`
        : "no browser to close";
    return { json: r, text };
  },

  async snapshot(ctx) {
    arity(ctx, 0, 1);
    const r = await onPage(ctx, (s) => takeSnapshot(s, snapOpts(ctx, ctx.args[0])));
    return { json: r, text: r.text };
  },

  async click(ctx) {
    arity(ctx, 1);
    return mutate(ctx, (s, o) => actions.click(s, ctx.args[0] as string, { ...o, ...confirm(ctx) }));
  },

  async hover(ctx) {
    arity(ctx, 1);
    return mutate(ctx, (s, o) => actions.hover(s, ctx.args[0] as string, o));
  },

  async type(ctx) {
    const [ref, text] = refAndText(ctx);
    return mutate(ctx, (s, o) => actions.typeText(s, ref, text, { ...o, ...confirm(ctx), ...(ctx.flags.submit ? { submit: true } : {}) }));
  },

  async fill(ctx) {
    const [ref, text] = refAndText(ctx);
    return mutate(ctx, (s, o) => actions.fill(s, ref, text, o));
  },

  async select(ctx) {
    arity(ctx, 2, Number.POSITIVE_INFINITY);
    return mutate(ctx, (s, o) => actions.select(s, ctx.args[0] as string, ctx.args.slice(1), o));
  },

  async press(ctx) {
    arity(ctx, 1);
    return mutate(ctx, (s, o) => actions.press(s, ctx.args[0] as string, { ...o, ...confirm(ctx) }));
  },

  async upload(ctx) {
    arity(ctx, 2, Number.POSITIVE_INFINITY);
    const cwd = ctx.deps.cwd ?? process.cwd();
    // Checked here, before a browser is reached for, so a typo costs nothing.
    const files = ctx.args.slice(1).map((f) => {
      const path = resolve(cwd, f);
      if (!existsSync(path) || !statSync(path).isFile()) throw new UsageError(`no such file: ${path}`);
      return path;
    });
    return mutate(ctx, (s, o) => actions.upload(s, ctx.args[0] as string, files, o));
  },

  async scroll(ctx) {
    arity(ctx, 1);
    return mutate(ctx, (s, o) => actions.scroll(s, ctx.args[0] as string, o));
  },

  async back(ctx) {
    arity(ctx, 0);
    return mutate(ctx, (s, o) => actions.back(s, { ...o, ...historyOpts(ctx) }));
  },

  async forward(ctx) {
    arity(ctx, 0);
    return mutate(ctx, (s, o) => actions.forward(s, { ...o, ...historyOpts(ctx) }));
  },

  async reload(ctx) {
    arity(ctx, 0);
    return mutate(ctx, (s, o) => actions.reload(s, { ...o, ...historyOpts(ctx) }));
  },

  async dialog(ctx) {
    const answer = ctx.args[0];
    if (answer !== "accept" && answer !== "dismiss") throw usageError(ctx.action);
    if (answer === "dismiss") arity(ctx, 1);
    const prompt = ctx.args.length > 1 ? ctx.args.slice(1).join(" ") : undefined;
    return mutate(ctx, (s, o) => actions.handleDialog(s, answer === "accept", prompt, o));
  },

  async wait(ctx) {
    arity(ctx, 0);
    const f = ctx.flags;
    const conds: WaitCondition[] = [];
    if (f.text !== undefined) conds.push({ text: f.text });
    if (f.gone !== undefined) conds.push({ gone: f.gone });
    if (f.selector !== undefined) conds.push({ selector: f.selector });
    if (f.url !== undefined) conds.push({ url: f.url });
    if (f.idle) conds.push({ idle: true });
    if (f.load) conds.push({ load: true });
    if (f.clear) conds.push({ clear: true });
    if (f.ms !== undefined) conds.push({ ms: f.ms });
    if (conds.length !== 1) throw new UsageError(`wait takes exactly one condition — usage: ${cliName()} browser ${USAGE.wait}`);
    const cond = conds[0] as WaitCondition;
    const r = await onPage(ctx, (s) =>
      waitFor(s, cond, { ...(f.timeout !== undefined ? { timeoutMs: f.timeout } : {}), ...(ctx.deps.browser ? { deps: ctx.deps.browser } : {}) }),
    );
    return { json: { ok: true, ...r }, text: `${r.matched} held after ${r.waitedMs} ms` };
  },

  async eval(ctx) {
    if (ctx.args.length === 0) throw usageError(ctx.action);
    let expression = ctx.args.join(" ");
    if (expression === "-") {
      if (!ctx.deps.stdin) throw usageError(ctx.action);
      expression = ctx.deps.stdin();
    }
    expression = expression.trim();
    if (!expression) throw usageError(ctx.action);
    const r = await onPage(ctx, (s) => actions.evaluate(s, expression, actOpts(ctx)));
    const lines = [pretty(r.value)];
    if (r.dialog) lines.push(dialogLine(r.dialog));
    return { json: r, text: lines.join("\n") };
  },

  async screenshot(ctx) {
    arity(ctx, 0, 1);
    if (isNoWrite()) throw new Error(`nothing may be written (${envName("NO_WRITE")}), and a screenshot is a file`);
    const stamp = new Date(browserDeps(ctx.deps.browser).now()).toISOString().replace(/[:.]/g, "-");
    const path =
      ctx.flags.out !== undefined ? resolve(ctx.deps.cwd ?? process.cwd(), ctx.flags.out) : join(tmpdir(), brand().name, "browser", `shot-${stamp}.png`);
    const format = /\.jpe?g$/i.test(path) ? "jpeg" : "png";
    const ref = ctx.args[0];
    const bytes = await onPage(ctx, (s) => actions.screenshot(s, { format, ...(ref !== undefined ? { ref } : {}), ...(ctx.flags.full ? { full: true } : {}) }));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return { json: { ok: true, path, bytes: bytes.length, format }, text: path, image: { path } };
  },

  async network(ctx) {
    const sub = ctx.args[0] ?? "list";
    if (sub === "list") {
      arity(ctx, 0, 1);
      const entries = listNetwork(currentTarget());
      const text = entries.length
        ? entries.map((e) => `${e.n}  ${e.method} ${e.status} ${e.url} (${e.mime}, ${e.size} B)`).join("\n")
        : `nothing recorded for this tab — \`${cliName()} browser open <url> --capture\`, or --capture on an action`;
      return { json: { entries }, text };
    }
    if (sub === "get") {
      arity(ctx, 2);
      const n = Number(ctx.args[1]);
      if (!Number.isInteger(n) || n < 1) throw usageError(ctx.action);
      const e = getNetworkEntry(currentTarget(), n);
      if (!e) throw new Error(`no network entry ${n} in this tab's log — \`${cliName()} browser network list\``);
      const text =
        e.json !== undefined
          ? pretty(e.json)
          : e.text !== undefined
            ? e.text
            : `${e.method} ${e.status} ${e.url}: body not kept (${e.bodyTruncated ? `${e.size} B, over the size cap` : (e.error ?? "none")})`;
      return { json: e, text };
    }
    if (sub === "clear") {
      arity(ctx, 1);
      clearNetworkLog(currentTarget());
      return { json: { ok: true }, text: "cleared this tab's network log" };
    }
    throw usageError(ctx.action);
  },

  async tabs(ctx) {
    const sub = ctx.args[0] ?? "list";
    if (sub === "list") {
      arity(ctx, 0, 1);
      const tabs = await onPage(ctx, (s) => s.listTabs());
      return { json: { tabs }, text: tabLines(tabs) };
    }
    if (sub === "new") {
      arity(ctx, 1, 2);
      const tab = await onPage(ctx, (s) => s.newTab(ctx.args[1]));
      return { json: tab, text: tabLines([tab]) };
    }
    if (sub === "select") {
      arity(ctx, 2);
      const tab = await onPage(ctx, (s) => s.selectTab(ctx.args[1] as string));
      return { json: tab, text: tabLines([tab]) };
    }
    if (sub === "close") {
      arity(ctx, 2);
      const id = ctx.args[1] as string;
      const tabs = await onPage(ctx, async (s) => {
        await s.closeTab(id);
        return s.listTabs();
      });
      return { json: { closed: id, tabs }, text: tabLines(tabs) };
    }
    throw usageError(ctx.action);
  },

  async profile(ctx) {
    const sub = ctx.args[0];
    const name = ctx.flags.profile;
    if (sub === "path") {
      arity(ctx, 1);
      const path = profileDir(name);
      return { json: { path }, text: path };
    }
    if (sub === "import") {
      arity(ctx, 2);
      const r = importProfile(ctx.args[1] as string, { ...(name !== undefined ? { name } : {}), ...(ctx.flags.force ? { force: true } : {}) });
      return { json: r, text: `imported ${r.files} files (${r.bytes} B) from ${r.from} into ${r.to}` };
    }
    if (sub === "reset") {
      arity(ctx, 1);
      const path = profileDir(name);
      const existed = existsSync(path);
      resetProfile(name);
      return { json: { ok: true, path, removed: existed }, text: existed ? `removed ${path}: the next launch starts logged out` : `no profile at ${path}` };
    }
    throw usageError(ctx.action);
  },
};
