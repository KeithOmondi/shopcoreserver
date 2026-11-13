import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createProduct, idemKey, resetDatabase, stockOf, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';

/**
 * Concurrency correctness under contention. These are the invariants that matter
 * most at 40k RPS: no overselling, no duplicate orders from retried requests,
 * no deadlocks between multi-line orders.
 */
let h: Harness;
beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ DB_POOL_MAX: '40' });
});
afterAll(async () => h?.close());

async function placeOrder(token: string, items: { productId: string; quantity: number }[], key = idemKey()) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    payload: { items },
  });
}

describe('inventory under contention', () => {
  it('never oversells a hot SKU: 400 concurrent buyers, 50 units', async () => {
    const p = await createProduct(h, { stock: 50 });
    const tokens = await Promise.all(Array.from({ length: 400 }, () => h.token(uuidv7())));
    const results = await Promise.all(tokens.map((t) => placeOrder(t, [{ productId: p.id, quantity: 1 }])));

    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(50);
    expect(codes.filter((c) => c === 409)).toHaveLength(350);
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(await stockOf(h, p.id)).toEqual({ available: 0, reserved: 50 });
    const { rows } = await h.db.query(
      'SELECT coalesce(sum(quantity),0)::int AS sold FROM order_items WHERE product_id = $1',
      [p.id],
    );
    expect(rows[0].sold).toBe(50);
  });

  it('does not deadlock when concurrent orders lock the same rows in opposite order', async () => {
    const a = await createProduct(h, { stock: 10_000 });
    const b = await createProduct(h, { stock: 10_000 });
    const c = await createProduct(h, { stock: 10_000 });
    const token = await h.token(uuidv7());
    const shapes = [
      [a.id, b.id, c.id],
      [c.id, b.id, a.id],
      [b.id, a.id, c.id],
      [c.id, a.id, b.id],
    ];
    const results = await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        placeOrder(token, shapes[i % shapes.length]!.map((productId) => ({ productId, quantity: 1 }))),
      ),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    for (const p of [a, b, c]) expect(await stockOf(h, p.id)).toEqual({ available: 9_700, reserved: 300 });
  });

  it('creates exactly one order when the same request is retried concurrently', async () => {
    const p = await createProduct(h, { stock: 100 });
    const token = await h.token(uuidv7());
    const key = idemKey();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => placeOrder(token, [{ productId: p.id, quantity: 2 }], key)),
    );
    expect(results.every((r) => r.statusCode === 201 || r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(await stockOf(h, p.id)).toEqual({ available: 98, reserved: 2 });
  });

  it('keeps stock consistent with a mix of orders and cancellations', async () => {
    const p = await createProduct(h, { stock: 1_000 });
    const tokens = await Promise.all(Array.from({ length: 20 }, () => h.token(uuidv7())));
    const created = await Promise.all(
      Array.from({ length: 200 }, (_, i) => placeOrder(tokens[i % 20]!, [{ productId: p.id, quantity: 3 }])),
    );
    const orders = created.map((r) => ({ id: r.json().id as string, token: tokens[created.indexOf(r) % 20]! }));
    const toCancel = orders.filter((_, i) => i % 2 === 0);
    const cancels = await Promise.all(
      toCancel.map((o) =>
        h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/cancel`, headers: { authorization: `Bearer ${o.token}` }, payload: {} }),
      ),
    );
    expect(cancels.every((r) => r.statusCode === 200)).toBe(true);
    expect(await stockOf(h, p.id)).toEqual({ available: 1_000 - 100 * 3, reserved: 100 * 3 });
  });
});
