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

  // Make the retry backoff and the polite inter-request delays instant, so
  // failure-path tests (429/503 retry, network-error retry, pagination)
  // exercise the logic without waiting real milliseconds.
  //
  // Upstream this needed two side-effect modules, _fastfetch.ts and
  // _polite0.ts, each carrying the same warning: "Must be imported FIRST,
  // before src/backends/fetch.ts reads these env vars at module load." That
  // ordering contract is gone — the engine reads its tunables at CALL time
  // (see the lazy rule in src/brand.ts), so setting them here, per case, is
  // enough and cannot be defeated by import order.
  process.env[`${TEST_PREFIX}_RETRY_MS`] = "0";
  process.env[`${TEST_PREFIX}_POLITE_DELAY_MS`] = "0";
  process.env[`${TEST_PREFIX}_PAGE_DELAY_MS`] = "0";

  // Own cache dir, so a run never reads or writes the real one and a second run
  // inside the 24h TTL is not served a page from disk instead of the mock.
  process.env[`${TEST_PREFIX}_CACHE_DIR`] = testCacheDir;

  // Firecrawl and SearXNG default to localhost and are gated by an availability
  // probe. Under a stubbed global fetch that probe SUCCEEDS — the mock answers
  // every URL, including the probe — so every test would silently route through
  // a fake instance, and the probe itself would show up as an extra call in
  // fetch-count assertions. Disable both; the suites that exercise them pass an
  // explicit base ({ firecrawl: "http://fc.test" }), which overrides this.
  process.env[`${TEST_PREFIX}_FIRECRAWL`] = "off";
  process.env[`${TEST_PREFIX}_SEARXNG`] = "off";

  // The PDF ladder shells out to npx and pdftotext: network access, ~90s
  // timeouts, and results that depend on which tools the developer happens to
  // have installed — the opposite of an offline, deterministic suite. Pin it to
  // the built-in reader; suites exercising other rungs set the engine or pass
  // `engines` themselves.
  process.env[`${TEST_PREFIX}_PDF_ENGINE`] = "native";

  // The office ladder shells out to npx too and has no built-in last rung, so
  // `none` disables it. This also keeps the default assertion honest: a
  // document nothing can read must REFUSE, which is what doc-extract pins.
  process.env[`${TEST_PREFIX}_DOC_ENGINE`] = "none";

  // OCR rasterises at 300 DPI through copyable-pdf + tesseract: machine-
  // dependent, seconds per page. A budget of 0 switches the rung off for the
  // whole suite; pdf-ocr.test.ts drives it with the subprocess layer stubbed.
  process.env[`${TEST_PREFIX}_OCR_MAX`] = "0";
});

afterEach(() => {
  clearTestEnv();
  resetBrand();
});
