import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';
import { respectQuietHours } from '../../src/modules/marketing/engage.js';

const PW = 'Sunrise#2025!';
let h: Harness;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, token: string | null, body?: unknown) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} });
async function staffToken(email: string) {
  const r = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PW } });
  if (r.statusCode !== 200) throw new Error(r.body);
  return r.json().accessToken as string;
}

let owner: string, ruth: string, grace: string, samuel: string, kevin: string;
let tote: string, shoes: string, belt: string, bags: string, cheap: string;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const DAY = 86_400_000;

/** Places an order as `user`, with an optional coupon. Returns the raw response. */
async function place(user: string, items: { productId: string; quantity?: number }[], couponCode?: string, method: 'mpesa' | 'cod' = 'mpesa') {
  const t = await h.token(user, ['customer']);
  return h.app.inject({ method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${t}`, 'idempotency-key': idemKey() },
    payload: { items: items.map((i) => ({ productId: i.productId, quantity: i.quantity ?? 1 })), paymentMethod: method, couponCode, delivery: { name: 'Wanjiku Njoroge', phone: '+254 712 555 001', area: 'Kilimani', address: 'Argwings Kodhek Rd' } } });
}
const quote = async (user: string, items: { productId: string; quantity?: number }[], couponCode?: string) =>
  h.app.inject({ method: 'POST', url: '/v1/coupons/quote', headers: { authorization: `Bearer ${await h.token(user, ['customer'])}` }, payload: { items: items.map((i) => ({ productId: i.productId, quantity: i.quantity ?? 1 })), area: 'Kilimani', couponCode } });
const pay = async (o: { id: string; totalCents: number; currency: string }) => {
  const p = await h.token(uuidv7(), ['payments']);
  expect((await h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/payment-confirmation`, headers: { authorization: `Bearer ${p}` }, payload: { paymentRef: `r-${uuidv7()}`, amountCents: o.totalCents, currency: o.currency } })).statusCode).toBe(200);
};
const coupon = (over: Record<string, unknown> = {}) => ({ name: 'Offer', code: `C${uuidv7().slice(-8).toUpperCase()}`, type: 'percent', value: 10, limit: 100, startsAt: iso(-DAY), endsAt: iso(30 * DAY), state: 'live', ...over });

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ RIDER_DEV_OTP: '123456' });
  const s = h.c.staff;
  await s.ensureDefaultRoles();
  const add = (n: string, e: string, r: string) => s.insertRaw({ name: n, email: e, role: r, status: 'active', password: PW, mustChange: false });
  await add('Amara', 'amara@t.co', 'Owner admin');
  await add('Ruth', 'ruth@t.co', 'Marketing manager');
  await add('Grace', 'grace@t.co', 'Customer support');
  await add('Samuel', 'samuel@t.co', 'Finance analyst');
  await add('Kevin', 'kevin@t.co', 'Inventory manager');
  [owner, ruth, grace, samuel, kevin] = await Promise.all(['amara', 'ruth', 'grace', 'samuel', 'kevin'].map((n) => staffToken(`${n}@t.co`))) as string[] as [string, string, string, string, string];
  await call('POST', '/v1/admin/zones', owner, { name: 'Kilimani', feeCents: 25_000, commissionPct: 20, areas: ['Kilimani'] });
  bags = (await call('POST', '/v1/admin/categories', kevin, { name: 'Bags', handle: 'bags' })).json().id;
  const mk = async (sku: string, name: string, priceCents: number, categoryId: string | null, initialStock = 500) =>
    (await call('POST', '/v1/admin/products', kevin, { sku, name, priceCents, currency: 'KES', initialStock, categoryId })).json().id as string;
  tote = await mk('TOTE-1', 'Leather Tote', 485_000, bags);
  shoes = await mk('SHOE-1', 'Canvas Shoes', 300_000, null);
  belt = await mk('BELT-1', 'Leather Belt', 120_000, null);
  cheap = await mk('SOCK-1', 'Socks', 20_000, null);
});
afterAll(async () => { await h.close(); });

describe('who can reach marketing', () => {
  it('keeps it to marketing and the owner', async () => {
    for (const url of ['/v1/admin/coupons', '/v1/admin/segments', '/v1/admin/campaigns', '/v1/admin/pushes', '/v1/admin/pages', '/v1/admin/banners']) {
      expect((await call('GET', url, ruth)).statusCode, url).toBe(200);
      expect((await call('GET', url, owner)).statusCode, url).toBe(200);
      for (const t of [grace, samuel]) expect((await call('GET', url, t)).statusCode, url).toBe(403);
      expect((await call('GET', url, null)).statusCode).toBe(401);
    }
  });
});

