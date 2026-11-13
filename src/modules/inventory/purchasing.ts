import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { isUuid, uuidv7 } from '../../infra/uuid.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { audit, type Actor } from '../products/products.js';
import { applyMoves } from './stock.js';
import { OWNER_ROLE } from '../staff/permissions.js';

const uuid = z.string().refine(isUuid, 'must be a UUID');
export const DEFAULT_APPROVAL_LIMIT_CENTS = 10_000_000; // KES 100,000
export type PoStatus = 'draft' | 'pending_approval' | 'approved' | 'in_transit' | 'partially_received' | 'received' | 'cancelled';

export const PoLineSchema = z.strictObject({ productId: uuid, qty: z.number().int().min(1).max(1_000_000), costCents: z.number().int().min(0).max(1_000_000_00) });
export const SavePoSchema = z.strictObject({
  supplierId: uuid, locationId: uuid, expectedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shippingCents: z.number().int().min(0).max(100_000_000).default(0), notes: z.string().trim().max(1000).default(''),
  lines: z.array(PoLineSchema).min(1).max(200), submit: z.boolean().default(false),
}).refine((v) => new Set(v.lines.map((l) => l.productId)).size === v.lines.length, { message: 'Each product can appear once', path: ['lines'] });
export const PoActionSchema = z.strictObject({ action: z.enum(['approve', 'send', 'cancel']) });
export const ReceiveSchema = z.strictObject({
  deliveryRef: z.string().trim().min(1).max(80),
  lines: z.array(z.strictObject({ productId: uuid, good: z.number().int().min(0).max(1_000_000), damaged: z.number().int().min(0).max(1_000_000) })).min(1).max(200),
});
export const PoListSchema = z.object({
  status: z.enum(['draft', 'pending_approval', 'approved', 'in_transit', 'partially_received', 'received', 'cancelled']).optional(),
  supplierId: uuid.optional(), q: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional(),
});

interface PoRow {
  id: string; po_no: number; supplier_id: string; supplier: string; location_id: string; location: string; expected_on: string; status: PoStatus;
  shipping_cents: number; tax_rate: string; notes: string; created_by: string; created_by_name: string; approved_by_name: string | null; approved_at: Date | null;
  delivery_ref: string | null; received_at: Date | null; created_at: Date; version: number; subtotal: number; ordered: number; received: number;
}
const poView = (r: PoRow) => {
  const subtotal = Number(r.subtotal);
  const tax = Math.round(subtotal * Number(r.tax_rate) / 100);
  return {
    id: r.id, number: `PO-${r.po_no}`, supplierId: r.supplier_id, supplier: r.supplier, locationId: r.location_id, location: r.location, expectedOn: r.expected_on,
    status: r.status, shippingCents: r.shipping_cents, taxRate: Number(r.tax_rate), subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + r.shipping_cents + tax,
    notes: r.notes, createdBy: r.created_by_name, createdById: r.created_by, approvedBy: r.approved_by_name, approvedAt: r.approved_at?.toISOString() ?? null,
    deliveryRef: r.delivery_ref, receivedAt: r.received_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(), unitsOrdered: Number(r.ordered), unitsReceived: Number(r.received), version: r.version,
  };
};
const PO_SELECT = `SELECT po.*, to_char(po.expected_on, 'YYYY-MM-DD') AS expected_on, s.name AS supplier, l.name AS location,
    COALESCE(sum(pl.qty * pl.cost_cents), 0)::bigint AS subtotal, COALESCE(sum(pl.qty), 0)::int AS ordered, COALESCE(sum(pl.received), 0)::int AS received
  FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN locations l ON l.id = po.location_id LEFT JOIN purchase_order_lines pl ON pl.po_id = po.id`;

export interface PoActor extends Actor { name: string; isOwner: boolean }
export const toPoActor = (a: Actor, role: string | undefined): PoActor => ({ ...a, name: a.name ?? 'Staff', isOwner: role === OWNER_ROLE });

