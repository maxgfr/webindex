// What `doctor` reports about the browser layer. Read-only: no browser is
// launched, no directory is made, nothing is written, so it is safe offline and
// in CI. The one network touch is a single loopback liveness probe, and only
// when a session is saved.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { envInt, envName } from "../brand.js";
import { type BrowserBinary, detectBrowserBinary } from "./detect.js";
import { isPortAlive } from "./discovery.js";
import { type BrowserFetchMode, browserFetchMode } from "./mode.js";
import { browserHome } from "./profile.js";
import { type Session, readSession } from "./state.js";

export interface BrowserDoctorDeps {
  detect(): BrowserBinary | null;
  home(): string;
  /** Names under `<home>/profiles`; empty when there are none. */
  profiles(home: string): string[];
  session(): Session | null;
  alive(port: number, host: string): Promise<boolean>;
  fetchMode(): BrowserFetchMode;
  concurrency(): number;
}

export interface BrowserDoctorReport {
  binary: { state: "found"; kind: string; path: string } | { state: "not found"; hint: string } | { state: "error"; error: string };
  home: string;
  profiles: string[];
  session: { state: "none" } | { state: "alive" | "dead"; port: number; launchedByUs: boolean; profile: string };
  fetch: { mode: BrowserFetchMode; concurrency: number };
}

function listProfiles(home: string): string[] {
  try {
    return readdirSync(join(home, "profiles"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // no profiles directory yet: nothing was ever launched
  }
}

const defaults: BrowserDoctorDeps = {
  detect: () => detectBrowserBinary(),
  home: browserHome,
  profiles: listProfiles,
  session: () => readSession(),
  alive: isPortAlive,
  fetchMode: () => browserFetchMode(),
  concurrency: () => envInt("BROWSER_CONCURRENCY", 1, 1, 4),
};

export async function browserDoctor(own: Partial<BrowserDoctorDeps> = {}): Promise<BrowserDoctorReport> {
  const d = { ...defaults, ...own };

  let binary: BrowserDoctorReport["binary"];
  try {
    const found = d.detect();
    binary = found
      ? { state: "found", kind: found.kind, path: found.path }
      : { state: "not found", hint: `install Chrome/Brave/Chromium/Edge or set ${envName("BROWSER_BIN")}` };
  } catch (e) {
    binary = { state: "error", error: (e as Error).message }; // BROWSER_BIN names a file that is not there
  }

  const home = d.home();
  const saved = d.session();
  let session: BrowserDoctorReport["session"] = { state: "none" };
  if (saved) {
    const up = await d.alive(saved.port, saved.host ?? "127.0.0.1").catch(() => false);
    session = { state: up ? "alive" : "dead", port: saved.port, launchedByUs: saved.launchedByUs, profile: saved.profile };
  }

  return { binary, home, profiles: d.profiles(home), session, fetch: { mode: d.fetchMode(), concurrency: d.concurrency() } };
}
