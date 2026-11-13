import { z } from 'zod';
import type { Database } from '../../infra/db.js';
import { NotFoundError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { isUuid } from '../../infra/uuid.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { audit, type Actor } from '../products/products.js';
import { applyMoves } from './stock.js';

const uuid = z.string().refine(isUuid, 'must be a UUID');

export const AdjustSchema = z.strictObject({
  productId: uuid, locationId: uuid, delta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, 'delta must be non-zero'),
  type: z.enum(['Adjustment', 'Write-off', 'Count correction']).default('Adjustment'), reason: z.string().trim().min(3).max(200),
});
export const TransferSchema = z.strictObject({ productId: uuid, fromLocationId: uuid, toLocationId: uuid, qty: z.number().int().min(1).max(1_000_000), note: z.string().trim().max(200).default('') })
  .refine((v) => v.fromLocationId !== v.toLocationId, { message: 'Choose two different locations', path: ['toLocationId'] });
export const LevelsQuerySchema = z.object({ locationId: uuid.optional(), q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().max(200).optional() });
export const MovementsQuerySchema = z.object({
  productId: uuid.optional(), locationId: uuid.optional(), type: z.string().max(30).optional(), q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional(),
});
export const AlertRulesSchema = z.strictObject({
  when: z.enum(['Reorder point', 'Below safety stock']).default('Reorder point'), digest: z.string().trim().max(60).default('Daily at 8:00 AM'),
  leadDays: z.number().int().min(0).max(365).default(7), bufferPct: z.number().int().min(0).max(100).default(15),
});
export type AlertRules = z.infer<typeof AlertRulesSchema>;
export const ALERT_DEFAULTS: AlertRules = { when: 'Reorder point', digest: 'Daily at 8:00 AM', leadDays: 7, bufferPct: 15 };

export class InventoryService {
  constructor(private readonly db: Database) {}

