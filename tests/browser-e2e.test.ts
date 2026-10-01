import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configure, resetBrand } from "../src/brand.js";
import { type BrowserCliFlags, type BrowserCliResult, runBrowserCommand } from "../src/browser/cli.js";
import { isPortAlive } from "../src/browser/discovery.js";
import { createBrowserToolHost } from "../src/browser/mcp.js";
import { readRenderedPage } from "../src/index.js";

// A real Chrome (or Brave, Chromium, Edge), headless, driven the way the CLI
// drives it: every step is one `browser` command that reconnects through
// session.json, as separate CLI processes would (one step drives the MCP
// tools instead, whose session outlives a call). Opt-in, never in CI:
//
//   WEBINDEX_E2E_BROWSER=1 pnpm vitest run tests/browser-e2e.test.ts
//
// A path instead of 1 names the browser binary to drive. The pages come from a
// local server; the browser home is a scratch directory, removed afterwards with
// every browser this suite started.

const E2E = process.env.WEBINDEX_E2E_BROWSER;
const live = !!E2E;
const binary = E2E && E2E !== "1" ? E2E : undefined;
// A binary named that does not exist is a typo, not a request for whichever browser is found.
if (binary && !existsSync(binary)) throw new Error(`WEBINDEX_E2E_BROWSER names no file: ${binary} (set it to 1, or to a browser binary)`);

const PREFIX = "WEBINDEX_TEST";
const STEP_MS = 60_000;

// A 1×1 transparent GIF: the icon of an icon-only button.
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const PAGES: Record<string, string> = {
  "/": `<!doctype html><html><head><title>E2E form</title></head><body>
<h1>Form</h1>
<form id="search" onsubmit="event.preventDefault(); go()">
  <label>Query <input id="q" name="q"></label>
  <label>Kind <select id="kind"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
  <label><input type="checkbox" id="agree"> Agree</label>
  <label>Attachment <input type="file" id="file"></label>
  <button type="submit">Search</button>
</form>
<button type="button" onclick="document.getElementById('out').textContent = 'Paid'">Payer</button>
<button type="button" onclick="document.getElementById('out').textContent = 'Deleted'"><img alt="Supprimer" src="${GIF}"></button>
<button type="button" onclick="alert('hello from the page')">Notify</button>
<button type="button" onclick="document.getElementById('out').textContent = 'Answered: ' + confirm('Go on?')">Ask</button>
<form id="login" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Logged in'">
  <label>User <input id="user"></label>
  <label>Password <input type="password" id="pw"></label>
  <button type="submit">Go</button>
</form>
<p id="out">Nothing yet</p>
<iframe src="/frame.html" title="Inner frame" width="400" height="120"></iframe>
<div style="height: 3000px"></div>
<button type="button" id="far" style="display: block; width: 200px; height: 60px; background: rgb(255, 0, 0); border: 0; color: rgb(255, 0, 0)">Far away</button>
<a href="/second.html">Next page</a>
<script>
async function go() {
  const q = document.getElementById("q").value;
  const r = await fetch("/api.json?q=" + encodeURIComponent(q));
  const j = await r.json();
  const file = document.getElementById("file").files[0];
  document.getElementById("out").textContent =
    "Results: " + j.items.join(", ") + " / " + document.getElementById("kind").value + " / " + document.getElementById("agree").checked + " / " + (file ? file.name : "no file");
}
</script>
</body></html>`,
  "/frame.html": `<!doctype html><html><head><title>Frame</title></head><body>
<h2>Frame heading</h2>
<button type="button" onclick="this.textContent = 'Clicked inside'">Inside frame</button>
</body></html>`,
  "/onload.html": `<!doctype html><html><head><title>Loaded</title></head><body onload="alert('loaded')"><h1>Alert on load</h1></body></html>`,
  "/leave.html": `<!doctype html><html><head><title>Leave</title></head><body>
<label>Note <input id="note"></label>
<script>
addEventListener("beforeunload", (e) => {
  if (document.getElementById("note").value) {
    e.preventDefault();
    e.returnValue = "";
  }
});
</script></body></html>`,
  "/later.html": `<!doctype html><html><head><title>Later</title></head><body><h1>An alert after the command</h1>
<script>setTimeout(() => alert("later"), 800);</script></body></html>`,
  "/second.html": `<!doctype html><html><head><title>Second page</title></head><body><h1>The second page</h1></body></html>`,
  "/js.html": `<!doctype html><html><head><title>Rendered later</title></head><body><main id="root"></main>
<script>
fetch("/api.json").then((r) => r.json()).then((j) => {
  document.getElementById("root").innerHTML =
    "<article><h1>Rendered by script</h1><p>Inserted by JavaScript after the page loaded: " + j.items.join(", ") +
    ". This paragraph is long enough for the extractor to keep it as the main content of the page, which it would drop as boilerplate if it were a stub.</p></article>";
});
</script></body></html>`,
};

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] as string;
    if (path === "/api.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: ["alpha", "beta", "gamma"] }));
      return;
    }
    const page = PAGES[path];
    res.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(page ?? "<!doctype html><title>Not found</title><h1>Not found</h1>");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** The ref of the first `<role> "<name>"` line of a snapshot. */
