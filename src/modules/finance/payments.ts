import { z } from 'zod';
import type { Database } from '../../infra/db.js';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { audit, type Actor } from '../products/products.js';
import type { OrderService } from '../orders/orders.js';
import { flag } from '../../http/validate.js';
import { assertOpen } from './common.js';

const METHODS = ['mpesa', 'card'] as const;
export const PaymentListSchema = z.object({
  status: z.enum(['success', 'failed', 'recovered', 'manual_review']).optional(),
  method: z.enum(METHODS).optional(),
  q: z.string().trim().max(80).optional(),
  failuresOnly: flag.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const FailureSchema = z.strictObject({
  method: z.enum(METHODS),
  reason: z.string().trim().min(1).max(200),
  ref: z.string().trim().min(1).max(128),
});
export const StatementImportSchema = z.strictObject({ file: z.string().trim().min(1).max(200), text: z.string().min(1).max(2_000_000) });
export const ResolveLineSchema = z.strictObject({
  how: z.enum(['adjusted', 'written_off', 'matched_manually']),
  note: z.string().trim().min(3).max(300),
  orderId: z.string().uuid().optional(),
});

/** Reasons that usually clear on a second try. */
export const RETRYABLE = ['Customer not reachable', 'Timeout at gateway', 'Network error'];
export const MAX_ATTEMPTS = 3;

/** The payment provider. M-Pesa and card are connected in the wire-up phase; until then a development gateway stands in. */
export interface PaymentGateway {
  retry(f: { orderId: string; method: string; amountCents: number; reason: string; ref: string }): Promise<{ ok: true; ref: string } | { ok: false; reason: string }>;
}
/** Used with real M-Pesa: a retry can't charge anyone on the customer's behalf, so it asks them to pay again from the app. */
export const askCustomerGateway: PaymentGateway = {
  async retry(f) { return { ok: false, reason: f.reason }; },
};
export const devGateway: PaymentGateway = {
  async retry(f) {
    return RETRYABLE.includes(f.reason) ? { ok: true, ref: `${f.ref}-R` } : { ok: false, reason: f.reason };
  },
};

const STATUS_LABEL: Record<string, string> = { failed: 'Failed', recovered: 'Recovered', manual_review: 'Manual review' };
const METHOD_LABEL: Record<string, string> = { mpesa: 'M-Pesa', card: 'Card' };

/** A statement amount in shillings (with optional commas or decimals) as cents. */
function cents(text: string): number | null {
  const n = Number(text.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
/** Splits one CSV row, honouring quoted cells. */
function cells(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (q) { if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export class PaymentsService {
  constructor(private readonly db: Database, private readonly orders: OrderService, private readonly gateway: PaymentGateway = devGateway) {}

  // ---- the payments list: money that came in, and attempts that failed ------------------------------------------------------------

  async list(q: z.infer<typeof PaymentListSchema>) {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ kind: string; id: string; number: string; order_id: string; order_no: number; customer: string; method: string; amount_cents: number; status: string; ref: string; at: Date; reason: string | null; attempts: number | null }>(
        `SELECT * FROM (
           SELECT 'payment' AS kind, o.id, 'PAY-' || o.order_no AS number, o.id AS order_id, o.order_no, COALESCE(NULLIF(o.delivery_name, ''), NULLIF(cu.name, ''), 'Customer') AS customer,
                  o.payment_method AS method, o.total_cents AS amount_cents, 'success' AS status, o.payment_ref AS ref, o.paid_at AS at, NULL::text AS reason, NULL::int AS attempts
             FROM orders o LEFT JOIN customers cu ON cu.id = o.user_id
            WHERE o.paid_at IS NOT NULL AND o.payment_method IN ('mpesa', 'card') AND $3::boolean IS NOT TRUE
           UNION ALL
           SELECT 'failure', f.id, 'PM-' || f.fail_no, f.order_id, o.order_no, COALESCE(NULLIF(o.delivery_name, ''), NULLIF(cu.name, ''), 'Customer'),
                  f.method, f.amount_cents, f.status, f.ref, f.created_at, f.reason, f.attempts
             FROM failed_payments f JOIN orders o ON o.id = f.order_id LEFT JOIN customers cu ON cu.id = o.user_id
         ) p
          WHERE ($1::text IS NULL OR p.status = $1) AND ($2::text IS NULL OR p.method = $2)
            AND ($4::text IS NULL OR p.number ILIKE '%' || $4 || '%' OR p.ref ILIKE '%' || $4 || '%' OR p.customer ILIKE '%' || $4 || '%' OR ('SC-' || p.order_no) ILIKE '%' || $4 || '%')
          ORDER BY p.at DESC NULLS LAST LIMIT $5`,
        [q.status ?? null, q.method ?? null, q.failuresOnly ?? null, q.q ?? null, q.limit]);
      const t = (await c.query<{ paid: number; received: number; failed: number; recovered: number; review: number }>(
        `SELECT (SELECT count(*) FROM orders WHERE paid_at IS NOT NULL AND payment_method IN ('mpesa','card'))::int AS paid,
                (SELECT COALESCE(sum(total_cents),0) FROM orders WHERE paid_at IS NOT NULL AND payment_method IN ('mpesa','card'))::bigint AS received,
                (SELECT count(*) FROM failed_payments WHERE status = 'failed')::int AS failed,
                (SELECT count(*) FROM failed_payments WHERE status = 'recovered')::int AS recovered,
                (SELECT count(*) FROM failed_payments WHERE status = 'manual_review')::int AS review`)).rows[0]!;
      return {
        items: rows.map((r) => ({
          kind: r.kind, id: r.id, number: r.number, orderId: r.order_id, orderNumber: `SC-${r.order_no}`, customer: r.customer, method: METHOD_LABEL[r.method] ?? r.method, amountCents: Number(r.amount_cents),
          status: r.kind === 'payment' ? 'Success' : r.status === 'recovered' ? 'Success' : 'Failed', state: r.kind === 'payment' ? 'success' : r.status, stateLabel: r.kind === 'payment' ? 'Success' : STATUS_LABEL[r.status],
          ref: r.ref, at: r.at?.toISOString() ?? null, reason: r.reason, attempts: r.attempts,
        })),
        totals: { successCount: t.paid, receivedCents: Number(t.received), failed: t.failed, recovered: t.recovered, manualReview: t.review },
      };
    });
  }

  async detail(id: string) {
    return this.db.read(async (c) => {
      const f = (await c.query<{ id: string; fail_no: number; order_id: string; method: string; amount_cents: number; reason: string; ref: string; attempts: number; status: string; created_at: Date; updated_at: Date }>('SELECT * FROM failed_payments WHERE id = $1', [id])).rows[0];
      const orderId = f?.order_id ?? id;
      const o = (await c.query<{ id: string; order_no: number; user_id: string; status: string; total_cents: number; item_count: number; payment_method: string | null; payment_ref: string | null; paid_at: Date | null; created_at: Date; refunded_cents: number; customer: string; phone: string | null }>(
        `SELECT o.id, o.order_no, o.user_id, o.status, o.total_cents, o.item_count, o.payment_method, o.payment_ref, o.paid_at, o.created_at, o.refunded_cents,
                COALESCE(NULLIF(o.delivery_name, ''), NULLIF(cu.name, ''), 'Customer') AS customer, COALESCE(NULLIF(o.delivery_phone, ''), cu.phone) AS phone
           FROM orders o LEFT JOIN customers cu ON cu.id = o.user_id WHERE o.id = $1`, [orderId])).rows[0];
      if (!o || (!f && !o.paid_at)) throw new NotFoundError('Payment');
      const refunds = (await c.query<{ refund_no: number; decided_cents: number | null; decided_at: Date | null }>(`SELECT refund_no, decided_cents, decided_at FROM refunds WHERE order_id = $1 AND status IN ('approved', 'partly_approved') ORDER BY decided_at`, [orderId])).rows;
      const failures = (await c.query<{ fail_no: number; reason: string; created_at: Date }>('SELECT fail_no, reason, created_at FROM failed_payments WHERE order_id = $1 ORDER BY created_at', [orderId])).rows;
      const timeline = [
        { at: o.created_at.toISOString(), label: `Order SC-${o.order_no} placed` },
        ...failures.map((x) => ({ at: x.created_at.toISOString(), label: `Payment PM-${x.fail_no} failed: ${x.reason}` })),
        ...(o.paid_at ? [{ at: o.paid_at.toISOString(), label: `Payment received${o.payment_ref ? ` (${o.payment_ref})` : ''}` }] : []),
        ...refunds.filter((r) => r.decided_at).map((r) => ({ at: r.decided_at!.toISOString(), label: `Refund RF-${r.refund_no} approved for KES ${(Number(r.decided_cents) / 100).toLocaleString('en-KE')}` })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      return {
        kind: f ? 'failure' : 'payment', id: f?.id ?? o.id, number: f ? `PM-${f.fail_no}` : `PAY-${o.order_no}`,
        method: METHOD_LABEL[f?.method ?? o.payment_method ?? ''] ?? o.payment_method, amountCents: Number(f?.amount_cents ?? o.total_cents), ref: f?.ref ?? o.payment_ref,
        state: f ? f.status : 'success', stateLabel: f ? STATUS_LABEL[f.status] : 'Success', reason: f?.reason ?? null, attempts: f?.attempts ?? null, at: (f?.created_at ?? o.paid_at)?.toISOString() ?? null,
        retryable: !!f && f.status === 'failed',
        order: { id: o.id, number: `SC-${o.order_no}`, status: o.status, totalCents: Number(o.total_cents), itemCount: o.item_count, refundedCents: Number(o.refunded_cents) },
        customer: { id: o.user_id, name: o.customer, phone: o.phone },
        timeline,
      };
    });
  }

  // ---- failures ------------------------------------------------------------------------------------------------------------------------

  /** The payment service reports a failed attempt. Reporting the same reference twice changes nothing. */
  async recordFailure(orderId: string, input: z.infer<typeof FailureSchema>, actor: Actor) {
    return this.db.tx(async (c) => {
      const o = (await c.query<{ total_cents: number; status: string }>('SELECT total_cents, status FROM orders WHERE id = $1', [orderId])).rows[0];
      if (!o) throw new NotFoundError('Order');
      const seen = (await c.query<{ id: string }>('SELECT id FROM failed_payments WHERE lower(ref) = lower($1)', [input.ref])).rows[0];
      if (seen) return { id: seen.id, duplicate: true };
      const id = uuidv7();
      await c.query('INSERT INTO failed_payments (id, order_id, method, amount_cents, reason, ref) VALUES ($1,$2,$3,$4,$5,$6)', [id, orderId, input.method, o.total_cents, input.reason, input.ref]);
      await audit(c, actor, 'payment.failed', 'order', orderId, input);
      return { id, duplicate: false };
    });
  }

  /** Try a failed collection again. Reasons that clear on their own recover the order; others go to manual review after three tries. */
  async retry(id: string, actor: Actor): Promise<{ outcome: 'recovered' | 'failed' | 'manual_review'; reason?: string }> {
    const f = await this.db.tx(async (c) => {
      const r = (await c.query<{ id: string; order_id: string; method: string; amount_cents: number; reason: string; ref: string; attempts: number; status: string }>('SELECT * FROM failed_payments WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new NotFoundError('Payment');
      if (r.status !== 'failed') throw new ConflictError('NOT_RETRYABLE', r.status === 'recovered' ? 'This payment has already been recovered' : 'This payment needs a manual review and can’t be retried');
      // Reserve the attempt first so two people clicking at once don’t charge the customer twice.
      await c.query(`UPDATE failed_payments SET attempts = attempts + 1, updated_at = now() WHERE id = $1`, [id]);
      return { ...r, attempts: r.attempts + 1 };
    });
    const res = await this.gateway.retry({ orderId: f.order_id, method: f.method, amountCents: Number(f.amount_cents), reason: f.reason, ref: f.ref });
    if (res.ok) {
      const order = (await this.db.read((c) => c.query<{ currency: string }>('SELECT currency FROM orders WHERE id = $1', [f.order_id]))).rows[0]!;
      await this.orders.markPaid(f.order_id, actor, { paymentRef: res.ref, amountCents: Number(f.amount_cents), currency: order.currency });
      await this.db.tx(async (c) => {
        await c.query(`UPDATE failed_payments SET status = 'recovered', updated_at = now() WHERE id = $1`, [id]);
        await audit(c, actor, 'payment.recovered', 'order', f.order_id, { id, attempts: f.attempts, ref: res.ref });
      });
      return { outcome: 'recovered' };
    }
    const status = f.attempts >= MAX_ATTEMPTS ? 'manual_review' : 'failed';
    await this.db.tx(async (c) => {
      await c.query('UPDATE failed_payments SET status = $2, reason = $3, updated_at = now() WHERE id = $1', [id, status, res.reason]);
      await audit(c, actor, 'payment.retry_failed', 'order', f.order_id, { id, attempts: f.attempts, reason: res.reason });
    });
    return { outcome: status, reason: res.reason };
  }

  /** Retries every failure whose reason usually clears on a second try. */
  async retryEligible(actor: Actor) {
    const ids = (await this.db.read((c) => c.query<{ id: string }>(`SELECT id FROM failed_payments WHERE status = 'failed' AND reason = ANY($1) ORDER BY created_at`, [RETRYABLE]))).rows.map((r) => r.id);
    const out = { tried: 0, recovered: 0, stillFailing: 0 };
    for (const id of ids) {
      try {
        const r = await this.retry(id, actor);
        out.tried++;
        if (r.outcome === 'recovered') out.recovered++; else out.stillFailing++;
      } catch (e) { if (!(e instanceof ConflictError)) throw e; }
    }
    return out;
  }

  // ---- reconciliation against the gateway’s own statement -----------------------------------------------------------------------------

  private stateOf(l: { resolution: string | null; ours_cents: number | null; gateway_cents: number }) {
    return l.resolution ? 'Resolved' : l.ours_cents === null ? 'Unmatched' : Number(l.gateway_cents) === Number(l.ours_cents) ? 'Matched' : 'Mismatch';
  }

  async statement(id?: string) {
    return this.db.read(async (c) => {
      const s = (await c.query<{ id: string; file_name: string; imported_by: string; imported_at: Date; completed_at: Date | null; completed_by: string | null }>(
        id ? 'SELECT * FROM statements WHERE id = $1' : 'SELECT * FROM statements ORDER BY imported_at DESC LIMIT 1', id ? [id] : [])).rows[0];
      if (!s) return null;
      const lines = (await c.query<{ id: string; ref: string; gateway_cents: number; order_id: string | null; order_no: number | null; ours_cents: number | null; resolution: string | null; note: string }>(
        `SELECT l.id, l.ref, l.gateway_cents, l.order_id, o.order_no, l.ours_cents, l.resolution, l.note FROM statement_lines l LEFT JOIN orders o ON o.id = l.order_id WHERE l.statement_id = $1 ORDER BY l.line_no`, [s.id])).rows;
      const view = lines.map((l) => ({ id: l.id, ref: l.ref, orderId: l.order_id, orderNumber: l.order_no ? `SC-${l.order_no}` : null, gatewayCents: Number(l.gateway_cents), oursCents: l.ours_cents === null ? null : Number(l.ours_cents), state: this.stateOf(l), resolution: l.resolution, note: l.note }));
      return {
        id: s.id, file: s.file_name, importedBy: s.imported_by, importedAt: s.imported_at.toISOString(), completed: !!s.completed_at, completedAt: s.completed_at?.toISOString() ?? null, completedBy: s.completed_by,
        summary: { total: view.length, matched: view.filter((l) => l.state === 'Matched').length, mismatched: view.filter((l) => l.state === 'Mismatch').length, unmatched: view.filter((l) => l.state === 'Unmatched').length, resolved: view.filter((l) => l.state === 'Resolved').length },
        lines: view,
      };
    });
  }

  /** Reads a statement file (a header row with a reference column and an amount column) and matches each line to a paid order. */
  async importStatement(input: z.infer<typeof StatementImportSchema>, actor: Actor) {
    const rows = input.text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    if (rows.length < 2) throw new ValidationError([{ path: ['text'], message: 'The file is empty. It needs a header row and at least one transaction.' }]);
    const head = cells(rows[0]!).map((h) => h.toLowerCase());
    const ri = head.findIndex((h) => h.includes('ref'));
    const ai = head.findIndex((h) => h.includes('amount'));
    if (ri < 0 || ai < 0) throw new ValidationError([{ path: ['text'], message: 'The header row needs a “reference” column and an “amount” column.' }]);
    const parsed: { ref: string; cents: number }[] = [];
    const seen = new Set<string>();
    for (const [i, row] of rows.slice(1).entries()) {
      const cs = cells(row);
      const ref = cs[ri] ?? '';
      const amt = cents(cs[ai] ?? '');
      if (!ref || amt === null) throw new ValidationError([{ path: ['text'], message: `Row ${i + 2} has no valid reference or amount.` }]);
      if (seen.has(ref.toLowerCase())) throw new ValidationError([{ path: ['text'], message: `Row ${i + 2} repeats reference ${ref}.` }]);
      seen.add(ref.toLowerCase());
      parsed.push({ ref, cents: amt });
    }
    if (parsed.length > 20_000) throw new ValidationError([{ path: ['text'], message: 'Import at most 20,000 lines at a time.' }]);
    const id = uuidv7();
    await this.db.tx(async (c) => {
      await c.query('INSERT INTO statements (id, file_name, imported_by) VALUES ($1,$2,$3)', [id, input.file, actor.name ?? 'Staff']);
      const match = new Map((await c.query<{ id: string; ref: string; total_cents: number }>('SELECT id, lower(payment_ref) AS ref, total_cents FROM orders WHERE lower(payment_ref) = ANY($1)', [parsed.map((p) => p.ref.toLowerCase())])).rows.map((o) => [o.ref, o]));
      for (const [i, p] of parsed.entries()) {
        const o = match.get(p.ref.toLowerCase());
        await c.query('INSERT INTO statement_lines (id, statement_id, line_no, ref, gateway_cents, order_id, ours_cents) VALUES ($1,$2,$3,$4,$5,$6,$7)', [uuidv7(), id, i + 1, p.ref, p.cents, o?.id ?? null, o?.total_cents ?? null]);
      }
      await audit(c, actor, 'reconciliation.import', 'statement', id, { file: input.file, lines: parsed.length });
    });
    return (await this.statement(id))!;
  }

  async resolveLine(statementId: string, lineId: string, input: z.infer<typeof ResolveLineSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const s = (await c.query<{ completed_at: Date | null }>('SELECT completed_at FROM statements WHERE id = $1 FOR UPDATE', [statementId])).rows[0];
      if (!s) throw new NotFoundError('Statement');
      if (s.completed_at) throw new ConflictError('STATEMENT_COMPLETED', 'This reconciliation is already complete');
      const l = (await c.query<{ id: string; order_id: string | null; ours_cents: number | null }>('SELECT id, order_id, ours_cents FROM statement_lines WHERE id = $1 AND statement_id = $2 FOR UPDATE', [lineId, statementId])).rows[0];
      if (!l) throw new NotFoundError('Statement line');
      let orderId = l.order_id;
      let ours = l.ours_cents;
      if (input.orderId) {
        const o = (await c.query<{ id: string; total_cents: number }>('SELECT id, total_cents FROM orders WHERE id = $1', [input.orderId])).rows[0];
        if (!o) throw new NotFoundError('Order');
        orderId = o.id; ours = o.total_cents;
      }
      if (input.how === 'matched_manually' && !orderId) throw new UnprocessableError('ORDER_REQUIRED', 'Choose the order this line belongs to');
      await c.query('UPDATE statement_lines SET resolution = $2, note = $3, order_id = $4, ours_cents = $5, resolved_by = $6, resolved_at = now() WHERE id = $1', [lineId, input.how, input.note, orderId, ours, actor.name ?? 'Staff']);
      await audit(c, actor, 'reconciliation.resolve', 'statement', statementId, { lineId, ...input });
    });
    return (await this.statement(statementId))!;
  }

  /** Marks the statement reconciled. Lines still open are listed so the person knows what they are signing off. */
  async completeStatement(statementId: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const s = (await c.query<{ completed_at: Date | null }>('SELECT completed_at FROM statements WHERE id = $1 FOR UPDATE', [statementId])).rows[0];
      if (!s) throw new NotFoundError('Statement');
      if (s.completed_at) return;
      await assertOpen(c);
      await c.query('UPDATE statements SET completed_at = now(), completed_by = $2 WHERE id = $1', [statementId, actor.name ?? 'Staff']);
      await audit(c, actor, 'reconciliation.complete', 'statement', statementId, {});
    });
    return (await this.statement(statementId))!;
  }
}
