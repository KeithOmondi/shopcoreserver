import CircuitBreaker from 'opossum';
import type { Logger } from 'pino';
import { breakerState } from './metrics.js';

/**
 * Circuit breaker factory around a dependency call. When a dependency fails
 * repeatedly the breaker opens and calls fail fast instead of piling up
 * in-flight requests, timeouts and connection-pool exhaustion (the classic
 * cascading-failure path). After resetTimeout one trial call is let through.
 */
export interface BreakerOptions {
  name: string;
  timeoutMs: number;
  errorThresholdPercentage?: number;
  resetTimeoutMs?: number;
  volumeThreshold?: number;
  /** Errors for which this returns true do not count as dependency failures (e.g. business errors). */
  isNonFailure?: (err: unknown) => boolean;
}

export function createBreaker<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: BreakerOptions,
  log: Logger,
): CircuitBreaker<A, R> {
  const breaker = new CircuitBreaker(fn, {
    name: opts.name,
    timeout: opts.timeoutMs,
    errorThresholdPercentage: opts.errorThresholdPercentage ?? 50,
    resetTimeout: opts.resetTimeoutMs ?? 5000,
    volumeThreshold: opts.volumeThreshold ?? 20,
    rollingCountTimeout: 10000,
    rollingCountBuckets: 10,
    errorFilter: opts.isNonFailure ? (err: unknown) => opts.isNonFailure!(err) : undefined,
  });
  breakerState.set({ name: opts.name }, 0);
  breaker.on('open', () => {
    breakerState.set({ name: opts.name }, 2);
    log.warn({ breaker: opts.name }, 'circuit breaker opened');
  });
  breaker.on('halfOpen', () => {
    breakerState.set({ name: opts.name }, 1);
    log.info({ breaker: opts.name }, 'circuit breaker half-open');
  });
  breaker.on('close', () => {
    breakerState.set({ name: opts.name }, 0);
    log.info({ breaker: opts.name }, 'circuit breaker closed');
  });
  return breaker;
}
