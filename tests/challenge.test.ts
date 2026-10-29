import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configure } from "../src/brand.js";
import { fetchAndExtract, looksLikeJunkExtraction } from "../src/fetch.js";
import { challengeUrl, isWordedWall, looksLikeWall, wallPattern } from "../src/walls.js";
import { installFetchMock } from "./fetchmock.js";
import { testCacheDir } from "./setup.js";

afterEach(() => vi.unstubAllGlobals());

// wiki.openfoodfacts.org, as the engine extracted it during a research run: an
// Anubis proof-of-work page stored as a source. Its one strong phrase sits above
// three lines of the template's own prose, which outvoted it.
const ANUBIS = readFileSync(join(import.meta.dirname, "fixtures/pages/anubis-challenge.txt"), "utf8");

// developer.apple.com/forums/verify-human/verify.html, as extracted (HTTP 200).
const APPLE =
  "# Security verification in progress. Please wait while we verify your browser to protect against automated access.\n" +
  "## Verifying connection...\nVerification Successful. Redirecting...\n## Invalid connection";

describe("challenge pages are walls by their wording", () => {
  it("flags the Anubis proof-of-work page, whatever prose its template carries", () => {
    expect(ANUBIS).toContain("Making sure you're not a bot!");
    expect(looksLikeJunkExtraction(ANUBIS)).toMatch(/anti-bot/);
    expect(wallPattern(ANUBIS)).toMatch(/anti-bot/);
    expect(isWordedWall(looksLikeWall(ANUBIS))).toBe(true);
  });

  it("flags the Anubis title alone, and its curly-apostrophe spelling", () => {
    expect(wallPattern("# Making sure you’re not a bot!\nLoading...")).toMatch(/anti-bot/);
    expect(wallPattern("Making sure you are not a bot!")).toMatch(/anti-bot/);
  });

  it("flags Apple's security-verification interstitial", () => {
    expect(wallPattern(APPLE)).toMatch(/anti-bot/);
    expect(isWordedWall(looksLikeWall(APPLE))).toBe(true);
  });

  it("does not take an article about Anubis for the page itself", () => {
    const article = [
      "# How Anubis keeps scrapers off small wikis",
      "Anubis is a reverse proxy that asks every new visitor's browser to solve a proof-of-work puzzle before it serves a page.",
      "Its challenge page is titled after its purpose, and operators can restyle it, but most leave the jackal mascot in place.",
      "Wiki administrators report that crawler traffic fell by an order of magnitude within a week of putting it in front of MediaWiki.",
      "The cost to a human visitor is a second or two of hashing on the first visit, after which a signed cookie lets them through.",
    ].join("\n");
    expect(wallPattern(article)).toBeUndefined();
    expect(looksLikeWall(article)).toBeUndefined();
  });
});

describe("challengeUrl", () => {
  it.each([
    "https://www.fda.gov/apology_objects/abuse-detection-apology.html",
    "https://developer.apple.com/forums/verify-human/verify.html?next=/forums/thread/731403",
    "https://example.test/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1",
    "https://wiki.example.test/.within.website/x/cmd/anubis/api/make-challenge",
    "https://shop.example.test/.well-known/sgcaptcha/?r=%2Fitem",
    "https://example.test/_Incapsula_Resource?SWJIYLWA=1",
  ])("names %s a challenge", (u) => {
    expect(challengeUrl(u)).toBeTruthy();
  });

  it.each([
    "https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods",
    "https://en.wikipedia.org/wiki/CAPTCHA",
    "https://blog.example.test/2024/how-we-built-our-captcha-solver",
    "https://developer.apple.com/forums/thread/731403",
    "not a url",
  ])("leaves %s alone", (u) => {
    expect(challengeUrl(u)).toBeUndefined();
  });
});

const uaOf = (init?: RequestInit) => String((init?.headers as Record<string, string> | undefined)?.["user-agent"] ?? "");
const REAL = "<html><body><article><p>Nutrition labeling for food: the real page, served to an honest client.</p></article></body></html>";

describe("fetchAndExtract on a redirect to a challenge", () => {
  // fda.gov answers a browser-like UA with a 404 at its abuse-detection apology
  // page, and a plain one with the page. One retry under the other UA gets it.
  it("retries once with the identifying UA and keeps the real page", async () => {
    const uas: string[] = [];
    installFetchMock((_url, init) => {
      uas.push(uaOf(init));
      return uaOf(init).includes("Mozilla/5.0")
        ? { status: 404, body: "<html><body>Sorry</body></html>", url: "https://www.fda.gov/apology_objects/abuse-detection-apology.html" }
        : { body: REAL, url: "https://www.fda.gov/food/nutrition-food-labeling" };
    });
    const res = await fetchAndExtract("https://www.fda.gov/food/food-labeling-nutrition");
    expect(uas).toHaveLength(2);
    expect(uas[0]).toContain("Mozilla/5.0");
    expect(uas[1]).toContain("webindex-tests/");
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe("https://www.fda.gov/food/nutrition-food-labeling");
    expect(res.text).toContain("the real page");
  });

  it("retries a contact-UA brand as a browser", async () => {
    configure({ name: "webindex-tests", envPrefix: "WEBINDEX_TEST", cli: "webindex-tests", cacheDir: testCacheDir, defaultUa: "contact" });
    const uas: string[] = [];
    installFetchMock((_url, init) => {
      uas.push(uaOf(init));
      return uas.length === 1 ? { body: "<p>Verifying</p>", url: "https://x.test/verify-human/verify.html?next=/a" } : { body: REAL, url: "https://x.test/a" };
    });
    const res = await fetchAndExtract("https://x.test/a");
    expect(uas[1]).toContain("Mozilla/5.0");
    expect(res.text).toContain("the real page");
  });

  // Apple's verify-human page answers every UA. Its 200 is not the document:
  // no text comes back, and the note says where the read ended up.
  it("returns no text, and says so, when both UAs land on the challenge", async () => {
    let calls = 0;
    installFetchMock(() => {
      calls++;
      return { body: `<html><body><h1>${APPLE}</h1></body></html>`, url: "https://developer.apple.com/forums/verify-human/verify.html?next=/forums/thread/1" };
    });
    const res = await fetchAndExtract("https://developer.apple.com/forums/thread/1");
    expect(calls).toBe(2);
    expect(res.text).toBe("");
    expect(res.finalUrl).toContain("/verify-human/");
    expect(res.note).toMatch(/anti-bot challenge/);
  });

  it("never retries a page that was not redirected to a challenge", async () => {
    let calls = 0;
    installFetchMock(() => {
      calls++;
      return { status: 404, body: "gone" };
    });
    await fetchAndExtract("https://x.test/gone");
    expect(calls).toBe(1);
  });
});
