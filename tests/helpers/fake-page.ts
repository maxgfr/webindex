import type { CdpHandler, CdpSession } from "../../src/browser/cdp.js";

// An in-memory CdpSession: scripted commands, events pushed by the test, and a
// fake clock whose `sleep` advances `now` so waits are instant and deterministic.

export type PageHandler = (params: any) => unknown | Promise<unknown>;

export class FakePage implements CdpSession {
  readonly sessionId = "S1";
  readonly calls: { method: string; params: any }[] = [];
  private readonly handlers = new Map<string, PageHandler>();
  private readonly listeners = new Map<string, Set<CdpHandler>>();

  handle(method: string, handler: PageHandler): void {
    this.handlers.set(method, handler);
  }

  async send<T = unknown>(method: string, params?: object): Promise<T> {
    this.calls.push({ method, params });
    const h = this.handlers.get(method);
    return ((h ? await h(params) : {}) ?? {}) as T;
  }

  on(method: string, handler: CdpHandler): void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(handler);
  }

  off(method: string, handler: CdpHandler): void {
    this.listeners.get(method)?.delete(handler);
  }

  once(): Promise<any> {
    return Promise.reject(new Error("FakePage.once is not scripted"));
  }

  emit(method: string, params: unknown = {}): void {
    for (const h of [...(this.listeners.get(method) ?? [])]) h(params);
  }

  listenerCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

/** A clock for the `now`/`sleep` deps. `onSleep` runs on every tick, to schedule events along the timeline. */
export function fakeClock(onSleep?: (now: number) => void) {
  let t = 1000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      onSleep?.(t);
    },
    at: () => t,
  };
}
