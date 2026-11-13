import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';
import { DarajaClient } from '../../src/modules/integrations/mpesa.js';
import { AfricasTalkingSms } from '../../src/modules/integrations/sms.js';
import { loadConfig } from '../../src/config/index.js';
import pino from 'pino';

const PW = 'Sunrise#2025!';
const SECRET = 'a-long-callback-secret-for-tests-1234';
let h: Harness;
const dir = mkdtempSync(join(tmpdir(), 'shopcore-uploads-'));
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, token: string | null, body?: unknown) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} });
async function staffToken(email: string) {
  const r = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PW } });
  if (r.statusCode !== 200) throw new Error(r.body);
  return r.json().accessToken as string;
}
let owner: string, ruth: string, grace: string, kevin: string;
let tote: string, odd: string;

async function order(user: string, productId = tote, method: 'mpesa' | 'cod' = 'mpesa') {
  const t = await h.token(user, ['customer']);
  const res = await h.app.inject({ method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${t}`, 'idempotency-key': idemKey() }, payload: { items: [{ productId, quantity: 1 }], paymentMethod: method } });
  expect(res.statusCode).toBe(201);
  return { ...(res.json() as { id: string; totalCents: number; status: string }), token: t };
}
const stk = (o: { id: string; token: string }, phone = '0712 345 678') => h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/pay/mpesa`, headers: { authorization: `Bearer ${o.token}` }, payload: { phone } });
const callback = (checkout: string, code: number, over: { amount?: number; receipt?: string } = {}, secret = SECRET) =>
  h.app.inject({ method: 'POST', url: `/v1/webhooks/mpesa/${secret}`, payload: {
    Body: { stkCallback: { MerchantRequestID: 'm1', CheckoutRequestID: checkout, ResultCode: code, ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
      ...(code === 0 ? { CallbackMetadata: { Item: [{ Name: 'Amount', Value: over.amount }, { Name: 'MpesaReceiptNumber', Value: over.receipt ?? `QK${uuidv7().slice(-8).toUpperCase()}` }, { Name: 'PhoneNumber', Value: 254712345678 }] } } : {}) } } } });

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const upload = (token: string | null, kind: string, type: string, body: Buffer) =>
  h.app.inject({ method: 'PUT', url: `/v1/uploads?kind=${kind}&name=${encodeURIComponent('my photo.jpg')}`, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': type }, payload: body });

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ MPESA_ENV: 'simulator', MPESA_CALLBACK_SECRET: SECRET, MPESA_CALLBACK_BASE_URL: 'https://api.example.test', UPLOAD_DIR: dir, UPLOAD_MAX_BYTES: '20000', RIDER_DEV_OTP: '123456' });
  const s = h.c.staff;
  await s.ensureDefaultRoles();
  const add = (n: string, e: string, r: string) => s.insertRaw({ name: n, email: e, role: r, status: 'active', password: PW, mustChange: false });
  await add('Amara', 'amara@t.co', 'Owner admin');
  await add('Ruth', 'ruth@t.co', 'Marketing manager');
  await add('Grace', 'grace@t.co', 'Customer support');
  await add('Kevin', 'kevin@t.co', 'Inventory manager');
  [owner, ruth, grace, kevin] = await Promise.all(['amara', 'ruth', 'grace', 'kevin'].map((n) => staffToken(`${n}@t.co`))) as string[] as [string, string, string, string];
  tote = (await call('POST', '/v1/admin/products', kevin, { sku: 'TOTE-1', name: 'Leather Tote', priceCents: 485_000, currency: 'KES', initialStock: 100 })).json().id;
  odd = (await call('POST', '/v1/admin/products', kevin, { sku: 'ODD-1', name: 'Odd price', priceCents: 10_050, currency: 'KES', initialStock: 100 })).json().id;
});
afterAll(async () => { await h.close(); rmSync(dir, { recursive: true, force: true }); });

