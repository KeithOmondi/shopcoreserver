import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { isUuid, uuidv7 } from '../../infra/uuid.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { audit, outbox, type Actor } from '../products/products.js';
import { flag } from '../../http/validate.js';
import { PRIORITIES, type Person } from './support.js';

const uuid = z.string().refine(isUuid, 'must be a UUID');
export const DEFAULT_REFUND_LIMIT_CENTS = 500_000; // KES 5,000: above this, someone with payments access must approve
export const RETURN_WINDOW_DAYS = 14;

// ---- schemas ----------------------------------------------------------------------------------------------------------

export const RefundListSchema = z.object({ status: z.enum(['needs_review', 'approved', 'partly_approved', 'rejected']).optional(), orderId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional() });
export const StaffRefundSchema = z.strictObject({ orderId: uuid, amountCents: z.number().int().min(1), reason: z.string().trim().min(3).max(500), ticketId: uuid.optional(), priority: z.enum(PRIORITIES).default('high') });
export const OwnRefundSchema = z.strictObject({ amountCents: z.number().int().min(1), reason: z.string().trim().min(3).max(500) });
export const RefundDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('approve'), amountCents: z.number().int().min(1), reason: z.string().trim().min(3).max(500) }),
  z.strictObject({ decision: z.literal('reject'), reason: z.string().trim().min(3).max(500) }),
]);
export const NoteSchema = z.strictObject({ text: z.string().trim().min(1).max(1000) });

