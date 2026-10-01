import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { readRenderedPage } from "../src/browser/read.js";
import { type BrowserCliFlags, runBrowserCommand } from "../src/browser/cli.js";
import type { BrowserDeps } from "../src/browser/deps.js";
import { profileDir } from "../src/browser/profile.js";
import { appendNetwork, readNetwork, readSession, writeSession } from "../src/browser/state.js";
import { main } from "../src/cli.js";
import { resetNoWrite, setNoWrite } from "../src/no-write.js";
import { BrowserWorld as World } from "./helpers/browser-world.js";
import { scriptBrowser } from "./helpers/fake-browser.js";
import { FakeCdp } from "./helpers/fake-cdp.js";
import { fakeClock } from "./helpers/fake-page.js";

// `webindex browser …` end to end against a fake DevTools endpoint: the real
// session, lock, refs and actions, with the page's answers scripted below.

vi.mock("../src/browser/read.js", () => ({ readRenderedPage: vi.fn() }));

let fake: FakeCdp;
let world: World;
let home: string;
let scratch: string;

beforeEach(async () => {
  fake = await FakeCdp.start();
  scriptBrowser(fake);
  world = new World(fake);
  fake.addTarget("https://a.test/", "A page");
  home = mkdtempSync(join(tmpdir(), "wi-bcli-"));
  scratch = mkdtempSync(join(tmpdir(), "wi-bcli-cwd-"));
  process.env[envName("BROWSER_DIR")] = home;
});
afterEach(async () => {
  resetNoWrite();
  await fake.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const browserDeps = (over: Partial<BrowserDeps> = {}): Partial<BrowserDeps> => ({
  ...fakeClock(),
  detectBrowser: () => null,
  spawn: () => {
    throw new Error("no browser may be launched in these tests");
  },
  ...over,
});

let stdin = "";
const cli = (action: string, args: string[] = [], flags: BrowserCliFlags = {}, over: Partial<BrowserDeps> = {}) =>
  runBrowserCommand(action, args, flags, { browser: browserDeps(over), cwd: scratch, stdin: () => stdin });

/** Attach to the fake endpoint, then snapshot so the refs e1…e5 exist. */
async function ready(): Promise<void> {
  expect((await cli("attach", [String(fake.port)])).exitCode).toBe(0);
  expect((await cli("snapshot")).exitCode).toBe(0);
}

const sent = (method: string) => fake.calls.filter((c) => c.method === method);

describe("usage errors exit 2", () => {
  it.each([
    ["an unknown action", "frobnicate", [], {}],
    ["no action", "", [], {}],
    ["click without a ref", "click", [], {}],
    ["type without text", "type", ["e3"], {}],
    ["fill without text", "fill", ["e3"], {}],
    ["select without a value", "select", ["e4"], {}],
    ["upload without a file", "upload", ["e5"], {}],
    ["press without a key", "press", [], {}],
    ["scroll without a target", "scroll", [], {}],
    ["open without a url", "open", [], {}],
    ["attach without a port", "attach", [], {}],
    ["two wait conditions", "wait", [], { text: "a", gone: "b" }],
    ["no wait condition", "wait", [], {}],
    ["a stray argument", "click", ["e1", "e2"], {}],
    ["an unknown tabs action", "tabs", ["shuffle"], {}],
    ["tabs select without an id", "tabs", ["select"], {}],
    ["an unknown network action", "network", ["purge"], {}],
    ["network get without a number", "network", ["get", "x"], {}],
    ["dialog without an answer", "dialog", [], {}],
    ["an unknown profile action", "profile", ["wipe"], {}],
    ["profile import without a source", "profile", ["import"], {}],
    ["eval without an expression", "eval", [], {}],
    ["a non-loopback attach", "attach", ["http://10.0.0.1:9222"], {}],
  ] as [string, string, string[], BrowserCliFlags][])("%s", async (_what, action, args, flags) => {
    const r = await cli(action, args, flags);
    expect(r.exitCode).toBe(2);
    expect(r.text).toBeTruthy();
    expect(r.json).toEqual({ ok: false, error: r.text });
  });

  it("names the action's own usage line", async () => {
    expect((await cli("click")).text).toMatch(/^usage: webindex-tests browser click <ref>/);
    expect((await cli("nope")).text).toMatch(/open\|attach\|status/);
  });

  it.each([
    ["scroll", ["sideways"]],
    ["press", ["NotAKey"]],
    ["press", ["Control+"]],
  ])("checks %s %s before reaching for the browser", async (action, args) => {
    const r = await cli(action, args);
    expect(r.exitCode).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it("checks an upload's files before reaching for the browser", async () => {
    const r = await cli("upload", ["e5", "missing.pdf"]);
    expect(r.exitCode).toBe(2);
    expect(r.text).toContain(join(scratch, "missing.pdf"));
    expect(fake.calls).toEqual([]);
  });
});

describe("attach, status, close", () => {
  it("attaches to a loopback port, records it as not ours, and reports the tabs", async () => {
    const r = await cli("attach", [`http://localhost:${fake.port}`], { json: true });
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ ok: true, alive: true, port: fake.port, launchedByUs: false, tabs: [{ id: "t1", url: "https://a.test/" }] });
    expect(readSession()).toMatchObject({ port: fake.port, launchedByUs: false, targetId: "T1" });
    expect(r.text).toContain(`browser on port ${fake.port}`);
    expect(r.text).toContain("attached");
  });

  it("fails with exit 1 when nothing answers there", async () => {
    const r = await cli("attach", ["1"]);
    expect(r.exitCode).toBe(1);
    expect(r.text).toMatch(/nothing answers DevTools/);
  });

  it("says no browser is running without launching one", async () => {
    const r = await cli("status");
    expect(r.exitCode).toBe(0);
    expect(r.json).toEqual({ ok: true, alive: false });
    expect(r.text).toMatch(/no browser/);
  });

  it("lists the tabs of the running browser", async () => {
    await ready();
    fake.addTarget("https://b.test/", "B");
    const r = await cli("status");
    expect(r.exitCode).toBe(0);
    expect(r.text).toMatch(/\* t1 {2}https:\/\/a\.test\/ — A page/);
    expect(r.text).toMatch(/ {2}t2 {2}https:\/\/b\.test\/ — B/);
  });

  it("forgets a browser it only attached to, and leaves it running", async () => {
    await ready();
    const r = await cli("close", [], { json: true });
    expect(r.exitCode).toBe(0);
    expect(r.json).toEqual({ ok: true, closed: false, launchedByUs: false });
    expect(r.text).toMatch(/left running/);
    expect(sent("Browser.close")).toEqual([]);
    expect(readSession()).toBeNull();
  });

  it("closes a browser it launched", async () => {
    writeSession({
      version: 1,
      port: fake.port,
      wsBrowserUrl: fake.browserWsUrl,
      launchedByUs: true,
      profile: "default",
      headless: false,
      targetId: "T1",
      updatedAt: 1,
    });
    const r = await cli("close", [], { all: true });
    expect(r.exitCode).toBe(0);
    expect(r.text).toMatch(/closed the browser/);
    expect(sent("Browser.close")).toHaveLength(1);
  });

  it("has nothing to close when no browser runs", async () => {
    const r = await cli("close");
    expect(r.exitCode).toBe(0);
    expect(r.text).toMatch(/no browser to close/);
  });
});

describe("open", () => {
  it("navigates the current tab and prints where it landed", async () => {
    await cli("attach", [String(fake.port)]);
    const r = await cli("open", ["https://b.test/"], { json: true });
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ ok: true, url: "https://b.test/", title: "Title of https://b.test/", status: 200, tab: "T1", challenge: null });
    expect(r.text.split("\n")[0]).toBe("https://b.test/ — Title of https://b.test/ (HTTP 200)");
  });

  it("opens a new tab with --new-tab", async () => {
    await cli("attach", [String(fake.port)]);
    const r = await cli("open", ["https://b.test/"], { newTab: true, json: true });
    expect(r.json).toMatchObject({ tab: "T2" });
    expect(fake.targets).toHaveLength(2);
  });

  it("names a challenge and tells the agent to let the human solve it", async () => {
    await cli("attach", [String(fake.port)]);
    world.blocking = true;
    const r = await cli("open", ["https://b.test/"]);
    expect(r.exitCode).toBe(0);
    expect(r.text).toMatch(/challenge: cloudflare \(blocking\)/);
    expect(r.text).toContain("let the human solve it, then `webindex-tests browser wait --clear`");
  });

  it("captures the JSON the page fetched with --capture", async () => {
    await cli("attach", [String(fake.port)]);
    world.xhr = true;
    const r = await cli("open", ["https://b.test/"], { capture: true, json: true });
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ captured: 1 });
    expect(readNetwork("T1")).toMatchObject([{ n: 1, url: "https://a.test/api.json", json: { a: 1 } }]);
    const text = await cli("open", ["https://c.test/"], { capture: true });
    expect(text.text).toMatch(/captured 0 JSON responses/);
  });

  it("appends the snapshot with --snapshot", async () => {
    await cli("attach", [String(fake.port)]);
    const r = await cli("open", ["https://b.test/"], { snapshot: true, interactive: true });
    expect(r.text).toContain('- button "Search" [ref=e1]');
    const j = await cli("open", ["https://c.test/"], { snapshot: true, json: true });
    expect(j.json).toMatchObject({ snapshot: { refCount: 5, truncated: false } });
  });

  it("fails with exit 1 when the navigation fails", async () => {
    await cli("attach", [String(fake.port)]);
    const r = await cli("open", ["https://unreachable.test/"]);
    expect(r.exitCode).toBe(1);
    expect(r.text).toMatch(/ERR_NAME_NOT_RESOLVED/);
  });
});

