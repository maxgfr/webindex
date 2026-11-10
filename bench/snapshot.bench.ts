import { bench, describe } from "vitest";
import { type AXNode, renderSnapshot } from "../src/browser/snapshot.js";
import type { RefTable } from "../src/browser/state.js";

// The accessibility snapshot of a large page: every control and container is
// given a ref, and a ref is looked up by the node it names. Run with
// `pnpm run bench`; offline, no browser.
//
// A single-page app keeps one document (one loaderId) across route changes, so
// the ref table only grows: the second case renders the same page against the
// table the first one filled, which is what every snapshot after the first is.

const value = (v: string) => ({ type: "string", value: v });

/** A page of `n` rows, each a link and a button: 2n refs. */
function page(n: number): AXNode[] {
  const nodes: AXNode[] = [{ nodeId: "0", role: value("RootWebArea"), childIds: [], backendDOMNodeId: 1 }];
  const root = nodes[0] as AXNode;
  for (let i = 0; i < n; i++) {
    const link = String(2 * i + 1);
    const button = String(2 * i + 2);
    root.childIds?.push(link, button);
    nodes.push({ nodeId: link, role: value("link"), name: value(`Open item ${i}`), childIds: [], backendDOMNodeId: 10 + 2 * i });
    nodes.push({ nodeId: button, role: value("button"), name: value(`Archive item ${i}`), childIds: [], backendDOMNodeId: 11 + 2 * i });
  }
  return nodes;
}

const fresh = (): RefTable => ({ loaderId: "L1", url: "https://a.test/", next: 1, refs: {} });

for (const rows of [500, 2_500]) {
  const nodes = page(rows);
  const filled = renderSnapshot(nodes, { refs: fresh() }).refs;
  describe(`renderSnapshot (${rows * 2} refs)`, () => {
    bench("first snapshot of the page", () => {
      renderSnapshot(nodes, { refs: fresh() });
    });
    bench("a later snapshot, refs already known", () => {
      renderSnapshot(nodes, { refs: filled });
    });
  });
}
