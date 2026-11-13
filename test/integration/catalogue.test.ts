import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';

const PW = 'Sunrise#2025!';
let h: Harness;

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: { authorization: `Bearer ${token}`, ...headers } });
async function tokenFor(email: string) {
  const r = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PW } });
  if (r.statusCode !== 200) throw new Error(r.body);
  return r.json().accessToken as string;
}
/** Every product's per-location stock must add up to what the order system believes it has. */
async function expectInvariant() {
  const { rows } = await h.db.query(
    `SELECT p.sku, COALESCE(i.available,0) + COALESCE(i.reserved,0) AS expected, COALESCE((SELECT sum(on_hand) FROM stock_levels s WHERE s.product_id = p.id),0)::int AS shelves
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id`);
  for (const r of rows) expect({ sku: r.sku, shelves: r.shelves }).toEqual({ sku: r.sku, shelves: r.expected });
}

let inv: string, support: string, owner: string, marketing: string;
let nairobi: string, mombasa: string;

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness();
  const s = h.c.staff;
  await s.ensureDefaultRoles();
  const add = (n: string, e: string, r: string) => s.insertRaw({ name: n, email: e, role: r, status: 'active', password: PW, mustChange: false });
  await add('Amara', 'amara@t.co', 'Owner admin');
  await add('Kevin', 'kevin@t.co', 'Inventory manager');
  await add('Grace', 'grace@t.co', 'Customer support');
  await add('Ruth', 'ruth@t.co', 'Marketing manager');
  [owner, inv, support, marketing] = await Promise.all([tokenFor('amara@t.co'), tokenFor('kevin@t.co'), tokenFor('grace@t.co'), tokenFor('ruth@t.co')]);
});
afterAll(async () => { await h.close(); });

describe('locations', () => {
  it('creates locations; the first active one is primary', async () => {
    const a = await call('POST', '/v1/admin/locations', inv, { name: 'Nairobi Central', city: 'Nairobi', capacity: 600 });
    expect(a.statusCode).toBe(201);
    nairobi = a.json().id;
    const b = await call('POST', '/v1/admin/locations', inv, { name: 'Mombasa Hub', city: 'Mombasa', capacity: 300 });
    mombasa = b.json().id;
    const list = (await call('GET', '/v1/admin/locations', inv)).json().items as { id: string; primary: boolean }[];
    expect(list.find((l) => l.primary)!.id).toBe(nairobi);
    expect((await call('POST', '/v1/admin/locations', inv, { name: 'nairobi central' })).json().error.code).toBe('LOCATION_EXISTS');
    expect((await call('PATCH', `/v1/admin/locations/${mombasa}`, inv, { primary: true })).json().primary).toBe(true);
    await call('PATCH', `/v1/admin/locations/${nairobi}`, inv, { primary: true });
  });
  it('is closed to roles without Inventory access', async () => {
    expect((await call('GET', '/v1/admin/locations', marketing)).statusCode).toBe(403);
    expect((await call('POST', '/v1/admin/locations', support, { name: 'X' })).statusCode).toBe(403);
  });
});

describe('categories, brands, suppliers', () => {
  it('manages the catalogue structure', async () => {
    const c = await call('POST', '/v1/admin/categories', inv, { name: 'Bags', subcategories: ['Totes', 'Backpacks', 'totes'] });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ handle: 'bags', subcategories: ['Backpacks', 'Totes'] });
    const up = await call('PATCH', `/v1/admin/categories/${c.json().id}`, inv, { subcategories: ['Totes'] });
    expect(up.json().subcategories).toEqual(['Totes']);
    expect((await call('POST', '/v1/admin/categories', inv, { name: 'BAGS' })).json().error.code).toBe('CATEGORY_EXISTS');
    expect((await call('POST', '/v1/admin/brands', inv, { name: 'Kilele', origin: 'Nairobi' })).statusCode).toBe(201);
    expect((await call('POST', '/v1/admin/brands', inv, { name: 'kilele' })).json().error.code).toBe('BRAND_EXISTS');
    const s = await call('POST', '/v1/admin/suppliers', inv, { name: 'Kilele Leather Works', leadDays: 7, minOrderCents: 5_000_000 });
    expect(s.statusCode).toBe(201);
    expect((await call('PATCH', `/v1/admin/suppliers/${s.json().id}`, inv, { status: 'on_hold' })).json().status).toBe('on_hold');
  });
});

