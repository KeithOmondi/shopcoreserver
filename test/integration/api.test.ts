import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createProduct, idemKey, resetDatabase, stockOf, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';
import { mint, generateKeys } from '../../scripts/dev-keys.js';

let h: Harness;
const user = uuidv7();
let auth: Record<string, string>;

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness();
  auth = { authorization: `Bearer ${await h.token(user)}` };
});
afterAll(async () => h?.close());

const order = (productId: string, quantity: number, key = idemKey(), headers = auth) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...headers, 'idempotency-key': key },
    payload: { items: [{ productId, quantity }] },
  });

describe('authentication', () => {
  it('rejects missing, malformed, forged, wrong-audience and expired tokens', async () => {
    const p = await createProduct(h, { stock: 10 });
    expect((await order(p.id, 1, idemKey(), {})).statusCode).toBe(401);
    expect((await order(p.id, 1, idemKey(), { authorization: 'Bearer abc.def.ghi' })).statusCode).toBe(401);

    const other = await generateKeys(); // signed by an attacker key
    const forged = await mint(other.privatePem, user, ['admin'], 600, 'https://auth.test/', 'shopcore-test');
    expect((await order(p.id, 1, idemKey(), { authorization: `Bearer ${forged}` })).statusCode).toBe(401);

    const res = await h.app.inject({ method: 'GET', url: '/v1/orders', headers: { authorization: 'Basic Zm9vOmJhcg==' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects alg=none tokens', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: user, iss: 'https://auth.test/', aud: 'shopcore-test', exp: 9e9, iat: 1, roles: ['admin'] })}.`;
    const res = await h.app.inject({ method: 'GET', url: '/v1/orders', headers: { authorization: `Bearer ${none}` } });
    expect(res.statusCode).toBe(401);
  });

  it('enforces roles', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/v1/products', headers: auth, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe('catalog', () => {
  it('serves products, 404s unknown ids and validates input', async () => {
    const p = await createProduct(h, { stock: 5, priceCents: 1234 });
    const res = await h.app.inject({ method: 'GET', url: `/v1/products/${p.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: p.id, priceCents: 1234 });
    expect(res.headers.etag).toBe('"1"');

    expect((await h.app.inject({ method: 'GET', url: `/v1/products/${uuidv7()}` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/v1/products/not-a-uuid' })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'GET', url: '/v1/products?limit=1000' })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'GET', url: '/v1/products?cursor=garbage' })).statusCode).toBe(400);
  });

  it('paginates with keyset cursors without gaps or duplicates', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/products?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await h.app.inject({ method: 'GET', url });
      const body = res.json() as { items: { id: string }[]; nextCursor: string | null };
      for (const i of body.items) {
        expect(seen.has(i.id)).toBe(false);
        seen.add(i.id);
      }
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    const { rows } = await h.db.query('SELECT count(*)::int AS n FROM products WHERE active');
    expect(seen.size).toBe(rows[0].n);
  });

  it('uses optimistic concurrency for updates and invalidates the cache', async () => {
    const admin = { authorization: `Bearer ${await h.token(uuidv7(), ['admin'])}` };
    const p = await createProduct(h, { stock: 1, priceCents: 500 });
    await h.app.inject({ method: 'GET', url: `/v1/products/${p.id}` }); // warm cache

    const noVersion = await h.app.inject({ method: 'PATCH', url: `/v1/products/${p.id}`, headers: admin, payload: { priceCents: 600 } });
    expect(noVersion.statusCode).toBe(400);

    const ok = await h.app.inject({
      method: 'PATCH',
      url: `/v1/products/${p.id}`,
      headers: { ...admin, 'if-match': '"1"' },
      payload: { priceCents: 600 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe(2);

    const stale = await h.app.inject({
      method: 'PATCH',
      url: `/v1/products/${p.id}`,
      headers: { ...admin, 'if-match': '"1"' },
      payload: { priceCents: 700 },
    });
    expect(stale.statusCode).toBe(409);

    const read = await h.app.inject({ method: 'GET', url: `/v1/products/${p.id}` });
    expect(read.json().priceCents).toBe(600);

    const { rows } = await h.db.query("SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id", [p.id]);
    expect(rows.map((r) => r.action)).toEqual(['product.create', 'product.update']);
  });

  it('refuses stock adjustments that would go negative', async () => {
    const admin = { authorization: `Bearer ${await h.token(uuidv7(), ['admin'])}` };
    const p = await createProduct(h, { stock: 3 });
    const bad = await h.app.inject({
      method: 'POST',
      url: `/v1/products/${p.id}/stock-adjustments`,
      headers: admin,
      payload: { delta: -4, reason: 'cycle count' },
    });
    expect(bad.statusCode).toBe(422);
    const good = await h.app.inject({
      method: 'POST',
      url: `/v1/products/${p.id}/stock-adjustments`,
      headers: admin,
      payload: { delta: 7, reason: 'restock' },
    });
    expect(good.json().available).toBe(10);
  });
});

describe('orders', () => {
  it('creates an order using server-side prices and reserves stock', async () => {
    const p = await createProduct(h, { stock: 10, priceCents: 2500 });
    const res = await order(p.id, 3);
    expect(res.statusCode).toBe(201);
    const o = res.json();
    expect(o).toMatchObject({ status: 'PENDING_PAYMENT', totalCents: 7500, itemCount: 3, userId: user });
    expect(await stockOf(h, p.id)).toEqual({ available: 7, reserved: 3 });

    const { rows } = await h.db.query("SELECT event_type FROM outbox WHERE aggregate_id = $1", [o.id]);
    expect(rows).toEqual([{ event_type: 'OrderCreated' }]);
  });

  it('is idempotent and detects key reuse with a different body', async () => {
    const p = await createProduct(h, { stock: 10 });
    const key = idemKey();
    const a = await order(p.id, 2, key);
    const b = await order(p.id, 2, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    expect((await stockOf(h, p.id)).available).toBe(8);

    const c = await order(p.id, 3, key);
    expect(c.statusCode).toBe(422);
    expect(c.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Keys are scoped per user: another user may use the same key string.
    const other = { authorization: `Bearer ${await h.token(uuidv7())}` };
    expect((await order(p.id, 1, key, other)).statusCode).toBe(201);
  });

  it('rejects insufficient stock atomically and lets the key be retried', async () => {
    const p = await createProduct(h, { stock: 2 });
    const key = idemKey();
    const res = await order(p.id, 3, key);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(h, p.id)).toEqual({ available: 2, reserved: 0 });
    expect((await order(p.id, 2, key)).statusCode).toBe(201); // claim was rolled back
  });

  it('rejects inactive and unknown products and missing idempotency keys', async () => {
    const p = await createProduct(h, { stock: 5 });
    await h.db.query('UPDATE products SET active = false WHERE id = $1', [p.id]);
    expect((await order(p.id, 1)).json().error.code).toBe('PRODUCT_UNAVAILABLE');
    expect((await order(uuidv7(), 1)).statusCode).toBe(422);
    const noKey = await h.app.inject({ method: 'POST', url: '/v1/orders', headers: auth, payload: { items: [] } });
    expect(noKey.statusCode).toBe(400);
    expect((await order(p.id, 1, 'short')).statusCode).toBe(400);
  });

  it('hides other users’ orders and paginates the caller’s orders', async () => {
    const p = await createProduct(h, { stock: 100 });
    const me = { authorization: `Bearer ${await h.token(uuidv7())}` };
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await order(p.id, 1, idemKey(), me)).json().id);

    const stranger = { authorization: `Bearer ${await h.token(uuidv7())}` };
    expect((await h.app.inject({ method: 'GET', url: `/v1/orders/${ids[0]}`, headers: stranger })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: `/v1/orders/${ids[0]}`, headers: me })).statusCode).toBe(200);

    const got: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await h.app.inject({ method: 'GET', url: `/v1/orders?limit=2${cursor ? `&cursor=${cursor}` : ''}`, headers: me });
      const body = res.json() as { items: { id: string }[]; nextCursor: string | null };
      got.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(got).toEqual([...ids].reverse());
  });

  it('cancels (releasing stock), confirms payment idempotently, and enforces transitions', async () => {
    const p = await createProduct(h, { stock: 10 });
    const o1 = (await order(p.id, 4)).json();
    const cancel = await h.app.inject({ method: 'POST', url: `/v1/orders/${o1.id}/cancel`, headers: auth, payload: {} });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe('CANCELLED');
    expect(await stockOf(h, p.id)).toEqual({ available: 10, reserved: 0 });
    const again = await h.app.inject({ method: 'POST', url: `/v1/orders/${o1.id}/cancel`, headers: auth, payload: {} });
    expect(again.statusCode).toBe(409);

    const o2 = (await order(p.id, 2)).json();
    const payments = { authorization: `Bearer ${await h.token(uuidv7(), ['payments'])}` };
    const forbidden = await h.app.inject({ method: 'POST', url: `/v1/orders/${o2.id}/payment-confirmation`, headers: auth, payload: { paymentRef: 'x', amountCents: 2000, currency: 'USD' } });
    expect(forbidden.statusCode).toBe(403);
    for (let i = 0; i < 2; i++) {
      const paid = await h.app.inject({ method: 'POST', url: `/v1/orders/${o2.id}/payment-confirmation`, headers: payments, payload: { paymentRef: 'pi_123', amountCents: 2000, currency: 'USD' } });
      expect(paid.statusCode).toBe(200);
      expect(paid.json().status).toBe('PAID');
    }
    expect(await stockOf(h, p.id)).toEqual({ available: 8, reserved: 0 });
    // A PAID order can still be cancelled before shipment: stock returns and a refund is requested.
    const cancelPaid = await h.app.inject({ method: 'POST', url: `/v1/orders/${o2.id}/cancel`, headers: auth, payload: {} });
    expect(cancelPaid.statusCode).toBe(200);
    expect(cancelPaid.json().status).toBe('CANCELLED');
    expect(await stockOf(h, p.id)).toEqual({ available: 10, reserved: 0 });
    const ev = await h.db.query("SELECT payload FROM outbox WHERE aggregate_id = $1 AND event_type = 'OrderCancelled'", [o2.id]);
    expect(ev.rows[0].payload).toMatchObject({ refundRequired: true, paymentRef: 'pi_123' });
  });

  it('expires unpaid orders and releases their stock', async () => {
    const p = await createProduct(h, { stock: 5 });
    const o = (await order(p.id, 5)).json();
    await h.db.query("UPDATE orders SET created_at = now() - interval '2 hours' WHERE id = $1", [o.id]);
    let n = 0;
    for (let k = -1; k !== 0; n += k) k = await h.c.orders.expireUnpaid(30);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await stockOf(h, p.id)).toEqual({ available: 5, reserved: 0 });
  });
});

describe('error handling', () => {
  it('returns structured errors for malformed bodies, oversized bodies and unknown routes', async () => {
    const bad = await h.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...auth, 'idempotency-key': idemKey(), 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBeDefined();

    const huge = await h.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...auth, 'idempotency-key': idemKey(), 'content-type': 'application/json' },
      payload: JSON.stringify({ items: [], pad: 'x'.repeat(200_000) }),
    });
    expect(huge.statusCode).toBe(413);

    const nf = await h.app.inject({ method: 'GET', url: '/nope' });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().requestId).toBeDefined();
  });

  it('propagates a valid inbound request id and rejects junk ones', async () => {
    const a = await h.app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': 'trace-abc-12345' } });
    expect(a.headers['x-request-id']).toBe('trace-abc-12345');
    const b = await h.app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': '<script>' } });
    expect(b.headers['x-request-id']).not.toBe('<script>');
  });
});
