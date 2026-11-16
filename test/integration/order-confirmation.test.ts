import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrderConfirmationMailer } from '../../src/modules/orders/confirmation.js';
import { createHarness, resetDatabase, type Harness } from '../helpers.js';

let h: Harness;
let owner: string, product: string;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
let n = 0;
const sentMail: { to: string; subject: string; text: string }[] = [];
let failNext = false;
const mailer = () => new OrderConfirmationMailer(h.c.db, { send: async (m) => { if (failNext) { failNext = false; throw new Error('down'); } sentMail.push(m); } }, { warn: () => undefined, info: () => undefined } as never);

async function shopperWith(email: string, phone: string) {
  await call('POST', '/v1/customer/auth/signup', null, { fullName: 'Mail Test', email, phone, password: 'sunrise2025' });
  return (await call('POST', '/v1/customer/auth/verify-signup', null, { phone, code: '482913' })).json().accessToken as string;
}
const place = async (token: string) => (await call('POST', '/v1/orders', token, { items: [{ productId: product, quantity: 2 }], paymentMethod: 'cod', delivery: { name: 'Pat', phone: '+254 712 555 001', area: 'Kilimani', address: 'Argwings Kodhek Rd' } }, { 'idempotency-key': `mail-${++n}-${Date.now()}` })).json();

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ CUSTOMER_DEV_OTP: '482913' });
  await h.c.staff.ensureDefaultRoles();
  await h.c.staff.insertRaw({ name: 'Amara', email: 'amara@t.co', role: 'Owner admin', status: 'active', password: 'Sunrise#2025!', mustChange: false });
  owner = (await call('POST', '/v1/auth/login', null, { email: 'amara@t.co', password: 'Sunrise#2025!' })).json().accessToken;
  product = (await call('POST', '/v1/admin/products', owner, { sku: 'M-1', name: 'Woven Basket', priceCents: 120_000, currency: 'KES', initialStock: 20 })).json().id;
});
afterAll(async () => { await h.close(); });

describe('order confirmation emails', () => {
  it('emails one receipt per order, never twice, and retries a failed send', async () => {
    const token = await shopperWith('mail1@example.com', '+254712300001');
    const order = await place(token);
    expect(order.id ?? order.orderId).toBeTruthy();
    failNext = true;
    expect(await mailer().runDue()).toBe(0); // provider down: nothing sent, order left for later
    expect(await mailer().runDue()).toBe(1);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]).toMatchObject({ to: 'mail1@example.com' });
    expect(sentMail[0]!.subject).toMatch(/^Your ShopCore order SC-\d+$/);
    expect(sentMail[0]!.text).toContain('2 x Woven Basket');
    expect(sentMail[0]!.text).toContain('cash');
    expect(sentMail[0]!.text).toContain('Kilimani');
    expect(await mailer().runDue()).toBe(0); // already sent
    expect(sentMail).toHaveLength(1);
  });

  it('skips shoppers with no email without getting stuck on them', async () => {
    const token = await shopperWith('', '+254712300002');
    await place(token);
    expect(await mailer().runDue()).toBe(0);
    const { rows } = await h.db.query('SELECT count(*)::int AS n FROM orders WHERE confirmation_emailed_at IS NULL');
    expect(rows[0].n).toBe(0);
  });
});
