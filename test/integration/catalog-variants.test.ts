import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';

let h: Harness;
let owner: string, phones: string;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

const ATTRS = [
  { label: 'Storage', kind: 'choice', choices: ['128GB', '256GB', '512GB'], isOption: true, filterable: true },
  { label: 'Colour', kind: 'choice', choices: ['Black', 'Blue'], isOption: true },
  { label: 'RAM', kind: 'choice', choices: ['6GB', '8GB', '12GB'], required: true, filterable: true },
  { label: 'Screen size', kind: 'number', unit: 'in' },
  { label: '5G', kind: 'yes_no' },
];

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ CUSTOMER_DEV_OTP: '482913' });
  await h.c.staff.ensureDefaultRoles();
  await h.c.staff.insertRaw({ name: 'Amara', email: 'amara@t.co', role: 'Owner admin', status: 'active', password: 'Sunrise#2025!', mustChange: false });
  owner = (await call('POST', '/v1/auth/login', null, { email: 'amara@t.co', password: 'Sunrise#2025!' })).json().accessToken;
  await call('POST', '/v1/admin/zones', owner, { name: 'Kilimani', feeCents: 25_000, areas: ['Kilimani'] });
  phones = (await call('POST', '/v1/admin/categories', owner, { name: 'Phones', subcategories: ['Smartphones'] })).json().id;
});
afterAll(async () => { await h.close(); });

