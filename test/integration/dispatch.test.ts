import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';

const PW = 'Sunrise#2025!';
let h: Harness;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
async function staffToken(email: string) {
  const r = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PW } });
  if (r.statusCode !== 200) throw new Error(r.body);
  return r.json().accessToken as string;
}

let owner: string, james: string, faith: string, samuel: string, grace: string, kevin: string;
let zoneKilimani: string;
let product: string;

/** Walks a new rider through sign-up and returns their tokens. */
async function newRider(phone: string, name: string, opts: { approve?: boolean } = {}) {
  expect((await call('POST', '/v1/rider/auth/code', null, { phone, purpose: 'signup' })).statusCode).toBe(204);
  expect((await call('POST', '/v1/rider/auth/verify', null, { phone, purpose: 'signup', code: '123456' })).statusCode).toBe(204);
  const reg = await call('POST', '/v1/rider/auth/register', null, { phone, password: 'Ride1234', name, vehicle: 'Motorbike', plate: 'KDA 284G', zoneId: zoneKilimani });
  expect(reg.statusCode).toBe(201);
  const t = reg.json() as { accessToken: string; refreshToken: string; account: { id: string } };
  if (opts.approve !== false) {
    for (const key of ['id', 'license', 'insurance', 'photo', 'selfie']) await call('PUT', `/v1/admin/riders/${t.account.id}/documents/${key}`, james, { state: 'valid' });
    const ok = await call('POST', `/v1/admin/riders/${t.account.id}/actions`, james, { action: 'approve' });
    expect(ok.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    h.c.riders.invalidate();
  }
  return { id: t.account.id, token: t.accessToken, refresh: t.refreshToken };
}
const goOnline = (r: { token: string }) => call('PUT', '/v1/rider/availability', r.token, { online: true, lat: -1.29, lng: 36.8 });

async function placeOrder(opts: { qty?: number; method?: 'mpesa' | 'cod'; area?: string; userId?: string; pay?: boolean } = {}) {
  const userId = opts.userId ?? uuidv7();
  const t = await h.token(userId, ['customer']);
  const res = await h.app.inject({
    method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${t}`, 'idempotency-key': idemKey() },
    payload: { items: [{ productId: product, quantity: opts.qty ?? 1 }], paymentMethod: opts.method ?? 'mpesa', delivery: { name: 'Wanjiku Njoroge', phone: '+254 712 555 001', area: opts.area ?? 'Kilimani', address: 'Argwings Kodhek Rd' } },
  });
  expect(res.statusCode).toBe(201);
  const order = res.json() as { id: string; totalCents: number; currency: string; status: string };
  if (opts.method !== 'cod' && opts.pay !== false) {
    const p = await h.token(uuidv7(), ['payments']);
    const paid = await h.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/payment-confirmation`, headers: { authorization: `Bearer ${p}` }, payload: { paymentRef: `r-${uuidv7()}`, amountCents: order.totalCents, currency: order.currency } });
    expect(paid.statusCode).toBe(200);
  }
  return { order, customer: t, userId };
}
const board = async () => (await call('GET', '/v1/admin/dispatch/board', james)).json() as { unassigned: { orderId: string }[]; active: { id: string; orderId: string; status: string; riderId: string }[]; riders: { id: string }[] };

async function expectInvariant() {
  const { rows } = await h.db.query(
    `SELECT p.sku, COALESCE(i.available,0) + COALESCE(i.reserved,0) AS expected, COALESCE((SELECT sum(on_hand) FROM stock_levels s WHERE s.product_id = p.id),0)::int AS shelves
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id`);
  for (const r of rows) expect({ sku: r.sku, shelves: r.shelves }).toEqual({ sku: r.sku, shelves: r.expected });
}

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ RIDER_DEV_OTP: '123456' });
  const s = h.c.staff;
  await s.ensureDefaultRoles();
  const add = (n: string, e: string, r: string) => s.insertRaw({ name: n, email: e, role: r, status: 'active', password: PW, mustChange: false });
  await add('Amara', 'amara@t.co', 'Owner admin');
  await add('James', 'james@t.co', 'Operations manager');
  await add('Faith', 'faith@t.co', 'Rider manager');
  await add('Samuel', 'samuel@t.co', 'Finance analyst');
  await add('Grace', 'grace@t.co', 'Customer support');
  await add('Kevin', 'kevin@t.co', 'Inventory manager');
  [owner, james, faith, samuel, grace, kevin] = await Promise.all([staffToken('amara@t.co'), staffToken('james@t.co'), staffToken('faith@t.co'), staffToken('samuel@t.co'), staffToken('grace@t.co'), staffToken('kevin@t.co')]);
  product = (await call('POST', '/v1/admin/products', kevin, { sku: 'TOTE-1', name: 'Leather Tote', priceCents: 485_000, currency: 'KES', initialStock: 200 })).json().id;
});
afterAll(async () => { await h.close(); });

