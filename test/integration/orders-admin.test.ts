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

let owner: string, grace: string, kevin: string, ruth: string, riderMgr: string;
let product: string;
const wanjiku = uuidv7();
const brian = uuidv7();

async function place(userId: string, qty: number, extra: object = {}) {
  const t = await h.token(userId, ['customer']);
  const r = await h.app.inject({ method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${t}`, 'idempotency-key': idemKey() }, payload: { items: [{ productId: product, quantity: qty }], ...extra } });
  expect(r.statusCode).toBe(201);
  return { order: r.json() as { id: string; orderNumber: string; totalCents: number; currency: string }, token: t };
}
async function pay(o: { id: string; totalCents: number; currency: string }) {
  const p = await h.token(uuidv7(), ['payments']);
  const r = await h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/payment-confirmation`, headers: { authorization: `Bearer ${p}` }, payload: { paymentRef: `r-${uuidv7()}`, amountCents: o.totalCents, currency: o.currency } });
  expect(r.statusCode).toBe(200);
}

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness();
  const s = h.c.staff;
  await s.ensureDefaultRoles();
  const add = (n: string, e: string, r: string) => s.insertRaw({ name: n, email: e, role: r, status: 'active', password: PW, mustChange: false });
  await add('Amara', 'amara@t.co', 'Owner admin');
  await add('Grace', 'grace@t.co', 'Customer support');
  await add('Kevin', 'kevin@t.co', 'Inventory manager');
  await add('Ruth', 'ruth@t.co', 'Marketing manager');
  await add('Faith', 'faith@t.co', 'Rider manager');
  [owner, grace, kevin, ruth, riderMgr] = await Promise.all([tokenFor('amara@t.co'), tokenFor('grace@t.co'), tokenFor('kevin@t.co'), tokenFor('ruth@t.co'), tokenFor('faith@t.co')]);
  product = (await call('POST', '/v1/admin/products', kevin, { sku: 'TOTE-1', name: 'Leather Tote', priceCents: 485_000, currency: 'KES', initialStock: 50 })).json().id;
});
afterAll(async () => { await h.close(); });