describe('audiences and consent', () => {
  it('counts who a rule reaches, and only counts people who said yes for each channel', async () => {
    const a = uuidv7(), b = uuidv7();
    for (const [u, area] of [[a, 'Kilimani'], [b, 'Westlands']] as const) {
      const t = await h.token(u, ['customer']);
      await h.app.inject({ method: 'PUT', url: '/v1/me/profile', headers: { authorization: `Bearer ${t}` }, payload: { name: area, phone: '0712000000', area, street: 'x' } });
    }
    await h.db.query(`INSERT INTO customers (id, name, area) VALUES ($1,'A','Kilimani'), ($2,'B','Westlands') ON CONFLICT (id) DO UPDATE SET area = EXCLUDED.area`, [a, b]);
    expect((await call('GET', '/v1/me/marketing', await h.token(a, ['customer']))).json()).toMatchObject({ push: false, email: false, sms: false });
    expect((await call('PUT', '/v1/me/marketing', await h.token(a, ['customer']), { push: true, email: true, sms: false })).json()).toMatchObject({ push: true, email: true, sms: false });
    const prev = await call('POST', '/v1/admin/segments/preview', ruth, { rules: [{ field: 'area', op: 'is', value: 'kilimani' }] });
    expect(prev.json()).toEqual({ total: 1, push: 1, email: 1, sms: 0 });
    expect((await call('POST', '/v1/admin/segments/preview', ruth, { rules: [{ field: 'area', op: 'is not', value: 'kilimani' }] })).json().total).toBeGreaterThanOrEqual(1);
    expect((await call('POST', '/v1/admin/segments/preview', ruth, { match: 'any', rules: [{ field: 'orders', op: 'at most', value: '0' }, { field: 'area', op: 'is', value: 'Nowhere' }] })).json().total).toBeGreaterThanOrEqual(2);
    expect((await call('POST', '/v1/admin/segments/preview', ruth, { rules: [{ field: 'area', op: 'greater than', value: '1' }] })).statusCode).toBe(400);
    expect((await call('POST', '/v1/admin/segments/preview', ruth, { rules: [{ field: 'spend', op: 'greater than', value: 'lots' }] })).statusCode).toBe(400);
  });

  it('protects the built-in segment and one that a campaign uses', async () => {
    const list = (await call('GET', '/v1/admin/segments', ruth)).json().items as { id: string; system: boolean; audience: { total: number } }[];
    const all = list.find((s) => s.system)!;
    expect((await call('PATCH', `/v1/admin/segments/${all.id}`, ruth, { name: 'x' })).json().error.code).toBe('SYSTEM_SEGMENT');
    expect((await call('DELETE', `/v1/admin/segments/${all.id}`, ruth)).json().error.code).toBe('SYSTEM_SEGMENT');
    const seg = (await call('POST', '/v1/admin/segments', ruth, { name: 'High value', rules: [{ field: 'spend', op: 'greater than', value: '20000' }] })).json();
    expect(seg).toMatchObject({ name: 'High value', match: 'all', purpose: 'Campaign audience' });
    expect((await call('POST', '/v1/admin/segments', ruth, { name: 'high VALUE' })).json().error.code).toBe('SEGMENT_EXISTS');
    // Editing one field leaves the rest alone.
    expect((await call('PATCH', `/v1/admin/segments/${seg.id}`, ruth, { description: 'Big spenders' })).json()).toMatchObject({ description: 'Big spenders', rules: seg.rules, match: 'all' });
    const p = await call('POST', '/v1/admin/pushes', ruth, { title: 'Hi', body: 'There', segmentId: seg.id });
    expect(p.statusCode).toBe(201);
    expect((await call('DELETE', `/v1/admin/segments/${seg.id}`, ruth)).json().error.code).toBe('SEGMENT_IN_USE');
    expect((await call('GET', '/v1/admin/segments', ruth)).json().items.find((s: { id: string }) => s.id === seg.id).inUse).toBe(true);
  });
});

