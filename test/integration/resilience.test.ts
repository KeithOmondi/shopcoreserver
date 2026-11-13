import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/infra/logger.js';
import pg from 'pg';
import { createHarness, createProduct, idemKey, resetDatabase, TEST_DB, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';
import { LogPublisher, OutboxRelay } from '../../src/workers/outbox-relay.js';

const silent = createLogger({ level: 'silent', service: 'test' });

beforeAll(async () => {
  await resetDatabase();
});

describe('rate limiting', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_CAPACITY: '5', RATE_LIMIT_REFILL_PER_SEC: '0.1' });
  });
  afterAll(async () => h.close());

  it('returns 429 with Retry-After once the bucket is empty, per principal', async () => {
    const a = { authorization: `Bearer ${await h.token(uuidv7())}` };
    const b = { authorization: `Bearer ${await h.token(uuidv7())}` };
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await h.app.inject({ method: 'GET', url: '/v1/orders', headers: a })).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true);
    const limited = await h.app.inject({ method: 'GET', url: '/v1/orders', headers: a });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // A different user has their own bucket.
    expect((await h.app.inject({ method: 'GET', url: '/v1/orders', headers: b })).statusCode).toBe(200);
    // Health endpoints are never rate limited (probes must not be starved).
    for (let i = 0; i < 20; i++) expect((await h.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });
});

describe('graceful degradation when Redis is down', () => {
  let h: Harness;
  beforeAll(async () => {
    // Nothing listens on this port: every Redis call fails.
    h = await createHarness({ REDIS_URL: 'redis://127.0.0.1:6390', RATE_LIMIT_CAPACITY: '3', RATE_LIMIT_REFILL_PER_SEC: '0.1' });
  });
  afterAll(async () => h.close());

  it('still serves catalog reads from Postgres and still places orders', async () => {
    const p = await createProduct(h, { stock: 5 });
    for (let i = 0; i < 3; i++) {
      const res = await h.app.inject({ method: 'GET', url: `/v1/products/${p.id}` });
      expect(res.statusCode).toBe(200);
    }
    const token = await h.token(uuidv7());
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': idemKey() },
      payload: { items: [{ productId: p.id, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('falls back to per-process rate limiting instead of failing open or closed', async () => {
    const a = { authorization: `Bearer ${await h.token(uuidv7())}` };
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await h.app.inject({ method: 'GET', url: '/v1/orders', headers: a })).statusCode);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3).every((c) => c === 429)).toBe(true);
  });

  it('reports the dependency as down without failing readiness', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/health/deps' })).json()).toMatchObject({ redis: 'down', postgres: 'ok' });
  });
});

describe('load shedding and shutdown', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  it('sheds API traffic with 503 + Retry-After when overloaded, but keeps probes working', async () => {
    h.c.shedder.inflight = h.cfg.MAX_INFLIGHT_REQUESTS; // simulate saturation
    const res = await h.app.inject({ method: 'GET', url: '/v1/products' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect((await h.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    h.c.shedder.inflight = 0;
    expect((await h.app.inject({ method: 'GET', url: '/v1/products' })).statusCode).toBe(200);
  });

  it('fails readiness once shutdown begins', async () => {
    h.c.setShuttingDown();
    expect((await h.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
    expect((await h.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });
});

describe('database outage', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  it('returns 503 (not 500, not a hang) when the database is unreachable, and opens the breaker', async () => {
    // Simulate an outage: block new connections to the database and kill the app's existing ones.
    const admin = new pg.Pool({ connectionString: TEST_DB.replace(/\/[^/]+$/, '/postgres'), max: 1 });
    await admin.query('ALTER DATABASE shopcore_test WITH ALLOW_CONNECTIONS false');
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'shopcore_test' AND pid <> pg_backend_pid() AND application_name LIKE 'shopcore%'",
    );
    try {
      const started = Date.now();
      const codes: number[] = [];
      for (let i = 0; i < 25; i++) {
        codes.push((await h.app.inject({ method: 'GET', url: `/v1/products/${uuidv7()}` })).statusCode);
      }
      expect(codes.every((c) => c === 503)).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
      const deps = (await h.app.inject({ method: 'GET', url: '/health/deps' })).json();
      expect(deps.postgres).toBe('down');
    } finally {
      await admin.query('ALTER DATABASE shopcore_test WITH ALLOW_CONNECTIONS true');
      await admin.end();
    }
  });
});

describe('transactional outbox relay', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  it('publishes events in order, deletes them after ack, and elects a single leader', async () => {
    await h.db.query('DELETE FROM outbox');
    const p = await createProduct(h, { stock: 10 });
    const token = await h.token(uuidv7());
    for (let i = 0; i < 3; i++) {
      await h.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': idemKey() },
        payload: { items: [{ productId: p.id, quantity: 1 }] },
      });
    }
    const pub = new LogPublisher(silent);
    const cfg = { OUTBOX_BATCH_SIZE: 100, OUTBOX_POLL_INTERVAL_MS: 10 };
    const leader = new OutboxRelay(h.c.db.writer, pub, cfg, silent);
    const standby = new OutboxRelay(h.c.db.writer, new LogPublisher(silent), cfg, silent);
    expect(await leader.tryBecomeLeader()).toBe(true);
    expect(await standby.tryBecomeLeader()).toBe(false);

    expect(await leader.relayOnce()).toBe(4); // ProductCreated + 3 x OrderCreated
    expect(pub.published.map((e) => e.event_type)).toEqual(['ProductCreated', 'OrderCreated', 'OrderCreated', 'OrderCreated']);
    const ids = pub.published.map((e) => Number(e.id));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect((await h.db.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(0);

    await leader.stop();
    expect(await standby.tryBecomeLeader()).toBe(true); // failover
    await standby.stop();
  });

  it('keeps events when the broker fails (at-least-once)', async () => {
    await h.db.query('DELETE FROM outbox');
    await createProduct(h, { stock: 1 });
    const failing = { publish: async () => Promise.reject(new Error('broker down')), close: async () => undefined };
    const relay = new OutboxRelay(h.c.db.writer, failing, { OUTBOX_BATCH_SIZE: 10, OUTBOX_POLL_INTERVAL_MS: 10 }, silent);
    relay.signalStop(); // makes the internal retry give up immediately
    await expect(relay.relayOnce()).rejects.toThrow('broker down');
    expect((await h.db.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(1);
  });
});
