/**
 * DEVELOPMENT ONLY. Fills an empty database with the demo catalogue the admin screens were designed around:
 * three locations, five categories, brands, suppliers and sixteen products with stock spread across the locations.
 *
 *   npm run demo:catalogue
 *
 * Safe to run twice: it does nothing if any product already exists.
 */
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/infra/logger.js';
import { Database } from '../src/infra/db.js';
import { CatalogService } from '../src/modules/catalog/catalog.js';
import { applyMoves } from '../src/modules/inventory/stock.js';
import type { ProductService } from '../src/modules/products/products.js';

const LOCATIONS: [string, string, number][] = [['Nairobi Central', 'Nairobi', 600], ['Mombasa Hub', 'Mombasa', 300], ['Kisumu Depot', 'Kisumu', 200]];
const SPLIT = [0.6, 0.25, 0.15];
const CATEGORIES: Record<string, string[]> = {
  Bags: ['Totes', 'Backpacks', 'Weekenders'], Clothing: ['Shirts', 'Trousers', 'Outerwear'], Footwear: ['Sneakers', 'Sandals', 'Running'],
  Accessories: ['Wallets', 'Eyewear', 'Scarves'], Home: ['Throws', 'Kitchen', 'Candles'],
};
const BRANDS: Record<string, [string, string]> = { Bags: ['Kilele', 'Nairobi, Kenya'], Clothing: ['Urban Threads', 'Nairobi, Kenya'], Footwear: ['Stride', 'Mombasa, Kenya'], Accessories: ['Nuru', 'Nakuru, Kenya'], Home: ['Nyumba', 'Kisumu, Kenya'] };
const SUPPLIERS: Record<string, { name: string; contact: string; email: string; phone: string; city: string; terms: string; leadDays: number; minOrderCents: number; status: 'active' | 'on_hold' }> = {
  Bags: { name: 'Kilele Leather Works', contact: 'Peter Karanja', email: 'orders@kilele.co.ke', phone: '+254 712 555 018', city: 'Nairobi', terms: 'Net 30', leadDays: 7, minOrderCents: 5_000_000, status: 'active' },
  Clothing: { name: 'Urban Threads Ltd', contact: 'Mercy Achieng', email: 'sales@urbanthreads.co.ke', phone: '+254 722 555 310', city: 'Nairobi', terms: 'Net 30', leadDays: 5, minOrderCents: 4_000_000, status: 'active' },
  Footwear: { name: 'Stride Footwear Co.', contact: 'Hassan Ali', email: 'trade@stride.co.ke', phone: '+254 701 555 204', city: 'Mombasa', terms: 'Net 14', leadDays: 10, minOrderCents: 6_000_000, status: 'active' },
  Accessories: { name: 'Nuru Accessories', contact: 'Grace Wanjiru', email: 'hello@nuru.co.ke', phone: '+254 790 555 511', city: 'Nakuru', terms: 'Net 30', leadDays: 8, minOrderCents: 2_500_000, status: 'active' },
  Home: { name: 'Nyumba Home Goods', contact: 'Samuel Otieno', email: 'accounts@nyumba.co.ke', phone: '+254 733 555 902', city: 'Kisumu', terms: 'Net 45', leadDays: 6, minOrderCents: 3_000_000, status: 'on_hold' },
};
// name, category, subcategory, price (KES), stock, status
const PRODUCTS: [string, string, string, number, number, 'active' | 'draft' | 'archived'][] = [
  ['Canvas Weekender Bag', 'Bags', 'Weekenders', 4500, 46, 'active'], ['Everyday Leather Tote', 'Bags', 'Totes', 4850, 8, 'active'], ['Linen Weekend Shirt', 'Clothing', 'Shirts', 3200, 64, 'active'],
  ['Classic Chino Trousers', 'Clothing', 'Trousers', 3600, 31, 'active'], ['Trail Running Shoes', 'Footwear', 'Running', 6900, 5, 'active'], ['Leather Slides', 'Footwear', 'Sandals', 2400, 52, 'active'],
  ['Minimal Wallet', 'Accessories', 'Wallets', 1800, 120, 'active'], ['Polarised Sunglasses', 'Accessories', 'Eyewear', 2900, 27, 'active'], ['Ceramic Mug Set', 'Home', 'Kitchen', 2200, 0, 'active'],
  ['Woven Throw Blanket', 'Home', 'Throws', 3800, 19, 'active'], ['Packable Rain Jacket', 'Clothing', 'Outerwear', 5200, 14, 'active'], ['Travel Backpack 30L', 'Bags', 'Backpacks', 7400, 23, 'active'],
  ['Canvas Sneakers', 'Footwear', 'Sneakers', 3500, 38, 'active'], ['Silk Scarf', 'Accessories', 'Scarves', 1500, 3, 'active'], ['Scented Candle Trio', 'Home', 'Candles', 2100, 44, 'draft'],
  ['Denim Overshirt', 'Clothing', 'Shirts', 4300, 11, 'archived'],
];

