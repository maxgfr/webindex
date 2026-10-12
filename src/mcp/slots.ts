// How many tool calls one server runs at once, over either transport. Above
// this, the engine's own per-source concurrency and its subprocesses stop
// paying for themselves — and over HTTP, without it, twenty POSTs were twenty
// fetches, crawls or transcriptions at once.
export const MAX_IN_FLIGHT = 4;

export interface ToolSlots {
  /**
   * Wait for a free slot. Resolves to the function that gives it back, or to
   * undefined when `signal` aborts first: a caller that left while queued
   * takes no slot, and the one it was waiting for goes to the next in line.
   */
  acquire(signal?: AbortSignal): Promise<(() => void) | undefined>;
}

export function toolSlots(max: number = MAX_IN_FLIGHT): ToolSlots {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    acquire(signal) {
      return new Promise((resolve) => {
        const take = () => {
          active++;
          let given = false;
          resolve(() => {
            if (given) return;
            given = true;
            active--;
            waiting.shift()?.();
          });
        };
        if (active < max) return take();
        if (signal?.aborted) return resolve(undefined);
        const leave = () => {
          const at = waiting.indexOf(wake);
          if (at >= 0) waiting.splice(at, 1);
          resolve(undefined);
        };
        const wake = () => {
          signal?.removeEventListener("abort", leave);
          take();
        };
        waiting.push(wake);
        signal?.addEventListener("abort", leave, { once: true });
      });
    },
  };
}
