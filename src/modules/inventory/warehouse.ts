import { z } from 'zod';
import type { Database } from '../../infra/db.js';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { isUuid, uuidv7 } from '../../infra/uuid.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { audit } from '../products/products.js';
import { applyMoves } from './stock.js';
import type { PoActor } from './purchasing.js';

const uuid = z.string().refine(isUuid, 'must be a UUID');

// ---- schemas -------------------------------------------------------------------------------------

export const StartCountSchema = z.strictObject({ locationId: uuid, zone: z.string().trim().max(60).default('Whole location') });
export const EnterCountSchema = z.strictObject({ productId: uuid, which: z.enum(['c1', 'c2']), value: z.number().int().min(0).max(10_000_000).nullable() });
export const CountListSchema = z.object({ status: z.enum(['counting', 'pending_approval', 'reconciled']).optional(), locationId: uuid.optional() });

export const DISPOSITIONS = ['restock_sellable', 'restock_clearance', 'write_off', 'return_to_supplier'] as const;
export const CreateReturnSchema = z.strictObject({
  orderId: uuid.optional(), customer: z.string().trim().max(120).default(''), productId: uuid, qty: z.number().int().min(1).max(10_000),
  reason: z.string().trim().max(200).default(''), condition: z.string().trim().max(80).default(''), valueCents: z.number().int().min(0).default(0),
});
export const DecideReturnSchema = z.strictObject({
  disposition: z.enum(DISPOSITIONS), locationId: uuid, notes: z.string().trim().max(300).default(''), refundReview: z.boolean().default(false),
});
export const ReturnListSchema = z.object({ state: z.enum(['open', 'decided']).default('open'), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional() });

export const PickSchema = z.strictObject({ productId: uuid, picked: z.boolean() });

// ---- helpers -----------------------------------------------------------------------------------------

export type CountState = 'not_counted' | 'matched' | 'recount' | 'variance';
/** Matched when the counts agree with the system; recount when the first count is off and there's no second. */
export function countState(l: { expected: number; c1: number | null; c2: number | null }): CountState {
  if (l.c1 === null) return 'not_counted';
  const final = l.c2 ?? l.c1;
  if (final === l.expected) return 'matched';
  return l.c2 === null ? 'recount' : 'variance';
}

export class WarehouseService {
  constructor(private readonly db: Database) {}

  // -- stock counts --------------------------------------------------------------------------------

