import type { Logger } from 'pino';
import type CircuitBreaker from 'opossum';
import type { RedisClient } from './redis.js';
import { cacheEvents } from './metrics.js';
import { createBreaker } from './circuit-breaker.js';

/** Bounded LRU with per-entry expiry. Map iteration order gives O(1) LRU eviction. */
export class LruTtl<V> {
  private readonly map = new Map<string, { v: V; exp: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp <= this.now()) {
      this.map.delete(k);
      return undefined;
    }
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }
  set(k: string, v: V): void {
    if (this.max === 0 || this.ttlMs === 0) return;
    this.map.delete(k);
    this.map.set(k, { v, exp: this.now() + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }
  delete(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

/**
 * Two-tier read-through cache:
 *   L1: in-process LRU with a very short TTL (absorbs hot keys; bounds staleness to ~1s)
 *   L2: Redis with TTL + jitter (shared across pods; jitter avoids synchronized expiry)
 * Concurrent misses for the same key are coalesced into a single loader call
 * ("single-flight"), which prevents cache stampedes on hot keys after expiry.
 * Redis access is wrapped in a breaker: if Redis is down we skip it entirely and
 * go to the loader, rather than paying a timeout on every request.
 * Negative results (null) are cached briefly to blunt enumeration of missing ids.
 */
const NULL_SENTINEL = '__null__';

export class ReadThroughCache<V> {
  private readonly l1: LruTtl<V | null>;
  private readonly inflight = new Map<string, Promise<V | null>>();
  private readonly getBreaker: CircuitBreaker<[string], string | null>;

  constructor(
    private readonly name: string,
    private readonly redis: RedisClient,
    private readonly opts: {
      ttlSec: number;
      negativeTtlSec: number;
      l1TtlMs: number;
      l1Max: number;
      /** Keys carry a generation number so flush() invalidates every entry (e.g. list pages). */
      generational?: boolean;
    },
    private readonly log: Logger,
  ) {
    this.l1 = new LruTtl(opts.l1Max, opts.l1TtlMs);
    this.getBreaker = createBreaker((k: string) => this.redis.get(k), { name: `redis-${name}`, timeoutMs: 300 }, log);
  }

  private gen = '0';
  private genCheckedAt = 0;

  private key(id: string) {
    return this.opts.generational ? `c:${this.name}:g${this.gen}:${id}` : `c:${this.name}:${id}`;
  }

  /** Refresh the shared generation at most about once per L1 TTL (min 1s), so other pods notice a flush quickly. */
  private async refreshGeneration(): Promise<void> {
    if (!this.opts.generational) return;
    const now = Date.now();
    if (now - this.genCheckedAt < Math.max(1000, this.opts.l1TtlMs)) return;
    this.genCheckedAt = now;
    try {
      const g = await this.redis.get(`c:${this.name}:gen`);
      if (g !== null && g !== this.gen) {
        this.gen = g;
        this.l1.clear();
      }
    } catch {
      /* Redis unavailable: keep the current generation; entries still expire by TTL */
    }
  }

  /** Invalidate every entry of a generational cache (all list pages) on all pods. */
  async flush(): Promise<void> {
    this.l1.clear();
    this.inflight.clear();
    if (!this.opts.generational) return;
    try {
      this.gen = String(await this.redis.incr(`c:${this.name}:gen`));
      this.genCheckedAt = Date.now();
    } catch (err) {
      this.log.warn({ err, cache: this.name }, 'cache flush failed; entries will expire by TTL');
    }
  }

  async get(id: string, loader: () => Promise<V | null>): Promise<V | null> {
    const l1 = this.l1.get(id);
    if (l1 !== undefined) {
      cacheEvents.inc({ cache: this.name, tier: 'l1', result: 'hit' });
      return l1;
    }
    const pending = this.inflight.get(id);
    if (pending) {
      cacheEvents.inc({ cache: this.name, tier: 'l1', result: 'coalesced' });
      return pending;
    }
    const p = this.load(id, loader).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async load(id: string, loader: () => Promise<V | null>): Promise<V | null> {
    await this.refreshGeneration();
    const k = this.key(id);
    try {
      const raw = await this.getBreaker.fire(k);
      if (raw !== null) {
        cacheEvents.inc({ cache: this.name, tier: 'l2', result: 'hit' });
        const v = raw === NULL_SENTINEL ? null : (JSON.parse(raw) as V);
        this.l1.set(id, v);
        return v;
      }
      cacheEvents.inc({ cache: this.name, tier: 'l2', result: 'miss' });
    } catch {
      cacheEvents.inc({ cache: this.name, tier: 'l2', result: 'error' });
    }

    const v = await loader();
    this.l1.set(id, v);
    const ttl =
      v === null ? this.opts.negativeTtlSec : this.opts.ttlSec + Math.floor(Math.random() * this.opts.ttlSec * 0.1);
    // Fire-and-forget write: never block the response on cache population.
    if (!this.getBreaker.opened) {
      this.redis.set(k, v === null ? NULL_SENTINEL : JSON.stringify(v), 'EX', ttl).catch(() => {
        cacheEvents.inc({ cache: this.name, tier: 'l2', result: 'set_error' });
      });
    }
    return v;
  }

  /** Invalidate on write. L1 entries on other pods expire within l1TtlMs. */
  async invalidate(id: string): Promise<void> {
    this.l1.delete(id);
    try {
      await this.redis.del(this.key(id));
    } catch (err) {
      this.log.warn({ err, cache: this.name, id }, 'cache invalidation failed; entry will expire by TTL');
    }
  }

  shutdown() {
    this.getBreaker.shutdown();
  }
}
