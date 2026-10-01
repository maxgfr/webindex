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
// `profile` never launch a browser. The MCP server (mcp.ts) runs the same
// handlers on the one session it keeps, through `BrowserCliDeps.page`.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { brand, envName } from "../brand.js";
import { UsageError } from "../cli-kit.js";
import { isNoWrite, writeFileAtomic } from "../no-write.js";
import * as actions from "./actions.js";
import type { ActionOptions, ActionResult, DialogInfo } from "./actions.js";
import type { Challenge } from "./challenge.js";
import { detectChallenge } from "./challenge.js";
import { type BrowserDeps, browserDeps } from "./deps.js";
import { parseKey } from "./keys.js";
import { isSameBrowser, readActivePort } from "./launch.js";
import { clearNetworkLog, getNetworkEntry, listNetwork, NetworkRecorder } from "./network.js";
import { ensurePrivateDir, importProfile, profileDir, resetProfile } from "./profile.js";
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
  /**
   * Runs a page command on a session. By default the CLI's: reconnect under
   * the browser lock (withPage), detach at the end. The MCP server hands the
   * one live session it keeps instead.
   */
  page?: <T>(fn: (s: BrowserSession) => Promise<T>, opts: { newTab?: boolean }) => Promise<T>;
  /** How a result names the next step to take; the CLI's own commands by default. */
  followUps?: BrowserFollowUps;
  /** Stops a `wait` between two polls: an MCP client's cancel. */
  signal?: AbortSignal;
}

/** The next step a result points the agent to, in the words of the interface it uses. */
export interface BrowserFollowUps {
  /** Answer the open dialog. */
  dialog: string;
  /** Wait until a challenge is cleared. */
  waitClear: string;
  /** Read what was captured. */
  networkList: string;
  /** How to record what pages fetch. */
  capture: string;
}

const cliFollowUps = (): BrowserFollowUps => ({
  dialog: `\`${cliName()} browser dialog accept|dismiss\``,
  waitClear: `\`${cliName()} browser wait --clear\``,
  networkList: `\`${cliName()} browser network list\``,
  capture: `\`${cliName()} browser open <url> --capture\`, or --capture on an action`,
});

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
    // Every success says so in its JSON, as every failure does with `ok: false`.
    return { ...out, json: { ok: true, ...(out.json as object) }, exitCode: 0 };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { json: { ok: false, error }, text: error, exitCode: e instanceof UsageError ? 2 : 1 };
  }
}

// --- shared pieces -----------------------------------------------------------

function onPage<T>(ctx: Ctx, fn: (s: BrowserSession) => Promise<T>, extra: { newTab?: boolean } = {}): Promise<T> {
  if (ctx.deps.page) return ctx.deps.page(fn, extra);
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

const follow = (ctx: Ctx): BrowserFollowUps => ctx.deps.followUps ?? cliFollowUps();

/** The line saying a JavaScript dialog is open, and how to answer it — or that the CLI dismissed it. */
export const dialogLine = (d: DialogInfo, f: BrowserFollowUps = cliFollowUps()): string =>
  d.dismissed
    ? `dialog ${d.type}: ${JSON.stringify(d.message)} — dismissed: a dialog cannot outlive a command; \`${cliName()} mcp --browser\` keeps it open for an answer`
    : `dialog ${d.type}: ${JSON.stringify(d.message)} — it is still open: ${f.dialog}`;

/**
 * The CLI's answer to a dialog its command opened: dismiss it (never accept)
 * before letting go. The browser hands a dialog only to the connection that saw
 * it open, so the next command could not answer it, and every command after
 * would wait on the page frozen behind it. The MCP server keeps its connection
 * (`deps.page`): there the dialog stays open for the agent to answer.
 */
async function dismissLeftover<R extends { dialog?: DialogInfo }>(ctx: Ctx, s: BrowserSession, r: R): Promise<R> {
  if (!r.dialog || ctx.deps.page) return r;
  await s.page.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {}); // already closed by hand: nothing to do
  return { ...r, dialog: { ...r.dialog, dismissed: true } };
}

