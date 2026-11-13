import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createHarness, createProduct, idemKey, resetDatabase, stockOf, TEST_DB, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';
import { createLogger } from '../../src/infra/logger.js';
import { LogPublisher, OutboxRelay, type Publisher } from '../../src/workers/outbox-relay.js';

const silent = createLogger({ level: 'silent', service: 'test' });

beforeAll(async () => {
  await resetDatabase();
});

describe('payments, fulfilment and refunds', () => {
  let h: Harness;
  let customer: string;
  let auth: Record<string, string>;
  let payments: Record<string, string>;
  let admin: Record<string, string>;

  beforeAll(async () => {
    h = await createHarness();
    customer = uuidv7();
    auth = { authorization: `Bearer ${await h.token(customer)}` };
    payments = { authorization: `Bearer ${await h.token(uuidv7(), ['payments'])}` };
    admin = { authorization: `Bearer ${await h.token(uuidv7(), ['admin'])}` };
  });
  afterAll(async () => h.close());

  const place = async (productId: string, quantity: number) =>
    (
      await h.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: { ...auth, 'idempotency-key': idemKey() },
        payload: { items: [{ productId, quantity }] },
      })
    ).json();
  const pay = (orderId: string, body: object) =>
    h.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/payment-confirmation`, headers: payments, payload: body });
  const outboxOf = async (orderId: string, type: string) =>
    (await h.db.query('SELECT payload FROM outbox WHERE aggregate_id = $1 AND event_type = $2', [orderId, type])).rows;

  it('rejects a charge that does not match the order total, without changing the order or stock', async () => {
    const p = await createProduct(h, { stock: 5, priceCents: 500 });
    const o = await place(p.id, 2); // 1000 USD cents
    const wrongAmount = await pay(o.id, { paymentRef: 'pi_a', amountCents: 999, currency: 'USD' });
    expect(wrongAmount.statusCode).toBe(422);
    expect(wrongAmount.json().error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
    expect((await pay(o.id, { paymentRef: 'pi_a', amountCents: 1000, currency: 'EUR' })).statusCode).toBe(422);
    expect((await pay(o.id, { paymentRef: 'pi_a', currency: 'USD' })).statusCode).toBe(400); // amount is required
    expect(await stockOf(h, p.id)).toEqual({ available: 3, reserved: 2 });
    expect((await pay(o.id, { paymentRef: 'pi_a', amountCents: 1000, currency: 'USD' })).statusCode).toBe(200);
  });

  it('is idempotent per paymentRef, rejects a different ref, and a ref can pay only one order', async () => {
    const p = await createProduct(h, { stock: 5, priceCents: 100 });
    const a = await place(p.id, 1);
    const b = await place(p.id, 1);
    const body = (ref: string) => ({ paymentRef: ref, amountCents: 100, currency: 'USD' });
    expect((await pay(a.id, body('pi_once'))).statusCode).toBe(200);
    expect((await pay(a.id, body('pi_once'))).statusCode).toBe(200); // redelivery
    const other = await pay(a.id, body('pi_other'));
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('ORDER_ALREADY_PAID');
    const reuse = await pay(b.id, body('pi_once'));
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.code).toBe('PAYMENT_REF_REUSED');
    expect(await outboxOf(a.id, 'OrderPaid')).toHaveLength(1);
  });

  it('records a payment that arrives after the order was cancelled so it can be refunded (once)', async () => {
    const p = await createProduct(h, { stock: 3, priceCents: 100 });
    const o = await place(p.id, 1);
    await h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/cancel`, headers: auth, payload: {} });
    const body = { paymentRef: 'pi_late', amountCents: 100, currency: 'USD' };
    for (let i = 0; i < 2; i++) {
      const late = await pay(o.id, body);
      expect(late.statusCode).toBe(409);
      expect(late.json().error.code).toBe('ORDER_CANCELLED');
    }
    const events = await outboxOf(o.id, 'OrderPaymentOrphaned');
    expect(events).toHaveLength(1); // not duplicated by the retry
    expect(events[0].payload).toMatchObject({ paymentRef: 'pi_late', amountCents: 100 });
    expect(await stockOf(h, p.id)).toEqual({ available: 3, reserved: 0 });
  });

  it('fulfils only PAID orders, admin only, and blocks cancelling after shipment', async () => {
    const p = await createProduct(h, { stock: 3, priceCents: 100 });
    const o = await place(p.id, 1);
    const fulfil = (headers: Record<string, string>) =>
      h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/fulfillment`, headers });
    expect((await fulfil(auth)).statusCode).toBe(403);
    expect((await fulfil(admin)).statusCode).toBe(409); // not paid yet
    await pay(o.id, { paymentRef: 'pi_ship', amountCents: 100, currency: 'USD' });
    const done = await fulfil(admin);
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('FULFILLED');
    expect(await outboxOf(o.id, 'OrderFulfilled')).toHaveLength(1);
    const cancel = await h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/cancel`, headers: auth, payload: {} });
    expect(cancel.statusCode).toBe(409);
    expect(await stockOf(h, p.id)).toEqual({ available: 2, reserved: 0 });
  });

  it('expires unpaid orders one transaction each, skips paid ones, and writes an audit entry', async () => {
    const p = await createProduct(h, { stock: 10, priceCents: 100 });
    const stale = [await place(p.id, 2), await place(p.id, 3)];
    const paid = await place(p.id, 1);
    await pay(paid.id, { paymentRef: 'pi_keep', amountCents: 100, currency: 'USD' });
    await h.db.query("UPDATE orders SET created_at = now() - interval '3 hours' WHERE id = ANY($1::uuid[])", [
      [...stale.map((o) => o.id), paid.id],
    ]);
    expect(await h.c.orders.expireUnpaid(30)).toBe(2);
    expect(await h.c.orders.expireUnpaid(30)).toBe(0);
    expect(await stockOf(h, p.id)).toEqual({ available: 9, reserved: 0 }); // only the paid unit stays sold
    const status = await h.db.query('SELECT id, status FROM orders WHERE id = ANY($1::uuid[])', [[...stale, paid].map((o) => o.id)]);
    expect(Object.fromEntries(status.rows.map((r) => [r.id, r.status]))).toEqual({
      [stale[0].id]: 'CANCELLED',
      [stale[1].id]: 'CANCELLED',
      [paid.id]: 'PAID',
    });
    const audit = await h.db.query("SELECT actor_id FROM audit_log WHERE action = 'order.expire' AND entity_id = $1", [stale[0].id]);
    expect(audit.rows[0].actor_id).toBe('system:expiry');
  });

  it('serves 304 for a matching If-None-Match and flushes cached list pages on write', async () => {
    const p = await createProduct(h, { stock: 1 });
    const first = await h.app.inject({ method: 'GET', url: `/v1/products/${p.id}` });
    const etag = String(first.headers.etag);
    const cond = await h.app.inject({ method: 'GET', url: `/v1/products/${p.id}`, headers: { 'if-none-match': etag } });
    expect(cond.statusCode).toBe(304);
    expect(cond.body).toBe('');

    const idsOf = async () => (await h.app.inject({ method: 'GET', url: '/v1/products?limit=100' })).json().items.map((i: { id: string }) => i.id);
    expect(await idsOf()).toContain(p.id); // populates the list cache
    const q = await createProduct(h, { stock: 1 });
    expect(await idsOf()).toContain(q.id); // visible immediately, not after the cache TTL
    await h.app.inject({
      method: 'PATCH',
      url: `/v1/products/${q.id}`,
      headers: { ...admin, 'if-match': `"${q.version}"` },
      payload: { active: false },
    });
    expect(await idsOf()).not.toContain(q.id);
  });
});

