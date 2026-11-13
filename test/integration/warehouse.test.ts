import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';

const PW = 'Sunrise#2025!';
let h: Harness;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: { authorization: `Bearer ${token}`, ...headers } });
async function tokenFor(email: string) {
  const r = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PW } });
  if (r.statusCode !== 200) throw new Error(r.body);
  return r.json().accessToken as string;
}
async function expectInvariant() {
  const { rows } = await h.db.query(
    `SELECT p.sku, COALESCE(i.available,0) + COALESCE(i.reserved,0) AS expected, COALESCE((SELECT sum(on_hand) FROM stock_levels s WHERE s.product_id = p.id),0)::int AS shelves
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id`);
  for (const r of rows) expect({ sku: r.sku, shelves: r.shelves }).toEqual({ sku: r.sku, shelves: r.expected });
}
const onHand = async (pid: string, loc: string) => Number((await h.db.query('SELECT COALESCE(sum(on_hand),0) AS n FROM stock_levels WHERE product_id=$1 AND location_id=$2', [pid, loc])).rows[0].n);

let owner: string, kevin: string, dennis: string, sarah: string, support: string;
let nairobi: string, mombasa: string, supplier: string, holdSupplier: string;
let bag: string, shoe: string;

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness();
  const s = h.c.staff;
  await s.ensureDefaultRoles();
  const add = (n: string, e: string, r: string) => s.insertRaw({ name: n, email: e, role: r, status: 'active', password: PW, mustChange: false });
  await add('Amara', 'amara@t.co', 'Owner admin');
  await add('Kevin', 'kevin@t.co', 'Inventory manager');
  await add('Dennis', 'dennis@t.co', 'Purchasing agent');
  await add('Sarah', 'sarah@t.co', 'Warehouse lead');
  await add('Grace', 'grace@t.co', 'Customer support');
  [owner, kevin, dennis, sarah, support] = await Promise.all([tokenFor('amara@t.co'), tokenFor('kevin@t.co'), tokenFor('dennis@t.co'), tokenFor('sarah@t.co'), tokenFor('grace@t.co')]);
  nairobi = (await call('POST', '/v1/admin/locations', kevin, { name: 'Nairobi Central', capacity: 600 })).json().id;
  mombasa = (await call('POST', '/v1/admin/locations', kevin, { name: 'Mombasa Hub', capacity: 300 })).json().id;
  supplier = (await call('POST', '/v1/admin/suppliers', owner, { name: 'Kilele Leather', minOrderCents: 5_000_000 })).json().id;
  holdSupplier = (await call('POST', '/v1/admin/suppliers', owner, { name: 'Nyumba Home', status: 'on_hold' })).json().id;
  const mk = async (sku: string, stock: number) => (await call('POST', '/v1/admin/products', kevin, { sku, name: sku, priceCents: 400_000, costCents: 240_000, initialStock: stock })).json().id as string;
  bag = await mk('BAG-1', 20);
  shoe = await mk('SHOE-1', 10);
});
afterAll(async () => { await h.close(); });

const poBody = (over: object = {}) => ({ supplierId: supplier, locationId: nairobi, expectedOn: '2026-12-01', shippingCents: 450_000, lines: [{ productId: bag, qty: 30, costCents: 240_000 }], submit: true, ...over });