describe('paying with M-Pesa', () => {
  it('sends a prompt, then marks the order paid when Safaricom reports the money, once', async () => {
    const o = await order(uuidv7());
    const sent = await stk(o);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ checkoutRequestId: expect.stringContaining('ws_CO_'), message: expect.stringContaining('PIN') });
    expect((await call('GET', `/v1/orders/${o.id}/pay/mpesa`, o.token)).json()).toMatchObject({ status: 'pending', receipt: null });
    expect((await stk(o)).json().error.code).toBe('PROMPT_PENDING');

    expect((await callback(sent.json().checkoutRequestId, 0, { amount: o.totalCents / 100 }, 'wrong-secret-wrong-secret-wrong')).statusCode).toBe(403);
    const receipt = 'QKR12345AB';
    expect((await callback(sent.json().checkoutRequestId, 0, { amount: o.totalCents / 100, receipt })).json()).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect((await call('GET', `/v1/orders/${o.id}`, o.token)).json().status).toBe('PAID');
    expect((await call('GET', `/v1/orders/${o.id}/pay/mpesa`, o.token)).json()).toMatchObject({ status: 'success', receipt });
    expect((await h.db.query('SELECT payment_ref FROM orders WHERE id = $1', [o.id])).rows[0].payment_ref).toBe(receipt);
    // Safaricom retrying the same result changes nothing.
    expect((await callback(sent.json().checkoutRequestId, 0, { amount: o.totalCents / 100, receipt })).statusCode).toBe(200);
    expect((await stk(o)).json().error.code).toBe('NOT_PAYABLE');
  });

  it('keeps an order unpaid when the amount doesn’t match, and flags it', async () => {
    const o = await order(uuidv7());
    const ack = (await stk(o)).json();
    await callback(ack.checkoutRequestId, 0, { amount: 100, receipt: 'QKSHORT01' });
    expect((await call('GET', `/v1/orders/${o.id}`, o.token)).json().status).toBe('PENDING_PAYMENT');
    expect((await call('GET', `/v1/orders/${o.id}/pay/mpesa`, o.token)).json()).toMatchObject({ status: 'failed', message: expect.stringContaining('didn’t match') });
    expect((await h.db.query(`SELECT 1 FROM audit_log WHERE action = 'mpesa.mismatch' AND entity_id = $1`, [o.id])).rowCount).toBe(1);
  });

  it('records a failed or cancelled prompt in the failed-payments list, and allows another try', async () => {
    const o = await order(uuidv7());
    const ack = (await stk(o)).json();
    await callback(ack.checkoutRequestId, 1032);
    expect((await call('GET', `/v1/orders/${o.id}/pay/mpesa`, o.token)).json()).toMatchObject({ status: 'cancelled', message: 'Cancelled by customer' });
    const fails = (await call('GET', '/v1/admin/payments?failuresOnly=true', owner)).json().items;
    expect(fails).toContainEqual(expect.objectContaining({ orderId: o.id, reason: 'Cancelled by customer', ref: ack.checkoutRequestId }));
    await h.db.query(`UPDATE mpesa_requests SET created_at = now() - interval '5 minutes' WHERE order_id = $1`, [o.id]);
    expect((await stk(o)).statusCode).toBe(200);
  });

  it('refuses what it should: someone else’s order, pay-on-delivery orders, odd phone numbers, cents, and junk callbacks', async () => {
    const o = await order(uuidv7());
    const stranger = { ...o, token: await h.token(uuidv7(), ['customer']) };
    expect((await stk(stranger)).statusCode).toBe(404);
    expect((await stk(o, '0212345678')).json().error.code).toBe('BAD_PHONE');
    const cod = await order(uuidv7(), tote, 'cod');
    expect((await stk(cod)).json().error.code).toMatch(/PAY_ON_DELIVERY|NOT_PAYABLE/);
    const cents = await order(uuidv7(), odd);
    expect((await stk(cents)).json().error.code).toBe('AMOUNT_NOT_WHOLE_SHILLINGS');
    expect((await h.app.inject({ method: 'POST', url: `/v1/webhooks/mpesa/${SECRET}`, payload: { nonsense: true } })).json()).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect((await callback('ws_CO_unknown_request_1', 0, { amount: 1 })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/pay/mpesa`, payload: { phone: '0712345678' } })).statusCode).toBe(401);
  });
});

describe('the providers’ requests', () => {
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', JWT_ISSUER: 'x', JWT_AUDIENCE: 'x', JWT_PUBLIC_KEY: 'x', MPESA_ENV: 'sandbox', MPESA_CONSUMER_KEY: 'key', MPESA_CONSUMER_SECRET: 'secret', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'pass', MPESA_CALLBACK_BASE_URL: 'https://api.example.test', MPESA_CALLBACK_SECRET: SECRET }, 'worker');

  it('asks Daraja for a token, then a prompt with the right shape', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return url.includes('/oauth/') ? new Response(JSON.stringify({ access_token: 'tok', expires_in: '3599' })) : new Response(JSON.stringify({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', MerchantRequestID: 'm-1' }));
    }) as unknown as typeof fetch;
    const c = new DarajaClient(cfg, fake);
    const ack = await c.stkPush({ phone: '254712345678', amountKes: 4850, accountRef: 'SC-4961', description: 'ShopCore', callbackUrl: `https://api.example.test/v1/webhooks/mpesa/${SECRET}` });
    expect(ack).toEqual({ checkoutRequestId: 'ws_CO_1', merchantRequestId: 'm-1' });
    expect(seen[0]!.url).toBe('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    expect((seen[0]!.init!.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('key:secret').toString('base64')}`);
    const body = JSON.parse(String(seen[1]!.init!.body));
    expect(body).toMatchObject({ BusinessShortCode: '174379', Amount: 4850, PartyA: '254712345678', PartyB: '174379', TransactionType: 'CustomerPayBillOnline', AccountReference: 'SC-4961' });
    expect(Buffer.from(body.Password, 'base64').toString()).toBe(`174379pass${body.Timestamp}`);
    expect((seen[1]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    await c.stkPush({ phone: '254712345678', amountKes: 1, accountRef: 'x', description: 'x', callbackUrl: 'x' });
    expect(seen.filter((s) => s.url.includes('/oauth/'))).toHaveLength(1); // the token is reused
    const refused = new DarajaClient(cfg, (async (url: string) => (url.includes('/oauth/') ? new Response(JSON.stringify({ access_token: 't', expires_in: '3599' })) : new Response(JSON.stringify({ errorMessage: 'Bad Request - Invalid PhoneNumber' }), { status: 400 }))) as unknown as typeof fetch);
    await expect(refused.stkPush({ phone: '1', amountKes: 1, accountRef: 'x', description: 'x', callbackUrl: 'x' })).rejects.toMatchObject({ code: 'MPESA_REFUSED', message: expect.stringContaining('Invalid PhoneNumber') });
  });

  it('sends text messages through Africa’s Talking, and says so when one isn’t accepted', async () => {
    const log = pino({ level: 'silent' });
    let sent: { url: string; body: URLSearchParams; key: string } | undefined;
    const ok = (async (url: string, init: RequestInit) => { sent = { url, body: init.body as URLSearchParams, key: (init.headers as Record<string, string>).apiKey! }; return new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ status: 'Success', statusCode: 101 }] } })); }) as unknown as typeof fetch;
    await new AfricasTalkingSms('sandbox', 'k', 'SHOPCORE', log, ok).send('+254712345678', 'Your code is 123456');
    expect(sent!.url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
    expect(Object.fromEntries(sent!.body)).toEqual({ username: 'sandbox', to: '+254712345678', message: 'Your code is 123456', from: 'SHOPCORE' });
    expect(sent!.key).toBe('k');
    const bad = (async () => new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ status: 'InvalidPhoneNumber', statusCode: 403 }] } }))) as unknown as typeof fetch;
    await expect(new AfricasTalkingSms('acme', 'k', undefined, log, bad).send('+254', 'x')).rejects.toThrow(/not accepted/);
    const down = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(new AfricasTalkingSms('acme', 'k', undefined, log, down).send('+254712345678', 'x')).rejects.toThrow(/500/);
  });

  it('refuses unsafe or incomplete settings', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', JWT_ISSUER: 'x', JWT_AUDIENCE: 'x', JWT_PUBLIC_KEY: 'x' };
    expect(() => loadConfig({ ...base, MPESA_ENV: 'sandbox' }, 'worker')).toThrow(/MPESA_CONSUMER_KEY/);
    expect(() => loadConfig({ ...base, SMS_PROVIDER: 'africastalking' }, 'worker')).toThrow(/AT_USERNAME/);
    expect(() => loadConfig({ ...base, MPESA_ENV: 'simulator' }, 'worker')).toThrow(/MPESA_CALLBACK_SECRET/);
  });
});