  async counts(q: z.infer<typeof CountListSchema>) {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; count_no: number; location_id: string; location: string; zone: string; owner_name: string; status: string; started_at: Date; approved_by_name: string | null; lines: number; counted: number; variances: number }>(
        `SELECT sc.id, sc.count_no, sc.location_id, l.name AS location, sc.zone, sc.owner_name, sc.status, sc.started_at, sc.approved_by_name,
                count(scl.product_id)::int AS lines, count(scl.c1)::int AS counted,
                count(*) FILTER (WHERE scl.c1 IS NOT NULL AND COALESCE(scl.c2, scl.c1) <> scl.expected AND scl.c2 IS NOT NULL)::int AS variances
           FROM stock_counts sc JOIN locations l ON l.id = sc.location_id LEFT JOIN stock_count_lines scl ON scl.count_id = sc.id
          WHERE ($1::text IS NULL OR sc.status = $1) AND ($2::uuid IS NULL OR sc.location_id = $2)
          GROUP BY sc.id, l.name ORDER BY sc.count_no DESC LIMIT 200`, [q.status ?? null, q.locationId ?? null]);
      return { items: rows.map((r) => ({ id: r.id, number: `CC-${String(r.count_no).padStart(4, '0')}`, locationId: r.location_id, location: r.location, zone: r.zone, owner: r.owner_name, status: r.status, startedAt: r.started_at.toISOString(), approvedBy: r.approved_by_name, lines: r.lines, counted: r.counted, variances: r.variances })) };
    });
  }

  async count(id: string) {
    return this.db.read(async (c) => {
      const h = (await c.query<{ id: string; count_no: number; location_id: string; location: string; zone: string; owner_id: string; owner_name: string; status: string; started_at: Date; approved_by_name: string | null; version: number }>(
        `SELECT sc.*, l.name AS location FROM stock_counts sc JOIN locations l ON l.id = sc.location_id WHERE sc.id = $1`, [id])).rows[0];
      if (!h) throw new NotFoundError('Stock count');
      const { rows } = await c.query<{ product_id: string; sku: string; name: string; expected: number; c1: number | null; c2: number | null }>(
        `SELECT scl.product_id, p.sku, p.name, scl.expected, scl.c1, scl.c2 FROM stock_count_lines scl JOIN products p ON p.id = scl.product_id WHERE scl.count_id = $1 ORDER BY p.name`, [id]);
      return {
        id: h.id, number: `CC-${String(h.count_no).padStart(4, '0')}`, locationId: h.location_id, location: h.location, zone: h.zone, owner: h.owner_name, ownerId: h.owner_id,
        status: h.status, startedAt: h.started_at.toISOString(), approvedBy: h.approved_by_name, version: h.version,
        lines: rows.map((r) => ({ productId: r.product_id, sku: r.sku, name: r.name, expected: r.expected, c1: r.c1, c2: r.c2, state: countState(r) })),
      };
    });
  }

  async startCount(input: z.infer<typeof StartCountSchema>, actor: PoActor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      const loc = (await c.query<{ active: boolean }>('SELECT active FROM locations WHERE id = $1', [input.locationId])).rows[0];
      if (!loc) throw new NotFoundError('Location');
      try {
        await c.query('INSERT INTO stock_counts (id, location_id, zone, owner_id, owner_name) VALUES ($1,$2,$3,$4,$5)', [id, input.locationId, input.zone || 'Whole location', actor.id, actor.name]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictError('COUNT_OPEN', 'There is already an open count at that location. Finish it first.');
        throw e;
      }
      // The system's number is frozen when the count starts, so late sales don't move the goalposts mid-count.
      await c.query(
        `INSERT INTO stock_count_lines (count_id, product_id, expected)
         SELECT $1, p.id, COALESCE(sl.on_hand, 0) FROM products p LEFT JOIN stock_levels sl ON sl.product_id = p.id AND sl.location_id = $2
          WHERE p.status <> 'archived' AND p.track_stock`, [id, input.locationId]);
      await audit(c, actor, 'count.start', 'stock_count', id, input);
    });
    return this.count(id);
  }

  async enterCount(id: string, input: z.infer<typeof EnterCountSchema>, actor: PoActor) {
    await this.db.tx(async (c) => {
      const sc = (await c.query<{ status: string }>('SELECT status FROM stock_counts WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!sc) throw new NotFoundError('Stock count');
      if (sc.status !== 'counting') throw new UnprocessableError('COUNT_CLOSED', 'This count has been submitted');
      if (input.which === 'c2' && input.value !== null) {
        const l = (await c.query<{ c1: number | null }>('SELECT c1 FROM stock_count_lines WHERE count_id = $1 AND product_id = $2', [id, input.productId])).rows[0];
        if (l && l.c1 === null) throw new UnprocessableError('COUNT_FIRST', 'Enter the first count before the recount');
      }
      const col = input.which === 'c1' ? 'c1' : 'c2';
      const { rowCount } = await c.query(`UPDATE stock_count_lines SET ${col} = $3 ${input.which === 'c1' && input.value === null ? ', c2 = NULL' : ''} WHERE count_id = $1 AND product_id = $2`, [id, input.productId, input.value]);
      if (!rowCount) throw new NotFoundError('Product in this count');
      void actor;
    });
    return this.count(id);
  }

  async submitCount(id: string, actor: PoActor) {
    await this.db.tx(async (c) => {
      const sc = (await c.query<{ status: string }>('SELECT status FROM stock_counts WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!sc) throw new NotFoundError('Stock count');
      if (sc.status !== 'counting') throw new UnprocessableError('COUNT_CLOSED', 'This count has already been submitted');
      const { rows } = await c.query<{ expected: number; c1: number | null; c2: number | null }>('SELECT expected, c1, c2 FROM stock_count_lines WHERE count_id = $1', [id]);
      const states = rows.map(countState);
      if (states.includes('not_counted')) throw new UnprocessableError('INCOMPLETE_COUNT', 'Count every product before submitting');
      if (states.includes('recount')) throw new UnprocessableError('RECOUNT_NEEDED', 'Some products don’t match the system. Enter a second count for them.');
      const variance = states.includes('variance');
      await c.query(`UPDATE stock_counts SET status = $2, approved_by_name = CASE WHEN $2 = 'reconciled' THEN 'No variances' END, closed_at = CASE WHEN $2 = 'reconciled' THEN now() END, version = version + 1 WHERE id = $1`, [id, variance ? 'pending_approval' : 'reconciled']);
      await audit(c, actor, 'count.submit', 'stock_count', id, { variance });
    });
    return this.count(id);
  }

  /** Approving applies the differences to the shelves. The person who ran the count can't approve it (the owner can). */
  async approveCount(id: string, actor: PoActor) {
    await this.db.tx(async (c) => {
      const sc = (await c.query<{ status: string; owner_id: string; location_id: string; count_no: number }>('SELECT status, owner_id, location_id, count_no FROM stock_counts WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!sc) throw new NotFoundError('Stock count');
      if (sc.status !== 'pending_approval') throw new UnprocessableError('NOT_AWAITING_APPROVAL', 'This count isn’t waiting for approval');
      if (sc.owner_id === actor.id && !actor.isOwner) throw new ForbiddenError('You ran this count, so someone else must approve the adjustments');
      const { rows } = await c.query<{ product_id: string; c1: number | null; c2: number | null; expected: number; on_hand: number }>(
        `SELECT scl.product_id, scl.c1, scl.c2, scl.expected, COALESCE(sl.on_hand, 0) AS on_hand
           FROM stock_count_lines scl LEFT JOIN stock_levels sl ON sl.product_id = scl.product_id AND sl.location_id = $2 WHERE scl.count_id = $1`, [id, sc.location_id]);
      const ref = `CC-${String(sc.count_no).padStart(4, '0')}`;
      // Corrections are measured against what's on the shelf *now*, so sales made during the count aren't double-counted.
      const moves = rows.filter((l) => countState(l) === 'variance').map((l) => ({ productId: l.product_id, locationId: sc.location_id, delta: (l.c2 ?? l.c1)! - l.on_hand, type: 'Count correction' as const, ref, note: 'Stock count variance' })).filter((m) => m.delta !== 0);
      for (const m of moves) await c.query('SELECT 1 FROM inventory WHERE product_id = $1 FOR UPDATE', [m.productId]);
      await applyMoves(c, moves, { id: actor.id, name: actor.name });
      await c.query(`UPDATE stock_counts SET status = 'reconciled', approved_by = $2, approved_by_name = $3, closed_at = now(), version = version + 1 WHERE id = $1`, [id, actor.id, actor.name]);
      await audit(c, actor, 'count.approve', 'stock_count', id, { adjustments: moves.length });
    });
    return this.count(id);
  }

  // -- returns --------------------------------------------------------------------------------------------

  async returns(q: z.infer<typeof ReturnListSchema>) {
    const before = q.cursor ? decodeCursor(q.cursor, 1)[0]! : null;
    if (before !== null && !isUuid(before)) throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; return_no: number; order_id: string | null; order_no: number | null; customer: string; product_id: string | null; product_name: string; qty: number; reason: string; condition: string; value_cents: number; received_at: Date; disposition: string | null; location: string | null; decision_note: string; refund_review: boolean; decided_by_name: string | null; decided_at: Date | null }>(
        `SELECT r.*, o.order_no, l.name AS location FROM warehouse_returns r LEFT JOIN orders o ON o.id = r.order_id LEFT JOIN locations l ON l.id = r.location_id
          WHERE ($1::uuid IS NULL OR r.id < $1) AND (($2 = 'open' AND r.disposition IS NULL) OR ($2 = 'decided' AND r.disposition IS NOT NULL))
          ORDER BY r.id DESC LIMIT $3`, [before, q.state, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({ id: r.id, number: `RT-${r.return_no}`, orderId: r.order_id, orderNumber: r.order_no ? `SC-${r.order_no}` : null, customer: r.customer, productId: r.product_id, product: r.product_name, qty: r.qty, reason: r.reason, condition: r.condition, valueCents: r.value_cents, receivedAt: r.received_at.toISOString(), disposition: r.disposition, location: r.location, note: r.decision_note, refundReview: r.refund_review, decidedBy: r.decided_by_name, decidedAt: r.decided_at?.toISOString() ?? null })),
        nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1]!.id]) : null,
      };
    });
  }

  async createReturn(input: z.infer<typeof CreateReturnSchema>, actor: PoActor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      const p = (await c.query<{ name: string }>('SELECT name FROM products WHERE id = $1', [input.productId])).rows[0];
      if (!p) throw new NotFoundError('Product');
      await c.query('INSERT INTO warehouse_returns (id, order_id, customer, product_id, product_name, qty, reason, condition, value_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, input.orderId ?? null, input.customer, input.productId, p.name, input.qty, input.reason, input.condition, input.valueCents]);
      await audit(c, actor, 'return.receive', 'warehouse_return', id, input);
    });
    return (await this.returns({ state: 'open', limit: 200 })).items.find((r) => r.id === id)!;
  }

  async decideReturn(id: string, input: z.infer<typeof DecideReturnSchema>, actor: PoActor) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ disposition: string | null; product_id: string | null; qty: number; return_no: number }>('SELECT disposition, product_id, qty, return_no FROM warehouse_returns WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new NotFoundError('Return');
      if (r.disposition) throw new ConflictError('ALREADY_DECIDED', 'This return has already been decided');
      const loc = (await c.query<{ active: boolean }>('SELECT active FROM locations WHERE id = $1', [input.locationId])).rows[0];
      if (!loc) throw new NotFoundError('Location');
      if (input.disposition.startsWith('restock')) {
        if (!r.product_id) throw new UnprocessableError('NO_PRODUCT', 'This item can’t be matched to a product, so it can’t be restocked');
        await c.query('SELECT 1 FROM inventory WHERE product_id = $1 FOR UPDATE', [r.product_id]);
        await applyMoves(c, [{ productId: r.product_id, locationId: input.locationId, delta: r.qty, type: 'Return restock', ref: `RT-${r.return_no}`, note: input.disposition === 'restock_clearance' ? `Clearance. ${input.notes}`.trim() : input.notes }], { id: actor.id, name: actor.name });
      }
      await c.query('UPDATE warehouse_returns SET disposition = $2, location_id = $3, decision_note = $4, refund_review = $5, decided_by = $6, decided_by_name = $7, decided_at = now() WHERE id = $1',
        [id, input.disposition, input.locationId, input.notes, input.refundReview, actor.id, actor.name]);
      await audit(c, actor, 'return.decide', 'warehouse_return', id, input);
    });
    return (await this.returns({ state: 'decided', limit: 200 })).items.find((r) => r.id === id)!;
  }

  // -- picking and packing ------------------------------------------------------------------------------------

  /** Paid orders waiting to be picked and packed (oldest first), with what's been picked so far. */
  async packingQueue() {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; order_no: number; created_at: Date; total_cents: number; currency: string; stage: string | null; picked: string[] | null; started_at: Date | null; packed_at: Date | null; items: { productId: string; sku: string; name: string; quantity: number; location: string | null }[] }>(
        `SELECT o.id, o.order_no, o.created_at, o.total_cents, o.currency, ps.stage, ps.picked, ps.started_at, ps.packed_at,
                (SELECT json_agg(json_build_object('productId', oi.product_id, 'sku', oi.sku, 'name', oi.name, 'quantity', oi.quantity,
                        'location', (SELECT l.name FROM stock_levels sl JOIN locations l ON l.id = sl.location_id WHERE sl.product_id = oi.product_id AND sl.on_hand > 0 ORDER BY l.sort_order LIMIT 1)) ORDER BY oi.line_no)
                   FROM order_items oi WHERE oi.order_id = o.id) AS items
           FROM orders o LEFT JOIN pack_state ps ON ps.order_id = o.id
          WHERE o.status = 'PAID' ORDER BY o.created_at LIMIT 200`);
      return { items: rows.map((r) => ({ orderId: r.id, orderNumber: `SC-${r.order_no}`, placedAt: r.created_at.toISOString(), totalCents: r.total_cents, currency: r.currency, stage: r.stage ?? 'pick', picked: r.picked ?? [], startedAt: r.started_at?.toISOString() ?? null, packedAt: r.packed_at?.toISOString() ?? null, items: r.items ?? [] })) };
    });
  }

  async pick(orderId: string, input: z.infer<typeof PickSchema>) {
    await this.db.tx(async (c) => {
      const o = (await c.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0];
      if (!o) throw new NotFoundError('Order');
      if (o.status !== 'PAID') throw new UnprocessableError('NOT_PACKABLE', 'Only paid orders are picked and packed');
      if (!(await c.query('SELECT 1 FROM order_items WHERE order_id = $1 AND product_id = $2', [orderId, input.productId])).rowCount) throw new ValidationError([{ path: ['productId'], message: 'That item isn’t on this order' }]);
      await c.query(`INSERT INTO pack_state (order_id) VALUES ($1) ON CONFLICT DO NOTHING`, [orderId]);
      const st = (await c.query<{ stage: string }>('SELECT stage FROM pack_state WHERE order_id = $1 FOR UPDATE', [orderId])).rows[0]!;
      if (st.stage === 'packed') throw new UnprocessableError('ALREADY_PACKED', 'This order is already packed');
      await c.query(input.picked
        ? 'UPDATE pack_state SET picked = array_append(array_remove(picked, $2::uuid), $2::uuid) WHERE order_id = $1'
        : 'UPDATE pack_state SET picked = array_remove(picked, $2::uuid) WHERE order_id = $1', [orderId, input.productId]);
    });
  }

  async pack(orderId: string, actor: PoActor) {
    await this.db.tx(async (c) => {
      const o = (await c.query<{ status: string; order_no: number }>('SELECT status, order_no FROM orders WHERE id = $1', [orderId])).rows[0];
      if (!o) throw new NotFoundError('Order');
      if (o.status !== 'PAID') throw new UnprocessableError('NOT_PACKABLE', 'Only paid orders are picked and packed');
      const st = (await c.query<{ picked: string[]; stage: string }>('SELECT picked, stage FROM pack_state WHERE order_id = $1 FOR UPDATE', [orderId])).rows[0];
      const items = (await c.query<{ product_id: string }>('SELECT product_id FROM order_items WHERE order_id = $1', [orderId])).rows;
      if (!st || items.some((i) => !st.picked.includes(i.product_id))) throw new UnprocessableError('PICK_INCOMPLETE', 'Pick every item before packing');
      if (st.stage === 'packed') throw new UnprocessableError('ALREADY_PACKED', 'This order is already packed');
      await c.query(`UPDATE pack_state SET stage = 'packed', packed_at = now(), packed_by = $2 WHERE order_id = $1`, [orderId, actor.name]);
      await audit(c, actor, 'order.packed', 'order', orderId, { orderNumber: `SC-${o.order_no}` });
    });
  }
}
