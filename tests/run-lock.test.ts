import { afterEach, describe, expect, it } from "vitest";
import { resetRunLocks, withRunLock } from "../src/run-lock.js";

// A concurrency primitive with no test is a coin flip. These pin the four
// properties the comment in run-lock.ts claims, because each of them is the
// kind of thing that looks fine until two calls happen to overlap.

afterEach(() => resetRunLocks());

const defer = () => {
  let resolve!: (v?: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res as typeof resolve;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("withRunLock", () => {
  it("serialises work on the same key", async () => {
    // The whole point: two callers must not interleave read-modify-write.
    const order: string[] = [];
    const a = defer();
    const first = withRunLock("run", async () => {
      order.push("a:start");
      await a.promise;
      order.push("a:end");
    });
    const second = withRunLock("run", async () => {
      order.push("b:start");
    });

    await Promise.resolve();
    expect(order).toEqual(["a:start"]); // b has not started

    a.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("keeps different keys fully parallel", async () => {
    const order: string[] = [];
    const a = defer();
    const slow = withRunLock("one", async () => {
      await a.promise;
      order.push("one");
    });
    await withRunLock("two", async () => {
      order.push("two");
    });

    expect(order).toEqual(["two"]); // "two" did not wait for "one"
    a.resolve();
    await slow;
    expect(order).toEqual(["two", "one"]);
  });

  it("does not let a failed holder poison the queue behind it", async () => {
    // A thrown tool call must not wedge every later call for the same key —
    // the failure belongs to its caller and nobody else.
    const boom = withRunLock("run", async () => {
      throw new Error("boom");
    });
    await expect(boom).rejects.toThrow("boom");

    await expect(withRunLock("run", async () => "fine")).resolves.toBe("fine");
  });

  it("propagates the result and the error to the right caller", async () => {
    await expect(withRunLock("k", async () => 42)).resolves.toBe(42);
    await expect(withRunLock("k", async () => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
  });

  it("forgets a key once its queue drains", async () => {
    // A long-lived server must not accumulate one settled promise per key it
    // ever touched. Observed indirectly: after draining, a fresh call starts
    // immediately rather than chaining off a retained tail.
    await withRunLock("gone", async () => "x");
    const order: string[] = [];
    const p = withRunLock("gone", async () => void order.push("ran"));
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["ran"]);
    await p;
  });

  it("keeps ordering across a long queue", async () => {
    const seen: number[] = [];
    const all = Array.from({ length: 8 }, (_, i) =>
      withRunLock("q", async () => {
        await new Promise((r) => setTimeout(r, 8 - i)); // later items sleep less
        seen.push(i);
      }),
    );
    await Promise.all(all);
    // Despite the descending sleeps, the lock forces submission order.
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
