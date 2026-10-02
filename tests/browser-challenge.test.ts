import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { classifyChallenge, detectChallenge, probeChallenge } from "../src/browser/challenge.js";
import { FakePage } from "./helpers/fake-page.js";

const page = (over: Partial<Parameters<typeof classifyChallenge>[0]> = {}) => ({
  url: "https://shop.test/",
  title: "Shop",
  text: "x".repeat(2000),
  ...over,
});

describe("classifyChallenge", () => {
  it("returns null for an ordinary page", () => {
    expect(classifyChallenge(page())).toBeNull();
    expect(classifyChallenge(page({ cookieNames: ["session", "lang"], scriptUrls: ["https://cdn.test/app.js"] }))).toBeNull();
  });

  it("recognises a DataDome captcha frame as a blocking interstitial", () => {
    const c = classifyChallenge(page({ frameUrls: ["https://geo.captcha-delivery.com/captcha/?initialCid=x"] }));
    expect(c).toMatchObject({ kind: "datadome", blocking: true });
    expect(c?.signals.join(" ")).toContain("captcha-delivery.com");
  });

  it("ignores the datadome cookie of a normal page but counts it on a blocked one", () => {
    expect(classifyChallenge(page({ cookieNames: ["datadome"], scriptUrls: ["https://js.datadome.co/tags.js"] }))).toBeNull();
    expect(classifyChallenge(page({ cookieNames: ["datadome"], text: "", status: 403 }))).toMatchObject({ kind: "datadome", blocking: true });
    expect(classifyChallenge(page({ selectors: ['iframe[src*="datadome"]'] }))).toMatchObject({ kind: "datadome" });
  });

  it("recognises the Cloudflare interstitial by title, markers and frames", () => {
    for (const title of ["Just a moment...", "Attention Required! | Cloudflare", "Un instant…"]) {
      expect(classifyChallenge(page({ title }))).toMatchObject({ kind: "cloudflare", blocking: true });
    }
    expect(classifyChallenge(page({ selectors: ["#challenge-form"] }))).toMatchObject({ kind: "cloudflare", blocking: true });
    expect(classifyChallenge(page({ scriptUrls: ["https://x.test/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?__cf_chl_opt=1"] }))).toMatchObject({
      kind: "cloudflare",
    });
    expect(classifyChallenge(page({ cookieNames: ["cf-chl-bypass"], text: "", status: 503 }))).toMatchObject({ kind: "cloudflare" });
  });

  it("does not turn short, realistic pages into blocks: login forms with a widget, a tag or a cookie", () => {
    const login = "Connexion\nEmail\nMot de passe\nSe connecter\nMot de passe oublié ?";
    const short = (over: object) => classifyChallenge({ url: "https://shop.test/login", title: "Connexion", text: login, ...over });
    expect(short({ cookieNames: ["datadome"] })).toBeNull();
    expect(short({ cookieNames: ["datadome"], status: 200 })).toBeNull();
    expect(short({ scriptUrls: ["https://www.google.com/recaptcha/api.js?render=KEY"] })).toBeNull();
    expect(short({ scriptUrls: ["https://js.hcaptcha.com/1/api.js"] })).toBeNull();
    expect(short({ scriptUrls: ["https://challenges.cloudflare.com/turnstile/v0/api.js"] })).toBeNull();
    expect(short({ frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=1"], selectors: [".g-recaptcha"] })).toMatchObject({
      kind: "recaptcha",
      blocking: false,
    });
    expect(short({ frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/x/hcaptcha.html"] })).toMatchObject({ kind: "hcaptcha", blocking: false });
    expect(short({ selectors: [".cf-turnstile"] })).toMatchObject({ kind: "cloudflare", blocking: false });
    // the same widgets on a blocked response are the block
    expect(short({ frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=1"], status: 429 })).toMatchObject({ kind: "recaptcha", blocking: true });
    // a tag with a blocked status counts too
    expect(short({ scriptUrls: ["https://www.google.com/recaptcha/api.js"], status: 403 })).toMatchObject({ kind: "recaptcha", blocking: true });
  });

  it("still makes a block of a short page whose evidence is not a widget or a tag", () => {
    expect(classifyChallenge({ url: "u", title: "", text: "Please verify you are human", scriptUrls: [] })).toMatchObject({ kind: "generic", blocking: true });
    expect(classifyChallenge({ url: "u", title: "", text: "Reference # 1", frameUrls: ["https://errors.edgesuite.net/1"] })).toMatchObject({
      kind: "akamai",
      blocking: true,
    });
  });

  it("treats a Turnstile widget on a normal page as non blocking", () => {
    const c = classifyChallenge(
      page({ frameUrls: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/x"], selectors: [".cf-turnstile"] }),
    );
    expect(c).toMatchObject({ kind: "cloudflare", blocking: false });
  });

  it("treats a reCAPTCHA checkbox on a login form as non blocking, and a bare one as blocking", () => {
    const widget = classifyChallenge(page({ frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=1"], selectors: [".g-recaptcha"] }));
    expect(widget).toMatchObject({ kind: "recaptcha", blocking: false });
    expect(classifyChallenge(page({ frameUrls: ["https://www.recaptcha.net/recaptcha/api2/anchor"], text: "Verify", status: 403 }))).toMatchObject({
      kind: "recaptcha",
      blocking: true,
    });
    expect(classifyChallenge(page({ frameUrls: ["https://www.google.com/recaptcha/api2/anchor"], status: 429 }))).toMatchObject({ blocking: true });
  });

  it("recognises hCaptcha, Arkose and FunCaptcha", () => {
    expect(classifyChallenge(page({ frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html"] }))).toMatchObject({
      kind: "hcaptcha",
      blocking: false,
    });
    expect(classifyChallenge(page({ selectors: [".h-captcha"] }))).toMatchObject({ kind: "hcaptcha" });
    expect(classifyChallenge(page({ frameUrls: ["https://client-api.arkoselabs.com/v2/x/enforcement.html"] }))).toMatchObject({
      kind: "arkose",
      blocking: false,
    });
    expect(classifyChallenge(page({ frameUrls: ["https://x.test/funcaptcha/frame"] }))).toMatchObject({ kind: "arkose" });
  });

  it("recognises PerimeterX by marker, hosts and the Press & Hold text", () => {
    expect(classifyChallenge(page({ selectors: ["#px-captcha"] }))).toMatchObject({ kind: "perimeterx", blocking: true });
    expect(classifyChallenge(page({ frameUrls: ["https://captcha.px-cdn.net/PX1/captcha.js"] }))).toMatchObject({ kind: "perimeterx" });
    expect(classifyChallenge(page({ text: "Please Press & Hold to confirm you are a human" }))).toMatchObject({ kind: "perimeterx", blocking: true });
    // the tag on every protected page is not a challenge
    expect(classifyChallenge(page({ scriptUrls: ["https://client.px-cdn.net/PX1/main.min.js"], cookieNames: ["_pxvid"] }))).toBeNull();
    expect(classifyChallenge(page({ scriptUrls: ["https://tzm.px-cloud.net/ns"], text: "", status: 403 }))).toMatchObject({ kind: "perimeterx" });
  });

  it("recognises Akamai and Imperva error pages", () => {
    const a = classifyChallenge({
      url: "https://x.test/",
      title: "Access Denied",
      text: "You don't have permission to access. Reference #18.2d3a1b02.1700000000.1a2b3c",
      status: 403,
    });
    expect(a).toMatchObject({ kind: "akamai", blocking: true });
    expect(classifyChallenge(page({ scriptUrls: ["https://x.test/sec-if-cpt/main.js"] }))).toMatchObject({ kind: "akamai" });
    expect(classifyChallenge(page({ text: "Error. Reference #1 https://errors.edgesuite.net/18.1" }))).toMatchObject({ kind: "akamai" });
    // "Access Denied" alone is not Akamai
    expect(classifyChallenge(page({ title: "Access Denied", text: "nothing else", status: 403 }))).toMatchObject({ kind: "generic" });

    const i = classifyChallenge(page({ scriptUrls: ["/_Incapsula_Resource?SWJIYLWA=1"], text: "Request unsuccessful. Incapsula incident ID: 123-456" }));
    expect(i).toMatchObject({ kind: "imperva", blocking: true });
    expect(classifyChallenge(page({ cookieNames: ["incap_ses_123_456", "visid_incap_1"] }))).toBeNull();
    expect(classifyChallenge(page({ cookieNames: ["incap_ses_1_2"], text: "", status: 403 }))).toMatchObject({ kind: "imperva" });
  });

  it("falls back to generic phrases, in English and French", () => {
    for (const text of [
      "Please verify you are human",
      "Are you a robot?",
      "Vérifiez que vous êtes humain",
      "Je ne suis pas un robot",
      "Complete the CAPTCHA to continue",
      "Unusual traffic from your network",
    ]) {
      expect(classifyChallenge(page({ text }))).toMatchObject({ kind: "generic" });
    }
    expect(classifyChallenge(page({ title: "Captcha check" }))).toMatchObject({ kind: "generic" });
    expect(classifyChallenge(page({ frameUrls: ["https://x.test/captcha/frame"] }))).toMatchObject({ kind: "generic" });
    // a long article that happens to mention captchas is not a challenge
    expect(classifyChallenge(page({ text: `${"lorem ipsum ".repeat(300)} captcha` }))).toBeNull();
  });

  it("flags an almost empty 403/429 page as generic and blocking, but not a normal one", () => {
    expect(classifyChallenge({ url: "https://x.test/", title: "", text: "Forbidden", status: 403 })).toMatchObject({ kind: "generic", blocking: true });
    expect(classifyChallenge({ url: "https://x.test/", title: "", text: "", status: 429 })).toMatchObject({ kind: "generic", blocking: true });
    expect(classifyChallenge(page({ status: 403 }))).toBeNull();
    expect(classifyChallenge(page({ status: 200, text: "ok" }))).toBeNull();
  });

  it("lets the first vendor in the documented order win over generic and later vendors", () => {
    const c = classifyChallenge(page({ title: "Just a moment...", text: "verify you are human", frameUrls: ["https://www.google.com/recaptcha/api2/anchor"] }));
    expect(c?.kind).toBe("cloudflare");
    const d = classifyChallenge(page({ frameUrls: ["https://geo.captcha-delivery.com/x", "https://hcaptcha.com/x"] }));
    expect(d?.kind).toBe("datadome");
  });

  it("is accent and case insensitive", () => {
    expect(classifyChallenge(page({ title: "UN INSTANT…" }))).toMatchObject({ kind: "cloudflare" });
    expect(classifyChallenge(page({ text: "VÉRIFIEZ QUE VOUS ÊTES HUMAIN" }))).toMatchObject({ kind: "generic" });
  });
});

describe("detectChallenge", () => {
  const probe = (over: object = {}) => ({
    url: "https://shop.test/",
    title: "Just a moment...",
    text: "Checking your browser",
    scriptUrls: [],
    iframeSrcs: [],
    cookieNames: [],
    selectors: [],
    status: 503,
    ...over,
  });
  const tree = (over: object = {}) => ({
    frameTree: { frame: { url: "https://shop.test/" }, childFrames: [{ frame: { url: "https://geo.captcha-delivery.com/x" } }], ...over },
  });

  it("gathers a probe and the frame tree with one evaluate each, then classifies", async () => {
    const p = new FakePage();
    p.handle("Runtime.evaluate", () => ({ result: { value: probe({ title: "Shop", text: "x".repeat(2000), status: 200 }) } }));
    p.handle("Page.getFrameTree", () => tree());
    const c = await detectChallenge({ page: p });
    expect(c).toMatchObject({ kind: "datadome", blocking: true });
    expect(p.methods().filter((m) => m === "Runtime.evaluate")).toHaveLength(1);
    expect(p.calls[0]?.params).toMatchObject({ returnByValue: true });
    expect(String(p.calls[0]?.params.expression)).toContain("document.cookie");
  });

  it("uses the iframe sources of the probe too, and walks nested frames", async () => {
    const p = new FakePage();
    p.handle("Runtime.evaluate", () => ({
      result: { value: probe({ title: "Shop", text: "x".repeat(2000), status: 200, iframeSrcs: ["https://hcaptcha.com/x"] }) },
    }));
    p.handle("Page.getFrameTree", () => ({
      frameTree: { frame: { url: "a" }, childFrames: [{ frame: { url: "b" }, childFrames: [{ frame: { url: "https://x.test/funcaptcha/y" } }] }] },
    }));
    expect((await detectChallenge({ page: p }))?.kind).toBe("arkose");
  });

  it("returns null on a clean page, and when the frame tree is unavailable it still classifies", async () => {
    const p = new FakePage();
    p.handle("Runtime.evaluate", () => ({ result: { value: probe({ title: "Just a moment..." }) } }));
    p.handle("Page.getFrameTree", () => {
      throw new Error("no tree");
    });
    expect((await detectChallenge({ page: p }))?.kind).toBe("cloudflare");
    const clean = new FakePage();
    clean.handle("Runtime.evaluate", () => ({ result: { value: probe({ title: "Shop", text: "y".repeat(3000), status: 200 }) } }));
    expect(await detectChallenge({ page: clean })).toBeNull();
  });

  it("never throws: an evaluate failure or a junk result gives null", async () => {
    const boom = new FakePage();
    boom.handle("Runtime.evaluate", () => {
      throw new Error("context destroyed");
    });
    expect(await detectChallenge({ page: boom })).toBeNull();
    const junk = new FakePage();
    junk.handle("Runtime.evaluate", () => ({ result: { value: "nope" } }));
    expect(await detectChallenge({ page: junk })).toBeNull();
    const exc = new FakePage();
    exc.handle("Runtime.evaluate", () => ({ exceptionDetails: { text: "boom" } }));
    expect(await detectChallenge({ page: exc })).toBeNull();
  });

  it("tolerates missing probe fields", async () => {
    const p = new FakePage();
    p.handle("Runtime.evaluate", () => ({ result: { value: { url: "u", title: "Just a moment..." } } }));
    expect((await detectChallenge({ page: p }))?.kind).toBe("cloudflare");
  });
});

describe("probeChallenge", () => {
  it("tells a probe that could not run (unknown) from a page without a challenge", async () => {
    const clean = new FakePage();
    clean.handle("Runtime.evaluate", () => ({ result: { value: { url: "u", title: "Shop", text: "y".repeat(3000), status: 200 } } }));
    expect(await probeChallenge({ page: clean })).toEqual({ ok: true, challenge: null });
    const boom = new FakePage();
    boom.handle("Runtime.evaluate", () => {
      throw new Error("CDP command timed out: Runtime.evaluate (3000 ms)");
    });
    expect(await probeChallenge({ page: boom })).toEqual({ ok: false });
    const exc = new FakePage();
    exc.handle("Runtime.evaluate", () => ({ exceptionDetails: { text: "Uncaught", exception: { description: "SecurityError" } } }));
    expect(await probeChallenge({ page: exc })).toEqual({ ok: false });
    const junk = new FakePage();
    junk.handle("Runtime.evaluate", () => ({ result: { value: "nope" } }));
    expect(await probeChallenge({ page: junk })).toEqual({ ok: false });
  });

  it("runs on a page whose cookies script may not read (a sandboxed or opaque origin)", async () => {
    const p = new FakePage();
    p.handle("Runtime.evaluate", () => ({ result: { value: { url: "u", title: "Shop" } } }));
    await detectChallenge({ page: p });
    const expression = String(p.calls[0]?.params.expression);
    const document = {
      title: "Just a moment...",
      body: { innerText: "Checking your browser" },
      scripts: [],
      querySelector: () => null,
      querySelectorAll: () => [],
      get cookie(): string {
        throw new Error("SecurityError: The document is sandboxed and lacks the 'allow-same-origin' flag.");
      },
    };
    const value = runInNewContext(expression, {
      document,
      location: { href: "https://shop.test/" },
      performance: { getEntriesByType: () => [] },
    });
    expect(value).toMatchObject({ title: "Just a moment...", cookieNames: [] });
  });
});

describe("Cloudflare's challenge-platform scripts", () => {
  const long = "A real product page with plenty of text. ".repeat(60);
  it("does not take the bot-management script an ordinary page loads for a challenge", () => {
    for (const src of [
      "https://shop.test/cdn-cgi/challenge-platform/scripts/jsd/main.js",
      "https://shop.test/cdn-cgi/challenge-platform/h/b/scripts/jsd/1a2b3c/main.js",
    ]) {
      expect(classifyChallenge({ url: "https://shop.test/", title: "Shop", text: long, scriptUrls: [src], status: 200 }), src).toBeNull();
    }
  });

  it("still counts the bot-management script on a page that looks blocked", () => {
    const c = classifyChallenge({
      url: "u",
      title: "",
      text: "",
      scriptUrls: ["https://shop.test/cdn-cgi/challenge-platform/scripts/jsd/main.js"],
      status: 403,
    });
    expect(c).toMatchObject({ kind: "cloudflare", blocking: true });
  });

  it("takes the interstitial's own orchestrate script for a block", () => {
    const c = classifyChallenge({
      url: "u",
      title: "shop.test",
      text: long,
      scriptUrls: ["https://shop.test/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=8a1b"],
      status: 200,
    });
    expect(c).toMatchObject({ kind: "cloudflare", blocking: true });
  });
});
