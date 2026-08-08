import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brand, env, envInt, envName } from "./brand.js";

// The optional local Docker stack, embedded so `webindex semantic up|down|status`
// and `webindex firecrawl up|down|status` work from ANY install location (npx
// skills add, npm, a curled bundle) — not just a dev checkout where
// docker-compose.yml sits beside the source. The repo files
// (docker-compose.yml, docker/searxng/settings.yml, docker/firecrawl/firecrawl.env)
// remain the editable source of truth; tests/compose.test.ts fails if these
// copies drift from them.

export const COMPOSE_YAML = `# Optional, fully-local, no-API-key stack for a semantic mode, web
# search and content extraction. Start it with \`{{CLI}} semantic up\` (or
# \`docker compose --profile all up -d\`). The published bundle stays
# dependency-free — it only speaks HTTP to these containers on localhost;
# nothing here is required for Tier-1 retrieval.
#
# Profiles let you start subsets:
#   --profile semantic  → qdrant + ollama (vector search)
#   --profile search    → searxng (web discovery)
#   --profile all       → everything above
#   --profile extract   → firecrawl (content cleaning; \`{{CLI}} firecrawl up\`)
# ── One stack, however many tools use it ─────────────────────────────────────
# Any tool needing SearXNG or Firecrawl binds the SAME host ports. Run two from
# separate compose projects and only one can ever be up: the second fails with
# "port is already allocated", after leaving its sidecars running.
#
# So this file uses one fixed project name, one set of container names and one
# set of volumes. A second tool bringing the stack up is a no-op against the
# containers already running, and the whole thing costs one machine's worth of
# RAM rather than one per tool.
#
# WARNING: any tool shipping its own copy of these service blocks must keep them
# byte-identical. Docker compares the RESOLVED config, so a divergence makes an
# up from one recreate the other's running containers.

name: skills

services:
  # Vector database — Apache-2.0, self-hosted, no key.
  qdrant:
    image: qdrant/qdrant:v1.18.2
    container_name: skills-qdrant
    ports:
      - "6333:6333"
    volumes:
      - qdrant:/qdrant/storage
    restart: unless-stopped
    profiles: ["semantic", "all"]
    healthcheck:
      # The image ships no curl/wget — probe the REST port over bash's /dev/tcp.
      test: ["CMD-SHELL", "bash -c ':> /dev/tcp/127.0.0.1/6333' || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  # Local embedding server — no key, no data leaves the machine. Pull the model
  # once: \`docker compose exec ollama ollama pull nomic-embed-text\`
  # (\`{{CLI}} semantic up\` does this for you).
  ollama:
    image: ollama/ollama:0.30.7
    container_name: skills-ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama:/root/.ollama
    restart: unless-stopped
    profiles: ["semantic", "all"]
    healthcheck:
      test: ["CMD", "ollama", "list"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  # Self-hosted metasearch for keyless web discovery. JSON output is enabled in
  # docker/searxng/settings.yml so the engine can be queried programmatically.
  # Also backs Firecrawl's keyless /search through SEARXNG_ENDPOINT.
  searxng:
    image: searxng/searxng:2026.6.11-a1490676e
    container_name: skills-searxng
    ports:
      - "8888:8080"
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888/
    volumes:
      - ./docker/searxng:/etc/searxng:rw
    restart: unless-stopped
    profiles: ["search", "all"]
    healthcheck:
      # busybox wget is in the image; /healthz answers on the container port.
      test: ["CMD-SHELL", "wget -qO- http://localhost:8080/healthz || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  # Self-hosted Firecrawl — keyless content cleaning. Fetches a page with a real
  # browser and returns main-content markdown, which beats the built-in regex
  # HTML stripper on nav/cookie chrome and is the only way JS-rendered pages
  # yield any text at all. Keyless because USE_DB_AUTHENTICATION=false; see
  # docker/firecrawl/firecrawl.env for the tunables.
  #
  # Deliberately NOT in the "all" profile: it is ~3 GB of images and 5
  # containers, and \`{{CLI}} semantic up\` must stay cheap.
  #
  #   docker compose --profile search --profile extract up -d --wait
  firecrawl:
    image: ghcr.io/firecrawl/firecrawl:2.10.5@sha256:8ce1af201332e1de046d70d5d516fbfe7f0f6229820d271d880873eeca531ea6
    container_name: skills-firecrawl
    ports:
      - "3002:3002"
    env_file:
      - ./docker/firecrawl/firecrawl.env
    environment:
      # Wiring lives here; tunables live in the env file above.
      - HOST=0.0.0.0
      - PORT=3002
      - ENV=local
      - REDIS_URL=redis://firecrawl-redis:6379
      - REDIS_RATE_LIMIT_URL=redis://firecrawl-redis:6379
      - PLAYWRIGHT_MICROSERVICE_URL=http://firecrawl-playwright:3000/scrape
      - POSTGRES_HOST=firecrawl-postgres
      - NUQ_RABBITMQ_URL=amqp://firecrawl-rabbitmq:5672
      # Keeps /search keyless by delegating to the searxng service above.
      # Unreachable when the \`search\` profile is down — Firecrawl then falls
      # back to DuckDuckGo on its own.
      - SEARXNG_ENDPOINT=http://searxng:8080
    command: node dist/src/harness.js --start-docker
    depends_on:
      firecrawl-redis:
        condition: service_started
      firecrawl-playwright:
        condition: service_started
      firecrawl-postgres:
        condition: service_started
      firecrawl-rabbitmq:
        condition: service_healthy
    restart: unless-stopped
    profiles: ["extract"]
    # The image ships no curl/wget, but it is a Node image — probe with node.
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3002/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 60s
    # Trimmed for a 16 GB laptop; upstream asks for 4 CPU / 8 GB. Measured at
    # 2.3 GB steady under 5 concurrent scrapes, so 3 GB was too tight a cap —
    # MAX_RAM=0.8 in the env file makes Firecrawl self-throttle at ~3.2 GB.
    cpus: 2.0
    mem_limit: 4g
    memswap_limit: 4g

  # Headless-browser sidecar — this is what makes JS-rendered pages extractable.
  firecrawl-playwright:
    image: ghcr.io/firecrawl/playwright-service:latest@sha256:8c50add7293201e575110e6c7489fa383a9dfc46f168936526a458e06ffc5c28
    container_name: skills-firecrawl-playwright
    environment:
      - PORT=3000
      - BLOCK_MEDIA=true
      - MAX_CONCURRENT_PAGES=4
    restart: unless-stopped
    profiles: ["extract"]
    cpus: 1.5
    mem_limit: 2g
    memswap_limit: 2g
    tmpfs:
      - /tmp/.cache:noexec,nosuid,size=512m

  firecrawl-redis:
    image: redis:alpine
    container_name: skills-firecrawl-redis
    command: redis-server --bind 0.0.0.0
    restart: unless-stopped
    profiles: ["extract"]

  firecrawl-rabbitmq:
    image: rabbitmq:3-management
    container_name: skills-firecrawl-rabbitmq
    restart: unless-stopped
    profiles: ["extract"]
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "check_running"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s

  firecrawl-postgres:
    image: ghcr.io/firecrawl/nuq-postgres:latest@sha256:aed86f62858f29bd971abddcdeb301c12888098d2cf5d33c1ba42b053bc460f6
    container_name: skills-firecrawl-postgres
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=postgres
    volumes:
      - firecrawl_pg:/var/lib/postgresql/data
    restart: unless-stopped
    profiles: ["extract"]

volumes:
  qdrant:
  ollama:
  firecrawl_pg:
`;