  /** Stock per product per location, for the “stock levels” table. */
  async levels(q: z.infer<typeof LevelsQuerySchema>) {
    const after = q.cursor ? decodeCursor(q.cursor, 1)[0]! : null;
    if (after !== null && !isUuid(after)) throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; sku: string; name: string; status: string; reorder_at: number; cost_cents: number; price_cents: number; available: number; reserved: number; locs: { locationId: string; onHand: number }[] }>(
        `SELECT p.id, p.sku, p.name, p.status, p.reorder_at, p.cost_cents, p.price_cents, COALESCE(i.available, 0) AS available, COALESCE(i.reserved, 0) AS reserved,
                COALESCE((SELECT json_agg(json_build_object('locationId', sl.location_id, 'onHand', sl.on_hand)) FROM stock_levels sl WHERE sl.product_id = p.id AND ($2::uuid IS NULL OR sl.location_id = $2)), '[]') AS locs
           FROM products p LEFT JOIN inventory i ON i.product_id = p.id
          WHERE ($1::uuid IS NULL OR p.id < $1) AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%' OR p.sku ILIKE '%' || $3 || '%' OR p.barcode = $3)
            AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM stock_levels s WHERE s.product_id = p.id AND s.location_id = $2 AND s.on_hand > 0))
          ORDER BY p.id DESC LIMIT $4`, [after, q.locationId ?? null, q.q ?? null, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({ productId: r.id, sku: r.sku, name: r.name, status: r.status, reorderAt: r.reorder_at, costCents: r.cost_cents, priceCents: r.price_cents, available: r.available, reserved: r.reserved, onHand: r.available + r.reserved, locations: r.locs })),
        nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1]!.id]) : null,
      };
    });
  }

  async movements(q: z.infer<typeof MovementsQuerySchema>) {
    const before = q.cursor ? Number(decodeCursor(q.cursor, 1)[0]) : null;
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: number; product_id: string; sku: string; name: string; location_id: string; location: string; type: string; qty: number; balance: number; ref: string; note: string; actor_name: string; created_at: Date }>(
        `SELECT m.id, m.product_id, p.sku, p.name, m.location_id, l.name AS location, m.type, m.qty, m.balance, m.ref, m.note, m.actor_name, m.created_at
           FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN locations l ON l.id = m.location_id
          WHERE ($1::bigint IS NULL OR m.id < $1) AND ($2::uuid IS NULL OR m.product_id = $2) AND ($3::uuid IS NULL OR m.location_id = $3) AND ($4::text IS NULL OR m.type = $4)
            AND ($5::text IS NULL OR p.name ILIKE '%' || $5 || '%' OR p.sku ILIKE '%' || $5 || '%' OR m.ref ILIKE '%' || $5 || '%')
          ORDER BY m.id DESC LIMIT $6`, [before, q.productId ?? null, q.locationId ?? null, q.type ?? null, q.q ?? null, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({ id: String(r.id), productId: r.product_id, sku: r.sku, product: r.name, locationId: r.location_id, location: r.location, type: r.type, qty: r.qty, balance: r.balance, ref: r.ref, note: r.note, by: r.actor_name, at: r.created_at.toISOString() })),
        nextCursor: rows.length > q.limit ? encodeCursor([String(page[page.length - 1]!.id)]) : null,
      };
    });
  }

  async adjust(input: z.infer<typeof AdjustSchema>, actor: Actor) {
    return this.db.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM inventory WHERE product_id = $1 FOR UPDATE', [input.productId])).rowCount) throw new NotFoundError('Product');
      if (!(await c.query('SELECT 1 FROM locations WHERE id = $1', [input.locationId])).rowCount) throw new NotFoundError('Location');
      const type = input.delta > 0 && input.type === 'Write-off' ? 'Adjustment' : input.type;
      await applyMoves(c, [{ productId: input.productId, locationId: input.locationId, delta: input.delta, type, ref: `ADJ-${Date.now().toString(36).toUpperCase()}`, note: input.reason }], { id: actor.id, name: actor.name ?? 'Staff' });
      await audit(c, actor, 'inventory.adjust', 'product', input.productId, input);
      return this.snapshot(c, input.productId);
    });
  }

  async transfer(input: z.infer<typeof TransferSchema>, actor: Actor) {
    return this.db.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM inventory WHERE product_id = $1 FOR UPDATE', [input.productId])).rowCount) throw new NotFoundError('Product');
      const locs = (await c.query<{ id: string; active: boolean }>('SELECT id, active FROM locations WHERE id = ANY($1::uuid[])', [[input.fromLocationId, input.toLocationId]])).rows;
      if (locs.length !== 2) throw new NotFoundError('Location');
      if (locs.some((l) => !l.active)) throw new UnprocessableError('LOCATION_INACTIVE', 'You can only move stock between active locations');
      const ref = `TR-${Date.now().toString(36).toUpperCase()}`;
      await applyMoves(c, [
        { productId: input.productId, locationId: input.fromLocationId, delta: -input.qty, type: 'Transfer out', ref, note: input.note },
        { productId: input.productId, locationId: input.toLocationId, delta: input.qty, type: 'Transfer in', ref, note: input.note },
      ], { id: actor.id, name: actor.name ?? 'Staff' });
      await audit(c, actor, 'inventory.transfer', 'product', input.productId, input);
      return { ref, ...(await this.snapshot(c, input.productId)) };
    });
  }

  private async snapshot(c: { query: Database['writer']['query'] }, productId: string) {
    const r = (await c.query('SELECT available, reserved FROM inventory WHERE product_id = $1', [productId])).rows[0] as { available: number; reserved: number };
    const levels = (await c.query('SELECT location_id AS "locationId", on_hand AS "onHand" FROM stock_levels WHERE product_id = $1', [productId])).rows as { locationId: string; onHand: number }[];
    return { productId, available: r.available, reserved: r.reserved, levels };
  }

  /** Headline numbers for the inventory overview. */
  async overview() {
    return this.db.read(async (c) => {
      const t = (await c.query<{ units: number; value_cents: number; out: number; low: number; skus: number }>(
        `SELECT COALESCE(sum(COALESCE(i.available,0) + COALESCE(i.reserved,0)), 0)::int AS units,
                COALESCE(sum((COALESCE(i.available,0) + COALESCE(i.reserved,0)) * p.cost_cents), 0)::bigint AS value_cents,
                count(*) FILTER (WHERE COALESCE(i.available,0) = 0 AND p.status = 'active')::int AS out,
                count(*) FILTER (WHERE COALESCE(i.available,0) > 0 AND COALESCE(i.available,0) <= p.reorder_at AND p.status = 'active')::int AS low,
                count(*) FILTER (WHERE p.status = 'active')::int AS skus
           FROM products p LEFT JOIN inventory i ON i.product_id = p.id`)).rows[0]!;
      const locs = (await c.query<{ id: string; name: string; capacity: number; units: number }>(
        `SELECT l.id, l.name, l.capacity, COALESCE(sum(sl.on_hand), 0)::int AS units FROM locations l LEFT JOIN stock_levels sl ON sl.location_id = l.id WHERE l.active GROUP BY l.id ORDER BY l.sort_order`)).rows;
      const open = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_movements WHERE created_at > now() - interval '7 days'`)).rows[0]!.n;
      return { units: t.units, valueCents: t.value_cents, outOfStock: t.out, lowStock: t.low, activeProducts: t.skus, movementsThisWeek: open,
        locations: locs.map((l) => ({ id: l.id, name: l.name, capacity: l.capacity, units: l.units, usedPct: l.capacity ? Math.round((l.units / l.capacity) * 100) : null })) };
    });
  }

  // -- alerts -------------------------------------------------------------------------------------

  async alertRules(): Promise<AlertRules> {
    return this.db.read(async (c) => {
      const r = (await c.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'stock.alert_rules'`)).rows[0];
      const parsed = AlertRulesSchema.safeParse(r?.value ?? {});
      return parsed.success ? parsed.data : ALERT_DEFAULTS;
    });
  }

  async saveAlertRules(rules: AlertRules, actor: Actor) {
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO settings (key, value, updated_by) VALUES ('stock.alert_rules', $1, $2) ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`, [JSON.stringify(rules), actor.id]);
      await audit(c, actor, 'inventory.alert_rules', 'setting', 'stock.alert_rules', rules);
    });
    return rules;
  }

  /** Products at or below their reorder point, each with a suggested order quantity (lead-time demand plus buffer). */
  async alerts() {
    const rules = await this.alertRules();
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; sku: string; name: string; available: number; reorder_at: number; supplier: string | null; supplier_id: string | null; cost_cents: number; sold30: number }>(
        `SELECT p.id, p.sku, p.name, COALESCE(i.available,0) AS available, p.reorder_at, s.name AS supplier, p.supplier_id, p.cost_cents,
                COALESCE((SELECT sum(-m.qty) FROM stock_movements m WHERE m.product_id = p.id AND m.type = 'Sale' AND m.created_at > now() - interval '30 days'), 0)::int AS sold30
           FROM products p LEFT JOIN inventory i ON i.product_id = p.id LEFT JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.status = 'active' AND p.track_stock AND COALESCE(i.available,0) <= ${rules.when === 'Reorder point' ? 'p.reorder_at' : '(p.reorder_at / 2)'}
          ORDER BY COALESCE(i.available,0), p.name LIMIT 500`);
      return {
        rules,
        items: rows.map((r) => {
          const perDay = r.sold30 / 30;
          const suggested = Math.max(r.reorder_at * 2 - r.available, Math.ceil(perDay * rules.leadDays * (1 + rules.bufferPct / 100)) - r.available, 1);
          return { productId: r.id, sku: r.sku, name: r.name, available: r.available, reorderAt: r.reorder_at, severity: r.available === 0 ? 'out' : 'low', supplierId: r.supplier_id, supplier: r.supplier, costCents: r.cost_cents, sold30: r.sold30, suggestedQty: suggested };
        }),
      };
    });
  }
}