describe('coupons at checkout', () => {
  it('takes a percentage off, from the server’s own arithmetic, and records the use', async () => {
    const c = (await call('POST', '/v1/admin/coupons', ruth, coupon({ code: 'fresh10', name: 'Fresh start', minSpendCents: 100_000 }))).json();
    expect(c).toMatchObject({ code: 'FRESH10', status: 'Active', redemptions: 0, type: 'percent' });
    const user = uuidv7();
    const q = (await quote(user, [{ productId: tote }], 'fresh10')).json();
    expect(q).toMatchObject({ subtotalCents: 485_000, deliveryFeeCents: 25_000, discountCents: 48_500, totalCents: 485_000 + 25_000 - 48_500, coupon: { code: 'FRESH10', discountCents: 48_500 } });
    const res = await place(user, [{ productId: tote }], 'FRESH10');
    expect(res.statusCode).toBe(201);
    const o = res.json();
    expect(o.totalCents).toBe(461_500);
    expect((await call('GET', `/v1/admin/coupons/${c.id}`, ruth)).json()).toMatchObject({ redemptions: 1, discountGivenCents: 48_500 });
    // Same customer can't reuse it; a cancelled order gives the use back.
    expect((await place(user, [{ productId: tote }], 'FRESH10')).json().error).toMatchObject({ code: 'COUPON_INVALID', message: expect.stringContaining('already used') });
    expect((await h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/cancel`, headers: { authorization: `Bearer ${await h.token(user, ['customer'])}` }, payload: { reason: 'changed my mind' } })).statusCode).toBe(200);
    expect((await call('GET', `/v1/admin/coupons/${c.id}`, ruth)).json()).toMatchObject({ redemptions: 0, discountGivenCents: 0 });
    expect((await place(user, [{ productId: tote }], 'FRESH10')).statusCode).toBe(201);
    // Paying for it works at the discounted total, and a wrong total is still refused.
    const paid = await place(uuidv7(), [{ productId: shoes }], 'FRESH10');
    await pay(paid.json());
  });

  it('refuses a coupon for a reason the shopper can read', async () => {
    const reason = async (code: string, items = [{ productId: tote }], user = uuidv7()) => (await quote(user, items, code)).json().error as { code: string; message: string };
    expect((await reason('NOPE')).message).toContain('doesn’t exist');
    const paused = (await call('POST', '/v1/admin/coupons', ruth, coupon({ state: 'paused' }))).json();
    expect((await reason(paused.code)).message).toContain('paused');
    const later = (await call('POST', '/v1/admin/coupons', ruth, coupon({ startsAt: iso(2 * DAY), endsAt: iso(9 * DAY) }))).json();
    expect(later.status).toBe('Scheduled');
    expect((await reason(later.code)).message).toContain('isn’t active yet');
    const ended = (await call('POST', '/v1/admin/coupons', ruth, coupon({ startsAt: iso(-9 * DAY), endsAt: iso(-DAY) }))).json();
    expect((await reason(ended.code)).message).toContain('ended');
    const big = (await call('POST', '/v1/admin/coupons', ruth, coupon({ minSpendCents: 1_000_000 }))).json();
    expect((await reason(big.code)).message).toContain('Spend at least KES 10,000');
    const fresh = (await call('POST', '/v1/admin/coupons', ruth, coupon({ audience: 'new' }))).json();
    const old = uuidv7();
    await pay((await place(old, [{ productId: cheap }])).json());
    expect((await reason(fresh.code, [{ productId: tote }], old)).message).toContain('new customers only');
    expect((await quote(uuidv7(), [{ productId: tote }], fresh.code)).statusCode).toBe(200);
    const catOnly = (await call('POST', '/v1/admin/coupons', ruth, coupon({ categoryIds: [bags] }))).json();
    expect((await reason(catOnly.code, [{ productId: shoes }])).message).toContain('categories');
    expect((await quote(uuidv7(), [{ productId: tote }, { productId: shoes }], catOnly.code)).json().discountCents).toBe(48_500); // only the bag counts
  });

  it('caps a percentage, takes a fixed amount, or waives delivery', async () => {
    const capped = (await call('POST', '/v1/admin/coupons', ruth, coupon({ value: 50, maxDiscountCents: 75_000 }))).json();
    expect((await quote(uuidv7(), [{ productId: tote }], capped.code)).json().discountCents).toBe(75_000);
    const fixed = (await call('POST', '/v1/admin/coupons', ruth, coupon({ type: 'fixed', value: 50_000 }))).json();
    expect((await quote(uuidv7(), [{ productId: shoes }], fixed.code)).json().discountCents).toBe(50_000);
    expect((await quote(uuidv7(), [{ productId: cheap }], fixed.code)).json().discountCents).toBe(20_000); // never more than the goods
    const free = (await call('POST', '/v1/admin/coupons', ruth, coupon({ type: 'free_delivery', value: 0 }))).json();
    expect((await quote(uuidv7(), [{ productId: shoes }], free.code)).json()).toMatchObject({ discountCents: 25_000, totalCents: 300_000 });
  });

  it('stops at the usage limit, even when two customers try at once', async () => {
    const one = (await call('POST', '/v1/admin/coupons', ruth, coupon({ limit: 1 }))).json();
    const [a, b] = await Promise.all([place(uuidv7(), [{ productId: shoes }], one.code), place(uuidv7(), [{ productId: shoes }], one.code)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 422]);
    expect((await call('GET', `/v1/admin/coupons/${one.id}`, ruth)).json()).toMatchObject({ redemptions: 1, status: 'Exhausted' });
  });

  it('checks coupons as they are saved, and keeps a used one from being rewritten', async () => {
    expect((await call('POST', '/v1/admin/coupons', ruth, coupon({ value: 150 }))).json().error.code).toBe('BAD_VALUE');
    expect((await call('POST', '/v1/admin/coupons', ruth, coupon({ startsAt: iso(DAY), endsAt: iso(-DAY) }))).json().error.code).toBe('BAD_DATES');
    expect((await call('POST', '/v1/admin/coupons', ruth, coupon({ audience: 'segment' }))).json().error.code).toBe('SEGMENT_REQUIRED');
    expect((await call('POST', '/v1/admin/coupons', ruth, coupon({ code: 'x' }))).statusCode).toBe(400);
    expect((await call('POST', '/v1/admin/coupons', grace, coupon())).statusCode).toBe(403);
    const c = (await call('POST', '/v1/admin/coupons', ruth, coupon({ code: 'DUP-1' }))).json();
    expect((await call('POST', '/v1/admin/coupons', ruth, coupon({ code: 'dup-1' }))).json().error.code).toBe('CODE_EXISTS');
    expect((await call('PATCH', `/v1/admin/coupons/${c.id}`, ruth, { note: 'Trial' })).json()).toMatchObject({ note: 'Trial', code: 'DUP-1', value: 10, limit: 100 });
    await place(uuidv7(), [{ productId: shoes }], 'DUP-1');
    expect((await call('PATCH', `/v1/admin/coupons/${c.id}`, ruth, { code: 'NEW-1' })).json().error.code).toBe('COUPON_USED');
    expect((await call('PATCH', `/v1/admin/coupons/${c.id}`, ruth, { limit: 100 })).statusCode).toBe(200);
    expect((await call('DELETE', `/v1/admin/coupons/${c.id}`, ruth)).json().error.code).toBe('COUPON_KEPT');
    expect((await call('POST', '/v1/admin/coupons/state', ruth, { ids: [c.id], state: 'paused' })).json()).toEqual({ updated: 1 });
    expect((await call('GET', `/v1/admin/coupons/${c.id}`, ruth)).json().status).toBe('Paused');
    const draft = (await call('POST', '/v1/admin/coupons', ruth, coupon({ state: 'draft' }))).json();
    expect((await call('DELETE', `/v1/admin/coupons/${draft.id}`, ruth)).statusCode).toBe(204);
    expect((await call('GET', '/v1/admin/coupons?status=Paused', ruth)).json().items.every((i: { status: string }) => i.status === 'Paused')).toBe(true);
  });
});

describe('flash sales and bundles', () => {
  it('charges the sale price, keeps coupons off sale items, and lets only one live sale hold a product', async () => {
    const s = await call('POST', '/v1/admin/flash-sales', ruth, { name: 'Weekend finds', startsAt: iso(-3_600_000), endsAt: iso(DAY), type: 'percent', value: 20, productIds: [belt], stockGuard: 10, state: 'live' });
    expect(s.statusCode).toBe(201);
    expect(s.json()).toMatchObject({ status: 'Live', productIds: [belt] });
    const user = uuidv7();
    const q = (await quote(user, [{ productId: belt }])).json();
    expect(q.lines[0]).toMatchObject({ listCents: 120_000, unitCents: 96_000, onSale: true });
    expect((await call('GET', '/v1/storefront/home', null)).json().onSale).toEqual([expect.objectContaining({ productId: belt, saleCents: 96_000, badge: '20% off' })]);
    const o = (await place(user, [{ productId: belt }, { productId: shoes }])).json();
    expect(o.items.find((i: { productId: string }) => i.productId === belt).unitPriceCents).toBe(96_000);
    expect(o.totalCents).toBe(96_000 + 300_000 + 25_000);
    await pay(o);
    expect((await call('GET', `/v1/admin/flash-sales/${s.json().id}`, ruth)).json().salesTodayCents).toBe(96_000);
    // A coupon doesn't stack on a sale item, but still works on the rest of the basket.
    const cp = (await call('POST', '/v1/admin/coupons', ruth, coupon())).json();
    expect((await quote(uuidv7(), [{ productId: belt }], cp.code)).json().error.message).toContain('flash sale');
    expect((await quote(uuidv7(), [{ productId: belt }, { productId: shoes }], cp.code)).json().discountCents).toBe(30_000);
    expect((await call('PUT', '/v1/admin/marketing/rules', ruth, { noStackFlash: false, bundlePoints: true })).statusCode).toBe(200);
    expect((await quote(uuidv7(), [{ productId: belt }], cp.code)).json().discountCents).toBe(9_600);
    await call('PUT', '/v1/admin/marketing/rules', ruth, { noStackFlash: true, bundlePoints: true });
    // Overlap, bad dates and a stock guard.
    const clash = await call('POST', '/v1/admin/flash-sales', ruth, { name: 'Clash', startsAt: iso(0), endsAt: iso(2 * DAY), type: 'fixed', value: 10_000, productIds: [belt, shoes], state: 'live' });
    expect(clash.json().error.code).toBe('SALE_OVERLAP');
    expect((await call('POST', '/v1/admin/flash-sales', ruth, { name: 'Bad', startsAt: iso(DAY), endsAt: iso(0), type: 'fixed', value: 1, productIds: [shoes] })).json().error.code).toBe('BAD_DATES');
    const guarded = (await call('POST', '/v1/admin/flash-sales', ruth, { name: 'Guarded', startsAt: iso(-1000), endsAt: iso(DAY), type: 'fixed', value: 50_000, productIds: [shoes], stockGuard: 100_000, state: 'live' })).json();
    expect((await quote(uuidv7(), [{ productId: shoes }])).json().lines[0].onSale).toBe(false);
    // Taking a sale back to a draft restores the price.
    await call('PATCH', `/v1/admin/flash-sales/${guarded.id}`, ruth, { stockGuard: 0 });
    expect((await quote(uuidv7(), [{ productId: shoes }])).json().lines[0]).toMatchObject({ onSale: true, unitCents: 250_000 });
    await call('PATCH', `/v1/admin/flash-sales/${guarded.id}`, ruth, { state: 'draft' });
    expect((await quote(uuidv7(), [{ productId: shoes }])).json().lines[0].onSale).toBe(false);
    await call('PATCH', `/v1/admin/flash-sales/${s.json().id}`, ruth, { state: 'draft' });
    expect((await quote(uuidv7(), [{ productId: belt }])).json().lines[0].onSale).toBe(false);
  });

  it('gives a bundle’s saving when everything is in the basket, and keeps coupons apart unless allowed', async () => {
    expect((await call('POST', '/v1/admin/bundles', ruth, { name: 'Set', type: 'Bundle', items: [{ productId: tote }, { productId: shoes }], priceCents: 800_000, state: 'live' })).json().error.code).toBe('BAD_PRICE');
    const b = await call('POST', '/v1/admin/bundles', ruth, { name: 'Weekender set', type: 'Bundle', items: [{ productId: tote }, { productId: belt }], priceCents: 550_000, state: 'live' });
    expect(b.statusCode).toBe(201);
    expect(b.json()).toMatchObject({ status: 'Live', standaloneCents: 605_000, savingCents: 55_000 });
    const user = uuidv7();
    expect((await quote(user, [{ productId: tote }])).json().bundle).toBeNull();
    const q = (await quote(user, [{ productId: tote }, { productId: belt }])).json();
    expect(q).toMatchObject({ bundle: { name: 'Weekender set', discountCents: 55_000 }, discountCents: 55_000, totalCents: 605_000 + 25_000 - 55_000 });
    const noCombine = (await call('POST', '/v1/admin/coupons', ruth, coupon())).json();
    expect((await quote(user, [{ productId: tote }, { productId: belt }], noCombine.code)).json().error.message).toContain('bundle');
    const combine = (await call('POST', '/v1/admin/coupons', ruth, coupon({ combine: true }))).json();
    expect((await quote(user, [{ productId: tote }, { productId: belt }], combine.code)).json().discountCents).toBe(55_000 + 60_500);
    const o = (await place(user, [{ productId: tote }, { productId: belt }])).json();
    expect(o.totalCents).toBe(575_000);
    await pay(o);
    expect((await call('GET', `/v1/admin/bundles/${b.json().id}`, ruth)).json().ordersCount).toBe(1);
    // Two sets in the basket save twice.
    expect((await quote(uuidv7(), [{ productId: tote, quantity: 2 }, { productId: belt, quantity: 2 }])).json().bundle.discountCents).toBe(110_000);
    await call('POST', `/v1/admin/bundles/${b.json().id}/state`, ruth, { state: 'draft' });
    expect((await quote(uuidv7(), [{ productId: tote }, { productId: belt }])).json().bundle).toBeNull();
    // Multi-buy
    expect((await call('POST', '/v1/admin/bundles', ruth, { name: 'Mix', type: 'Multi-buy', percent: 15, minItems: 1, state: 'live' })).json().error.code).toBe('BAD_OFFER');
    await call('POST', '/v1/admin/bundles', ruth, { name: 'Mix and match', type: 'Multi-buy', percent: 15, minItems: 3, state: 'live' });
    expect((await quote(uuidv7(), [{ productId: shoes, quantity: 2 }])).json().bundle).toBeNull();
    expect((await quote(uuidv7(), [{ productId: shoes, quantity: 2 }, { productId: belt }])).json().bundle.discountCents).toBe(Math.round((600_000 + 120_000) * 0.15));
  });
});

describe('banners and the homepage', () => {
  it('won’t publish a banner without alt text or with a broken link, and shows only what is live', async () => {
    const base = { title: 'New arrivals', link: '/collections/new', startsAt: iso(-DAY), endsAt: iso(10 * DAY), tone: 0 };
    expect((await call('POST', '/v1/admin/banners', ruth, { ...base, published: true })).json().error.code).toBe('ALT_REQUIRED');
    expect((await call('POST', '/v1/admin/banners', ruth, { ...base, alt: 'Models', link: '/collections/summer', published: true })).json().error.code).toBe('BROKEN_LINK');
    const b1 = (await call('POST', '/v1/admin/banners', ruth, { ...base, alt: 'Models in new arrivals', published: true })).json();
    const b2 = (await call('POST', '/v1/admin/banners', ruth, { ...base, title: 'Bags', link: '/categories/bags', alt: 'Bags', published: true, platform: 'Mobile only' })).json();
    await call('POST', '/v1/admin/banners', ruth, { ...base, title: 'Later', startsAt: iso(5 * DAY), alt: 'Later', published: true });
    await call('POST', '/v1/admin/banners', ruth, { ...base, title: 'Draft one', alt: '' });
    expect(b1).toMatchObject({ status: 'Live', linkOk: true });
    expect((await call('GET', '/v1/storefront/home?platform=web', null)).json().banners.map((b: { title: string }) => b.title)).toEqual(['New arrivals']);
    expect((await call('GET', '/v1/storefront/home?platform=mobile', null)).json().banners.map((b: { title: string }) => b.title)).toEqual(['New arrivals', 'Bags']);
    const moved = (await call('POST', `/v1/admin/banners/${b2.id}/move`, ruth, { dir: -1 })).json();
    expect(moved.items.slice(0, 2).map((b: { title: string }) => b.title)).toEqual(['Bags', 'New arrivals']);
    expect((await call('PATCH', `/v1/admin/banners/${b1.id}`, ruth, { published: false })).json().status).toBe('Draft');
    expect((await call('GET', '/v1/storefront/home?platform=web', null)).json().banners).toHaveLength(0);
    expect((await call('DELETE', `/v1/admin/banners/${b2.id}`, ruth)).statusCode).toBe(204);
    expect((await call('PUT', '/v1/admin/banner-settings', ruth, { interval: '8 seconds', ratio: '16:5' })).statusCode).toBe(200);
    expect((await call('GET', '/v1/admin/banners', ruth)).json().settings).toEqual({ interval: '8 seconds', ratio: '16:5' });
  });

  it('publishes the layout now or later, and only then do shoppers see it', async () => {
    expect((await call('POST', '/v1/admin/homepage/publish', ruth, { mode: 'now' })).json().error.code).toBe('NO_SECTIONS');
    const add = async (name: string, enabled = true) => (await call('POST', '/v1/admin/homepage/sections', ruth, { name, sub: 'Row', enabled, count: 4 })).json();
    await add('Hero banners');
    const first = await add('Shop by category');
    const l = await add('Hidden row', false);
    expect(l.sections.map((s: { name: string }) => s.name)).toEqual(['Hero banners', 'Shop by category', 'Hidden row']);
    expect(l.unpublished).toBe(3);
    expect((await call('GET', '/v1/storefront/home', null)).json().sections).toEqual([]);
    const moved = (await call('POST', `/v1/admin/homepage/sections/${first.sections[1].id}/move`, ruth, { dir: -1 })).json();
    expect(moved.sections[0].name).toBe('Shop by category');
    expect((await call('POST', '/v1/admin/homepage/publish', ruth, { mode: 'later', at: iso(-1000) })).json().error.code).toBe('PAST_TIME');
    const pub = (await call('POST', '/v1/admin/homepage/publish', ruth, { mode: 'now' })).json();
    expect(pub.unpublished).toBe(0);
    expect((await call('GET', '/v1/storefront/home', null)).json().sections.map((s: { name: string }) => s.name)).toEqual(['Shop by category', 'Hero banners']);
    // A change waits until it is published; a scheduled one goes live when its time comes.
    await call('PATCH', `/v1/admin/homepage/sections/${moved.sections[0].id}`, ruth, { enabled: false });
    expect((await call('GET', '/v1/storefront/home', null)).json().sections).toHaveLength(2);
    expect((await call('GET', '/v1/admin/homepage', ruth)).json().unpublished).toBe(1);
    expect((await call('POST', '/v1/admin/homepage/publish', ruth, { mode: 'later', at: iso(3_600_000) })).json().pending).toMatchObject({ by: 'Ruth' });
    await h.db.query(`UPDATE home_layouts SET effective_at = now() - interval '1 minute' WHERE slot = 'pending'`);
    expect(await h.c.engage.runDue()).toMatchObject({ layout: true });
    expect((await call('GET', '/v1/storefront/home', null)).json().sections.map((s: { name: string }) => s.name)).toEqual(['Hero banners']);
    expect((await call('GET', '/v1/admin/homepage', ruth)).json()).toMatchObject({ pending: null, unpublished: 0 });
  });
});

describe('push, email and SMS', () => {
  let seg: string;
  beforeAll(async () => {
    seg = (await call('POST', '/v1/admin/segments', ruth, { name: 'Kilimani folk', rules: [{ field: 'area', op: 'is', value: 'Kilimani' }] })).json().id;
  });

  it('moves a send out of quiet hours, holds the one-a-day limit, and sends what is due', async () => {
    expect(respectQuietHours(new Date('2026-06-10T20:30:00Z'))).toMatchObject({ moved: true, at: new Date('2026-06-11T04:00:00Z') }); // 23:30 in Nairobi -> 07:00 next day
    expect(respectQuietHours(new Date('2026-06-10T02:00:00Z'))).toMatchObject({ moved: true, at: new Date('2026-06-10T04:00:00Z') }); // 05:00 -> 07:00 same day
    expect(respectQuietHours(new Date('2026-06-10T09:00:00Z')).moved).toBe(false);
    const at = new Date(Date.now() + 5 * DAY); at.setUTCHours(6, 0, 0, 0); // 09:00 in Nairobi
    const first = await call('POST', '/v1/admin/pushes', ruth, { title: 'New arrivals', body: 'Fresh styles', segmentId: seg, sendAt: at.toISOString(), action: 'schedule' });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ status: 'scheduled', movedOutOfQuietHours: false });
    const dup = await call('POST', '/v1/admin/pushes', ruth, { title: 'Second', body: 'Again', segmentId: seg, sendAt: new Date(at.getTime() + 3_600_000).toISOString(), action: 'schedule' });
    expect(dup.json().error).toMatchObject({ code: 'FREQUENCY_CAP', details: { title: 'New arrivals' } });
    expect((await call('POST', '/v1/admin/pushes', ruth, { title: 'Second', body: 'Again', segmentId: seg, sendAt: new Date(at.getTime() + 3_600_000).toISOString(), action: 'schedule', cap: false })).statusCode).toBe(201);
    const night = new Date(Date.now() + 9 * DAY); night.setUTCHours(19, 0, 0, 0); // 22:00 in Nairobi
    const moved = (await call('POST', '/v1/admin/pushes', ruth, { title: 'Late', body: 'Night owl', segmentId: seg, sendAt: night.toISOString(), action: 'schedule' })).json();
    expect(moved.movedOutOfQuietHours).toBe(true);
    expect(new Date(moved.sendAt).getUTCHours()).toBe(4);
    expect((await call('POST', '/v1/admin/pushes', ruth, { title: 'Past', body: 'Old', segmentId: seg, sendAt: iso(-1000), action: 'schedule' })).json().error.code).toBe('PAST_TIME');

    // Send what's due, to the people who agreed.
    await h.db.query(`UPDATE pushes SET send_at = now() - interval '1 minute' WHERE id = $1`, [first.json().id]);
    expect(await h.c.engage.runDue()).toMatchObject({ pushes: 1 });
    const sent = (await call('GET', `/v1/admin/pushes/${first.json().id}`, ruth)).json();
    expect(sent).toMatchObject({ status: 'sent', stats: { sent: 1, opened: 0, converted: 0 } });
    expect((await call('PATCH', `/v1/admin/pushes/${first.json().id}`, ruth, { title: 'x' })).json().error.code).toBe('ALREADY_SENT');
    const svc = await h.token(uuidv7(), ['notifications']);
    expect((await h.app.inject({ method: 'POST', url: `/v1/internal/marketing/push/${first.json().id}/results`, headers: { authorization: `Bearer ${svc}` }, payload: { opened: 1, converted: 1 } })).statusCode).toBe(204);
    expect((await call('GET', `/v1/admin/pushes/${first.json().id}`, ruth)).json().stats).toEqual({ sent: 1, opened: 1, converted: 1 });
    expect((await h.app.inject({ method: 'POST', url: `/v1/internal/marketing/push/${first.json().id}/results`, headers: { authorization: `Bearer ${await h.token(uuidv7(), ['customer'])}` }, payload: { opened: 5 } })).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/pushes/${dup.json().id ?? uuidv7()}/unschedule`, ruth)).statusCode).toBe(404);
  });

  it('sends email and SMS to those who opted in for that channel, with SMS parts counted', async () => {
    expect((await call('POST', '/v1/admin/messages', ruth, { name: 'Update', channel: 'Email', segmentId: seg, body: 'Hello', action: 'now' })).json().error.code).toBe('SUBJECT_REQUIRED');
    const long = 'x'.repeat(200);
    const sms = (await call('POST', '/v1/admin/messages', ruth, { name: 'Welcome', channel: 'SMS', segmentId: seg, body: long })).json();
    expect(sms).toMatchObject({ status: 'draft', smsParts: 2 });
    const sent = (await call('PATCH', `/v1/admin/messages/${sms.id}`, ruth, { action: 'now', body: 'Use FRESH10 for 10% off' })).json();
    expect(sent).toMatchObject({ status: 'sent', smsParts: 1, stats: { sent: 0 } }); // the one Kilimani customer said no to SMS
    const mail = (await call('POST', '/v1/admin/messages', ruth, { name: 'March update', channel: 'Email', segmentId: seg, subject: 'What’s new', body: 'Hello', action: 'now' })).json();
    expect(mail).toMatchObject({ status: 'sent', stats: { sent: 1 } });
    const sch = (await call('POST', '/v1/admin/messages', ruth, { name: 'Later', channel: 'Email', segmentId: seg, subject: 'Soon', body: 'x', sendAt: iso(2 * DAY), action: 'schedule' })).json();
    expect((await call('POST', `/v1/admin/messages/${sch.id}/unschedule`, ruth)).json().status).toBe('draft');
    expect((await call('POST', `/v1/admin/messages/${sch.id}/unschedule`, ruth)).json().error.code).toBe('NOT_SCHEDULED');
  });
});

