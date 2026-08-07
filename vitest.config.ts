import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/fixtures/**"],
    // Pins the brand to a throwaway identity and the fetch cache to a scratch
    // dir — the engine reads `${envPrefix}_*` at call time, and the suite must
    // never touch a real consumer's cache.
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "text"],
      // A ratchet, not an aspiration: set a couple of points below the measured
      // baseline so coverage cannot silently regress. Raise these when real
      // coverage climbs; never lower them to make a red run pass.
      //
      // Each layer moved in from the skills must arrive WITH its ported suite —
      // if a migration drops the numbers, the answer is the missing tests, not
      // a smaller threshold.
      //
      // Measured across the whole extracted engine: statements 90.0,
      // branches 82.9, functions 91.7, lines 92.4.
      //
      // This is the floor for the extraction as a whole, set once now that all
      // three layers are in, rather than nudged after each move. It goes UP
      // from here and never down — a change that drops it means the missing
      // test, not a smaller number.
      //
      // The shortfall is KNOWN debt, in two places:
      //
      //   fetch.ts (89% stmts, 78% branches) — the rescue ladder, extractor
      //   accounting, malformed-response and consent-wall paths are covered
      //   upstream by hydration / gather / robustness / source-hygiene, which
      //   cannot move because they drive a dossier the engine does not own.
      //
      //   mcp/{http,stdio}.ts (71% / 75%) — backpressure, request timeouts and
      //   mid-write hangups are covered by each consumer's end-to-end MCP
      //   suite, which drives real tools over a real socket.
      //
      // Neither repays itself at migration: once a skill vendors the bundle,
      // its suites exercise the engine but their coverage lands on a vendored
      // file, not on src/ here. Repaying means porting them with a fixture, or
      // writing engine-level equivalents. Track it; do not quietly forget it.
      thresholds: {
        statements: 89,
        branches: 82,
        functions: 91,
        lines: 92,
      },
    },
  },
});
