import { z } from 'zod';
import type { Database } from '../../infra/db.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { audit, type Actor } from '../products/products.js';
import { patchOf } from '../../http/validate.js';
import type { EngageService } from './engage.js';
import type { PromotionsService } from './promotions.js';

export const PageSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(/^\/[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/, 'start with / and use lowercase words joined by hyphens'),
  audience: z.string().trim().min(1).max(60).default('Website and mobile app'),
  status: z.enum(['draft', 'published']).default('draft'),
  body: z.string().max(50_000).default(''),
  seoTitle: z.string().trim().max(70).default(''),
  seoDesc: z.string().trim().max(170).default(''),
});
export const PagePatchSchema = patchOf(PageSchema);
export const CategoryContentSchema = z.strictObject({
  heading: z.string().trim().max(100).default(''),
  intro: z.string().trim().max(600).default(''),
  cta: z.string().trim().max(40).default(''),
  collection: z.string().trim().max(60).default('Featured'),
  seoTitle: z.string().trim().max(70).default(''),
  seoDesc: z.string().trim().max(170).default(''),
  canonical: z.string().trim().max(300).default(''),
  published: z.boolean().default(false),
});
export const CategoryContentPatchSchema = patchOf(CategoryContentSchema);

interface PageRow { id: string; title: string; slug: string; audience: string; status: string; body: string; seo_title: string; seo_desc: string; updated_by: string | null; updated_at: Date; version: number }
const pageView = (p: PageRow) => ({ id: p.id, title: p.title, slug: p.slug, audience: p.audience, status: p.status, body: p.body, seoTitle: p.seo_title, seoDesc: p.seo_desc, updatedBy: p.updated_by, updatedAt: p.updated_at.toISOString(), version: p.version });
interface CatRow { category_id: string; name: string; handle: string; heading: string | null; intro: string | null; cta: string | null; collection: string | null; seo_title: string | null; seo_desc: string | null; canonical: string | null; published: boolean | null }
const catView = (r: CatRow) => ({ categoryId: r.category_id, name: r.name, handle: r.handle, heading: r.heading ?? '', intro: r.intro ?? '', cta: r.cta ?? '', collection: r.collection ?? 'Featured', seoTitle: r.seo_title ?? '', seoDesc: r.seo_desc ?? '', canonical: r.canonical ?? '', published: r.published ?? false });

export class ContentService {
  constructor(private readonly db: Database) {}

  async pages() {
    return this.db.read(async (c) => ({ items: (await c.query<PageRow>('SELECT * FROM content_pages ORDER BY title')).rows.map((p) => { const { body, ...rest } = pageView(p); return { ...rest, words: body.trim() ? body.trim().split(/\s+/).length : 0 }; }) }));
  }
  async page(id: string) {
    const r = (await this.db.read((c) => c.query<PageRow>('SELECT * FROM content_pages WHERE id = $1', [id]))).rows[0];
    if (!r) throw new NotFoundError('Page');
    return pageView(r);
  }

