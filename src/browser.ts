// A real Chrome over the DevTools Protocol — public surface.
//
// The implementation lives in ./browser/: `ws.ts` and `cdp.ts` (a zero-dependency
// WebSocket and CDP client), `discovery.ts`, `detect.ts`, `launch.ts` and
// `profile.ts` (finding, starting and isolating a browser), `session.ts` (one
// live tab), `snapshot.ts` (an accessibility tree with stable refs), `actions.ts`
// (click, type, fill…, behind the irreversibility guard), `challenge.ts` (anti-bot
// walls), `network.ts` and `read.ts` (a rendered page as readable text).
//
// Callers want `openBrowserSession`, or `readRenderedPage` for a one-shot read
// (and `closeBrowserReads` at the end of their run).
// Names are prefixed `Browser*` so vendoring skills do not collide.

export { openBrowserSession, type BrowserSession, type OpenOptions as BrowserOpenOptions } from "./browser/session.js";
export {
  closeBrowserReads,
  readRenderedPage,
  type CloseReadsOptions as BrowserCloseReadsOptions,
  type ReadPageOptions as BrowserReadOptions,
} from "./browser/read.js";
export {
  renderSnapshot as renderBrowserSnapshot,
  type AXNode as BrowserAXNode,
  type RenderOptions as BrowserRenderOptions,
  type RenderResult as BrowserRenderResult,
  type SnapshotOptions as BrowserSnapshotOptions,
  type SnapshotResult as BrowserSnapshotResult,
} from "./browser/snapshot.js";
export {
  classifyChallenge as classifyBrowserChallenge,
  type Challenge as BrowserChallenge,
  type ChallengeSignature as BrowserChallengeSignature,
} from "./browser/challenge.js";
export { detectBrowserBinary, type BrowserBinary, type BrowserKind, type DetectOptions as BrowserDetectOptions } from "./browser/detect.js";
export { browserHome } from "./browser/profile.js";
export type { NetworkEntry as BrowserNetworkEntry } from "./browser/network.js";
export type { ActionResult as BrowserActionResult } from "./browser/actions.js";
