/**
 * Creates a starter set of categories, each with the fields its products need (a phone has storage and RAM, a shirt has size and colour).
 * Safe on a real shop and safe to run twice: a category that already exists is left alone, and fields are only added to a category
 * that has none. Edit or add to them afterwards in the admin (Inventory > Categories).
 *
 *   npm run seed:categories
 */
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/infra/logger.js';
import { Database } from '../src/infra/db.js';
import { CatalogService } from '../src/modules/catalog/catalog.js';
import type { AttributeInput } from '../src/modules/catalog/attributes.js';
import type { ProductService } from '../src/modules/products/products.js';

type A = Partial<AttributeInput> & Pick<AttributeInput, 'label' | 'kind'>;
const choice = (label: string, choices: string[], more: Partial<AttributeInput> = {}): A => ({ label, kind: 'choice', choices, ...more });
const text = (label: string, more: Partial<AttributeInput> = {}): A => ({ label, kind: 'text', ...more });
const num = (label: string, unit: string, more: Partial<AttributeInput> = {}): A => ({ label, kind: 'number', unit, ...more });
const yes = (label: string, more: Partial<AttributeInput> = {}): A => ({ label, kind: 'yes_no', ...more });
const COLOURS = ['Black', 'White', 'Grey', 'Silver', 'Blue', 'Red', 'Green', 'Gold', 'Pink', 'Brown', 'Beige'];