describe('failed-authentication throttle', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ AUTH_FAIL_CAPACITY: '3', AUTH_FAIL_REFILL_PER_SEC: '0.01' });
  });
  afterAll(async () => h.close());

  it('stops verifying tokens from an IP that keeps failing, even with spoofed X-Forwarded-For', async () => {
    const bad = (xff: string) =>
      h.app.inject({
        method: 'GET',
        url: '/v1/orders',
        headers: { authorization: 'Bearer a.b.c', 'x-forwarded-for': xff },
      });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await bad(`203.0.113.${i}`)).statusCode); // rotating spoofed IPs
    expect(codes).toEqual([401, 401, 401, 429, 429, 429]);
    const blocked = await bad('198.51.100.9');
    expect(blocked.headers['retry-after']).toBeDefined();
    // A valid token from the throttled IP is also refused until the budget refills (verification is skipped).
    const good = await h.app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${await h.token(uuidv7())}` },
    });
    expect(good.statusCode).toBe(429);
    // Anonymous traffic is unaffected.
    expect((await h.app.inject({ method: 'GET', url: '/v1/products' })).statusCode).toBe(200);
  });
});

describe('identity provider compatibility', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ JWT_ROLES_CLAIM: 'cognito:groups', JWT_SUB_MODE: 'hash' });
  });
  afterAll(async () => h.close());

  it('reads roles from a configurable claim and maps non-UUID subjects to stable UUIDs', async () => {
    const adminTok = await h.tokenWithClaim('auth0|507f1f77bcf86cd799439011', ['admin'], 'cognito:groups');
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: { authorization: `Bearer ${adminTok}` },
      payload: { sku: `IDP-${Date.now()}`, name: 'x', priceCents: 1, currency: 'USD', initialStock: 1 },
    });
    expect(created.statusCode).toBe(201);
    // Roles under the default claim name are ignored (the token is then a plain customer).
    const wrongClaim = await h.tokenWithClaim('auth0|someone-else', ['admin'], 'roles');
    const denied = await h.app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: { authorization: `Bearer ${wrongClaim}` },
      payload: { sku: `IDP2-${Date.now()}`, name: 'x', priceCents: 1, currency: 'USD', initialStock: 1 },
    });
    expect(denied.statusCode).toBe(403);
    // The same subject always maps to the same internal user: its orders are visible to it again.
    const mine = await h.app.inject({ method: 'GET', url: '/v1/orders', headers: { authorization: `Bearer ${adminTok}` } });
    expect(mine.statusCode).toBe(200);
  });
});

describe('dependency health endpoint', () => {
  it('requires the shared secret when one is configured', async () => {
    const h = await createHarness({ HEALTH_DEPS_TOKEN: 'a-sufficiently-long-secret' });
    try {
      expect((await h.app.inject({ method: 'GET', url: '/health/deps' })).statusCode).toBe(404);
      expect((await h.app.inject({ method: 'GET', url: '/health/deps', headers: { 'x-health-token': 'nope' } })).statusCode).toBe(404);
      const ok = await h.app.inject({ method: 'GET', url: '/health/deps', headers: { 'x-health-token': 'a-sufficiently-long-secret' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ postgres: 'ok' });
    } finally {
      await h.close();
    }
  });
});

describe('audit log is append-only', () => {
  it('rejects UPDATE, DELETE and TRUNCATE even for the owner', async () => {
    const c = new pg.Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await c.query("INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES ('t','t','t','t')");
      await expect(c.query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
      await expect(c.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
      await expect(c.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
    } finally {
      await c.end();
    }
  });
});

describe('outbox relay does not hold a transaction while publishing', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  it('publishes with no idle-in-transaction session and deletes only afterwards', async () => {
    await h.db.query('DELETE FROM outbox');
    await createProduct(h, { stock: 1 });
    let idleInTx = -1;
    let rowsDuringPublish = -1;
    const probing: Publisher = {
      publish: async () => {
        idleInTx = (
          await h.db.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND application_name LIKE 'shopcore%'",
          )
        ).rows[0].n;
        rowsDuringPublish = (await h.db.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n;
      },
      close: async () => undefined,
    };
    const relay = new OutboxRelay(h.c.db.writer, probing, { OUTBOX_BATCH_SIZE: 10, OUTBOX_POLL_INTERVAL_MS: 10 }, silent);
    expect(await relay.relayOnce()).toBe(1);
    expect(idleInTx).toBe(0);
    expect(rowsDuringPublish).toBe(1); // still there until acknowledged
    expect((await h.db.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(0);
  });

  it('notices a dead leadership session, does not leak connections, and re-elects', async () => {
    const relay = new OutboxRelay(h.c.db.writer, new LogPublisher(silent), { OUTBOX_BATCH_SIZE: 10, OUTBOX_POLL_INTERVAL_MS: 10 }, silent);
    expect(await relay.tryBecomeLeader()).toBe(true);
    const before = h.c.db.writer.totalCount;
    await h.db.query(
      "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = 727274002 AND granted",
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(await relay.tryBecomeLeader()).toBe(true); // heartbeat failed -> dropped -> re-acquired on a fresh session
    expect(h.c.db.writer.totalCount).toBeLessThanOrEqual(before + 1);
    await relay.stop();
    expect(h.c.db.writer.waitingCount).toBe(0);
  });
});
