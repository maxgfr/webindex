import { describe, expect, it } from "vitest";
import * as facade from "../src/browser.js";
import * as index from "../src/index.js";
import { classifyChallenge } from "../src/browser/challenge.js";
import { renderSnapshot } from "../src/browser/snapshot.js";

const FUNCTIONS = [
  "openBrowserSession",
  "readRenderedPage",
  "renderBrowserSnapshot",
  "classifyBrowserChallenge",
  "detectBrowserBinary",
  "browserHome",
] as const;

describe("browser façade", () => {
  it("exports exactly the public functions", () => {
    expect(Object.keys(facade).sort()).toEqual([...FUNCTIONS].sort());
    for (const name of FUNCTIONS) expect(typeof (facade as Record<string, unknown>)[name]).toBe("function");
  });

  it("aliases the unprefixed internals", () => {
    expect(facade.renderBrowserSnapshot).toBe(renderSnapshot);
    expect(facade.classifyBrowserChallenge).toBe(classifyChallenge);
  });

  it("is re-exported by the package index, and nothing else browser-ish leaks", () => {
    for (const name of FUNCTIONS) expect((index as Record<string, unknown>)[name]).toBe((facade as Record<string, unknown>)[name]);
    // browserUa and looksLikeChallenge predate the CDP layer (fetch.ts).
    const OLD = ["browserUa", "looksLikeChallenge"];
    const found = Object.keys(index).filter((k) => /browser|cdp|challenge|snapshot|session|rendered/i.test(k) && !OLD.includes(k));
    expect(found.sort()).toEqual([...FUNCTIONS].sort());
  });
});
