import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "../src/version.js";

describe("ENGINE_VERSION", () => {
  it("is a plain semver literal", () => {
    // Consumers' sync-engine.mjs greps this value out of the built bundle and
    // refuses a pin whose tag disagrees with it. Anything but a bare semver
    // string breaks that gate.
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });

  it("matches package.json", () => {
    // scripts/sync-version.mjs writes both during release; if they ever drift,
    // every consumer's re-pin fails closed. Catch it here instead.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  it("is assigned exactly once, as a quoted literal, in the source", () => {
    // The pin gate is a regex over the bundle. A second assignment — or the
    // pattern appearing in a comment that survives bundling — would let it read
    // the wrong version.
    const src = readFileSync(new URL("../src/version.ts", import.meta.url), "utf8");
    const matches = src.match(/ENGINE_VERSION = "[^"]+"/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
