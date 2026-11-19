/**
 * TEST DATA ONLY. Adds 100 products to every category (1,000 in all) through a running admin API, so lists, search, filters and
 * paging can be tried with a full shop. Brands are made up. Run `npm run seed:categories` and the demo staff first.
 *
 *   API_URL=http://127.0.0.1:8090 DEMO_FORCE=true tsx scripts/bulk-demo-products.ts
 *
 * Safe to run twice: it counts what each category already has and only adds the difference.
 * Refuses anything but a local address unless DEMO_FORCE=true. Never point it at the real shop.
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:8090';
const PER_CATEGORY = Number(process.env.PER_CATEGORY ?? 100);
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API) && process.env.DEMO_FORCE !== 'true') {
  console.error(`Refusing to add test products to ${API}. Set DEMO_FORCE=true if you really mean it.`);
  process.exit(1);
}

let token = '';
async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', 'x-client': 'api', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
}

// A small deterministic random generator, so a rerun makes the same catalogue.
let seed = 20261118;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);

const BRANDS = ['Kilele', 'Savanna', 'Zuri', 'Neema', 'Tembo', 'Jua', 'Baraka', 'Nuru', 'Safari', 'Pwani', 'Mavuno', 'Upepo', 'Simba', 'Twiga', 'Kijani', 'Mto', 'Anga', 'Hodari', 'Lulu', 'Zawadi', 'Rafiki', 'Dunia', 'Msitu', 'Kioo'];
const MODELS = ['Pro', 'Lite', 'Max', 'Plus', 'Air', 'Go', 'One', 'Edge', 'Prime', 'Flex', 'Core', 'Neo', 'Ultra', 'Mini', 'Elite', 'Classic', 'Studio', 'Sport', 'Active', 'Essential'];

interface Sub { sub: string; share: number; nouns: string[]; price: [number, number]; blurb: string; fields?: (name: string) => Record<string, string | number | boolean> }
interface Cat { name: string; subs: Sub[]; options: () => Record<string, string>; fields: (sub: string) => Record<string, string | number | boolean>; brandless?: boolean }

const COLOURS = ['Black', 'White', 'Grey', 'Silver', 'Blue', 'Red', 'Green', 'Gold', 'Pink', 'Brown', 'Beige'];
const colour = () => pick(COLOURS);
const WARRANTY = ['6 months', '12 months', '24 months'];

const CATS: Cat[] = [
  {
    name: 'Phones & Tablets', options: () => ({ Storage: pick(['64GB', '128GB', '256GB', '512GB']), Colour: colour() }),
    fields: (s) => s === 'Tablets'
      ? { RAM: pick(['4GB', '6GB', '8GB']), 'Screen size': Math.round(between(8, 12.9) * 10) / 10, Battery: Math.round(between(5000, 10000)), 'Rear camera': pick([8, 12, 13]), Network: pick(['4G', '5G']), 'Operating system': pick(['Android', 'iOS']), 'Dual SIM': false, Warranty: pick(WARRANTY) }
      : { RAM: pick(['4GB', '6GB', '8GB', '12GB']), 'Screen size': Math.round(between(5.5, 6.9) * 10) / 10, Battery: Math.round(between(3800, 6000)), 'Rear camera': pick([12, 48, 50, 64, 108]), Network: pick(['4G', '5G']), 'Operating system': pick(['Android', 'iOS']), 'Dual SIM': rnd() > 0.3, Warranty: pick(WARRANTY) },
    subs: [
      { sub: 'Smartphones', share: 60, nouns: ['Phone', 'Smartphone', '5G Phone'], price: [9_000, 180_000], blurb: 'A smartphone with a bright display, a capable camera and a battery that lasts the day.' },
      { sub: 'Tablets', share: 40, nouns: ['Tablet', 'Tab', 'Pad'], price: [14_000, 120_000], blurb: 'A tablet for reading, streaming, school and work, with a sharp screen and long battery life.' },
    ],
  },
  {
    name: 'Audio & Sound', options: () => ({ Colour: colour() }),
    fields: (s) => ({ Connectivity: s === 'Microphones' ? 'Wired' : pick(['Bluetooth', 'Bluetooth + wired']), 'Power output': Math.round(between(5, 120)), Channels: s === 'Home theatre & sound bars' ? pick(['2.1', '5.1', '7.1']) : 'Stereo (2.0)', 'Battery life': Math.round(between(6, 40)), Waterproof: rnd() > 0.6, 'Remote included': s === 'Home theatre & sound bars', Warranty: pick(WARRANTY) }),
    subs: [
      { sub: 'Bluetooth speakers', share: 25, nouns: ['Bluetooth Speaker', 'Portable Speaker', 'Party Speaker'], price: [2_000, 45_000], blurb: 'A portable speaker with clear sound and deep bass.' },
      { sub: 'Earbuds', share: 25, nouns: ['Wireless Earbuds', 'True Wireless Earbuds', 'Earbuds'], price: [1_500, 30_000], blurb: 'Compact wireless earbuds with a charging case and clear calls.' },
      { sub: 'Headphones', share: 20, nouns: ['Headphones', 'Wireless Headphones', 'Noise-Cancelling Headphones'], price: [2_000, 60_000], blurb: 'Over-ear headphones that are comfortable for hours.' },
      { sub: 'Home theatre & sound bars', share: 15, nouns: ['Sound Bar', 'Home Theatre System', 'Soundbar with Subwoofer'], price: [8_000, 90_000], blurb: 'Fills the room with sound for films, sport and music.' },
      { sub: 'Microphones', share: 15, nouns: ['USB Microphone', 'Wireless Microphone', 'Lapel Microphone'], price: [2_000, 40_000], blurb: 'A microphone for calls, streaming and recording.' },
    ],
  },
  {
    name: 'TVs & Home Entertainment', options: () => ({ 'Screen size': pick(['32"', '40"', '43"', '50"', '55"', '65"', '75"']) }),
    fields: () => ({ Resolution: pick(['HD', 'Full HD', '4K UHD']), Panel: pick(['LED', 'QLED', 'OLED']), 'Smart TV': rnd() > 0.2, 'HDMI ports': pick([2, 3, 4]), Warranty: pick(WARRANTY) }),
    subs: [{ sub: 'Televisions', share: 100, nouns: ['Smart TV', 'LED TV', '4K TV', 'QLED TV'], price: [18_000, 250_000], blurb: 'A television with a sharp picture, built-in apps and plenty of connections.' }],
  },
  {
    name: 'Computers & Laptops', options: () => ({ Storage: pick(['256GB', '512GB', '1TB']), RAM: pick(['8GB', '16GB', '32GB']), Colour: pick(['Black', 'Silver', 'Grey', 'Blue']) }),
    fields: (s) => ({ Processor: pick(['Intel Core i3', 'Intel Core i5', 'Intel Core i7', 'AMD Ryzen 5', 'AMD Ryzen 7']), 'Screen size': s === 'Desktops' ? Math.round(between(21, 27)) : Math.round(between(13.3, 17.3) * 10) / 10, 'Operating system': pick(['Windows', 'Windows', 'Linux', 'None']), Warranty: pick(WARRANTY) }),
    subs: [
      { sub: 'Laptops', share: 65, nouns: ['Laptop', 'Notebook', 'Ultrabook'], price: [45_000, 350_000], blurb: 'A laptop for work, study and entertainment, with fast storage and a long-lasting battery.' },
      { sub: 'Desktops', share: 35, nouns: ['Desktop PC', 'All-in-One PC', 'Tower PC'], price: [40_000, 250_000], blurb: 'A desktop computer with the power for everyday work and more.' },
    ],
  },
  {
    name: 'Clothing', options: () => ({ Size: pick(['S', 'M', 'L', 'XL', 'XXL']), Colour: colour() }),
    fields: (s) => ({ Gender: s === 'Dresses' ? 'Women' : s === 'Kids' ? pick(['Girls', 'Boys']) : pick(['Women', 'Men', 'Unisex']), Material: pick(['100% cotton', 'Cotton blend', 'Polyester', 'Linen', 'Denim']), Fit: pick(['Slim', 'Regular', 'Relaxed']), 'Care instructions': 'Machine wash cold. Do not bleach.' }),
    subs: [
      { sub: 'Shirts & tops', share: 25, nouns: ['T-Shirt', 'Polo Shirt', 'Blouse', 'Hoodie', 'Button-Up Shirt'], price: [600, 5_500], blurb: 'A comfortable top that is easy to dress up or down.' },
      { sub: 'Trousers & jeans', share: 20, nouns: ['Jeans', 'Chinos', 'Cargo Trousers', 'Joggers'], price: [1_200, 6_500], blurb: 'A well-cut pair that holds its shape wash after wash.' },
      { sub: 'Dresses', share: 20, nouns: ['Summer Dress', 'Maxi Dress', 'Wrap Dress', 'Shirt Dress'], price: [1_500, 8_000], blurb: 'A flattering dress for the office, a party or a day out.' },
      { sub: 'Outerwear', share: 15, nouns: ['Jacket', 'Bomber Jacket', 'Rain Coat', 'Cardigan'], price: [2_000, 12_000], blurb: 'A layer for cool mornings and wet days.' },
      { sub: 'Kids', share: 10, nouns: ['Kids T-Shirt', 'Kids Dungarees', 'Kids Hoodie', 'Kids Shorts'], price: [500, 3_500], blurb: 'Soft, hard-wearing clothes for active kids.' },
      { sub: 'Underwear & socks', share: 10, nouns: ['Socks 3-Pack', 'Boxer Briefs 2-Pack', 'Vest 3-Pack'], price: [400, 2_500], blurb: 'Everyday basics in a comfortable fabric.' },
    ],
  },
  {
    name: 'Shoes', options: () => ({ Size: String(pick([38, 39, 40, 41, 42, 43, 44])), Colour: colour() }),
    fields: (s) => ({ Gender: pick(['Women', 'Men', 'Unisex']), Material: pick(['Leather', 'Synthetic leather', 'Canvas', 'Mesh', 'Suede']), Sole: s === 'Formal shoes' ? 'Leather sole' : pick(['Rubber', 'EVA foam', 'Rubber']) }),
    subs: [
      { sub: 'Sneakers', share: 35, nouns: ['Sneakers', 'Running Shoes', 'Trainers', 'Court Shoes'], price: [2_500, 15_000], blurb: 'Light, cushioned and comfortable from morning to night.' },
      { sub: 'Sandals', share: 20, nouns: ['Sandals', 'Slides', 'Open-Toe Sandals'], price: [900, 6_000], blurb: 'Easy to slip on and comfortable in the heat.' },
      { sub: 'Boots', share: 20, nouns: ['Ankle Boots', 'Work Boots', 'Chelsea Boots'], price: [3_500, 14_000], blurb: 'Hard-wearing boots that look as good as they feel.' },
      { sub: 'Formal shoes', share: 25, nouns: ['Oxford Shoes', 'Loafers', 'Derby Shoes', 'Heels'], price: [3_000, 12_000], blurb: 'A polished pair for the office and special occasions.' },
    ],
  },
  {
    name: 'Home & Kitchen', options: () => ({ Colour: colour() }),
    fields: (s) => ({ Material: pick(['Stainless steel', 'Non-stick aluminium', 'Wood', 'Cotton', 'Ceramic', 'Plastic']), ...(s === 'Kitchen appliances' ? { Capacity: Math.round(between(1, 40)), Power: Math.round(between(300, 2200)) } : {}), Dimensions: `${Math.round(between(10, 120))} x ${Math.round(between(10, 90))} x ${Math.round(between(5, 60))} cm`, Warranty: pick(WARRANTY) }),
    subs: [
      { sub: 'Kitchen appliances', share: 30, nouns: ['Blender', 'Kettle', 'Air Fryer', 'Microwave Oven', 'Toaster', 'Rice Cooker'], price: [1_500, 45_000], blurb: 'A kitchen helper that saves time every day.' },
      { sub: 'Cookware', share: 25, nouns: ['Frying Pan', 'Saucepan Set', 'Casserole Pot', 'Baking Tray Set'], price: [900, 15_000], blurb: 'Even heating and an easy-clean finish.' },
      { sub: 'Bedding', share: 20, nouns: ['Duvet Set', 'Bed Sheet Set', 'Pillow Pair', 'Blanket'], price: [800, 12_000], blurb: 'Soft and breathable for a good night’s sleep.' },
      { sub: 'Furniture', share: 15, nouns: ['Coffee Table', 'Bookshelf', 'Office Chair', 'Shoe Rack'], price: [3_000, 120_000], blurb: 'Sturdy furniture that is simple to put together.' },
      { sub: 'Decor & lighting', share: 10, nouns: ['Table Lamp', 'Wall Clock', 'Picture Frame Set', 'LED Strip Lights'], price: [500, 9_000], blurb: 'A finishing touch that brightens any room.' },
    ],
  },
  {
    name: 'Beauty & Personal Care', options: () => ({ 'Size / volume': pick(['30ml', '50ml', '100ml', '200ml', '250ml', '500ml']) }),
    fields: (s) => ({ Shade: s === 'Makeup' ? pick(['Natural', 'Nude', 'Rose', 'Berry', 'Bronze']) : 'Not applicable', 'Skin type': pick(['All skin types', 'Dry', 'Oily', 'Combination', 'Sensitive']), 'Key ingredients': pick(['Shea butter, vitamin E', 'Aloe vera, glycerin', 'Niacinamide, hyaluronic acid', 'Argan oil, coconut oil', 'Vitamin C, green tea']), 'Expiry information': '24 months from manufacture' }),
    subs: [
      { sub: 'Skincare', share: 30, nouns: ['Face Moisturiser', 'Body Lotion', 'Facial Cleanser', 'Sunscreen SPF 50', 'Vitamin C Serum'], price: [300, 6_500], blurb: 'Gentle daily care that leaves skin soft and fresh.' },
      { sub: 'Hair care', share: 20, nouns: ['Shampoo', 'Conditioner', 'Hair Oil', 'Leave-In Treatment'], price: [300, 4_500], blurb: 'Nourishes and protects, from root to tip.' },
      { sub: 'Makeup', share: 20, nouns: ['Lipstick', 'Foundation', 'Mascara', 'Eyeshadow Palette'], price: [400, 5_500], blurb: 'Long-wearing colour that looks natural.' },
      { sub: 'Fragrance', share: 15, nouns: ['Eau de Parfum', 'Body Spray', 'Eau de Toilette'], price: [800, 9_000], blurb: 'A signature scent that lasts through the day.' },
      { sub: 'Grooming', share: 15, nouns: ['Beard Trimmer', 'Shaving Kit', 'Hair Clipper', 'Deodorant'], price: [300, 7_500], blurb: 'Everything for a clean, confident look.' },
    ],
  },
  {
    name: 'Bags & Accessories', options: () => ({ Colour: colour() }),
    fields: (s) => ({ Material: s === 'Watches' ? pick(['Stainless steel', 'Leather strap', 'Silicone']) : pick(['Leather', 'Synthetic leather', 'Canvas', 'Nylon']), Dimensions: `${Math.round(between(10, 50))} x ${Math.round(between(8, 40))} x ${Math.round(between(2, 20))} cm`, Gender: pick(['Women', 'Men', 'Unisex']) }),
    subs: [
      { sub: 'Bags', share: 30, nouns: ['Backpack', 'Tote Bag', 'Crossbody Bag', 'Laptop Bag', 'Handbag'], price: [900, 15_000], blurb: 'Roomy, strong and made for every day.' },
      { sub: 'Watches', share: 20, nouns: ['Analogue Watch', 'Digital Watch', 'Smart Watch', 'Chronograph'], price: [1_500, 40_000], blurb: 'A reliable watch with a clean, easy-to-read face.' },
      { sub: 'Wallets', share: 15, nouns: ['Leather Wallet', 'Card Holder', 'Zip Wallet'], price: [600, 5_000], blurb: 'Slim, tidy and made to last.' },
      { sub: 'Eyewear', share: 20, nouns: ['Sunglasses', 'Blue-Light Glasses', 'Aviator Sunglasses'], price: [700, 8_000], blurb: 'UV-protective lenses in a frame that suits you.' },
      { sub: 'Jewellery', share: 15, nouns: ['Necklace', 'Bracelet', 'Earring Set', 'Ring'], price: [400, 12_000], blurb: 'A simple piece that goes with everything.' },
    ],
  },
  {
    name: 'Groceries', options: () => ({ 'Pack size': pick(['250g', '500g', '1kg', '2kg', '500ml', '1L', '2L', '12 pack']) }),
    fields: (s) => ({ Ingredients: s === 'Household supplies' ? 'See pack' : pick(['Wheat flour, sugar, salt', 'Maize, water, salt', 'Rice', 'Tea leaves', 'Sunflower oil', 'Tomatoes, onion, spices']), 'Storage instructions': 'Store in a cool, dry place.', 'Expiry information': 'Best before 12 months from packing' }),
    subs: [
      { sub: 'Food cupboard', share: 35, nouns: ['Rice', 'Maize Flour', 'Cooking Oil', 'Spaghetti', 'Sugar', 'Tomato Paste', 'Wheat Flour'], price: [100, 2_800], blurb: 'A pantry staple, packed fresh.' },
      { sub: 'Beverages', share: 25, nouns: ['Tea Leaves', 'Instant Coffee', 'Fruit Juice', 'Mineral Water', 'Drinking Chocolate'], price: [80, 1_800], blurb: 'Refreshing and ready whenever you are.' },
      { sub: 'Snacks', share: 20, nouns: ['Crisps', 'Biscuits', 'Peanuts', 'Chocolate Bar', 'Popcorn'], price: [50, 700], blurb: 'A tasty treat for any time of the day.' },
      { sub: 'Household supplies', share: 20, nouns: ['Laundry Detergent', 'Dish Soap', 'Toilet Paper 12-Pack', 'Bleach', 'Paper Towels'], price: [100, 2_200], blurb: 'Keeps the home clean and fresh.' },
    ],
  },
];

interface Attr { key: string; label: string; isOption: boolean }
interface ApiCat { id: string; name: string; subcategories: string[]; attributes: Attr[] }
const toNice = (kes: number) => Math.max(50, Math.round(kes / 50) * 50);

interface Io {
  categories(): Promise<ApiCat[]>; supplier(): Promise<string | null>; brands(): Promise<Map<string, string>>; createBrand(name: string): Promise<string>;
  products(categoryId: string): Promise<{ name: string }[]>; create(body: Record<string, unknown>): Promise<string | null>; close(): Promise<void>;
}

/** Through a running admin API (needs a sign-in). */
async function apiIo(): Promise<Io> {
  const login = await call<{ accessToken?: string }>('POST', '/v1/auth/login', { email: process.env.DEMO_EMAIL ?? 'amara@shopcore.co', password: process.env.DEMO_PASSWORD ?? 'ShopCore#2025' });
  if (!login.data.accessToken) throw new Error('Could not sign in to the API');
  token = login.data.accessToken;
  return {
    categories: async () => (await call<{ items: ApiCat[] }>('GET', '/v1/admin/categories')).data.items,
    supplier: async () => (await call<{ items: { id: string }[] }>('GET', '/v1/admin/suppliers')).data.items[0]?.id ?? null,
    brands: async () => new Map((await call<{ items: { id: string; name: string }[] }>('GET', '/v1/admin/brands')).data.items.map((b) => [b.name, b.id])),
    createBrand: async (name) => (await call<{ id: string }>('POST', '/v1/admin/brands', { name, origin: 'Kenya' })).data.id,
    products: async (id) => (await call<{ items: { name: string }[] }>('GET', `/v1/admin/products?limit=200&categoryId=${id}`)).data.items ?? [],
    create: async (body) => { const r = await call<{ error?: { message: string } }>('POST', '/v1/admin/products', body); return r.status === 201 ? null : `${r.status} ${r.data?.error?.message ?? ''}`; },
    close: async () => undefined,
  };
}