function refOf(snapshot: string, role: string, name: string): string {
  const line = snapshot.split("\n").find((l) => l.includes(`${role} "${name}"`) && l.includes("[ref="));
  const ref = line && /\[ref=(e\d+)\]/.exec(line)?.[1];
  if (!ref) throw new Error(`no ${role} "${name}" with a ref in the snapshot:\n${snapshot}`);
  return ref;
}

/** Decode an 8-bit RGB(A) PNG enough to read a pixel: width, height and the unfiltered rows. */
function decodePng(buf: Buffer): { width: number; height: number; pixel: (x: number, y: number) => number[] } {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8); // bit depth
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      expect(channels).toBeGreaterThan(0);
    }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    const prev = rows[y - 1] ?? Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (line[i - channels] as number) : 0;
      const b = prev[i] as number;
      const c = i >= channels ? (prev[i - channels] as number) : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const add = [0, a, b, (a + b) >> 1, paeth][filter] as number;
      line[i] = ((line[i] as number) + add) & 0xff;
    }
    rows.push(line);
  }
  return { width, height, pixel: (x, y) => [...(rows[y] as Buffer).subarray(x * channels, x * channels + 3)] };
}

/** The port a browser on that profile listens on, from the DevToolsActivePort it writes there. */
function readActivePortFile(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const port = Number(readFileSync(path, "utf8").split("\n")[0]);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function waitGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      try {
        process.kill(pid, 0);
      } catch {
        resolve(true);
        return;
      }
      if (Date.now() > until) resolve(false);
      else setTimeout(tick, 100);
    };
    tick();
  });
}