describe('category fields and product variants', () => {
  it('lets a category define its own fields and checks the list', async () => {
    const bad = await call('PUT', `/v1/admin/categories/${phones}/attributes`, owner, { attributes: [{ label: 'Tier', kind: 'choice', choices: ['one'] }, { label: 'tier', kind: 'text' }] });
    expect(bad.statusCode).toBe(400);
    const ok = await call('PUT', `/v1/admin/categories/${phones}/attributes`, owner, { attributes: ATTRS });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().attributes.map((a: { key: string }) => a.key)).toEqual(['storage', 'colour', 'ram', 'screen-size', '5g']);
    expect(ok.json().attributes[0]).toMatchObject({ isOption: true, required: true, filterable: true });
    const cats = (await call('GET', '/v1/admin/categories', owner)).json().items as { id: string; attributes: unknown[] }[];
    expect(cats.find((c) => c.id === phones)!.attributes).toHaveLength(5);
  });

  it('checks a product’s specs and options against its category', async () => {
    const base = { sku: 'PH-1', name: 'Nova X', priceCents: 4_000_000, currency: 'KES', categoryId: phones, initialStock: 5 };
    // RAM is required; colour and storage must be options, not specs; unknown fields are refused
    expect((await call('POST', '/v1/admin/products', owner, { ...base, options: { storage: '256GB', colour: 'Black' } })).json().error.details?.[0]?.path ?? 'x').toBeDefined();
    const missing = await call('POST', '/v1/admin/products', owner, { ...base, options: { storage: '256GB', colour: 'Black' }, specs: {} });
    expect(missing.statusCode).toBe(400);
    expect((await call('POST', '/v1/admin/products', owner, { ...base, options: { storage: '1TB', colour: 'Black' }, specs: { ram: '8GB' } })).statusCode).toBe(400);
    expect((await call('POST', '/v1/admin/products', owner, { ...base, options: { storage: '256GB', colour: 'Black' }, specs: { ram: '8GB', flavour: 'x' } })).statusCode).toBe(400);
    expect((await call('POST', '/v1/admin/products', owner, { ...base, options: { storage: '256GB', colour: 'Black' }, specs: { ram: '8GB', 'screen-size': 'big' } })).statusCode).toBe(400);
    const made = await call('POST', '/v1/admin/products', owner, { ...base, options: { storage: '256gb', colour: 'Black' }, specs: { ram: '8GB', 'screen-size': 6.7, '5g': true } });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ options: { storage: '256GB', colour: 'Black' }, specs: { ram: '8GB', 'screen-size': 6.7, '5g': true } });
    // without a category, specs make no sense
    expect((await call('POST', '/v1/admin/products', owner, { sku: 'X-1', name: 'Plain', priceCents: 1000, currency: 'KES', specs: { ram: '8GB' } })).statusCode).toBe(400);
  });

  it('adds variants that are their own products, keeps shared details in step, and shows them to shoppers', async () => {
    const first = (await call('GET', '/v1/admin/products?q=PH-1', owner)).json().items[0] as { id: string; version: number };
    const add = await call('POST', `/v1/admin/products/${first.id}/variants`, owner, { variants: [
      { sku: 'PH-1-512-BLK', options: { storage: '512GB', colour: 'Black' }, priceCents: 5_000_000, initialStock: 3 },
      { sku: 'PH-1-256-BLU', options: { storage: '256GB', colour: 'Blue' }, initialStock: 2 },
    ] });
    expect(add.statusCode).toBe(201);
    const [big, blue] = add.json().items as { id: string; sku: string; priceCents: number; available: number; groupId: string; specs: Record<string, unknown>; name: string }[];
    expect(big).toMatchObject({ priceCents: 5_000_000, available: 3, name: 'Nova X', specs: { ram: '8GB' } });
    expect(blue!.priceCents).toBe(4_000_000); // price defaults to the original's
    expect(big!.groupId).toBe(add.json().group);

    // the same combination twice is refused, and so is a combination the category doesn't allow
    expect((await call('POST', `/v1/admin/products/${first.id}/variants`, owner, { variants: [{ sku: 'PH-1-DUP', options: { storage: '512GB', colour: 'Black' } }] })).json().error.code).toBe('VARIANT_EXISTS');
    expect((await call('POST', `/v1/admin/products/${first.id}/variants`, owner, { variants: [{ sku: 'PH-1-BAD', options: { storage: '1TB', colour: 'Black' } }] })).statusCode).toBe(400);
    expect((await call('GET', `/v1/admin/products/${big!.id}/variants`, owner)).json().items).toHaveLength(3);

    // a shared detail changed on one variant changes on all, while price and SKU stay their own
    const cur = (await call('GET', `/v1/admin/products/${big!.id}`, owner)).json() as { version: number };
    expect((await call('PATCH', `/v1/admin/products/${big!.id}`, owner, { name: 'Nova X Pro', description: 'Fast', specs: { ram: '12GB' } }, { 'if-match': String(cur.version) })).statusCode).toBe(200);
    const all = (await call('GET', `/v1/admin/products/${first.id}/variants`, owner)).json().items as { name: string; description: string; specs: { ram: string }; priceCents: number }[];
    expect(all.every((p) => p.name === 'Nova X Pro' && p.description === 'Fast' && p.specs.ram === '12GB')).toBe(true);
    expect(all.map((p) => p.priceCents).sort()).toEqual([4_000_000, 4_000_000, 5_000_000]);
    // the category can't change once variants exist
    const other = (await call('POST', '/v1/admin/categories', owner, { name: 'Audio' })).json().id;
    const v2 = (await call('GET', `/v1/admin/products/${first.id}`, owner)).json() as { version: number };
    expect((await call('PATCH', `/v1/admin/products/${first.id}`, owner, { categoryId: other }, { 'if-match': String(v2.version) })).json().error.code).toBe('GROUP_CATEGORY');
    // an option can't be removed from the category while products are sold by it
    expect((await call('PUT', `/v1/admin/categories/${phones}/attributes`, owner, { attributes: ATTRS.filter((a) => a.label !== 'Colour') })).json().error.code).toBe('OPTION_IN_USE');

    // shoppers get the grouping, the options and the field definitions
    const cat = (await call('GET', '/v1/storefront/catalogue', null)).json() as { categories: { id: string; attributes: { key: string; isOption: boolean; filterable: boolean }[] }[]; products: { id: string; groupId: string | null; options: Record<string, string>; specs: Record<string, unknown>; priceCents: number }[] };
    expect(cat.categories.find((c) => c.id === phones)!.attributes.find((a) => a.key === 'storage')).toMatchObject({ isOption: true, filterable: true });
    const mine = cat.products.filter((p) => p.groupId === big!.groupId);
    expect(mine).toHaveLength(3);
    expect(mine.find((p) => p.id === big!.id)).toMatchObject({ options: { storage: '512GB', colour: 'Black' }, priceCents: 5_000_000 });
  });

  it('orders the exact variant chosen, with its options in the line name, and takes stock from it only', async () => {
    const list = (await call('GET', '/v1/storefront/catalogue', null)).json().products as { id: string; options: Record<string, string> }[];
    const blue = list.find((p) => p.options.colour === 'Blue')!;
    await call('POST', '/v1/customer/auth/signup', null, { fullName: 'Var Shopper', email: 'var@example.com', phone: '+254712300001', password: 'sunrise2025' });
    const tok = (await call('POST', '/v1/customer/auth/verify-signup', null, { phone: '+254712300001', code: '482913' })).json().accessToken as string;
    const o = await call('POST', '/v1/orders', tok, { items: [{ productId: blue.id, quantity: 2 }], paymentMethod: 'cod', delivery: { name: 'Pat', phone: '+254 712 555 001', area: 'Kilimani', address: 'Argwings Kodhek Rd' } }, { 'idempotency-key': idemKey() });
    expect(o.statusCode).toBe(201);
    expect(o.json().items[0].name).toBe('Nova X Pro - 256GB / Blue');
    const after = (await call('GET', '/v1/storefront/catalogue', null)).json().products as { id: string; available: number }[];
    expect(after.find((p) => p.id === blue.id)!.available).toBe(0);
    expect(after.filter((p) => p.id !== blue.id).map((p) => p.available).sort()).toEqual([3, 5]);
  });

  it('counts a review of any variant for the whole product, and lets one variant’s photos be copied to the rest', async () => {
    const list = (await call('GET', '/v1/storefront/catalogue', null)).json().products as { id: string; options: Record<string, string> }[];
    const black = list.find((p) => p.options.colour === 'Black')!;
    const blue = list.find((p) => p.options.colour === 'Blue')!;
    // the earlier test ordered the blue one: a review on that order is a review of the product, so it shows on the black one too
    const order = (await h.db.query('SELECT o.id, o.user_id FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE oi.product_id = $1 LIMIT 1', [blue.id])).rows[0];
    await h.db.query(`INSERT INTO reviews (id, order_id, customer_id, customer_name, rating, body) VALUES (gen_random_uuid(), $1, $2, 'Var Shopper', 4, 'Good phone')`, [order.id, order.user_id]);
    const r = (await call('GET', `/v1/storefront/products/${black.id}/reviews`, null)).json();
    expect(r.count).toBe(1);
    expect(r.average).toBe(4);
    const after = (await call('GET', '/v1/storefront/catalogue', null)).json().products as { id: string; reviews?: number }[];
    expect(after.find((p) => p.id === black.id)!.reviews).toBe(1);

    const up = (await h.db.query(`INSERT INTO uploads (id, kind, owner_id, owner_type, content_type, size_bytes, sha256, file_name) VALUES (gen_random_uuid(), 'product-image', 'x', 'staff', 'image/png', 10, 'abc', 'a.png') RETURNING id`)).rows[0].id;
    await h.db.query('INSERT INTO product_images (product_id, upload_id, position) VALUES ($1, $2, 0)', [black.id, up]);
    const done = await call('POST', `/v1/admin/products/${black.id}/copy-images`, owner);
    expect(done.json().copied).toBe(2);
    const n = (await h.db.query('SELECT count(*)::int AS n FROM product_images WHERE upload_id = $1', [up])).rows[0].n;
    expect(n).toBe(3);
    expect((await call('POST', `/v1/admin/products/${black.id}/copy-images`, owner)).json().copied).toBe(0); // the others now have photos
  });
});
