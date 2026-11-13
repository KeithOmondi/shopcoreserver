import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { audit, type Actor } from '../products/products.js';
import { patchOf } from '../../http/validate.js';
import { feeFor } from '../dispatch/zones.js';
import { inSegment } from './audience.js';

const uuid = z.string().uuid();
const when = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date and time').transform((s) => new Date(s).toISOString());
const Money = z.number().int().min(0).max(100_000_000_000);

// ============ rules shared by offers ============================================================================================================

export interface MarketingRules { noStackFlash: boolean; bundlePoints: boolean }
export const RulesSchema = z.strictObject({ noStackFlash: z.boolean(), bundlePoints: z.boolean() });
export async function marketingRules(c: Queryable): Promise<MarketingRules> {
  const r = (await c.query<{ value: Partial<MarketingRules> }>(`SELECT value FROM settings WHERE key = 'marketing.rules'`)).rows[0];
  return { noStackFlash: true, bundlePoints: true, ...(r?.value ?? {}) };
}

// ============ coupons ==============================================================================================================================

export const CouponSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,24}$/, '3 to 24 letters, digits, - or _'),
  type: z.enum(['percent', 'fixed', 'free_delivery']),
  value: z.number().min(0).max(100_000_000_000).default(0),
  minSpendCents: Money.default(0),
  maxDiscountCents: Money.default(0),
  limit: z.number().int().min(1).max(10_000_000),
  perCustomer: z.number().int().min(1).max(1000).default(1),
  startsAt: when,
  endsAt: when,
  state: z.enum(['draft', 'live', 'paused']).default('draft'),
  categoryIds: z.array(uuid).max(50).default([]),
  audience: z.enum(['all', 'new', 'segment']).default('all'),
  segmentId: uuid.nullable().default(null),
  combine: z.boolean().default(false),
  note: z.string().trim().max(300).default(''),
});
export const CouponPatchSchema = patchOf(CouponSchema);
export const CouponStateSchema = z.strictObject({ ids: z.array(uuid).min(1).max(100), state: z.enum(['live', 'paused']) });
export const CouponListSchema = z.object({
  status: z.enum(['Draft', 'Scheduled', 'Active', 'Paused', 'Exhausted', 'Ended']).optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type CouponInput = z.infer<typeof CouponSchema>;

function checkCoupon(c: CouponInput) {
  if (c.type === 'percent' && !(Number.isInteger(c.value) && c.value >= 1 && c.value <= 100)) throw new UnprocessableError('BAD_VALUE', 'A percentage coupon takes a whole number from 1 to 100');
  if (c.type === 'fixed' && !(Number.isInteger(c.value) && c.value >= 1)) throw new UnprocessableError('BAD_VALUE', 'A fixed coupon takes an amount of at least one cent');
  if (Date.parse(c.endsAt) <= Date.parse(c.startsAt)) throw new UnprocessableError('BAD_DATES', 'The end must be after the start');
  if (c.audience === 'segment' && !c.segmentId) throw new UnprocessableError('SEGMENT_REQUIRED', 'Choose the segment this coupon is for');
}

interface CouponRow {
  id: string; name: string; code: string; kind: 'percent' | 'fixed' | 'free_delivery'; value: number; min_spend_cents: number; max_discount_cents: number; usage_limit: number; per_customer: number;
  starts_at: Date; ends_at: Date; state: string; category_ids: string[]; audience: string; segment_id: string | null; combine: boolean; note: string; created_by: string; version: number;
  used?: number; given?: number;
}
const couponStatus = (r: CouponRow, now = Date.now()) =>
  r.state === 'draft' ? 'Draft' : r.state === 'paused' ? 'Paused' : Number(r.used ?? 0) >= r.usage_limit ? 'Exhausted' : now < r.starts_at.getTime() ? 'Scheduled' : now > r.ends_at.getTime() ? 'Ended' : 'Active';
const couponView = (r: CouponRow) => ({
  id: r.id, name: r.name, code: r.code, type: r.kind, value: Number(r.value), minSpendCents: Number(r.min_spend_cents), maxDiscountCents: Number(r.max_discount_cents), limit: r.usage_limit, perCustomer: r.per_customer,
  startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(), state: r.state, status: couponStatus(r), categoryIds: r.category_ids, audience: r.audience, segmentId: r.segment_id, combine: r.combine, note: r.note,
  redemptions: Number(r.used ?? 0), discountGivenCents: Number(r.given ?? 0), createdBy: r.created_by, version: r.version,
});
const COUPON_SELECT = `SELECT c.*, COALESCE((SELECT count(*) FROM coupon_redemptions r WHERE r.coupon_id = c.id AND r.released_at IS NULL),0)::int AS used,
                              COALESCE((SELECT sum(discount_cents) FROM coupon_redemptions r WHERE r.coupon_id = c.id AND r.released_at IS NULL),0)::bigint AS given FROM coupons c`;

// ============ flash sales ==========================================================================================================================

export const FlashSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  startsAt: when,
  endsAt: when,
  type: z.enum(['percent', 'fixed']),
  value: z.number().int().min(1).max(100_000_000),
  productIds: z.array(uuid).min(1).max(200),
  placement: z.enum(['Home carousel', 'Category pages', 'Product pages only']).default('Home carousel'),
  stockGuard: z.number().int().min(0).max(100_000).default(10),
  state: z.enum(['draft', 'live']).default('draft'),
});
export const FlashPatchSchema = patchOf(FlashSchema);
export type FlashInput = z.infer<typeof FlashSchema>;
const saleStatus = (state: string, s: Date, e: Date, now = Date.now()) => (state === 'draft' ? 'Draft' : now < s.getTime() ? 'Scheduled' : now > e.getTime() ? 'Ended' : 'Live');
const salePrice = (kind: string, value: number, price: number) => Math.max(1, kind === 'percent' ? Math.round((price * (100 - value)) / 100) : price - value);

