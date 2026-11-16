import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PW = 'Sunrise#2025!';
let h: Harness;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
let owner: string, kevin: string, james: string, tote: string, riderId: string;

async function place(user: string, method: 'cod' | 'mpesa' = 'cod', qty = 1) {
  const res = await call('POST', '/v1/orders', await h.token(user, ['customer']), { items: [{ productId: tote, quantity: qty }], paymentMethod: method, delivery: { name: 'Wanjiku Njoroge', phone: '+254712555001', area: 'Kilimani', address: 'Argwings Kodhek Rd' } }, { 'idempotency-key': idemKey() });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; totalCents: number; currency: string };
}
const mine = async (user: string, path = '') => call('GET', `/v1/customer/orders${path}`, await h.token(user, ['customer']));
const delivery = (orderId: string, status: string, extra: Record<string, unknown> = {}) =>
  h.db.query(`INSERT INTO deliveries (id, order_id, rider_id, status, handover_code, accepted_at, picked_up_at, delivered_at) VALUES ($1,$2,$3,$4,'4821', now(), $5, $6)`,
    [uuidv7(), orderId, riderId, status, extra.pickedUp ? new Date() : null, extra.delivered ? new Date() : null]);

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ RIDER_DEV_OTP: '123456', UPLOAD_DIR: mkdtempSync(join(tmpdir(), 'shopcore-uploads-')) });
  await h.c.staff.ensureDefaultRoles();
  const add = (n: string, e: string, r: string) => h.c.staff.insertRaw({ name: n, email: e, role: r, status: 'active', password: PW, mustChange: false });
  await add('Amara', 'amara@t.co', 'Owner admin');
  await add('Kevin', 'kevin@t.co', 'Inventory manager');
  await add('James', 'james@t.co', 'Operations manager');
  const login = async (e: string) => (await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: e, password: PW } })).json().accessToken as string;
  [owner, kevin, james] = [await login('amara@t.co'), await login('kevin@t.co'), await login('james@t.co')];
  const zone = (await call('POST', '/v1/admin/zones', owner, { name: 'Kilimani', feeCents: 25_000, areas: ['Kilimani'] })).json().id;
  tote = (await call('POST', '/v1/admin/products', kevin, { sku: 'TOTE-1', name: 'Leather Tote', priceCents: 485_000, currency: 'KES', initialStock: 100 })).json().id;
  const phone = '+254711000001';
  await call('POST', '/v1/rider/auth/code', null, { phone, purpose: 'signup' });
  await call('POST', '/v1/rider/auth/verify', null, { phone, purpose: 'signup', code: '123456' });
  const reg = await call('POST', '/v1/rider/auth/register', null, { phone, password: 'Ride1234', kraPin: 'A123456789B', emergencyName: 'Next Kin', emergencyRelation: 'Sibling', emergencyPhone: '+254700000000', name: 'Wanjala Rider', vehicle: 'Motorbike', plate: 'KDA 284G', zoneId: zone });
  riderId = reg.json().account.id;
});
afterAll(async () => { await h.close(); });

