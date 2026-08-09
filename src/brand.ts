// The brand injection point.
//
// webindex is vendored into tools that each own a different public identity:
// one reads ACME_SEARXNG, another READER_SEARXNG — and each prints notes that
// name its own command ("pass --web-results to `reader ask`"). None of that may
// be hardcoded here, and none of it may break for the user: the variables they
// already export must keep working byte-for-byte.
//
// So the engine never writes `process.env.SOMETHING_SEARXNG`. It writes
// `env("SEARXNG")`, and the consumer declares the prefix once at startup:
//
//   configure({ name: "reader", envPrefix: "READER", cli: "reader" });
//
// ── The lazy rule ───────────────────────────────────────────────────────────
// Every read here happens at CALL time, never at module-load time. This is not
// a style preference, it is the thing that makes vendoring work at all.
//
// A vendored bundle is imported by the consumer's entry module, so the engine's
// top-level code runs BEFORE the consumer's first statement — before it can
// possibly call configure(). Any `const X = env("UA") ?? "…"` at module scope
// would therefore capture the DEFAULT brand forever, and the consumer's real
// prefix would silently never be consulted.
//
// The pre-extraction code had exactly this shape (BROWSER_UA, PAGE_DELAY_MS,
// POLITE_DELAY_MS, MAX_ATTEMPTS were all module-load constants), which is safe
// only while the prefix is a compile-time literal. It stops being safe the
// moment the module is shared. Keep tunables behind functions.
//
// Reads are deliberately NOT memoized: tests mutate process.env between cases,
// and one env lookup is free next to the network call it is configuring.

export interface Brand {
  /** Human-readable engine consumer, used in notes and diagnostics. */
  name: string;
  /** Uppercase prefix for environment variables, without the trailing underscore. */
  envPrefix: string;
  /** The command users type, used when a note tells them what to run. */
  cli: string;
  /**
   * The consumer's own release version, for the polite User-Agent.
   *
   * Without it every consumer identifies as `<name>/1.x`, which is the one
   * thing that header exists to avoid being: a maintainer looking at their logs
   * to decide whether to throttle a client cannot tell one release from another,
   * and cannot tell a fixed version from the one that was hammering them.
   */
  version?: string;
  /** Root for on-disk caches. Defaults to `<tmpdir>/<name>` when unset. */
  cacheDir?: string;
  /**
   * Root for cloned working trees. Defaults to `<tmpdir>/<name>/repos`.
   *
   * Exists because a consumer that already had its own clone cache cannot adopt
   * `ensureClone` without it: the engine would key clones somewhere else, which
   * orphans every checkout the tool has already made and splits one cache in
   * two. Declaring the directory it already uses makes adoption free.
   */
  repoDir?: string;
  /**
   * How long a cached page stays fresh. Defaults to 24h.
   *
   * A per-consumer decision, not a universal one: a research tool that re-runs
   * the same question all day wants a week, a search tool wants a day. It was
   * the reason one consumer kept its own cache rather than adopt this one.
   */
  cacheTtlMs?: number;
  /**
   * Which User-Agent unlabelled requests carry.
   *
   * `browser` (the default, and the historical behaviour) sends a realistic
   * desktop UA, because several keyless endpoints serve 403 or empty to obvious
   * bots. `contact` sends the polite identifying one instead and falls back to
   * the browser UA exactly once, on a 403/429 — the "identify honestly, disguise
   * only when refused" policy one consumer chose deliberately and would have
   * lost by adopting this layer.
   */
  defaultUa?: "browser" | "contact";
  /**
   * Called once per response body read: bytes, and whether the cache served it.
   *
   * The observability seam. Without it a consumer that instruments retrieval —
   * attributing bytes to the concurrent angle that issued the request — has to
   * keep its own `httpGet` to keep counting, which is the whole duplication this
   * engine exists to remove. Never throws into the caller: a failing counter must
   * not fail a fetch.
   */
  onFetch?: (bytes: number, cached: boolean) => void;
  /**
   * Where a rate-limited API maintainer can find out who is calling.
   *
   * Goes into the polite User-Agent that arXiv, Crossref, OpenAlex and friends
   * are sent. That header is a courtesy with teeth — it is how those services
   * attribute traffic and choose to throttle a well-behaved client gently
   * rather than block it — so it has to name the SKILL doing the calling, not
   * the shared engine underneath.
   */
  contactUrl?: string;
  /**
   * Words this consumer wants dropped on top of the engine's list.
   *
   * The shared list is question scaffolding — "what", "is", "the", plus the
   * French equivalents. What counts as noise BEYOND that is domain knowledge the
   * engine cannot have: a documentation tool reading source repositories sees
   * "test" and "request" in almost every file, so keeping them as keywords
   * scores every document alike. A market-research tool would say the opposite.
   *
   * This exists so adopting the shared matcher is not an all-or-nothing choice.
   * Without it a consumer with two extra words has to keep its own copy of the
   * whole keyword machinery — which is exactly the duplication being removed.
   */
  extraStopwords?: string[];
}

