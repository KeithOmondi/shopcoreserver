import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';

const PW = 'Sunrise#2025!';
let h: Harness;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
let owner: string, kevin: string, tote: string, scarce: string, retired: string;

const quote = async (user: string, items: { productId: string; quantity: number }[], area = 'Kilimani', couponCode?: string) =>
  call('POST', '/v1/coupons/quote', await h.token(user, ['customer']), { items, area, couponCode });
const order = async (user: string, items: { productId: string; quantity: number }[], over: Record<string, unknown> = {}, key = idemKey()) =>
  call('POST', '/v1/orders', await h.token(user, ['customer']), { items, paymentMethod: 'cod', delivery: { name: 'Wanjiku Njoroge', phone: '+254712555001', area: 'Kilimani', address: 'Argwings Kodhek Rd' }, ...over }, { 'idempotency-key': key });

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ RIDER_DEV_OTP: '123456' });
  await h.c.staff.ensureDefaultRoles();
  const add = (n: string, e: string, r: string) => h.c.staff.insertRaw({ name: n, email: e, role: r, status: 'active', password: PW, mustChange: false });
  await add('Amara', 'amara@t.co', 'Owner admin');
  await add('Kevin', 'kevin@t.co', 'Inventory manager');
  const login = async (email: string) => (await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PW } })).json().accessToken as string;
  [owner, kevin] = [await login('amara@t.co'), await login('kevin@t.co')];
  await call('POST', '/v1/admin/zones', owner, { name: 'Kilimani', feeCents: 25_000, areas: ['Kilimani'] });
  await call('PUT', '/v1/admin/delivery-settings', owner, { baseFeeCents: 30_000, minBasketCents: 100_000 });
  const mk = async (sku: string, name: string, priceCents: number, stock: number) => (await call('POST', '/v1/admin/products', kevin, { sku, name, priceCents, currency: 'KES', initialStock: stock })).json().id as string;
  tote = await mk('TOTE-1', 'Leather Tote', 485_000, 50);
  scarce = await mk('RARE-1', 'Rare Watch', 150_000, 2);
  retired = await mk('OLD-1', 'Old Bag', 200_000, 5);
  expect((await call('PATCH', `/v1/admin/products/${retired}`, kevin, { status: 'archived' }, { 'if-match': '1' })).statusCode).toBe(200);
});
afterAll(async () => { await h.close(); });

describe('the checkout quote', () => {
  it('prices a basket with the delivery fee for the area, and says it can be ordered', async () => {
    const q = (await quote(uuidv7(), [{ productId: tote, quantity: 2 }])).json();
    expect(q).toMatchObject({ subtotalCents: 970_000, deliveryFeeCents: 25_000, discountCents: 0, totalCents: 995_000, canOrder: true, issues: [], unavailable: [] });
    expect(q.lines[0]).toMatchObject({ productId: tote, quantity: 2, unitCents: 485_000, available: 50 });
  });

  it('reports what is wrong with a basket instead of failing, line by line', async () => {
    const q = (await quote(uuidv7(), [{ productId: scarce, quantity: 5 }, { productId: retired, quantity: 1 }, { productId: tote, quantity: 1 }])).json();
    expect(q.canOrder).toBe(false);
    expect(q.unavailable).toEqual([retired]);
    expect(q.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INSUFFICIENT_STOCK', productId: scarce, available: 2, message: expect.stringContaining('Only 2') }),
      expect.objectContaining({ code: 'PRODUCT_UNAVAILABLE', productId: retired }),
    ]));
    // The goods that can be bought are still priced.
    expect(q.subtotalCents).toBe(5 * 150_000 + 485_000);
  });

  it('flags a basket below the delivery minimum and an area the shop doesn’t serve', async () => {
    const small = await h.token(uuidv7(), ['customer']);
    const cheap = (await call('POST', '/v1/admin/products', kevin, { sku: 'SOCK-1', name: 'Socks', priceCents: 20_000, currency: 'KES', initialStock: 9 })).json().id;
    const q = (await call('POST', '/v1/coupons/quote', small, { items: [{ productId: cheap, quantity: 1 }], area: 'Kilimani' })).json();
    expect(q.issues).toEqual([expect.objectContaining({ code: 'BELOW_MINIMUM_BASKET', message: expect.stringContaining('KES 1,000') })]);
    const far = (await quote(uuidv7(), [{ productId: tote, quantity: 1 }], 'Karen')).json();
    expect(far.issues).toEqual([expect.objectContaining({ code: 'AREA_NOT_SERVED' })]);
    expect(far.deliveryFeeCents).toBe(30_000); // the base fee
    expect(far.canOrder).toBe(false);
    // Without an area (the cart page) nothing about delivery is checked.
    const cart = (await call('POST', '/v1/coupons/quote', small, { items: [{ productId: tote, quantity: 1 }] })).json();
    expect(cart).toMatchObject({ deliveryFeeCents: 0, minBasketCents: 0, canOrder: false });
  });
});

describe('placing the order', () => {
  it('records the price breakdown, the delivery details and the payment method', async () => {
    const user = uuidv7();
    const res = await order(user, [{ productId: tote, quantity: 1 }]);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      orderNumber: expect.stringMatching(/^SC-\d+$/), status: 'PAID', subtotalCents: 485_000, deliveryFeeCents: 25_000, discountCents: 0, totalCents: 510_000, paymentMethod: 'cod',
      delivery: { name: 'Wanjiku Njoroge', phone: '+254712555001', area: 'Kilimani', address: 'Argwings Kodhek Rd' },
    });
  });

  it('prices a coupon the same at checkout as in the quote, and a mobile-money order waits for payment', async () => {
    const cp = await call('POST', '/v1/admin/coupons', owner, { name: 'Ten', code: 'TEN', type: 'percent', value: 10, limit: 100, startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), state: 'live' });
    expect(cp.statusCode).toBe(201);
    const user = uuidv7();
    const q = (await quote(user, [{ productId: tote, quantity: 1 }], 'Kilimani', 'TEN')).json();
    const res = await order(user, [{ productId: tote, quantity: 1 }], { paymentMethod: 'mpesa', couponCode: 'TEN' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'PENDING_PAYMENT', paymentMethod: 'mpesa', discountCents: q.discountCents, totalCents: q.totalCents, paidAt: null });
    expect(q.discountCents).toBe(48_500);
  });

  it('answers a retried request with the same order instead of a second one', async () => {
    const user = uuidv7();
    const key = idemKey();
    const first = await order(user, [{ productId: tote, quantity: 1 }], {}, key);
    const again = await order(user, [{ productId: tote, quantity: 1 }], {}, key);
    expect(first.statusCode).toBe(201);
    expect(again.json().id).toBe(first.json().id);
    const list = await call('GET', '/v1/orders', await h.token(user, ['customer']));
    expect(list.json().items).toHaveLength(1);
  });

  it('refuses a basket that can’t be fulfilled with the reason, and leaves no order behind', async () => {
    const user = uuidv7();
    const short = await order(user, [{ productId: scarce, quantity: 5 }]);
    expect(short.statusCode).toBe(409);
    expect(short.json().error.code).toBe('INSUFFICIENT_STOCK');
    expect((await order(user, [{ productId: retired, quantity: 1 }])).json().error.code).toBe('PRODUCT_UNAVAILABLE');
    expect((await call('GET', '/v1/orders', await h.token(user, ['customer']))).json().items).toHaveLength(0);
  });
});
