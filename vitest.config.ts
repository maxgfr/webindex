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
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