describe('zones and delivery fees', () => {
  it('manages zones; an area can only sit in one', async () => {
    const z = await call('POST', '/v1/admin/zones', owner, { name: 'Kilimani', feeCents: 25_000, commissionPct: 20, areas: ['Kilimani', 'Lavington'] });
    expect(z.statusCode).toBe(201);
    zoneKilimani = z.json().id;
    expect((await call('POST', '/v1/admin/zones', owner, { name: 'Westlands', feeCents: 30_000, areas: ['lavington', 'Westlands'] })).json().error.code).toBe('AREA_IN_ANOTHER_ZONE');
    expect((await call('POST', '/v1/admin/zones', owner, { name: 'kilimani', feeCents: 1 })).json().error.code).toBe('ZONE_EXISTS');
    const u = await call('PATCH', `/v1/admin/zones/${zoneKilimani}`, owner, { note: 'Premium' });
    expect(u.json()).toMatchObject({ note: 'Premium', feeCents: 25_000, areas: ['Kilimani', 'Lavington'] });
    expect((await call('PUT', '/v1/admin/delivery-settings', owner, { baseFeeCents: 30_000, minBasketCents: 0 })).statusCode).toBe(200);
    expect((await call('POST', '/v1/admin/zones', james, { name: 'X', feeCents: 1 })).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/zones', james)).statusCode).toBe(200);
  });

  it('adds the zone’s fee at checkout, or the base fee for unlisted areas', async () => {
    const a = await placeOrder({ area: 'Kilimani', pay: false });
    expect(a.order.totalCents).toBe(485_000 + 25_000);
    const b = await placeOrder({ area: 'Somewhere New', pay: false });
    expect(b.order.totalCents).toBe(485_000 + 30_000);
    const d = (await call('GET', `/v1/admin/orders/${a.order.id}`, james)).json();
    expect(d).toMatchObject({ subtotalCents: 485_000, deliveryFeeCents: 25_000 });
    await call('PUT', '/v1/admin/delivery-settings', owner, { baseFeeCents: 30_000, minBasketCents: 600_000 });
    const t = await h.token(uuidv7(), ['customer']);
    const small = await h.app.inject({ method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${t}`, 'idempotency-key': idemKey() }, payload: { items: [{ productId: product, quantity: 1 }], delivery: { name: 'A', phone: '0712345678', area: 'Kilimani', address: 'x' } } });
    expect(small.json().error.code).toBe('BELOW_MINIMUM_BASKET');
    await call('PUT', '/v1/admin/delivery-settings', owner, { baseFeeCents: 30_000, minBasketCents: 0 });
  });
});

describe('cash on delivery', () => {
  it('confirms at once: stock leaves the shelf, nothing is taken until the rider collects', async () => {
    const before = Number((await h.db.query('SELECT COALESCE(sum(on_hand),0) AS n FROM stock_levels')).rows[0].n);
    const { order, userId } = await placeOrder({ method: 'cod', qty: 2 });
    expect(order.status).toBe('PAID');
    expect(Number((await h.db.query('SELECT COALESCE(sum(on_hand),0) AS n FROM stock_levels')).rows[0].n)).toBe(before - 2);
    await expectInvariant();
    const d = (await call('GET', `/v1/admin/orders/${order.id}`, james)).json();
    expect(d).toMatchObject({ paid: false, cashDueCents: 2 * 485_000 + 25_000, paymentMethod: 'cod' });
    expect((await call('GET', '/v1/admin/orders?payment=unpaid&method=cod', james)).json().items.map((o: { id: string }) => o.id)).toContain(order.id);
    // cancelling takes the stock back and asks for no refund
    const t = await h.token(userId, ['customer']);
    expect((await h.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/cancel`, headers: { authorization: `Bearer ${t}` }, payload: {} })).statusCode).toBe(200);
    expect(Number((await h.db.query('SELECT COALESCE(sum(on_hand),0) AS n FROM stock_levels')).rows[0].n)).toBe(before);
    const ev = (await h.db.query(`SELECT payload FROM outbox WHERE aggregate_id = $1 AND event_type = 'OrderCancelled'`, [order.id])).rows[0].payload;
    expect(ev.refundRequired).toBe(false);
    await expectInvariant();
  });
});