describe('purchase orders', () => {
  let small: { id: string; number: string }, big: { id: string };

  it('approves a small order straight away and sends a large one for approval', async () => {
    const a = await call('POST', '/v1/admin/purchase-orders', dennis, poBody()); // 30 x 2,400 = 72,000 + VAT + shipping < 100,000
    expect(a.statusCode).toBe(201);
    small = a.json();
    expect(a.json()).toMatchObject({ status: 'approved', approvedBy: 'Auto-approved', subtotalCents: 7_200_000, taxCents: 1_152_000, totalCents: 7_200_000 + 450_000 + 1_152_000 });
    expect(a.json().number).toMatch(/^PO-\d+$/);
    const b = await call('POST', '/v1/admin/purchase-orders', dennis, poBody({ lines: [{ productId: bag, qty: 60, costCents: 240_000 }, { productId: shoe, qty: 20, costCents: 300_000 }] }));
    expect(b.json().status).toBe('pending_approval');
    big = b.json();
  });

  it('keeps drafts editable, and nobody else’s role can raise orders', async () => {
    const d = await call('POST', '/v1/admin/purchase-orders', dennis, poBody({ submit: false }));
    expect(d.json().status).toBe('draft');
    const e = await call('PUT', `/v1/admin/purchase-orders/${d.json().id}`, dennis, poBody({ submit: false, notes: 'Rush' }));
    expect(e.json()).toMatchObject({ notes: 'Rush', status: 'draft' });
    expect((await call('PUT', `/v1/admin/purchase-orders/${small.id}`, dennis, poBody())).json().error.code).toBe('NOT_A_DRAFT');
    expect((await call('POST', '/v1/admin/purchase-orders', sarah, poBody())).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/purchase-orders', support)).statusCode).toBe(403);
  });

  it('refuses orders to a supplier on hold, under the minimum, or with repeated products', async () => {
    expect((await call('POST', '/v1/admin/purchase-orders', dennis, poBody({ supplierId: holdSupplier }))).json().error.code).toBe('SUPPLIER_ON_HOLD');
    expect((await call('POST', '/v1/admin/purchase-orders', dennis, poBody({ lines: [{ productId: bag, qty: 1, costCents: 240_000 }] }))).json().error.code).toBe('BELOW_MINIMUM_ORDER');
    expect((await call('POST', '/v1/admin/purchase-orders', dennis, poBody({ lines: [{ productId: bag, qty: 30, costCents: 1 }, { productId: bag, qty: 30, costCents: 1 }] }))).statusCode).toBe(400);
    expect((await call('POST', '/v1/admin/purchase-orders', dennis, poBody({ submit: false, supplierId: holdSupplier }))).statusCode).toBe(201); // a draft is fine
  });

  it('needs a second person to approve (the owner may approve their own)', async () => {
    const self = await call('POST', `/v1/admin/purchase-orders/${big.id}/actions`, dennis, { action: 'approve' });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.message).toContain('Dennis created this order');
    const ok = await call('POST', `/v1/admin/purchase-orders/${big.id}/actions`, kevin, { action: 'approve' });
    expect(ok.json()).toMatchObject({ status: 'approved', approvedBy: 'Kevin' });
    expect((await call('POST', `/v1/admin/purchase-orders/${big.id}/actions`, kevin, { action: 'approve' })).json().error.code).toBe('NOT_AWAITING_APPROVAL');

    const mine = await call('POST', '/v1/admin/purchase-orders', owner, poBody({ lines: [{ productId: bag, qty: 80, costCents: 240_000 }] }));
    expect(mine.json().status).toBe('pending_approval');
    expect((await call('POST', `/v1/admin/purchase-orders/${mine.json().id}/actions`, owner, { action: 'approve' })).json().status).toBe('approved');
  });

  it('receives in parts: good units are shelved at the order’s location, damaged ones are not', async () => {
    await call('POST', `/v1/admin/purchase-orders/${small.id}/actions`, dennis, { action: 'send' });
    const before = await onHand(bag, nairobi);
    expect((await call('POST', `/v1/admin/purchase-orders/${small.id}/receive`, sarah, { deliveryRef: 'DN-1', lines: [{ productId: bag, good: 10, damaged: 2 }] })).json()).toMatchObject({ status: 'partially_received', unitsReceived: 12 });
    expect(await onHand(bag, nairobi)).toBe(before + 10);
    await expectInvariant();
    expect((await call('POST', `/v1/admin/purchase-orders/${small.id}/actions`, dennis, { action: 'cancel' })).json().error.code).toBe('PARTLY_RECEIVED');
    expect((await call('POST', `/v1/admin/purchase-orders/${small.id}/receive`, sarah, { deliveryRef: 'DN-2', lines: [{ productId: bag, good: 30, damaged: 0 }] })).json().error.code).toBe('OVER_RECEIVED');
    expect((await call('POST', `/v1/admin/purchase-orders/${small.id}/receive`, sarah, { deliveryRef: 'DN-2', lines: [{ productId: shoe, good: 1, damaged: 0 }] })).statusCode).toBe(400);
    const done = await call('POST', `/v1/admin/purchase-orders/${small.id}/receive`, sarah, { deliveryRef: 'DN-2', lines: [{ productId: bag, good: 18, damaged: 0 }] });
    expect(done.json()).toMatchObject({ status: 'received', deliveryRef: 'DN-2' });
    expect(done.json().receipts.map((r: { deliveryRef: string }) => r.deliveryRef)).toEqual(['DN-1', 'DN-2']);
    expect(await onHand(bag, nairobi)).toBe(before + 28);
    await expectInvariant();
    const mv = (await call('GET', `/v1/admin/stock/movements?productId=${bag}&type=PO%20receipt`, kevin)).json().items as { qty: number; ref: string; note: string }[];
    expect(mv.map((m) => [m.qty, m.ref, m.note])).toEqual([[18, small.number, 'DN-2'], [10, small.number, 'DN-1']]);
    expect((await call('POST', `/v1/admin/purchase-orders/${small.id}/receive`, sarah, { deliveryRef: 'DN-3', lines: [{ productId: bag, good: 1, damaged: 0 }] })).json().error.code).toBe('CANNOT_RECEIVE');
  });

  it('cancels an untouched order and reports supplier performance', async () => {
    const d = await call('POST', '/v1/admin/purchase-orders', dennis, poBody());
    expect((await call('POST', `/v1/admin/purchase-orders/${d.json().id}/actions`, dennis, { action: 'cancel' })).json().status).toBe('cancelled');
    const stats = (await call('GET', '/v1/admin/purchase-orders/stats', dennis)).json().items as { supplierId: string; received: number; onTimePct: number | null }[];
    expect(stats.find((x) => x.supplierId === supplier)).toMatchObject({ received: 1 });
    const list = (await call('GET', '/v1/admin/purchase-orders?status=received', dennis)).json().items as { id: string }[];
    expect(list.map((p) => p.id)).toEqual([small.id]);
  });
});

