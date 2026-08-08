import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPOSE_YAML,
  FIRECRAWL_ENV,
  SEARXNG_SETTINGS_YAML,
  SERVICE_PROFILES,
  STACK_SERVICES,
  composeControl,
  ensureComposeMaterialized,
} from "../src/stack.js";

// The stack is EMBEDDED so the commands work from any install rather than only
// from a checkout with docker-compose.yml beside the source. These pin that it
// really is self-contained and really lands on disk.

describe("the embedded assets", () => {
  it("carries a compose file with every service the profiles reference", () => {
    for (const svc of ["searxng", "firecrawl", "qdrant", "ollama"]) {
      expect(COMPOSE_YAML, svc).toContain(`  ${svc}:`);
    }
    // One fixed project name is what lets several tools share one set of
    // containers instead of colliding on the same host ports.
    expect(COMPOSE_YAML).toMatch(/^name: \w+/m);
  });

  it("enables SearXNG's JSON output, which is the whole reason a local one ships", () => {
    // Most public instances disable it, and without it the search backend
    // cannot read a result page at all.
    expect(SEARXNG_SETTINGS_YAML).toContain("json");
  });

  it("keeps Firecrawl keyless", () => {
    expect(FIRECRAWL_ENV).toMatch(/USE_DB_AUTHENTICATION\s*=\s*false/);
  });

  it("names no particular consuming tool", () => {
    // The stack is shared infrastructure; naming one tool in the file every
    // other tool also writes out is how the copies drift.
    const assets: [string, string][] = [
      ["compose", COMPOSE_YAML],
      ["searxng", SEARXNG_SETTINGS_YAML],
      ["firecrawl", FIRECRAWL_ENV],
    ];
    for (const [label, text] of assets) {
      expect(text.toLowerCase(), label).not.toMatch(/ultrasearch|ultradoc|maxgfr\/construct/);
    }
  });
});

describe("materialisation", () => {
  it("writes the compose file and both assets, and is idempotent", () => {
    const first = ensureComposeMaterialized();
    expect(readFileSync(first, "utf8")).toBe(COMPOSE_YAML);
    expect(readFileSync(join(dirname(first), "docker", "searxng", "settings.yml"), "utf8")).toBe(SEARXNG_SETTINGS_YAML);
    expect(readFileSync(join(dirname(first), "docker", "firecrawl", "firecrawl.env"), "utf8")).toBe(FIRECRAWL_ENV);
    expect(ensureComposeMaterialized()).toBe(first);
  });

  it("lands under the configured brand's cache dir, not a shared one", () => {
    expect(ensureComposeMaterialized()).toContain("webindex-tests");
  });
});

describe("composeControl", () => {
  it("knows which profiles each service needs", () => {
    // Firecrawl delegates its keyless /search to SearXNG, so starting it alone
    // would give an extractor that cannot discover anything.
    expect(SERVICE_PROFILES.firecrawl).toContain("search");
    expect(STACK_SERVICES).toEqual(expect.arrayContaining(["searxng", "firecrawl", "all"]));
  });

  it("refuses an unknown service instead of shelling out", async () => {
    await expect(composeControl("not-a-service", "status")).resolves.toBe(1);
  });
});
