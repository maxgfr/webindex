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
      // Measured on the retrieval layer as it stands: statements 93.0,
      // branches 84.3, functions 94.0, lines 96.1.
      //
      // The shortfall is concentrated in fetch.ts (89% statements, 78%
      // branches) and is KNOWN debt, not an unknown. Upstream those paths are
      // covered end-to-end by suites that cannot move yet because they drive a
      // dossier the engine does not own:
      //
      //   hydration.test.ts      the rescue ladder and extractor accounting
      //   gather.test.ts         hydration inside a real run
      //   robustness.test.ts     malformed-response handling
      //   source-hygiene.test.ts junk-extraction and consent-wall detection
      //
      // Note they will NOT fix themselves at migration: once ultrasearch
      // vendors the bundle, those suites exercise the engine but their coverage
      // lands on a vendored file, not on src/ here. So the debt is repaid by
      // porting them (with a dossier fixture) or by writing engine-level
      // equivalents — track it, do not quietly forget it.
      thresholds: {
        statements: 92,
        branches: 83,
        functions: 93,
        lines: 95,
      },
    },
  },
});