export const ReturnListSchema = z.object({ status: z.enum(['new', 'review', 'pending', 'evidence_requested', 'approved', 'rejected']).optional(), open: flag.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const OwnReturnSchema = z.strictObject({ productId: uuid, qty: z.number().int().min(1).max(100).default(1), reason: z.string().trim().min(3).max(200), statement: z.string().trim().max(2000).default(''), photos: z.number().int().min(0).max(10).default(0) });
export const ReturnDecisionSchema = z.strictObject({ decision: z.enum(['approved', 'rejected', 'evidence_requested', 'review']), note: z.string().trim().min(3).max(500), inspection: z.enum(['confirmed', 'more']).default('confirmed') });

export const DisputeListSchema = z.object({ status: z.enum(['awaiting_decision', 'escalated', 'resolved_customer', 'resolved_rider']).optional(), open: flag.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const NewDisputeSchema = z.strictObject({
  orderId: uuid, claimBy: z.enum(['customer', 'rider']).default('customer'), category: z.string().trim().max(60).default('Delivery'), priority: z.enum(PRIORITIES).default('high'),
  customerStatement: z.string().trim().max(2000).default(''), riderStatement: z.string().trim().max(2000).default(''), ticketId: uuid.optional(),
});
export const DisputePatchSchema = z.strictObject({ notes: z.string().trim().max(2000).optional(), customerStatement: z.string().trim().max(2000).optional(), riderStatement: z.string().trim().max(2000).optional(), evidence: z.string().trim().min(1).max(300).optional() })
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export const ResolveDisputeSchema = z.strictObject({ inFavourOf: z.enum(['customer', 'rider']), note: z.string().trim().min(3).max(1000), openRefund: z.boolean().default(false) });

export interface ClaimsActor extends Actor { name: string; canApproveLarge: boolean }

interface OrderMoney { total_cents: number; refunded_cents: number; paid: boolean; user_id: string; order_no: number; payment_ref: string | null; payment_method: string | null; customer_name: string }
async function orderMoney(c: Queryable, orderId: string): Promise<OrderMoney> {
  const o = (await c.query<OrderMoney>(
    `SELECT o.total_cents, o.refunded_cents, o.user_id, o.order_no, o.payment_ref, o.payment_method,
            (o.paid_at IS NOT NULL AND (o.cod_due_cents IS NULL OR o.cod_collected_at IS NOT NULL) AND o.status <> 'PENDING_PAYMENT') AS paid,
            COALESCE(NULLIF(o.delivery_name,''), NULLIF(cu.name,''), 'Customer') AS customer_name
       FROM orders o LEFT JOIN customers cu ON cu.id = o.user_id WHERE o.id = $1 FOR UPDATE OF o`, [orderId])).rows[0];
  if (!o) throw new NotFoundError('Order');
  return o;
}

export class ClaimsService {
  constructor(private readonly db: Database) {}

  private async refundLimit(c: Queryable) {
    const r = (await c.query<{ value: number }>(`SELECT value FROM settings WHERE key = 'support.refund_limit_cents'`)).rows[0];
    return Number(r?.value ?? DEFAULT_REFUND_LIMIT_CENTS);
  }

  // ---- refunds ---------------------------------------------------------------------------------------------------------------

  async refunds(q: z.infer<typeof RefundListSchema>) {
    const before = q.cursor ? decodeCursor(q.cursor, 1)[0]! : null;
    if (before !== null && !isUuid(before)) throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
    return this.db.read(async (c) => {
      const { rows } = await c.query<RefundRow>(
        `${REFUND_SELECT} WHERE ($1::uuid IS NULL OR r.id < $1) AND ($2::text IS NULL OR r.status = $2) AND ($3::uuid IS NULL OR r.order_id = $3) ORDER BY (r.status = 'needs_review') DESC, r.id DESC LIMIT $4`,
        [before, q.status ?? null, q.orderId ?? null, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return { items: page.map(refundView), limit: await this.refundLimit(c), nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1]!.id]) : null };
    });
  }

  async refund(id: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<RefundRow>(`${REFUND_SELECT} WHERE r.id = $1`, [id])).rows[0];
      if (!r) throw new NotFoundError('Refund request');
      const notes = (await c.query<{ body: string; by_name: string; at: Date }>('SELECT body, by_name, at FROM refund_notes WHERE refund_id = $1 ORDER BY id', [id])).rows;
      const items = (await c.query<{ name: string }>('SELECT name FROM order_items WHERE order_id = $1 ORDER BY line_no', [r.order_id])).rows;
      return { ...refundView(r), items: items.map((i) => i.name), notes: notes.map((n) => ({ text: n.body, by: n.by_name, at: n.at.toISOString() })) };
    });
  }

  private async createRefund(c: Queryable, orderId: string, amountCents: number, reason: string, openedBy: string, extra: { ticketId?: string; priority?: string; requireOwner?: string } = {}) {
    const o = await orderMoney(c, orderId);
    if (extra.requireOwner && o.user_id !== extra.requireOwner) throw new NotFoundError('Order');
    if (!o.paid) throw new UnprocessableError('NOT_PAID', 'This order wasn’t paid, so there is nothing to refund');
    const max = o.total_cents - o.refunded_cents;
    if (amountCents > max) throw new UnprocessableError('MORE_THAN_PAID', 'That’s more than can still be refunded on this order', { maxCents: max });
    const id = uuidv7();
    await c.query(`INSERT INTO refunds (id, order_id, customer_id, customer_name, amount_cents, reason, priority, ticket_id, opened_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, orderId, o.user_id, o.customer_name, amountCents, reason, extra.priority ?? 'normal', extra.ticketId ?? null, openedBy])
      .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('REFUND_OPEN', 'There is already a refund request waiting for this order'); throw e; });
    return id;
  }

  async openRefund(input: z.infer<typeof StaffRefundSchema>, actor: ClaimsActor) {
    const id = await this.db.tx(async (c) => {
      const rid = await this.createRefund(c, input.orderId, input.amountCents, input.reason, actor.name, { ticketId: input.ticketId, priority: input.priority });
      await c.query('INSERT INTO refund_notes (refund_id, body, by_name) VALUES ($1,$2,$3)', [rid, `Opened by ${actor.name}`, actor.name]);
      await audit(c, actor, 'refund.open', 'refund', rid, input);
      return rid;
    });
    return this.refund(id);
  }

  /** A shopper asks for their money back. It waits for a person to decide. */
  async requestRefund(person: Person, orderId: string, input: z.infer<typeof OwnRefundSchema>) {
    const id = await this.db.tx((c) => this.createRefund(c, orderId, input.amountCents, input.reason, 'Customer', { requireOwner: person.id, priority: 'normal' }));
    return this.refund(id).then((r) => ({ id: r.id, number: r.number, status: r.status, amountCents: r.amountCents }));
  }

  async decideRefund(id: string, input: z.infer<typeof RefundDecisionSchema>, actor: ClaimsActor) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ status: string; order_id: string; amount_cents: number; refund_no: number }>('SELECT status, order_id, amount_cents, refund_no FROM refunds WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new NotFoundError('Refund request');
      if (r.status !== 'needs_review') throw new ConflictError('ALREADY_DECIDED', 'This request has already been decided');
      if (input.decision === 'reject') {
        await c.query(`UPDATE refunds SET status = 'rejected', decided_by = $2, decided_by_name = $3, decided_at = now(), decided_cents = 0, decision_reason = $4 WHERE id = $1`, [id, actor.id, actor.name, input.reason]);
        await audit(c, actor, 'refund.reject', 'refund', id, input);
        return;
      }
      const o = await orderMoney(c, r.order_id);
      if (!o.paid) throw new UnprocessableError('NOT_PAID', 'This order wasn’t paid, so there is nothing to refund');
      const max = o.total_cents - o.refunded_cents;
      if (input.amountCents > max) throw new UnprocessableError('MORE_THAN_PAID', 'The most that can still be refunded on this order is less than that', { maxCents: max });
      const limit = await this.refundLimit(c);
      if (input.amountCents > limit && !actor.canApproveLarge) {
        throw new ForbiddenError(`Refunds above KES ${(limit / 100).toLocaleString('en-KE')} need approval from someone with payments access. Add a note and ask finance.`);
      }
      await c.query('UPDATE orders SET refunded_cents = refunded_cents + $2, updated_at = now() WHERE id = $1', [r.order_id, input.amountCents]);
      await c.query(`UPDATE refunds SET status = $2, decided_by = $3, decided_by_name = $4, decided_at = now(), decided_cents = $5, decision_reason = $6 WHERE id = $1`,
        [id, input.amountCents >= r.amount_cents ? 'approved' : 'partly_approved', actor.id, actor.name, input.amountCents, input.reason]);
      // The payment service picks this up and sends the money back (M-Pesa reversal, card refund, or a manual cash payout for cash orders).
      await outbox(c, 'order', r.order_id, 'RefundApproved', { refundId: id, number: `RF-${r.refund_no}`, orderId: r.order_id, amountCents: input.amountCents, paymentRef: o.payment_ref, method: o.payment_method });
      await audit(c, actor, 'refund.approve', 'refund', id, input);
    });
    return this.refund(id);
  }

  async refundNote(id: string, text: string, actor: Actor) {
    await this.db.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM refunds WHERE id = $1', [id])).rowCount) throw new NotFoundError('Refund request');
      await c.query('INSERT INTO refund_notes (refund_id, body, by_name) VALUES ($1,$2,$3)', [id, text, actor.name ?? 'Staff']);
    });
    return this.refund(id);
  }

  // ---- returns ------------------------------------------------------------------------------------------------------------------

  async returns(q: z.infer<typeof ReturnListSchema>) {
    return this.db.read(async (c) => ({ items: (await c.query<ReturnRow>(
      `${RETURN_SELECT} WHERE ($1::text IS NULL OR r.status = $1) AND (NOT $2 OR r.status IN ('new','review','pending','evidence_requested')) ORDER BY (r.status IN ('new','review','pending','evidence_requested')) DESC, r.submitted_at DESC LIMIT $3`,
      [q.status ?? null, q.open === true, q.limit])).rows.map(returnView) }));
  }

  async submitReturn(person: Person, orderId: string, input: z.infer<typeof OwnReturnSchema>) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      const o = (await c.query<{ status: string; fulfilled_at: Date | null; name: string }>(
        `SELECT o.status, o.fulfilled_at, COALESCE(NULLIF(o.delivery_name,''), NULLIF(cu.name,''), $2) AS name FROM orders o LEFT JOIN customers cu ON cu.id = o.user_id WHERE o.id = $1 AND o.user_id = $3`, [orderId, person.name, person.id])).rows[0];
      if (!o) throw new NotFoundError('Order');
      if (o.status !== 'FULFILLED' || !o.fulfilled_at) throw new UnprocessableError('NOT_DELIVERED', 'You can return an order once it has arrived');
      if (Date.now() - o.fulfilled_at.getTime() > RETURN_WINDOW_DAYS * 86_400_000) throw new UnprocessableError('RETURN_WINDOW_PASSED', `Returns are accepted for ${RETURN_WINDOW_DAYS} days after delivery`);
      const it = (await c.query<{ name: string; quantity: number; unit_price_cents: number }>('SELECT name, quantity, unit_price_cents FROM order_items WHERE order_id = $1 AND product_id = $2', [orderId, input.productId])).rows[0];
      if (!it) throw new ValidationError([{ path: ['productId'], message: 'That item wasn’t on this order' }]);
      const already = Number((await c.query<{ n: number }>(`SELECT COALESCE(sum(qty),0)::int AS n FROM return_requests WHERE order_id = $1 AND product_id = $2 AND status <> 'rejected'`, [orderId, input.productId])).rows[0]!.n);
      if (already + input.qty > it.quantity) throw new UnprocessableError('ALREADY_RETURNED', 'You’ve already asked to return that item');
      await c.query(`INSERT INTO return_requests (id, order_id, customer_id, customer_name, product_id, item, item_value_cents, qty, reason, statement, photos) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, orderId, person.id, o.name, input.productId, it.name, it.unit_price_cents * input.qty, input.qty, input.reason, input.statement, input.photos]);
    });
    return { id };
  }

  async decideReturn(id: string, input: z.infer<typeof ReturnDecisionSchema>, actor: ClaimsActor) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ status: string; order_id: string; product_id: string | null; item: string; qty: number; reason: string; customer_name: string; photos: number; item_value_cents: number; request_no: number }>(
        'SELECT status, order_id, product_id, item, qty, reason, customer_name, photos, item_value_cents, request_no FROM return_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new NotFoundError('Return request');
      if (['approved', 'rejected'].includes(r.status)) throw new ConflictError('ALREADY_DECIDED', 'This return has already been decided');
      const final = input.decision === 'approved' || input.decision === 'rejected';
      await c.query('UPDATE return_requests SET status = $2, note = $3, inspection = $4, decided_by = CASE WHEN $5 THEN $6 END, decided_at = CASE WHEN $5 THEN now() END WHERE id = $1', [id, input.decision, input.note, input.inspection, final, actor.name]);
      if (input.decision === 'approved') {
        // The item now waits in the warehouse queue for a restock / write-off decision.
        await c.query(
          `INSERT INTO warehouse_returns (id, order_id, customer, product_id, product_name, qty, reason, condition, value_cents, support_request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [uuidv7(), r.order_id, r.customer_name, r.product_id, r.item, r.qty, r.reason, r.photos > 0 ? 'Photo evidence' : 'Reported', r.item_value_cents, id]);
      }
      await audit(c, actor, `return.${input.decision}`, 'return_request', id, input);
    });
    return (await this.returns({ limit: 200 })).items.find((x) => x.id === id)!;
  }

  // ---- disputes ---------------------------------------------------------------------------------------------------------------------

  async disputes(q: z.infer<typeof DisputeListSchema>) {
    return this.db.read(async (c) => ({ items: (await c.query<DisputeRow>(
      `${DISPUTE_SELECT} WHERE ($1::text IS NULL OR d.status = $1) AND (NOT $2 OR d.status IN ('awaiting_decision','escalated')) ORDER BY (d.status IN ('awaiting_decision','escalated')) DESC, d.opened_at DESC LIMIT $3`,
      [q.status ?? null, q.open === true, q.limit])).rows.map(disputeView) }));
  }

  async dispute(id: string) {
    const d = (await this.db.read((c) => c.query<DisputeRow>(`${DISPUTE_SELECT} WHERE d.id = $1`, [id]))).rows[0];
    if (!d) throw new NotFoundError('Dispute');
    return disputeView(d);
  }

  async openDispute(input: z.infer<typeof NewDisputeSchema>, actor: ClaimsActor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      const o = await orderMoney(c, input.orderId);
      const rider = (await c.query<{ id: string; name: string }>(
        `SELECT r.id, r.name FROM deliveries d JOIN riders r ON r.id = d.rider_id WHERE d.order_id = $1 AND d.rider_id IS NOT NULL ORDER BY d.created_at DESC LIMIT 1`, [input.orderId])).rows[0];
      if ((await c.query(`SELECT 1 FROM disputes WHERE order_id = $1 AND status IN ('awaiting_decision','escalated')`, [input.orderId])).rowCount) throw new ConflictError('DISPUTE_OPEN', 'There is already an open dispute for this order');
      await c.query(
        `INSERT INTO disputes (id, order_id, customer_id, customer_name, rider_id, rider_name, claim_by, category, priority, customer_statement, rider_statement, ticket_id, assignee_name, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, input.orderId, o.user_id, o.customer_name, rider?.id ?? null, rider?.name ?? 'Unassigned', input.claimBy, input.category, input.priority, input.customerStatement, input.riderStatement, input.ticketId ?? null, actor.name,
          JSON.stringify([{ text: 'Dispute opened by staff', sub: actor.name, tone: 'gray' }])]);
      await audit(c, actor, 'dispute.open', 'dispute', id, input);
    });
    return this.dispute(id);
  }

  async updateDispute(id: string, p: z.infer<typeof DisputePatchSchema>, actor: ClaimsActor) {
    await this.db.tx(async (c) => {
      const d = (await c.query<{ status: string }>('SELECT status FROM disputes WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!d) throw new NotFoundError('Dispute');
      if (d.status.startsWith('resolved')) throw new ConflictError('ALREADY_RESOLVED', 'This dispute has been resolved');
      await c.query(
        `UPDATE disputes SET notes = COALESCE($2, notes), customer_statement = COALESCE($3, customer_statement), rider_statement = COALESCE($4, rider_statement),
                evidence = CASE WHEN $5::text IS NULL THEN evidence ELSE evidence || jsonb_build_array(jsonb_build_object('text', $5::text, 'sub', $6::text, 'tone', 'blue')) END WHERE id = $1`,
        [id, p.notes ?? null, p.customerStatement ?? null, p.riderStatement ?? null, p.evidence ?? null, actor.name]);
      await audit(c, actor, 'dispute.update', 'dispute', id, { fields: Object.keys(p) });
    });
    return this.dispute(id);
  }

  async escalate(id: string, actor: ClaimsActor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query(`UPDATE disputes SET status = 'escalated' WHERE id = $1 AND status = 'awaiting_decision'`, [id]);
      if (!rowCount) throw new UnprocessableError('CANNOT_ESCALATE', 'Only a dispute waiting for a decision can be escalated');
      await audit(c, actor, 'dispute.escalate', 'dispute', id, {});
    });
    return this.dispute(id);
  }

  /** Decide a dispute. Ruling for the customer can open a refund for what is still owed on the order. */
  async resolve(id: string, input: z.infer<typeof ResolveDisputeSchema>, actor: ClaimsActor) {
    await this.db.tx(async (c) => {
      const d = (await c.query<{ status: string; order_id: string; ticket_id: string | null; dispute_no: number }>('SELECT status, order_id, ticket_id, dispute_no FROM disputes WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!d) throw new NotFoundError('Dispute');
      if (d.status.startsWith('resolved')) throw new ConflictError('ALREADY_RESOLVED', 'This dispute has already been resolved');
      await c.query(`UPDATE disputes SET status = $2, notes = $3, outcome_by = $4, outcome_at = now(), outcome_note = $3 WHERE id = $1`, [id, input.inFavourOf === 'customer' ? 'resolved_customer' : 'resolved_rider', input.note, actor.name]);
      if (input.inFavourOf === 'customer' && input.openRefund) {
        const o = await orderMoney(c, d.order_id);
        const left = o.total_cents - o.refunded_cents;
        const open = (await c.query('SELECT 1 FROM refunds WHERE order_id = $1 AND status = $2', [d.order_id, 'needs_review'])).rowCount;
        if (o.paid && left > 0 && !open) await this.createRefund(c, d.order_id, left, `Dispute DSP-${d.dispute_no} resolved for the customer`, actor.name, { ticketId: d.ticket_id ?? undefined, priority: 'high' });
      }
      await audit(c, actor, 'dispute.resolve', 'dispute', id, input);
    });
    return this.dispute(id);
  }

  // ---- what a shopper sees of their claims ---------------------------------------------------------------------------------------

  async mine(customerId: string) {
    return this.db.read(async (c) => ({
      refunds: (await c.query<{ id: string; refund_no: number; order_no: number; amount_cents: number; status: string; decided_cents: number | null; submitted_at: Date }>(
        `SELECT r.id, r.refund_no, o.order_no, r.amount_cents, r.status, r.decided_cents, r.submitted_at FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.customer_id = $1 ORDER BY r.submitted_at DESC LIMIT 30`, [customerId])).rows
        .map((r) => ({ id: r.id, number: `RF-${r.refund_no}`, order: `SC-${r.order_no}`, amountCents: r.amount_cents, status: r.status, refundedCents: r.decided_cents, at: r.submitted_at.toISOString() })),
      returns: (await c.query<{ id: string; request_no: number; order_no: number; item: string; qty: number; status: string; note: string; submitted_at: Date }>(
        `SELECT r.id, r.request_no, o.order_no, r.item, r.qty, r.status, r.note, r.submitted_at FROM return_requests r JOIN orders o ON o.id = r.order_id WHERE r.customer_id = $1 ORDER BY r.submitted_at DESC LIMIT 30`, [customerId])).rows
        .map((r) => ({ id: r.id, number: `RR-${r.request_no}`, order: `SC-${r.order_no}`, item: r.item, qty: r.qty, status: r.status, message: ['evidence_requested', 'rejected', 'approved'].includes(r.status) ? r.note : '', at: r.submitted_at.toISOString() })),
    }));
  }
}

// ---- row shapes ------------------------------------------------------------------------------------------------------------------

interface RefundRow {
  id: string; refund_no: number; order_id: string; order_no: number; customer_id: string; customer_name: string; amount_cents: number; reason: string; priority: string; status: string; ticket_id: string | null;
  opened_by: string; submitted_at: Date; decided_by_name: string | null; decided_at: Date | null; decided_cents: number | null; decision_reason: string | null; total_cents: number; refunded_cents: number;
}
const REFUND_SELECT = `SELECT r.*, o.order_no, o.total_cents, o.refunded_cents FROM refunds r JOIN orders o ON o.id = r.order_id`;
const refundView = (r: RefundRow) => ({
  id: r.id, number: `RF-${r.refund_no}`, orderId: r.order_id, order: `SC-${r.order_no}`, customerId: r.customer_id, customer: r.customer_name, amountCents: r.amount_cents, reason: r.reason, priority: r.priority,
  status: r.status, ticketId: r.ticket_id, openedBy: r.opened_by, submittedAt: r.submitted_at.toISOString(), orderTotalCents: r.total_cents, alreadyRefundedCents: r.refunded_cents,
  decision: r.decided_at ? { by: r.decided_by_name, at: r.decided_at.toISOString(), amountCents: r.decided_cents ?? 0, reason: r.decision_reason ?? '' } : null,
});

interface ReturnRow { id: string; request_no: number; order_id: string; order_no: number; customer_name: string; item: string; item_value_cents: number; qty: number; reason: string; statement: string; photos: number; status: string; inspection: string; note: string; ticket_id: string | null; submitted_at: Date; decided_by: string | null; decided_at: Date | null }
const RETURN_SELECT = `SELECT r.*, o.order_no FROM return_requests r JOIN orders o ON o.id = r.order_id`;
const returnView = (r: ReturnRow) => ({
  id: r.id, number: `RR-${r.request_no}`, orderId: r.order_id, order: `SC-${r.order_no}`, customer: r.customer_name, item: r.item, itemValueCents: r.item_value_cents, qty: r.qty, reason: r.reason, statement: r.statement,
  photos: r.photos, status: r.status, inspection: r.inspection, note: r.note, ticketId: r.ticket_id, submittedAt: r.submitted_at.toISOString(), decidedBy: r.decided_by, decidedAt: r.decided_at?.toISOString() ?? null,
});

interface DisputeRow { id: string; dispute_no: number; order_id: string; order_no: number; customer_id: string; customer_name: string; rider_id: string | null; rider_name: string; claim_by: string; category: string; priority: string; status: string; customer_statement: string; rider_statement: string; evidence: unknown; notes: string; ticket_id: string | null; assignee_name: string | null; opened_at: Date; sla_due_at: Date; outcome_by: string | null; outcome_at: Date | null; outcome_note: string | null }
const DISPUTE_SELECT = `SELECT d.*, o.order_no FROM disputes d JOIN orders o ON o.id = d.order_id`;
const disputeView = (d: DisputeRow) => ({
  id: d.id, number: `DSP-${d.dispute_no}`, orderId: d.order_id, order: `SC-${d.order_no}`, customerId: d.customer_id, customer: d.customer_name, riderId: d.rider_id, rider: d.rider_name, claimBy: d.claim_by, category: d.category,
  priority: d.priority, status: d.status, customerStatement: d.customer_statement, riderStatement: d.rider_statement, evidence: d.evidence, notes: d.notes, ticketId: d.ticket_id, assignee: d.assignee_name,
  openedAt: d.opened_at.toISOString(), slaDueAt: d.sla_due_at.toISOString(), late: !d.status.startsWith('resolved') && d.sla_due_at.getTime() < Date.now(),
  outcome: d.outcome_at ? { by: d.outcome_by, at: d.outcome_at.toISOString(), note: d.outcome_note } : null,
});
