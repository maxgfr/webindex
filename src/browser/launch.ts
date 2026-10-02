// Getting a live DevTools port, by the launch policy, in this order:
//
//   1. an explicit port or URL (`--cdp`): loopback only, and it must answer;
//   2. the port saved in session.json, while it still answers (and, when a
//      profile was asked for, only if it is that profile's browser — never a
//      browser we were only attached to, which has no profile of ours);
//   3. otherwise a SEPARATE browser of our own, on a dedicated profile.
//
// The browser we launch never touches the user's own profile: Chrome 136+
// ignores --remote-debugging-port on the default user-data-dir anyway, and the
// user's running browser holds it locked. It is started with
// --remote-debugging-port=0, so the OS picks a free port and nothing races for
// a fixed one; Chrome writes the port it got to <profile>/DevToolsActivePort
// (line 1 the port, line 2 the browser socket path). No automation flag is
// passed — no --enable-automation, no --remote-allow-origins (our WebSocket
// client sends no Origin header, so none is needed) — and headless only when
// asked: the point is a browser a human can also look at and sign in to.
//
// Which browser: BROWSER_BIN, else the kind asked for (`--browser-kind`, else
// BROWSER_KIND, else the kind the profile belongs to), else the first found. A
// profile belongs to the kind it was first launched with (profile.ts): another
// kind is refused on it. Unpacked extensions (BROWSER_EXTENSIONS, see
// extensions.ts) are loaded into a browser we spawn, never into one running.

import { join } from "node:path";
import { envName } from "../brand.js";
import { UsageError } from "../cli-kit.js";
import { type BrowserDeps, browserDeps } from "./deps.js";
import { type BrowserBinary, type BrowserKind, ignoresUnpackedExtensions, isBrowserKind, kindOf } from "./detect.js";
import { dialHost, parseCdpEndpoint } from "./discovery.js";
import { extensionArgs, extensionDirs, unpackedIgnoredNote } from "./extensions.js";
import { browserHome, ensurePrivateDir, profileDir, readProfileKind, writeProfileKind } from "./profile.js";
import { clearSession, readSession } from "./state.js";

const STARTUP_TIMEOUT_MS = 20_000;
const POLL_MS = 100;

export interface LaunchOptions {
  /** An already-running browser: a port, `host:port` or URL (loopback only). */
  cdp?: string | number;
  /** Dedicated profile name; `default` when unset. */
  profile?: string;
  headless?: boolean;
  /** The browser binary; detected when unset. */
  binary?: string;
  /** The kind of browser to launch (`--browser-kind`); BROWSER_KIND, then the profile's own kind, when unset. */
  kind?: BrowserKind;
  /**
   * Never a saved browser this library did not launch (one `attach` or `--cdp`
   * named): the user lent it for the agent's session, not for reads in the
   * background. Ours is used, or launched, instead. An explicit `cdp` still wins.
   */
  ownOnly?: boolean;
  deps?: Partial<BrowserDeps>;
}

export interface Endpoint {
  /** Loopback address to dial (never `localhost`, see `dialHost`). */
  host: string;
  port: number;
  /** True only for a browser this library started: only that one may be closed. */
  launchedByUs: boolean;
  pid?: number;
  profile: string;
  headless: boolean;
  /** What the launch has to tell the user (extensions the browser will not load); only from the call that spawned it. */
  notes?: string[];
}