describe("snapshot", () => {
  it("prints the tree with refs, 20000 characters at most by default", async () => {
    await cli("attach", [String(fake.port)]);
    const r = await cli("snapshot");
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain("url: https://a.test/");
    expect(r.text).toContain('- button "Pay now" [ref=e2]');
    const cut = await cli("snapshot", [], { maxChars: 30, json: true });
    expect(cut.json).toMatchObject({ ok: true, truncated: true });
  });

  it("scopes to a ref, and refuses one it does not know", async () => {
    await ready();
    const r = await cli("snapshot", ["e3"]);
    expect(r.text).toContain('textbox "Query" [ref=e3]');
    expect(r.text).not.toContain("Search");
    const stale = await cli("snapshot", ["e99"]);
    expect(stale.exitCode).toBe(1);
    expect(stale.text).toMatch(/take a new snapshot/);
  });
});

describe("page actions", () => {
  it("clicks a ref and prints a one-line result", async () => {
    await ready();
    const r = await cli("click", ["e1"]);
    expect(r.exitCode).toBe(0);
    expect(r.text).toBe("click e1: https://a.test/ — A page");
    expect(sent("Input.dispatchMouseEvent").map((c) => c.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    const j = await cli("click", ["e1"], { json: true });
    expect(j.json).toMatchObject({ ok: true, action: "click", ref: "e1", navigated: false, url: "https://a.test/", title: "A page", challenge: null });
  });

  it("refuses a click that looks irreversible with exit 1, and lets it through with --confirm", async () => {
    await ready();
    const refused = await cli("click", ["e2"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.text).toMatch(/refused to click on "Pay now".*--confirm/);
    expect(sent("Input.dispatchMouseEvent")).toEqual([]);
    const ok = await cli("click", ["e2"], { confirm: true });
    expect(ok.exitCode).toBe(0);
    expect(sent("Input.dispatchMouseEvent")).toHaveLength(3);
  });

  it("refuses a stale ref with exit 1 and asks for a new snapshot", async () => {
    await cli("attach", [String(fake.port)]);
    const before = await cli("click", ["e1"]);
    expect(before.exitCode).toBe(1);
    expect(before.text).toMatch(/take a new snapshot/);
    await cli("snapshot");
    await cli("open", ["https://b.test/"]);
    const after = await cli("hover", ["e1"]);
    expect(after.exitCode).toBe(1);
    expect(after.text).toMatch(/stale/);
  });

  it("hovers, types, fills, selects, presses and scrolls", async () => {
    await ready();
    expect((await cli("hover", ["e1"])).text).toBe("hover e1: https://a.test/ — A page");
    const typed = await cli("type", ["e3", "hello", "world"], { submit: true });
    expect(typed.exitCode).toBe(0);
    const keys = sent("Input.dispatchKeyEvent").filter((c) => c.params.type === "keyDown");
    expect(keys.map((c) => c.params.text ?? c.params.key).join("")).toBe("hello world\r");
    const filled = await cli("fill", ["e3", "new", "text"]);
    expect(filled.exitCode).toBe(0);
    expect(world.els.get(12)?.value).toBe("new text");
    const picked = await cli("select", ["e4", "Medium"], { json: true });
    expect(picked.json).toMatchObject({ action: "select", value: ["m"] });
    expect((await cli("select", ["e4", "Medium"])).text).toContain('value: ["m"]');
    expect((await cli("press", ["Escape"])).text).toBe("press: https://a.test/ — A page");
    const scrolled = await cli("scroll", ["down"]);
    expect(scrolled.text).toContain('value: {"x":0,"y":640}');
    expect((await cli("scroll", ["e3"])).exitCode).toBe(0);
  });

  it("refuses an Enter that would submit a password form, unless confirmed", async () => {
    await ready();
    world.active = { role: "textbox", label: "Password", isSubmit: true, formHasPassword: true, submitLabel: "Log in" };
    const r = await cli("press", ["Enter"]);
    expect(r.exitCode).toBe(1);
    expect(r.text).toMatch(/password/);
    expect((await cli("press", ["Enter"], { confirm: true })).exitCode).toBe(0);
  });

  it("uploads files named relative to the working directory", async () => {
    await ready();
    writeFileSync(join(scratch, "a.pdf"), "%PDF");
    const r = await cli("upload", ["e5", "a.pdf"], { json: true });
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ action: "upload", value: { files: 1 } });
    expect(sent("DOM.setFileInputFiles")[0]?.params).toEqual({ files: [join(scratch, "a.pdf")], backendNodeId: 14 });
  });

  it("appends the post-action snapshot with --snapshot", async () => {
    await ready();
    const r = await cli("click", ["e1"], { snapshot: true });
    expect(r.text.split("\n")[0]).toBe("click e1: https://a.test/ — A page");
    expect(r.text).toContain('- button "Search" [ref=e1]');
    const j = await cli("click", ["e1"], { snapshot: true, json: true });
    expect(j.json).toMatchObject({ action: "click", snapshot: { refCount: 5 } });
  });

  it("dismisses a dialog the action opened before the command ends, says so, then takes the snapshot", async () => {
    // The browser hands a dialog only to the connection that saw it open: the next command could not answer it.
    await ready();
    fake.handle("Page.handleJavaScriptDialog", () => ({}));
    world.dialogOnClick = { type: "confirm", message: "Leave?" };
    const r = await cli("click", ["e1"], { snapshot: true });
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain(
      'dialog confirm: "Leave?" — dismissed: a dialog cannot outlive a command; `webindex-tests mcp --browser` keeps it open for an answer',
    );
    expect(sent("Page.handleJavaScriptDialog").at(-1)?.params).toEqual({ accept: false });
    expect(r.text).toContain("[ref=e1]");
    world.dialogOnClick = { type: "alert", message: "Hi" };
    const j = await cli("click", ["e1"], { json: true });
    expect(j.json).toMatchObject({ dialog: { type: "alert", message: "Hi", dismissed: true } });
  });

  it("dismisses a dialog an eval opened", async () => {
    await ready();
    fake.handle("Page.handleJavaScriptDialog", () => ({}));
    fake.handle("Runtime.evaluate", (p, sessionId) => {
      if (p.expression === "alert(1)") fake.emit("Page.javascriptDialogOpening", { type: "alert", message: "1", url: "https://a.test/" }, sessionId);
      return { result: { type: "string", value: "A page" } };
    });
    const r = await cli("eval", ["alert(1)"]);
    expect(r.text).toContain('dialog alert: "1" — dismissed');
    expect(sent("Page.handleJavaScriptDialog").at(-1)?.params).toEqual({ accept: false });
  });

  it("captures what an action fetched with --capture", async () => {
    await ready();
    world.xhr = true;
    const r = await cli("click", ["e1"], { capture: true });
    expect(r.text).toMatch(/captured 1 JSON response\b/);
  });

  it("lets go of the recorder when the action fails", async () => {
    await ready();
    const r = await cli("click", ["e2"], { capture: true });
    expect(r.exitCode).toBe(1);
    expect(r.text).toMatch(/refused/);
  });

  it("answers a dialog, and says when none is open", async () => {
    await ready();
    const none = await cli("dialog", ["accept"]);
    expect(none.exitCode).toBe(1);
    expect(none.text).toBe("no dialog is open");
    fake.handle("Page.handleJavaScriptDialog", () => ({}));
    const r = await cli("dialog", ["accept", "my", "answer"], { json: true });
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ action: "dialog" });
    expect(sent("Page.handleJavaScriptDialog").at(-1)?.params).toEqual({ accept: true, promptText: "my answer" });
    await cli("dialog", ["dismiss"]);
    expect(sent("Page.handleJavaScriptDialog").at(-1)?.params).toEqual({ accept: false });
  });

  it("goes back, forward and reloads", async () => {
    await cli("attach", [String(fake.port)]);
    await cli("open", ["https://b.test/"]);
    const back = await cli("back", [], { json: true });
    expect(back.json).toMatchObject({ action: "back", navigated: true, url: "https://a.test/" });
    expect((await cli("forward")).text).toBe("forward: navigated to https://b.test/ — Title of https://b.test/");
    expect((await cli("reload")).exitCode).toBe(0);
    const none = await cli("forward");
    expect(none.exitCode).toBe(1);
    expect(none.text).toMatch(/no next page/);
  });
});