describe('products', () => {
  let cat: string, brand: string, sup: string;
  beforeAll(async () => {
    cat = ((await call('GET', '/v1/admin/categories', inv)).json().items as { id: string }[])[0]!.id;
    brand = ((await call('GET', '/v1/admin/brands', inv)).json().items as { id: string }[])[0]!.id;
    sup = ((await call('GET', '/v1/admin/suppliers', inv)).json().items as { id: string }[])[0]!.id;
  });
  const body = (sku: string, over: object = {}) => ({ sku, name: `Product ${sku}`, priceCents: 450_000, costCents: 260_000, categoryId: cat, brandId: brand, supplierId: sup, barcode: '', initialStock: 40, ...over });

  it('creates a product with its stock at the primary location', async () => {
    const r = await call('POST', '/v1/admin/products', inv, body('BAG-1', { barcode: '6160000000011' }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ category: 'Bags', brand: 'Kilele', available: 40, levels: [{ location: 'Nairobi Central', onHand: 40 }] });
    expect((await call('POST', '/v1/admin/products', inv, body('BAG-1'))).json().error.code).toBe('SKU_EXISTS');
    expect((await call('POST', '/v1/admin/products', inv, body('BAG-2', { barcode: '6160000000011' }))).json().error.code).toBe('BARCODE_EXISTS');
    expect((await call('POST', '/v1/admin/products', inv, body('BAG-3', { categoryId: uuidv7() }))).statusCode).toBe(400);
    await expectInvariant();
  });

  it('only people with Products access can create or edit', async () => {
    expect((await call('POST', '/v1/admin/products', marketing, body('NOPE-1'))).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/products', marketing)).statusCode).toBe(200); // marketing may view
    expect((await call('GET', '/v1/admin/products', await tokenFor('grace@t.co'))).statusCode).toBe(200);
  });

  it('updates with optimistic concurrency and keeps the storefront in step', async () => {
    const made = (await call('POST', '/v1/admin/products', inv, body('SHOW-1', { status: 'draft' }))).json();
    expect((await h.app.inject({ method: 'GET', url: `/v1/products/${made.id}` })).statusCode).toBe(404); // drafts are hidden
    const live = await call('PATCH', `/v1/admin/products/${made.id}`, inv, { status: 'active', priceCents: 500_000 }, { 'if-match': `"${made.version}"` });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: 'active', priceCents: 500_000, version: made.version + 1 });
    const shop = await h.app.inject({ method: 'GET', url: `/v1/products/${made.id}` });
    expect(shop.statusCode).toBe(200);
    expect(shop.json().priceCents).toBe(500_000);
    const stale = await call('PATCH', `/v1/admin/products/${made.id}`, inv, { name: 'Late' }, { 'if-match': `"${made.version}"` });
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    expect((await call('PATCH', `/v1/admin/products/${made.id}`, inv, { name: 'x' })).statusCode).toBe(400); // If-Match required
    await call('PATCH', `/v1/admin/products/${made.id}`, inv, { status: 'archived' }, { 'if-match': `"${live.json().version}"` });
    expect((await h.app.inject({ method: 'GET', url: `/v1/products/${made.id}` })).statusCode).toBe(404);
  });

  it('searches and filters', async () => {
    await call('POST', '/v1/admin/products', inv, body('LOW-1', { initialStock: 4, reorderAt: 10 }));
    await call('POST', '/v1/admin/products', inv, body('OUT-1', { initialStock: 0 }));
    const low = (await call('GET', '/v1/admin/products?stock=low', inv)).json().items as { sku: string }[];
    expect(low.map((p) => p.sku)).toEqual(['LOW-1']);
    const out = (await call('GET', '/v1/admin/products?stock=out', inv)).json().items as { sku: string }[];
    expect(out.map((p) => p.sku)).toContain('OUT-1');
    const hit = (await call('GET', '/v1/admin/products?q=bag-1', inv)).json().items as { sku: string }[];
    expect(hit.map((p) => p.sku)).toEqual(['BAG-1']);
    const byCode = (await call('GET', '/v1/admin/products?q=6160000000011', inv)).json().items as { sku: string }[];
    expect(byCode).toHaveLength(1);
    const page1 = (await call('GET', '/v1/admin/products?limit=2', inv)).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
  });

  it('refuses to delete a category or location that is in use', async () => {
    expect((await call('DELETE', `/v1/admin/categories/${cat}`, inv)).json().error.code).toBe('CATEGORY_IN_USE');
    expect((await call('PATCH', `/v1/admin/locations/${nairobi}`, inv, { active: false })).json().error.code).toBe('LOCATION_HAS_STOCK');
  });
});