// ============ bundles ==============================================================================================================================

export const BundleSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['Bundle', 'Multi-buy', 'Cross-sell']),
  description: z.string().trim().max(300).default(''),
  items: z.array(z.strictObject({ productId: uuid, quantity: z.number().int().min(1).max(100).default(1) })).max(20).default([]),
  priceCents: Money.default(0),
  percent: z.number().min(0).max(90).default(0),
  minItems: z.number().int().min(0).max(100).default(0),
  state: z.enum(['draft', 'live']).default('draft'),
  startsAt: when.optional(),
});
export const BundlePatchSchema = patchOf(BundleSchema);
export type BundleInput = z.infer<typeof BundleSchema>;

// ============ pricing a basket at checkout ===========================================================================================================

export interface PricingLineIn { productId: string; priceCents: number; categoryId: string | null; quantity: number }
export interface PricedLine extends PricingLineIn { unitCents: number; flashSaleId: string | null }
export interface Pricing {
  lines: PricedLine[]; subtotalCents: number; bundle: { id: string; name: string; discountCents: number } | null; coupon: { id: string; code: string; discountCents: number } | null; discountCents: number;
}

async function flashPrices(c: Queryable, productIds: string[]) {
  const { rows } = await c.query<{ product_id: string; sale_id: string; kind: string; value: number; price_cents: number }>(
    `SELECT fp.product_id, s.id AS sale_id, s.kind, s.value, p.price_cents
       FROM flash_sales s JOIN flash_sale_products fp ON fp.sale_id = s.id JOIN products p ON p.id = fp.product_id LEFT JOIN inventory i ON i.product_id = p.id
      WHERE s.state = 'live' AND now() BETWEEN s.starts_at AND s.ends_at AND fp.product_id = ANY($1::uuid[]) AND COALESCE(i.available, 0) > s.stock_guard`, [productIds]);
  const best = new Map<string, { saleId: string; priceCents: number }>();
  for (const r of rows) {
    const price = salePrice(r.kind, Number(r.value), Number(r.price_cents));
    const cur = best.get(r.product_id);
    if (!cur || price < cur.priceCents) best.set(r.product_id, { saleId: r.sale_id, priceCents: price });
  }
  return best;
}

