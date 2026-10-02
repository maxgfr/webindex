import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { runBrowserCommand } from "../src/browser/cli.js";
import type { BrowserDeps } from "../src/browser/deps.js";
import { BROWSER_CAP_ADVICE, type BrowserToolHost, browserToolDecls, createBrowserToolHost } from "../src/browser/mcp.js";
import { writeProfileKind } from "../src/browser/profile.js";
import { readSession, writeSession } from "../src/browser/state.js";
import { main, webindexAdapter } from "../src/cli.js";
import { createServer, type JsonRpcMessage, ToolError } from "../src/mcp/server.js";
import { READ_DOCUMENT } from "../src/browser/overlay.js";
import { BrowserWorld } from "./helpers/browser-world.js";
import { scriptBrowser } from "./helpers/fake-browser.js";
import { FakeCdp } from "./helpers/fake-cdp.js";
import { fakeClock } from "./helpers/fake-page.js";

// `webindex mcp --browser`: the webindex_browser_* tools over ONE live browser
// session, against a fake DevTools endpoint (the real session, refs, actions
// and lock, the page scripted by BrowserWorld).

const NAMES = [
  "open",
  "snapshot",
  "text",
  "click",
  "hover",
  "type",
  "fill",
  "select",
  "press",
  "upload",
  "scroll",
  "wait",
  "screenshot",
  "eval",
  "network",
  "tabs",
  "history",
  "dialog",
  "status",
  "close",
].map((a) => `webindex_browser_${a}`);

let fake: FakeCdp;
let world: BrowserWorld;
let home: string;
let scratch: string;
const hosts: BrowserToolHost[] = [];

beforeEach(async () => {
  fake = await FakeCdp.start();
  scriptBrowser(fake);
  world = new BrowserWorld(fake);
  fake.addTarget("https://a.test/", "A page");
  home = mkdtempSync(join(tmpdir(), "wi-mcpb-"));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "wi-mcpb-cwd-")));
  process.env[envName("BROWSER_DIR")] = home;
});
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  await fake.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const browserDeps = (): Partial<BrowserDeps> => ({
  ...fakeClock(),
  detectBrowser: () => null,
  spawn: () => {
    throw new Error("no browser may be launched in these tests");
  },
});

/** A host on the fake endpoint: `attach` saves its port, the host's first call connects there. */
async function host(policy: { extractRoot?: string; noLocalFiles?: boolean } = {}): Promise<BrowserToolHost> {
  expect((await runBrowserCommand("attach", [String(fake.port)], {}, { browser: browserDeps() })).exitCode).toBe(0);
  const h = createBrowserToolHost({ policy, deps: { browser: browserDeps(), cwd: scratch } });
  hosts.push(h);
  return h;
}

const sent = (method: string) => fake.calls.filter((c) => c.method === method);

