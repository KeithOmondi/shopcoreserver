import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, retry } from '../../src/infra/retry.js';
import { isUuid, uuidv7 } from '../../src/infra/uuid.js';
import { LruTtl } from '../../src/infra/cache.js';
import { assertTransition, makeCreateOrderSchema, requestHash, TRANSITIONS } from '../../src/modules/orders/orders.js';
import { decodeCursor, encodeCursor } from '../../src/http/pagination.js';
import { loadConfig } from '../../src/config/index.js';
import { AppError } from '../../src/domain/errors.js';

describe('retry with full-jitter exponential backoff', () => {
  it('caps delay and grows exponentially', () => {
    expect(backoffDelay(0, 10, 1000, () => 0.999)).toBe(9);
    expect(backoffDelay(3, 10, 1000, () => 0.999)).toBe(79);
    expect(backoffDelay(20, 10, 1000, () => 0.999)).toBe(999);
    expect(backoffDelay(5, 10, 1000, () => 0)).toBe(0);
  });

  it('retries only retryable errors, up to the limit', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('a')).mockRejectedValueOnce(new Error('b')).mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(retry(fn, { retries: 3, baseDelayMs: 1, maxDelayMs: 10, shouldRetry: () => true, sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);

    const fatal = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(retry(fatal, { retries: 5, baseDelayMs: 1, maxDelayMs: 10, shouldRetry: () => false, sleep })).rejects.toThrow('fatal');
    expect(fatal).toHaveBeenCalledTimes(1);

    const always = vi.fn().mockRejectedValue(new Error('x'));
    await expect(retry(always, { retries: 2, baseDelayMs: 1, maxDelayMs: 10, shouldRetry: () => true, sleep })).rejects.toThrow('x');
    expect(always).toHaveBeenCalledTimes(3);
  });
});

describe('uuidv7', () => {
  it('is a valid, version-7, strictly increasing id', () => {
    const ids = Array.from({ length: 10_000 }, () => uuidv7());
    for (const id of ids) {
      expect(isUuid(id)).toBe(true);
      expect(id[14]).toBe('7');
    }
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const t = Date.UTC(2030, 0, 1);
    const id = uuidv7(t);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBeGreaterThanOrEqual(t);
  });
});

describe('LruTtl', () => {
  it('evicts least-recently-used and expires by ttl', () => {
    let now = 0;
    const c = new LruTtl<number>(2, 100, () => now);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // a is now most recent
    c.set('c', 3); // evicts b
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    now = 101;
    expect(c.get('a')).toBeUndefined();
  });
  it('is a no-op when disabled', () => {
    const c = new LruTtl<number>(0, 100);
    c.set('a', 1);
    expect(c.get('a')).toBeUndefined();
  });
});

describe('order domain', () => {
  const schema = makeCreateOrderSchema({ ORDER_MAX_LINES: 3, ORDER_MAX_QTY_PER_LINE: 5 });
  const p1 = '01a1cdbf-3b3e-7508-a74a-d7e636a4e0e1';
  const p2 = '01a1cdbf-3b3e-7508-a74a-d7e636a4e0e2';

  it('request hash is order-independent but quantity-sensitive', () => {
    const a = requestHash({ items: [{ productId: p1, quantity: 1 }, { productId: p2, quantity: 2 }] });
    const b = requestHash({ items: [{ productId: p2, quantity: 2 }, { productId: p1, quantity: 1 }] });
    const c = requestHash({ items: [{ productId: p1, quantity: 2 }, { productId: p2, quantity: 2 }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('validates order input', () => {
    expect(schema.safeParse({ items: [{ productId: p1, quantity: 1 }] }).success).toBe(true);
    expect(schema.safeParse({ items: [] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ productId: p1, quantity: 6 }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ productId: p1, quantity: 0 }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ productId: p1, quantity: 1.5 }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ productId: 'nope', quantity: 1 }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ productId: p1, quantity: 1 }, { productId: p1, quantity: 1 }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ productId: p1, quantity: 1, priceCents: 1 }] }).success).toBe(false); // no client prices
  });

  it('enforces the state machine', () => {
    expect(() => assertTransition('PENDING_PAYMENT', 'PAID')).not.toThrow();
    expect(() => assertTransition('PENDING_PAYMENT', 'CANCELLED')).not.toThrow();
    expect(() => assertTransition('PAID', 'CANCELLED')).not.toThrow();
    expect(() => assertTransition('PAID', 'PENDING_PAYMENT')).toThrow(AppError);
    expect(() => assertTransition('FULFILLED', 'CANCELLED')).toThrow(AppError);
    expect(() => assertTransition('CANCELLED', 'PAID')).toThrow(AppError);
    expect(TRANSITIONS.FULFILLED).toHaveLength(0);
    expect(TRANSITIONS.PAID).toEqual(['FULFILLED', 'CANCELLED']);
  });
});