export const SEARXNG_SETTINGS_YAML = `# Minimal SearXNG config for keyless, self-hosted web discovery. The important
# bit is enabling the JSON output format so the CLI can query it
# programmatically (\`/search?format=json\`) — most PUBLIC instances disable it,
# which is why a local one ships here.
#
# The service names and ports below are deliberately stable, so several tools on
# one machine share a single container rather than each starting their own.
use_default_settings: true

server:
  # Override with a real random secret if you expose this beyond localhost.
  secret_key: "searxng-local-dev-change-me"
  # The limiter/bot-detection middleware answers 403 to format=json requests.
  limiter: false
  image_proxy: false

search:
  safe_search: 0
  autocomplete: ""
  formats:
    - html
    - json
`;

// Firecrawl's tunables. The compose file references it with `env_file:
// ./docker/firecrawl/firecrawl.env`, a path relative to the compose file — so
// this has to be materialized beside the materialized compose or `firecrawl up`
// fails before Docker is even reached.
export const FIRECRAWL_ENV = `# Tunables for the self-hosted Firecrawl stack (docker compose --profile extract).
# Wiring (hostnames, ports, SEARXNG_ENDPOINT) lives in docker-compose.yml and
# overrides anything set here.

# THIS is what makes the API keyless. Turning it on would require a Supabase
# project; there is no reason to for a localhost stack.
USE_DB_AUTHENTICATION=false

# Firecrawl's Rust PDF extractor, which is OFF by default upstream. Without it
# Firecrawl falls back to pdf-parse (JS) for PDFs. Still keyless: this is the
# local Rust path, not the MinerU / Fire PDF routes, which need API credentials.
# Reached as a rung of the PDF ladder when the built-in reader finds no text.
PDF_RUST_EXTRACT_ENABLE=true

# Postgres credentials for the bundled nuq-postgres container. It is not
# published on a host port, so these never leave the compose network.
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=postgres
POSTGRES_PORT=5432

# Admin queue dashboard at http://localhost:3002/admin/CHANGEME/queues
BULL_AUTH_KEY=CHANGEME

# Concurrency, trimmed for a laptop. Upstream defaults are 8/5/5/10 and assume
# a 4-CPU / 8-GB box; these keep the stack near ~4 GB total.
NUM_WORKERS_PER_QUEUE=2
MAX_CONCURRENT_JOBS=3
BROWSER_POOL_SIZE=2
CRAWL_CONCURRENT_REQUESTS=4

# Back off before the host runs out of headroom.
MAX_CPU=0.8
MAX_RAM=0.8

LOGGING_LEVEL=info
`;