/** The single best bundle offer a basket qualifies for, as a saving in cents. */
async function bestBundle(c: Queryable, lines: PricedLine[], rules: MarketingRules) {
  const usable = lines.filter((l) => !(rules.noStackFlash && l.flashSaleId));
  const qty = new Map(usable.map((l) => [l.productId, l]));
  const { rows } = await c.query<{ id: string; name: string; kind: string; price_cents: number; percent: string; min_items: number; items: { product_id: string; quantity: number }[] }>(
    `SELECT b.id, b.name, b.kind, b.price_cents, b.percent, b.min_items,
            COALESCE((SELECT json_agg(json_build_object('product_id', i.product_id, 'quantity', i.quantity)) FROM bundle_items i WHERE i.bundle_id = b.id), '[]') AS items
       FROM bundles b WHERE b.state = 'live' AND b.starts_at <= now()`);
  let best: { id: string; name: string; discountCents: number } | null = null;
  for (const b of rows) {
    let saving = 0;
    if (b.kind === 'Multi-buy') {
      const eligible = b.items.length ? usable.filter((l) => b.items.some((i) => i.product_id === l.productId)) : usable;
      if (eligible.reduce((n, l) => n + l.quantity, 0) >= Math.max(1, b.min_items)) saving = Math.round((eligible.reduce((n, l) => n + l.unitCents * l.quantity, 0) * Number(b.percent)) / 100);
    } else if (b.items.length) {
      let times = Infinity;
      let standalone = 0;
      for (const i of b.items) {
        const l = qty.get(i.product_id);
        if (!l) { times = 0; break; }
        times = Math.min(times, Math.floor(l.quantity / i.quantity));
        standalone += l.unitCents * i.quantity;
      }
      if (times >= 1 && standalone > Number(b.price_cents)) saving = (standalone - Number(b.price_cents)) * times;
    }
    if (saving > 0 && (!best || saving > best.discountCents)) best = { id: b.id, name: b.name, discountCents: saving };
  }
  return best;
}

/**
 * Prices a basket the way checkout will: flash-sale prices first, then the best bundle, then an optional coupon.
 * Locks the coupon row, so two orders can't both take its last use. Throws COUPON_INVALID with a reason a shopper can read.
 */
export async function priceBasket(c: Queryable, userId: string, items: { productId: string; priceCents: number; categoryId: string | null; quantity: number }[], feeCents: number, couponCode: string | undefined, lockCoupon: boolean): Promise<Pricing> {
  const rules = await marketingRules(c);
  const flash = await flashPrices(c, items.map((i) => i.productId));
  const lines: PricedLine[] = items.map((i) => { const f = flash.get(i.productId); return { ...i, unitCents: f ? Math.min(f.priceCents, i.priceCents) : i.priceCents, flashSaleId: f ? f.saleId : null }; });
  const subtotal = lines.reduce((n, l) => n + l.unitCents * l.quantity, 0);
  const bundle = await bestBundle(c, lines, rules);
  let coupon: Pricing['coupon'] = null;
  if (couponCode) {
    const code = couponCode.trim().toUpperCase();
    // Lock first, then read: the counts must be taken after any other order using this coupon has finished.
    if (lockCoupon) await c.query('SELECT 1 FROM coupons WHERE code = $1 FOR UPDATE', [code]);
    const row = (await c.query<CouponRow>(`${COUPON_SELECT} WHERE c.code = $1`, [code])).rows[0];
    const refuse = (reason: string) => { throw new UnprocessableError('COUPON_INVALID', reason, { code }); };
    if (!row) return refuse('That coupon code doesn’t exist.');
    const st = couponStatus(row);
    if (st !== 'Active') return refuse(st === 'Scheduled' ? 'This coupon isn’t active yet.' : `This coupon is ${st.toLowerCase()}.`);
    if (bundle && !row.combine) return refuse('This coupon can’t be combined with the bundle offer on your basket.');
    const eligible = lines.filter((l) => !(rules.noStackFlash && l.flashSaleId) && (!row.category_ids.length || (l.categoryId && row.category_ids.includes(l.categoryId))));
    const eligibleCents = eligible.reduce((n, l) => n + l.unitCents * l.quantity, 0);
    if (row.kind !== 'free_delivery' && !eligible.length) return refuse(row.category_ids.length ? 'None of the items in your basket are in this coupon’s categories.' : 'Items already on a flash sale can’t use coupons.');
    if (eligibleCents < Number(row.min_spend_cents)) return refuse(`Spend at least KES ${(Number(row.min_spend_cents) / 100).toLocaleString('en-KE')} to use this coupon.`);
    if (row.audience === 'new' && (await c.query(`SELECT 1 FROM orders WHERE user_id = $1 AND status IN ('PAID','FULFILLED')`, [userId])).rowCount) return refuse('This coupon is for new customers only.');
    if (row.audience === 'segment' && !(row.segment_id && (await inSegment(c, row.segment_id, userId)))) return refuse('This coupon isn’t available for your account.');
    const mine = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND customer_id = $2 AND released_at IS NULL', [row.id, userId])).rows[0]!.n;
    if (mine >= row.per_customer) return refuse('You’ve already used this coupon.');
    let d = row.kind === 'free_delivery' ? feeCents : row.kind === 'fixed' ? Math.min(Number(row.value), eligibleCents) : Math.round((eligibleCents * Number(row.value)) / 100);
    if (row.kind === 'percent' && Number(row.max_discount_cents) > 0) d = Math.min(d, Number(row.max_discount_cents));
    d = Math.min(d, subtotal - (bundle?.discountCents ?? 0) + feeCents);
    if (d <= 0) return refuse('This coupon wouldn’t take anything off your basket.');
    coupon = { id: row.id, code: row.code, discountCents: d };
  }
  return { lines, subtotalCents: subtotal, bundle, coupon, discountCents: (bundle?.discountCents ?? 0) + (coupon?.discountCents ?? 0) };
}