describe('order details from the customer app', () => {
  it('stores delivery details, numbers the order, and builds the customer’s profile', async () => {
    const { order, token } = await place(wanjiku, 2, { paymentMethod: 'mpesa', delivery: { name: 'Wanjiku Njoroge', phone: '+254 712 555 001', area: 'Kilimani', address: 'Argwings Kodhek Rd, Apt 4B' } });
    expect(order.orderNumber).toMatch(/^SC-\d+$/);
    const me = await h.app.inject({ method: 'GET', url: '/v1/customers/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.json()).toMatchObject({ name: 'Wanjiku Njoroge', phone: '+254 712 555 001', area: 'Kilimani', street: 'Argwings Kodhek Rd, Apt 4B' });
    expect(JSON.stringify(me.json())).not.toContain('spent');
    const bad = await h.app.inject({ method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${token}`, 'idempotency-key': idemKey() }, payload: { items: [{ productId: product, quantity: 1 }], delivery: { name: '', phone: '1', address: '' } } });
    expect(bad.statusCode).toBe(400);
    // a second order with different details doesn't overwrite the saved profile
    await place(wanjiku, 1, { delivery: { name: 'Someone Else', phone: '+254 700 000 000', area: 'Karen', address: 'Elsewhere' } });
    expect((await h.app.inject({ method: 'GET', url: '/v1/customers/me', headers: { authorization: `Bearer ${token}` } })).json().name).toBe('Wanjiku Njoroge');
    // a customer can fix their own details
    const put = await h.app.inject({ method: 'PUT', url: '/v1/customers/me', headers: { authorization: `Bearer ${token}` }, payload: { area: 'Lavington' } });
    expect(put.json()).toMatchObject({ area: 'Lavington', name: 'Wanjiku Njoroge' });
  });

  it('is not open to staff tokens or anonymous callers', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/customers/me' })).statusCode).toBe(401);
    expect((await call('GET', '/v1/customers/me', grace)).statusCode).toBe(403);
  });
});

describe('orders for staff', () => {
  let paid: { id: string; orderNumber: string; totalCents: number; currency: string };
  let unpaid: { id: string };

  beforeAll(async () => {
    paid = (await place(brian, 1, { paymentMethod: 'card', delivery: { name: 'Brian Kiptoo', phone: '+254 722 000 111', area: 'Westlands', address: 'Waiyaki Way' } })).order;
    unpaid = (await place(brian, 1, { paymentMethod: 'mpesa' })).order;
    await pay(paid);
  });

  it('lists newest first with the customer’s name, and filters', async () => {
    const all = (await call('GET', '/v1/admin/orders', grace)).json() as { items: { id: string; customer: string; status: string; paid: boolean }[]; nextCursor: string | null };
    expect(all.items.length).toBe(4);
    expect(all.items[0]!.id).toBe(unpaid.id);
    expect(all.items.find((o) => o.id === paid.id)).toMatchObject({ customer: 'Brian Kiptoo', status: 'Processing', paid: true });
    expect((await call('GET', '/v1/admin/orders?status=Pending', grace)).json().items).toHaveLength(3);
    expect((await call('GET', '/v1/admin/orders?payment=paid', grace)).json().items).toHaveLength(1);
    expect((await call('GET', '/v1/admin/orders?method=card', grace)).json().items.map((o: { id: string }) => o.id)).toEqual([paid.id]);
    expect((await call('GET', `/v1/admin/orders?q=${paid.orderNumber}`, grace)).json().items).toHaveLength(1);
    expect((await call('GET', '/v1/admin/orders?q=0722%20000', grace)).json().items).toHaveLength(0); // spaces matter in stored phones
    expect((await call('GET', '/v1/admin/orders?q=722%20000', grace)).json().items).toHaveLength(2); // both of Brian's orders: one by its own phone, one by his saved profile
    expect((await call('GET', '/v1/admin/orders?q=wanjiku', grace)).json().items).toHaveLength(2);
    expect((await call('GET', `/v1/admin/orders?customerId=${brian}`, grace)).json().items).toHaveLength(2);
    const p1 = (await call('GET', '/v1/admin/orders?limit=3', grace)).json();
    expect(p1.items).toHaveLength(3);
    const p2 = (await call('GET', `/v1/admin/orders?limit=3&cursor=${p1.nextCursor}`, grace)).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect((await call('GET', '/v1/admin/orders?from=2999-01-01', grace)).json().items).toHaveLength(0);
  });

  it('shows the whole story of one order, with notes', async () => {
    const note = await call('POST', `/v1/admin/orders/${paid.id}/notes`, kevin, { text: 'Customer asked for a gift bag' });
    expect(note.statusCode).toBe(200);
    const d = (await call('GET', `/v1/admin/orders/${paid.id}`, grace)).json();
    expect(d).toMatchObject({ number: paid.orderNumber, status: 'Processing', paymentMethod: 'card', customer: { name: 'Brian Kiptoo', phone: '+254 722 000 111' }, delivery: { area: 'Westlands', address: 'Waiyaki Way' } });
    expect(d.items).toEqual([expect.objectContaining({ sku: 'TOTE-1', quantity: 1, lineTotalCents: 485_000 })]);
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(['Placed', 'Paid', 'Note']);
    expect(d.notes[0]).toMatchObject({ by: 'Kevin', text: 'Customer asked for a gift bag' });
    expect((await call('POST', `/v1/admin/orders/${paid.id}/notes`, kevin, { text: '' })).statusCode).toBe(400);
    expect((await call('POST', `/v1/admin/orders/${paid.id}/notes`, grace, { text: 'x' })).statusCode).toBe(403); // support can read orders, not change them
    expect((await call('GET', `/v1/admin/orders/${uuidv7()}`, grace)).statusCode).toBe(404);
  });

  it('follows the order through packing, shipping and cancellation', async () => {
    const wh = await tokenFor('kevin@t.co');
    await call('POST', `/v1/admin/packing/${paid.id}/pick`, wh, { productId: product, picked: true });
    await call('POST', `/v1/admin/packing/${paid.id}/pack`, wh, {});
    expect((await call('GET', `/v1/admin/orders/${paid.id}`, grace)).json()).toMatchObject({ status: 'Packed' });
    await call('POST', `/v1/orders/${paid.id}/fulfillment`, kevin, {});
    const shipped = (await call('GET', `/v1/admin/orders/${paid.id}`, grace)).json();
    expect(shipped.status).toBe('Shipped');
    expect(shipped.events.map((e: { kind: string }) => e.kind)).toEqual(['Placed', 'Paid', 'Note', 'Packed', 'Shipped']);

    expect((await call('POST', `/v1/orders/${unpaid.id}/cancel`, grace, { reason: 'Not allowed' })).statusCode).toBe(404); // support can't cancel
    const cancelled = await call('POST', `/v1/orders/${unpaid.id}/cancel`, kevin, { reason: 'Customer called to cancel' });
    expect(cancelled.statusCode).toBe(200);
    const d = (await call('GET', `/v1/admin/orders/${unpaid.id}`, grace)).json();
    expect(d.status).toBe('Cancelled');
    expect(d.events.at(-1)).toMatchObject({ kind: 'Cancelled', note: 'Customer called to cancel' });
    const stats = (await call('GET', '/v1/admin/orders/stats', grace)).json();
    expect(stats.byStatus).toMatchObject({ Shipped: 1, Cancelled: 1, Pending: 2 });
    expect(stats.todayRevenueCents).toBe(485_000);
  });

  it('is closed to roles with no orders access', async () => {
    for (const t of [ruth, riderMgr]) {
      expect((await call('GET', '/v1/admin/orders', t)).statusCode).toBe(403);
      expect((await call('GET', `/v1/admin/orders/${paid.id}`, t)).statusCode).toBe(403);
    }
    expect((await call('POST', `/v1/admin/orders/${paid.id}/notes`, ruth, { text: 'x' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/orders/${paid.id}/notes`, owner, { text: 'Owner note' })).statusCode).toBe(200);
  });
});

describe('customers for staff', () => {
  it('lists customers with order counts, spend and segment', async () => {
    const list = (await call('GET', '/v1/admin/customers', grace)).json() as { items: { id: string; name: string; orders: number; spentCents: number; segment: string }[] };
    expect(list.items).toHaveLength(2);
    const b = list.items.find((c) => c.id === brian)!;
    expect(b).toMatchObject({ name: 'Brian Kiptoo', orders: 1, spentCents: 485_000, segment: 'new' }); // one cancelled order doesn't count
    const w = list.items.find((c) => c.id === wanjiku)!;
    expect(w).toMatchObject({ orders: 2, segment: 'returning' });
    expect((await call('GET', '/v1/admin/customers?segment=returning', grace)).json().items.map((c: { id: string }) => c.id)).toEqual([wanjiku]);
    expect((await call('GET', '/v1/admin/customers?q=kiptoo', grace)).json().items).toHaveLength(1);
    expect((await call('GET', '/v1/admin/customers?q=%2B254%20712', grace)).json().items).toHaveLength(1);
  });

  it('shows a profile with recent orders, and lets support add notes and fix details', async () => {
    const d = (await call('GET', `/v1/admin/customers/${wanjiku}`, grace)).json();
    expect(d.recentOrders).toHaveLength(2);
    expect(d.recentOrders[0].number).toMatch(/^SC-/);
    const n = await call('POST', `/v1/admin/customers/${wanjiku}/notes`, grace, { text: 'Prefers morning delivery' });
    expect(n.json().notes[0]).toMatchObject({ text: 'Prefers morning delivery', by: 'Grace' });
    const u = await call('PATCH', `/v1/admin/customers/${wanjiku}`, grace, { email: 'wanjiku@example.com' });
    expect(u.json()).toMatchObject({ email: 'wanjiku@example.com', name: 'Wanjiku Njoroge', area: 'Lavington' });
    expect((await call('PATCH', `/v1/admin/customers/${wanjiku}`, grace, {})).statusCode).toBe(400);
  });

  it('is limited to roles that handle customers (marketing can view but not edit)', async () => {
    expect((await call('GET', '/v1/admin/customers', ruth)).statusCode).toBe(200);
    expect((await call('PATCH', `/v1/admin/customers/${wanjiku}`, ruth, { name: 'X' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/customers/${wanjiku}/notes`, ruth, { text: 'x' })).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/customers', riderMgr)).statusCode).toBe(403);
    expect((await call('GET', `/v1/admin/customers/${uuidv7()}`, grace)).statusCode).toBe(404);
  });
});
