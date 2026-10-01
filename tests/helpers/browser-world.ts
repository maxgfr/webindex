import { COLLECT_SOURCE } from "../../src/browser/risk.js";
import type { FakeCdp } from "./fake-cdp.js";

// The page behind a FakeCdp for the browser command tests (CLI and MCP): an AX
// tree with five controls (e1 Search, e2 Pay now, e3 Query, e4 Size, e5 File),
// and the CDP answers the actions need. Use with scriptBrowser().

interface El {
  label: string;
  value?: string;
}

const BOX = [[0, 0, 100, 0, 100, 40, 0, 40]];

/** The page; flip its fields to script what the next command meets. */
export class BrowserWorld {
  els = new Map<number, El>([
    [10, { label: "Search" }],
    [11, { label: "Pay now" }],
    [12, { label: "Query", value: "" }],
    [13, { label: "Size" }],
    [14, { label: "File" }],
  ]);
  focused: number | undefined;
  aimed: number | undefined;
  /** document.activeElement as the risk collector reads it. */
  active = { role: "textbox", label: "Query", isSubmit: true, formHasPassword: false, submitLabel: "Search" };
  /** What the challenge probe sees. */
  blocking = false;
  bodyText = "Welcome";
  evalValue: unknown = "A page";
  /** The next mouse release opens this dialog. */
  dialogOnClick: { type: string; message: string } | undefined;
  /** Network events the first Network.enable sends, as a page's own XHR would. */
  xhr = false;

  constructor(readonly fake: FakeCdp) {
    const ax = (id: string, role: string, name: string, backendDOMNodeId: number) => ({
      nodeId: id,
      parentId: "1",
      role: { value: role },
      name: { value: name },
      backendDOMNodeId,
    });
    fake.handle("Accessibility.getFullAXTree", () => ({
      nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "A" }, childIds: ["2", "3", "4", "5", "6"], backendDOMNodeId: 1 },
        ax("2", "button", "Search", 10),
        ax("3", "button", "Pay now", 11),
        ax("4", "textbox", "Query", 12),
        ax("5", "combobox", "Size", 13),
        ax("6", "button", "File", 14),
      ],
    }));
    fake.handle("DOM.resolveNode", ({ backendNodeId }) => {
      if (!this.els.has(backendNodeId)) throw { code: -32000, message: "No node with given id found" };
      return { object: { objectId: `o${backendNodeId}` } };
    });
    fake.handle("DOM.getContentQuads", ({ backendNodeId }) => {
      this.aimed = backendNodeId;
      return { quads: BOX };
    });
    fake.handle("DOM.getNodeForLocation", () => ({ backendNodeId: this.aimed }));
    fake.handle("DOM.focus", ({ backendNodeId }) => {
      this.focused = backendNodeId;
    });
    fake.handle("Input.insertText", ({ text }) => {
      const el = this.focused === undefined ? undefined : this.els.get(this.focused);
      if (el) el.value = text;
    });
    fake.handle("Input.dispatchMouseEvent", (e, sessionId) => {
      if (e.type === "mouseReleased" && this.dialogOnClick) {
        fake.emit("Page.javascriptDialogOpening", { ...this.dialogOnClick, url: "https://a.test/" }, sessionId);
        this.dialogOnClick = undefined;
      }
    });
    fake.handle("Runtime.callFunctionOn", ({ objectId, functionDeclaration }) => {
      const el = this.els.get(Number(String(objectId).slice(1))) as El;
      if (functionDeclaration === COLLECT_SOURCE) return { result: { value: { role: "button", label: el.label, isSubmit: false, formHasPassword: false } } };
      const name = /^function (\w+)/.exec(functionDeclaration)?.[1];
      if (name === "hitTest") return { result: { value: null } };
      if (name === "fieldKind") return { result: { value: { kind: "field" } } };
      if (name === "readValue") return { result: { value: el.value ?? "" } };
      if (name === "matchOptions") return { result: { value: { picked: [1] } } };
      if (name === "applyOptions") return { result: { value: ["m"] } };
      if (name === "fileInput") return { result: { value: { ok: true, multiple: true, what: "<input>" } } };
      return { result: {} };
    });
    fake.handle("Runtime.evaluate", ({ expression }) => {
      const e = String(expression);
      if (e.includes(COLLECT_SOURCE)) return { result: { value: this.active } };
      if (e.includes("document.cookie")) {
        return {
          result: { value: { url: "u", title: this.blocking ? "Just a moment..." : "Shop", text: "x".repeat(2000), status: this.blocking ? 503 : 200 } },
        };
      }
      if (e.includes("responseStatus")) return { result: { type: "number", value: 200 } };
      if (e.includes("readyState")) return { result: { value: e.includes("===") ? true : "complete" } };
      if (e.includes("innerText")) return { result: { value: this.bodyText.includes(JSON.parse(e.match(/includes\((".*")\)/)?.[1] ?? '""')) } };
      if (e.includes("scroll")) return { result: { value: { x: 0, y: 640 } } };
      return { result: { type: typeof this.evalValue, value: this.evalValue } };
    });
    fake.handle("Page.captureScreenshot", () => ({ data: Buffer.from("PNGDATA").toString("base64") }));
    fake.handle("Page.handleJavaScriptDialog", () => {
      throw { code: -32000, message: "No dialog is showing" };
    });
    let sent = false;
    fake.handle("Network.enable", (_p, sessionId) => {
      if (!this.xhr || sent) return {};
      sent = true;
      setTimeout(() => {
        fake.emit("Network.requestWillBeSent", { requestId: "r1", type: "XHR", request: { method: "GET", url: "https://a.test/api.json" } }, sessionId);
        fake.emit(
          "Network.responseReceived",
          { requestId: "r1", type: "XHR", response: { url: "https://a.test/api.json", status: 200, mimeType: "application/json" } },
          sessionId,
        );
        fake.emit("Network.loadingFinished", { requestId: "r1", encodedDataLength: 9 }, sessionId);
      }, 0);
      return {};
    });
    fake.handle("Network.getResponseBody", () => ({ body: '{"a":1}' }));
  }
}