describe('a shopper’s orders', () => {
  it('shows a new order as processing, with a real timeline, and lets it be cancelled', async () => {
    const user = uuidv7();
    const o = await place(user);
    const r = (await mine(user)).json();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      id: o.id, number: expect.stringMatching(/^SC-\d+$/), status: 'processing', paymentMethod: 'cod', paid: false, cashDueCents: 510_000, canCancel: true, canTrack: true, awaitingPayment: false,
      totals: { subtotalCents: 485_000, deliveryFeeCents: 25_000, discountCents: 0, totalCents: 510_000 }, delivery: { area: 'Kilimani' },
      items: [{ name: 'Leather Tote', quantity: 1, unitPriceCents: 485_000 }],
    });
    const steps = r.items[0].tracking.steps as { key: string; state: string; at: string | null; title: string }[];
    expect(steps.map((s) => [s.key, s.state])).toEqual([['placed', 'done'], ['paid', 'done'], ['packed', 'current'], ['on_the_way', 'todo'], ['delivered', 'todo']]);
    expect(steps[1]!.title).toBe('Order confirmed');
    expect(r.items[0].tracking).toMatchObject({ rider: null, handoverCode: null, riderLocation: null, failure: null });
  });

  it('keeps an unpaid mobile-money order waiting for payment', async () => {
    const user = uuidv7();
    const o = await place(user, 'mpesa');
    const one = (await mine(user, `/${o.id}`)).json();
    expect(one).toMatchObject({ status: 'processing', awaitingPayment: true, paid: false, canCancel: true });
    expect(one.tracking.steps.map((s: { key: string; state: string }) => [s.key, s.state])[1]).toEqual(['paid', 'current']);
    expect(one.tracking.steps[1].title).toBe('Payment confirmed');
    const pay = await h.token(uuidv7(), ['payments']);
    await h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/payment-confirmation`, headers: { authorization: `Bearer ${pay}` }, payload: { paymentRef: 'QK12345', amountCents: o.totalCents, currency: o.currency } });
    expect((await mine(user, `/${o.id}`)).json()).toMatchObject({ awaitingPayment: false, paid: true, paymentRef: 'QK12345' });
  });

  it('shows a rider on the way, the handover code only once the parcel is on the road, and stops cancelling then', async () => {
    const user = uuidv7();
    const o = await place(user);
    await delivery(o.id, 'accepted');
    let one = (await mine(user, `/${o.id}`)).json();
    expect(one).toMatchObject({ status: 'processing', canCancel: true });
    expect(one.tracking).toMatchObject({ rider: { name: 'Wanjala Rider', vehicle: 'Motorbike' }, handoverCode: null });

    await h.db.query(`UPDATE deliveries SET status = 'picked_up', picked_up_at = now() WHERE order_id = $1`, [o.id]);
    await h.db.query(`UPDATE riders SET last_lat = -1.29, last_lng = 36.8, last_seen_at = now() WHERE id = $1`, [riderId]);
    one = (await mine(user, `/${o.id}`)).json();
    expect(one).toMatchObject({ status: 'in_transit', canCancel: false, canTrack: true });
    expect(one.tracking).toMatchObject({ handoverCode: '4821', riderLocation: { lat: -1.29, lng: 36.8 } });
    expect(one.tracking.steps.map((s: { key: string; state: string }) => [s.key, s.state]).slice(2, 4)).toEqual([['packed', 'done'], ['on_the_way', 'done']]);

    const cancel = await call('POST', `/v1/orders/${o.id}/cancel`, await h.token(user, ['customer']), { reason: 'changed my mind' });
    expect(cancel.statusCode).toBe(422);
    expect(cancel.json().error.code).toBe('ORDER_ON_THE_WAY');
    // Staff can still cancel it.
    expect((await call('POST', `/v1/admin/orders/${o.id}/cancel`, james, { reason: 'Rider incident' })).statusCode).toBeLessThan(500);
  });

  it('files delivered and cancelled orders under their own tabs, newest first, and pages through them', async () => {
    const user = uuidv7();
    const a = await place(user);
    const b = await place(user);
    const c = await place(user);
    await delivery(a.id, 'delivered', { pickedUp: true, delivered: true });
    await h.db.query(`UPDATE orders SET status = 'FULFILLED', fulfilled_at = now() WHERE id = $1`, [a.id]);
    expect((await call('POST', `/v1/orders/${b.id}/cancel`, await h.token(user, ['customer']), { reason: 'Ordered by mistake' })).statusCode).toBe(200);

    const done = (await mine(user, '?tab=completed')).json().items;
    expect(done.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect(done[0]).toMatchObject({ status: 'delivered', canCancel: false, canTrack: false, deliveredAt: expect.any(String), paid: false });
    expect(done[0].tracking.steps.every((s: { state: string }) => s.state === 'done')).toBe(true);

    const gone = (await mine(user, '?tab=cancelled')).json().items;
    expect(gone.map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect(gone[0]).toMatchObject({ status: 'cancelled', cancelReason: 'Ordered by mistake' });
    expect(gone[0].tracking.steps.at(-1)).toMatchObject({ key: 'cancelled', note: 'Ordered by mistake' });

    expect((await mine(user, '?tab=active')).json().items.map((x: { id: string }) => x.id)).toEqual([c.id]);
    const all = (await mine(user)).json().items.map((x: { id: string }) => x.id);
    expect(all).toEqual([c.id, b.id, a.id]);

    const p1 = (await mine(user, '?limit=2')).json();
    expect(p1.items.map((x: { id: string }) => x.id)).toEqual([c.id, b.id]);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await mine(user, `?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).json();
    expect(p2.items.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect(p2.nextCursor).toBeNull();
    // A tab with a lot of other orders in the way is still filled.
    expect((await mine(user, '?tab=completed&limit=1')).json().items).toHaveLength(1);
  });

  it('shows an order only to its owner', async () => {
    const o = await place(uuidv7());
    expect((await mine(uuidv7(), `/${o.id}`)).statusCode).toBe(404);
    expect((await mine(uuidv7(), `/${uuidv7()}`)).statusCode).toBe(404);
    expect((await mine(uuidv7(), '/not-a-uuid')).statusCode).toBe(400);
    expect((await call('GET', '/v1/customer/orders', null)).statusCode).toBe(401);
    expect((await call('GET', '/v1/customer/orders', owner)).statusCode).toBe(403);
  });

  it('says so when a delivery fails', async () => {
    const user = uuidv7();
    const o = await place(user);
    await delivery(o.id, 'failed', { pickedUp: true });
    await h.db.query(`UPDATE deliveries SET failure_reason = 'Nobody answered the door', failed_at = now() WHERE order_id = $1`, [o.id]);
    expect((await mine(user, `/${o.id}`)).json().tracking.failure).toBe('Nobody answered the door');
  });
});