  async savePage(id: string | null, input: Partial<z.infer<typeof PageSchema>>, actor: Actor) {
    const pid = id ?? uuidv7();
    await this.db.tx(async (c) => {
      let m: z.infer<typeof PageSchema>;
      if (id) {
        const cur = (await c.query<PageRow>('SELECT * FROM content_pages WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw new NotFoundError('Page');
        m = PageSchema.parse({ title: cur.title, slug: cur.slug, audience: cur.audience, status: cur.status, body: cur.body, seoTitle: cur.seo_title, seoDesc: cur.seo_desc, ...input });
      } else m = PageSchema.parse(input);
      if (m.status === 'published' && m.body.trim().length < 40) throw new UnprocessableError('BODY_TOO_SHORT', 'Write the page before publishing');
      if ((await c.query('SELECT 1 FROM content_pages WHERE slug = $1 AND id <> $2', [m.slug, pid])).rowCount) throw new ConflictError('SLUG_EXISTS', 'Another page already uses that address');
      const cols = [m.title, m.slug, m.audience, m.status, m.body, m.seoTitle, m.seoDesc, actor.name ?? actor.id];
      if (id) await c.query('UPDATE content_pages SET title=$2, slug=$3, audience=$4, status=$5, body=$6, seo_title=$7, seo_desc=$8, updated_by=$9, updated_at = now(), version = version + 1 WHERE id = $1', [id, ...cols]);
      else await c.query('INSERT INTO content_pages (id, title, slug, audience, status, body, seo_title, seo_desc, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [pid, ...cols]);
      await audit(c, actor, id ? 'page.update' : 'page.create', 'page', pid, { slug: m.slug, status: m.status });
    });
    return this.page(pid);
  }

  async deletePage(id: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ status: string; slug: string }>('SELECT status, slug FROM content_pages WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new NotFoundError('Page');
      if (r.status === 'published') throw new ConflictError('PAGE_LIVE', 'Unpublish a page before deleting it');
      await c.query('DELETE FROM content_pages WHERE id = $1', [id]);
      await audit(c, actor, 'page.delete', 'page', id, { slug: r.slug });
    });
  }

  // ---- category copy ----------------------------------------------------------------------------------------------------------------------------

  async categories() {
    return this.db.read(async (c) => ({ items: (await c.query<CatRow>(
      `SELECT g.id AS category_id, g.name, g.handle, cc.heading, cc.intro, cc.cta, cc.collection, cc.seo_title, cc.seo_desc, cc.canonical, cc.published FROM categories g LEFT JOIN category_content cc ON cc.category_id = g.id ORDER BY g.sort_order, g.name`)).rows.map(catView) }));
  }

  async saveCategory(categoryId: string, patch: Partial<z.infer<typeof CategoryContentSchema>>, actor: Actor) {
    await this.db.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM categories WHERE id = $1', [categoryId])).rowCount) throw new NotFoundError('Category');
      const cur = (await c.query<CatRow>('SELECT category_id, \'\' AS name, \'\' AS handle, heading, intro, cta, collection, seo_title, seo_desc, canonical, published FROM category_content WHERE category_id = $1 FOR UPDATE', [categoryId])).rows[0];
      const m = CategoryContentSchema.parse({ ...(cur ? { heading: cur.heading, intro: cur.intro, cta: cur.cta, collection: cur.collection, seoTitle: cur.seo_title, seoDesc: cur.seo_desc, canonical: cur.canonical, published: cur.published } : {}), ...patch });
      if (m.published && !m.heading) throw new UnprocessableError('HEADING_REQUIRED', 'Add a heading before publishing the category page');
      await c.query(
        `INSERT INTO category_content (category_id, heading, intro, cta, collection, seo_title, seo_desc, canonical, published, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (category_id) DO UPDATE SET heading=$2, intro=$3, cta=$4, collection=$5, seo_title=$6, seo_desc=$7, canonical=$8, published=$9, updated_by=$10, updated_at = now()`,
        [categoryId, m.heading, m.intro, m.cta, m.collection, m.seoTitle, m.seoDesc, m.canonical, m.published, actor.name ?? actor.id]);
      await audit(c, actor, 'category_content.save', 'category', categoryId, { published: m.published });
    });
    return (await this.categories()).items.find((i) => i.categoryId === categoryId)!;
  }
}

/** What the shop and the app read. Nothing here needs a login, and nothing unpublished or out of date shows. */
export class StorefrontService {
  constructor(private readonly db: Database, private readonly engage: EngageService, private readonly promotions: PromotionsService) {}

