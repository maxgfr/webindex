import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { configure, resetBrand } from "../src/brand.js";

// Every test runs under a throwaway brand whose prefix belongs to no real
// consumer. Two reasons this matters:
//
//   1. the engine reads `${envPrefix}_*` at call time, so a suite that ran
//      under ULTRASEARCH_* would pick up whatever the developer has exported in
//      their own shell and fail differently on every machine;
//   2. a stray WEBINDEX_CACHE_DIR would let a test write into a real cache.
//
// The scratch prefix WEBINDEX_TEST_ is unset before and after each case, so no
// test can leak configuration into the next one.
const TEST_PREFIX = "WEBINDEX_TEST";

export const testCacheDir = mkdtempSync(join(tmpdir(), "webindex-tests-"));

function clearTestEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(`${TEST_PREFIX}_`)) delete process.env[key];
  }
}

beforeEach(() => {
  clearTestEnv();
  configure({ name: "webindex-tests", envPrefix: TEST_PREFIX, cli: "webindex-tests", cacheDir: testCacheDir });
});

afterEach(() => {
  clearTestEnv();
  resetBrand();
});