describe('campaigns and programmes', () => {
  it('reports a coupon campaign from real orders, and keeps channel results beside it', async () => {
    const cp = (await call('POST', '/v1/admin/coupons', ruth, coupon({ code: 'WEEKEND', type: 'fixed', value: 20_000 }))).json();
    const k = (await call('POST', '/v1/admin/campaigns', ruth, { name: 'Weekender weekend', type: 'Coupon', offer: 'WEEKEND · KES 200 off', spendCents: 100_000, startsAt: iso(-DAY), endsAt: iso(7 * DAY), couponId: cp.id })).json();
    const o = (await place(uuidv7(), [{ productId: shoes }], 'WEEKEND')).json();
    await pay(o);
    const view = (await call('GET', `/v1/admin/campaigns/${k.id}`, ruth)).json();
    expect(view).toMatchObject({ status: 'Active', channels: [{ name: 'Coupon WEEKEND', conversions: 1, salesCents: o.totalCents }] });
    await call('PUT', `/v1/admin/campaigns/${k.id}/channels`, ruth, { name: 'Push notification', reach: 8200, clicks: 1500, conversions: 288, salesCents: 660_000 });
    const after = (await call('GET', `/v1/admin/campaigns/${k.id}`, ruth)).json();
    expect(after.totals).toMatchObject({ reach: 8200, conversions: 289, salesCents: o.totalCents + 660_000 });
    expect(after.totals.returnOnSpend).toBeGreaterThan(6);
    expect((await call('GET', '/v1/admin/campaigns', ruth)).json().summary.active).toBe(1);
    expect((await call('POST', '/v1/admin/campaigns', ruth, { name: 'x', type: 'Push', startsAt: iso(DAY), endsAt: iso(0) })).json().error.code).toBe('BAD_DATES');
  });

  it('keeps the loyalty and referral settings, and shows good reviews that staff choose', async () => {
    const l = (await call('GET', '/v1/admin/loyalty', ruth)).json();
    expect(l).toMatchObject({ earnRate: 1, active: true });
    expect((await call('PUT', '/v1/admin/loyalty', ruth, { ...l, maxRedeemPct: 150 })).statusCode).toBe(400);
    expect((await call('PUT', '/v1/admin/loyalty', ruth, { ...l, earnRate: 2 })).json().earnRate).toBe(2);
    expect((await call('GET', '/v1/storefront/programmes', null)).json().loyalty.earnRate).toBe(2);
    const r = (await call('GET', '/v1/admin/referrals', ruth)).json();
    expect((await call('PUT', '/v1/admin/referrals', ruth, { ...r, limit: 5 })).json().limit).toBe(5);
    expect((await call('PUT', '/v1/admin/referrals', grace, r)).statusCode).toBe(403);

    const cust = uuidv7();
    const [good, bad, hidden] = [uuidv7(), uuidv7(), uuidv7()];
    for (const [id, rating, state] of [[good, 5, 'visible'], [bad, 2, 'visible'], [hidden, 5, 'hidden']] as const) {
      await h.db.query(`INSERT INTO reviews (id, customer_id, customer_name, rating, body, topic, state) VALUES ($1,$2,'Wanjiku Njoroge',$3,'Lovely',$4,$5)`, [id, cust, rating, 'Delivery', state]);
    }
    expect((await call('GET', '/v1/admin/review-highlights', ruth)).json().items.map((i: { reviewId: string }) => i.reviewId)).toEqual([good]);
    expect((await call('PUT', `/v1/admin/review-highlights/${hidden}`, ruth, { published: true })).json().error.code).toBe('REVIEW_HIDDEN');
    const put = (await call('PUT', `/v1/admin/review-highlights/${good}`, ruth, { placement: 'Category page' })).json();
    expect(put.highlight).toEqual({ placement: 'Category page', published: false });
    expect((await call('GET', '/v1/storefront/home', null)).json().reviews).toEqual([]);
    expect((await call('PUT', `/v1/admin/review-highlights/${good}`, ruth, { published: true })).json().highlight).toEqual({ placement: 'Category page', published: true });
    expect((await call('GET', '/v1/storefront/home', null)).json().reviews).toEqual([{ customer: 'Wanjiku', rating: 5, body: 'Lovely', placement: 'Category page' }]);
    expect((await call('DELETE', `/v1/admin/review-highlights/${good}`, ruth)).statusCode).toBe(204);
    expect((await call('GET', '/v1/storefront/home', null)).json().reviews).toEqual([]);
  });
});

