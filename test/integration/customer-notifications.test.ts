import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness } from '../helpers.js';

let h: Harness;
let owner: string, shopper: string, product: string;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token: string | null, body?: unknown) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} });
const drain = async () => { for (let i = 0; i < 5; i++) if ((await h.c.push.drain()) === 0) break; };

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ CUSTOMER_DEV_OTP: '482913' });
  await h.c.staff.ensureDefaultRoles();
  await h.c.staff.insertRaw({ name: 'Amara', email: 'amara@t.co', role: 'Owner admin', status: 'active', password: 'Sunrise#2025!', mustChange: false });
  owner = (await call('POST', '/v1/auth/login', null, { email: 'amara@t.co', password: 'Sunrise#2025!' })).json().accessToken;
  product = (await call('POST', '/v1/admin/products', owner, { sku: 'N-1', name: 'Woven Basket', priceCents: 120_000, currency: 'KES', initialStock: 5 })).json().id;
  await call('POST', '/v1/customer/auth/signup', null, { fullName: 'Note Taker', email: 'note@example.com', phone: '+254712000888', password: 'sunrise2025' });
  shopper = (await call('POST', '/v1/customer/auth/verify-signup', null, { phone: '+254712000888', code: '482913' })).json().accessToken;
  await call('POST', '/v1/customer/push-token', shopper, { token: 'ExponentPushToken[shopper000111]' });
});
afterAll(async () => { await h.close(); });

describe('shopper notifications beyond order updates', () => {
  it('sends a campaign only to shoppers who opted in, in their chosen language setting', async () => {
    h.c.push.sent.length = 0;
    const draft = { title: 'Weekend sale', body: '20% off baskets', segmentId: '00000000-0000-7000-8000-000000000001', quiet: false, cap: false, action: 'now' };
    expect((await call('POST', '/v1/admin/pushes', owner, draft)).statusCode).toBe(201);
    await drain();
    expect(h.c.push.sent).toHaveLength(0); // not opted in yet
    const pr = await call('PATCH', '/v1/customer/preferences', shopper, { push: true });
    expect(pr.json()).toMatchObject({ push: true, deals: false });
    expect((await call('POST', '/v1/admin/pushes', owner, draft)).statusCode).toBe(201);
    await drain();
    expect(h.c.push.sent).toHaveLength(0); // offers are opt-in too
    await call('PATCH', '/v1/customer/preferences', shopper, { deals: true });
    expect((await call('POST', '/v1/admin/pushes', owner, draft)).statusCode).toBe(201);
    await drain();
    expect(h.c.push.sent.at(-1)).toMatchObject({ to: 'ExponentPushToken[shopper000111]', title: 'Weekend sale', body: '20% off baskets' });
  });

  it('tells shoppers when a saved item is back in stock, unless they turned stock alerts off', async () => {
    await call('PATCH', '/v1/customer/preferences', shopper, { stock: true });
    expect((await call('POST', '/v1/customer/wishlist', shopper, { productId: product })).statusCode).toBeLessThan(300);
    await h.db.query('UPDATE inventory SET available = 0 WHERE product_id = $1', [product]);
    h.c.push.sent.length = 0;
    await h.db.query('UPDATE inventory SET available = 4 WHERE product_id = $1', [product]);
    await drain();
    expect(h.c.push.sent.at(-1)).toMatchObject({ title: 'Back in stock', body: 'Woven Basket is available again.' });
    await call('PATCH', '/v1/customer/preferences', shopper, { stock: false });
    const n = h.c.push.sent.length;
    await h.db.query('UPDATE inventory SET available = 0 WHERE product_id = $1', [product]);
    await h.db.query('UPDATE inventory SET available = 3 WHERE product_id = $1', [product]);
    await drain();
    expect(h.c.push.sent).toHaveLength(n);
  });

  it('writes notifications in Kiswahili once the shopper picks it', async () => {
    expect((await call('PATCH', '/v1/customer/preferences', shopper, { language: 'sw', stock: true })).json()).toMatchObject({ language: 'sw' });
    await h.db.query('UPDATE inventory SET available = 0 WHERE product_id = $1', [product]);
    h.c.push.sent.length = 0;
    await h.db.query('UPDATE inventory SET available = 2 WHERE product_id = $1', [product]);
    await drain();
    expect(h.c.push.sent.at(-1)).toMatchObject({ title: 'Imerudi dukani' });
    expect((await call('PATCH', '/v1/customer/preferences', shopper, { language: 'fr' })).statusCode).toBe(400);
  });
});