const challengeLine = (ctx: Ctx, c: Challenge): string =>
  `challenge: ${c.kind}${c.blocking ? " (blocking)" : ""} — let the human solve it, then ${follow(ctx).waitClear}`;

const capturedLine = (ctx: Ctx, n: number): string => `captured ${n} JSON response${n === 1 ? "" : "s"} — ${follow(ctx).networkList}`;

function actionText(ctx: Ctx, r: ActionResult, captured: number | undefined, snap: SnapshotResult | undefined): string {
  const lines = [`${r.action}${r.ref !== undefined ? ` ${r.ref}` : ""}: ${r.navigated ? "navigated to " : ""}${where(r.url, r.title)}`];
  // What the action yields (the options chosen, the scroll position); an empty protocol answer says nothing.
  if (r.value !== undefined && !(typeof r.value === "object" && r.value !== null && Object.keys(r.value).length === 0)) lines.push(`  value: ${show(r.value)}`);
  if (r.dialog) lines.push(dialogLine(r.dialog, follow(ctx)));
  if (r.challenge) lines.push(challengeLine(ctx, r.challenge));
  if (captured !== undefined) lines.push(capturedLine(ctx, captured));
  if (snap) lines.push("", snap.text);
  return lines.join("\n");
}

/**
 * An action that can change the page: run it (recording the network with
 * --capture), then take the snapshot --snapshot asks for — unless a dialog is
 * open, which freezes the page until it is answered (in the CLI, dismissed first).
 */
