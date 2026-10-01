import { request } from "node:http";

// The HTTP side of the DevTools endpoint (/json/*). Loopback only, short timeouts.

const REQUEST_TIMEOUT_MS = 3000;
const ALIVE_TIMEOUT_MS = 1000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface BrowserVersion {
  Browser?: string;
  "Protocol-Version"?: string;
  "User-Agent"?: string;
  webSocketDebuggerUrl: string;
  [key: string]: unknown;
}

export interface TargetInfo {
  id: string;
  type: string;
  title?: string;
  url: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

export interface CdpEndpoint {
  host: string;
  port: number;
  /** Set when the input was a `ws://` URL. */
  wsUrl?: string;
}

/** Throw unless `host` is a loopback name (127.0.0.1, ::1 or localhost). Returns it without brackets. */
export function assertLoopback(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK.has(bare)) throw new Error(`refusing non-loopback DevTools host "${host}" (only 127.0.0.1, ::1 and localhost are allowed)`);
  return bare;
}

/** Accepts `9222`, `127.0.0.1:9222`, `http://localhost:9222`, `ws://[::1]:9222/devtools/browser/x`. */
export function parseCdpEndpoint(input: string): CdpEndpoint {
  const text = input.trim();
  if (/^\d+$/.test(text)) return { host: "127.0.0.1", port: checkPort(Number(text), input) };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new Error(`invalid DevTools endpoint "${input}"`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error(`unsupported DevTools endpoint scheme "${url.protocol}" in "${input}"`);
  const host = assertLoopback(url.hostname);
  if (!url.port) throw new Error(`DevTools endpoint "${input}" has no port`);
  const endpoint: CdpEndpoint = { host, port: checkPort(Number(url.port), input) };
  if (url.protocol === "ws:" || url.protocol === "wss:") endpoint.wsUrl = text;
  return endpoint;
}

function checkPort(port: number, input: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in DevTools endpoint "${input}"`);
  return port;
}

interface HttpResult {
  status: number;
  body: string;
}

/**
 * The address to dial for a loopback host. `localhost` is dialled as 127.0.0.1:
 * Node >= 17 keeps the resolver's order, which often puts ::1 first, while
 * Chrome's DevTools server listens on 127.0.0.1 only — so `localhost:9222`
 * would be refused against a browser that is plainly running.
 */
export function dialHost(host: string): string {
  const bare = assertLoopback(host);
  return bare === "localhost" ? "127.0.0.1" : bare;
}

function http(method: string, port: number, host: string, path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: dialHost(host), port, path, method, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`DevTools request ${method} ${path} timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

async function json<T>(method: string, port: number, host: string, path: string): Promise<T> {
  const { status, body } = await http(method, port, host, path);
  if (status < 200 || status >= 300) throw new Error(`DevTools ${method} ${path} answered HTTP ${status}`);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`DevTools ${path} did not return valid JSON`);
  }
}

export function getVersion(port: number, host = "127.0.0.1"): Promise<BrowserVersion> {
  return json<BrowserVersion>("GET", port, host, "/json/version");
}

export function listTargets(port: number, host = "127.0.0.1"): Promise<TargetInfo[]> {
  return json<TargetInfo[]>("GET", port, host, "/json/list");
}

export async function listPages(port: number, host = "127.0.0.1"): Promise<TargetInfo[]> {
  return (await listTargets(port, host)).filter((t) => t.type === "page");
}

/** Open a tab. Chrome >= 111 wants PUT; older and other builds only answer GET. */
export async function newTarget(port: number, url?: string, host = "127.0.0.1"): Promise<TargetInfo> {
  const path = url === undefined ? "/json/new" : `/json/new?${encodeURIComponent(url)}`;
  try {
    return await json<TargetInfo>("PUT", port, host, path);
  } catch (e) {
    // Only an HTTP refusal means "try the other verb"; a dead port or a timeout would fail again.
    if (!/answered HTTP/.test((e as Error).message)) throw e;
    return json<TargetInfo>("GET", port, host, path);
  }
}

async function command(port: number, host: string, path: string): Promise<string> {
  const { status, body } = await http("GET", port, host, path);
  if (status < 200 || status >= 300) throw new Error(`DevTools GET ${path} answered HTTP ${status}`);
  return body;
}

export async function closeTarget(port: number, id: string, host = "127.0.0.1"): Promise<void> {
  await command(port, host, `/json/close/${encodeURIComponent(id)}`);
}

export async function activateTarget(port: number, id: string, host = "127.0.0.1"): Promise<void> {
  await command(port, host, `/json/activate/${encodeURIComponent(id)}`);
}

/** True when something answers DevTools on `port`. Never throws. */
export async function isPortAlive(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    const { status } = await http("GET", port, host, "/json/version", ALIVE_TIMEOUT_MS);
    return status === 200;
  } catch {
    return false;
  }
}