describe('stock counts', () => {
  let count: string;
  it('freezes the system numbers, needs recounts for mismatches, and then waits for a second person', async () => {
    const start = await call('POST', '/v1/admin/stock-counts', sarah, { locationId: mombasa, zone: 'Aisle 2' });
    expect(start.statusCode).toBe(201);
    count = start.json().id;
    expect(start.json().lines.map((l: { sku: string }) => l.sku).sort()).toEqual(['BAG-1', 'SHOE-1']);
    expect((await call('POST', '/v1/admin/stock-counts', kevin, { locationId: mombasa })).json().error.code).toBe('COUNT_OPEN');

    expect((await call('POST', `/v1/admin/stock-counts/${count}/submit`, sarah, {})).json().error.code).toBe('INCOMPLETE_COUNT');
    // Stock first goes to Mombasa so there's something to count.
    await call('POST', '/v1/admin/stock/transfer', kevin, { productId: shoe, fromLocationId: nairobi, toLocationId: mombasa, qty: 4 });
    const enter = (pid: string, which: 'c1' | 'c2', value: number | null) => call('POST', `/v1/admin/stock-counts/${count}/entries`, sarah, { productId: pid, which, value });
    await enter(bag, 'c1', 0); // matches
    const r1 = await enter(shoe, 'c1', 2); // system said 0 (frozen before the transfer)
    expect(r1.json().lines.find((l: { sku: string }) => l.sku === 'SHOE-1')).toMatchObject({ expected: 0, state: 'recount' });
    expect((await call('POST', `/v1/admin/stock-counts/${count}/submit`, sarah, {})).json().error.code).toBe('RECOUNT_NEEDED');
    expect((await enter(bag, 'c2', 1)).json().lines.find((l: { sku: string }) => l.sku === 'BAG-1').state).toBe('variance');
    await enter(bag, 'c2', null);
    await enter(shoe, 'c2', 3);
    const sub = await call('POST', `/v1/admin/stock-counts/${count}/submit`, sarah, {});
    expect(sub.json().status).toBe('pending_approval');
    expect((await enter(shoe, 'c1', 9)).json().error.code).toBe('COUNT_CLOSED');
  });

  it('applies the variances against what is on the shelf now, once someone else approves', async () => {
    expect((await call('POST', `/v1/admin/stock-counts/${count}/approve`, sarah, {})).statusCode).toBe(403);
    expect(await onHand(shoe, mombasa)).toBe(4);
    const ok = await call('POST', `/v1/admin/stock-counts/${count}/approve`, kevin, {});
    expect(ok.json()).toMatchObject({ status: 'reconciled', approvedBy: 'Kevin' });
    expect(await onHand(shoe, mombasa)).toBe(3); // counted 3 (second count) against 4 now on the shelf
    await expectInvariant();
    const mv = (await call('GET', `/v1/admin/stock/movements?productId=${shoe}&type=Count%20correction`, kevin)).json().items as { qty: number; ref: string }[];
    expect(mv).toHaveLength(1);
    expect(mv[0]!.qty).toBe(-1);
    expect((await call('POST', `/v1/admin/stock-counts/${count}/approve`, kevin, {})).json().error.code).toBe('NOT_AWAITING_APPROVAL');
    expect((await call('GET', '/v1/admin/stock-counts?status=reconciled', kevin)).json().items).toHaveLength(1);
  });

  it('closes immediately when everything matches', async () => {
    const c = (await call('POST', '/v1/admin/stock-counts', sarah, { locationId: mombasa })).json();
    for (const l of c.lines as { productId: string; expected: number }[]) await call('POST', `/v1/admin/stock-counts/${c.id}/entries`, sarah, { productId: l.productId, which: 'c1', value: l.expected });
    expect((await call('POST', `/v1/admin/stock-counts/${c.id}/submit`, sarah, {})).json()).toMatchObject({ status: 'reconciled', approvedBy: 'No variances' });
  });
});