// Materialize the compose stack under <cacheRoot>/compose/ (rewriting only when
// content changed, so an upgrade refreshes it) and return the compose file path.
// The searxng settings and the firecrawl env file keep their ./docker/...
// relative paths, so the embedded copies stay byte-identical to the repo files.
/**
 * The embedded assets with `{{CLI}}` resolved to the consumer's command.
 *
 * The templates name a tool in their comments, and the tool they name is
 * whoever wrote the file out — not this engine. A vendored copy that told the
 * reader to run `webindex semantic up` would be naming a binary they do not
 * have. Substituted at CALL time, per the lazy rule in src/brand.ts.
 */
export function renderAsset(template: string): string {
  return template.replaceAll("{{CLI}}", brand().cli);
}

export function ensureComposeMaterialized(): string {
  const base = join(brand().cacheDir ?? join(tmpdir(), brand().name), "compose");
  const composePath = join(base, "docker-compose.yml");
  const settingsPath = join(base, "docker", "searxng", "settings.yml");
  const firecrawlEnvPath = join(base, "docker", "firecrawl", "firecrawl.env");
  writeIfChanged(composePath, renderAsset(COMPOSE_YAML));
  writeIfChanged(settingsPath, renderAsset(SEARXNG_SETTINGS_YAML));
  writeIfChanged(firecrawlEnvPath, renderAsset(FIRECRAWL_ENV));
  return composePath;
}

function writeIfChanged(path: string, content: string): void {
  try {
    if (existsSync(path) && readFileSync(path, "utf8") === content) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  } catch {
    /* best-effort — composeControl surfaces docker errors if the path is unusable */
  }
}

// ── Driving the stack ───────────────────────────────────────────────────────

/** What one `docker` invocation produced. Mirrors the shape a caller can act on. */
export interface StackRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The binary was not on PATH — a different problem from a non-zero exit. */
  missing?: boolean;
}

/**
 * The two host effects `stackControl` needs, injectable so its orchestration is
 * unit-testable without a Docker daemon. Both default to the real thing.
 */
export interface StackDeps {
  run?: (cmd: string, args: string[], opts: { timeoutMs: number; capture?: boolean }) => StackRun;
  has?: (cmd: string) => boolean;
}

export interface StackResult {
  /** Ready to print. Multi-line for `up`, which reports what to do next. */
  message: string;
  code: number;
}

