import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { isUuid, uuidv7 } from '../../infra/uuid.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { patchOf } from '../../http/validate.js';
import { audit, outbox, type Actor, type ProductService } from '../products/products.js';
import { applyMoves, primaryLocation } from '../inventory/stock.js';

const uuid = z.string().refine(isUuid, 'must be a UUID');
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const dupe = (e: unknown, code: string, msg: string): never => {
  if ((e as { code?: string }).code === '23505') throw new ConflictError(code, msg);
  throw e;
};

// ---- schemas -----------------------------------------------------------------------------

export const LocationSchema = z.strictObject({
  name: z.string().trim().min(1).max(80), city: z.string().trim().max(80).default(''),
  capacity: z.number().int().min(0).max(10_000_000).default(0), active: z.boolean().default(true),
});
export const LocationPatchSchema = patchOf(LocationSchema.extend({ primary: z.literal(true).optional() })) as z.ZodType<Partial<z.output<typeof LocationSchema>> & { primary?: true }>;

export const CategorySchema = z.strictObject({
  name: z.string().trim().min(1).max(60), handle: z.string().trim().max(60).optional(),
  description: z.string().trim().max(500).default(''), subcategories: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
});
export const CategoryPatchSchema = patchOf(CategorySchema);

export const BrandSchema = z.strictObject({ name: z.string().trim().min(1).max(80), origin: z.string().trim().max(120).default(''), status: z.enum(['active', 'draft']).default('active') });
export const BrandPatchSchema = patchOf(BrandSchema);

export const SupplierSchema = z.strictObject({
  name: z.string().trim().min(1).max(120), contact: z.string().trim().max(120).default(''), email: z.string().trim().max(254).default(''),
  phone: z.string().trim().max(32).default(''), city: z.string().trim().max(80).default(''), terms: z.string().trim().max(40).default('Net 30'),
  leadDays: z.number().int().min(0).max(365).default(7), minOrderCents: z.number().int().min(0).default(0), status: z.enum(['active', 'on_hold']).default('active'),
});
export const SupplierPatchSchema = patchOf(SupplierSchema);