describe("eval", () => {
  it("prints the value of an expression", async () => {
    await cli("attach", [String(fake.port)]);
    const r = await cli("eval", ["document.title"]);
    expect(r.exitCode).toBe(0);
    expect(r.text).toBe("A page");
    expect(sent("Runtime.evaluate").some((c) => c.params.expression === "document.title")).toBe(true);
    world.evalValue = { n: 1 };
    expect((await cli("eval", ["({", "n:", "1", "})"])).text).toBe('{\n  "n": 1\n}');
    expect(sent("Runtime.evaluate").some((c) => c.params.expression === "({ n: 1 })")).toBe(true);
  });

  it("reads the expression from stdin for -", async () => {
    await cli("attach", [String(fake.port)]);
    stdin = "location.href\n";
    world.evalValue = 42;
    const r = await cli("eval", ["-"], { json: true });
    expect(r.json).toMatchObject({ action: "evaluate", value: 42 });
    expect(sent("Runtime.evaluate").some((c) => c.params.expression === "location.href")).toBe(true);
  });

  it("says undefined for no value", async () => {
    await cli("attach", [String(fake.port)]);
    world.evalValue = undefined;
    expect((await cli("eval", ["void 0"])).text).toBe("undefined");
  });

  it("is a usage error when stdin is not offered, or blank", async () => {
    const r = await runBrowserCommand("eval", ["-"], {}, { browser: browserDeps() });
    expect(r.exitCode).toBe(2);
    stdin = "  \n";
    expect((await cli("eval", ["-"])).exitCode).toBe(2);
  });
});