export type StackAction = "up" | "down" | "status";

// Budgets. Only the image pull is configurable: it is the one that legitimately
// takes tens of minutes on a cold machine, and the one whose failure is most
// often just "the network was slow", not "this is broken".
const DEFAULT_PULL_TIMEOUT_MS = 1_200_000; // 20 min — the Ollama image alone is >1.6 GB
const UP_TIMEOUT_MS = 300_000;
const DOWN_TIMEOUT_MS = 120_000;
const PS_TIMEOUT_MS = 30_000;
const MODEL_PULL_TIMEOUT_MS = 600_000;

function pullTimeoutMs(): number {
  return envInt("DOCKER_PULL_TIMEOUT_MS", DEFAULT_PULL_TIMEOUT_MS);
}

/** The embedding model the `ollama` service is expected to serve. */
export function embedModel(): string {
  return env("EMBED_MODEL") ?? "nomic-embed-text";
}

function defaultRun(cmd: string, args: string[], opts: { timeoutMs: number; capture?: boolean }): StackRun {
  // `capture: false` inherits the terminal, which is the point for `pull` and
  // `up`: those are the slow ones, and a 20-minute silence is indistinguishable
  // from a hang. Their output is progress, not data — nothing reads it back.
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: opts.capture ? "pipe" : "inherit",
  });
  const missing = !!res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT";
  return {
    ok: !res.error && res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
    missing,
  };
}

function defaultHas(cmd: string): boolean {
  const probe = defaultRun(process.platform === "win32" ? "where" : "which", [cmd], { timeoutMs: 10_000, capture: true });
  return probe.ok && probe.stdout.trim().length > 0;
}

/**
 * One controllable subset of the compose file: which profiles it starts, what a
 * successful `up` reports, and any work that only makes sense once the
 * containers answer.
 */
interface StackSpec {
  profiles: string[];
  summary: string;
  /** Extra steps after a green `up`. Returns the lines appended to the report. */
  postUp?: (file: string, run: NonNullable<StackDeps["run"]>) => string[];
}

// Firecrawl delegates its keyless `/search` to SearXNG, so bringing it up alone
// would give an extractor that cannot discover anything — hence `search` too.
const STACKS: Record<string, StackSpec> = {
  searxng: {
    profiles: ["search"],
    summary: "SearXNG is up (:8888) — keyless discovery, JSON API enabled.",
  },
  firecrawl: {
    profiles: ["search", "extract"],
    summary: "Firecrawl is up (:3002 · playwright · redis · rabbitmq · postgres), with SearXNG behind it.",
    postUp: () => [
      "  keyless: USE_DB_AUTHENTICATION=false — no API key is sent or needed.",
      "  effect:  pages are now cleaned by a real browser; --firecrawl off opts out.",
    ],
  },
  semantic: {
    profiles: ["semantic"],
    summary: "Qdrant (:6333) and Ollama (:11434) are up.",
    postUp: (file, run) => {
      // Idempotent, and embeddings do not work until it has run once. A failure
      // here is not a failed `up` — the containers are fine, one model is not
      // there yet — so it degrades to the command to run by hand.
      const model = embedModel();
      const pull = run("docker", ["compose", "-f", file, "exec", "-T", "ollama", "ollama", "pull", model], { timeoutMs: MODEL_PULL_TIMEOUT_MS, capture: true });
      return [pull.ok ? `  model:   ${model} ready` : `  model:   pull it yourself: docker compose -f ${file} exec ollama ollama pull ${model}`];
    },
  },
  all: {
    profiles: ["all", "extract"],
    summary: "The whole stack is up (Qdrant · Ollama · SearXNG · Firecrawl).",
    postUp: (file, run) => STACKS.semantic!.postUp!(file, run),
  },
};

/**
 * Fold several services into one. A tool whose own command means more than one
 * of these — "start the cheap local stack" covering both semantic search and
 * discovery — should bring them up in ONE `docker compose` call: two calls
 * against the same project make the second recreate what the first started.
 *
 * Returns null if any name is unknown, so the caller can say which.
 */
