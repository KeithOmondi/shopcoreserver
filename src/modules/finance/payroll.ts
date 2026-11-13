import { z } from 'zod';
import type { Database } from '../../infra/db.js';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { audit } from '../products/products.js';
import { patchOf } from '../../http/validate.js';
import { assertOpen, currentMonth, Money, MonthSchema, shiftMonth } from './common.js';
import type { FinanceActor } from './cash.js';
import { calcSlip, STATUTORY_DEFAULTS, StatutorySchema, type Statutory } from './payslip.js';

export const ProfileSchema = z.strictObject({
  basicCents: Money.default(0), houseCents: Money.default(0), transportCents: Money.default(0),
  kraPin: z.string().trim().toUpperCase().max(20).default(''), nssfNo: z.string().trim().max(30).default(''), shaNo: z.string().trim().max(30).default(''),
  payTo: z.string().trim().max(120).default(''), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
});
export const ProfilePatchSchema = patchOf(ProfileSchema);
export const NewRunSchema = z.strictObject({ month: MonthSchema });
export const AdjustSchema = z.strictObject({ bonusCents: Money.default(0), otherDeductionCents: Money.default(0), note: z.string().trim().max(200).default('') });
export const RunActionSchema = z.strictObject({ action: z.enum(['submit', 'return', 'approve', 'pay']) });
export const RemitSchema = z.strictObject({ kind: z.enum(['PAYE', 'NSSF', 'SHIF', 'Housing levy']), ref: z.string().trim().min(3).max(80) });
export const StatutoryBody = StatutorySchema;

export const REMIT_KINDS = ['PAYE', 'NSSF', 'SHIF', 'Housing levy'] as const;
type RemitKind = (typeof REMIT_KINDS)[number];
const REMIT_TO: Record<RemitKind, string> = { PAYE: 'KRA', NSSF: 'NSSF', SHIF: 'SHA', 'Housing levy': 'KRA (Affordable Housing Levy)' };
/** The day of the following month each payment is due. */
const REMIT_DAY: Record<RemitKind, number> = { PAYE: 9, NSSF: 15, SHIF: 9, 'Housing levy': 9 };

