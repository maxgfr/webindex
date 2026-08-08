import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brand } from "./brand.js";

// The optional local Docker stack, embedded so `webindex semantic up|down|status`
// and `webindex firecrawl up|down|status` work from ANY install location (npx
// skills add, npm, a curled bundle) — not just a dev checkout where
// docker-compose.yml sits beside the source. The repo files
// (docker-compose.yml, docker/searxng/settings.yml, docker/firecrawl/firecrawl.env)
// remain the editable source of truth; tests/compose.test.ts fails if these
// copies drift from them.

export const COMPOSE_YAML = `# Optional, fully-local, no-API-key stack for a semantic mode, web
# search and content extraction. Start it with \`webindex semantic up\` (or
# \`docker compose --profile all up -d\`). The published bundle stays
# dependency-free — it only speaks HTTP to these containers on localhost;
# nothing here is required for Tier-1 retrieval.
#
# Profiles let you start subsets:
#   --profile semantic  → qdrant + ollama (vector search)
#   --profile search    → searxng (web discovery)
#   --profile all       → everything above
#   --profile extract   → firecrawl (content cleaning; \`webindex firecrawl up\`)
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
  # (\`webindex semantic up\` does this for you).
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
  # containers, and \`webindex semantic up\` must stay cheap.
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
export function ensureComposeMaterialized(): string {
  const base = join(brand().cacheDir ?? join(tmpdir(), brand().name), "compose");
  const composePath = join(base, "docker-compose.yml");
  const settingsPath = join(base, "docker", "searxng", "settings.yml");
  const firecrawlEnvPath = join(base, "docker", "firecrawl", "firecrawl.env");
  writeIfChanged(composePath, COMPOSE_YAML);
  writeIfChanged(settingsPath, SEARXNG_SETTINGS_YAML);
  writeIfChanged(firecrawlEnvPath, FIRECRAWL_ENV);
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
//
// Which compose profiles each service needs. Firecrawl delegates its keyless
// `/search` to SearXNG, so bringing it up alone would give you an extractor
// that cannot discover anything.
export const SERVICE_PROFILES: Record<string, string[]> = {
  searxng: ["search"],
  firecrawl: ["search", "extract"],
  semantic: ["semantic"],
  all: ["all", "extract"],
};

export type StackAction = "up" | "down" | "status";

/** The services this stack knows how to drive. */
export const STACK_SERVICES = Object.keys(SERVICE_PROFILES);

/**
 * Run `docker compose` for a service, against the embedded stack.
 *
 * Materialises the compose file first, so this works from any install — a
 * global npm install, a Homebrew cellar, a vendored bundle — and not only from
 * a checkout with docker-compose.yml beside the source. That last assumption is
 * what made the equivalent command fail for anyone who installed the tool
 * rather than cloned it.
 *
 * Resolves with the exit code; never throws. A missing `docker` is reported as
 * a message rather than a stack trace, because not having Docker is a normal
 * state for this tool — everything it gates is optional.
 */
export function composeControl(service: string, action: StackAction): Promise<number> {
  const profiles = SERVICE_PROFILES[service];
  if (!profiles) {
    process.stderr.write(`${brand().cli}: unknown service "${service}" — expected one of ${STACK_SERVICES.join(", ")}\n`);
    return Promise.resolve(1);
  }
  const file = ensureComposeMaterialized();
  const flags = profiles.flatMap((p) => ["--profile", p]);
  const verb = action === "status" ? ["ps"] : action === "up" ? ["up", "-d", "--wait"] : ["down"];
  const args = ["compose", "-f", file, ...flags, ...verb];

  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("error", (e: NodeJS.ErrnoException) => {
      process.stderr.write(
        e.code === "ENOENT"
          ? `${brand().cli}: docker not found on PATH. The stack is optional — every rung it provides degrades to a note.\n`
          : `${brand().cli}: ${e.message}\n`,
      );
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