describe('rider sign-up and approval', () => {
  const phone = '+254700111222';
  let rider: { id: string; token: string };

  it('needs a verified phone and a good code', async () => {
    expect((await call('POST', '/v1/rider/auth/register', null, { phone, password: 'Ride1234', name: 'New Rider' })).json().error.code).toBe('CODE_NOT_VERIFIED');
    await call('POST', '/v1/rider/auth/code', null, { phone: '0700 111 222', purpose: 'signup' });
    expect((await call('POST', '/v1/rider/auth/verify', null, { phone, purpose: 'signup', code: '999999' })).json().error.code).toBe('WRONG_CODE');
    expect((await call('POST', '/v1/rider/auth/code', null, { phone, purpose: 'signup' })).json().error.code).toBe('CODE_TOO_SOON');
    expect((await call('POST', '/v1/rider/auth/verify', null, { phone, purpose: 'signup', code: '123456' })).statusCode).toBe(204);
    expect((await call('POST', '/v1/rider/auth/register', null, { phone, password: 'short', name: 'New Rider' })).statusCode).toBe(400);
    const reg = await call('POST', '/v1/rider/auth/register', null, { phone, password: 'Ride1234', name: 'New Rider', vehicle: 'Motorbike', plate: 'kda 111a' });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().account).toMatchObject({ status: 'pending', name: 'New Rider', plate: 'KDA 111A' });
    rider = { id: reg.json().account.id, token: reg.json().accessToken };
    expect((await call('POST', '/v1/rider/auth/code', null, { phone, purpose: 'signup' })).json().error.code).toBe('PHONE_EXISTS');
  });

  it('keeps a pending rider out of the work, and out of the approval until every document is checked', async () => {
    expect((await call('GET', '/v1/rider/offers', rider.token)).statusCode).toBe(403);
    expect((await call('GET', '/v1/rider/me', rider.token)).json()).toMatchObject({ status: 'pending' });
    expect((await call('PUT', '/v1/rider/availability', rider.token, { online: true })).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/riders/${rider.id}/actions`, james, { action: 'approve' })).json().error.code).toBe('DOCS_NOT_VERIFIED');
    for (const key of ['id', 'license', 'insurance', 'photo']) await call('PUT', `/v1/admin/riders/${rider.id}/documents/${key}`, james, { state: 'valid' });
    expect((await call('POST', `/v1/admin/riders/${rider.id}/actions`, james, { action: 'approve' })).json().error.message).toContain('Selfie check');
  });

  it('sends back a rejected application with the reason, and takes a re-sent photo back to pending', async () => {
    const rj = await call('POST', `/v1/admin/riders/${rider.id}/actions`, james, { action: 'reject', docKey: 'id', note: 'Photo is blurry. Retake it in bright light.' });
    expect(rj.json()).toMatchObject({ status: 'rejected' });
    const me = (await call('GET', '/v1/rider/me', rider.token)).json();
    expect(me.status).toBe('rejected');
    expect(me.rejection).toMatchObject({ document: 'id', message: 'Photo is blurry. Retake it in bright light.' });
    const re = await call('PUT', '/v1/rider/me/documents/id', rider.token, { fileRef: 'uploads/id-2.jpg' });
    expect(re.json().status).toBe('pending');
    for (const key of ['id', 'selfie']) await call('PUT', `/v1/admin/riders/${rider.id}/documents/${key}`, james, { state: 'valid' });
    expect((await call('POST', `/v1/admin/riders/${rider.id}/actions`, james, { action: 'approve' })).json().status).toBe('approved');
    h.c.riders.invalidate();
    expect((await goOnline(rider)).json().online).toBe(true);
  });

  it('pauses and reinstates a rider, signing them out when paused', async () => {
    expect((await call('POST', `/v1/admin/riders/${rider.id}/actions`, faith, { action: 'suspend', reason: 'Customer complaints under review' })).json().status).toBe('suspended');
    expect((await call('GET', '/v1/rider/offers', rider.token)).statusCode).toBe(401);
    const login = await call('POST', '/v1/rider/auth/login', null, { phone: '0700111222', password: 'Ride1234' });
    expect(login.json().account.status).toBe('suspended');
    expect((await call('GET', '/v1/rider/offers', login.json().accessToken)).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/riders/${rider.id}/actions`, faith, { action: 'reinstate' })).json().status).toBe('approved');
    expect((await call('POST', '/v1/rider/auth/login', null, { phone, password: 'wrong-one1' })).statusCode).toBe(401);
  });

  it('lets only the right staff manage riders', async () => {
    expect((await call('GET', '/v1/admin/riders', samuel)).statusCode).toBe(403); // finance has no say over riders
    expect((await call('GET', '/v1/admin/riders', grace)).statusCode).toBe(200); // support can see who is out on the road
    expect((await call('GET', '/v1/admin/riders', faith)).json().items.length).toBeGreaterThan(0);
    expect((await call('POST', `/v1/admin/riders/${rider.id}/actions`, samuel, { action: 'suspend', reason: 'Not mine to do' })).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/riders', rider.token)).statusCode).toBe(403);
    expect((await call('GET', '/v1/rider/me', james)).statusCode).toBe(403);
  });
});