/** Apply the launch policy and return a port something answers DevTools on. */
export async function resolveEndpoint(opts: LaunchOptions = {}): Promise<Endpoint> {
  const deps = browserDeps(opts.deps);
  const profile = opts.profile ?? "default";
  const headless = opts.headless ?? false;

  if (opts.cdp !== undefined) {
    let host: string;
    let port: number;
    try {
      const ep = parseCdpEndpoint(String(opts.cdp));
      host = dialHost(ep.host);
      port = ep.port;
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    if (!(await deps.discovery.isPortAlive(port, host))) throw new Error(`nothing answers DevTools on ${host}:${port}`);
    return { host, port, launchedByUs: false, profile, headless };
  }

  const saved = readSession();
  // An attached browser is whatever the user runs: it matches no profile asked for by name, `default` included.
  const usable = saved && (saved.launchedByUs ? opts.profile === undefined || saved.profile === opts.profile : opts.profile === undefined && !opts.ownOnly);
  if (saved && usable) {
    const host = saved.host ?? "127.0.0.1";
    // A live port is not enough: ours may have died and the port gone to another
    // browser, which `close` would then shut down. The browser socket path (a
    // per-run GUID) says whether it is still the same one. A browser of ours whose
    // path was not recorded cannot be told apart, so it counts as gone; one we only
    // attached to is never closed, so its port answering is enough.
    const same = saved.wsBrowserUrl
      ? await isSameBrowser(deps, saved.port, host, saved.wsBrowserUrl)
      : !saved.launchedByUs && (await deps.discovery.isPortAlive(saved.port, host));
    if (same) {
      return {
        host,
        port: saved.port,
        launchedByUs: saved.launchedByUs,
        ...(saved.pid !== undefined ? { pid: saved.pid } : {}),
        profile: saved.profile,
        headless: saved.headless,
      };
    }
    clearSession(); // its browser is gone (or is someone else's now); the one launched below replaces it
  }

  return launch(deps, opts.binary, profile, headless, opts.kind);
}

/** The kind to look for first: the one asked for, else BROWSER_KIND, else the profile's own. */
function preferredKind(deps: BrowserDeps, kind: BrowserKind | undefined, profile: string): BrowserKind | undefined {
  if (kind) return kind;
  const asked = deps.env("BROWSER_KIND")?.trim().toLowerCase();
  if (asked && !isBrowserKind(asked)) throw new UsageError(`${envName("BROWSER_KIND")} is "${asked}", not one of chrome, brave, chromium, edge`);
  return asked && isBrowserKind(asked) ? asked : readProfileKind(profile);
}

async function launch(deps: BrowserDeps, binary: string | undefined, profile: string, headless: boolean, kind?: BrowserKind): Promise<Endpoint> {
  const found: BrowserBinary | null = binary ? { kind: kindOf(binary), path: binary } : deps.detectBrowser(preferredKind(deps, kind, profile));
  if (!found) {
    throw new Error(`no Chrome, Brave, Chromium or Edge found: install one, or set ${envName("BROWSER_BIN")} to the browser's executable`);
  }
  const bin = found.path;
  const dir = profileDir(profile);
  ensurePrivateDir(browserHome());
  ensurePrivateDir(join(browserHome(), "profiles"));
  ensurePrivateDir(dir);
  const portFile = join(dir, "DevToolsActivePort");
  // A browser of ours may still be running on this profile, saved under another
  // session since: Chrome would hand a second launch to it and exit, so use it.
  // Only if that port still serves the browser socket the file names: a crashed
  // run's port may since belong to another browser, which is not ours to close.
  const running = await readActivePort(deps, portFile);
  if (running && (await isSameBrowser(deps, running.port, "127.0.0.1", running.path))) {
    return { host: "127.0.0.1", port: running.port, launchedByUs: true, profile, headless };
  }
  // A profile is one kind of browser's: another would find its logins unreadable.
  const owner = readProfileKind(profile);
  if (owner && owner !== found.kind) {
    throw new UsageError(
      `the profile "${profile}" belongs to ${owner} (its logins are encrypted for that browser), not ${found.kind}: use a profile of its own (\`--profile ${found.kind}\`), or ${owner} (\`--browser-kind ${owner}\`)`,
    );
  }
  const extensions = extensionDirs(deps.env("BROWSER_EXTENSIONS"));
  // Otherwise the file is a crashed run's: it must go before the start, or the
  // poll below could read it.
  await deps.fs.rm(portFile, { force: true });

  const args = ["--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", ...extensionArgs(extensions)];
  if (headless) args.push("--headless=new");
  args.push("about:blank");
  // Detached and unreferenced: the browser outlives this CLI call, and the next
  // call reconnects to it.
  const child = deps.spawn(bin, args, { detached: true, stdio: "ignore" });
  let failure: string | undefined;
  child.on("exit", (code, signal) => {
    const how = code !== null ? `code ${code}` : `signal ${signal}`;
    // Exit 0 at once is Chrome handing the launch to an instance already on this profile.
    const hint = code === 0 ? `; is a browser already running on the profile ${dir}?` : "";
    failure = `the browser exited before exposing a DevTools port (${how}${hint})`;
  });
  child.on("error", (err) => {
    failure = `could not start ${bin}: ${err.message}`;
  });
  child.unref();

  const deadline = deps.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    // A live port first: a launcher that exits once the browser is up still succeeded.
    const active = await readActivePort(deps, portFile);
    if (active && (await isSameBrowser(deps, active.port, "127.0.0.1", active.path))) {
      const port = active.port;
      if (!owner) writeProfileKind(profile, found.kind);
      const notes = extensions.length > 0 && (await dropsExtensions(deps, found, port)) ? [unpackedIgnoredNote()] : [];
      return {
        host: "127.0.0.1",
        port,
        launchedByUs: true,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        profile,
        headless,
        ...(notes.length ? { notes } : {}),
      };
    }
    if (failure) throw new Error(failure);
    if (deps.now() >= deadline) {
      child.kill("SIGTERM"); // a browser we cannot drive is only in the way
      throw new Error(`${bin} did not expose a DevTools port within ${STARTUP_TIMEOUT_MS / 1000} s (no usable ${portFile})`);
    }
    await deps.sleep(POLL_MS);
  }
}

/** Whether the browser just started on `port` is one that drops unpacked extensions (branded Chrome ≥ 137). */
async function dropsExtensions(deps: BrowserDeps, bin: BrowserBinary, port: number): Promise<boolean> {
  if (!ignoresUnpackedExtensions(bin)) return false;
  const version = await deps.discovery
    .getVersion(port, "127.0.0.1")
    .then((v) => (typeof v.Browser === "string" ? v.Browser : undefined))
    .catch(() => undefined);
  return ignoresUnpackedExtensions(bin, version);
}

/** Line 1 (the port) and line 2 (the browser socket path) of DevToolsActivePort, or undefined while it is absent or half-written. */
export async function readActivePort(deps: BrowserDeps, file: string): Promise<{ port: number; path: string } | undefined> {
  let text: string;
  try {
    text = await deps.fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const [first = "", second = ""] = text.split("\n");
  const port = Number(first.trim());
  const path = second.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path) return undefined;
  return { port, path };
}

/** The path of a browser socket URL (`/devtools/browser/<guid>`); a bare path is returned as is. */
function socketPath(urlOrPath: string): string {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return urlOrPath;
  }
}

/**
 * Whether the browser answering on `port` is the one whose socket is
 * `wsBrowserUrl` (a URL or just its path). The path carries a GUID drawn at each
 * browser start, so a different browser on a reused port never matches. Never throws.
 */
export async function isSameBrowser(deps: BrowserDeps, port: number, host: string, wsBrowserUrl: string): Promise<boolean> {
  try {
    const { webSocketDebuggerUrl } = await deps.discovery.getVersion(port, host);
    return socketPath(webSocketDebuggerUrl) === socketPath(wsBrowserUrl);
  } catch {
    return false;
  }
}
