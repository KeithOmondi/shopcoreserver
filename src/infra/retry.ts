/**
 * Retry with capped exponential backoff and full jitter (AWS Architecture Blog,
 * "Exponential Backoff and Jitter"). Full jitter spreads retries so that a
 * transient failure does not turn into synchronized retry storms.
 */
export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function backoffDelay(attempt: number, base: number, max: number, random = Math.random): number {
  const ceiling = Math.min(max, base * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const doSleep = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || !opts.shouldRetry(err, attempt)) throw err;
      const delay = backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, opts.random);
      opts.onRetry?.(err, attempt + 1, delay);
      await doSleep(delay);
    }
  }
}