describe('a delivery from offer to payout', () => {
  let rider: { id: string; token: string };
  let orderId: string, deliveryId: string, customerToken: string;

  beforeAll(async () => {
    rider = await newRider('+254711000001', 'Wanjala Rider');
    await goOnline(rider);
  });

  it('lists a paid order for dispatch and offers it to an online rider', async () => {
    const o = await placeOrder({ qty: 1 });
    orderId = o.order.id; customerToken = o.customer;
    expect((await board()).unassigned.map((x) => x.orderId)).toContain(orderId);
    const sug = (await call('GET', `/v1/admin/dispatch/orders/${orderId}/suggestions`, james)).json().items as { id: string }[];
    expect(sug[0]!.id).toBe(rider.id);
    expect((await call('POST', `/v1/admin/dispatch/orders/${orderId}/assign`, grace, { riderId: rider.id })).statusCode).toBe(403);
    const a = await call('POST', `/v1/admin/dispatch/orders/${orderId}/assign`, james, { riderId: rider.id });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ status: 'offered', rider: 'Wanjala Rider', fareCents: 20_000 });
    deliveryId = a.json().id;
    expect((await board()).unassigned.map((x) => x.orderId)).not.toContain(orderId);
    expect((await call('POST', `/v1/admin/dispatch/orders/${orderId}/assign`, james, { riderId: rider.id })).json().error.code).toBe('ALREADY_ASSIGNED');
  });

  it('shows the rider the request and lets only them answer it', async () => {
    const offers = (await call('GET', '/v1/rider/offers', rider.token)).json().items as { id: string; earningsCents: number; customer: string; items: unknown[] }[];
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ id: deliveryId, earningsCents: 20_000, customer: 'Wanjiku Njoroge' });
    const other = await newRider('+254711000002', 'Other Rider');
    expect((await call('POST', `/v1/rider/offers/${deliveryId}/accept`, other.token)).statusCode).toBe(404);
    const acc = await call('POST', `/v1/rider/offers/${deliveryId}/accept`, rider.token);
    expect(acc.statusCode).toBe(200);
    expect(acc.json().active).toMatchObject({ id: deliveryId, status: 'accepted' });
  });

  it('keeps the handover code secret until the parcel is on the road', async () => {
    const view = async () => (await h.app.inject({ method: 'GET', url: `/v1/orders/${orderId}/delivery`, headers: { authorization: `Bearer ${customerToken}` } })).json();
    expect(await view()).toMatchObject({ status: 'accepted', rider: { name: 'Wanjala Rider' }, handoverCode: null });
    expect((await call('POST', `/v1/rider/deliveries/${deliveryId}/stage`, rider.token, { stage: 'picked_up' })).json().error.code).toBe('WRONG_STAGE');
    await call('POST', `/v1/rider/deliveries/${deliveryId}/stage`, rider.token, { stage: 'at_pickup' });
    await call('POST', `/v1/rider/deliveries/${deliveryId}/stage`, rider.token, { stage: 'picked_up' });
    expect((await call('GET', `/v1/admin/orders/${orderId}`, james)).json().status).toBe('Out for delivery');
    const v = await view();
    expect(v.handoverCode).toMatch(/^\d{4}$/);
    const stranger = await h.token(uuidv7(), ['customer']);
    expect((await h.app.inject({ method: 'GET', url: `/v1/orders/${orderId}/delivery`, headers: { authorization: `Bearer ${stranger}` } })).statusCode).toBe(404);
    await call('POST', `/v1/rider/deliveries/${deliveryId}/stage`, rider.token, { stage: 'at_dropoff' });
    expect((await call('POST', `/v1/rider/deliveries/${deliveryId}/deliver`, rider.token, { code: v.handoverCode === '0000' ? '1111' : '0000' })).json().error.code).toBe('WRONG_CODE');
    expect((await call('POST', `/v1/rider/deliveries/${deliveryId}/deliver`, rider.token, { code: v.handoverCode, photoRef: 'uploads/pod.jpg' })).statusCode).toBe(200);
  });

  it('completes the order and credits the rider’s earnings', async () => {
    expect((await call('GET', `/v1/admin/orders/${orderId}`, james)).json()).toMatchObject({ status: 'Delivered' });
    const e = (await call('GET', '/v1/rider/earnings', rider.token)).json();
    expect(e).toMatchObject({ balanceCents: 20_000, todayCents: 20_000, cashHeldCents: 0 });
    expect(e.entries[0]).toMatchObject({ kind: 'fare', amountCents: 20_000 });
    expect((await call('GET', '/v1/rider/active', rider.token)).json().active).toBeNull();
    expect((await call('GET', '/v1/rider/history', rider.token)).json().items[0]).toMatchObject({ status: 'delivered' });
    expect((await call('GET', `/v1/admin/riders/${rider.id}`, faith)).json()).toMatchObject({ deliveries: 1, earningsBalanceCents: 20_000 });
    await expectInvariant();
  });

  it('collects cash on delivery exactly, and the rider owes it until it is handed in', async () => {
    const o = await placeOrder({ method: 'cod', qty: 1 });
    await call('POST', `/v1/admin/dispatch/orders/${o.order.id}/assign`, james, { riderId: rider.id, force: true });
    const act = (await call('GET', '/v1/rider/active', rider.token)).json().active as { id: string; codCents: number };
    expect(act.codCents).toBe(485_000 + 25_000);
    for (const stage of ['at_pickup', 'picked_up', 'at_dropoff']) await call('POST', `/v1/rider/deliveries/${act.id}/stage`, rider.token, { stage });
    const code = (await h.app.inject({ method: 'GET', url: `/v1/orders/${o.order.id}/delivery`, headers: { authorization: `Bearer ${o.customer}` } })).json().handoverCode as string;
    expect((await call('POST', `/v1/rider/deliveries/${act.id}/deliver`, rider.token, { code, cashCents: 400_000 })).json().error.code).toBe('CASH_MISMATCH');
    expect((await call('POST', `/v1/rider/deliveries/${act.id}/deliver`, rider.token, { code })).json().error.code).toBe('CASH_MISMATCH');
    expect((await call('POST', `/v1/rider/deliveries/${act.id}/deliver`, rider.token, { code, cashCents: 510_000 })).statusCode).toBe(200);
    expect((await call('GET', `/v1/admin/orders/${o.order.id}`, james)).json()).toMatchObject({ paid: true, cashDueCents: 0, status: 'Delivered' });
    expect((await call('GET', '/v1/rider/earnings', rider.token)).json().cashHeldCents).toBe(510_000);

    const cash = (await call('GET', '/v1/admin/cash', samuel)).json();
    expect(cash.owed).toEqual([expect.objectContaining({ riderId: rider.id, heldCents: 510_000 })]);
    expect((await call('GET', '/v1/admin/cash', faith)).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/cash/${rider.id}/deposit`, samuel, { amountCents: 600_000, ref: 'MPESA-ABC1' })).json().error.code).toBe('MORE_THAN_HELD');
    const dep = await call('POST', `/v1/admin/cash/${rider.id}/deposit`, samuel, { amountCents: 510_000, ref: 'MPESA-ABC1' });
    expect(dep.json()).toMatchObject({ totalHeldCents: 0, deposits: [expect.objectContaining({ amountCents: 510_000, receivedBy: 'Samuel' })] });
  });

  it('pays out earnings: minimum, fee, and the money set aside while pending', async () => {
    const e0 = (await call('GET', '/v1/rider/earnings', rider.token)).json();
    expect(e0.balanceCents).toBe(40_000); // two deliveries at KES 200
    expect((await call('POST', '/v1/rider/withdrawals', rider.token, { amountCents: 5_000 })).json().error.code).toBe('BELOW_MINIMUM');
    expect((await call('POST', '/v1/rider/withdrawals', rider.token, { amountCents: 39_000 })).json().error.code).toBe('INSUFFICIENT_BALANCE');
    const w = await call('POST', '/v1/rider/withdrawals', rider.token, { amountCents: 30_000 });
    expect(w.statusCode).toBe(201);
    expect(w.json()).toMatchObject({ status: 'pending', amountCents: 30_000, feeCents: 1_500 });
    expect((await call('GET', '/v1/rider/earnings', rider.token)).json().balanceCents).toBe(40_000 - 30_000 - 1_500);

    expect((await call('POST', `/v1/admin/payouts/${w.json().id}/paid`, faith, { providerRef: 'MPESA-XYZ' })).statusCode).toBe(403);
    const paid = await call('POST', `/v1/admin/payouts/${w.json().id}/paid`, samuel, { providerRef: 'MPESA-XYZ' });
    expect(paid.json()).toMatchObject({ status: 'paid', paidBy: 'Samuel', providerRef: 'MPESA-XYZ' });
    expect((await call('POST', `/v1/admin/payouts/${w.json().id}/failed`, samuel, { reason: 'late' })).json().error.code).toBe('ALREADY_SETTLED');

    expect((await call('POST', `/v1/admin/riders/${rider.id}/adjustments`, faith, { amountCents: 20_000, note: 'Weather bonus' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/riders/${rider.id}/adjustments`, samuel, { amountCents: -999_999, note: 'Too much' })).json().error.code).toBe('NEGATIVE_BALANCE');
    expect((await call('POST', `/v1/admin/riders/${rider.id}/adjustments`, samuel, { amountCents: 20_000, note: 'Weather bonus' })).statusCode).toBe(204);
    const w2 = await call('POST', '/v1/rider/withdrawals', rider.token, { amountCents: 10_000 });
    const failed = await call('POST', `/v1/admin/payouts/${w2.json().id}/failed`, samuel, { reason: 'Number not registered for M-Pesa' });
    expect(failed.json().status).toBe('failed');
    expect((await call('GET', '/v1/rider/earnings', rider.token)).json().balanceCents).toBe(40_000 - 30_000 - 1_500 + 20_000);
    expect((await call('GET', '/v1/admin/payouts?status=paid', samuel)).json().items).toHaveLength(1);
    await expect(h.db.query('DELETE FROM rider_ledger')).rejects.toThrow(/append-only/);
  });
});