function mutate(ctx: Ctx, run: (s: BrowserSession, o: ActionOptions) => Promise<ActionResult>): Promise<Out> {
  return onPage(ctx, async (s) => {
    const { value: r, captured } = await capturing(ctx, s, async () => dismissLeftover(ctx, s, await run(s, actOpts(ctx))));
    const snap = ctx.flags.snapshot && !(r.dialog && !r.dialog.dismissed) ? await takeSnapshot(s, snapOpts(ctx)) : undefined;
    return {
      json: { ...r, ...(captured !== undefined ? { captured } : {}), ...(snap ? { snapshot: snap } : {}) },
      text: actionText(ctx, r, captured, snap),
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

export function tabLines(tabs: BrowserTab[]): string {
  return tabs.map((t) => `${t.active ? "*" : " "} ${t.id}  ${where(t.url, t.title)}`).join("\n");
}

/** `status` as text: where the browser runs and whose it is, then its tabs (`*` the current one). */
export function statusText(st: BrowserStatus): string {
  if (!st.alive) return st.port === undefined ? "no browser session" : `no browser answers on port ${st.port} any more`;
  const owner = st.launchedByUs ? `launched by ${brand().name}` : "attached, not ours: close only forgets it";
  const head = `browser on port ${st.port} (${owner}), profile ${st.profile}${st.headless ? ", headless" : ""}`;
  return [head, tabLines(st.tabs ?? [])].filter(Boolean).join("\n");
}

/**
 * Refuse to delete or replace a profile a browser of ours is running on: the
 * live browser would write it back, or (on Windows) hold its files open. Our
 * browser — whether a session or a fetch read started it — is told by the
 * DevToolsActivePort it keeps in the profile, still served by the socket it
 * names: a crashed run's file does not block anything. Never launches.
 */
async function assertProfileIdle(ctx: Ctx, name: string | undefined): Promise<void> {
  const deps = browserDeps(ctx.deps.browser);
  const own = await readActivePort(deps, join(profileDir(name), "DevToolsActivePort"));
  if (own && (await isSameBrowser(deps, own.port, "127.0.0.1", own.path))) {
    throw new Error(`a browser is running on the profile ${name ?? "default"}: close it first: \`${cliName()} browser close\``);
  }
}

/** The current tab of the saved session, for the commands that read its files only. */
function currentTarget(ctx: Ctx): string {
  const saved = readSession();
  if (!saved) throw new Error(`no browser session: record what a page fetches with ${follow(ctx).capture}`);
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
        if (challenge) lines.push(challengeLine(ctx, challenge));
        if (captured !== undefined) lines.push(capturedLine(ctx, captured));
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
    parseKey(ctx.args[0] as string); // an unknown key is a usage error, before any browser is reached for
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
    if (!/^(up|down|top|bottom|e\d+)$/.test(ctx.args[0] as string)) throw usageError(ctx.action);
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
      waitFor(s, cond, {
        ...(f.timeout !== undefined ? { timeoutMs: f.timeout } : {}),
        ...(ctx.deps.browser ? { deps: ctx.deps.browser } : {}),
        ...(ctx.deps.signal ? { signal: ctx.deps.signal } : {}),
      }),
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
    const r = await onPage(ctx, async (s) => dismissLeftover(ctx, s, await actions.evaluate(s, expression, actOpts(ctx))));
    const lines = [pretty(r.value)];
    if (r.dialog) lines.push(dialogLine(r.dialog, follow(ctx)));
    return { json: r, text: lines.join("\n") };
  },

  async screenshot(ctx) {
    arity(ctx, 0, 1);
    if (isNoWrite()) throw new Error(`nothing may be written (${envName("NO_WRITE")}), and a screenshot is a file`);
    const stamp = new Date(browserDeps(ctx.deps.browser).now()).toISOString().replace(/[:.]/g, "-");
    // A screenshot shows whatever the page does, a logged-in account included: private, as the profile is.
    const shots = join(tmpdir(), brand().name, "browser");
    const path = ctx.flags.out !== undefined ? resolve(ctx.deps.cwd ?? process.cwd(), ctx.flags.out) : join(shots, `shot-${stamp}.png`);
    const format = /\.jpe?g$/i.test(path) ? "jpeg" : "png";
    const ref = ctx.args[0];
    const bytes = await onPage(ctx, (s) => actions.screenshot(s, { format, ...(ref !== undefined ? { ref } : {}), ...(ctx.flags.full ? { full: true } : {}) }));
    if (ctx.flags.out === undefined) ensurePrivateDir(shots);
    else mkdirSync(dirname(path), { recursive: true });
    // Atomic, through a fresh file: an existing one's looser mode is not kept.
    writeFileAtomic(path, bytes, 0o600);
    return { json: { ok: true, path, bytes: bytes.length, format }, text: path, image: { path } };
  },

  async network(ctx) {
    const sub = ctx.args[0] ?? "list";
    if (sub === "list") {
      arity(ctx, 0, 1);
      const entries = listNetwork(currentTarget(ctx));
      const text = entries.length
        ? entries.map((e) => `${e.n}  ${e.method} ${e.status} ${e.url} (${e.mime}, ${e.size} B)`).join("\n")
        : `nothing recorded for this tab — record it with ${follow(ctx).capture}`;
      return { json: { entries }, text };
    }
    if (sub === "get") {
      arity(ctx, 2);
      const n = Number(ctx.args[1]);
      if (!Number.isInteger(n) || n < 1) throw usageError(ctx.action);
      const e = getNetworkEntry(currentTarget(ctx), n);
      if (!e) throw new Error(`no network entry ${n} in this tab's log — ${follow(ctx).networkList}`);
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
      clearNetworkLog(currentTarget(ctx));
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
      await assertProfileIdle(ctx, name);
      const r = importProfile(ctx.args[1] as string, { ...(name !== undefined ? { name } : {}), ...(ctx.flags.force ? { force: true } : {}) });
      return { json: r, text: `imported ${r.files} files (${r.bytes} B) from ${r.from} into ${r.to}` };
    }
    if (sub === "reset") {
      arity(ctx, 1);
      await assertProfileIdle(ctx, name);
      const path = profileDir(name);
      const existed = existsSync(path);
      resetProfile(name);
      return { json: { ok: true, path, removed: existed }, text: existed ? `removed ${path}: the next launch starts logged out` : `no profile at ${path}` };
    }
    throw usageError(ctx.action);
  },
};
