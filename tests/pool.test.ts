import { describe, expect, it } from "vitest";
import { mapLimit } from "../src/pool.js";

describe("mapLimit", () => {
  it("preserves input order regardless of completion order", async () => {
    // The slowest item is first, so a result array built in completion order
    // would come back reversed. Consumers number their sources from this array,
    // so order is correctness, not tidiness.
    const out = await mapLimit([30, 20, 10, 0], 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:20", "2:10", "3:0"]);
  });

  it("never exceeds the requested width", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    );
    expect(peak).toBe(3);
  });

  it("actually overlaps — a width of 4 is not four sequential calls", async () => {
    const started = Date.now();
    await mapLimit([20, 20, 20, 20], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
    });
    // Sequentially this is 80ms; overlapped it is ~20. The generous ceiling keeps
    // the assertion about "did they overlap", not about timer precision.
    expect(Date.now() - started).toBeLessThan(70);
  });

  it("runs sequentially at width 1, and handles the trivial shapes", async () => {
    let peak = 0;
    let inFlight = 0;
    const out = await mapLimit([1, 2, 3], 1, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6]);
    expect(peak).toBe(1);

    expect(await mapLimit([], 4, async (n) => n)).toEqual([]);
    expect(await mapLimit([7], 4, async (n) => n)).toEqual([7]);
    // A nonsense width degrades to sequential rather than dividing by zero.
    expect(await mapLimit([1, 2], 0, async (n) => n)).toEqual([1, 2]);
  });

  it("treats a width that is not a number as 1, rather than doing nothing", async () => {
    // Math.max(1, NaN) is NaN: no workers were started and the call resolved
    // to an array of holes, with fn never called.
    for (const width of [Number.NaN, Number("ten"), Number.POSITIVE_INFINITY, -3]) {
      let calls = 0;
      const out = await mapLimit([1, 2, 3], width, async (n) => {
        calls++;
        return n * 2;
      });
      expect(out, String(width)).toEqual([2, 4, 6]);
      expect(calls, String(width)).toBe(3);
    }
  });

  it("stops claiming items once one has rejected", async () => {
    // The caller has already been handed the rejection; running fn on every
    // remaining item — network requests, in practice — is work nobody reads.
    const started: number[] = [];
    await expect(
      mapLimit(
        Array.from({ length: 10 }, (_, i) => i),
        3,
        async (n) => {
          started.push(n);
          await new Promise((r) => setTimeout(r, n === 0 ? 1 : 20));
          if (n === 0) throw new Error("first");
          return n;
        },
      ),
    ).rejects.toThrow("first");
    await new Promise((r) => setTimeout(r, 80));
    expect(started).toEqual([0, 1, 2]);
  });

  it("rejects the whole call when an item throws, like Promise.all", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("nope");
        return n;
      }),
    ).rejects.toThrow("nope");
  });
});