describe('offers that go nowhere', () => {
  let rider: { id: string; token: string };
  beforeAll(async () => { rider = await newRider('+254722000001', 'Busy Rider'); await goOnline(rider); });

  it('returns an unanswered offer to the pool when it expires', async () => {
    const { order } = await placeOrder();
    const a = await call('POST', `/v1/admin/dispatch/orders/${order.id}/assign`, james, { riderId: rider.id });
    await h.db.query(`UPDATE deliveries SET offer_expires_at = now() - interval '1 second' WHERE id = $1`, [a.json().id]);
    expect((await call('POST', `/v1/rider/offers/${a.json().id}/accept`, rider.token)).json().error.code).toBe('OFFER_GONE');
    expect((await board()).unassigned.map((x) => x.orderId)).toContain(order.id);
    const hist = (await call('GET', `/v1/admin/dispatch/orders/${order.id}/history`, james)).json();
    expect(hist.attempts.map((x: { outcome: string }) => x.outcome)).toEqual(['offered', 'expired']);
  });

  it('records a decline, then reassigns outright (even to an offline rider)', async () => {
    const { order } = await placeOrder();
    const a = await call('POST', `/v1/admin/dispatch/orders/${order.id}/assign`, james, { riderId: rider.id });
    expect((await call('POST', `/v1/rider/offers/${a.json().id}/decline`, rider.token, { reason: 'too_far' })).statusCode).toBe(204);
    await call('PUT', '/v1/rider/availability', rider.token, { online: false });
    const soft = await call('POST', `/v1/admin/dispatch/orders/${order.id}/assign`, james, { riderId: rider.id });
    expect(soft.json().error.code).toBe('RIDER_OFFLINE');
    const forced = await call('POST', `/v1/admin/dispatch/orders/${order.id}/assign`, james, { riderId: rider.id, force: true, note: 'Phoned them' });
    expect(forced.json().status).toBe('accepted');
    const hist = (await call('GET', `/v1/admin/dispatch/orders/${order.id}/history`, james)).json();
    expect(hist.attempts.map((x: { outcome: string }) => x.outcome)).toEqual(['offered', 'declined', 'accepted']);
    expect((await call('POST', `/v1/admin/dispatch/orders/${order.id}/unassign`, james)).statusCode).toBe(204);
    expect((await board()).unassigned.map((x) => x.orderId)).toContain(order.id);
  });

  it('only assigns paid orders to approved riders', async () => {
    const unpaid = await placeOrder({ pay: false });
    expect((await call('POST', `/v1/admin/dispatch/orders/${unpaid.order.id}/assign`, james, { riderId: rider.id, force: true })).json().error.code).toBe('NOT_DISPATCHABLE');
    const pending = await newRider('+254722000009', 'Pending Rider', { approve: false });
    const paid = await placeOrder();
    expect((await call('POST', `/v1/admin/dispatch/orders/${paid.order.id}/assign`, james, { riderId: pending.id, force: true })).json().error.code).toBe('RIDER_NOT_APPROVED');
  });
});