// Used when a consumer forgets to call configure(), and by the test suite.
// Deliberately a real, usable identity rather than a throw: a missing
// configure() should degrade to webindex's own defaults, not crash a run
// halfway through a fetch.
const DEFAULT_BRAND: Brand = {
  name: "webindex",
  envPrefix: "WEBINDEX",
  cli: "webindex",
  contactUrl: "https://github.com/maxgfr/webindex",
};

let current: Brand = { ...DEFAULT_BRAND };

/**
 * Declare the consuming skill's identity. Call once, as early as possible in
 * the CLI entry point and in the MCP server bootstrap — both are process
 * entry points, and a run that starts through either must see the same brand.
 */
export function configure(next: Brand): void {
  if (!next.envPrefix || !/^[A-Z][A-Z0-9_]*$/.test(next.envPrefix)) {
    throw new Error(`webindex: envPrefix must be UPPER_SNAKE, got ${JSON.stringify(next.envPrefix)}`);
  }
  if (!next.name || !next.cli) {
    throw new Error("webindex: configure() requires both `name` and `cli`");
  }
  current = { ...next };
}

/** The active brand. Consumers read `.cli` to name commands inside notes. */
export function brand(): Readonly<Brand> {
  return current;
}

/** Restore the default identity. Test-only; production code configures once. */
export function resetBrand(): void {
  current = { ...DEFAULT_BRAND };
}

/**
 * Report a response body to the consumer's traffic counter, if it declared one.
 *
 * Swallows anything the hook throws. A counter is instrumentation; a broken one
 * must not be able to fail the fetch it was measuring.
 */
export function countFetch(bytes: number, cached = false): void {
  const hook = current.onFetch;
  if (!hook) return;
  try {
    hook(bytes, cached);
  } catch {
    /* instrumentation never breaks retrieval */
  }
}

/** Full variable name for a suffix, e.g. `env` name for "SEARXNG". */
export function envName(suffix: string): string {
  return `${current.envPrefix}_${suffix}`;
}

/**
 * Read `${envPrefix}_${suffix}`, trimmed. Returns undefined for unset OR
 * empty-after-trim, so `FOO=` and `FOO="  "` behave like unset rather than
 * like the empty string — an exported-but-blank variable is a user mistake,
 * not a request for empty configuration.
 */
export function env(suffix: string): string | undefined {
  const raw = process.env[envName(suffix)];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Presence-as-truth, matching the `if (process.env.X_NO_NPX)` shape the
 * extracted code already used. Any non-empty value except the explicit
 * negatives turns the flag on, so `NO_NPX=1`, `NO_NPX=true` and `NO_NPX=yes`
 * all work — but `NO_NPX=0` and `NO_NPX=false` read as off, because a user who
 * writes that plainly means off and the old presence-only test got it wrong.
 */
export function envFlag(suffix: string): boolean {
  const v = env(suffix);
  if (v === undefined) return false;
  const lower = v.toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "no" && lower !== "off";
}

/**
 * Read a numeric tunable, clamped into [min, max]. A missing, non-numeric or
 * negative-where-forbidden value falls back to `def` silently — these are
 * performance knobs, and a typo in one must never abort a run.
 *
 * Replaces three separate copies of this helper that had drifted apart (one
 * clamped, one did not, one rejected zero).
 */
export function envInt(suffix: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env(suffix);
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
