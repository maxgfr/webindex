import { lookup as dnsLookup } from "node:dns/promises";
import { realpathSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";

// What an operator exposing the MCP server can confine it to.
//
// The server fetches whatever URL it is handed and reads whatever file it is
// named. On a developer's own machine that is the point. Reachable by anyone
// else it is two classic holes: a fetch that can be pointed at the machine's
// own network — the cloud metadata endpoint at 169.254.169.254 hands out
// credentials to whoever asks it — and a file tool that reads ~/.ssh. These
// are the two opt-in walls, kept apart from the transport so each is testable
// on its own.
//
// Deliberately not exported from the library: they serve the webindex server's
// own tools, and a new engine export is a name every vendoring skill must then
// avoid declaring.

// ── Addresses ───────────────────────────────────────────────────────────────

// [first address, prefix length]: every IPv4 range that is not the public
// internet. Loopback, the RFC 1918 networks and link-local (the metadata
// endpoints) are the ones that matter; the rest are reserved, documentation,
// benchmarking or multicast space no public page lives in.
const V4_NON_PUBLIC: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network" — 0.0.0.0 itself reaches the local host
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, and Alibaba Cloud's metadata endpoint
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local: AWS, GCP, Azure and OpenStack metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
];

const v4Number = (ip: string): number => ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);

function v4Public(n: number): boolean {
  return !V4_NON_PUBLIC.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)));
}

// An IPv6 address as its eight 16-bit groups, or undefined when it is not one.
function v6Groups(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  // A trailing dotted quad (::ffff:127.0.0.1) is the last two groups.
  const lastColon = s.lastIndexOf(":");
  const quad = s.slice(lastColon + 1);
  if (quad.includes(".")) {
    if (isIP(quad) !== 4) return undefined;
    const n = v4Number(quad);
    s = `${s.slice(0, lastColon + 1)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part ? part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? Number.parseInt(h, 16) : Number.NaN)) : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return undefined;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  return groups.every((g) => Number.isInteger(g)) ? groups : undefined;
}

// The IPv4 address an IPv6 one carries, where the packet ends up at it: mapped
// and compatible (::ffff:a.b.c.d, ::a.b.c.d — `::` and `::1` among them),
// SIIT-translated, NAT64 and 6to4. Judged as that IPv4 address, or
// `[::ffff:127.0.0.1]` would be a way round the IPv4 list.
function embeddedV4(g: readonly number[]): number | undefined {
  const tail = g[6]! * 65536 + g[7]!;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0) {
    if (g[4] === 0 && (g[5] === 0 || g[5] === 0xffff)) return tail;
    if (g[4] === 0xffff && g[5] === 0) return tail;
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return tail;
  if (g[0] === 0x2002) return g[1]! * 65536 + g[2]!;
  return undefined;
}

/**
 * Is this IP address on the public internet? False for loopback, private,
 * link-local (cloud metadata), carrier-grade NAT, unique-local, multicast,
 * reserved and documentation ranges — IPv4 and IPv6, an IPv4 address carried
 * inside IPv6 judged as itself — and for anything that is not an address.
 */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Public(v4Number(ip));
  if (kind !== 6) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  const v4 = embeddedV4(g);
  if (v4 !== undefined) return v4Public(v4);
  // Only 2000::/3 is global unicast. Within it: Teredo (2001::/32), the
  // benchmarking and documentation prefixes.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8 || (g[1] === 2 && g[2] === 0))) return false;
  if ((g[0]! & 0xfff0) === 0x3ff0) return false;
  return true;
}

/** How a host name becomes addresses. Injectable so a test needs no resolver. */
export type HostLookup = (host: string) => Promise<readonly { address: string }[]>;

const systemLookup: HostLookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Why `url` may not be fetched under a public-only policy, or undefined when
 * it may.
 *
 * Every address the name resolves to must be public: a name with one public and
 * one private address can be answered by either. A name that does not resolve
 * is refused rather than waved through — it cannot be checked.
 *
 * A guard against the common attacks — a literal private address in any of
 * its spellings, a name that resolves privately, a redirect to one (run it at
 * every hop) — not against a resolver the attacker controls answering this
 * lookup and the fetch's own differently (DNS rebinding with a zero TTL):
 * Node's fetch cannot be handed the address checked here.
 */
export async function publicUrlRefusal(url: string, lookup: HostLookup = systemLookup): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `${parsed.protocol} is not http(s)`;
  const host = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
  if (isIP(host)) return isPublicAddress(host) ? undefined : `${host} is not a public address`;
  let addresses: readonly { address: string }[];
  try {
    addresses = await lookup(host);
  } catch (e) {
    return `${host} did not resolve (${(e as { code?: string }).code ?? (e as Error).message})`;
  }
  if (!addresses.length) return `${host} did not resolve`;
  const inside = addresses.find((a) => !isPublicAddress(a.address));
  return inside ? `${host} resolves to ${inside.address}, which is not a public address` : undefined;
}

/** publicUrlRefusal as the `authorizeUrl` hook httpGet runs before the request and every redirect. */
export function publicUrlsOnly(lookup?: HostLookup): (url: string) => Promise<boolean> {
  return async (url) => (await publicUrlRefusal(url, lookup)) === undefined;
}

// ── Files ───────────────────────────────────────────────────────────────────

/**
 * `requested` as a real path inside `root`, or a thrown Error saying why not.
 *
 * A relative path is read against the root. Containment is checked twice: on
 * the path as written, before the filesystem is asked anything — so a refusal
 * says the same about /etc/passwd as about a file that does not exist, instead
 * of answering "is it there?" — and on the realpath, so a symlink inside the
 * root cannot lead out of it.
 *
 * The first check takes the root as the operator spelled it as well as its real
 * path: that spelling is the one the server advertises, and it often runs
 * through a symlink (macOS's /tmp is /private/tmp). Accepting both is safe
 * because the realpath check alone decides what may be read.
 */
export function confinePath(root: string, requested: string): string {
  const rootLex = resolve(root);
  const rootReal = realpathSync(root);
  const under = (base: string, p: string) => {
    const rel = relative(base, p);
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  const outside = new Error(`${requested} is outside ${rootLex}, the only directory this server reads files from`);
  const target = resolve(rootLex, requested);
  if (!under(rootLex, target) && !under(rootReal, target)) throw outside;
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new Error(`no such file under ${rootLex}: ${requested}`);
  }
  if (!under(rootReal, real)) throw outside;
  return real;
}

// ── Time ────────────────────────────────────────────────────────────────────

/** The longest any one tool call may be asked to wait, on a server other clients share. */
export const MAX_TOOL_WAIT_MS = 300_000;

/**
 * A tool's `timeoutMs` (or any wait an agent names). Clamped rather than
 * refused: an agent's odd value should cost it a default, not the call — but
 * never an unbounded wait on a server other clients share.
 */
export function toolTimeoutMs(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(MAX_TOOL_WAIT_MS, Math.max(1, Math.round(n))) : undefined;
}
