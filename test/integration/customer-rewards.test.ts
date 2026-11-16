import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';
import { rewardDelivered } from '../../src/modules/customers/rewards.js';

let h: Harness;
let owner: string, product: string;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

async function join(name: string, phone: string, referralCode?: string) {
  const su = await call('POST', '/v1/customer/auth/signup', null, { fullName: name, email: `${phone.slice(-4)}@example.com`, phone, password: 'sunrise2025', ...(referralCode ? { referralCode } : {}) });
  expect(su.statusCode).toBe(202);
  return (await call('POST', '/v1/customer/auth/verify-signup', null, { phone, code: '482913' })).json().accessToken as string;
}
const order = async (token: string, couponCode?: string) => {
  const r = await call('POST', '/v1/orders', token, { items: [{ productId: product, quantity: 1 }], paymentMethod: 'cod', ...(couponCode ? { couponCode } : {}), delivery: { name: 'Pat', phone: '+254 712 555 001', area: 'Kilimani', address: 'Argwings Kodhek Rd' } }, { 'idempotency-key': idemKey() });
  expect(r.statusCode).toBe(201);
  return r.json() as { id: string; totalCents: number; discountCents?: number };
};
const deliver = (orderId: string) => h.c.db.tx((c) => rewardDelivered(c, orderId));

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ CUSTOMER_DEV_OTP: '482913' });
  await h.c.staff.ensureDefaultRoles();
  await h.c.staff.insertRaw({ name: 'Amara', email: 'amara@t.co', role: 'Owner admin', status: 'active', password: 'Sunrise#2025!', mustChange: false });
  owner = (await call('POST', '/v1/auth/login', null, { email: 'amara@t.co', password: 'Sunrise#2025!' })).json().accessToken;
  await call('POST', '/v1/admin/zones', owner, { name: 'Kilimani', feeCents: 25_000, areas: ['Kilimani'] });
  product = (await call('POST', '/v1/admin/products', owner, { sku: 'R-1', name: 'Clay Pot', priceCents: 1_000_000, currency: 'KES', initialStock: 50 })).json().id;
});
afterAll(async () => { await h.close(); });

describe('shopper points and referrals', () => {
  it('earns points on delivery, rewards both sides of a referral once, and turns points into a one-time code', async () => {
    const ann = await join('Ann Referrer', '+254712100001');
    const start = (await call('GET', '/v1/customer/rewards', ann)).json();
    expect(start).toMatchObject({ points: 0 });
    const code = start.referral.code as string;
    expect(code).toMatch(/^[A-Z0-9]{8}$/);

    const ben = await join('Ben Friend', '+254712100002', code);
    const first = await order(ben);
    await deliver(first.id);
    await deliver(first.id); // confirming twice changes nothing
    // KES 10,000 of goods at 1 point per KES 100 = 100 points, plus 200 for the invite
    expect((await call('GET', '/v1/customer/rewards', ben)).json()).toMatchObject({ points: 300 });
    const annNow = (await call('GET', '/v1/customer/rewards', ann)).json();
    expect(annNow.points).toBe(200);
    expect(annNow.referral.invited).toEqual([{ name: 'Ben', rewarded: true }]);

    // the invite pays out only on the first order
    await deliver((await order(ben)).id);
    expect((await call('GET', '/v1/customer/rewards', ann)).json().points).toBe(200);
    expect((await call('GET', '/v1/customer/rewards', ben)).json().points).toBe(400);

    // redeeming: not too few, not more than you have, then a code that really takes money off
    expect((await call('POST', '/v1/customer/rewards/redeem', ben, { points: 10 })).json().error.code).toBe('BELOW_MINIMUM');
    expect((await call('POST', '/v1/customer/rewards/redeem', ben, { points: 9000 })).json().error.code).toBe('NOT_ENOUGH_POINTS');
    const red = await call('POST', '/v1/customer/rewards/redeem', ben, { points: 200 });
    expect(red.statusCode).toBe(200);
    expect(red.json()).toMatchObject({ valueCents: 20_000, points: 200 });
    expect((await call('GET', '/v1/customer/rewards', ben)).json().points).toBe(200);
    const plain = await order(ann);
    const discounted = await order(ann, red.json().code);
    expect(plain.totalCents - discounted.totalCents).toBe(20_000);
  });

  it('lets staff change the programme and rejects an unknown invite code format', async () => {
    expect((await call('PUT', '/v1/admin/rewards-programme', owner, { earnPerHundredKes: 2, pointValueCents: 50, minRedeemPoints: 50, referralPoints: 500, couponDays: 30 })).statusCode).toBe(200);
    expect((await call('GET', '/v1/admin/rewards-programme', owner)).json()).toMatchObject({ earnPerHundredKes: 2, referralPoints: 500 });
    const bad = await call('POST', '/v1/customer/auth/signup', null, { fullName: 'Cy Test', email: 'cy@example.com', phone: '+254712100003', password: 'sunrise2025', referralCode: '!!' });
    expect(bad.statusCode).toBe(400);
  });
});