export class PurchasingService {
  constructor(private readonly db: Database) {}

  private async setting<T>(c: Queryable, key: string, fallback: T): Promise<T> {
    const r = (await c.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key])).rows[0];
    return r ? r.value : fallback;
  }

  async list(q: z.infer<typeof PoListSchema>) {
    const before = q.cursor ? decodeCursor(q.cursor, 1)[0]! : null;
    if (before !== null && !isUuid(before)) throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
    return this.db.read(async (c) => {
      const { rows } = await c.query<PoRow>(
        `${PO_SELECT}
          WHERE ($1::uuid IS NULL OR po.id < $1) AND ($2::text IS NULL OR po.status = $2) AND ($3::uuid IS NULL OR po.supplier_id = $3)
            AND ($4::text IS NULL OR ('PO-' || po.po_no) ILIKE '%' || $4 || '%' OR s.name ILIKE '%' || $4 || '%')
          GROUP BY po.id, s.name, l.name ORDER BY po.id DESC LIMIT $5`, [before, q.status ?? null, q.supplierId ?? null, q.q ?? null, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return { items: page.map(poView), nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1]!.id]) : null };
    });
  }

  async get(id: string) {
    return this.db.read((c) => this.load(c, id));
  }

  private async load(c: Queryable, id: string, lock = false) {
    if (lock) await c.query('SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    const r = (await c.query<PoRow>(`${PO_SELECT} WHERE po.id = $1 GROUP BY po.id, s.name, l.name`, [id])).rows[0];
    if (!r) throw new NotFoundError('Purchase order');
    const { rows: lines } = await c.query<{ product_id: string; sku: string; name: string; qty: number; cost_cents: number; received: number; damaged: number }>(
      `SELECT pl.product_id, p.sku, p.name, pl.qty, pl.cost_cents, pl.received, pl.damaged FROM purchase_order_lines pl JOIN products p ON p.id = pl.product_id WHERE pl.po_id = $1 ORDER BY pl.line_no`, [id]);
    const { rows: receipts } = await c.query<{ delivery_ref: string; lines: unknown; received_by: string; received_at: Date }>('SELECT delivery_ref, lines, received_by, received_at FROM purchase_receipts WHERE po_id = $1 ORDER BY id', [id]);
    return {
      ...poView(r),
      lines: lines.map((l) => ({ productId: l.product_id, sku: l.sku, name: l.name, qty: l.qty, costCents: l.cost_cents, received: l.received, damaged: l.damaged })),
      receipts: receipts.map((x) => ({ deliveryRef: x.delivery_ref, lines: x.lines, by: x.received_by, at: x.received_at.toISOString() })),
    };
  }

  /** Create a purchase order, or edit a draft. `submit` sends it for approval (or approves it outright when it's under the limit). */
  async save(id: string | null, input: z.infer<typeof SavePoSchema>, actor: PoActor, expectedVersion?: number) {
    const poId = id ?? uuidv7();
    await this.db.tx(async (c) => {
      const sup = (await c.query<{ status: string; min_order_cents: number }>('SELECT status, min_order_cents FROM suppliers WHERE id = $1', [input.supplierId])).rows[0];
      if (!sup) throw new ValidationError([{ path: ['supplierId'], message: 'Unknown supplier' }]);
      const loc = (await c.query<{ active: boolean }>('SELECT active FROM locations WHERE id = $1', [input.locationId])).rows[0];
      if (!loc) throw new ValidationError([{ path: ['locationId'], message: 'Unknown location' }]);
      if (!loc.active) throw new UnprocessableError('LOCATION_INACTIVE', 'That location is switched off');
      const found = (await c.query('SELECT id FROM products WHERE id = ANY($1::uuid[])', [input.lines.map((l) => l.productId)])).rowCount;
      if (found !== input.lines.length) throw new ValidationError([{ path: ['lines'], message: 'One of the products no longer exists' }]);

      const subtotal = input.lines.reduce((n, l) => n + l.qty * l.costCents, 0);
      const vat = Number(await this.setting(c, 'business.vat', 16)) || 16;
      const limit = Number(await this.setting(c, 'purchasing.approval_limit_cents', DEFAULT_APPROVAL_LIMIT_CENTS));
      const total = subtotal + input.shippingCents + Math.round(subtotal * vat / 100);
      if (input.submit) {
        if (sup.status === 'on_hold') throw new UnprocessableError('SUPPLIER_ON_HOLD', 'This supplier is on hold. Take it off hold before ordering.');
        if (subtotal < sup.min_order_cents) throw new UnprocessableError('BELOW_MINIMUM_ORDER', 'This order is below the supplier’s minimum order value', { minOrderCents: sup.min_order_cents });
      }
      const status: PoStatus = input.submit ? (total > limit ? 'pending_approval' : 'approved') : 'draft';
      const auto = input.submit && total <= limit;

      if (id) {
        const cur = (await c.query<{ status: string; version: number }>('SELECT status, version FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw new NotFoundError('Purchase order');
        if (cur.status !== 'draft') throw new ConflictError('NOT_A_DRAFT', 'Only a draft can be edited');
        if (expectedVersion !== undefined && cur.version !== expectedVersion) throw new ConflictError('VERSION_CONFLICT', 'Someone else changed this order. Reload and try again.');
        await c.query(
          `UPDATE purchase_orders SET supplier_id=$2, location_id=$3, expected_on=$4, shipping_cents=$5, notes=$6, tax_rate=$7, status=$8,
                  approved_by = NULL, approved_by_name = $9, approved_at = $10, updated_at = now(), version = version + 1 WHERE id = $1`,
          [id, input.supplierId, input.locationId, input.expectedOn, input.shippingCents, input.notes, vat, status, auto ? 'Auto-approved' : null, auto ? new Date() : null]);
        await c.query('DELETE FROM purchase_order_lines WHERE po_id = $1', [id]);
      } else {
        await c.query(
          `INSERT INTO purchase_orders (id, supplier_id, location_id, expected_on, shipping_cents, notes, tax_rate, status, created_by, created_by_name, approved_by_name, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [poId, input.supplierId, input.locationId, input.expectedOn, input.shippingCents, input.notes, vat, status, actor.id, actor.name, auto ? 'Auto-approved' : null, auto ? new Date() : null]);
      }
      let n = 0;
      for (const l of input.lines) {
        await c.query('INSERT INTO purchase_order_lines (po_id, line_no, product_id, qty, cost_cents) VALUES ($1,$2,$3,$4,$5)', [poId, ++n, l.productId, l.qty, l.costCents]);
      }
      await audit(c, actor, input.submit ? 'po.submit' : 'po.save', 'purchase_order', poId, { status, totalCents: total });
    });
    return this.get(poId);
  }

  async act(id: string, action: z.infer<typeof PoActionSchema>['action'], actor: PoActor) {
    await this.db.tx(async (c) => {
      const po = await this.load(c, id, true);
      if (action === 'approve') {
        if (po.status !== 'pending_approval') throw new UnprocessableError('NOT_AWAITING_APPROVAL', 'This order isn’t waiting for approval');
        // Maker-checker: the person who raised the order can't also approve it (the owner is the one exception).
        if (po.createdById === actor.id && !actor.isOwner) throw new ForbiddenError(`${po.createdBy} created this order, so someone else must approve it`);
        await c.query(`UPDATE purchase_orders SET status = 'approved', approved_by = $2, approved_by_name = $3, approved_at = now(), updated_at = now(), version = version + 1 WHERE id = $1`, [id, actor.id, actor.name]);
      } else if (action === 'send') {
        if (po.status !== 'approved') throw new UnprocessableError('NOT_APPROVED', 'Only an approved order can be sent');
        await c.query(`UPDATE purchase_orders SET status = 'in_transit', updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
      } else {
        if (po.status === 'cancelled' || po.status === 'received') throw new UnprocessableError('ALREADY_CLOSED', 'This order is already closed');
        if (po.lines.some((l) => l.received > 0)) throw new UnprocessableError('PARTLY_RECEIVED', 'Part of this order has been received, so it can’t be cancelled');
        await c.query(`UPDATE purchase_orders SET status = 'cancelled', updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
      }
      await audit(c, actor, `po.${action}`, 'purchase_order', id, { number: po.number });
    });
    return this.get(id);
  }

  /** Record a delivery. Good units go on the shelf at the order's location; damaged units are counted but not stocked. */
  async receive(id: string, input: z.infer<typeof ReceiveSchema>, actor: PoActor) {
    await this.db.tx(async (c) => {
      const po = await this.load(c, id, true);
      if (!['approved', 'in_transit', 'partially_received'].includes(po.status)) throw new UnprocessableError('CANNOT_RECEIVE', 'This order can’t be received in its current state');
      const byProduct = new Map(input.lines.map((l) => [l.productId, l]));
      for (const l of input.lines) if (!po.lines.some((x) => x.productId === l.productId)) throw new ValidationError([{ path: ['lines'], message: 'A product in this delivery isn’t on the order' }]);
      if (!input.lines.some((l) => l.good + l.damaged > 0)) throw new UnprocessableError('NOTHING_RECEIVED', 'Enter the quantities you received');
      const moves = [];
      for (const l of po.lines) {
        const r = byProduct.get(l.productId);
        if (!r) continue;
        const got = r.good + r.damaged;
        if (l.received + got > l.qty) throw new UnprocessableError('OVER_RECEIVED', `More ${l.name} than was ordered. Record the extra as a supplier correction instead.`);
        await c.query('UPDATE purchase_order_lines SET received = received + $3, damaged = damaged + $4 WHERE po_id = $1 AND product_id = $2', [id, l.productId, got, r.damaged]);
        if (r.good > 0) moves.push({ productId: l.productId, locationId: po.locationId, delta: r.good, type: 'PO receipt' as const, ref: po.number, note: input.deliveryRef });
      }
      await applyMoves(c, moves, { id: actor.id, name: actor.name });
      const left = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM purchase_order_lines WHERE po_id = $1 AND received < qty', [id])).rows[0]!.n;
      await c.query(`UPDATE purchase_orders SET status = $2, delivery_ref = $3, received_at = CASE WHEN $2 = 'received' THEN now() ELSE received_at END, updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, left === 0 ? 'received' : 'partially_received', input.deliveryRef]);
      await c.query('INSERT INTO purchase_receipts (po_id, delivery_ref, lines, received_by) VALUES ($1,$2,$3,$4)', [id, input.deliveryRef, JSON.stringify(input.lines), actor.name]);
      await audit(c, actor, 'po.receive', 'purchase_order', id, { number: po.number, deliveryRef: input.deliveryRef, lines: input.lines });
    });
    return this.get(id);
  }

  /** Supplier scorecard: on-time delivery over the orders that were fully received. */
  async supplierStats() {
    return this.db.read(async (c) => (await c.query<{ supplier_id: string; orders: number; received: number; on_time: number; spend: number }>(
      `SELECT po.supplier_id, count(*)::int AS orders, count(*) FILTER (WHERE po.status = 'received')::int AS received,
              count(*) FILTER (WHERE po.status = 'received' AND po.received_at::date <= po.expected_on)::int AS on_time,
              COALESCE(sum((SELECT sum(qty * cost_cents) FROM purchase_order_lines pl WHERE pl.po_id = po.id)) FILTER (WHERE po.status <> 'cancelled' AND po.status <> 'draft'), 0)::bigint AS spend
         FROM purchase_orders po GROUP BY po.supplier_id`)).rows.map((r) => ({
      supplierId: r.supplier_id, orders: r.orders, received: r.received, onTimePct: r.received ? Math.round((r.on_time / r.received) * 100) : null, spendCents: r.spend,
    })));
  }
}