describe('editing one field leaves the others alone', () => {
  it('keeps unrelated product, location, supplier and category fields', async () => {
    const p = (await call('GET', '/v1/admin/products?q=BAG-1', inv)).json().items[0] as { id: string; version: number; costCents: number; reorderAt: number; barcode: string; brandId: string };
    const after = await call('PATCH', `/v1/admin/products/${p.id}`, inv, { name: 'Renamed bag' }, { 'if-match': `"${p.version}"` });
    expect(after.json()).toMatchObject({ name: 'Renamed bag', costCents: p.costCents, reorderAt: p.reorderAt, barcode: p.barcode, brandId: p.brandId, tax: 'standard', status: 'active' });
    const loc = await call('PATCH', `/v1/admin/locations/${nairobi}`, inv, { city: 'Nairobi CBD' });
    expect(loc.json()).toMatchObject({ city: 'Nairobi CBD', capacity: 600, active: true });
    const sup = (await call('GET', '/v1/admin/suppliers', inv)).json().items[0] as { id: string; leadDays: number; minOrderCents: number };
    const s2 = await call('PATCH', `/v1/admin/suppliers/${sup.id}`, inv, { contact: 'Peter' });
    expect(s2.json()).toMatchObject({ contact: 'Peter', leadDays: sup.leadDays, minOrderCents: sup.minOrderCents });
    const cat = (await call('GET', '/v1/admin/categories', inv)).json().items[0] as { id: string; subcategories: string[] };
    expect((await call('PATCH', `/v1/admin/categories/${cat.id}`, inv, { description: 'Carry things' })).json().subcategories).toEqual(cat.subcategories);
    expect((await call('PATCH', `/v1/admin/suppliers/${sup.id}`, inv, {})).statusCode).toBe(400);
  });
});

describe('stock', () => {
  let pid: string;
  beforeAll(async () => {
    pid = ((await call('GET', '/v1/admin/products?q=BAG-1', inv)).json().items as { id: string }[])[0]!.id;
  });

  it('transfers between locations without changing the total', async () => {
    const r = await call('POST', '/v1/admin/stock/transfer', inv, { productId: pid, fromLocationId: nairobi, toLocationId: mombasa, qty: 15 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ available: 40 });
    const lv = (r.json().levels as { locationId: string; onHand: number }[]);
    expect(lv.find((l) => l.locationId === nairobi)!.onHand).toBe(25);
    expect(lv.find((l) => l.locationId === mombasa)!.onHand).toBe(15);
    expect((await call('POST', '/v1/admin/stock/transfer', inv, { productId: pid, fromLocationId: nairobi, toLocationId: mombasa, qty: 500 })).json().error.code).toBe('NEGATIVE_STOCK');
    expect((await call('POST', '/v1/admin/stock/transfer', inv, { productId: pid, fromLocationId: nairobi, toLocationId: nairobi, qty: 1 })).statusCode).toBe(400);
    await expectInvariant();
  });

  it('adjusts stock with a reason, and never below zero', async () => {
    const r = await call('POST', '/v1/admin/stock/adjust', inv, { productId: pid, locationId: mombasa, delta: -3, type: 'Write-off', reason: 'Damaged in storage' });
    expect(r.json()).toMatchObject({ available: 37 });
    expect((await call('POST', '/v1/admin/stock/adjust', inv, { productId: pid, locationId: mombasa, delta: -100, reason: 'Oops' })).json().error.code).toBe('NEGATIVE_STOCK');
    expect((await call('POST', '/v1/admin/stock/adjust', inv, { productId: pid, locationId: mombasa, delta: 1, reason: 'x' })).statusCode).toBe(400);
    expect((await call('POST', '/v1/admin/stock/adjust', support, { productId: pid, locationId: mombasa, delta: 1, reason: 'Not mine to do' })).statusCode).toBe(403);
    await expectInvariant();
  });

  it('records every change with a running balance, and the log cannot be edited', async () => {
    const mv = (await call('GET', `/v1/admin/stock/movements?productId=${pid}&locationId=${mombasa}`, inv)).json().items as { type: string; qty: number; balance: number; by: string }[];
    expect(mv.map((m) => [m.type, m.qty, m.balance])).toEqual([['Write-off', -3, 12], ['Transfer in', 15, 15]]);
    expect(mv[0]!.by).toBe('Kevin');
    await expect(h.db.query('UPDATE stock_movements SET qty = 99')).rejects.toThrow(/append-only/);
    await expect(h.db.query('DELETE FROM stock_movements')).rejects.toThrow(/append-only/);
  });

  it('summarises the warehouse and raises reorder alerts with a suggested quantity', async () => {
    const o = (await call('GET', '/v1/admin/stock/overview', inv)).json();
    expect(o).toMatchObject({ lowStock: 1, outOfStock: 1 });
    // BAG-1 (37) + SHOW-1 (40, archived but still on the shelf) + LOW-1 (4)
    expect(o.units).toBe(37 + 40 + 4);
    expect(o.valueCents).toBe(81 * 260_000);
    expect(o.locations.find((l: { name: string }) => l.name === 'Nairobi Central')).toMatchObject({ capacity: 600, units: 25 + 40 + 4 });
    const al = (await call('GET', '/v1/admin/stock/alerts', inv)).json();
    expect(al.items.map((a: { sku: string; severity: string }) => [a.sku, a.severity]).sort()).toEqual([['LOW-1', 'low'], ['OUT-1', 'out']]);
    expect(al.items.every((a: { suggestedQty: number }) => a.suggestedQty > 0)).toBe(true);
    const saved = await call('PUT', '/v1/admin/stock/alert-rules', inv, { when: 'Below safety stock', digest: 'Weekly', leadDays: 14, bufferPct: 20 });
    expect(saved.statusCode).toBe(200);
    expect((await call('GET', '/v1/admin/stock/alerts', inv)).json().rules).toMatchObject({ leadDays: 14 });
    await call('PUT', '/v1/admin/stock/alert-rules', inv, { when: 'Reorder point', digest: 'Daily at 8:00 AM', leadDays: 7, bufferPct: 15 });
  });
});