interface LineRow {
  staff_id: string; name: string; role: string; bonus_cents: number; other_deduction_cents: number; note: string; basic_cents: number; allowances_cents: number; gross_cents: number;
  nssf_cents: number; shif_cents: number; housing_cents: number; taxable_cents: number; paye_cents: number; net_cents: number; pay_to: string;
}
const lineView = (l: LineRow) => ({
  staffId: l.staff_id, name: l.name, role: l.role, note: l.note, payTo: l.pay_to,
  adjust: { bonusCents: Number(l.bonus_cents), otherDeductionCents: Number(l.other_deduction_cents) },
  slip: { basicCents: Number(l.basic_cents), allowancesCents: Number(l.allowances_cents), bonusCents: Number(l.bonus_cents), grossCents: Number(l.gross_cents), nssfCents: Number(l.nssf_cents), shifCents: Number(l.shif_cents), housingCents: Number(l.housing_cents), taxableCents: Number(l.taxable_cents), payeCents: Number(l.paye_cents), otherDeductionCents: Number(l.other_deduction_cents), netCents: Number(l.net_cents), employerNssfCents: Number(l.nssf_cents), employerHousingCents: Number(l.housing_cents) },
});
const sum = (ls: ReturnType<typeof lineView>[], f: (s: ReturnType<typeof lineView>['slip']) => number) => ls.reduce((n, l) => n + f(l.slip), 0);
const totalsOf = (ls: ReturnType<typeof lineView>[]) => ({
  grossCents: sum(ls, (s) => s.grossCents), netCents: sum(ls, (s) => s.netCents), payeCents: sum(ls, (s) => s.payeCents),
  nssfCents: sum(ls, (s) => s.nssfCents * 2), shifCents: sum(ls, (s) => s.shifCents), housingCents: sum(ls, (s) => s.housingCents * 2),
  employerCostCents: sum(ls, (s) => s.grossCents + s.employerNssfCents + s.employerHousingCents),
});
const STATUS: Record<string, string> = { draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved', paid: 'Paid' };

export class PayrollService {
  constructor(private readonly db: Database) {}

  // ---- rates and pay profiles ---------------------------------------------------------------------------------------------------------

  async statutory(): Promise<Statutory> {
    return this.db.read(async (c) => {
      const r = (await c.query<{ value: Statutory }>(`SELECT value FROM settings WHERE key = 'payroll.statutory'`)).rows[0];
      return r?.value ?? STATUTORY_DEFAULTS;
    });
  }

  async saveStatutory(input: Statutory, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO settings (key, value, updated_by) VALUES ('payroll.statutory', $1, $2) ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`, [JSON.stringify(input), actor.id]);
      await audit(c, actor, 'payroll.statutory', 'setting', 'payroll.statutory', input);
    });
    return input;
  }

  /** Everyone on staff with their pay profile (blank if none has been set yet). */
  async profiles() {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; name: string; role: string; status: string; basic_cents: number | null; house_cents: number | null; transport_cents: number | null; kra_pin: string | null; nssf_no: string | null; sha_no: string | null; pay_to: string | null; start_date: string | null }>(
        `SELECT s.id, s.name, s.role, s.status, p.basic_cents, p.house_cents, p.transport_cents, p.kra_pin, p.nssf_no, p.sha_no, p.pay_to, to_char(p.start_date, 'YYYY-MM-DD') AS start_date
           FROM staff s LEFT JOIN employee_pay p ON p.staff_id = s.id ORDER BY s.name`);
      return { items: rows.map((r) => ({ staffId: r.id, name: r.name, role: r.role, status: r.status, basicCents: Number(r.basic_cents ?? 0), houseCents: Number(r.house_cents ?? 0), transportCents: Number(r.transport_cents ?? 0), kraPin: r.kra_pin ?? '', nssfNo: r.nssf_no ?? '', shaNo: r.sha_no ?? '', payTo: r.pay_to ?? '', startDate: r.start_date, hasProfile: r.basic_cents !== null })) };
    });
  }

  async saveProfile(staffId: string, patch: z.infer<typeof ProfilePatchSchema>, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM staff WHERE id = $1', [staffId])).rowCount) throw new NotFoundError('Staff member');
      const cur = (await c.query<{ basic_cents: number; house_cents: number; transport_cents: number; kra_pin: string; nssf_no: string; sha_no: string; pay_to: string; start_date: string | null }>(
        `SELECT basic_cents, house_cents, transport_cents, kra_pin, nssf_no, sha_no, pay_to, to_char(start_date, 'YYYY-MM-DD') AS start_date FROM employee_pay WHERE staff_id = $1 FOR UPDATE`, [staffId])).rows[0];
      const m = { basicCents: Number(cur?.basic_cents ?? 0), houseCents: Number(cur?.house_cents ?? 0), transportCents: Number(cur?.transport_cents ?? 0), kraPin: cur?.kra_pin ?? '', nssfNo: cur?.nssf_no ?? '', shaNo: cur?.sha_no ?? '', payTo: cur?.pay_to ?? '', startDate: cur?.start_date ?? null, ...patch };
      await c.query(
        `INSERT INTO employee_pay (staff_id, basic_cents, house_cents, transport_cents, kra_pin, nssf_no, sha_no, pay_to, start_date, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (staff_id) DO UPDATE SET basic_cents = $2, house_cents = $3, transport_cents = $4, kra_pin = $5, nssf_no = $6, sha_no = $7, pay_to = $8, start_date = $9, updated_by = $10, updated_at = now()`,
        [staffId, m.basicCents, m.houseCents, m.transportCents, m.kraPin, m.nssfNo, m.shaNo, m.payTo, m.startDate, actor.name]);
      // Salary figures are not written to the log; only what kind of change happened.
      await audit(c, actor, 'payroll.profile', 'staff', staffId, { fields: Object.keys(patch) });
    });
    return (await this.profiles()).items.find((p) => p.staffId === staffId)!;
  }

  // ---- runs -----------------------------------------------------------------------------------------------------------------------------------

  async runs() {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; month: string; status: string; prepared_by: string; approved_by: string | null; submitted_at: Date | null; approved_at: Date | null; paid_at: Date | null; n: number; gross: number; net: number }>(
        `SELECT r.id, r.month, r.status, r.prepared_by, r.approved_by, r.submitted_at, r.approved_at, r.paid_at, count(l.staff_id)::int AS n, COALESCE(sum(l.gross_cents),0)::bigint AS gross, COALESCE(sum(l.net_cents),0)::bigint AS net
           FROM payroll_runs r LEFT JOIN payroll_lines l ON l.run_id = r.id GROUP BY r.id ORDER BY r.month DESC`);
      return { items: rows.map((r) => ({ id: r.id, month: r.month, status: STATUS[r.status], state: r.status, preparedBy: r.prepared_by, approvedBy: r.approved_by, submittedAt: r.submitted_at?.toISOString() ?? null, approvedAt: r.approved_at?.toISOString() ?? null, paidAt: r.paid_at?.toISOString() ?? null, people: r.n, grossCents: Number(r.gross), netCents: Number(r.net) })) };
    });
  }

  async run(id: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<{ id: string; month: string; status: string; prepared_by_id: string; prepared_by: string; created_at: Date; submitted_at: Date | null; approved_by: string | null; approved_at: Date | null; paid_at: Date | null; paid_by: string | null; version: number }>('SELECT * FROM payroll_runs WHERE id = $1', [id])).rows[0];
      if (!r) throw new NotFoundError('Payroll run');
      const lines = (await c.query<LineRow>('SELECT * FROM payroll_lines WHERE run_id = $1 ORDER BY name', [id])).rows.map(lineView);
      const rem = (await c.query<{ kind: RemitKind; ref: string; paid_at: Date; by_name: string }>('SELECT kind, ref, paid_at, by_name FROM payroll_remittances WHERE run_id = $1', [id])).rows;
      const totals = totalsOf(lines);
      const amount: Record<RemitKind, number> = { PAYE: totals.payeCents, NSSF: totals.nssfCents, SHIF: totals.shifCents, 'Housing levy': totals.housingCents };
      return {
        id: r.id, month: r.month, status: STATUS[r.status], state: r.status, preparedBy: r.prepared_by, preparedById: r.prepared_by_id, createdAt: r.created_at.toISOString(), submittedAt: r.submitted_at?.toISOString() ?? null,
        approvedBy: r.approved_by, approvedAt: r.approved_at?.toISOString() ?? null, paidAt: r.paid_at?.toISOString() ?? null, paidBy: r.paid_by, version: r.version, lines, totals,
        remittances: REMIT_KINDS.map((k) => {
          const p = rem.find((x) => x.kind === k);
          const [y, m] = shiftMonth(r.month, 1).split('-').map(Number) as [number, number];
          return { kind: k, to: REMIT_TO[k], amountCents: amount[k], dueAt: new Date(Date.UTC(y, m - 1, REMIT_DAY[k], 20, 59)).toISOString(), paid: p ? { ref: p.ref, at: p.paid_at.toISOString(), by: p.by_name } : null };
        }),
      };
    });
  }

  /** Works out every active person’s pay for the month from their profile and the rates in force. */
  async prepare(month: string, actor: FinanceActor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      if (month > currentMonth()) throw new UnprocessableError('FUTURE_MONTH', 'You can’t run payroll for a month that hasn’t started');
      if ((await c.query('SELECT 1 FROM payroll_runs WHERE month = $1', [month])).rowCount) throw new ConflictError('RUN_EXISTS', `A payroll run for ${month} already exists`);
      await assertOpen(c, `${month}-15T12:00:00+03:00`);
      const st = ((await c.query<{ value: Statutory }>(`SELECT value FROM settings WHERE key = 'payroll.statutory'`)).rows[0]?.value) ?? STATUTORY_DEFAULTS;
      const people = (await c.query<{ id: string; name: string; role: string; basic_cents: number; house_cents: number; transport_cents: number; pay_to: string }>(
        `SELECT s.id, s.name, s.role, p.basic_cents, p.house_cents, p.transport_cents, p.pay_to FROM staff s JOIN employee_pay p ON p.staff_id = s.id WHERE s.status = 'active' AND p.basic_cents > 0 ORDER BY s.name`)).rows;
      if (!people.length) throw new UnprocessableError('NO_PROFILES', 'No active staff have a pay profile yet');
      await c.query('INSERT INTO payroll_runs (id, month, prepared_by_id, prepared_by, statutory) VALUES ($1,$2,$3,$4,$5)', [id, month, actor.id, actor.name, JSON.stringify(st)]);
      for (const p of people) await this.writeLine(c, id, p.id, p.name, p.role, p.pay_to, { basicCents: Number(p.basic_cents), houseCents: Number(p.house_cents), transportCents: Number(p.transport_cents) }, st, { bonusCents: 0, otherDeductionCents: 0 }, '');
      await audit(c, actor, 'payroll.prepare', 'payroll_run', id, { month, people: people.length });
    });
    return this.run(id);
  }

  private async writeLine(c: { query: Parameters<typeof assertOpen>[0]['query'] }, runId: string, staffId: string, name: string, role: string, payTo: string, p: { basicCents: number; houseCents: number; transportCents: number }, st: Statutory, adj: { bonusCents: number; otherDeductionCents: number }, note: string) {
    const s = calcSlip(p, st, adj);
    await c.query(
      `INSERT INTO payroll_lines (run_id, staff_id, name, role, bonus_cents, other_deduction_cents, note, basic_cents, allowances_cents, gross_cents, nssf_cents, shif_cents, housing_cents, taxable_cents, paye_cents, net_cents, pay_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (run_id, staff_id) DO UPDATE SET bonus_cents = $5, other_deduction_cents = $6, note = $7, gross_cents = $10, nssf_cents = $11, shif_cents = $12, housing_cents = $13, taxable_cents = $14, paye_cents = $15, net_cents = $16`,
      [runId, staffId, name, role, adj.bonusCents, adj.otherDeductionCents, note, s.basicCents, s.allowancesCents, s.grossCents, s.nssfCents, s.shifCents, s.housingCents, s.taxableCents, s.payeCents, s.netCents, payTo]);
    return s;
  }

  async adjust(runId: string, staffId: string, input: z.infer<typeof AdjustSchema>, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ status: string; statutory: Statutory }>('SELECT status, statutory FROM payroll_runs WHERE id = $1 FOR UPDATE', [runId])).rows[0];
      if (!r) throw new NotFoundError('Payroll run');
      if (r.status !== 'draft') throw new ConflictError('RUN_LOCKED', 'Only a draft can be changed. Return it for changes first');
      const l = (await c.query<LineRow>('SELECT * FROM payroll_lines WHERE run_id = $1 AND staff_id = $2 FOR UPDATE', [runId, staffId])).rows[0];
      if (!l) throw new NotFoundError('Payslip');
      const s = calcSlip({ basicCents: Number(l.basic_cents), houseCents: Number(l.allowances_cents), transportCents: 0 }, r.statutory, input);
      if (s.netCents < 0) throw new UnprocessableError('NEGATIVE_PAY', 'Those deductions are more than the pay');
      await this.writeLine(c, runId, staffId, l.name, l.role, l.pay_to, { basicCents: Number(l.basic_cents), houseCents: Number(l.allowances_cents), transportCents: 0 }, r.statutory, input, input.note);
      await audit(c, actor, 'payroll.adjust', 'payroll_run', runId, { staffId, bonusCents: input.bonusCents, otherDeductionCents: input.otherDeductionCents });
    });
    return this.run(runId);
  }

  /**
   * Draft → submitted → approved → paid. Approval is the owner’s alone, and never by the person who prepared the run
   * (unlike other approvals there is no owner exception: payroll is the one place nobody signs off their own work).
   */
  async act(runId: string, action: z.infer<typeof RunActionSchema>['action'], actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ status: string; prepared_by_id: string; month: string }>('SELECT status, prepared_by_id, month FROM payroll_runs WHERE id = $1 FOR UPDATE', [runId])).rows[0];
      if (!r) throw new NotFoundError('Payroll run');
      const need = (s: string, msg: string) => { if (r.status !== s) throw new ConflictError('WRONG_STATE', msg); };
      if (action === 'submit') { need('draft', 'Only a draft can be submitted'); await c.query(`UPDATE payroll_runs SET status = 'pending_approval', submitted_at = now(), version = version + 1 WHERE id = $1`, [runId]); }
      else if (action === 'return') { need('pending_approval', 'Nothing to return'); await c.query(`UPDATE payroll_runs SET status = 'draft', submitted_at = NULL, version = version + 1 WHERE id = $1`, [runId]); }
      else if (action === 'approve') {
        need('pending_approval', 'This run isn’t waiting for approval');
        if (!actor.isOwner) throw new ForbiddenError('Only an owner can approve payroll');
        if (r.prepared_by_id === actor.id) throw new ForbiddenError('You prepared this run, so someone else must approve it');
        await c.query(`UPDATE payroll_runs SET status = 'approved', approved_by_id = $2, approved_by = $3, approved_at = now(), version = version + 1 WHERE id = $1`, [runId, actor.id, actor.name]);
      } else {
        need('approved', 'Approve the run before paying it');
        await assertOpen(c);
        await c.query(`UPDATE payroll_runs SET status = 'paid', paid_at = now(), paid_by = $2, version = version + 1 WHERE id = $1`, [runId, actor.name]);
      }
      await audit(c, actor, `payroll.${action}`, 'payroll_run', runId, { month: r.month });
    });
    return this.run(runId);
  }

  async payslip(runId: string, staffId: string) {
    const run = await this.run(runId);
    const line = run.lines.find((l) => l.staffId === staffId);
    if (!line) throw new NotFoundError('Payslip');
    return { runId, month: run.month, status: run.status, ...line };
  }

  async remit(runId: string, input: z.infer<typeof RemitSchema>, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ status: string }>('SELECT status FROM payroll_runs WHERE id = $1 FOR UPDATE', [runId])).rows[0];
      if (!r) throw new NotFoundError('Payroll run');
      if (r.status !== 'approved' && r.status !== 'paid') throw new ConflictError('WRONG_STATE', 'Approve the run before remitting its deductions');
      if ((await c.query('SELECT 1 FROM payroll_remittances WHERE run_id = $1 AND kind = $2', [runId, input.kind])).rowCount) throw new ConflictError('ALREADY_REMITTED', `${input.kind} for this run is already marked as paid`);
      await c.query('INSERT INTO payroll_remittances (run_id, kind, ref, by_name) VALUES ($1,$2,$3,$4)', [runId, input.kind, input.ref, actor.name]);
      await audit(c, actor, 'payroll.remit', 'payroll_run', runId, input);
    });
    return this.run(runId);
  }
}