  async home(platform: 'web' | 'mobile') {
    const [banners, layout, flash, highlights] = await Promise.all([
      this.db.read(async (c) => (await c.query<{ id: string; title: string; label: string; link: string; platform: string; tone: number; alt: string; image_ref: string | null }>(
        `SELECT id, title, label, link, platform, tone, alt, image_ref FROM banners WHERE published AND now() BETWEEN starts_at AND ends_at AND ($1 = 'web' AND platform <> 'Mobile only' OR $1 = 'mobile' AND platform <> 'Web only') ORDER BY position, created_at`, [platform])).rows),
      this.db.read(async (c) => (await c.query<{ sections: { id: string; name: string; sub: string; enabled: boolean; count: number }[] }>(`SELECT sections FROM home_layouts WHERE slot = 'live'`)).rows[0]),
      this.promotions.livePrices(),
      this.db.read(async (c) => (await c.query<{ customer_name: string; rating: number; body: string; placement: string }>(
        `SELECT r.customer_name, r.rating, r.body, h.placement FROM review_highlights h JOIN reviews r ON r.id = h.review_id WHERE h.published AND r.state = 'visible' ORDER BY h.updated_at DESC LIMIT 12`)).rows),
    ]);
    return {
      banners: banners.map((b) => ({ id: b.id, title: b.title, label: b.label, link: b.link, tone: b.tone, alt: b.alt, imageRef: b.image_ref })),
      sections: (layout?.sections ?? []).filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name, sub: s.sub, count: s.count })),
      onSale: flash.items,
      reviews: highlights.map((h) => ({ customer: h.customer_name.split(' ')[0] ?? '', rating: h.rating, body: h.body, placement: h.placement })),
    };
  }

  async page(slug: string) {
    const r = (await this.db.read((c) => c.query<PageRow>(`SELECT * FROM content_pages WHERE slug = $1 AND status = 'published'`, [slug]))).rows[0];
    if (!r) throw new NotFoundError('Page');
    return { title: r.title, slug: r.slug, body: r.body, seoTitle: r.seo_title || r.title, seoDesc: r.seo_desc, updatedAt: r.updated_at.toISOString() };
  }
  async pages() {
    return this.db.read(async (c) => ({ items: (await c.query<{ title: string; slug: string }>(`SELECT title, slug FROM content_pages WHERE status = 'published' ORDER BY title`)).rows }));
  }
  async category(handle: string) {
    const r = (await this.db.read((c) => c.query<CatRow>(
      `SELECT g.id AS category_id, g.name, g.handle, cc.heading, cc.intro, cc.cta, cc.collection, cc.seo_title, cc.seo_desc, cc.canonical, cc.published FROM categories g JOIN category_content cc ON cc.category_id = g.id WHERE g.handle = $1 AND cc.published`, [handle]))).rows[0];
    if (!r) throw new NotFoundError('Category page');
    const { categoryId: _id, published: _p, ...rest } = catView(r);
    return rest;
  }
  /**
   * Everything the shop screens need in one call: categories (with their sub-categories), brands, and every product that can be bought,
   * with its picture links, the price right now (a live flash sale included) and whether it is in stock. Cached for a short while.
   * Rating is the average of shoppers' reviews of orders that contained the product (there are no separate product reviews yet).
   */
  async catalogue() {
    return this.db.read(async (c) => {
      const cats = (await c.query<{ id: string; name: string; handle: string; description: string }>('SELECT id, name, handle, description FROM categories ORDER BY sort_order, name')).rows;
      const subs = (await c.query<{ category_id: string; name: string }>('SELECT category_id, name FROM subcategories ORDER BY name')).rows;
      const brands = (await c.query<{ id: string; name: string; origin: string }>(`SELECT id, name, origin FROM brands WHERE status = 'active' ORDER BY name`)).rows;
      const prods = (await c.query<{ id: string; name: string; description: string; price_cents: number; currency: string; category: string | null; handle: string | null; subcategory: string; brand: string | null; brand_id: string | null; variants: unknown; available: number | null; created_at: Date; images: string[]; rating: string | null; reviews: number }>(
        `SELECT p.id, p.name, p.description, p.price_cents, p.currency, g.id AS category, g.handle, p.subcategory, b.name AS brand, b.id AS brand_id, p.variants, i.available, p.created_at,
                COALESCE((SELECT array_agg(pi.upload_id::text ORDER BY pi.position) FROM product_images pi WHERE pi.product_id = p.id), '{}') AS images,
                (SELECT round(avg(r.rating)::numeric, 1) FROM reviews r JOIN order_items oi ON oi.order_id = r.order_id WHERE oi.product_id = p.id AND r.state = 'visible') AS rating,
                (SELECT count(*) FROM reviews r JOIN order_items oi ON oi.order_id = r.order_id WHERE oi.product_id = p.id AND r.state = 'visible')::int AS reviews
           FROM products p LEFT JOIN categories g ON g.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN inventory i ON i.product_id = p.id
          WHERE p.status = 'active' AND p.active ORDER BY p.created_at DESC LIMIT 2000`)).rows;
      const sale = new Map((await this.promotions.livePrices()).items.map((s) => [s.productId, s]));
      const cutoff = Date.now() - 14 * 86_400_000;
      return {
        categories: cats.map((g) => ({ id: g.id, handle: g.handle, name: g.name, description: g.description, subcategories: subs.filter((s) => s.category_id === g.id).map((s) => s.name) })),
        brands: brands.map((b) => ({ id: b.id, name: b.name, origin: b.origin })),
        products: prods.map((p) => {
          const s = sale.get(p.id);
          return {
            id: p.id, name: p.name, description: p.description, brand: p.brand, brandId: p.brand_id, categoryId: p.category, categoryHandle: p.handle, subcategory: p.subcategory, currency: p.currency,
            listPriceCents: Number(p.price_cents), priceCents: s ? s.saleCents : Number(p.price_cents), onSale: !!s, saleBadge: s?.badge ?? null, saleEndsAt: s?.endsAt ?? null,
            inStock: (p.available ?? 0) > 0, available: Math.max(0, p.available ?? 0), isNew: p.created_at.getTime() > cutoff, variants: p.variants,
            images: p.images.map((id) => `/v1/files/${id}`), rating: p.rating === null ? null : Number(p.rating), reviews: p.reviews,
          };
        }),
      };
    });
  }

  async bundles() { return { items: (await this.promotions.bundles()).items.filter((b) => b.status === 'Live') }; }
  async programmes() { return { loyalty: await this.engage.loyalty(), referral: await this.engage.referral() }; }
}