export async function recordRedemption(c: Queryable, orderId: string, userId: string, p: Pricing) {
  if (p.coupon) await c.query('INSERT INTO coupon_redemptions (coupon_id, order_id, customer_id, discount_cents) VALUES ($1,$2,$3,$4)', [p.coupon.id, orderId, userId, p.coupon.discountCents]);
}
/** A cancelled order gives its coupon use back. */
export async function releaseRedemption(c: Queryable, orderId: string) {
  await c.query('UPDATE coupon_redemptions SET released_at = now() WHERE order_id = $1 AND released_at IS NULL', [orderId]);
}

export const QuoteSchema = z.strictObject({
  items: z.array(z.strictObject({ productId: uuid, quantity: z.number().int().min(1).max(1000) })).min(1).max(100),
  area: z.string().trim().max(80).default(''),
  couponCode: z.string().trim().max(40).optional(),
});

export class PromotionsService {
  constructor(private readonly db: Database) {}

  // ---- rules --------------------------------------------------------------------------------------------------------------------------------

  async rules() { return this.db.read((c) => marketingRules(c)); }
  async saveRules(r: MarketingRules, actor: Actor) {
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO settings (key, value, updated_by) VALUES ('marketing.rules', $1, $2) ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`, [JSON.stringify(r), actor.id]);
      await audit(c, actor, 'marketing.rules', 'setting', 'marketing.rules', r);
    });
    return r;
  }

  // ---- coupons ------------------------------------------------------------------------------------------------------------------------------

  async coupons(q: z.infer<typeof CouponListSchema>) {
    return this.db.read(async (c) => {
      const rows = (await c.query<CouponRow>(`${COUPON_SELECT} WHERE ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%' OR c.code ILIKE '%' || $1 || '%') ORDER BY c.created_at DESC LIMIT $2`, [q.q ?? null, q.limit])).rows;
      const items = rows.map(couponView).filter((x) => !q.status || x.status === q.status);
      return { items, summary: { active: items.filter((i) => i.status === 'Active').length, redemptions: items.reduce((n, i) => n + i.redemptions, 0), discountGivenCents: items.reduce((n, i) => n + i.discountGivenCents, 0) } };
    });
  }

  async coupon(id: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<CouponRow>(`${COUPON_SELECT} WHERE c.id = $1`, [id])).rows[0];
      if (!r) throw new NotFoundError('Coupon');
      return couponView(r);
    });
  }

  async saveCoupon(id: string | null, input: Partial<CouponInput>, actor: Actor) {
    const cid = id ?? uuidv7();
    await this.db.tx(async (c) => {
      let m: CouponInput;
      if (id) {
        const cur = (await c.query<CouponRow>('SELECT * FROM coupons WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw new NotFoundError('Coupon');
        const base = { name: cur.name, code: cur.code, type: cur.kind, value: Number(cur.value), minSpendCents: Number(cur.min_spend_cents), maxDiscountCents: Number(cur.max_discount_cents), limit: cur.usage_limit, perCustomer: cur.per_customer, startsAt: cur.starts_at.toISOString(), endsAt: cur.ends_at.toISOString(), state: cur.state as CouponInput['state'], categoryIds: cur.category_ids, audience: cur.audience as CouponInput['audience'], segmentId: cur.segment_id, combine: cur.combine, note: cur.note };
        m = CouponSchema.parse({ ...base, ...input });
        const used = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND released_at IS NULL', [id])).rows[0]!.n;
        if (used && (m.code !== cur.code || m.type !== cur.kind)) throw new ConflictError('COUPON_USED', 'This coupon has been used, so its code and type can’t change. Pause it and make a new one');
        if (m.limit < used) throw new UnprocessableError('LIMIT_TOO_LOW', `${used} uses are already recorded`, { used });
      } else m = CouponSchema.parse(input);
      checkCoupon(m);
      if ((await c.query('SELECT 1 FROM coupons WHERE code = $1 AND id <> $2', [m.code, cid])).rowCount) throw new ConflictError('CODE_EXISTS', 'Another coupon already uses that code');
      if (m.segmentId && !(await c.query('SELECT 1 FROM segments WHERE id = $1', [m.segmentId])).rowCount) throw new NotFoundError('Segment');
      const cols = [m.name, m.code, m.type, Math.round(m.value), m.minSpendCents, m.maxDiscountCents, m.limit, m.perCustomer, m.startsAt, m.endsAt, m.state, m.categoryIds, m.audience, m.audience === 'segment' ? m.segmentId : null, m.combine, m.note];
      if (id) await c.query('UPDATE coupons SET name=$2, code=$3, kind=$4, value=$5, min_spend_cents=$6, max_discount_cents=$7, usage_limit=$8, per_customer=$9, starts_at=$10, ends_at=$11, state=$12, category_ids=$13, audience=$14, segment_id=$15, combine=$16, note=$17, version = version + 1, updated_at = now() WHERE id = $1', [id, ...cols]);
      else await c.query('INSERT INTO coupons (id, name, code, kind, value, min_spend_cents, max_discount_cents, usage_limit, per_customer, starts_at, ends_at, state, category_ids, audience, segment_id, combine, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)', [cid, ...cols, actor.name ?? actor.id]);
      await audit(c, actor, id ? 'coupon.update' : 'coupon.create', 'coupon', cid, { code: m.code });
    });
    return this.coupon(cid);
  }

  async setCouponState(input: z.infer<typeof CouponStateSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const n = (await c.query(`UPDATE coupons SET state = $2, version = version + 1, updated_at = now() WHERE id = ANY($1) AND state <> 'draft'`, [input.ids, input.state])).rowCount;
      if (!n) throw new NotFoundError('Coupon');
      await audit(c, actor, `coupon.${input.state}`, 'coupon', input.ids[0]!, { ids: input.ids });
    });
    return { updated: input.ids.length };
  }

  async deleteCoupon(id: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ state: string }>('SELECT state FROM coupons WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new NotFoundError('Coupon');
      if (r.state !== 'draft' || (await c.query('SELECT 1 FROM coupon_redemptions WHERE coupon_id = $1', [id])).rowCount) throw new ConflictError('COUPON_KEPT', 'Only an unused draft can be deleted. Pause a coupon to stop it');
      await c.query('DELETE FROM coupons WHERE id = $1', [id]);
      await audit(c, actor, 'coupon.delete', 'coupon', id, {});
    });
  }

  /** What a shopper's basket would cost with an optional coupon, exactly as checkout would charge it. */
  async quote(userId: string, input: z.infer<typeof QuoteSchema>) {
    return this.db.read(async (c) => {
      const ids = input.items.map((i) => i.productId);
      const prods = (await c.query<{ id: string; price_cents: number; category_id: string | null; active: boolean }>('SELECT id, price_cents, category_id, active FROM products WHERE id = ANY($1::uuid[])', [ids])).rows;
      const byId = new Map(prods.map((p) => [p.id, p]));
      const missing = ids.filter((i) => !byId.get(i)?.active);
      if (missing.length) throw new UnprocessableError('PRODUCT_UNAVAILABLE', 'Some products are unavailable', { productIds: missing });
      const fee = input.area ? (await feeFor(c, input.area)).feeCents : 0;
      const p = await priceBasket(c, userId, input.items.map((i) => ({ productId: i.productId, priceCents: Number(byId.get(i.productId)!.price_cents), categoryId: byId.get(i.productId)!.category_id, quantity: i.quantity })), fee, input.couponCode, false);
      return {
        lines: p.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, listCents: l.priceCents, unitCents: l.unitCents, onSale: !!l.flashSaleId })),
        subtotalCents: p.subtotalCents, deliveryFeeCents: fee, bundle: p.bundle, coupon: p.coupon, discountCents: p.discountCents, totalCents: p.subtotalCents + fee - p.discountCents,
      };
    });
  }

  // ---- flash sales ---------------------------------------------------------------------------------------------------------------------------

  private async flashView(c: Queryable, id?: string) {
    const rows = (await c.query<{ id: string; name: string; starts_at: Date; ends_at: Date; kind: string; value: number; placement: string; stock_guard: number; state: string; version: number; created_by: string; product_ids: string[]; today: number; total: number }>(
      `SELECT s.*, COALESCE((SELECT array_agg(product_id) FROM flash_sale_products WHERE sale_id = s.id), '{}') AS product_ids,
              COALESCE((SELECT sum(i.quantity * i.unit_price_cents) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.flash_sale_id = s.id AND o.status IN ('PAID','FULFILLED') AND o.created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'Africa/Nairobi'),0)::bigint AS today,
              COALESCE((SELECT sum(i.quantity * i.unit_price_cents) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.flash_sale_id = s.id AND o.status IN ('PAID','FULFILLED')),0)::bigint AS total
         FROM flash_sales s WHERE ($1::uuid IS NULL OR s.id = $1) ORDER BY s.starts_at DESC`, [id ?? null])).rows;
    return rows.map((s) => ({ id: s.id, name: s.name, startsAt: s.starts_at.toISOString(), endsAt: s.ends_at.toISOString(), type: s.kind, value: Number(s.value), placement: s.placement, stockGuard: s.stock_guard, state: s.state, status: saleStatus(s.state, s.starts_at, s.ends_at), productIds: s.product_ids, salesTodayCents: Number(s.today), salesTotalCents: Number(s.total), createdBy: s.created_by, version: s.version }));
  }

  async flashSales() { return this.db.read(async (c) => ({ items: await this.flashView(c) })); }
  async flashSale(id: string) {
    const r = (await this.db.read((c) => this.flashView(c, id)))[0];
    if (!r) throw new NotFoundError('Flash sale');
    return r;
  }

  async saveFlash(id: string | null, input: Partial<FlashInput>, actor: Actor) {
    const sid = id ?? uuidv7();
    await this.db.tx(async (c) => {
      let m: FlashInput;
      if (id) {
        const cur = (await this.flashView(c, id))[0];
        if (!cur) throw new NotFoundError('Flash sale');
        m = FlashSchema.parse({ name: cur.name, startsAt: cur.startsAt, endsAt: cur.endsAt, type: cur.type, value: cur.value, productIds: cur.productIds, placement: cur.placement, stockGuard: cur.stockGuard, state: cur.state, ...input });
      } else m = FlashSchema.parse(input);
      if (Date.parse(m.endsAt) <= Date.parse(m.startsAt)) throw new UnprocessableError('BAD_DATES', 'The end must be after the start');
      if (m.type === 'percent' && m.value > 99) throw new UnprocessableError('BAD_VALUE', 'A percentage sale takes 1 to 99');
      const ids = [...new Set(m.productIds)];
      if ((await c.query('SELECT count(*)::int AS n FROM products WHERE id = ANY($1::uuid[])', [ids])).rows[0].n !== ids.length) throw new NotFoundError('Product');
      if (m.state === 'live') {
        const clash = (await c.query<{ name: string }>(
          `SELECT DISTINCT s.name FROM flash_sales s JOIN flash_sale_products fp ON fp.sale_id = s.id WHERE s.id <> $1 AND s.state = 'live' AND s.starts_at < $3 AND $2 < s.ends_at AND fp.product_id = ANY($4::uuid[])`, [sid, m.startsAt, m.endsAt, ids])).rows[0];
        if (clash) throw new ConflictError('SALE_OVERLAP', `${clash.name} already runs on some of these products at the same time. Products can only be in one sale at once`);
      }
      if (id) await c.query('UPDATE flash_sales SET name=$2, starts_at=$3, ends_at=$4, kind=$5, value=$6, placement=$7, stock_guard=$8, state=$9, version = version + 1, updated_at = now() WHERE id = $1', [id, m.name, m.startsAt, m.endsAt, m.type, m.value, m.placement, m.stockGuard, m.state]);
      else await c.query('INSERT INTO flash_sales (id, name, starts_at, ends_at, kind, value, placement, stock_guard, state, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [sid, m.name, m.startsAt, m.endsAt, m.type, m.value, m.placement, m.stockGuard, m.state, actor.name ?? actor.id]);
      await c.query('DELETE FROM flash_sale_products WHERE sale_id = $1', [sid]);
      await c.query('INSERT INTO flash_sale_products (sale_id, product_id) SELECT $1, unnest($2::uuid[])', [sid, ids]);
      await audit(c, actor, id ? 'flash.update' : 'flash.create', 'flash_sale', sid, { name: m.name, state: m.state });
    });
    return this.flashSale(sid);
  }

  /** Product prices as the storefront will charge them right now, for products currently on a sale. */
  async livePrices() {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT DISTINCT fp.product_id AS id FROM flash_sales s JOIN flash_sale_products fp ON fp.sale_id = s.id WHERE s.state = 'live' AND now() BETWEEN s.starts_at AND s.ends_at`);
      const ids = rows.map((r) => r.id);
      const prices = ids.length ? await flashPrices(c, ids) : new Map();
      const list = (await c.query<{ id: string; price_cents: number; name: string }>('SELECT id, price_cents, name FROM products WHERE id = ANY($1::uuid[])', [ids])).rows;
      const sales = new Map((await this.flashView(c)).map((s) => [s.id, s]));
      return { items: list.filter((p) => prices.has(p.id)).map((p) => { const f = prices.get(p.id)!; const s = sales.get(f.saleId)!; return { productId: p.id, name: p.name, listCents: Number(p.price_cents), saleCents: f.priceCents, saleId: f.saleId, saleName: s.name, endsAt: s.endsAt, badge: s.type === 'percent' ? `${s.value}% off` : `KES ${(s.value / 100).toLocaleString('en-KE')} off` }; }) };
    });
  }

  // ---- bundles ----------------------------------------------------------------------------------------------------------------------------------

  private async bundleView(c: Queryable, id?: string) {
    const rows = (await c.query<{ id: string; name: string; kind: string; description: string; price_cents: number; percent: string; min_items: number; state: string; starts_at: Date; created_by: string; version: number; items: { productId: string; quantity: number; priceCents: number }[]; units: number }>(
      `SELECT b.*, COALESCE((SELECT json_agg(json_build_object('productId', i.product_id, 'quantity', i.quantity, 'priceCents', p.price_cents)) FROM bundle_items i JOIN products p ON p.id = i.product_id WHERE i.bundle_id = b.id), '[]') AS items,
              COALESCE((SELECT count(*) FROM orders o WHERE o.bundle_id = b.id AND o.status IN ('PAID','FULFILLED')),0)::int AS units
         FROM bundles b WHERE ($1::uuid IS NULL OR b.id = $1) ORDER BY b.created_at DESC`, [id ?? null])).rows;
    return rows.map((b) => {
      const standalone = b.items.reduce((n, i) => n + Number(i.priceCents) * i.quantity, 0);
      return { id: b.id, name: b.name, type: b.kind, description: b.description, items: b.items.map((i) => ({ productId: i.productId, quantity: i.quantity })), priceCents: Number(b.price_cents), percent: Number(b.percent), minItems: b.min_items, state: b.state, status: b.state === 'draft' ? 'Draft' : Date.now() < b.starts_at.getTime() ? 'Scheduled' : 'Live', startsAt: b.starts_at.toISOString(), standaloneCents: standalone, savingCents: b.kind === 'Multi-buy' ? 0 : Math.max(0, standalone - Number(b.price_cents)), ordersCount: b.units, createdBy: b.created_by, version: b.version };
    });
  }
  async bundles() { return this.db.read(async (c) => ({ items: await this.bundleView(c) })); }
  async bundle(id: string) {
    const r = (await this.db.read((c) => this.bundleView(c, id)))[0];
    if (!r) throw new NotFoundError('Bundle');
    return r;
  }

  async saveBundle(id: string | null, input: Partial<BundleInput>, actor: Actor) {
    const bid = id ?? uuidv7();
    await this.db.tx(async (c) => {
      let m: BundleInput;
      if (id) {
        const cur = (await this.bundleView(c, id))[0];
        if (!cur) throw new NotFoundError('Bundle');
        m = BundleSchema.parse({ name: cur.name, type: cur.type, description: cur.description, items: cur.items, priceCents: cur.priceCents, percent: cur.percent, minItems: cur.minItems, state: cur.state, startsAt: cur.startsAt, ...input });
      } else m = BundleSchema.parse(input);
      if (m.type === 'Multi-buy') {
        if (!(m.percent > 0) || m.minItems < 2) throw new UnprocessableError('BAD_OFFER', 'A multi-buy needs a percentage off and a minimum of two items');
      } else {
        if (!m.items.length) throw new UnprocessableError('BAD_OFFER', 'Add the products in the bundle');
        const ids = m.items.map((i) => i.productId);
        if (new Set(ids).size !== ids.length) throw new UnprocessableError('BAD_OFFER', 'A product can appear once in a bundle (raise its quantity instead)');
        const prices = (await c.query<{ id: string; price_cents: number }>('SELECT id, price_cents FROM products WHERE id = ANY($1::uuid[])', [ids])).rows;
        if (prices.length !== ids.length) throw new NotFoundError('Product');
        const standalone = m.items.reduce((n, i) => n + Number(prices.find((p) => p.id === i.productId)!.price_cents) * i.quantity, 0);
        if (m.priceCents <= 0 || m.priceCents >= standalone) throw new UnprocessableError('BAD_PRICE', 'A bundle’s price must be above zero and below buying the items separately', { standaloneCents: standalone });
      }
      const cols = [m.name, m.type, m.description, m.priceCents, m.type === 'Multi-buy' ? m.percent : 0, m.type === 'Multi-buy' ? m.minItems : 0, m.state, m.startsAt ?? new Date().toISOString()];
      if (id) await c.query('UPDATE bundles SET name=$2, kind=$3, description=$4, price_cents=$5, percent=$6, min_items=$7, state=$8, starts_at=$9, version = version + 1, updated_at = now() WHERE id = $1', [id, ...cols]);
      else await c.query('INSERT INTO bundles (id, name, kind, description, price_cents, percent, min_items, state, starts_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [bid, ...cols, actor.name ?? actor.id]);
      await c.query('DELETE FROM bundle_items WHERE bundle_id = $1', [bid]);
      for (const i of m.items) await c.query('INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES ($1,$2,$3)', [bid, i.productId, i.quantity]);
      await audit(c, actor, id ? 'bundle.update' : 'bundle.create', 'bundle', bid, { name: m.name, state: m.state });
    });
    return this.bundle(bid);
  }

  async setBundleState(id: string, state: 'draft' | 'live', actor: Actor) {
    await this.db.tx(async (c) => {
      if (!(await c.query('UPDATE bundles SET state = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, state])).rowCount) throw new NotFoundError('Bundle');
      await audit(c, actor, `bundle.${state}`, 'bundle', id, {});
    });
    return this.bundle(id);
  }
}