describe.runIf(live)("a real browser, driven command by command", () => {
  let server: Server;
  let base: string;
  let home: string;
  let scratch: string;
  /** The pid of the browser the session launched, for the check that close really kills it. */
  let pid: number | undefined;
  /** The latest snapshot text. */
  let snap = "";

  /** The suite's brand and browser home: the global setup resets both around every case, and afterAll runs outside them. */
  const scope = () => {
    configure({ name: "webindex-tests", envPrefix: PREFIX, cli: "webindex-tests" });
    process.env[`${PREFIX}_BROWSER_DIR`] = home;
    if (binary) process.env[`${PREFIX}_BROWSER_BIN`] = binary;
  };

  const run = async (action: string, args: string[] = [], flags: BrowserCliFlags = {}): Promise<BrowserCliResult> =>
    runBrowserCommand(action, args, { headless: true, ...flags }, { cwd: scratch });

  const ok = async (action: string, args: string[] = [], flags: BrowserCliFlags = {}): Promise<BrowserCliResult> => {
    const r = await run(action, args, flags);
    if (r.exitCode !== 0) throw new Error(`browser ${action} ${args.join(" ")} failed (${r.exitCode}): ${r.text}`);
    return r;
  };

  const snapshot = async (): Promise<string> => {
    snap = (await ok("snapshot")).text;
    return snap;
  };

  beforeAll(async () => {
    server = await serve();
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    home = mkdtempSync(join(tmpdir(), "webindex-e2e-browser-"));
    scratch = mkdtempSync(join(tmpdir(), "webindex-e2e-files-"));
    writeFileSync(join(scratch, "note.txt"), "an attachment\n");
  });

  beforeEach(scope);

  afterAll(async () => {
    // Whatever a failed step left running is shut down: the session's browser, then any other on the scratch profile.
    scope();
    try {
      await runBrowserCommand("close", [], { all: true });
      const port = readActivePortFile(join(home, "profiles", "default", "DevToolsActivePort"));
      if (port !== undefined && (await isPortAlive(port))) await runBrowserCommand("close", [], { all: true });
      if (pid !== undefined && !(await waitGone(pid, 5000))) process.kill(pid, "SIGKILL");
    } finally {
      resetBrand();
      delete process.env[`${PREFIX}_BROWSER_DIR`];
      delete process.env[`${PREFIX}_BROWSER_BIN`];
      await new Promise((resolve) => server.close(resolve));
      // A browser that has just quit may still be writing its profile.
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it(
    "opens the form page headless with --capture, and the snapshot has the controls and the iframe's content",
    async () => {
      const r = await ok("open", [`${base}/`], { capture: true, snapshot: true });
      expect(r.json).toMatchObject({ ok: true, url: `${base}/`, title: "E2E form", status: 200, challenge: null });
      const session = JSON.parse(readFileSync(join(home, "session.json"), "utf8")) as { pid?: number; launchedByUs: boolean; headless: boolean };
      expect(session).toMatchObject({ launchedByUs: true, headless: true });
      pid = session.pid;
      expect(pid).toBeTypeOf("number");
      snap = r.text;
      for (const [role, name] of [
        ["textbox", "Query"],
        ["combobox", "Kind"],
        ["checkbox", "Agree"],
        ["button", "Search"],
        ["button", "Payer"],
        ["button", "Supprimer"],
        ["button", "Inside frame"],
      ] as const) {
        expect(() => refOf(snap, role, name)).not.toThrow();
      }
      // The same-origin iframe is expanded into the tree.
      expect(snap).toContain("Frame heading");
    },
    STEP_MS,
  );

  it(
    "fills, selects, checks and uploads, then a click on Search passes the guard and the page's fetch is captured",
    async () => {
      await snapshot();
      await ok("fill", [refOf(snap, "textbox", "Query"), "webindex"]);
      const sel = await ok("select", [refOf(snap, "combobox", "Kind"), "Beta"]);
      expect((sel.json as { value?: unknown }).value).toEqual(["b"]);
      await ok("click", [refOf(snap, "checkbox", "Agree")]);
      const file = snap.split("\n").find((l) => /Attachment/.test(l) && /\[ref=/.test(l));
      const fileRef = file && /\[ref=(e\d+)\]/.exec(file)?.[1];
      expect(fileRef, `no file input in:\n${snap}`).toBeTruthy();
      const up = await ok("upload", [fileRef as string, "note.txt"]);
      expect((up.json as { value?: unknown }).value).toEqual({ files: 1 });

      const click = await ok("click", [refOf(snap, "button", "Search")], { capture: true });
      expect(click.json).toMatchObject({ ok: true, action: "click" });
      const waited = await ok("wait", [], { text: "Results:" });
      expect(waited.text).toMatch(/held after/);
      const out = await ok("eval", ["document.getElementById('out').textContent"]);
      expect((out.json as { value?: unknown }).value).toBe("Results: alpha, beta, gamma / b / true / note.txt");

      const list = await ok("network", ["list"]);
      const entries = (list.json as { entries: { n: number; url: string; status: number }[] }).entries;
      const api = entries.find((e) => e.url.startsWith(`${base}/api.json?q=webindex`));
      expect(api, list.text).toBeTruthy();
      const got = await ok("network", ["get", String(api?.n)]);
      expect((got.json as { json?: unknown }).json).toEqual({ items: ["alpha", "beta", "gamma"] });
    },
    STEP_MS,
  );

  it(
    "runs the guard's in-page collector: Payer and an icon-only Supprimer are refused, Enter in a password form too",
    async () => {
      await snapshot();
      const pay = await run("click", [refOf(snap, "button", "Payer")]);
      expect(pay.exitCode).toBe(1);
      expect(pay.text).toMatch(/refused to click on "Payer".*matches "payer"/);
      const del = await run("click", [refOf(snap, "button", "Supprimer")]);
      expect(del.exitCode).toBe(1);
      expect(del.text).toMatch(/refused to click on "Supprimer"/);
      expect((await ok("eval", ["document.getElementById('out').textContent"])).json).toMatchObject({ value: expect.stringMatching(/^Results:/) });

      await ok("fill", [refOf(snap, "textbox", "User"), "someone"]);
      await ok("fill", [refOf(snap, "textbox", "Password"), "not-a-secret"]);
      const enter = await run("press", ["Enter"]);
      expect(enter.exitCode).toBe(1);
      expect(enter.text).toMatch(/refused to press Enter.*password field/);
      const typed = await run("type", [refOf(snap, "textbox", "Password"), "x"], { submit: true });
      expect(typed.exitCode).toBe(1);
      expect(typed.text).toMatch(/password field/);
      expect((await ok("eval", ["document.getElementById('out').textContent"])).json).toMatchObject({ value: expect.not.stringMatching(/Logged in/) });

      // Enter in the search form is allowed: its submit control says Search.
      const search = await ok("type", [refOf(snap, "textbox", "Query"), " again"], { submit: true });
      expect(search.json).toMatchObject({ ok: true, action: "type" });
      await ok("wait", [], { text: "Results:" });

      // With the user's yes, the click goes through.
      await ok("click", [refOf(snap, "button", "Payer")], { confirm: true });
      expect((await ok("eval", ["document.getElementById('out').textContent"])).json).toMatchObject({ value: "Paid" });
    },
    STEP_MS,
  );

  it(
    "reports an alert a click opens, with the page's url, and dismisses it before the command ends",
    async () => {
      await snapshot();
      const r = await ok("click", [refOf(snap, "button", "Notify")]);
      // The url and title come from Target.getTargetInfo on the page session: the frozen page itself answers nothing.
      expect(r.json).toMatchObject({ dialog: { type: "alert", message: "hello from the page", dismissed: true }, url: `${base}/`, title: "E2E form" });
      expect(r.text).toMatch(/dialog alert: "hello from the page" — dismissed: a dialog cannot outlive a command/);
      // The next command finds a page that answers, and no dialog left.
      expect((await ok("eval", ["document.title"])).json).toMatchObject({ value: "E2E form" });
      // Answering one is the MCP tools' job: the CLI command refuses at once.
      const none = await run("dialog", ["dismiss"]);
      expect(none.exitCode).toBe(1);
      expect(none.text).toMatch(/^the CLI dismisses dialogs before each command ends/);
    },
    STEP_MS,
  );

  it(
    "keeps a dialog open over MCP, refuses the page tools behind it, and answers it at once",
    async () => {
      const host = createBrowserToolHost({ deps: { cwd: scratch } });
      try {
        const opened = await host.call("webindex_browser_snapshot", { mode: "interactive" });
        const ask = refOf(opened.text, "button", "Ask");
        const click = await host.call("webindex_browser_click", { ref: ask });
        expect(click.text).toMatch(/dialog confirm: "Go on\?" — it is still open/);
        await expect(host.call("webindex_browser_snapshot", { mode: "interactive" })).rejects.toThrow(/a JavaScript dialog is open/);
        const started = Date.now();
        const answered = await host.call("webindex_browser_dialog", { action: "accept", interactive: true });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(answered.text).toMatch(/^dialog: /);
        expect((await host.call("webindex_browser_eval", { expression: "document.getElementById('out').textContent" })).text).toBe("Answered: true");
      } finally {
        await host.close();
      }
    },
    STEP_MS,
  );

  it(
    "clicks inside the same-origin iframe",
    async () => {
      await snapshot();
      await ok("click", [refOf(snap, "button", "Inside frame")]);
      expect(await snapshot()).toContain('button "Clicked inside"');
    },
    STEP_MS,
  );

  it(
    "screenshots the viewport and an element far below it as valid PNGs, the element's clip on the element",
    async () => {
      await snapshot();
      const view = await ok("screenshot", [], { out: "view.png" });
      expect(decodePng(readFileSync(join(scratch, "view.png"))).width).toBeGreaterThan(300);
      expect(statSync(join(scratch, "view.png")).mode & 0o777).toBe(0o600);
      expect(view.json).toMatchObject({ format: "png" });

      await ok("screenshot", [refOf(snap, "button", "Far away")], { out: "far.png" });
      const png = decodePng(readFileSync(join(scratch, "far.png")));
      const ratio = png.width / 200;
      expect(ratio).toBeGreaterThanOrEqual(1);
      expect(png.height).toBe(Math.round(60 * ratio));
      // The clip is on the red button, not on the white page above it.
      for (const [x, y] of [
        [2, 2],
        [png.width >> 1, png.height >> 1],
        [png.width - 3, png.height - 3],
      ] as const) {
        const [r, g, b] = png.pixel(x, y);
        expect(r).toBeGreaterThan(200);
        expect(g).toBeLessThan(60);
        expect(b).toBeLessThan(60);
      }
    },
    STEP_MS,
  );

  it(
    "follows a link, goes back, and a ref from before the navigation is stale",
    async () => {
      await snapshot();
      const oldRef = refOf(snap, "button", "Payer");
      const nav = await ok("click", [refOf(snap, "link", "Next page")]);
      expect(nav.json).toMatchObject({ navigated: true, url: `${base}/second.html`, title: "Second page" });
      const stale = await run("click", [oldRef]);
      expect(stale.exitCode).toBe(1);
      expect(stale.text).toMatch(/stale: take a new snapshot/);
      const back = await ok("back");
      expect(back.json).toMatchObject({ action: "back", navigated: true, url: `${base}/`, title: "E2E form" });
      expect(await snapshot()).toContain('button "Payer"');
    },
    STEP_MS,
  );

  it(
    "reads a JS-rendered page in a scratch tab with readRenderedPage, and leaves the agent's tab alone",
    async () => {
      const before = (await ok("status")).json as { tabs: unknown[] };
      const page = await readRenderedPage(`${base}/js.html`, { headless: true });
      expect(page).toMatchObject({ extractor: "browser", status: 200, finalUrl: `${base}/js.html` });
      expect(page.text).toContain("Inserted by JavaScript after the page loaded: alpha, beta, gamma");
      const missing = await readRenderedPage(`${base}/missing`, { headless: true });
      expect(missing.status).toBe(404);
      const after = (await ok("status")).json as { tabs: unknown[]; url: string };
      expect(after.tabs).toHaveLength(before.tabs.length);
      expect(after.url).toBe(`${base}/`);
    },
    STEP_MS,
  );

  it(
    "dismisses an alert the page shows on load, so open returns at once and the next command works",
    async () => {
      const started = Date.now();
      const r = await ok("open", [`${base}/onload.html`]);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(r.json).toMatchObject({ url: `${base}/onload.html`, title: "Loaded", dialogs: [{ type: "alert", message: "loaded", dismissed: true }] });
      expect(r.text).toMatch(/dialog alert: "loaded" — dismissed/);
      expect((await ok("eval", ["document.title"])).json).toMatchObject({ value: "Loaded" });
    },
    STEP_MS,
  );

  it(
    "dismisses the beforeunload dialog a reload meets after typing: the reload is cancelled, fast, and the page keeps the text",
    async () => {
      await ok("open", [`${base}/leave.html`]);
      await snapshot();
      await ok("type", [refOf(snap, "textbox", "Note"), "unsaved"]);
      const started = Date.now();
      const r = await run("reload");
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(r.exitCode).toBe(1);
      expect(r.text).toMatch(/^reloading was cancelled: the page asked to confirm leaving it \(beforeunload\), and that was declined/);
      expect(r.json).toMatchObject({ dialogs: [{ type: "beforeunload", dismissed: true }] });
      expect((await ok("eval", ["document.getElementById('note').value"])).json).toMatchObject({ value: "unsaved" });
      // Leaving it some other way meets the same question, answered the same way.
      const away = await run("open", [`${base}/second.html`]);
      expect(away.exitCode).toBe(1);
      expect(away.json).toMatchObject({ dialogs: [{ type: "beforeunload", dismissed: true }] });
      await ok("eval", ["document.getElementById('note').value = ''"]);
    },
    STEP_MS,
  );

  it(
    "names the dialog a page opened between commands when the next one cannot reach the tab, and close is the way out",
    async () => {
      await ok("open", [`${base}/later.html`]);
      await new Promise((r) => setTimeout(r, 1500)); // the alert opens with no command connected
      const started = Date.now();
      const stuck = await run("snapshot");
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(stuck.exitCode).toBe(1);
      expect(stuck.text).toBe(
        "the tab does not answer; most likely a JavaScript dialog the page opened between commands — answer it in the window, or `webindex-tests browser close`",
      );
      const r = await ok("close");
      expect(r.json).toMatchObject({ closed: true, launchedByUs: true });
      expect(await waitGone(pid as number, 10_000)).toBe(true);
      expect((await ok("status")).json).toMatchObject({ alive: false });
    },
    STEP_MS,
  );

  it(
    "close also shuts down a browser a fetch read launched",
    async () => {
      // No browser: a read launches one on the dedicated profile, saves no session, and close finds it all the same.
      const page = await readRenderedPage(`${base}/second.html`, { headless: true });
      expect(page.text).toContain("The second page");
      const port = readActivePortFile(join(home, "profiles", "default", "DevToolsActivePort"));
      expect(port).toBeTypeOf("number");
      expect(await isPortAlive(port as number)).toBe(true);
      const closed = await ok("close");
      expect(closed.json).toMatchObject({ closed: true });
      const until = Date.now() + 10_000;
      while ((await isPortAlive(port as number)) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      expect(await isPortAlive(port as number)).toBe(false);
    },
    STEP_MS,
  );
});
