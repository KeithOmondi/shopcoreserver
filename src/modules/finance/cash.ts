import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { audit, type Actor } from '../products/products.js';
import { codOwed, settlePayoutFailed, settlePayoutPaid } from '../dispatch/money.js';
import { assertOpen, financeSettings, monthOf } from './common.js';

export interface FinanceActor extends Actor { name: string; isOwner: boolean }

const uuid = z.string().uuid();
export const NewBatchSchema = z.strictObject({ payoutIds: z.array(uuid).min(1).max(500), note: z.string().trim().max(500).default('') });
export const BatchPatchSchema = z.strictObject({ payoutIds: z.array(uuid).min(1).max(500).optional(), note: z.string().trim().max(500).optional() })
  .refine((o) => o.payoutIds !== undefined || o.note !== undefined, 'nothing to change');
export const SettlementPaySchema = z.strictObject({ ref: z.string().trim().min(3).max(80) });

/** Sends money to riders. M-Pesa business payments are connected in the wire-up phase; a development sender stands in until then. */
export interface PayoutGateway {
  /** False when no real money can move (so a batch can't be marked as sent). */
  readonly connected: boolean;
  send(p: { payoutId: string; phone: string; amountCents: number }): Promise<{ ok: true; providerRef: string } | { ok: false; reason: string }>;
}
/** Development only: every send works, except to numbers ending in 0, so the failure path can be seen. */
export const devPayoutGateway: PayoutGateway = {
  connected: true,
  async send(p) {
    return p.phone.replace(/\D/g, '').endsWith('0') ? { ok: false, reason: 'M-Pesa could not reach this number' } : { ok: true, providerRef: `DEV${p.payoutId.replace(/-/g, '').slice(-10).toUpperCase()}` };
  },
};

/** Used where the development sender must never run: nothing is sent, and batches can't be approved until a real sender is connected. */
export const unconnectedPayouts: PayoutGateway = {
  connected: false,
  async send() { return { ok: false, reason: 'Payouts to M-Pesa are not connected' }; },
};

export class CashService {
  constructor(private readonly db: Database, private readonly sender: PayoutGateway = devPayoutGateway) {}

  /** Cash riders are holding, and how many are past the hand-in window. */
  async cashSummary(c?: Queryable) {
    const run = async (q: Queryable) => {
      const owed = await codOwed(q, (await financeSettings(q)).codWindowHours);
      return { heldCents: owed.reduce((n, o) => n + o.heldCents, 0), overdueRiders: owed.filter((o) => o.overdue).length, owed };
    };
    return c ? run(c) : this.db.read(run);
  }

  // ---- payout batches ---------------------------------------------------------------------------------------------------------------