describe("wait", () => {
  it("waits for one condition and says which held", async () => {
    await cli("attach", [String(fake.port)]);
    const r = await cli("wait", [], { text: "Welcome", json: true });
    expect(r.exitCode).toBe(0);
    expect(r.json).toEqual({ ok: true, matched: "text", waitedMs: 0 });
    expect((await cli("wait", [], { ms: 10 })).text).toBe("ms held after 10 ms");
    expect((await cli("wait", [], { load: true })).exitCode).toBe(0);
    expect((await cli("wait", [], { gone: "Spinner" })).exitCode).toBe(0);
  });

  it("times out with exit 1", async () => {
    await cli("attach", [String(fake.port)]);
    const r = await cli("wait", [], { text: "Order shipped", timeout: 1000 });
    expect(r.exitCode).toBe(1);
    expect(r.text).toMatch(/timed out waiting for \{"text":"Order shipped"\} after 1000 ms/);
  });
});

describe("screenshot", () => {
  it("writes the image to --out and returns its path", async () => {
    await cli("attach", [String(fake.port)]);
    const r = await cli("screenshot", [], { out: "shots/page.png", full: true, json: true });
    expect(r.exitCode).toBe(0);
    const path = join(scratch, "shots", "page.png");
    expect(r.image).toEqual({ path });
    expect(r.json).toEqual({ ok: true, path, bytes: 7, format: "png" });
    expect(r.text).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("PNGDATA");
    expect(sent("Page.captureScreenshot").at(-1)?.params).toMatchObject({ format: "png", captureBeyondViewport: true });
  });

  it("takes JPEG for a .jpg path, and one element given a ref", async () => {
    await ready();
    const r = await cli("screenshot", ["e1"], { out: join(scratch, "e1.jpg") });
    expect(r.exitCode).toBe(0);
    expect(sent("Page.captureScreenshot").at(-1)?.params).toMatchObject({ format: "jpeg", clip: { width: 100, height: 40 } });
  });

  it("defaults to a private file under the temp dir", async () => {
    await cli("attach", [String(fake.port)]);
    // A dir left readable by an earlier run is made private.
    mkdirSync(join(tmpdir(), "webindex-tests", "browser"), { recursive: true });
    chmodSync(join(tmpdir(), "webindex-tests", "browser"), 0o755);
    const r = await cli("screenshot");
    expect(r.exitCode).toBe(0);
    expect(r.text.startsWith(join(tmpdir(), "webindex-tests", "browser", "shot-"))).toBe(true);
    expect(existsSync(r.text)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(r.text).mode & 0o777).toBe(0o600);
      expect(statSync(join(tmpdir(), "webindex-tests", "browser")).mode & 0o777).toBe(0o700);
    }
    rmSync(r.text);
  });

  it("refuses under no-write, before touching the browser", async () => {
    setNoWrite(true);
    const r = await cli("screenshot", [], { out: "x.png" });
    expect(r.exitCode).toBe(1);
    expect(r.text).toMatch(/NO_WRITE/);
    expect(fake.calls).toEqual([]);
  });
});