describe('failed deliveries and incidents', () => {
  let rider: { id: string; token: string };
  beforeAll(async () => { rider = await newRider('+254733000001', 'Unlucky Rider'); await goOnline(rider); });

  it('lists a failed delivery as an exception until dispatch deals with it', async () => {
    const { order } = await placeOrder();
    const a = await call('POST', `/v1/admin/dispatch/orders/${order.id}/assign`, james, { riderId: rider.id, force: true });
    expect((await call('POST', `/v1/rider/deliveries/${a.json().id}/fail`, rider.token, { reason: 'Customer unavailable', note: 'Phone off' })).statusCode).toBe(204);
    const ex = (await call('GET', '/v1/admin/exceptions', james)).json().items as { id: string; reason: string; kind: string; rider: string; customer: string }[];
    expect(ex[0]).toMatchObject({ kind: 'Failed', rider: 'Unlucky Rider', customer: 'Wanjiku Njoroge' });
    expect(ex[0]!.reason).toContain('Customer unavailable');
    expect((await board()).unassigned.map((x) => x.orderId)).toContain(order.id); // can be sent out again
    expect((await call('POST', `/v1/admin/exceptions/${ex[0]!.id}/resolve`, grace, { note: 'Called the customer' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/exceptions/${ex[0]!.id}/resolve`, james, { note: 'Called the customer, will retry' })).statusCode).toBe(204);
    expect((await call('GET', '/v1/admin/exceptions', james)).json().items).toHaveLength(0);
    expect((await call('GET', '/v1/admin/exceptions?state=resolved', james)).json().items).toHaveLength(1);
  });

  it('flags an order cancelled while the rider is already on it', async () => {
    const { order, customer } = await placeOrder();
    await call('POST', `/v1/admin/dispatch/orders/${order.id}/assign`, james, { riderId: rider.id, force: true });
    expect((await h.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/cancel`, headers: { authorization: `Bearer ${customer}` }, payload: { reason: 'Changed my mind' } })).statusCode).toBe(200);
    const ex = (await call('GET', '/v1/admin/exceptions', james)).json().items as { order: string; kind: string; reason: string }[];
    expect(ex[0]).toMatchObject({ kind: 'Cancelled', reason: 'Changed my mind' });
    expect((await call('GET', '/v1/rider/active', rider.token)).json().active).toBeNull();
    await expectInvariant();
  });

  it('turns a rider’s SOS into a critical incident dispatch can work', async () => {
    const r = await call('POST', '/v1/rider/incidents', rider.token, { type: 'Road accident', sos: true, note: 'Hit by a matatu', lat: -1.28, lng: 36.81 });
    expect(r.statusCode).toBe(201);
    const list = (await call('GET', '/v1/admin/incidents', james)).json().items as { id: string; number: string; severity: string; status: string; sos: boolean }[];
    expect(list[0]).toMatchObject({ severity: 'critical', status: 'open', sos: true });
    expect(list[0]!.number).toMatch(/^SOS-/);
    const up = await call('POST', `/v1/admin/incidents/${list[0]!.id}`, james, { status: 'investigating', note: 'Called the rider, ambulance on the way' });
    expect(up.json()).toMatchObject({ status: 'investigating' });
    expect(up.json().log.map((l: { text: string }) => l.text)).toEqual(['Road accident reported: Hit by a matatu', 'Started investigating', 'Called the rider, ambulance on the way']);
    expect((await call('POST', `/v1/admin/incidents/${list[0]!.id}`, grace, { status: 'resolved' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/incidents/${list[0]!.id}`, faith, { status: 'resolved' })).json().status).toBe('resolved');
    expect((await call('GET', '/v1/admin/incidents?status=open', james)).json().items).toHaveLength(0);
  });
});

describe('rosters', () => {
  it('rosters approved riders by day and swaps a shift', async () => {
    const r = await newRider('+254744000001', 'Rostered Rider');
    const day = '2026-12-07';
    const s = await call('PUT', '/v1/admin/shifts', faith, { riderId: r.id, day, window: '6 AM – 2 PM', zoneId: zoneKilimani });
    expect(s.json()).toMatchObject({ rider: 'Rostered Rider', window: '6 AM – 2 PM', zone: 'Kilimani' });
    await call('PUT', '/v1/admin/shifts', faith, { riderId: r.id, day, window: '2 PM – 10 PM', zoneId: null });
    const list = (await call('GET', `/v1/admin/shifts?from=${day}&to=${day}`, faith)).json().items as { window: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.window).toBe('2 PM – 10 PM');
    const pend = await newRider('+254744000002', 'Not Yet', { approve: false });
    expect((await call('PUT', '/v1/admin/shifts', faith, { riderId: pend.id, day, window: 'x' })).json().error.code).toBe('NOT_APPROVED');
    expect((await call('DELETE', `/v1/admin/shifts?riderId=${r.id}&day=${day}`, faith)).statusCode).toBe(204);
    expect((await call('GET', `/v1/admin/shifts?from=${day}&to=${day}`, faith)).json().items).toHaveLength(0);
  });
});
