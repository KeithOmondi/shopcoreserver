import { z } from 'zod';
import type { Database } from '../../infra/db.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { isUuid, uuidv7 } from '../../infra/uuid.js';
import { audit, type Actor } from '../products/products.js';
import type { RiderContext } from './riders.js';

const uuid = z.string().refine(isUuid, 'must be a UUID');
export const WithdrawSchema = z.strictObject({ amountCents: z.number().int().min(1).max(100_000_000) });
export const PayoutListSchema = z.object({ status: z.enum(['pending', 'paid', 'failed']).optional(), riderId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
export const PayoutPaySchema = z.strictObject({ providerRef: z.string().trim().min(3).max(60) });
export const PayoutFailSchema = z.strictObject({ reason: z.string().trim().min(3).max(200) });
export const DepositSchema = z.strictObject({ amountCents: z.number().int().min(1).max(100_000_000), ref: z.string().trim().min(3).max(60) });
export const AdjustSchema = z.strictObject({ amountCents: z.number().int().refine((n) => n !== 0, 'must be non-zero'), note: z.string().trim().min(3).max(200) });

interface Settings { minWithdrawCents: number; withdrawFeeCents: number }
const DEFAULTS: Settings = { minWithdrawCents: 10_000, withdrawFeeCents: 1_500 };

export class RiderMoneyService {
  constructor(private readonly db: Database) {}

  async settings(): Promise<Settings> {
    return this.db.read(async (c) => {
      const rows = (await c.query<{ key: string; value: number }>(`SELECT key, value FROM settings WHERE key IN ('rider.min_withdraw_cents','rider.withdraw_fee_cents')`)).rows;
      return {
        minWithdrawCents: Number(rows.find((r) => r.key === 'rider.min_withdraw_cents')?.value ?? DEFAULTS.minWithdrawCents),
        withdrawFeeCents: Number(rows.find((r) => r.key === 'rider.withdraw_fee_cents')?.value ?? DEFAULTS.withdrawFeeCents),
      };
    });
  }

  // ---- the rider's own money ------------------------------------------------------------------------------------------

  async mine(rider: RiderContext) {
    const s = await this.settings();
    return this.db.read(async (c) => {
      const t = (await c.query<{ balance: number; today: number; week: number; cash: number }>(
        `SELECT COALESCE(sum(amount_cents),0)::bigint AS balance,
                COALESCE(sum(amount_cents) FILTER (WHERE amount_cents > 0 AND created_at >= date_trunc('day', now())),0)::bigint AS today,
                COALESCE(sum(amount_cents) FILTER (WHERE amount_cents > 0 AND created_at >= date_trunc('week', now())),0)::bigint AS week,
                (SELECT COALESCE(sum(amount_cents),0) FROM rider_cash WHERE rider_id = $1)::bigint AS cash
           FROM rider_ledger WHERE rider_id = $1`, [rider.id])).rows[0]!;
      const entries = (await c.query<{ id: number; kind: string; amount_cents: number; note: string; created_at: Date }>('SELECT id, kind, amount_cents, note, created_at FROM rider_ledger WHERE rider_id = $1 ORDER BY id DESC LIMIT 100', [rider.id])).rows;
      const payouts = (await c.query<{ id: string; payout_no: number; amount_cents: number; fee_cents: number; status: string; requested_at: Date; paid_at: Date | null }>(
        'SELECT id, payout_no, amount_cents, fee_cents, status, requested_at, paid_at FROM payouts WHERE rider_id = $1 ORDER BY requested_at DESC LIMIT 30', [rider.id])).rows;
      return {
        balanceCents: t.balance, todayCents: t.today, weekCents: t.week, cashHeldCents: t.cash, minWithdrawCents: s.minWithdrawCents, withdrawFeeCents: s.withdrawFeeCents,
        entries: entries.map((e) => ({ id: String(e.id), kind: e.kind, amountCents: e.amount_cents, note: e.note, at: e.created_at.toISOString() })),
        payouts: payouts.map((p) => ({ id: p.id, number: `PO-${p.payout_no}`, amountCents: p.amount_cents, feeCents: p.fee_cents, status: p.status, requestedAt: p.requested_at.toISOString(), paidAt: p.paid_at?.toISOString() ?? null })),
      };
    });
  }

  /** Ask to be paid. The money is set aside straight away so it can’t be requested twice. */
  async withdraw(rider: RiderContext, amountCents: number) {
    const s = await this.settings();
    const id = uuidv7();
    await this.db.tx(async (c) => {
      await c.query('SELECT 1 FROM riders WHERE id = $1 FOR UPDATE', [rider.id]);
      if (amountCents < s.minWithdrawCents) throw new UnprocessableError('BELOW_MINIMUM', 'That’s below the minimum you can withdraw', { minCents: s.minWithdrawCents });
      const bal = Number((await c.query<{ b: number }>('SELECT COALESCE(sum(amount_cents),0)::bigint AS b FROM rider_ledger WHERE rider_id = $1', [rider.id])).rows[0]!.b);
      if (amountCents + s.withdrawFeeCents > bal) throw new UnprocessableError('INSUFFICIENT_BALANCE', 'You don’t have enough to withdraw that and cover the fee', { balanceCents: bal, feeCents: s.withdrawFeeCents });
      await c.query('INSERT INTO payouts (id, rider_id, amount_cents, fee_cents, phone) VALUES ($1,$2,$3,$4,$5)', [id, rider.id, amountCents, s.withdrawFeeCents, rider.phone]);
      await c.query(`INSERT INTO rider_ledger (rider_id, kind, amount_cents, payout_id, note) VALUES ($1,'payout',$2,$3,'Withdrawal requested')`, [rider.id, -amountCents, id]);
      if (s.withdrawFeeCents > 0) await c.query(`INSERT INTO rider_ledger (rider_id, kind, amount_cents, payout_id, note) VALUES ($1,'payout_fee',$2,$3,'Withdrawal fee')`, [rider.id, -s.withdrawFeeCents, id]);
    });
    return (await this.mine(rider)).payouts.find((p) => p.id === id)!;
  }

  // ---- finance: payouts ---------------------------------------------------------------------------------------------------

  async payouts(q: z.infer<typeof PayoutListSchema>) {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; payout_no: number; rider_id: string; rider: string; phone: string; amount_cents: number; fee_cents: number; status: string; requested_at: Date; paid_at: Date | null; paid_by: string | null; provider_ref: string | null; failure_reason: string | null }>(
        `SELECT p.*, r.name AS rider FROM payouts p JOIN riders r ON r.id = p.rider_id WHERE ($1::text IS NULL OR p.status = $1) AND ($2::uuid IS NULL OR p.rider_id = $2) ORDER BY (p.status = 'pending') DESC, p.requested_at DESC LIMIT $3`,
        [q.status ?? null, q.riderId ?? null, q.limit]);
      const totals = (await c.query<{ status: string; n: number; total: number }>(`SELECT status, count(*)::int AS n, COALESCE(sum(amount_cents),0)::bigint AS total FROM payouts GROUP BY status`)).rows;
      return {
        items: rows.map((p) => ({ id: p.id, number: `PO-${p.payout_no}`, riderId: p.rider_id, rider: p.rider, phone: p.phone, amountCents: p.amount_cents, feeCents: p.fee_cents, status: p.status, requestedAt: p.requested_at.toISOString(), paidAt: p.paid_at?.toISOString() ?? null, paidBy: p.paid_by, providerRef: p.provider_ref, failureReason: p.failure_reason })),
        totals: Object.fromEntries(totals.map((t) => [t.status, { count: t.n, cents: t.total }])),
      };
    });
  }

  async markPaid(id: string, input: z.infer<typeof PayoutPaySchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const p = (await c.query<{ status: string }>('SELECT status FROM payouts WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) throw new NotFoundError('Payout');
      if (p.status !== 'pending') throw new ConflictError('ALREADY_SETTLED', `This payout is already ${p.status}`);
      await c.query(`UPDATE payouts SET status = 'paid', paid_at = now(), paid_by = $2, provider_ref = $3 WHERE id = $1`, [id, actor.name ?? 'Staff', input.providerRef]);
      await audit(c, actor, 'payout.paid', 'payout', id, input);
    });
    return (await this.payouts({ limit: 200 })).items.find((p) => p.id === id)!;
  }

  /** A payout that didn’t go through: the money goes back to the rider’s balance. */
  async markFailed(id: string, input: z.infer<typeof PayoutFailSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const p = (await c.query<{ status: string; rider_id: string; amount_cents: number; fee_cents: number }>('SELECT status, rider_id, amount_cents, fee_cents FROM payouts WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) throw new NotFoundError('Payout');
      if (p.status !== 'pending') throw new ConflictError('ALREADY_SETTLED', `This payout is already ${p.status}`);
      await c.query(`UPDATE payouts SET status = 'failed', failure_reason = $2 WHERE id = $1`, [id, input.reason]);
      await c.query(`INSERT INTO rider_ledger (rider_id, kind, amount_cents, payout_id, note, by_name) VALUES ($1,'payout_reversal',$2,$3,$4,$5)`, [p.rider_id, p.amount_cents + p.fee_cents, id, `Payout failed: ${input.reason}`, actor.name ?? 'Staff']);
      await audit(c, actor, 'payout.failed', 'payout', id, input);
    });
    return (await this.payouts({ limit: 200 })).items.find((p) => p.id === id)!;
  }

  async adjust(riderId: string, input: z.infer<typeof AdjustSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      await c.query('SELECT 1 FROM riders WHERE id = $1 FOR UPDATE', [riderId]);
      const bal = Number((await c.query<{ b: number }>('SELECT COALESCE(sum(amount_cents),0)::bigint AS b FROM rider_ledger WHERE rider_id = $1', [riderId])).rows[0]!.b);
      if (!(await c.query('SELECT 1 FROM riders WHERE id = $1', [riderId])).rowCount) throw new NotFoundError('Rider');
      if (bal + input.amountCents < 0) throw new UnprocessableError('NEGATIVE_BALANCE', 'That would take the rider’s balance below zero');
      await c.query(`INSERT INTO rider_ledger (rider_id, kind, amount_cents, note, by_name) VALUES ($1,'adjustment',$2,$3,$4)`, [riderId, input.amountCents, input.note, actor.name ?? 'Staff']);
      await audit(c, actor, 'rider.adjustment', 'rider', riderId, input);
    });
  }

  async ledger(riderId: string) {
    return this.db.read(async (c) => ({ items: (await c.query<{ id: number; kind: string; amount_cents: number; note: string; by_name: string; created_at: Date }>(
      'SELECT id, kind, amount_cents, note, by_name, created_at FROM rider_ledger WHERE rider_id = $1 ORDER BY id DESC LIMIT 200', [riderId])).rows
      .map((e) => ({ id: String(e.id), kind: e.kind, amountCents: e.amount_cents, note: e.note, by: e.by_name, at: e.created_at.toISOString() })) }));
  }

  // ---- finance: cash on delivery held by riders ---------------------------------------------------------------------------------

  async cash() {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ rider_id: string; rider: string; phone: string; held: number; oldest: Date | null; orders: number }>(
        `SELECT r.id AS rider_id, r.name AS rider, r.phone, COALESCE(sum(rc.amount_cents),0)::bigint AS held,
                (SELECT min(created_at) FROM rider_cash x WHERE x.rider_id = r.id AND x.kind = 'collected' AND x.created_at > COALESCE((SELECT max(created_at) FROM rider_cash d WHERE d.rider_id = r.id AND d.kind = 'deposit'), 'epoch')) AS oldest,
                count(rc.id) FILTER (WHERE rc.kind = 'collected')::int AS orders
           FROM riders r JOIN rider_cash rc ON rc.rider_id = r.id GROUP BY r.id HAVING COALESCE(sum(rc.amount_cents),0) > 0 ORDER BY held DESC`);
      const recent = (await c.query<{ id: number; rider: string; amount_cents: number; ref: string; by_name: string; created_at: Date }>(
        `SELECT rc.id, r.name AS rider, rc.amount_cents, rc.ref, rc.by_name, rc.created_at FROM rider_cash rc JOIN riders r ON r.id = rc.rider_id WHERE rc.kind = 'deposit' ORDER BY rc.id DESC LIMIT 50`)).rows;
      return {
        owed: rows.map((r) => ({ riderId: r.rider_id, rider: r.rider, phone: r.phone, heldCents: Number(r.held), since: r.oldest?.toISOString() ?? null })),
        totalHeldCents: rows.reduce((n, r) => n + Number(r.held), 0),
        deposits: recent.map((d) => ({ id: String(d.id), rider: d.rider, amountCents: -d.amount_cents, ref: d.ref, receivedBy: d.by_name, at: d.created_at.toISOString() })),
      };
    });
  }

  /** The rider handed cash in (or paid it by M-Pesa to the till). Can’t take in more than they hold. */
  async receiveDeposit(riderId: string, input: z.infer<typeof DepositSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM riders WHERE id = $1 FOR UPDATE', [riderId])).rowCount) throw new NotFoundError('Rider');
      const held = Number((await c.query<{ h: number }>('SELECT COALESCE(sum(amount_cents),0)::bigint AS h FROM rider_cash WHERE rider_id = $1', [riderId])).rows[0]!.h);
      if (input.amountCents > held) throw new UnprocessableError('MORE_THAN_HELD', 'That’s more than this rider is holding', { heldCents: held });
      await c.query(`INSERT INTO rider_cash (rider_id, kind, amount_cents, ref, by_name) VALUES ($1,'deposit',$2,$3,$4)`, [riderId, -input.amountCents, input.ref, actor.name ?? 'Staff']);
      await audit(c, actor, 'cash.deposit', 'rider', riderId, input);
    });
    return this.cash();
  }
}
