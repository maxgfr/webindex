// Getting a live DevTools port, by the launch policy, in this order:
//
//   1. an explicit port or URL (`--cdp`): loopback only, and it must answer;
//   2. the port saved in session.json, while it still answers (and, when a
//      profile was asked for, only if it is that profile's browser);
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

import { join } from "node:path";
import { envName } from "../brand.js";
import { UsageError } from "../cli-kit.js";
import { type BrowserDeps, browserDeps } from "./deps.js";
import { dialHost, parseCdpEndpoint } from "./discovery.js";
import { browserHome, ensurePrivateDir, profileDir } from "./profile.js";
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
  if (saved && (opts.profile === undefined || saved.profile === opts.profile)) {
    const host = saved.host ?? "127.0.0.1";
    if (await deps.discovery.isPortAlive(saved.port, host)) {
      return {
        host,
        port: saved.port,
        launchedByUs: saved.launchedByUs,
        ...(saved.pid !== undefined ? { pid: saved.pid } : {}),
        profile: saved.profile,
        headless: saved.headless,
      };
    }
    clearSession(); // its browser is gone; the one launched below replaces it
  }

  return launch(deps, opts.binary, profile, headless);
}

async function launch(deps: BrowserDeps, binary: string | undefined, profile: string, headless: boolean): Promise<Endpoint> {
  const bin = binary ?? deps.detectBrowser()?.path;
  if (!bin) {
    throw new Error(`no Chrome, Brave, Chromium or Edge found: install one, or set ${envName("BROWSER_BIN")} to the browser's executable`);
  }
  const dir = profileDir(profile);
  ensurePrivateDir(browserHome());
  ensurePrivateDir(join(browserHome(), "profiles"));
  ensurePrivateDir(dir);
  const portFile = join(dir, "DevToolsActivePort");
  // A browser of ours may still be running on this profile, saved under another
  // session since: Chrome would hand a second launch to it and exit, so use it.
  const running = await readActivePort(deps, portFile);
  if (running !== undefined && (await deps.discovery.isPortAlive(running))) {
    return { host: "127.0.0.1", port: running, launchedByUs: true, profile, headless };
  }
  // Otherwise the file is a crashed run's, naming a dead port: it must go before
  // the start, or the poll below could read it.
  await deps.fs.rm(portFile, { force: true });

  const args = ["--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check"];
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
    const port = await readActivePort(deps, portFile);
    if (port !== undefined && (await deps.discovery.isPortAlive(port))) {
      return { host: "127.0.0.1", port, launchedByUs: true, ...(child.pid !== undefined ? { pid: child.pid } : {}), profile, headless };
    }
    if (failure) throw new Error(failure);
    if (deps.now() >= deadline) {
      child.kill("SIGTERM"); // a browser we cannot drive is only in the way
      throw new Error(`${bin} did not expose a DevTools port within ${STARTUP_TIMEOUT_MS / 1000} s (no usable ${portFile})`);
    }
    await deps.sleep(POLL_MS);
  }
}

/** The port on line 1 of DevToolsActivePort, or undefined while it is absent or half-written. */
async function readActivePort(deps: BrowserDeps, file: string): Promise<number | undefined> {
  let text: string;
  try {
    text = await deps.fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const [first = "", second] = text.split("\n");
  const port = Number(first.trim());
  // Line 2 (the browser socket path) is written with it; without it the file is still being written.
  if (!Number.isInteger(port) || port < 1 || port > 65535 || second === undefined) return undefined;
  return port;
}