describe('after delivery', () => {
  it('shows returns (with their photos), refund requests and the review on the order, and only lets the owner file them', async () => {
    const user = uuidv7();
    const tok = await h.token(user, ['customer']);
    const o = await place(user, 'cod', 2);
    expect((await call('POST', `/v1/orders/${o.id}/review`, tok, { rating: 5 })).json().error.code).toBe('NOT_DELIVERED');
    await delivery(o.id, 'delivered', { pickedUp: true, delivered: true });
    await h.db.query(`UPDATE orders SET status = 'FULFILLED', fulfilled_at = now(), paid_at = now(), cod_collected_at = now() WHERE id = $1`, [o.id]);

    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
    const up = await h.app.inject({ method: 'PUT', url: '/v1/uploads?kind=return-photo&name=damage.jpg', headers: { authorization: `Bearer ${tok}`, 'content-type': 'image/jpeg' }, payload: jpeg });
    expect(up.statusCode).toBe(201);
    const stranger = await h.token(uuidv7(), ['customer']);
    expect((await call('POST', `/v1/orders/${o.id}/returns`, stranger, { productId: tote, reason: 'Damaged', photoIds: [up.json().id] })).statusCode).toBe(404);
    const other = await h.app.inject({ method: 'PUT', url: '/v1/uploads?kind=return-photo', headers: { authorization: `Bearer ${stranger}`, 'content-type': 'image/jpeg' }, payload: jpeg });
    expect((await call('POST', `/v1/orders/${o.id}/returns`, tok, { productId: tote, reason: 'Damaged', photoIds: [other.json().id] })).statusCode).toBe(400);

    expect((await call('POST', `/v1/orders/${o.id}/returns`, tok, { productId: tote, qty: 1, reason: 'Item arrived damaged', statement: 'Strap is torn', photoIds: [up.json().id] })).statusCode).toBe(201);
    expect((await call('POST', `/v1/orders/${o.id}/refund-requests`, tok, { amountCents: 100_000, reason: 'Partial refund for the strap' })).statusCode).toBe(201);
    expect((await call('POST', `/v1/orders/${o.id}/review`, tok, { rating: 4, text: 'Fast delivery' })).statusCode).toBe(201);
    expect((await call('POST', `/v1/orders/${o.id}/review`, tok, { rating: 4 })).json().error.code).toBe('ALREADY_REVIEWED');

    const one = (await mine(user, `/${o.id}`)).json();
    expect(one.returns).toEqual([expect.objectContaining({ number: expect.stringMatching(/^RR-/), productId: tote, qty: 1, reason: 'Item arrived damaged', details: 'Strap is torn', photos: 1, status: 'new' })]);
    expect(one.refunds).toEqual([expect.objectContaining({ amountCents: 100_000, status: 'needs_review' })]);
    expect(one.review).toMatchObject({ rating: 4, text: 'Fast delivery' });
    const listed = (await mine(user)).json().items[0];
    expect(listed.returns).toHaveLength(1);
    const staffView = (await call('GET', '/v1/admin/returns', owner)).json().items[0];
    expect(staffView).toMatchObject({ photos: 1, photoUrls: [up.json().url] });

    // What shoppers say about the product, with no one's full name on show.
    const reviews = (await call('GET', `/v1/storefront/products/${tote}/reviews`, null)).json();
    expect(reviews).toMatchObject({ count: 1, average: 4, split: [0, 1, 0, 0, 0], items: [{ rating: 4, text: 'Fast delivery', verified: true }] });
    expect(reviews.items[0].name).toBe('Wanjiku N.');

    // The inbox is built from what happened to the order, and read state is remembered.
    const inbox = (await call('GET', '/v1/customer/notifications', tok)).json();
    expect(inbox.items.map((n: { title: string }) => n.title)).toEqual(expect.arrayContaining([expect.stringMatching(/placed$/), expect.stringMatching(/was delivered$/)]));
    expect(inbox.unread).toBe(inbox.items.length);
    expect((await call('POST', '/v1/customer/notifications/read', tok)).statusCode).toBe(204);
    expect((await call('GET', '/v1/customer/notifications', tok)).json().unread).toBe(0);

    // Saved items belong to the shopper.
    expect((await call('POST', '/v1/customer/wishlist', tok, { productId: tote })).json().items).toEqual([expect.objectContaining({ productId: tote })]);
    expect((await call('GET', '/v1/customer/wishlist', stranger)).json().items).toEqual([]);
    expect((await call('DELETE', `/v1/customer/wishlist/${tote}`, tok)).statusCode).toBe(204);
    expect((await call('GET', '/v1/customer/wishlist', tok)).json().items).toEqual([]);
    expect((await call('POST', '/v1/customer/wishlist', tok, { productId: uuidv7() })).statusCode).toBe(404);
  });
});
