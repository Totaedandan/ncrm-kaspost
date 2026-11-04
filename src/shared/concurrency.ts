export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `concurrency` tasks at the same time; extra tasks wait in FIFO order. */
export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spaces out starts of operations: every call resolves at least `minIntervalMs`
 * after the previous one resolved. Used to stay polite towards external APIs.
 */
export function createRateGate(minIntervalMs: number): () => Promise<void> {
  let nextSlot = 0;
  return async () => {
    if (minIntervalMs <= 0) return;
    const now = performance.now();
    const start = Math.max(now, nextSlot);
    nextSlot = start + minIntervalMs;
    if (start > now) await sleep(start - now);
  };
}