const Variant = z.strictObject({ name: z.string().trim().max(80), size: z.string().trim().max(30).default(''), color: z.string().trim().max(30).default(''), sku: z.string().trim().max(64).default(''), barcode: z.string().trim().max(32).default('') });
const productFields = {
  name: z.string().trim().min(1).max(200), description: z.string().max(5000).default(''),
  priceCents: z.number().int().min(0).max(1_000_000_000_00), currency: z.string().regex(/^[A-Z]{3}$/).default('KES'),
  categoryId: uuid.nullable().default(null), subcategory: z.string().trim().max(60).default(''),
  brandId: uuid.nullable().default(null), supplierId: uuid.nullable().default(null),
  costCents: z.number().int().min(0).default(0), barcode: z.string().trim().max(32).default(''),
  tax: z.enum(['standard', 'zero']).default('standard'), trackStock: z.boolean().default(true),
  status: z.enum(['active', 'draft', 'archived']).default('active'), reorderAt: z.number().int().min(0).max(1_000_000).default(10),
  handle: z.string().trim().max(120).default(''), seoTitle: z.string().trim().max(120).default(''), seoDesc: z.string().trim().max(300).default(''),
  variants: z.array(Variant).max(100).default([]),
};
export const AdminCreateProductSchema = z.strictObject({
  sku: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/), ...productFields,
  initialStock: z.number().int().min(0).max(10_000_000).default(0), locationId: uuid.optional(),
});
export const AdminUpdateProductSchema = patchOf(z.strictObject(productFields));
export const AdminProductListSchema = z.object({
  q: z.string().trim().max(100).optional(), categoryId: uuid.optional(), status: z.enum(['active', 'draft', 'archived']).optional(),
  stock: z.enum(['in', 'low', 'out']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional(),
});

// ---- shapes ---------------------------------------------------------------------------------

interface ProductRow {
  id: string; sku: string; name: string; description: string; price_cents: number; currency: string; active: boolean; version: number;
  created_at: Date; updated_at: Date; category_id: string | null; category: string | null; subcategory: string; brand_id: string | null; brand: string | null;
  supplier_id: string | null; supplier: string | null; cost_cents: number; barcode: string; tax: string; track_stock: boolean; status: string;
  reorder_at: number; handle: string; seo_title: string; seo_desc: string; variants: unknown; available: number | null; reserved: number | null;
}
const PRODUCT_SELECT = `SELECT p.*, c.name AS category, b.name AS brand, s.name AS supplier, i.available, i.reserved
  FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN inventory i ON i.product_id = p.id`;

export const toAdminProduct = (r: ProductRow) => ({
  id: r.id, sku: r.sku, name: r.name, description: r.description, priceCents: r.price_cents, currency: r.currency,
  categoryId: r.category_id, category: r.category, subcategory: r.subcategory, brandId: r.brand_id, brand: r.brand,
  supplierId: r.supplier_id, supplier: r.supplier, costCents: r.cost_cents, barcode: r.barcode, tax: r.tax, trackStock: r.track_stock,
  status: r.status, reorderAt: r.reorder_at, handle: r.handle, seoTitle: r.seo_title, seoDesc: r.seo_desc, variants: r.variants,
  /** Sellable now. */ available: r.available ?? 0, /** Held for orders awaiting payment. */ reserved: r.reserved ?? 0,
  version: r.version, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

export class CatalogService {
  constructor(private readonly db: Database, private readonly products: ProductService) {}

  // -- locations ---------------------------------------------------------------------------

  async locations() {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; name: string; city: string; capacity: number; active: boolean; sort_order: number; version: number; units: number; skus: number }>(
        `SELECT l.id, l.name, l.city, l.capacity, l.active, l.sort_order, l.version, COALESCE(sum(sl.on_hand), 0)::int AS units, count(sl.product_id) FILTER (WHERE sl.on_hand > 0)::int AS skus
           FROM locations l LEFT JOIN stock_levels sl ON sl.location_id = l.id GROUP BY l.id ORDER BY l.sort_order, l.created_at`);
      const first = rows.find((r) => r.active)?.id ?? rows[0]?.id;
      return rows.map((r) => ({ id: r.id, name: r.name, city: r.city, capacity: r.capacity, active: r.active, primary: r.id === first, units: r.units, products: r.skus, version: r.version }));
    });
  }

  async createLocation(input: z.infer<typeof LocationSchema>, actor: Actor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      const next = (await c.query<{ n: number }>('SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM locations')).rows[0]!.n;
      await c.query('INSERT INTO locations (id, name, city, capacity, active, sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [id, input.name, input.city, input.capacity, input.active, next])
        .catch((e) => dupe(e, 'LOCATION_EXISTS', 'You already have a location with that name'));
      await audit(c, actor, 'location.create', 'location', id, input);
    });
    return (await this.locations()).find((l) => l.id === id)!;
  }

  async updateLocation(id: string, patch: z.infer<typeof LocationPatchSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const cur = (await c.query<{ active: boolean }>('SELECT active FROM locations WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new NotFoundError('Location');
      if (patch.active === false) {
        const units = (await c.query<{ n: number }>('SELECT COALESCE(sum(on_hand), 0)::int AS n FROM stock_levels WHERE location_id = $1', [id])).rows[0]!.n;
        if (units > 0) throw new UnprocessableError('LOCATION_HAS_STOCK', `Move the ${units} unit${units === 1 ? '' : 's'} stored here to another location before switching it off`);
        const others = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM locations WHERE active AND id <> $1', [id])).rows[0]!.n;
        if (!others) throw new UnprocessableError('LAST_LOCATION', 'You need at least one active location');
      }
      if (patch.primary) await c.query('UPDATE locations SET sort_order = (SELECT COALESCE(min(sort_order), 0) - 1 FROM locations) WHERE id = $1', [id]);
      await c.query(
        `UPDATE locations SET name = COALESCE($2, name), city = COALESCE($3, city), capacity = COALESCE($4, capacity), active = COALESCE($5, active), updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, patch.name ?? null, patch.city ?? null, patch.capacity ?? null, patch.active ?? null],
      ).catch((e) => dupe(e, 'LOCATION_EXISTS', 'You already have a location with that name'));
      await audit(c, actor, 'location.update', 'location', id, patch);
    });
    return (await this.locations()).find((l) => l.id === id)!;
  }

  // -- categories ----------------------------------------------------------------------------

  async categories() {
    return this.db.read(async (c) => {
      const { rows: cs } = await c.query<{ id: string; name: string; handle: string; description: string; products: number }>(
        `SELECT c.id, c.name, c.handle, c.description, count(p.id)::int AS products FROM categories c LEFT JOIN products p ON p.category_id = c.id GROUP BY c.id ORDER BY c.sort_order, c.name`);
      const { rows: subs } = await c.query<{ category_id: string; name: string }>('SELECT category_id, name FROM subcategories ORDER BY name');
      return cs.map((x) => ({ ...x, subcategories: subs.filter((s) => s.category_id === x.id).map((s) => s.name) }));
    });
  }

  private async writeSubs(c: Queryable, categoryId: string, names: string[]) {
    const unique = [...new Map([...names].reverse().map((n) => [n.toLowerCase(), n])).values()].reverse();
    await c.query('DELETE FROM subcategories WHERE category_id = $1 AND lower(name) <> ALL($2::text[])', [categoryId, unique.map((n) => n.toLowerCase())]);
    for (const n of unique) await c.query('INSERT INTO subcategories (id, category_id, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [uuidv7(), categoryId, n]);
  }

  async createCategory(input: z.infer<typeof CategorySchema>, actor: Actor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      await c.query('INSERT INTO categories (id, name, handle, description, sort_order) VALUES ($1,$2,$3,$4,(SELECT COALESCE(max(sort_order), 0) + 1 FROM categories))', [id, input.name, slug(input.handle || input.name) || id, input.description])
        .catch((e) => dupe(e, 'CATEGORY_EXISTS', 'That category name or handle is already used'));
      await this.writeSubs(c, id, input.subcategories);
      await audit(c, actor, 'category.create', 'category', id, input);
    });
    return (await this.categories()).find((x) => x.id === id)!;
  }

  async updateCategory(id: string, patch: z.infer<typeof CategoryPatchSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE categories SET name = COALESCE($2, name), handle = COALESCE($3, handle), description = COALESCE($4, description), updated_at = now() WHERE id = $1`,
        [id, patch.name ?? null, patch.handle ? slug(patch.handle) : null, patch.description ?? null],
      ).catch((e) => dupe(e, 'CATEGORY_EXISTS', 'That category name or handle is already used')) as { rowCount: number };
      if (!rowCount) throw new NotFoundError('Category');
      if (patch.subcategories) await this.writeSubs(c, id, patch.subcategories);
      await audit(c, actor, 'category.update', 'category', id, patch);
    });
    return (await this.categories()).find((x) => x.id === id)!;
  }

  async deleteCategory(id: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM products WHERE category_id = $1', [id])).rows[0]!.n;
      if (n > 0) throw new ConflictError('CATEGORY_IN_USE', `${n} product${n === 1 ? ' is' : 's are'} in this category. Move them first.`);
      const { rowCount } = await c.query('DELETE FROM categories WHERE id = $1', [id]);
      if (!rowCount) throw new NotFoundError('Category');
      await audit(c, actor, 'category.delete', 'category', id, {});
    });
  }

  // -- brands ----------------------------------------------------------------------------------

  async brands() {
    return this.db.read(async (c) => (await c.query<{ id: string; name: string; origin: string; status: string; updated_at: Date; products: number }>(
      `SELECT b.id, b.name, b.origin, b.status, b.updated_at, count(p.id)::int AS products FROM brands b LEFT JOIN products p ON p.brand_id = b.id GROUP BY b.id ORDER BY b.name`)).rows
      .map((r) => ({ id: r.id, name: r.name, origin: r.origin, status: r.status, products: r.products, updatedAt: r.updated_at.toISOString() })));
  }
  async createBrand(input: z.infer<typeof BrandSchema>, actor: Actor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      await c.query('INSERT INTO brands (id, name, origin, status) VALUES ($1,$2,$3,$4)', [id, input.name, input.origin, input.status]).catch((e) => dupe(e, 'BRAND_EXISTS', 'You already have a brand with that name'));
      await audit(c, actor, 'brand.create', 'brand', id, input);
    });
    return (await this.brands()).find((b) => b.id === id)!;
  }
  async updateBrand(id: string, patch: z.infer<typeof BrandPatchSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query('UPDATE brands SET name = COALESCE($2, name), origin = COALESCE($3, origin), status = COALESCE($4, status), updated_at = now() WHERE id = $1', [id, patch.name ?? null, patch.origin ?? null, patch.status ?? null])
        .catch((e) => dupe(e, 'BRAND_EXISTS', 'You already have a brand with that name')) as { rowCount: number };
      if (!rowCount) throw new NotFoundError('Brand');
      await audit(c, actor, 'brand.update', 'brand', id, patch);
    });
    return (await this.brands()).find((b) => b.id === id)!;
  }
  async deleteBrand(id: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query('DELETE FROM brands WHERE id = $1', [id]); // products keep working: brand_id becomes null
      if (!rowCount) throw new NotFoundError('Brand');
      await audit(c, actor, 'brand.delete', 'brand', id, {});
    });
  }

  // -- suppliers -------------------------------------------------------------------------------

  async suppliers() {
    return this.db.read(async (c) => (await c.query<{ id: string; name: string; contact: string; email: string; phone: string; city: string; terms: string; lead_days: number; min_order_cents: number; status: string; products: number }>(
      `SELECT s.*, count(p.id)::int AS products FROM suppliers s LEFT JOIN products p ON p.supplier_id = s.id GROUP BY s.id ORDER BY s.name`)).rows
      .map((r) => ({ id: r.id, name: r.name, contact: r.contact, email: r.email, phone: r.phone, city: r.city, terms: r.terms, leadDays: r.lead_days, minOrderCents: r.min_order_cents, status: r.status, products: r.products })));
  }
  async createSupplier(input: z.infer<typeof SupplierSchema>, actor: Actor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      await c.query('INSERT INTO suppliers (id, name, contact, email, phone, city, terms, lead_days, min_order_cents, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, input.name, input.contact, input.email, input.phone, input.city, input.terms, input.leadDays, input.minOrderCents, input.status]).catch((e) => dupe(e, 'SUPPLIER_EXISTS', 'You already have a supplier with that name'));
      await audit(c, actor, 'supplier.create', 'supplier', id, input);
    });
    return (await this.suppliers()).find((s) => s.id === id)!;
  }
  async updateSupplier(id: string, p: z.infer<typeof SupplierPatchSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE suppliers SET name = COALESCE($2, name), contact = COALESCE($3, contact), email = COALESCE($4, email), phone = COALESCE($5, phone), city = COALESCE($6, city),
                terms = COALESCE($7, terms), lead_days = COALESCE($8, lead_days), min_order_cents = COALESCE($9, min_order_cents), status = COALESCE($10, status), updated_at = now() WHERE id = $1`,
        [id, p.name ?? null, p.contact ?? null, p.email ?? null, p.phone ?? null, p.city ?? null, p.terms ?? null, p.leadDays ?? null, p.minOrderCents ?? null, p.status ?? null],
      ).catch((e) => dupe(e, 'SUPPLIER_EXISTS', 'You already have a supplier with that name')) as { rowCount: number };
      if (!rowCount) throw new NotFoundError('Supplier');
      await audit(c, actor, 'supplier.update', 'supplier', id, p);
    });
    return (await this.suppliers()).find((s) => s.id === id)!;
  }

  // -- products (admin view) -----------------------------------------------------------------------

  async listProducts(q: z.infer<typeof AdminProductListSchema>) {
    const after = q.cursor ? decodeCursor(q.cursor, 1)[0]! : null;
    if (after !== null && !isUuid(after)) throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
    return this.db.read(async (c) => {
      const { rows } = await c.query<ProductRow>(
        `${PRODUCT_SELECT}
          WHERE ($1::uuid IS NULL OR p.id < $1)
            AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%' OR p.sku ILIKE '%' || $2 || '%' OR p.barcode = $2)
            AND ($3::uuid IS NULL OR p.category_id = $3) AND ($4::text IS NULL OR p.status = $4)
            AND ($5::text IS NULL OR ($5 = 'out' AND COALESCE(i.available, 0) = 0)
                 OR ($5 = 'low' AND COALESCE(i.available, 0) > 0 AND COALESCE(i.available, 0) <= p.reorder_at)
                 OR ($5 = 'in' AND COALESCE(i.available, 0) > p.reorder_at))
          ORDER BY p.id DESC LIMIT $6`,
        [after, q.q ?? null, q.categoryId ?? null, q.status ?? null, q.stock ?? null, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return { items: page.map(toAdminProduct), nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1]!.id]) : null };
    });
  }

  async getProduct(id: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = $1`, [id])).rows[0];
      if (!r) throw new NotFoundError('Product');
      const { rows: levels } = await c.query<{ location_id: string; name: string; on_hand: number }>(
        `SELECT sl.location_id, l.name, sl.on_hand FROM stock_levels sl JOIN locations l ON l.id = sl.location_id WHERE sl.product_id = $1 ORDER BY l.sort_order`, [id]);
      return { ...toAdminProduct(r), levels: levels.map((l) => ({ locationId: l.location_id, location: l.name, onHand: l.on_hand })) };
    });
  }

  private async assertRefs(c: Queryable, v: { categoryId?: string | null; brandId?: string | null; supplierId?: string | null }) {
    for (const [col, table, val] of [['categoryId', 'categories', v.categoryId], ['brandId', 'brands', v.brandId], ['supplierId', 'suppliers', v.supplierId]] as const) {
      if (val && !(await c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [val])).rowCount) throw new ValidationError([{ path: [col], message: 'does not exist' }]);
    }
  }

  async createProduct(input: z.infer<typeof AdminCreateProductSchema>, actor: Actor) {
    const id = uuidv7();
    const handle = input.handle ? slug(input.handle) : slug(input.name);
    await this.db.tx(async (c) => {
      await this.assertRefs(c, input);
      await c.query(
        `INSERT INTO products (id, sku, name, description, price_cents, currency, active, category_id, subcategory, brand_id, supplier_id, cost_cents, barcode, tax, track_stock, status, reorder_at, handle, seo_title, seo_desc, variants)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [id, input.sku, input.name, input.description, input.priceCents, input.currency, input.status === 'active', input.categoryId, input.subcategory, input.brandId, input.supplierId,
          input.costCents, input.barcode, input.tax, input.trackStock, input.status, input.reorderAt, handle, input.seoTitle, input.seoDesc, JSON.stringify(input.variants)],
      ).catch((e: { code?: string; constraint?: string }) => {
        if (e.code === '23505') throw new ConflictError(e.constraint === 'products_barcode_key' ? 'BARCODE_EXISTS' : 'SKU_EXISTS', e.constraint === 'products_barcode_key' ? 'Another product already uses that barcode' : 'SKU already exists');
        throw e;
      });
      await c.query('INSERT INTO inventory (product_id, available) VALUES ($1, 0)', [id]);
      if (input.initialStock > 0) {
        await applyMoves(c, [{ productId: id, locationId: input.locationId ?? (await primaryLocation(c)), delta: input.initialStock, type: 'Opening stock', ref: 'NEW-PRODUCT' }], { id: actor.id, name: actor.name ?? 'Staff' });
      }
      await audit(c, actor, 'product.create', 'product', id, { ...input, variants: input.variants.length });
      await outbox(c, 'product', id, 'ProductCreated', { id, sku: input.sku, name: input.name });
    });
    await this.products.invalidate(id);
    return this.getProduct(id);
  }

  async updateProduct(id: string, version: number, p: z.infer<typeof AdminUpdateProductSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      await this.assertRefs(c, p);
      const sets: string[] = [];
      const args: unknown[] = [id, version];
      const set = (col: string, val: unknown) => { args.push(val); sets.push(`${col} = $${args.length}`); };
      if (p.name !== undefined) set('name', p.name);
      if (p.description !== undefined) set('description', p.description);
      if (p.priceCents !== undefined) set('price_cents', p.priceCents);
      if (p.currency !== undefined) set('currency', p.currency);
      if (p.categoryId !== undefined) set('category_id', p.categoryId);
      if (p.subcategory !== undefined) set('subcategory', p.subcategory);
      if (p.brandId !== undefined) set('brand_id', p.brandId);
      if (p.supplierId !== undefined) set('supplier_id', p.supplierId);
      if (p.costCents !== undefined) set('cost_cents', p.costCents);
      if (p.barcode !== undefined) set('barcode', p.barcode);
      if (p.tax !== undefined) set('tax', p.tax);
      if (p.trackStock !== undefined) set('track_stock', p.trackStock);
      if (p.status !== undefined) { set('status', p.status); set('active', p.status === 'active'); }
      if (p.reorderAt !== undefined) set('reorder_at', p.reorderAt);
      if (p.handle !== undefined) set('handle', slug(p.handle));
      if (p.seoTitle !== undefined) set('seo_title', p.seoTitle);
      if (p.seoDesc !== undefined) set('seo_desc', p.seoDesc);
      if (p.variants !== undefined) set('variants', JSON.stringify(p.variants));
      const { rowCount } = await c.query(`UPDATE products SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1 AND version = $2`, args)
        .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('BARCODE_EXISTS', 'Another product already uses that barcode'); throw e; }) as { rowCount: number };
      if (!rowCount) {
        if (!(await c.query('SELECT 1 FROM products WHERE id = $1', [id])).rowCount) throw new NotFoundError('Product');
        throw new ConflictError('VERSION_CONFLICT', 'Someone else changed this product. Reload and try again.');
      }
      await audit(c, actor, 'product.update', 'product', id, { version, fields: Object.keys(p) });
      await outbox(c, 'product', id, 'ProductUpdated', { id, fields: Object.keys(p) });
    });
    await this.products.invalidate(id);
    return this.getProduct(id);
  }
}