describe("network", () => {
  const entry = (n: number, over = {}) => ({
    n,
    at: "2026-01-01T00:00:00.000Z",
    method: "GET",
    url: `https://a.test/api/${n}`,
    status: 200,
    mime: "application/json",
    resourceType: "XHR",
    size: 12,
    ...over,
  });

  it("lists, gets and clears the current tab's log", async () => {
    await cli("attach", [String(fake.port)]);
    appendNetwork("T1", [
      entry(1, { json: { ok: true } }),
      entry(2, { method: "POST", text: "plain body" }),
      entry(3, { bodyTruncated: true, size: 999999 }),
      entry(4, { error: "No resource with given identifier found" }),
    ]);
    const list = await cli("network");
    expect(list.text.split("\n")[0]).toBe("1  GET 200 https://a.test/api/1 (application/json, 12 B)");
    expect((await cli("network", ["list"], { json: true })).json).toMatchObject({ ok: true, entries: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] });
    expect((await cli("network", ["get", "1"])).text).toBe('{\n  "ok": true\n}');
    expect((await cli("network", ["get", "2"])).text).toBe("plain body");
    expect((await cli("network", ["get", "3"])).text).toMatch(/body not kept \(999999 B, over the size cap\)/);
    expect((await cli("network", ["get", "4"])).text).toMatch(/body not kept \(No resource/);
    expect((await cli("network", ["get", "2"], { json: true })).json).toMatchObject({ ok: true, n: 2, method: "POST" });
    const missing = await cli("network", ["get", "9"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.text).toMatch(/no network entry 9/);
    expect((await cli("network", ["clear"])).exitCode).toBe(0);
    expect((await cli("network")).text).toMatch(/nothing recorded/);
  });

  it("needs a session", async () => {
    const r = await cli("network");
    expect(r.exitCode).toBe(1);
    expect(r.text).toMatch(/no browser session/);
  });
});

describe("tabs", () => {
  it("lists, opens, selects and closes tabs", async () => {
    await cli("attach", [String(fake.port)]);
    expect((await cli("tabs")).text).toBe("* t1  https://a.test/ — A page");
    const opened = await cli("tabs", ["new", "https://b.test/"], { json: true });
    expect(opened.json).toMatchObject({ ok: true, id: "t2", url: "https://b.test/", active: true });
    expect((await cli("tabs", [], { json: true })).json).toMatchObject({ ok: true, tabs: [{ id: "t1" }, { id: "t2" }] });
    const picked = await cli("tabs", ["select", "t1"]);
    expect(picked.text).toBe("* t1  https://a.test/ — A page");
    const closed = await cli("tabs", ["close", "t2"], { json: true });
    expect(closed.json).toMatchObject({ ok: true, closed: "t2", tabs: [{ id: "t1" }] });
    const gone = await cli("tabs", ["select", "t9"]);
    expect(gone.exitCode).toBe(1);
    expect(gone.text).toMatch(/no tab t9/);
  });
});

describe("profile", () => {
  it("prints the profile path", async () => {
    expect((await cli("profile", ["path"])).text).toBe(profileDir("default"));
    expect((await cli("profile", ["path"], { profile: "work", json: true })).json).toEqual({ ok: true, path: profileDir("work") });
  });

  it("imports a user-data directory, and resets the profile", async () => {
    const from = join(scratch, "ud");
    mkdirSync(join(from, "Default"), { recursive: true });
    writeFileSync(join(from, "Local State"), "{}");
    writeFileSync(join(from, "Default", "Cookies"), "c");
    const r = await cli("profile", ["import", from], { json: true });
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ ok: true, from, to: profileDir("default"), files: 2 });
    expect((await cli("profile", ["import", from])).exitCode).toBe(1);
    expect((await cli("profile", ["import", from], { force: true })).text).toMatch(/imported 2 files/);
    expect((await cli("profile", ["reset"])).text).toMatch(/removed/);
    expect(existsSync(profileDir("default"))).toBe(false);
    expect((await cli("profile", ["reset"])).text).toMatch(/no profile/);
  });

  it("refuses to reset or replace a profile our browser is running on", async () => {
    const dir = profileDir("default");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Cookies"), "c");
    // What a browser of ours running on the profile leaves: its live DevTools port and socket.
    writeFileSync(join(dir, "DevToolsActivePort"), `${fake.port}\n/devtools/browser/fake\n`);
    const reset = await cli("profile", ["reset"]);
    expect(reset.exitCode).toBe(1);
    expect(reset.text).toContain("close it first: `webindex-tests browser close`");
    expect(existsSync(join(dir, "Cookies"))).toBe(true);
    const from = join(scratch, "ud");
    mkdirSync(join(from, "Default"), { recursive: true });
    const imported = await cli("profile", ["import", from], { force: true });
    expect(imported.exitCode).toBe(1);
    expect(imported.text).toMatch(/close it first/);
    expect(existsSync(join(dir, "Cookies"))).toBe(true);
    // Another profile is not that browser's.
    expect((await cli("profile", ["reset"], { profile: "work" })).exitCode).toBe(0);
  });

  it("resets a profile whose DevToolsActivePort is a crashed run's", async () => {
    const dir = profileDir("default");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "DevToolsActivePort"), "1\n/devtools/browser/gone\n");
    const r = await cli("profile", ["reset"]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });
});

