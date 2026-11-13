import type { Logger } from 'pino';
import type CircuitBreaker from 'opossum';
import type { RedisClient } from '../infra/redis.js';
import { createBreaker } from '../infra/circuit-breaker.js';
import { LruTtl } from '../infra/cache.js';

export interface BucketSpec {
  name: string;
  capacity: number;
  refillPerSec: number;
}

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Distributed token bucket, evaluated atomically inside Redis with a Lua script so
 * that limits hold across all pods. Uses Redis server time (no clock skew between pods).
 * Keys expire once the bucket would be full again, so idle principals cost no memory.
 */
const LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * rate / 1000)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil((capacity - tokens) / rate * 1000) + 1000)
local retry = 0
if allowed == 0 then retry = math.ceil((1 - tokens) / rate) end
return { allowed, math.floor(tokens), retry }
`;

/**
 * Fallback when Redis is unavailable: a per-process bucket. Limits become
 * per-pod rather than global (looser by a factor of the pod count) which is the
 * deliberate trade-off: degrade protection a little, never fail closed and take
 * the API down because the limiter's backing store is down.
 */
class LocalBuckets {
  private readonly buckets = new LruTtl<{ tokens: number; ts: number }>(100_000, 60_000);
  take(key: string, spec: BucketSpec): LimitResult {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: spec.capacity, ts: now };
    b.tokens = Math.min(spec.capacity, b.tokens + ((now - b.ts) * spec.refillPerSec) / 1000);
    b.ts = now;
    let allowed = false;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      allowed = true;
    }
    this.buckets.set(key, b);
    return {
      allowed,
      remaining: Math.floor(b.tokens),
      retryAfterSec: allowed ? 0 : Math.ceil((1 - b.tokens) / spec.refillPerSec),
    };
  }
}

export class RateLimiter {
  private readonly local = new LocalBuckets();
  private readonly breaker: CircuitBreaker<[string, BucketSpec], LimitResult>;

  constructor(redis: RedisClient, log: Logger) {
    redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: LUA });
    const run = async (key: string, spec: BucketSpec): Promise<LimitResult> => {
      const [allowed, remaining, retry] = (await (
        redis as unknown as { tokenBucket: (...a: unknown[]) => Promise<number[]> }
      ).tokenBucket(key, spec.capacity, spec.refillPerSec)) as [number, number, number];
      return { allowed: allowed === 1, remaining, retryAfterSec: retry };
    };
    this.breaker = createBreaker(run, { name: 'redis-ratelimit', timeoutMs: 200 }, log);
    this.breaker.fallback((key: string, spec: BucketSpec) => this.local.take(key, spec));
  }

  async take(principalKey: string, spec: BucketSpec): Promise<LimitResult> {
    // Hash tag {..} keeps a principal's buckets on one cluster slot.
    return this.breaker.fire(`rl:{${principalKey}}:${spec.name}`, spec);
  }

  shutdown() {
    this.breaker.shutdown();
  }
}

/**
 * Per-process throttle on *failed* authentication, keyed by client IP. It costs one Map lookup
 * for well-behaved clients and nothing in Redis. `blocked()` is checked before any token
 * verification, so a flood of garbage tokens cannot be used to burn CPU on signature checks;
 * `fail()` is called after a verification failure.
 */
export class FailureThrottle {
  private readonly buckets: LruTtl<{ tokens: number; ts: number }>;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.buckets = new LruTtl(100_000, Math.ceil(capacity / refillPerSec) * 1000 + 1000, now);
  }
  private refreshed(key: string) {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, ts: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.ts) * this.refillPerSec) / 1000);
    b.ts = t;
    return b;
  }
  /** Seconds the caller should wait, or 0 if the key may attempt authentication. */
  blocked(key: string): number {
    const b = this.refreshed(key);
    return b.tokens >= 1 ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerSec));
  }
  fail(key: string): void {
    const b = this.refreshed(key);
    b.tokens = Math.max(0, b.tokens - 1);
    this.buckets.set(key, b);
  }
}