describe('photos and documents', () => {
  it('keeps a customer’s upload to them and to staff, and checks the bytes are really a picture', async () => {
    const me = uuidv7();
    const mine = await h.token(me, ['customer']);
    const up = await upload(mine, 'return-photo', 'image/jpeg', JPEG);
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ kind: 'return-photo', contentType: 'image/jpeg', sizeBytes: JPEG.length, name: 'my photo.jpg', url: expect.stringMatching(/^\/v1\/files\//) });
    const get = (token: string | null) => h.app.inject({ method: 'GET', url: up.json().url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    const own = await get(mine);
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toBe('image/jpeg');
    expect(own.headers['x-content-type-options']).toBe('nosniff');
    expect(own.headers['cache-control']).toContain('private');
    expect(own.rawPayload.equals(JPEG)).toBe(true);
    expect((await get(await h.token(uuidv7(), ['customer']))).statusCode).toBe(403);
    expect((await get(null)).statusCode).toBe(403);
    expect((await get(grace)).statusCode).toBe(200);

    expect((await upload(mine, 'return-photo', 'image/jpeg', PNG)).json().error.code).toBe('FILE_CORRUPT');
    expect((await upload(mine, 'return-photo', 'image/png', Buffer.from('<script>alert(1)</script>'))).json().error.code).toBe('FILE_CORRUPT');
    expect((await upload(mine, 'return-photo', 'application/pdf', PDF)).json().error.code).toBe('FILE_TYPE');
    expect((await upload(mine, 'return-photo', 'image/jpeg', Buffer.alloc(0))).statusCode).toBe(422);
    expect((await upload(mine, 'return-photo', 'image/jpeg', Buffer.concat([JPEG, Buffer.alloc(30_000)]))).statusCode).toBe(413);
    expect((await upload(mine, 'return-photo', 'text/html', Buffer.from('<b>x</b>'))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await upload(null, 'return-photo', 'image/jpeg', JPEG)).statusCode).toBe(401);
    expect((await upload(mine, 'nonsense', 'image/jpeg', JPEG)).statusCode).toBe(400);
  });

  it('lets only the right people upload each kind, and shows banner pictures to everyone', async () => {
    const cust = await h.token(uuidv7(), ['customer']);
    expect((await upload(cust, 'banner', 'image/jpeg', JPEG)).statusCode).toBe(403);
    expect((await upload(cust, 'rider-document', 'application/pdf', PDF)).statusCode).toBe(403);
    expect((await upload(grace, 'banner', 'image/png', PNG)).statusCode).toBe(403);
    const b = await upload(ruth, 'banner', 'image/png', PNG);
    expect(b.statusCode).toBe(201);
    const pub = await h.app.inject({ method: 'GET', url: b.json().url });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['cache-control']).toContain('public');
    expect((await upload(owner, 'banner', 'application/pdf', PDF)).json().error.code).toBe('FILE_TYPE');
    expect((await h.app.inject({ method: 'GET', url: `/v1/files/${uuidv7()}` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/v1/files/not-a-uuid' })).statusCode).toBe(400);
    // A banner can carry the picture's reference.
    expect((await call('POST', '/v1/admin/banners', ruth, { title: 'Pic', link: '/', startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), alt: 'A picture', imageRef: b.json().url, published: true })).json().imageRef).toBe(b.json().url);
  });
});

describe('the shop catalogue', () => {
  it('lists what can be bought with pictures, categories and stock, with no sign-in', async () => {
    const cat = (await call('POST', '/v1/admin/categories', kevin, { name: 'Bags', handle: 'bags' })).json();
    const bag = (await call('POST', '/v1/admin/products', kevin, { sku: 'BAG-9', name: 'Canvas Bag', description: 'Roomy.', priceCents: 250_000, currency: 'KES', initialStock: 5, categoryId: cat.id })).json();
    const gone = (await call('POST', '/v1/admin/products', kevin, { sku: 'OLD-1', name: 'Old stock', priceCents: 100, currency: 'KES', initialStock: 0 })).json();
    expect((await h.app.inject({ method: 'PATCH', url: `/v1/admin/products/${gone.id}`, headers: { authorization: `Bearer ${kevin}`, 'if-match': '1' }, payload: { status: 'archived' } })).statusCode).toBe(200);
    const pic = (await upload(kevin, 'product-image', 'image/jpeg', JPEG)).json();
    expect((await call('PUT', `/v1/admin/products/${bag.id}/images`, grace, { uploadIds: [pic.id] })).statusCode).toBe(403);
    const banner = (await upload(ruth, 'banner', 'image/png', PNG)).json();
    expect((await call('PUT', `/v1/admin/products/${bag.id}/images`, kevin, { uploadIds: [banner.id] })).json().error.code).toBe('BAD_IMAGE');
    expect((await call('PUT', `/v1/admin/products/${bag.id}/images`, kevin, { uploadIds: [pic.id] })).json()).toEqual({ productId: bag.id, images: [pic.url] });

    const res = await h.app.inject({ method: 'GET', url: '/v1/storefront/catalogue' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    const c = res.json();
    expect(c.categories).toContainEqual(expect.objectContaining({ id: cat.id, handle: 'bags', name: 'Bags' }));
    const p = c.products.find((x: { id: string }) => x.id === bag.id);
    expect(p).toMatchObject({ name: 'Canvas Bag', priceCents: 250_000, listPriceCents: 250_000, onSale: false, inStock: true, available: 5, categoryHandle: 'bags', images: [pic.url], rating: null, reviews: 0 });
    expect(c.products.find((x: { id: string }) => x.id === gone.id)).toBeUndefined();
    // The picture link works without signing in.
    expect((await h.app.inject({ method: 'GET', url: p.images[0] })).statusCode).toBe(200);
  });
});