describe('cursor pagination', () => {
  it('round-trips and rejects tampering', () => {
    const c = encodeCursor(['2026-01-01T00:00:00.000Z', 'abc']);
    expect(decodeCursor(c, 2)).toEqual(['2026-01-01T00:00:00.000Z', 'abc']);
    expect(() => decodeCursor(c, 1)).toThrow(AppError);
    expect(() => decodeCursor('!!!', 2)).toThrow(AppError);
    expect(() => decodeCursor(Buffer.from('{"a":1}').toString('base64url'), 1)).toThrow(AppError);
  });
});

describe('config', () => {
  const base = {
    DATABASE_URL: 'postgres://u@h:5432/d',
    REDIS_URL: 'redis://h:6379',
    JWT_ISSUER: 'i',
    JWT_AUDIENCE: 'a',
    JWT_PUBLIC_KEY: 'k',
  };
  it('parses defaults', () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(8080);
    expect(c.RATE_LIMIT_ENABLED).toBe(true);
    expect(c.DB_SSL).toBe(false);
  });
  it('fails fast on invalid config', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, JWT_PUBLIC_KEY: undefined })).toThrow(/JWT_JWKS_URL/);
    expect(() => loadConfig({ ...base, JWT_ISSUER: undefined })).toThrow(/JWT_ISSUER/);
    // The worker never verifies tokens, so it does not need JWT settings.
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL, REDIS_URL: base.REDIS_URL }, 'worker')).not.toThrow();
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/DB_SSL/);
    expect(() => loadConfig({ ...base, DB_SSL: 'yes' })).toThrow(/DB_SSL/);
  });
});

describe('LoadShedder (AIMD, priority-aware)', () => {
  it('ramps shedding up while overloaded, decays when healthy, and never sheds critical work probabilistically', async () => {
    const { LoadShedder } = await import('../../src/http/load-shedding.js');
    const s = new LoadShedder(100, 0.95, 10, () => 0.5);
    try {
      expect(s.shouldShed('normal')).toBe(false);
      for (let i = 0; i < 4; i++) s.sample(500, 0.5); // 4 overloaded samples -> p = 0.60
      expect(s.shedProbability).toBeCloseTo(0.6, 5);
      expect(s.shouldShed('normal')).toBe(true); // random 0.5 < 0.6
      expect(s.shouldShed('critical')).toBe(false); // checkout protected
      for (let i = 0; i < 3; i++) s.sample(1, 0.1); // healthy -> p = 0.45
      expect(s.shouldShed('normal')).toBe(false);
      for (let i = 0; i < 20; i++) s.sample(1, 0.1);
      expect(s.shedProbability).toBe(0);
      for (let i = 0; i < 20; i++) s.sample(1, 0.99); // ELU signal alone also counts
      expect(s.shedProbability).toBeCloseTo(0.95, 5); // capped: never reject 100%
      s.inflight = 10;
      expect(s.shouldShed('critical')).toBe(true); // hard cap applies to everything
    } finally {
      s.stop();
    }
  });
});

describe('hardening helpers', () => {
  it('parses TRUST_PROXY into hop counts, CIDR lists and booleans', async () => {
    const { parseTrustProxy } = await import('../../src/config/index.js');
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12')).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
  });

  it('refuses TRUST_PROXY=true and plain-text DB in production', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@db/x',
      REDIS_URL: 'redis://r',
      JWT_ISSUER: 'i',
      JWT_AUDIENCE: 'a',
      JWT_JWKS_URL: 'https://idp/jwks',
      DB_SSL: 'true',
    };
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: '1' })).not.toThrow();
    expect(loadConfig({ ...base }).TRUST_PROXY).toBe('false'); // safe default
  });

  it('throttles failed authentication per key and recovers over time', async () => {
    const { FailureThrottle } = await import('../../src/http/rate-limiter.js');
    let t = 0;
    const th = new FailureThrottle(3, 1, () => t);
    expect(th.blocked('ip')).toBe(0);
    th.fail('ip'); th.fail('ip'); th.fail('ip');
    expect(th.blocked('ip')).toBeGreaterThan(0);
    expect(th.blocked('other')).toBe(0); // isolated per key
    t += 2000;
    expect(th.blocked('ip')).toBe(0); // 2 tokens refilled
  });

  it('extracts the UUIDv7 timestamp and derives stable UUIDs from names', async () => {
    const { uuidv7Timestamp, uuidFromName } = await import('../../src/infra/uuid.js');
    expect(uuidv7Timestamp('01a1cefc-8f5d-7554-a84d-0f12eb4af8da')).toBe(1794474020701);
    expect(uuidv7Timestamp(uuidv7())).toBeGreaterThan(1_700_000_000_000);
    expect(uuidv7Timestamp('11111111-1111-4111-8111-111111111111')).toBeNull(); // v4
    expect(uuidv7Timestamp('not-a-uuid')).toBeNull();
    const a = uuidFromName('iss', 'auth0|abc');
    expect(isUuid(a)).toBe(true);
    expect(a).toBe(uuidFromName('iss', 'auth0|abc'));
    expect(a).not.toBe(uuidFromName('iss', 'auth0|abd'));
    expect(a).not.toBe(uuidFromName('other', 'auth0|abc'));
  });
});
