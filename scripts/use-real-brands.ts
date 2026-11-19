/**
 * TEST DATA ONLY. Swaps the made-up brands that `seed:bulk` gave the test products for real, well-known brands that suit each
 * kind of product, renames the products to match, and adds the brands to the brand list so they are ready when real products
 * are added. The products themselves are still test products (invented models, prices and stock).
 *
 *   tsx --env-file=.env.render scripts/use-real-brands.ts
 *
 * Safe to run twice while the shop holds only test products. Do NOT run it once real products with SC- SKUs exist.
 */
import pg from 'pg';

const FICTIONAL = ['Kilele', 'Savanna', 'Zuri', 'Neema', 'Tembo', 'Jua', 'Baraka', 'Nuru', 'Safari', 'Pwani', 'Mavuno', 'Upepo', 'Simba', 'Twiga', 'Kijani', 'Mto', 'Anga', 'Hodari', 'Lulu', 'Zawadi', 'Rafiki', 'Dunia', 'Msitu', 'Kioo'];

const P = (s: string) => s.split(',').map((x) => x.trim());
/** category -> subcategory -> brands (the shop's own list). */
const POOLS: Record<string, Record<string, string[]>> = {
  'Audio & Sound': {
    'Bluetooth speakers': P('JBL, Sony, Anker Soundcore, Bose, Xiaomi'), Earbuds: P('Apple, Samsung, Oraimo, Anker Soundcore, JBL, Sony'), Headphones: P('Sony, JBL, Bose, Sennheiser, Beats'),
    'Home theatre & sound bars': P('Samsung, LG, Sony, Hisense, JBL, Bose'), Microphones: P('Shure, Rode, Maono, Boya, Audio-Technica'),
  },
  'Bags & Accessories': {
    Bags: P('Samsonite, American Tourister, Nike, Adidas, Puma, Herschel'), Eyewear: P('Ray-Ban, Oakley, Police, Carrera'), Watches: P('Casio, Fossil, Seiko, Citizen, Timex, Garmin'),
    Jewellery: P('Pandora, Swarovski, Daniel Wellington, Michael Kors'), Wallets: P('Tommy Hilfiger, Fossil, Levi’s, Calvin Klein'),
  },
  'Beauty & Personal Care': {
    Skincare: P('Nivea, CeraVe, Neutrogena, Vaseline, Garnier, The Ordinary'), 'Hair care': P('Dark & Lovely, TRESemmé, Pantene, Head & Shoulders, Cantu'), Makeup: P('Maybelline, L’Oréal Paris, Revlon, NYX, MAC'),
    Fragrance: P('Calvin Klein, Hugo Boss, Davidoff, Versace, Armaf, Lattafa'), Grooming: P('Gillette, Philips, Braun, Wahl, Axe, Old Spice'),
  },
  Clothing: {
    'Shirts & tops': P('Nike, Adidas, Puma, Tommy Hilfiger, Polo Ralph Lauren'), Dresses: P('Zara, H&M, Mango'), 'Trousers & jeans': P('Levi’s, Wrangler, Lee, Diesel'), Outerwear: P('The North Face, Columbia, Nike, Adidas'),
    Kids: P('Carter’s, Gap, H&M, Mothercare, Nike'), 'Underwear & socks': P('Calvin Klein, Jockey, Hanes, Fruit of the Loom, Puma'),
  },
  'Computers & Laptops': {
    Laptops: P('HP, Dell, Lenovo, Apple, Asus, Acer, Microsoft'), Desktops: P('HP, Dell, Lenovo, Apple, Asus, Acer'), 'Computer accessories': P('Logitech, Razer, Anker, SanDisk, Kingston, TP-Link'),
    Monitors: P('Dell, LG, Samsung, HP, Asus, Philips, ViewSonic'), Printers: P('HP, Canon, Epson, Brother'),
  },
  Groceries: {
    'Food cupboard': P('Pembe, Exe, Elianto, Royco, Blue Band, Heinz, Santa Maria'), Beverages: P('Coca-Cola, Pepsi, Minute Maid, Del Monte, Ketepa, Dormans, Nescafé'),
    'Household supplies': P('Omo, Ariel, Sunlight, Jik, Harpic, Dettol'), Snacks: P('Pringles, Cadbury, Oreo, Kenafric, Tropical Heat'),
  },
  'Home & Kitchen': {
    'Kitchen appliances': P('Ramtons, Von, Hotpoint, Philips, Tefal, Samsung, LG'), Cookware: P('Tefal, Prestige, Tramontina, Pyrex, Lodge'), Bedding: P('Vitafoam, Dunlopillo'),
    Furniture: P('Nilkamal, Ashley, IKEA'), 'Decor & lighting': P('Philips, Osram, Eveready'),
  },
  'Phones & Tablets': {
    Smartphones: P('Samsung, Apple, Xiaomi, Tecno, Infinix, Oppo, Realme, itel, Nokia'), Tablets: P('Apple, Samsung, Lenovo, Xiaomi, Huawei, Amazon'), 'Chargers & cables': P('Anker, Oraimo, Belkin, Baseus, UGREEN'),
    'Phone accessories': P('Spigen, OtterBox, Baseus, ESR'),
  },
  Shoes: {
    Sneakers: P('Nike, Adidas, Puma, New Balance, Converse, Vans, Skechers'), 'Formal shoes': P('Clarks, Bata, Florsheim, Hush Puppies'), Boots: P('Timberland, Caterpillar, Dr. Martens, Clarks'), Sandals: P('Birkenstock, Crocs, Havaianas, Bata'),
  },
  'TVs & Home Entertainment': {
    Televisions: P('Samsung, LG, Sony, Hisense, TCL, Skyworth, Vitron, Philips'), Projectors: P('Epson, BenQ, XGIMI, Optoma, Anker Nebula'), 'Streaming devices': P('Amazon Fire TV, Roku, Apple TV, Google Chromecast'),
  },
};

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL (or DATABASE_MIGRATION_URL)');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    const all = new Set<string>(['HP']);
    for (const subs of Object.values(POOLS)) for (const list of Object.values(subs)) for (const b of list) all.add(b);
    for (const name of all) await c.query('INSERT INTO brands (id, name) VALUES (gen_random_uuid(), $1) ON CONFLICT (lower(name)) DO NOTHING', [name]);
    // A brand that already existed under another capitalisation takes the spelling used here.
    for (const name of all) await c.query('UPDATE brands SET name = $1, updated_at = now() WHERE lower(name) = lower($1) AND name <> $1', [name]);
    const ids = new Map((await c.query<{ id: string; name: string }>('SELECT id, name FROM brands')).rows.map((r) => [r.name.toLowerCase(), r.id]));

    // Every test product (the real HP laptop is left alone). Run this only while the shop holds nothing but test products.
    const rows = (await c.query<{ id: string; cat: string; sub: string; name: string; old: string | null }>(
      `SELECT p.id, c.name AS cat, p.subcategory AS sub, p.name, b.name AS old FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
        WHERE p.sku LIKE 'SC-%' AND p.name NOT ILIKE 'HP 15s%' ORDER BY c.name, p.subcategory, p.id`)).rows;
    const seen = new Map<string, number>();
    const upd: { id: string; name: string; handle: string; brand: string }[] = [];
    for (const r of rows) {
      const pool = POOLS[r.cat]?.[r.sub];
      if (!pool) continue;
      const key = `${r.cat}|${r.sub}`;
      const i = seen.get(key) ?? 0;
      seen.set(key, i + 1);
      const brand = pool[i % pool.length]!;
      const rest = (r.old && r.name.startsWith(`${r.old} `) ? r.name.slice(r.old.length + 1) : r.name.split(' ').slice(1).join(' ')).trim();
      const name = `${brand} ${rest}`.slice(0, 200);
      upd.push({ id: r.id, name, handle: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), brand: ids.get(brand.toLowerCase())! });
    }
    for (let i = 0; i < upd.length; i += 200) {
      const part = upd.slice(i, i + 200);
      await c.query(
        `UPDATE products p SET name = u.name, handle = u.handle, brand_id = u.brand::uuid, version = p.version + 1, updated_at = now()
           FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS u(id, name, handle, brand) WHERE p.id = u.id`,
        [part.map((x) => x.id), part.map((x) => x.name), part.map((x) => x.handle), part.map((x) => x.brand)]);
    }
    // Brands this script and the bulk run added earlier today that nothing uses any more (and are not in the list) go.
    const gone = await c.query("DELETE FROM brands WHERE (name = ANY($1) OR created_at >= date_trunc('day', now())) AND lower(name) <> ALL($2) AND id NOT IN (SELECT brand_id FROM products WHERE brand_id IS NOT NULL)", [FICTIONAL, [...all].map((x) => x.toLowerCase())]);
    await c.query('COMMIT');
    console.log(`Products renamed with real brands: ${upd.length}. Real brands in the list: ${all.size}. Made-up brands removed: ${gone.rowCount}.`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