  async batches() {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; batch_no: number; status: string; note: string; created_by: string; created_at: Date; approved_by: string | null; sent_at: Date | null; n: number; total: number; failed: number }>(
        `SELECT b.id, b.batch_no, b.status, b.note, b.created_by, b.created_at, b.approved_by, b.sent_at, count(i.payout_id)::int AS n, COALESCE(sum(p.amount_cents),0)::bigint AS total,
                count(i.payout_id) FILTER (WHERE i.outcome = 'failed')::int AS failed
           FROM payout_batches b LEFT JOIN payout_batch_items i ON i.batch_id = b.id LEFT JOIN payouts p ON p.id = i.payout_id GROUP BY b.id ORDER BY b.created_at DESC LIMIT 100`);
      return { items: rows.map((b) => ({ id: b.id, number: `PB-${b.batch_no}`, status: b.status, note: b.note, createdBy: b.created_by, createdAt: b.created_at.toISOString(), approvedBy: b.approved_by, sentAt: b.sent_at?.toISOString() ?? null, payouts: b.n, totalCents: Number(b.total), failed: b.failed })) };
    });
  }

  async batch(id: string) {
    return this.db.read(async (c) => {
      const b = (await c.query<{ id: string; batch_no: number; status: string; note: string; created_by_id: string; created_by: string; created_at: Date; approved_by: string | null; sent_at: Date | null }>('SELECT * FROM payout_batches WHERE id = $1', [id])).rows[0];
      if (!b) throw new NotFoundError('Payout batch');
      const items = (await c.query<{ payout_id: string; payout_no: number; rider: string; phone: string; amount_cents: number; fee_cents: number; status: string; outcome: string | null; provider_ref: string | null; failure_reason: string | null }>(
        `SELECT i.payout_id, p.payout_no, r.name AS rider, p.phone, p.amount_cents, p.fee_cents, p.status, i.outcome, p.provider_ref, p.failure_reason
           FROM payout_batch_items i JOIN payouts p ON p.id = i.payout_id JOIN riders r ON r.id = p.rider_id WHERE i.batch_id = $1 ORDER BY p.payout_no`, [id])).rows;
      return {
        id: b.id, number: `PB-${b.batch_no}`, status: b.status, note: b.note, createdBy: b.created_by, createdById: b.created_by_id, createdAt: b.created_at.toISOString(), approvedBy: b.approved_by, sentAt: b.sent_at?.toISOString() ?? null,
        totalCents: items.reduce((n, i) => n + Number(i.amount_cents), 0),
        items: items.map((i) => ({ payoutId: i.payout_id, number: `PO-${i.payout_no}`, rider: i.rider, phone: i.phone, amountCents: Number(i.amount_cents), feeCents: Number(i.fee_cents), status: i.status, outcome: i.outcome, providerRef: i.provider_ref, failureReason: i.failure_reason })),
      };
    });
  }

  async createBatch(input: z.infer<typeof NewBatchSchema>, actor: FinanceActor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      await assertOpen(c);
      const ids = [...new Set(input.payoutIds)];
      const ok = (await c.query<{ id: string }>(`SELECT p.id FROM payouts p WHERE p.id = ANY($1) AND p.status = 'pending' AND NOT EXISTS (SELECT 1 FROM payout_batch_items i WHERE i.payout_id = p.id) FOR UPDATE OF p`, [ids])).rows.map((r) => r.id);
      if (ok.length !== ids.length) throw new UnprocessableError('PAYOUTS_UNAVAILABLE', 'Some of those payouts are already paid, failed or in another batch', { available: ok.length, requested: ids.length });
      await c.query('INSERT INTO payout_batches (id, note, created_by_id, created_by) VALUES ($1,$2,$3,$4)', [id, input.note, actor.id, actor.name]);
      for (const p of ok) await c.query('INSERT INTO payout_batch_items (batch_id, payout_id) VALUES ($1,$2)', [id, p]);
      await audit(c, actor, 'payout_batch.create', 'payout_batch', id, { payouts: ok.length });
    });
    return this.batch(id);
  }

  async updateBatch(id: string, input: z.infer<typeof BatchPatchSchema>, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const b = (await c.query<{ status: string }>('SELECT status FROM payout_batches WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!b) throw new NotFoundError('Payout batch');
      if (b.status !== 'draft') throw new ConflictError('BATCH_SENT', 'This batch has already been sent');
      if (input.note !== undefined) await c.query('UPDATE payout_batches SET note = $2 WHERE id = $1', [id, input.note]);
      if (input.payoutIds) {
        const want = [...new Set(input.payoutIds)];
        await c.query('DELETE FROM payout_batch_items WHERE batch_id = $1 AND payout_id <> ALL($2)', [id, want]);
        const have = new Set((await c.query<{ payout_id: string }>('SELECT payout_id FROM payout_batch_items WHERE batch_id = $1', [id])).rows.map((r) => r.payout_id));
        const add = want.filter((p) => !have.has(p));
        if (add.length) {
          const ok = (await c.query<{ id: string }>(`SELECT p.id FROM payouts p WHERE p.id = ANY($1) AND p.status = 'pending' AND NOT EXISTS (SELECT 1 FROM payout_batch_items i WHERE i.payout_id = p.id) FOR UPDATE OF p`, [add])).rows.map((r) => r.id);
          if (ok.length !== add.length) throw new UnprocessableError('PAYOUTS_UNAVAILABLE', 'Some of those payouts are already paid, failed or in another batch');
          for (const p of ok) await c.query('INSERT INTO payout_batch_items (batch_id, payout_id) VALUES ($1,$2)', [id, p]);
        }
      }
      await audit(c, actor, 'payout_batch.update', 'payout_batch', id, input);
    });
    return this.batch(id);
  }

  async deleteBatch(id: string, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const b = (await c.query<{ status: string }>('SELECT status FROM payout_batches WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!b) throw new NotFoundError('Payout batch');
      if (b.status !== 'draft') throw new ConflictError('BATCH_SENT', 'A sent batch can’t be deleted');
      await c.query('DELETE FROM payout_batches WHERE id = $1', [id]);
      await audit(c, actor, 'payout_batch.delete', 'payout_batch', id, {});
    });
  }

  /**
   * Approve and send. Someone other than the preparer must approve (an owner may do both). Sending can be repeated safely:
   * a payout that already has an outcome is skipped, so a crash half-way through is finished by sending again.
   */
  async sendBatch(id: string, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const b = (await c.query<{ status: string; created_by_id: string; created_by: string }>('SELECT status, created_by_id, created_by FROM payout_batches WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!b) throw new NotFoundError('Payout batch');
      if (b.status === 'sent') return;
      if (!this.sender.connected) throw new UnprocessableError('PAYOUTS_NOT_CONNECTED', 'Sending money to riders isn’t connected yet. Pay them from the M-Pesa portal and mark each payout as paid');
      if (b.created_by_id === actor.id && !actor.isOwner) throw new ForbiddenError(`${b.created_by} prepared this batch, so someone else must approve it`);
      if (!(await c.query('SELECT 1 FROM payout_batch_items WHERE batch_id = $1', [id])).rowCount) throw new UnprocessableError('EMPTY_BATCH', 'Select at least one rider');
      await assertOpen(c);
      await c.query(`UPDATE payout_batches SET status = 'sent', approved_by_id = $2, approved_by = $3, sent_at = now() WHERE id = $1`, [id, actor.id, actor.name]);
      await audit(c, actor, 'payout_batch.approve', 'payout_batch', id, { selfApproved: b.created_by_id === actor.id });
    });
    const todo = (await this.db.read((c) => c.query<{ payout_id: string; phone: string; amount_cents: number }>(
      `SELECT i.payout_id, p.phone, p.amount_cents FROM payout_batch_items i JOIN payouts p ON p.id = i.payout_id WHERE i.batch_id = $1 AND i.outcome IS NULL ORDER BY p.payout_no`, [id]))).rows;
    for (const p of todo) {
      const r = await this.sender.send({ payoutId: p.payout_id, phone: p.phone, amountCents: Number(p.amount_cents) });
      await this.db.tx(async (c) => {
        const st = (await c.query<{ status: string }>('SELECT status FROM payouts WHERE id = $1', [p.payout_id])).rows[0]?.status;
        // Someone may have settled it by hand meanwhile; record what happened and move on.
        if (st === 'pending') {
          if (r.ok) await settlePayoutPaid(c, p.payout_id, r.providerRef, actor);
          else await settlePayoutFailed(c, p.payout_id, r.reason, actor);
        }
        await c.query('UPDATE payout_batch_items SET outcome = $3 WHERE batch_id = $1 AND payout_id = $2', [id, p.payout_id, st === 'pending' ? (r.ok ? 'paid' : 'failed') : st === 'paid' ? 'paid' : 'failed']);
      });
    }
    return this.batch(id);
  }

  // ---- store settlements -----------------------------------------------------------------------------------------------------------------

  /** What is owed to each place stock is collected from, per month, after our commission. Worked out from delivered orders. */
  async settlements() {
    return this.db.read(async (c) => {
      const s = await financeSettings(c);
      const { rows } = await c.query<{ location_id: string | null; store: string; month: string; sales: number; orders: number }>(
        `SELECT d.pickup_location_id AS location_id, COALESCE(l.name, 'Main warehouse') AS store, ${monthOf('d.delivered_at')} AS month,
                COALESCE(sum(o.subtotal_cents - LEAST(o.refunded_cents, o.subtotal_cents)),0)::bigint AS sales, count(*)::int AS orders
           FROM deliveries d JOIN orders o ON o.id = d.order_id LEFT JOIN locations l ON l.id = d.pickup_location_id
          WHERE d.status = 'delivered' AND d.delivered_at IS NOT NULL GROUP BY d.pickup_location_id, l.name, ${monthOf('d.delivered_at')}`);
      const paid = new Map((await c.query<{ id: string; paid_at: Date; paid_ref: string; paid_by: string }>('SELECT id, paid_at, paid_ref, paid_by FROM settlements WHERE paid_at IS NOT NULL')).rows.map((p) => [p.id, p]));
      const items = rows.map((r) => {
        const id = settlementId(r.month, r.store, r.location_id);
        const sales = Number(r.sales);
        const commission = Math.round((sales * s.storeCommission) / 100);
        const p = paid.get(id);
        return { id, store: r.store, month: r.month, orders: r.orders, salesCents: sales, commissionCents: commission, netCents: sales - commission, commissionRate: s.storeCommission, paid: p ? { at: p.paid_at.toISOString(), ref: p.paid_ref, by: p.paid_by } : null, locationId: r.location_id };
      }).sort((a, b) => b.month.localeCompare(a.month) || a.store.localeCompare(b.store));
      return { items, payableCents: items.filter((i) => !i.paid).reduce((n, i) => n + i.netCents, 0) };
    });
  }

  async paySettlement(id: string, input: z.infer<typeof SettlementPaySchema>, actor: FinanceActor) {
    const all = await this.settlements();
    const s = all.items.find((x) => x.id === id);
    if (!s) throw new NotFoundError('Settlement');
    await this.db.tx(async (c) => {
      await assertOpen(c);
      await c.query('INSERT INTO settlements (id, location_id, month) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [id, s.locationId, s.month]);
      const row = (await c.query<{ paid_at: Date | null }>('SELECT paid_at FROM settlements WHERE id = $1 FOR UPDATE', [id])).rows[0]!;
      if (row.paid_at) throw new ConflictError('ALREADY_PAID', 'This settlement has already been paid');
      await c.query('UPDATE settlements SET paid_at = now(), paid_ref = $2, paid_by = $3 WHERE id = $1', [id, input.ref, actor.name]);
      await audit(c, actor, 'settlement.paid', 'settlement', id, { ...input, netCents: s.netCents });
    });
    return (await this.settlements()).items.find((x) => x.id === id)!;
  }
}

function settlementId(month: string, store: string, locationId: string | null) {
  const prefix = store.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'STORE';
  return `ST-${month.replace('-', '')}-${prefix}${locationId ? `-${locationId.replace(/-/g, '').slice(-4).toUpperCase()}` : ''}`;
}