const TAXONOMY: { name: string; description: string; subs: string[]; attrs: A[] }[] = [
  {
    name: 'Phones & Tablets', description: 'Smartphones, tablets and accessories', subs: ['Smartphones', 'Tablets', 'Phone accessories', 'Chargers & cables'],
    attrs: [
      choice('Storage', ['32GB', '64GB', '128GB', '256GB', '512GB', '1TB'], { isOption: true, filterable: true }), choice('Colour', COLOURS, { isOption: true, filterable: true }),
      choice('RAM', ['2GB', '3GB', '4GB', '6GB', '8GB', '12GB', '16GB'], { filterable: true }), num('Screen size', 'in', { filterable: true }), num('Battery', 'mAh'), num('Rear camera', 'MP'),
      choice('Network', ['4G', '5G'], { filterable: true }), choice('Operating system', ['Android', 'iOS', 'Other']), yes('Dual SIM'), text('Warranty'),
    ],
  },
  {
    name: 'Audio & Sound', description: 'Speakers, sound systems, headphones and earbuds', subs: ['Bluetooth speakers', 'Home theatre & sound bars', 'Headphones', 'Earbuds', 'Microphones'],
    attrs: [
      choice('Colour', COLOURS, { isOption: true, filterable: true }), choice('Connectivity', ['Bluetooth', 'Wired', 'Bluetooth + wired', 'Wi-Fi'], { filterable: true }), num('Power output', 'W', { filterable: true }),
      choice('Channels', ['Stereo (2.0)', '2.1', '5.1', '7.1']), num('Battery life', 'hrs'), yes('Waterproof'), yes('Remote included'), text('Warranty'),
    ],
  },
  {
    name: 'TVs & Home Entertainment', description: 'Televisions, projectors and streaming devices', subs: ['Televisions', 'Projectors', 'Streaming devices'],
    attrs: [
      choice('Screen size', ['24"', '32"', '40"', '43"', '50"', '55"', '65"', '75"'], { isOption: true, filterable: true }), choice('Resolution', ['HD', 'Full HD', '4K UHD', '8K'], { filterable: true }),
      choice('Panel', ['LED', 'QLED', 'OLED']), yes('Smart TV', { filterable: true }), num('HDMI ports', ''), text('Warranty'),
    ],
  },
  {
    name: 'Computers & Laptops', description: 'Laptops, desktops, monitors and accessories', subs: ['Laptops', 'Desktops', 'Monitors', 'Printers', 'Computer accessories'],
    attrs: [
      choice('Storage', ['128GB', '256GB', '512GB', '1TB', '2TB'], { isOption: true, filterable: true }), choice('RAM', ['4GB', '8GB', '16GB', '32GB', '64GB'], { isOption: true, filterable: true }),
      choice('Colour', COLOURS, { isOption: true }), text('Processor'), num('Screen size', 'in', { filterable: true }), choice('Operating system', ['Windows', 'macOS', 'Linux', 'None']), text('Warranty'),
    ],
  },
  {
    name: 'Clothing', description: 'Clothes for women, men and children', subs: ['Shirts & tops', 'Trousers & jeans', 'Dresses', 'Outerwear', 'Underwear & socks', 'Kids'],
    attrs: [
      choice('Size', ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'], { isOption: true, filterable: true }), choice('Colour', COLOURS, { isOption: true, filterable: true }),
      choice('Gender', ['Women', 'Men', 'Unisex', 'Girls', 'Boys'], { filterable: true }), text('Material'), choice('Fit', ['Slim', 'Regular', 'Relaxed', 'Oversized']), text('Care instructions'),
    ],
  },
  {
    name: 'Shoes', description: 'Sneakers, sandals, boots and formal shoes', subs: ['Sneakers', 'Sandals', 'Boots', 'Formal shoes'],
    attrs: [
      choice('Size', ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46'], { isOption: true, filterable: true }), choice('Colour', COLOURS, { isOption: true, filterable: true }),
      choice('Gender', ['Women', 'Men', 'Unisex', 'Girls', 'Boys'], { filterable: true }), text('Material'), text('Sole'),
    ],
  },
  {
    name: 'Home & Kitchen', description: 'Appliances, cookware, furniture and home decor', subs: ['Kitchen appliances', 'Cookware', 'Furniture', 'Bedding', 'Decor & lighting'],
    attrs: [choice('Colour', COLOURS, { isOption: true, filterable: true }), text('Material'), num('Capacity', 'L'), num('Power', 'W'), text('Dimensions'), text('Warranty')],
  },
  {
    name: 'Beauty & Personal Care', description: 'Skincare, makeup, hair care and fragrance', subs: ['Skincare', 'Makeup', 'Hair care', 'Fragrance', 'Grooming'],
    attrs: [text('Size / volume', { isOption: true }), text('Shade', { isOption: false }), choice('Skin type', ['All skin types', 'Dry', 'Oily', 'Combination', 'Sensitive']), text('Key ingredients'), text('Expiry information')],
  },
  {
    name: 'Bags & Accessories', description: 'Bags, wallets, watches and fashion accessories', subs: ['Bags', 'Wallets', 'Watches', 'Eyewear', 'Jewellery'],
    attrs: [choice('Colour', COLOURS, { isOption: true, filterable: true }), text('Material'), text('Dimensions'), choice('Gender', ['Women', 'Men', 'Unisex'], { filterable: true })],
  },
  {
    name: 'Groceries', description: 'Food, drinks and household supplies', subs: ['Food cupboard', 'Beverages', 'Snacks', 'Household supplies'],
    attrs: [text('Pack size', { isOption: true, required: true }), text('Ingredients'), text('Storage instructions'), text('Expiry information')],
  },
];

async function main() {
  const cfg = loadConfig({ ...process.env, JWT_ISSUER: process.env.JWT_ISSUER ?? 'x', JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'x', JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY ?? 'x' }, 'worker');
  const db = new Database(cfg, createLogger({ level: 'warn', service: 'seed-categories' }));
  const actor = { id: 'system', name: 'Category seed', requestId: 'seed-categories' };
  const catalog = new CatalogService(db, { invalidate: async () => undefined } as unknown as ProductService);
  try {
    const have = new Map((await catalog.categories()).map((c) => [c.name.toLowerCase(), c]));
    let made = 0, filled = 0;
    for (const t of TAXONOMY) {
      let cat = have.get(t.name.toLowerCase());
      if (!cat) { cat = await catalog.createCategory({ name: t.name, description: t.description, subcategories: t.subs }, actor); made++; }
      if (!cat.attributes.length) {
        await catalog.saveAttributes(cat.id, { attributes: t.attrs.map((a) => ({ unit: '', choices: [], isOption: false, required: false, filterable: false, ...a })) }, actor);
        filled++;
      }
    }
    console.log(`Categories created: ${made}. Categories given their fields: ${filled}. (Existing ones were left as they are.)`);
  } finally {
    await db.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
