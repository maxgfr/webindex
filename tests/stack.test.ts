import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPOSE_YAML,
  FIRECRAWL_ENV,
  SEARXNG_SETTINGS_YAML,
  SERVICE_PROFILES,
  STACK_SERVICES,
  type StackDeps,
  type StackRun,
  ensureComposeMaterialized,
  embedModel,
  stackControl,
} from "../src/stack.js";
import { envName } from "../src/brand.js";

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

describe("stackControl", () => {
  // A recording fake docker. Every case asserts on the argv it would have run,
  // so the whole orchestration is pinned without a daemon anywhere near it.
  function fake(over: { fails?: string; missingDocker?: boolean; ps?: string } = {}) {
    const calls: string[][] = [];
    const run: NonNullable<StackDeps["run"]> = (cmd, args): StackRun => {
      calls.push([cmd, ...args]);
      const verb = args.find((a) => ["pull", "up", "down", "ps", "exec"].includes(a)) ?? "";
      const ok = over.fails !== verb;
      return { ok, stdout: verb === "ps" ? (over.ps ?? "") : "", stderr: ok ? "" : `${verb} exploded` };
    };
    return { calls, deps: { run, has: () => !over.missingDocker } as StackDeps };
  }
  const argvOf = (calls: string[][], verb: string) => calls.find((c) => c.includes(verb));

  it("knows which profiles each service needs", () => {
    // Firecrawl delegates its keyless /search to SearXNG, so starting it alone
    // would give an extractor that cannot discover anything.
    expect(SERVICE_PROFILES.firecrawl).toContain("search");
    expect(STACK_SERVICES).toEqual(expect.arrayContaining(["searxng", "firecrawl", "semantic", "all"]));
  });

  it("refuses an unknown service or action instead of shelling out", () => {
    const a = fake();
    expect(stackControl("not-a-service", "status", a.deps).code).toBe(1);
    const b = fake();
    expect(stackControl("searxng", "restart", b.deps).code).toBe(1);
    expect(b.deps.run).toBeDefined();
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  it("says docker is missing without pretending that is a crash", () => {
    const { calls, deps } = fake({ missingDocker: true });
    const r = stackControl("searxng", "up", deps);
    expect(r.code).toBe(1);
    expect(r.message).toContain("docker not found");
    expect(r.message).toContain("degrades to a note");
    expect(calls).toEqual([]);
  });

  it("pulls before it starts, so a cold first run is not a failed start", () => {
    // `up` runs on a 5-minute budget. Let it do a multi-gigabyte download and a
    // slow network looks exactly like a broken stack.
    const { calls, deps } = fake();
    expect(stackControl("searxng", "up", deps).code).toBe(0);
    expect(calls.map((c) => c.find((a) => ["pull", "up"].includes(a)))).toEqual(["pull", "up"]);
  });

  it("waits for the healthchecks rather than reporting a container that merely started", () => {
    const { calls, deps } = fake();
    stackControl("searxng", "up", deps);
    expect(argvOf(calls, "up")).toEqual(expect.arrayContaining(["-d", "--wait"]));
  });

  it("blames the pull budget by name when the pull times out", () => {
    const { calls, deps } = fake({ fails: "pull" });
    const r = stackControl("firecrawl", "up", deps);
    expect(r.code).toBe(1);
    expect(r.message).toContain(envName("DOCKER_PULL_TIMEOUT_MS"));
    expect(argvOf(calls, "up")).toBeUndefined(); // never attempted
  });

  it("honours the consumer's own pull budget", () => {
    process.env[envName("DOCKER_PULL_TIMEOUT_MS")] = "1234";
    const { deps } = fake({ fails: "pull" });
    expect(stackControl("searxng", "up", deps).message).toContain("1234ms");
  });

  it("pulls the embedding model once the semantic containers answer", () => {
    const { calls, deps } = fake();
    const r = stackControl("semantic", "up", deps);
    expect(argvOf(calls, "exec")).toEqual(expect.arrayContaining(["ollama", "pull", embedModel()]));
    expect(r.message).toContain(`${embedModel()} ready`);
  });

  it("treats a failed model pull as advice, not a failed up", () => {
    // The containers ARE up. One model is not there yet, and the user can fix
    // that in one command — exiting non-zero would say the stack is broken.
    const { deps } = fake({ fails: "exec" });
    const r = stackControl("semantic", "up", deps);
    expect(r.code).toBe(0);
    expect(r.message).toContain("pull it yourself");
  });

  it("lets the consumer choose the embedding model", () => {
    process.env[envName("EMBED_MODEL")] = "mxbai-embed-large";
    const { calls, deps } = fake();
    stackControl("semantic", "up", deps);
    expect(argvOf(calls, "exec")).toContain("mxbai-embed-large");
  });

  it("reports status as data on a zero exit, even when nothing runs", () => {
    // `status` answers a question. "Nothing is running" is an answer.
    const { deps } = fake({ ps: "" });
    const r = stackControl("searxng", "status", deps);
    expect(r.code).toBe(0);
    expect(r.message).toContain("no services running");

    const withRows = fake({ ps: "NAME   STATUS\nskills-searxng  Up 2 minutes\n" });
    expect(stackControl("searxng", "status", withRows.deps).message).toContain("skills-searxng");
  });

  it("captures the output it reports and streams the output it does not", () => {
    // pull/up produce progress nobody reads back, and a 20-minute silence is
    // indistinguishable from a hang — so those inherit the terminal.
    const seen: { verb: string; capture?: boolean }[] = [];
    const deps: StackDeps = {
      has: () => true,
      run: (_cmd, args, opts) => {
        seen.push({ verb: args.find((a) => ["pull", "up", "down", "ps"].includes(a)) ?? "?", capture: opts.capture });
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    stackControl("searxng", "up", deps);
    stackControl("searxng", "status", deps);
    stackControl("searxng", "down", deps);
    expect(seen).toEqual([
      { verb: "pull", capture: undefined },
      { verb: "up", capture: undefined },
      { verb: "ps", capture: true },
      { verb: "down", capture: true },
    ]);
  });

  it("drives the embedded file, never a checkout's", () => {
    const { calls, deps } = fake();
    stackControl("searxng", "status", deps);
    expect(argvOf(calls, "ps")).toEqual(expect.arrayContaining(["-f", ensureComposeMaterialized()]));
  });

  it("names the consumer's command, not the engine's", () => {
    const { deps } = fake({ missingDocker: true });
    expect(stackControl("searxng", "up", deps).message.startsWith("webindex-tests searxng:")).toBe(true);
  });
});