describe("tools/list", () => {
  const rpc = (method: string): JsonRpcMessage => ({ jsonrpc: "2.0", id: 1, method });
  async function list(policy: Parameters<typeof webindexAdapter>[0]) {
    let out: JsonRpcMessage | undefined;
    await createServer(webindexAdapter(policy)).handle(rpc("tools/list"), (m) => {
      out = m;
    });
    return (out!.result as { tools: { name: string; annotations?: Record<string, unknown>; title?: string; inputSchema: { required: string[] } }[] }).tools;
  }

  it("offers no browser tool without --browser", async () => {
    expect((await list({})).filter((t) => t.name.startsWith("webindex_browser_"))).toEqual([]);
  });

  it("offers every browser tool with --browser, each annotated for what it does", async () => {
    const tools = (await list({ browser: true })).filter((t) => t.name.startsWith("webindex_browser_"));
    expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
    const readOnly = ["snapshot", "text", "screenshot", "status", "wait"];
    // network: its clear deletes the log.
    const destructive = ["click", "press", "type", "fill", "select", "upload", "eval", "dialog", "close", "network"];
    for (const t of tools) {
      const action = t.name.replace("webindex_browser_", "");
      const ro = readOnly.includes(action);
      expect(t.annotations, t.name).toEqual({
        title: t.title,
        readOnlyHint: ro,
        destructiveHint: destructive.includes(action),
        idempotentHint: ro,
        openWorldHint: true,
      });
      expect(t.title, t.name).toBeTruthy();
      // An oversized answer is withheld and names what to narrow: every tool needs a required argument and advice.
      expect(t.inputSchema.required.length, t.name).toBeGreaterThan(0);
      expect(BROWSER_CAP_ADVICE[t.name], t.name).toBeTruthy();
      expect(webindexAdapter({ browser: true }).capAdvice?.[t.name], t.name).toBe(BROWSER_CAP_ADVICE[t.name]);
    }
    // The default tools keep their own hints.
    const fetchTool = (await list({ browser: true })).find((t) => t.name === "webindex_fetch");
    expect(fetchTool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });

  it("tells the agent where refs come from, and to ask before confirming", () => {
    const decl = (name: string) => browserToolDecls().find((t) => t.name === `webindex_browser_${name}`)!;
    expect(decl("click").description).toMatch(/latest snapshot/);
    for (const name of ["click", "press", "type"]) {
      expect(decl(name).description, name).toMatch(/confirm: true/);
      expect(decl(name).description, name).toMatch(/ask(ing)? the user/);
    }
    expect(decl("screenshot").description).toMatch(/image/);
  });

  it("routes a browser tool call to the host", async () => {
    const r = await webindexAdapter({ browser: true }).callTool("webindex_browser_status", { show: "browser" });
    expect(r.text).toMatch(/no browser session/);
    await expect(webindexAdapter({}).callTool("webindex_browser_status", { show: "browser" })).rejects.toThrow(/unknown tool/);
  });
});

/** main() calls process.exit on failure; catch it so the case can assert. */
async function run(argv: string[]): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((c: any) => {
    err.push(String(c));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__exit__${code ?? 0}`);
  }) as never);
  let code = 0;
  process.exitCode = undefined;
  try {
    await main(argv);
    // A printed result sets the code instead of exiting, so a pipe gets all of it.
    code = Number(process.exitCode ?? 0);
  } catch (e) {
    const m = /^__exit__(\d+)$/.exec((e as Error).message);
    if (!m) throw e;
    code = Number(m[1]);
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
  return { code, err: err.join("") };
}

describe("mcp --browser policy", () => {
  it.each([
    [["--public-only"], /--browser.*--public-only/],
    [["--allow-remote"], /--browser.*--allow-remote/],
    [["--allow-remote", "--allow-private"], /--browser.*--allow-remote/],
  ])("refuses --browser with %s as a usage error", async (flags, message) => {
    const r = await run(["mcp", "--browser", ...flags]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(message);
  });

  it("refuses --browser under the public-only environment", async () => {
    process.env[envName("PUBLIC_ONLY")] = "1";
    try {
      const r = await run(["mcp", "--browser"]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(new RegExp(envName("PUBLIC_ONLY")));
    } finally {
      delete process.env[envName("PUBLIC_ONLY")];
    }
  });
});

describe("one live session", () => {
  it("opens, snapshots, clicks with the snapshot after, and screenshots as an image", async () => {
    const h = await host();
    const opened = await h.call("webindex_browser_open", { url: "https://b.test/" });
    expect(opened.text.split("\n")[0]).toBe("https://b.test/ — Title of https://b.test/ (HTTP 200)");
    expect(opened.text).toContain('- button "Search" [ref=e1]');

    const snap = await h.call("webindex_browser_snapshot", { mode: "interactive", maxChars: 5000 });
    expect(snap.text).toContain("url: https://b.test/");
    expect(snap.text).toContain('- button "Pay now" [ref=e2]');

    const clicked = await h.call("webindex_browser_click", { ref: "e1" });
    expect(clicked.text.split("\n")[0]).toBe("click e1: https://b.test/ — Title of https://b.test/");
    expect(clicked.text).toContain('- button "Search" [ref=e1]');
    expect(sent("Input.dispatchMouseEvent").map((c) => c.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);

    const shot = await h.call("webindex_browser_screenshot", { area: "viewport" });
    expect(shot.images).toEqual([{ data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/jpeg" }]);
    expect(shot.text).toMatch(/viewport.*JPEG/);
    const params = sent("Page.captureScreenshot").at(-1)?.params;
    expect(params).toEqual({ format: "jpeg", quality: 70 });
  });

  it("reuses the session across calls and makes a new one once its socket closed", async () => {
    const h = await host();
    const attaches = () => sent("Target.attachToTarget").length;
    const before = attaches();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    await h.call("webindex_browser_hover", { ref: "e1" });
    await h.call("webindex_browser_eval", { expression: "document.title" });
    expect(attaches()).toBe(before + 1);
    fake.dropClients();
    await new Promise((r) => setTimeout(r, 20));
    await h.call("webindex_browser_snapshot", { mode: "full" });
    expect(attaches()).toBe(before + 2);
    // Where the session left the tab is saved, as a CLI call would leave it.
    expect(readSession()).toMatchObject({ port: fake.port, targetId: "T1" });
  });

  it("serialises calls", async () => {
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    const order: string[] = [];
    fake.handle("Runtime.evaluate", async ({ expression }) => {
      const e = String(expression);
      if (e === "1" || e === "2") {
        order.push(`start ${e}`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`end ${e}`);
        return { result: { type: "number", value: Number(e) } };
      }
      return { result: { value: true } };
    });
    const [a, b] = await Promise.all([h.call("webindex_browser_eval", { expression: "1" }), h.call("webindex_browser_eval", { expression: "2" })]);
    expect([a.text, b.text]).toEqual(["1", "2"]);
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("detaches on close(), leaving the browser up", async () => {
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    await h.close();
    expect(sent("Browser.close")).toEqual([]);
    expect(readSession()).toMatchObject({ port: fake.port });
  });
});

describe("the guard and the policy", () => {
  it("refuses an irreversible click without confirm, telling the agent to ask the user", async () => {
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    const refused = h.call("webindex_browser_click", { ref: "e2" });
    await expect(refused).rejects.toThrow(ToolError);
    await expect(refused).rejects.toThrow(/refused to click on "Pay now".*ask the user.*confirm: true/);
    expect(sent("Input.dispatchMouseEvent")).toEqual([]);
    expect((await h.call("webindex_browser_click", { ref: "e2", confirm: true })).text).toMatch(/^click e2:/);
  });

  it("uploads only from under the extract root", async () => {
    const root = join(scratch, "root");
    mkdirSync(root);
    writeFileSync(join(root, "in.pdf"), "%PDF");
    writeFileSync(join(scratch, "out.pdf"), "%PDF");
    const h = await host({ extractRoot: root });
    await h.call("webindex_browser_snapshot", { mode: "full" });
    await expect(h.call("webindex_browser_upload", { ref: "e5", files: [join(scratch, "out.pdf")] })).rejects.toThrow(/outside/);
    await expect(h.call("webindex_browser_upload", { ref: "e5", files: ["../out.pdf"] })).rejects.toThrow(/outside/);
    expect(sent("DOM.setFileInputFiles")).toEqual([]);
    const r = await h.call("webindex_browser_upload", { ref: "e5", files: ["in.pdf"] });
    expect(r.text).toMatch(/^upload e5:/);
    expect(sent("DOM.setFileInputFiles")[0]?.params).toEqual({ files: [join(root, "in.pdf")], backendNodeId: 14 });
  });

  it("uploads nothing when the server reads no local file", async () => {
    const h = await host({ noLocalFiles: true });
    await expect(h.call("webindex_browser_upload", { ref: "e5", files: ["a.pdf"] })).rejects.toThrow(/reads no local files/);
  });

  it("with no root, uploads only with confirm, resolved against its working directory", async () => {
    // A page can talk the agent into uploading ~/.ssh/id_rsa: with no root to confine it, the user says yes.
    writeFileSync(join(scratch, "a.pdf"), "%PDF");
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    await expect(h.call("webindex_browser_upload", { ref: "e5", files: ["a.pdf"] })).rejects.toThrow(/confirm: true.*ask the user/);
    expect(sent("DOM.setFileInputFiles")).toEqual([]);
    await h.call("webindex_browser_upload", { ref: "e5", files: ["a.pdf"], confirm: true });
    expect(sent("DOM.setFileInputFiles")[0]?.params.files).toEqual([join(scratch, "a.pdf")]);
  });

  it("says so in the upload tool's description", () => {
    const upload = browserToolDecls().find((t) => t.name === "webindex_browser_upload")!;
    expect(upload.description).toMatch(/confirm: true/);
    expect(upload.inputSchema.properties.confirm).toBeDefined();
  });
});

describe("dialogs", () => {
  it("reports a pending dialog in every result until it is answered", async () => {
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    world.dialogOnClick = { type: "confirm", message: "Leave?" };
    const clicked = await h.call("webindex_browser_click", { ref: "e1" });
    expect(clicked.text).toContain('dialog confirm: "Leave?"');
    expect(clicked.text).toContain("webindex_browser_dialog");
    expect(clicked.text).not.toContain("[ref=e1]"); // the page is frozen: no snapshot
    expect((await h.call("webindex_browser_status", { show: "tabs" })).text).toContain('dialog confirm: "Leave?"');
    await expect(h.call("webindex_browser_snapshot", { mode: "full" })).rejects.toThrow(/dialog.*webindex_browser_dialog/);
    fake.handle("Page.handleJavaScriptDialog", () => ({}));
    const answered = await h.call("webindex_browser_dialog", { action: "accept", promptText: "yes" });
    expect(sent("Page.handleJavaScriptDialog").at(-1)?.params).toEqual({ accept: true, promptText: "yes" });
    expect(answered.text).toContain("[ref=e1]");
    expect((await h.call("webindex_browser_status", { show: "tabs" })).text).not.toContain("dialog");
  });

  it("refuses to accept a confirm that looks irreversible unless confirmed; dismissing never needs it", async () => {
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    world.dialogOnClick = { type: "confirm", message: "Supprimer définitivement cette annonce ?" };
    await h.call("webindex_browser_click", { ref: "e1" });
    fake.handle("Page.handleJavaScriptDialog", () => ({}));
    const before = sent("Page.handleJavaScriptDialog").length;
    const err = await h.call("webindex_browser_dialog", { action: "accept" }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toMatch(/refused to accept the confirm dialog "Supprimer définitivement cette annonce \?".*matches "supprim/);
    expect(err.message).toMatch(/ask the user, then retry with confirm: true/);
    expect(sent("Page.handleJavaScriptDialog")).toHaveLength(before);
    await h.call("webindex_browser_dialog", { action: "accept", confirm: true });
    expect(sent("Page.handleJavaScriptDialog").at(-1)?.params).toEqual({ accept: true });

    world.dialogOnClick = { type: "confirm", message: "Delete this item?" };
    await h.call("webindex_browser_click", { ref: "e1" });
    await h.call("webindex_browser_dialog", { action: "dismiss" });
    expect(sent("Page.handleJavaScriptDialog").at(-1)?.params).toEqual({ accept: false });

    // A harmless question is accepted as before.
    world.dialogOnClick = { type: "confirm", message: "Go on?" };
    await h.call("webindex_browser_click", { ref: "e1" });
    await h.call("webindex_browser_dialog", { action: "accept" });
    expect(sent("Page.handleJavaScriptDialog").at(-1)?.params).toEqual({ accept: true });
    const decl = browserToolDecls().find((t) => t.name === "webindex_browser_dialog")!;
    expect(decl.inputSchema.properties.confirm).toBeDefined();
    expect(decl.description).toMatch(/confirm: true/);
  });

  it("forgets a dialog the browser says is not showing", async () => {
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    fake.emit("Page.javascriptDialogOpening", { type: "alert", message: "Gone" }, `S${sent("Target.attachToTarget").length}`);
    await new Promise((r) => setTimeout(r, 20));
    // The fake answers handleJavaScriptDialog with "No dialog is showing".
    await expect(h.call("webindex_browser_dialog", { action: "dismiss" })).rejects.toThrow(/no dialog is open/);
    expect((await h.call("webindex_browser_status", { show: "browser" })).text).not.toContain("dialog");
    expect((await h.call("webindex_browser_snapshot", { mode: "full" })).text).toContain("[ref=e1]");
  });

  it("hears a dialog the page opens between calls, and its closing", async () => {
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    const session = sent("Target.attachToTarget").length;
    fake.emit("Page.javascriptDialogOpening", { type: "alert", message: "Hi" }, `S${session}`);
    await new Promise((r) => setTimeout(r, 20));
    expect((await h.call("webindex_browser_status", { show: "browser" })).text).toContain('dialog alert: "Hi"');
    fake.emit("Page.javascriptDialogClosed", { result: true }, `S${session}`);
    await new Promise((r) => setTimeout(r, 20));
    expect((await h.call("webindex_browser_status", { show: "browser" })).text).not.toContain("dialog");
  });
});

describe("bounds on a shared server", () => {
  it("clamps a wait's ms and timeout to 300 s", async () => {
    const h = await host();
    expect((await h.call("webindex_browser_wait", { condition: "ms", value: "86400000" })).text).toBe("ms held after 300000 ms");
    await expect(h.call("webindex_browser_wait", { condition: "text", value: "Never", timeoutMs: 1e9 })).rejects.toThrow(/after 300000 ms/);
  });

  it("stops a cancelled wait and frees the browser for the next call", async () => {
    expect((await runBrowserCommand("attach", [String(fake.port)], {}, { browser: browserDeps() })).exitCode).toBe(0);
    // A real clock: this wait would last its full 300 s.
    const h = createBrowserToolHost({ deps: { browser: { detectBrowser: () => null }, cwd: scratch } });
    hosts.push(h);
    const ac = new AbortController();
    const waiting = h.call("webindex_browser_wait", { condition: "text", value: "Never" }, { signal: ac.signal, progress: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    ac.abort();
    await expect(waiting).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(2000);
    const next = await h.call("webindex_browser_status", { show: "browser" });
    expect(next.text).toMatch(/^browser on port/);
    // The cross-process lock is free too: a CLI command gets it.
    expect((await runBrowserCommand("tabs", ["list"], {}, { browser: browserDeps() })).exitCode).toBe(0);
  });

  it("does not start a call cancelled while it queued", async () => {
    const h = await host();
    const ac = new AbortController();
    ac.abort();
    await expect(h.call("webindex_browser_snapshot", { mode: "full" }, { signal: ac.signal, progress: () => {} })).rejects.toThrow(/cancelled/);
    expect(sent("Accessibility.getFullAXTree")).toEqual([]);
  });
});

describe("network capture", () => {
  it("records from open with capture until network clear", async () => {
    const h = await host();
    world.xhr = true;
    const opened = await h.call("webindex_browser_open", { url: "https://b.test/", capture: true });
    expect(opened.text).toContain("webindex_browser_network");
    await new Promise((r) => setTimeout(r, 20));
    const list = await h.call("webindex_browser_network", { action: "list" });
    expect(list.text).toBe("1  GET 200 https://a.test/api.json (application/json, 7 B)");
    expect((await h.call("webindex_browser_network", { action: "get", n: 1 })).text).toBe('{\n  "a": 1\n}');
    // Listed twice, recorded once.
    expect((await h.call("webindex_browser_network", { action: "list" })).text.split("\n")).toHaveLength(1);
    expect((await h.call("webindex_browser_status", { show: "browser" })).text).toMatch(/recording/);
    await h.call("webindex_browser_network", { action: "clear" });
    expect((await h.call("webindex_browser_network", { action: "list" })).text).toMatch(/nothing recorded.*webindex_browser_open/);
    expect((await h.call("webindex_browser_status", { show: "browser" })).text).not.toMatch(/recording/);
    await expect(h.call("webindex_browser_network", { action: "get" })).rejects.toThrow(/`n`/);
  });
});

describe("the other tools", () => {
  it("types, fills, selects, presses, scrolls and waits", async () => {
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    expect((await h.call("webindex_browser_type", { ref: "e3", text: "hello world" })).text).toMatch(/^type e3:/);
    expect((await h.call("webindex_browser_fill", { ref: "e3", text: "new text" })).text).toMatch(/^fill e3:/);
    expect(world.els.get(12)?.value).toBe("new text");
    // No text, or an empty one, clears the field.
    expect(browserToolDecls().find((t) => t.name === "webindex_browser_fill")?.inputSchema.required).toEqual(["ref"]);
    expect((await h.call("webindex_browser_fill", { ref: "e3", text: "" })).text).toMatch(/^fill e3:/);
    expect(world.els.get(12)?.value).toBe("");
    expect((await h.call("webindex_browser_select", { ref: "e4", values: ["Medium"] })).text).toContain('value: ["m"]');
    expect((await h.call("webindex_browser_press", { key: "Escape" })).text).toMatch(/^press:/);
    expect((await h.call("webindex_browser_scroll", { target: "down" })).text).toContain('value: {"x":0,"y":640}');
    expect((await h.call("webindex_browser_wait", { condition: "text", value: "Welcome" })).text).toBe("text held after 0 ms");
    expect((await h.call("webindex_browser_wait", { condition: "ms", value: "10" })).text).toBe("ms held after 10 ms");
    expect((await h.call("webindex_browser_wait", { condition: "load" })).text).toMatch(/^load held/);
    await expect(h.call("webindex_browser_wait", { condition: "text" })).rejects.toThrow(/`value`/);
    await expect(h.call("webindex_browser_wait", { condition: "ms", value: "soon" })).rejects.toThrow(/`value`/);
    await expect(h.call("webindex_browser_wait", { condition: "text", value: "Order shipped", timeoutMs: 1000 })).rejects.toThrow(/timed out/);
    await expect(h.call("webindex_browser_scroll", { target: "sideways" })).rejects.toThrow(ToolError);
    world.active = { role: "textbox", label: "Password", isSubmit: true, formHasPassword: true, submitLabel: "Log in" };
    await expect(h.call("webindex_browser_press", { key: "Enter" })).rejects.toThrow(/refused.*password/);
    await expect(h.call("webindex_browser_type", { ref: "e3", text: "secret", submit: true })).rejects.toThrow(/refused/);
  });

  it("moves through history, and opens, selects and closes tabs", async () => {
    const h = await host();
    await h.call("webindex_browser_open", { url: "https://b.test/" });
    expect((await h.call("webindex_browser_history", { action: "back" })).text).toMatch(/^back: navigated to https:\/\/a\.test\//);
    expect((await h.call("webindex_browser_history", { action: "forward" })).text).toMatch(/^forward: navigated/);
    expect((await h.call("webindex_browser_history", { action: "reload", timeoutMs: 5000 })).text).toMatch(/^reload:/);
    const opened = await h.call("webindex_browser_tabs", { action: "new", url: "https://c.test/" });
    expect(opened.text).toBe("* t2  https://c.test/ — Title of https://c.test/");
    expect((await h.call("webindex_browser_tabs", { action: "list" })).text.split("\n")).toHaveLength(2);
    expect((await h.call("webindex_browser_tabs", { action: "select", id: "t1" })).text).toMatch(/^\* t1/);
    expect((await h.call("webindex_browser_tabs", { action: "close", id: "t2" })).text).toMatch(/^\* t1/);
    await expect(h.call("webindex_browser_tabs", { action: "select" })).rejects.toThrow(/`id`/);
    // The new tab's page answers the next call: the session follows the tab.
    expect((await h.call("webindex_browser_open", { url: "https://d.test/", newTab: true })).text).toMatch(/^https:\/\/d\.test\//);
    expect(readSession()?.targetId).toBe(fake.targets.at(-1)?.id);
  });

  it("evaluates, and reports the status", async () => {
    const h = await host();
    world.evalValue = { n: 1 };
    expect((await h.call("webindex_browser_eval", { expression: "({ n: 1 })" })).text).toBe('{\n  "n": 1\n}');
    const st = await h.call("webindex_browser_status", { show: "tabs" });
    expect(st.text).toMatch(new RegExp(`^browser on port ${fake.port}`));
    expect(st.text).toMatch(/\* t1 {2}https:\/\/a\.test\//);
    expect((await h.call("webindex_browser_status", { show: "browser" })).text.split("\n")).toHaveLength(1);
  });

  it("screenshots the full page or one element, and withholds an image too big to send", async () => {
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    await h.call("webindex_browser_screenshot", { area: "full" });
    expect(sent("Page.captureScreenshot").at(-1)?.params).toMatchObject({ format: "jpeg", captureBeyondViewport: true });
    await h.call("webindex_browser_screenshot", { area: "element", ref: "e1" });
    expect(sent("Page.captureScreenshot").at(-1)?.params).toMatchObject({ clip: { width: 100, height: 40 } });
    await expect(h.call("webindex_browser_screenshot", { area: "element" })).rejects.toThrow(/`ref`/);
    // Or the element a CSS selector matches: one or the other.
    world.selectors = { "table.infobox": 13 };
    const box = await h.call("webindex_browser_screenshot", { area: "element", selector: "table.infobox" });
    expect(box.text).toMatch(/^screenshot of table\.infobox \(JPEG/);
    expect(sent("Page.captureScreenshot").at(-1)?.params).toMatchObject({ clip: { width: 100, height: 40 } });
    await expect(h.call("webindex_browser_screenshot", { area: "element", selector: "table.nope" })).rejects.toThrow("no element matches table.nope");
    await expect(h.call("webindex_browser_screenshot", { area: "element", ref: "e1", selector: "table.infobox" })).rejects.toThrow(/not both/);
    await expect(h.call("webindex_browser_screenshot", { area: "element", ref: "table.infobox" })).rejects.toThrow(/expected a ref like e12/);
    const scoped = await h.call("webindex_browser_snapshot", { mode: "full", selector: "table.infobox" });
    expect(scoped.text).toContain('combobox "Size" [ref=e4]');
    expect(scoped.text).not.toContain("Search");
    await expect(h.call("webindex_browser_snapshot", { mode: "full", ref: "e4", selector: "table.infobox" })).rejects.toThrow(/not both/);
    // In the words of the tools: `selector`, never the CLI's --selector.
    for (const call of [
      () => h.call("webindex_browser_snapshot", { mode: "full", ref: "e4", selector: "table.infobox" }),
      () => h.call("webindex_browser_snapshot", { mode: "full", ref: "table.infobox" }),
      () => h.call("webindex_browser_screenshot", { area: "element", ref: "table.infobox" }),
      () => h.call("webindex_browser_click", { ref: "table.infobox" }),
    ]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect(err.message).not.toContain("--selector");
    }
    await expect(h.call("webindex_browser_click", { ref: "table.infobox" })).rejects.toThrow(
      "expected a ref like e12 from the latest snapshot; CSS selectors: pass `selector` to webindex_browser_screenshot, webindex_browser_snapshot or webindex_browser_text, or wait with condition selector",
    );
    // A ref or a selector goes with area element, never ignored.
    await expect(h.call("webindex_browser_screenshot", { area: "full", selector: "table.infobox" })).rejects.toThrow(/area "element"/);
    await expect(h.call("webindex_browser_screenshot", { area: "viewport", ref: "e1" })).rejects.toThrow(/area "element"/);
    expect(browserToolDecls().find((t) => t.name === "webindex_browser_snapshot")?.inputSchema.properties).toHaveProperty("selector");
    fake.handle("Page.captureScreenshot", () => ({ data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }));
    await expect(h.call("webindex_browser_screenshot", { area: "full" })).rejects.toThrow(/4 MB.*area: "element"/);
  });

  it("closes the browser: the next call starts a new session", async () => {
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    const before = sent("Target.attachToTarget").length;
    const r = await h.call("webindex_browser_close", { forget: "all" });
    expect(r.text).toMatch(/left running/); // attached, not ours
    expect(readSession()).toBeNull();
    await expect(h.call("webindex_browser_status", { show: "browser" })).resolves.toMatchObject({ text: expect.stringMatching(/no browser session/) });
    await runBrowserCommand("attach", [String(fake.port)], {}, { browser: browserDeps() });
    await h.call("webindex_browser_snapshot", { mode: "full" });
    expect(sent("Target.attachToTarget").length).toBeGreaterThan(before + 1);
  });

  it("answers a stale ref, a wrong choice or a launch option with what to do", async () => {
    const h = await host();
    // A profile named, `default` included, asks for a browser of ours, never the attached one (and none can be launched here).
    await expect(h.call("webindex_browser_open", { url: "https://b.test/", profile: "default" })).rejects.toThrow(/no Chrome, Brave/);
    // Launch options only matter to the call that opens the session: here, the attached browser keeps its window.
    expect((await h.call("webindex_browser_open", { url: "https://b.test/", headless: true, interactive: true })).text).toMatch(/^https:\/\/b\.test\//);
    await expect(h.call("webindex_browser_click", { ref: "e99" })).rejects.toThrow(/take a new snapshot/);
    await expect(h.call("webindex_browser_history", { action: "sideways" })).rejects.toThrow(/`action` must be one of back, forward, reload/);
    await expect(h.call("webindex_browser_snapshot", { mode: "full", ref: "e99" })).rejects.toThrow(ToolError);
  });

  it("records only once an open with capture has succeeded", async () => {
    const h = await host();
    await expect(h.call("webindex_browser_open", { url: "https://unreachable.test/", capture: true })).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
    expect((await h.call("webindex_browser_status", { show: "browser" })).text).not.toMatch(/recording/);
    await h.call("webindex_browser_open", { url: "https://b.test/", capture: true });
    expect((await h.call("webindex_browser_status", { show: "browser" })).text).toMatch(/recording/);
  });

  it("says a launch option is moot once the browser runs", async () => {
    const h = await host();
    await h.call("webindex_browser_snapshot", { mode: "full" });
    const r = await h.call("webindex_browser_open", { url: "https://b.test/", profile: "work", headless: true });
    expect(r.text).toMatch(/profile.*headless.*only when this call launches the browser.*profile default/);
    expect((await h.call("webindex_browser_open", { url: "https://b.test/", profile: "default" })).text).not.toMatch(/launches the browser/);
  });

  it("launches the browser kind open names, refuses one it does not know, and says it is moot once a browser runs", async () => {
    const decl = browserToolDecls().find((t) => t.name === "webindex_browser_open")!;
    expect(JSON.stringify(decl.inputSchema)).toContain('"browserKind":{"type":"string","enum":["chrome","brave","chromium","edge"]');
    const h = await host();
    await expect(h.call("webindex_browser_open", { url: "https://b.test/", browserKind: "netscape" })).rejects.toThrow(
      /`browserKind` must be one of chrome, brave, chromium, edge/,
    );
    await h.call("webindex_browser_snapshot", { mode: "full" });
    // The browser it attached to is not ours: no kind of ours applies to it.
    const r = await h.call("webindex_browser_open", { url: "https://b.test/", browserKind: "brave" });
    expect(r.text).toMatch(/browserKind apply only when this call launches the browser/);
  });

  it("says nothing of browserKind when the running browser of ours is of that kind already", async () => {
    // A browser of ours on the default profile, which belongs to brave.
    writeProfileKind("default", "brave");
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
    const h = createBrowserToolHost({ deps: { browser: browserDeps(), cwd: scratch } });
    try {
      await h.call("webindex_browser_snapshot", { mode: "full" });
      expect((await h.call("webindex_browser_open", { url: "https://b.test/", browserKind: "brave" })).text).not.toMatch(/apply only when/);
      expect((await h.call("webindex_browser_open", { url: "https://b.test/", browserKind: "chrome" })).text).toMatch(/browserKind apply only when/);
    } finally {
      await h.close();
    }
  });

  it("says what eval must not be used for", () => {
    const desc = browserToolDecls().find((t) => t.name === "webindex_browser_eval")!.description;
    expect(desc).toMatch(/form\.submit\(\)/);
    expect(desc).toMatch(/logged-in/);
  });

  it("reads the page's text, or one element's, without a snapshot", async () => {
    const decl = browserToolDecls().find((t) => t.name === "webindex_browser_text")!;
    expect(decl.inputSchema.required).toEqual(["scope"]);
    const h = await host();
    const evaluate = fake.handlerOf("Runtime.evaluate");
    const prose = "The article a reader came for, told at length so the extractor keeps it. ".repeat(8);
    fake.handle("Runtime.evaluate", (p, sid) =>
      p.expression === READ_DOCUMENT
        ? {
            result: {
              type: "object",
              value: { html: `<html><body><main><article><h1>Story</h1><p>${prose}</p></article></main></body></html>`, url: "https://a.test/" },
            },
          }
        : evaluate?.(p, sid),
    );
    const call = fake.handlerOf("Runtime.callFunctionOn");
    fake.handle("Runtime.callFunctionOn", (p, sid) =>
      /^function elementText/.test(p.functionDeclaration) ? { result: { value: { text: "Only the box", html: "<p>Only the box</p>" } } } : call?.(p, sid),
    );
    const page = await h.call("webindex_browser_text", { scope: "page" });
    expect(page.text).toContain("The article a reader came for");
    expect(page.text).not.toContain("[ref=");
    const cut = await h.call("webindex_browser_text", { scope: "page", maxChars: 30 });
    expect(cut.text).toMatch(/truncated at 30 of \d+ characters: raise maxChars, or read one element \(scope element with a ref or a selector\)/);
    await h.call("webindex_browser_snapshot", { mode: "full" });
    expect((await h.call("webindex_browser_text", { scope: "element", ref: "e3" })).text).toContain("Only the box");
    world.selectors = { "div.box": 12 };
    expect((await h.call("webindex_browser_text", { scope: "element", selector: "div.box", markdown: true })).text).toContain("Only the box");
    await expect(h.call("webindex_browser_text", { scope: "element" })).rejects.toThrow(/`ref` or a `selector`/);
    await expect(h.call("webindex_browser_text", { scope: "page", ref: "e3" })).rejects.toThrow(/scope "element"/);
    await expect(h.call("webindex_browser_text", { scope: "all" })).rejects.toThrow(/`scope` must be one of page, element/);
    for (const maxChars of [-5, 0, 2.5]) {
      await expect(h.call("webindex_browser_text", { scope: "page", maxChars }), String(maxChars)).rejects.toThrow(/`maxChars` must be a whole number/);
    }
  });

  it("names a blocking challenge an action lands on in a line after the result line, and is no error", async () => {
    const h = await host();
    world.blocking = true;
    const r = await h.call("webindex_browser_open", { url: "https://b.test/" });
    // Resolved, not thrown: the tool result is no error.
    expect(r.text.split("\n")[0]).toMatch(/^https:\/\/b\.test\//);
    expect(r.text).toMatch(/^challenge: cloudflare \(blocking\) — let the human solve it, then webindex_browser_wait with condition clear/m);
    await h.call("webindex_browser_snapshot", { mode: "full" });
    expect((await h.call("webindex_browser_click", { ref: "e1" })).text).toMatch(/challenge: cloudflare \(blocking\)/);
  });

  it("refuses an unknown tool", async () => {
    const h = await host();
    await expect(h.call("webindex_browser_nope", {})).rejects.toThrow(/unknown tool/);
  });
});