describe('returns', () => {
  it('restocks into a chosen location, or just records a write-off', async () => {
    const r1 = (await call('POST', '/v1/admin/warehouse-returns', sarah, { productId: bag, qty: 2, reason: 'Changed mind', condition: 'Sealed', customer: 'Wanjiku', valueCents: 900_000 })).json();
    expect(r1.number).toMatch(/^RT-/);
    expect((await call('GET', '/v1/admin/warehouse-returns', sarah)).json().items).toHaveLength(1);
    const before = await onHand(bag, mombasa);
    const d = await call('POST', `/v1/admin/warehouse-returns/${r1.id}/decision`, sarah, { disposition: 'restock_sellable', locationId: mombasa, refundReview: true });
    expect(d.json()).toMatchObject({ disposition: 'restock_sellable', location: 'Mombasa Hub', refundReview: true, decidedBy: 'Sarah' });
    expect(await onHand(bag, mombasa)).toBe(before + 2);
    await expectInvariant();
    expect((await call('POST', `/v1/admin/warehouse-returns/${r1.id}/decision`, sarah, { disposition: 'write_off', locationId: mombasa })).json().error.code).toBe('ALREADY_DECIDED');

    const r2 = (await call('POST', '/v1/admin/warehouse-returns', sarah, { productId: shoe, qty: 1, reason: 'Arrived damaged', condition: 'Cracked' })).json();
    const total = await onHand(shoe, mombasa);
    await call('POST', `/v1/admin/warehouse-returns/${r2.id}/decision`, sarah, { disposition: 'write_off', locationId: mombasa, notes: 'Cracked sole' });
    expect(await onHand(shoe, mombasa)).toBe(total);
    expect((await call('GET', '/v1/admin/warehouse-returns?state=decided', sarah)).json().items).toHaveLength(2);
    expect((await call('GET', '/v1/admin/warehouse-returns', sarah)).json().items).toHaveLength(0);
    expect((await call('POST', '/v1/admin/warehouse-returns', support, { productId: bag, qty: 1 })).statusCode).toBe(403);
  });
});

describe('picking and packing', () => {
  it('moves a paid order from pick to packed, and only when everything is picked', async () => {
    const customer = await h.token(uuidv7(), ['customer']);
    const placed = await h.app.inject({ method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${customer}`, 'idempotency-key': idemKey() }, payload: { items: [{ productId: bag, quantity: 1 }, { productId: shoe, quantity: 1 }] } });
    const order = placed.json() as { id: string; totalCents: number; currency: string };
    expect((await call('GET', '/v1/admin/packing', sarah)).json().items).toHaveLength(0); // unpaid orders aren't packable
    expect((await call('POST', `/v1/admin/packing/${order.id}/pick`, sarah, { productId: bag, picked: true })).statusCode).toBe(422);
    const payments = await h.token(uuidv7(), ['payments']);
    await h.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/payment-confirmation`, headers: { authorization: `Bearer ${payments}` }, payload: { paymentRef: `r-${uuidv7()}`, amountCents: order.totalCents, currency: order.currency } });

    const q = (await call('GET', '/v1/admin/packing', sarah)).json().items as { orderId: string; stage: string; items: unknown[] }[];
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ orderId: order.id, stage: 'pick' });
    expect(q[0]!.items).toHaveLength(2);
    expect((await call('POST', `/v1/admin/packing/${order.id}/pack`, sarah, {})).json().error.code).toBe('PICK_INCOMPLETE');
    expect((await call('POST', `/v1/admin/packing/${order.id}/pick`, sarah, { productId: bag, picked: true })).statusCode).toBe(204);
    expect((await call('POST', `/v1/admin/packing/${order.id}/pick`, sarah, { productId: uuidv7(), picked: true })).statusCode).toBe(400);
    expect((await call('POST', `/v1/admin/packing/${order.id}/pack`, sarah, {})).json().error.code).toBe('PICK_INCOMPLETE');
    await call('POST', `/v1/admin/packing/${order.id}/pick`, sarah, { productId: shoe, picked: true });
    expect((await call('POST', `/v1/admin/packing/${order.id}/pack`, sarah, {})).statusCode).toBe(204);
    const after = (await call('GET', '/v1/admin/packing', sarah)).json().items as { stage: string; packedAt: string }[];
    expect(after[0]).toMatchObject({ stage: 'packed' });
    expect((await call('POST', `/v1/admin/packing/${order.id}/pick`, sarah, { productId: bag, picked: false })).json().error.code).toBe('ALREADY_PACKED');
    expect((await call('GET', '/v1/admin/packing', support)).statusCode).toBe(200); // support may view orders
    expect((await call('POST', `/v1/admin/packing/${order.id}/pack`, support, {})).statusCode).toBe(403);
    await expectInvariant();
  });
});