/** Straight through the shop's own product code and the database in DATABASE_URL (no sign-in). Same rules as the admin. */
async function directIo(): Promise<Io> {
  const { loadConfig } = await import('../src/config/index.js');
  const { createLogger } = await import('../src/infra/logger.js');
  const { Database } = await import('../src/infra/db.js');
  const { CatalogService, AdminCreateProductSchema, BrandSchema } = await import('../src/modules/catalog/catalog.js');
  const cfg = loadConfig({ ...process.env, JWT_ISSUER: process.env.JWT_ISSUER ?? 'x', JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'x', JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY ?? 'x' }, 'worker');
  const db = new Database(cfg, createLogger({ level: 'warn', service: 'bulk-demo' }));
  const actor = { id: 'system', name: 'Test data', requestId: 'bulk-demo' };
  const catalog = new CatalogService(db, { invalidate: async () => undefined } as never);
  return {
    categories: async () => (await catalog.categories()) as unknown as ApiCat[],
    supplier: async () => ((await catalog.suppliers()) as { id: string }[])[0]?.id ?? null,
    brands: async () => new Map(((await catalog.brands()) as { id: string; name: string }[]).map((b) => [b.name, b.id])),
    createBrand: async (name) => ((await catalog.createBrand(BrandSchema.parse({ name, origin: 'Kenya' }), actor)) as { id: string }).id,
    products: async (id) => ((await catalog.listProducts({ categoryId: id, limit: 200 } as never)) as { items: { name: string }[] }).items,
    create: async (body) => { try { await catalog.createProduct(AdminCreateProductSchema.parse(body), actor); return null; } catch (e) { return (e as Error).message; } },
    close: () => db.close(),
  };
}