/** A valid EAN-13 barcode. */
function ean13(seed: number): string {
  const body = `616${String(seed).padStart(9, '0').slice(-9)}`;
  const sum = body.split('').reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return body + String((10 - (sum % 10)) % 10);
}

async function main() {
  const cfg = loadConfig({ ...process.env, JWT_ISSUER: process.env.JWT_ISSUER ?? 'x', JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'x', JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY ?? 'x' }, 'worker');
  if (cfg.NODE_ENV === 'production') throw new Error('The demo catalogue can’t be created in production');
  const db = new Database(cfg, createLogger({ level: 'warn', service: 'demo-catalogue' }));
  const actor = { id: 'system', name: 'Demo seed', requestId: 'demo-seed' };
  const catalog = new CatalogService(db, { invalidate: async () => undefined } as unknown as ProductService);
  try {
    if ((await db.read((c) => c.query('SELECT 1 FROM products LIMIT 1'))).rowCount) { console.log('Products already exist; nothing to do.'); return; }
    const locs = [];
    for (const [name, city, capacity] of LOCATIONS) locs.push(await catalog.createLocation({ name, city, capacity, active: true }, actor));
    const cats: Record<string, string> = {}, brands: Record<string, string> = {}, sups: Record<string, string> = {};
    for (const [name, subs] of Object.entries(CATEGORIES)) cats[name] = (await catalog.createCategory({ name, description: `${name} for everyday life, delivered across Nairobi.`, subcategories: subs }, actor)).id;
    for (const [cat, [name, origin]] of Object.entries(BRANDS)) brands[cat] = (await catalog.createBrand({ name, origin, status: 'active' }, actor)).id;
    for (const [cat, s] of Object.entries(SUPPLIERS)) sups[cat] = (await catalog.createSupplier(s, actor)).id;
    let n = 0;
    for (const [name, cat, sub, price, stock, status] of PRODUCTS) {
      n++;
      const p = await catalog.createProduct({
        sku: `SC-${cat.slice(0, 3).toUpperCase()}-${100 + n}`, name, description: `${name}. Quality materials, made to last, delivered across Nairobi.`, priceCents: price * 100, currency: 'KES',
        categoryId: cats[cat]!, subcategory: sub, brandId: brands[cat]!, supplierId: sups[cat]!, costCents: Math.round((price * 0.58) / 10) * 10 * 100, barcode: ean13(n * 7919 + 1),
        tax: 'standard', trackStock: true, status, reorderAt: 10, handle: '', seoTitle: '', seoDesc: '', variants: [], initialStock: 0,
      }, actor);
      if (stock > 0) {
        let left = stock;
        const moves = locs.map((l, i) => {
          const q = i === locs.length - 1 ? left : Math.floor(stock * (SPLIT[i] ?? 0));
          left -= q;
          return { productId: p.id, locationId: l.id, delta: q, type: 'Opening stock' as const, ref: 'DEMO' };
        });
        await db.tx((c) => applyMoves(c, moves, { id: actor.id, name: actor.name }));
      }
    }
    console.log(`Demo catalogue ready: ${locs.length} locations, ${Object.keys(cats).length} categories, ${PRODUCTS.length} products.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