function combine(names: string[]): StackSpec | null {
  const specs = names.map((n) => STACKS[n]);
  if (specs.some((x) => !x)) return null;
  const found = specs as StackSpec[];
  if (found.length === 1) return found[0]!;
  return {
    profiles: [...new Set(found.flatMap((x) => x.profiles))],
    summary: found.map((x) => x.summary).join("\n  "),
    postUp: (file, run) => found.flatMap((x) => x.postUp?.(file, run) ?? []),
  };
}

/** The services this stack knows how to drive. */
export const STACK_SERVICES = Object.keys(STACKS);

/** Which compose profiles each service needs. */
export const SERVICE_PROFILES: Record<string, string[]> = Object.fromEntries(Object.entries(STACKS).map(([k, v]) => [k, v.profiles]));

/**
 * Run `docker compose` for a service, against the embedded stack.
 *
 * Materialises the compose file first, so this works from any install — a
 * global npm install, a Homebrew cellar, a vendored bundle — and not only from
 * a checkout with docker-compose.yml beside the source. That last assumption is
 * what made the equivalent command fail for everyone who installed the tool
 * rather than cloned it.
 *
 * Never throws. Every failure comes back as a message and a non-zero code,
 * because not having Docker is a normal state for this tool: everything the
 * stack provides is optional and degrades to a note.
 */
export function stackControl(service: string | string[], action: string, deps: StackDeps = {}): StackResult {
  const run = deps.run ?? defaultRun;
  const has = deps.has ?? defaultHas;
  const names = Array.isArray(service) ? service : [service];
  const tag = `${brand().cli} ${names.join("+")}`;

  const spec = combine(names);
  if (!spec) {
    const bad = names.filter((n) => !STACKS[n]);
    return { message: `${brand().cli}: unknown service ${bad.map((b) => `"${b}"`).join(", ")} — expected one of ${STACK_SERVICES.join(", ")}`, code: 1 };
  }
  if (action !== "up" && action !== "down" && action !== "status") {
    return { message: `${tag}: unknown action "${action}" (use: up | down | status)`, code: 1 };
  }
  if (!has("docker")) {
    return { message: `${tag}: docker not found on PATH. The stack is optional — everything it provides degrades to a note.`, code: 1 };
  }

  const file = ensureComposeMaterialized();
  const profiles = spec.profiles.flatMap((p) => ["--profile", p]);

  if (action === "down") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "down"], { timeoutMs: DOWN_TIMEOUT_MS, capture: true });
    return { message: r.ok ? `${tag}: stopped.` : `${tag}: down failed.\n${r.stderr}`, code: r.ok ? 0 : 1 };
  }

  if (action === "status") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "ps"], { timeoutMs: PS_TIMEOUT_MS, capture: true });
    // Not an error: "nothing is running" is a legitimate answer to a question.
    return { message: r.ok ? r.stdout.trim() || `${tag}: no services running.` : `${tag}: status failed.\n${r.stderr}`, code: 0 };
  }

  // Pull FIRST, on a budget that assumes a cold machine. `up` carries its own
  // shorter deadline, and letting it do the downloading means a first run dies
  // partway through a multi-gigabyte pull and reports it as a failed start.
  const pulled = run("docker", ["compose", "-f", file, ...profiles, "pull"], { timeoutMs: pullTimeoutMs() });
  if (!pulled.ok) {
    return {
      message:
        `${tag}: pulling the images failed (they are large — raise ${envName("DOCKER_PULL_TIMEOUT_MS")}, currently ${pullTimeoutMs()}ms).` +
        (pulled.stderr ? `\n${pulled.stderr}` : ""),
      code: 1,
    };
  }

  // `--wait` blocks until every healthcheck passes, so a green `up` means the
  // endpoints actually answer — without it the very next probe can fail against
  // a container that is merely "started".
  const up = run("docker", ["compose", "-f", file, ...profiles, "up", "-d", "--wait"], { timeoutMs: UP_TIMEOUT_MS });
  if (!up.ok) return { message: `${tag}: up failed.${up.stderr ? `\n${up.stderr}` : ""}`, code: 1 };

  return { message: [`${tag}: ${spec.summary}`, ...(spec.postUp?.(file, run) ?? [])].join("\n"), code: 0 };
}