async function main() {
  const io = process.env.DIRECT === 'true' ? await directIo() : await apiIo();
  const cats = await io.categories();
  const supplier = await io.supplier();
  const have = await io.brands();
  for (const b of BRANDS) if (!have.has(b)) have.set(b, await io.createBrand(b));

  let total = 0;
  const only = process.env.ONLY?.split('|');
  for (const cfg of CATS) {
    if (only && !only.includes(cfg.name)) continue;
    const cat = cats.find((c) => c.name === cfg.name);
    if (!cat) { console.log(`skip: no category ${cfg.name}`); continue; }
    const existing = await io.products(cat.id);
    const names = new Set(existing.map((p) => p.name));
    const want = PER_CATEGORY - existing.length;
    if (want <= 0) { console.log(`${cfg.name}: already has ${existing.length}`); continue; }
    const keyOf = (label: string) => cat.attributes.find((a) => a.label === label)?.key;
    const keyed = (vals: Record<string, string | number | boolean>, options: boolean) => {
      const out: Record<string, string | number | boolean> = {};
      for (const [label, v] of Object.entries(vals)) { const a = cat.attributes.find((x) => x.label === label); if (a && a.isOption === options && keyOf(label)) out[a.key] = v; }
      return out;
    };
    // How many of each subcategory, in proportion to its share, adding up to exactly what is wanted.
    const sum = cfg.subs.reduce((n, s) => n + s.share, 0);
    const counts = cfg.subs.map((s) => Math.floor((want * s.share) / sum));
    for (let i = 0; counts.reduce((n, c) => n + c, 0) < want; i = (i + 1) % counts.length) counts[i]!++;
    let made = 0;
    for (const [si, s] of cfg.subs.entries()) {
      for (let n = 0; n < counts[si]!; n++) {
        let name = '';
        for (let tries = 0; tries < 60 && (!name || names.has(name)); tries++) name = `${pick(BRANDS)} ${pick(MODELS)}${rnd() > 0.5 ? ` ${Math.round(between(2, 99))}` : ''} ${pick(s.nouns)}`;
        if (names.has(name)) name = `${name} ${made + 1}`;
        names.add(name);
        const brand = name.split(' ')[0]!;
        const price = toNice(between(s.price[0], s.price[1]) ** 1);
        const body = {
          name, description: `${s.blurb} By ${brand}.`, priceCents: price * 100, costCents: toNice(price * between(0.55, 0.78)) * 100, categoryId: cat.id, subcategory: s.sub,
          brandId: have.get(brand) ?? null, supplierId: supplier, status: 'active', initialStock: Math.round(between(4, 90)), reorderAt: 10,
          specs: keyed(cfg.fields(s.sub), false), options: keyed(cfg.options(), true),
        };
        const problem = await io.create(body);
        if (problem) { console.error(`  ${cfg.name} / ${name}: ${problem}`); if (++failures > 15) throw new Error('Too many failures, stopping.'); continue; }
        made++; total++;
      }
    }
    console.log(`${cfg.name}: added ${made} (now ${existing.length + made})`);
  }
  console.log(`Done. ${total} products added.`);
  await io.close();
}
let failures = 0;
main().catch((e) => { console.error(e); process.exit(1); });
