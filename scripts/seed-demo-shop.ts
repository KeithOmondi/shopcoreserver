/**
 * DEVELOPMENT ONLY. Adds a few realistic products with variants (a phone in several storage sizes and colours, a speaker,
 * a shirt in sizes) so the admin and the shopper app have something to show while you build. It talks to a running API,
 * the same way the admin does, so every rule is checked. Run `npm run seed:categories` first. Safe to run twice: products
 * whose SKU already exists are skipped.
 *
 *   npm run seed:demo            (API at http://127.0.0.1:8080, owner amara@shopcore.co)
 *
 * Refuses to run against anything but a local address unless DEMO_FORCE=true. Never run it on a real shop.
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:8080';
const EMAIL = process.env.DEMO_EMAIL ?? 'amara@shopcore.co';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'ShopCore#2025';

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API) && process.env.DEMO_FORCE !== 'true') {
  console.error(`Refusing to add sample products to ${API}. This is for a local development server only.`);
  process.exit(1);
}

interface Attr { key: string; label: string; isOption: boolean }
interface Cat { id: string; name: string; attributes: Attr[] }
let token = '';

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', 'x-client': 'api', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
}

/** { Storage: '128GB' } -> { storage: '128GB' } using the category's own field keys. */
const keyed = (cat: Cat, values: Record<string, string | number | boolean>, options: boolean) => {
  const out: Record<string, string | number | boolean> = {};
  for (const [label, v] of Object.entries(values)) {
    const a = cat.attributes.find((x) => x.label === label);
    if (!a) throw new Error(`${cat.name} has no field called ${label}. Run npm run seed:categories first.`);
    if (a.isOption === options) out[a.key] = v;
  }
  return out;
};

interface Demo {
  category: string; subcategory: string; name: string; description: string; sku: string; price: number; cost: number; stock: number;
  fields: Record<string, string | number | boolean>;
  variants: { sku: string; price?: number; stock: number; fields: Record<string, string> }[];
}

const DEMO: Demo[] = [
  {
    category: 'Phones & Tablets', subcategory: 'Smartphones', name: 'Nova X Pro', description: 'A fast 5G phone with a bright 6.7 inch screen, all-day battery and a 50MP camera.', sku: 'NOVA-128-BLK', price: 42_000, cost: 34_000, stock: 12,
    fields: { Storage: '128GB', Colour: 'Black', RAM: '8GB', 'Screen size': 6.7, Battery: 5000, 'Rear camera': 50, Network: '5G', 'Operating system': 'Android', 'Dual SIM': true, Warranty: '12 months' },
    variants: [
      { sku: 'NOVA-128-BLU', stock: 8, fields: { Storage: '128GB', Colour: 'Blue' } },
      { sku: 'NOVA-256-BLK', price: 48_500, stock: 6, fields: { Storage: '256GB', Colour: 'Black' } },
      { sku: 'NOVA-256-BLU', price: 48_500, stock: 4, fields: { Storage: '256GB', Colour: 'Blue' } },
    ],
  },
  {
    category: 'Audio & Sound', subcategory: 'Bluetooth speakers', name: 'Pulse Bluetooth Speaker', description: 'A rugged, waterproof speaker with deep bass and 12 hours of playtime.', sku: 'PULSE-BLK', price: 6_500, cost: 4_300, stock: 25,
    fields: { Colour: 'Black', Connectivity: 'Bluetooth', 'Power output': 20, 'Battery life': 12, Waterproof: true, Warranty: '6 months' },
    variants: [{ sku: 'PULSE-BLU', stock: 15, fields: { Colour: 'Blue' } }, { sku: 'PULSE-RED', stock: 10, fields: { Colour: 'Red' } }],
  },
  {
    category: 'Clothing', subcategory: 'Shirts & tops', name: 'Everyday Cotton Tee', description: 'A soft, breathable cotton t-shirt for everyday wear.', sku: 'TEE-M-WHT', price: 1_200, cost: 600, stock: 30,
    fields: { Size: 'M', Colour: 'White', Gender: 'Unisex', Material: '100% cotton', Fit: 'Regular', 'Care instructions': 'Machine wash cold' },
    variants: ['S', 'L', 'XL'].map((s) => ({ sku: `TEE-${s}-WHT`, stock: 20, fields: { Size: s, Colour: 'White' } })),
  },
];

async function main() {
  const login = await call<{ accessToken: string }>('POST', '/v1/auth/login', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) throw new Error(`Could not sign in as ${EMAIL} (${login.status}). Set DEMO_EMAIL and DEMO_PASSWORD.`);
  token = login.data.accessToken;
  const cats = (await call<{ items: Cat[] }>('GET', '/v1/admin/categories')).data.items;
  let made = 0;
  for (const d of DEMO) {
    const cat = cats.find((c) => c.name === d.category);
    if (!cat) { console.log(`skip ${d.name}: no "${d.category}" category (run npm run seed:categories)`); continue; }
    const created = await call<{ id: string; error?: { message: string } }>('POST', '/v1/admin/products', {
      sku: d.sku, name: d.name, description: d.description, priceCents: d.price * 100, costCents: d.cost * 100, categoryId: cat.id, subcategory: d.subcategory,
      initialStock: d.stock, status: 'active', specs: keyed(cat, d.fields, false), options: keyed(cat, d.fields, true),
    });
    if (created.status === 409) { console.log(`skip ${d.name}: ${d.sku} already exists`); continue; }
    if (created.status !== 201) throw new Error(`${d.name}: ${created.status} ${created.data?.error?.message ?? ''}`);
    const v = await call<{ error?: { message: string } }>('POST', `/v1/admin/products/${created.data.id}/variants`, {
      variants: d.variants.map((x) => ({ sku: x.sku, priceCents: (x.price ?? d.price) * 100, initialStock: x.stock, options: keyed(cat, x.fields, true) })),
    });
    if (v.status !== 201) throw new Error(`${d.name} variants: ${v.status} ${v.data?.error?.message ?? ''}`);
    made++;
    console.log(`added ${d.name} with ${d.variants.length + 1} variants`);
  }
  console.log(made ? `Done: ${made} products added.` : 'Nothing new to add.');
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