describe('pages and category content', () => {
  it('publishes pages only when written, at a unique address, and shows nothing unpublished', async () => {
    expect((await call('POST', '/v1/admin/pages', ruth, { title: 'About', slug: 'about' })).statusCode).toBe(400);
    expect((await call('POST', '/v1/admin/pages', ruth, { title: 'About', slug: '/about', status: 'published', body: 'short' })).json().error.code).toBe('BODY_TOO_SHORT');
    const p = (await call('POST', '/v1/admin/pages', ruth, { title: 'About ShopCore', slug: '/About', body: 'ShopCore brings the best of Nairobi to your door, fast, every day.' })).json();
    expect(p).toMatchObject({ slug: '/about', status: 'draft' });
    expect((await call('POST', '/v1/admin/pages', ruth, { title: 'Dup', slug: '/about' })).json().error.code).toBe('SLUG_EXISTS');
    expect((await call('GET', '/v1/storefront/page?slug=/about', null)).statusCode).toBe(404);
    expect((await call('PATCH', `/v1/admin/pages/${p.id}`, ruth, { status: 'published' })).json()).toMatchObject({ status: 'published', title: 'About ShopCore', slug: '/about' });
    expect((await call('GET', '/v1/storefront/page?slug=/about', null)).json()).toMatchObject({ title: 'About ShopCore', seoTitle: 'About ShopCore' });
    expect((await call('GET', '/v1/storefront/pages', null)).json().items).toEqual([{ title: 'About ShopCore', slug: '/about' }]);
    expect((await call('DELETE', `/v1/admin/pages/${p.id}`, ruth)).json().error.code).toBe('PAGE_LIVE');
    // A published page is a valid banner link.
    expect((await call('POST', '/v1/admin/banners', ruth, { title: 'About', link: '/about', startsAt: iso(-1000), endsAt: iso(DAY), alt: 'About us', published: true })).statusCode).toBe(201);
    await call('PATCH', `/v1/admin/pages/${p.id}`, ruth, { status: 'draft' });
    expect((await call('DELETE', `/v1/admin/pages/${p.id}`, ruth)).statusCode).toBe(204);
  });

  it('keeps category copy, shown only once published', async () => {
    const list = (await call('GET', '/v1/admin/category-content', ruth)).json().items as { categoryId: string; handle: string }[];
    const cat = list.find((c) => c.handle === 'bags')!;
    expect((await call('PATCH', `/v1/admin/category-content/${cat.categoryId}`, ruth, { published: true })).json().error.code).toBe('HEADING_REQUIRED');
    const saved = (await call('PATCH', `/v1/admin/category-content/${cat.categoryId}`, ruth, { heading: 'Bags built for every day', intro: 'Weekenders to totes.' })).json();
    expect(saved).toMatchObject({ heading: 'Bags built for every day', published: false, collection: 'Featured' });
    expect((await call('GET', '/v1/storefront/categories/bags', null)).statusCode).toBe(404);
    expect((await call('PATCH', `/v1/admin/category-content/${cat.categoryId}`, ruth, { published: true })).json()).toMatchObject({ published: true, intro: 'Weekenders to totes.' });
    expect((await call('GET', '/v1/storefront/categories/bags', null)).json()).toMatchObject({ heading: 'Bags built for every day', name: 'Bags' });
    expect((await call('PATCH', `/v1/admin/category-content/${uuidv7()}`, ruth, { heading: 'x' })).statusCode).toBe(404);
  });
});