describe('orders and shelf stock stay in step', () => {
  let pid: string;
  beforeAll(async () => {
    pid = (await call('POST', '/v1/admin/products', inv, { sku: 'ORD-1', name: 'Order me', priceCents: 100_000, currency: 'KES', initialStock: 10 })).json().id;
  });
  const place = async (qty: number) => {
    const customer = await h.token(uuidv7(), ['customer']);
    const r = await h.app.inject({ method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${customer}`, 'idempotency-key': idemKey() }, payload: { items: [{ productId: pid, quantity: qty }] } });
    expect(r.statusCode).toBe(201);
    return { order: r.json() as { id: string; totalCents: number; currency: string }, customer };
  };
  const pay = async (o: { id: string; totalCents: number; currency: string }) => {
    const payments = await h.token(uuidv7(), ['payments']);
    const res = await h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/payment-confirmation`, headers: { authorization: `Bearer ${payments}` }, payload: { paymentRef: `ref-${uuidv7()}`, amountCents: o.totalCents, currency: o.currency } });
    return res;
  };
  const shelves = async () => Number((await h.db.query('SELECT COALESCE(sum(on_hand),0) AS n FROM stock_levels WHERE product_id = $1', [pid])).rows[0].n);

  it('holds stock while unpaid, takes it off the shelf when paid, and gives it back on cancel', async () => {
    const a = await place(3);
    expect(await shelves()).toBe(10); // reserved but still on the shelf
    await expectInvariant();
    expect((await pay(a.order)).statusCode).toBe(200);
    expect(await shelves()).toBe(7);
    await expectInvariant();
    const sale = (await call('GET', `/v1/admin/stock/movements?productId=${pid}&type=Sale`, inv)).json().items as { qty: number; ref: string }[];
    expect(sale[0]).toMatchObject({ qty: -3 });
    expect(sale[0]!.ref).toMatch(/^SC-\d+$/);

    const cancel = await h.app.inject({ method: 'POST', url: `/v1/orders/${a.order.id}/cancel`, headers: { authorization: `Bearer ${a.customer}` }, payload: {} });
    expect(cancel.statusCode).toBe(200);
    expect(await shelves()).toBe(10);
    await expectInvariant();
  });

  it('cancelling before payment changes nothing on the shelves', async () => {
    const b = await place(2);
    await h.app.inject({ method: 'POST', url: `/v1/orders/${b.order.id}/cancel`, headers: { authorization: `Bearer ${b.customer}` }, payload: {} });
    expect(await shelves()).toBe(10);
    await expectInvariant();
  });

  it('takes a sale from the primary location first, then the others', async () => {
    await call('POST', '/v1/admin/stock/transfer', inv, { productId: pid, fromLocationId: nairobi, toLocationId: mombasa, qty: 8 });
    const c = await place(5); // nairobi has 2, mombasa has 8
    expect((await pay(c.order)).statusCode).toBe(200);
    const lv = (await call('GET', `/v1/admin/products/${pid}`, inv)).json().levels as { location: string; onHand: number }[];
    expect(lv.find((l) => l.location === 'Nairobi Central')!.onHand).toBe(0);
    expect(lv.find((l) => l.location === 'Mombasa Hub')!.onHand).toBe(5);
    await expectInvariant();
  });

  it('the shop’s own stock-adjustment endpoint also keeps locations in step', async () => {
    const r = await call('POST', `/v1/products/${pid}/stock-adjustments`, owner, { delta: 4, reason: 'recount' });
    expect(r.statusCode).toBe(200);
    await expectInvariant();
  });
});