/** main() calls process.exit on failure; catch it so the case can assert. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: any) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c: any) => {
    err.push(String(c));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__exit__${code ?? 0}`);
  }) as never);
  let code = 0;
  try {
    await main(argv);
  } catch (e) {
    const m = /^__exit__(\d+)$/.exec((e as Error).message);
    if (!m) throw e;
    code = Number(m[1]);
  } finally {
    vi.restoreAllMocks();
  }
  return { code, out: out.join(""), err: err.join("") };
}

describe("through main", () => {
  it("fetch --browser renders the page in the browser", async () => {
    vi.mocked(readRenderedPage).mockResolvedValue({ text: "rendered text", finalUrl: "https://js.test/", status: 200, extractor: "browser" });
    const r = await run(["fetch", "https://js.test/", "--browser"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("rendered text\n");
    expect(readRenderedPage).toHaveBeenCalledWith("https://js.test/", expect.anything());
  });

  it("prints the text, or the JSON, of a browser command", async () => {
    const text = await run(["browser", "profile", "path"]);
    expect(text).toMatchObject({ code: 0, out: `${profileDir("default")}\n` });
    const json = await run(["browser", "profile", "path", "--profile", "work", "--json"]);
    expect(JSON.parse(json.out)).toEqual({ ok: true, path: profileDir("work") });
  });

  it("prints a failure on stderr with exit 1, after its JSON", async () => {
    const r = await run(["browser", "network", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
    expect(r.err).toMatch(/no browser session/);
  });

  it("answers `eval -` on a terminal with a usage error, JSON included", async () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const r = await run(["browser", "eval", "-", "--json"]);
      expect(r.code).toBe(2);
      expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: expect.stringMatching(/usage: .* browser eval/) });
    } finally {
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it("takes any number of words after the action", async () => {
    const r = await run(["browser", "type", "e1", "several", "words", "--max-chars", "0"]);
    expect(r.code).toBe(2);
    expect(r.err).not.toMatch(/unexpected argument/);
  });
});
