import { describe, expect, it } from "vitest";
import { brand, configure, env, envFlag, envInt, envName, resetBrand } from "../src/brand.js";

// The suite's setup file has already configured the WEBINDEX_TEST brand.
const P = "WEBINDEX_TEST";

describe("configure", () => {
  it("rejects a prefix that is not UPPER_SNAKE", () => {
    // A lowercase or hyphenated prefix would silently read nothing at all,
    // which is far worse than refusing at startup.
    expect(() => configure({ name: "x", envPrefix: "ultradoc", cli: "x" })).toThrow(/UPPER_SNAKE/);
    expect(() => configure({ name: "x", envPrefix: "ULTRA-DOC", cli: "x" })).toThrow(/UPPER_SNAKE/);
    expect(() => configure({ name: "x", envPrefix: "", cli: "x" })).toThrow(/UPPER_SNAKE/);
    expect(() => configure({ name: "x", envPrefix: "1ABC", cli: "x" })).toThrow(/UPPER_SNAKE/);
  });

  it("accepts digits and underscores after the first letter", () => {
    expect(() => configure({ name: "x", envPrefix: "ULTRA_DOC2", cli: "x" })).not.toThrow();
  });

  it("requires both name and cli", () => {
    expect(() => configure({ name: "", envPrefix: "ABC", cli: "x" })).toThrow(/name.*cli/);
    expect(() => configure({ name: "x", envPrefix: "ABC", cli: "" })).toThrow(/name.*cli/);
  });

  it("exposes the configured identity", () => {
    configure({ name: "ultradoc", envPrefix: "ULTRADOC", cli: "ultradoc" });
    expect(brand().name).toBe("ultradoc");
    expect(brand().cli).toBe("ultradoc");
    expect(envName("SEARXNG")).toBe("ULTRADOC_SEARXNG");
  });

  it("falls back to webindex's own identity when never configured", () => {
    resetBrand();
    expect(brand().envPrefix).toBe("WEBINDEX");
    expect(envName("SEARXNG")).toBe("WEBINDEX_SEARXNG");
  });
});

describe("env", () => {
  it("reads through the configured prefix", () => {
    process.env[`${P}_SEARXNG`] = "http://localhost:8888";
    expect(env("SEARXNG")).toBe("http://localhost:8888");
  });

  it("is read at call time, not module-load time", () => {
    // The whole reason the brand is a function and not a constant: a vendored
    // bundle is imported before the consumer can configure it.
    expect(env("LATE")).toBeUndefined();
    process.env[`${P}_LATE`] = "arrived";
    expect(env("LATE")).toBe("arrived");
  });

  it("follows a re-configured prefix", () => {
    process.env.OTHER_SEARXNG = "http://other:8888";
    configure({ name: "other", envPrefix: "OTHER", cli: "other" });
    expect(env("SEARXNG")).toBe("http://other:8888");
    delete process.env.OTHER_SEARXNG;
  });

  it("trims, and treats blank as unset", () => {
    process.env[`${P}_UA`] = "  Mozilla/5.0  ";
    expect(env("UA")).toBe("Mozilla/5.0");
    process.env[`${P}_UA`] = "   ";
    expect(env("UA")).toBeUndefined();
    process.env[`${P}_UA`] = "";
    expect(env("UA")).toBeUndefined();
  });
});

describe("envFlag", () => {
  it("is off when unset", () => {
    expect(envFlag("NO_NPX")).toBe(false);
  });

  it("is on for any ordinary truthy spelling", () => {
    for (const v of ["1", "true", "yes", "on", "anything"]) {
      process.env[`${P}_NO_NPX`] = v;
      expect(envFlag("NO_NPX"), v).toBe(true);
    }
  });

  it("is off for explicit negatives, case-insensitively", () => {
    // The presence-only test this replaces read `NO_NPX=0` as ON, which is the
    // opposite of what anyone writing it means.
    for (const v of ["0", "false", "FALSE", "no", "Off"]) {
      process.env[`${P}_NO_NPX`] = v;
      expect(envFlag("NO_NPX"), v).toBe(false);
    }
  });
});

describe("envInt", () => {
  it("returns the default when unset", () => {
    expect(envInt("OCR_MAX", 5)).toBe(5);
  });

  it("parses and truncates", () => {
    process.env[`${P}_OCR_MAX`] = "12";
    expect(envInt("OCR_MAX", 5)).toBe(12);
    process.env[`${P}_OCR_MAX`] = "12.9";
    expect(envInt("OCR_MAX", 5)).toBe(12);
  });

  it("clamps into range", () => {
    process.env[`${P}_ATTEMPTS`] = "99";
    expect(envInt("ATTEMPTS", 2, 1, 5)).toBe(5);
    process.env[`${P}_ATTEMPTS`] = "-4";
    expect(envInt("ATTEMPTS", 2, 1, 5)).toBe(1);
  });

  it("keeps zero when zero is in range", () => {
    // One of the three drifted copies rejected 0, which silently ignored
    // `PAGE_DELAY_MS=0` — the one value a user sets it to on purpose.
    process.env[`${P}_PAGE_DELAY_MS`] = "0";
    expect(envInt("PAGE_DELAY_MS", 350, 0, 5000)).toBe(0);
  });

  it("falls back on garbage rather than throwing", () => {
    for (const v of ["abc", "NaN", "Infinity", "  "]) {
      process.env[`${P}_OCR_MAX`] = v;
      expect(envInt("OCR_MAX", 5), v).toBe(5);
    }
  });
});
