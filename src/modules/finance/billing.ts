import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { audit, outbox } from '../products/products.js';
import { assertOpen, financeSettings, Money, MonthSchema, monthOfDate } from './common.js';
import type { FinanceActor } from './cash.js';

export const EXPENSE_CATEGORIES = ['Marketing', 'Fuel & fleet', 'Software', 'Office & hub', 'Professional fees', 'Insurance', 'Other'] as const;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').refine((d) => { const t = Date.parse(`${d}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d; }, 'not a real date');

export const ExpenseSchema = z.strictObject({
  date: day,
  category: z.string().trim().min(1).max(60),
  payee: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).default(''),
  amountCents: Money.refine((n) => n > 0, 'must be more than zero'),
});
export const ExpenseDecisionSchema = z.strictObject({ to: z.enum(['approved', 'rejected']), note: z.string().trim().max(300).default('') });
export const ExpenseListSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  category: z.string().trim().max(60).optional(),
  month: MonthSchema.optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const Line = z.strictObject({ description: z.string().trim().min(1).max(200), quantity: z.number().int().min(1).max(1_000_000), unitCents: Money });
export const InvoiceSchema = z.strictObject({
  customer: z.string().trim().min(1).max(120),
  contact: z.string().trim().max(120).default(''),
  email: z.string().trim().toLowerCase().email().max(254).or(z.literal('')).default(''),
  pin: z.string().trim().max(20).default(''),
  address: z.string().trim().max(200).default(''),
  dueInDays: z.number().int().min(0).max(365).default(30),
  vatRate: z.number().min(0).max(100).optional(),
  draft: z.boolean().default(false),
  lines: z.array(Line).min(1).max(50),
});
export const InvoicePaymentSchema = z.strictObject({ amountCents: Money.refine((n) => n > 0, 'must be more than zero'), method: z.string().trim().min(1).max(40), ref: z.string().trim().min(1).max(80) });
export const InvoiceListSchema = z.object({
  status: z.enum(['Draft', 'Sent', 'Partly paid', 'Paid', 'Overdue']).optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

interface InvoiceRow {
  id: string; invoice_no: number; customer: string; contact: string; email: string; pin: string; address: string; issued_at: Date; due_at: Date; vat_rate: string; draft: boolean; created_by: string; version: number;
  subtotal: number; paid: number;
}
const invoiceView = (r: InvoiceRow, now = Date.now()) => {
  const subtotal = Number(r.subtotal);
  const vat = Math.round((subtotal * Number(r.vat_rate)) / 100);
  const total = subtotal + vat;
  const paid = Number(r.paid);
  const balance = Math.max(0, total - paid);
  const status = r.draft ? 'Draft' : balance === 0 ? 'Paid' : now > r.due_at.getTime() ? 'Overdue' : paid > 0 ? 'Partly paid' : 'Sent';
  return { id: r.id, number: `INV-${r.invoice_no}`, customer: r.customer, contact: r.contact, email: r.email, pin: r.pin, address: r.address, issuedAt: r.issued_at.toISOString(), dueAt: r.due_at.toISOString(), vatRate: Number(r.vat_rate), draft: r.draft, createdBy: r.created_by, version: r.version, subtotalCents: subtotal, vatCents: vat, totalCents: total, paidCents: paid, balanceCents: balance, status };
};
const INVOICE_SELECT = `SELECT i.*, COALESCE((SELECT sum(quantity * unit_cents) FROM invoice_lines WHERE invoice_id = i.id),0)::bigint AS subtotal, COALESCE((SELECT sum(amount_cents) FROM invoice_payments WHERE invoice_id = i.id),0)::bigint AS paid FROM invoices i`;

export class BillingService {
  constructor(private readonly db: Database) {}

  // ---- expenses -----------------------------------------------------------------------------------------------------------------------

  private expenseView(r: { id: string; expense_no: number; spent_on: Date | string; category: string; payee: string; description: string; amount_cents: number; status: string; by_name: string; decided_by: string | null; decided_at: Date | null; note: string }) {
    return { id: r.id, number: `EX-${r.expense_no}`, date: typeof r.spent_on === 'string' ? r.spent_on : r.spent_on.toISOString().slice(0, 10), category: r.category, payee: r.payee, description: r.description, amountCents: Number(r.amount_cents), status: r.status, by: r.by_name, decidedBy: r.decided_by, decidedAt: r.decided_at?.toISOString() ?? null, note: r.note };
  }

  async expenses(q: z.infer<typeof ExpenseListSchema>) {
    return this.db.read(async (c) => {
      const s = await financeSettings(c);
      const { rows } = await c.query(
        `SELECT id, expense_no, to_char(spent_on, 'YYYY-MM-DD') AS spent_on, category, payee, description, amount_cents, status, by_name, decided_by, decided_at, note FROM expenses
          WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR category = $2) AND ($3::text IS NULL OR to_char(spent_on, 'YYYY-MM') = $3)
            AND ($4::text IS NULL OR payee ILIKE '%' || $4 || '%' OR description ILIKE '%' || $4 || '%' OR ('EX-' || expense_no) ILIKE '%' || $4 || '%')
          ORDER BY spent_on DESC, expense_no DESC LIMIT $5`, [q.status ?? null, q.category ?? null, q.month ?? null, q.q ?? null, q.limit]);
      const t = (await c.query<{ pending: number; pending_cents: number; approved_cents: number }>(
        `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, COALESCE(sum(amount_cents) FILTER (WHERE status = 'pending'),0)::bigint AS pending_cents,
                COALESCE(sum(amount_cents) FILTER (WHERE status = 'approved' AND to_char(spent_on, 'YYYY-MM') = $1),0)::bigint AS approved_cents FROM expenses`, [monthOfDate(new Date())])).rows[0]!;
      return { items: rows.map((r) => this.expenseView(r)), categories: EXPENSE_CATEGORIES, limitCents: s.expenseLimitCents, pendingCount: t.pending, pendingCents: Number(t.pending_cents), approvedThisMonthCents: Number(t.approved_cents) };
    });
  }

  /** A new expense waits for someone else to approve it; an owner’s own entries are approved on the spot. */
  async addExpense(input: z.infer<typeof ExpenseSchema>, actor: FinanceActor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      await assertOpen(c, `${input.date}T12:00:00+03:00`);
      const approved = actor.isOwner;
      await c.query(
        `INSERT INTO expenses (id, spent_on, category, payee, description, amount_cents, status, by_id, by_name, decided_by, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, input.date, input.category, input.payee, input.description, input.amountCents, approved ? 'approved' : 'pending', actor.id, actor.name, approved ? actor.name : null, approved ? new Date() : null]);
      await audit(c, actor, 'expense.add', 'expense', id, { ...input, autoApproved: approved });
    });
    return this.expense(id);
  }

  async expense(id: string) {
    return this.db.read(async (c) => {
      const r = (await c.query(`SELECT id, expense_no, to_char(spent_on, 'YYYY-MM-DD') AS spent_on, category, payee, description, amount_cents, status, by_name, decided_by, decided_at, note FROM expenses WHERE id = $1`, [id])).rows[0];
      if (!r) throw new NotFoundError('Expense');
      return this.expenseView(r);
    });
  }

  async decideExpense(id: string, input: z.infer<typeof ExpenseDecisionSchema>, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const e = (await c.query<{ status: string; by_id: string; amount_cents: number; spent_on: string }>(`SELECT status, by_id, amount_cents, to_char(spent_on, 'YYYY-MM-DD') AS spent_on FROM expenses WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!e) throw new NotFoundError('Expense');
      if (e.status !== 'pending') throw new ConflictError('ALREADY_DECIDED', 'This expense has already been decided');
      if (input.to === 'approved') {
        if (e.by_id === actor.id && !actor.isOwner) throw new ForbiddenError('You can’t approve an expense you entered yourself');
        const limit = (await financeSettings(c)).expenseLimitCents;
        if (Number(e.amount_cents) > limit && !actor.isOwner) throw new ForbiddenError(`Expenses above KES ${(limit / 100).toLocaleString('en-KE')} need an owner’s approval`);
        await assertOpen(c, `${e.spent_on}T12:00:00+03:00`);
      }
      await c.query('UPDATE expenses SET status = $2, decided_by = $3, decided_at = now(), note = $4 WHERE id = $1', [id, input.to, actor.name, input.note]);
      await audit(c, actor, `expense.${input.to}`, 'expense', id, input);
    });
    return this.expense(id);
  }

  // ---- invoices -------------------------------------------------------------------------------------------------------------------------

  async invoices(q: z.infer<typeof InvoiceListSchema>) {
    return this.db.read(async (c) => {
      const rows = (await c.query<InvoiceRow>(`${INVOICE_SELECT} WHERE ($1::text IS NULL OR i.customer ILIKE '%' || $1 || '%' OR i.contact ILIKE '%' || $1 || '%' OR ('INV-' || i.invoice_no) ILIKE '%' || $1 || '%') ORDER BY i.invoice_no DESC LIMIT $2`, [q.q ?? null, q.limit])).rows;
      const items = rows.map((r) => invoiceView(r)).filter((i) => !q.status || i.status === q.status);
      const open = items.filter((i) => i.status !== 'Draft' && i.status !== 'Paid');
      return { items, outstandingCents: open.reduce((n, i) => n + i.balanceCents, 0), overdueCents: items.filter((i) => i.status === 'Overdue').reduce((n, i) => n + i.balanceCents, 0), overdueCount: items.filter((i) => i.status === 'Overdue').length };
    });
  }

  async invoice(id: string) {
    return this.db.read(async (c) => this.loadInvoice(c, id));
  }

  private async loadInvoice(c: Queryable, id: string) {
    const r = (await c.query<InvoiceRow>(`${INVOICE_SELECT} WHERE i.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundError('Invoice');
    const lines = (await c.query<{ description: string; quantity: number; unit_cents: number }>('SELECT description, quantity, unit_cents FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [id])).rows;
    const payments = (await c.query<{ amount_cents: number; method: string; ref: string; by_name: string; paid_at: Date }>('SELECT amount_cents, method, ref, by_name, paid_at FROM invoice_payments WHERE invoice_id = $1 ORDER BY id', [id])).rows;
    const reminders = (await c.query<{ sent_at: Date; by_name: string }>('SELECT sent_at, by_name FROM invoice_reminders WHERE invoice_id = $1 ORDER BY id', [id])).rows;
    return {
      ...invoiceView(r),
      lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitCents: Number(l.unit_cents), amountCents: l.quantity * Number(l.unit_cents) })),
      payments: payments.map((p) => ({ amountCents: Number(p.amount_cents), method: p.method, ref: p.ref, by: p.by_name, at: p.paid_at.toISOString() })),
      reminders: reminders.map((x) => ({ at: x.sent_at.toISOString(), by: x.by_name })),
    };
  }

  async createInvoice(input: z.infer<typeof InvoiceSchema>, actor: FinanceActor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      const vat = input.vatRate ?? (await financeSettings(c)).vatRate;
      const issued = new Date();
      await assertOpen(c, issued);
      await c.query('INSERT INTO invoices (id, customer, contact, email, pin, address, issued_at, due_at, vat_rate, draft, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [id, input.customer, input.contact, input.email, input.pin, input.address, issued, new Date(issued.getTime() + input.dueInDays * 86_400_000), vat, input.draft, actor.name]);
      for (const [i, l] of input.lines.entries()) await c.query('INSERT INTO invoice_lines (invoice_id, line_no, description, quantity, unit_cents) VALUES ($1,$2,$3,$4,$5)', [id, i + 1, l.description, l.quantity, l.unitCents]);
      await audit(c, actor, 'invoice.create', 'invoice', id, { customer: input.customer, draft: input.draft, lines: input.lines.length });
      if (!input.draft) await outbox(c, 'invoice', id, 'InvoiceIssued', { invoiceId: id, email: input.email });
    });
    return this.invoice(id);
  }

  /** A draft becomes a real invoice, dated today, and goes to the customer. */
  async sendInvoice(id: string, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const inv = (await c.query<{ draft: boolean; issued_at: Date; due_at: Date; email: string }>('SELECT draft, issued_at, due_at, email FROM invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!inv) throw new NotFoundError('Invoice');
      if (!inv.draft) throw new ConflictError('NOT_A_DRAFT', 'This invoice has already been sent');
      await assertOpen(c);
      const now = new Date();
      // Terms are kept: the due date moves with the issue date.
      const terms = inv.due_at.getTime() - inv.issued_at.getTime();
      await c.query('UPDATE invoices SET draft = false, issued_at = $2, due_at = $3, version = version + 1 WHERE id = $1', [id, now, new Date(now.getTime() + Math.max(0, terms))]);
      await outbox(c, 'invoice', id, 'InvoiceIssued', { invoiceId: id, email: inv.email });
      await audit(c, actor, 'invoice.send', 'invoice', id, {});
    });
    return this.invoice(id);
  }

  async deleteDraft(id: string, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const inv = (await c.query<{ draft: boolean }>('SELECT draft FROM invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!inv) throw new NotFoundError('Invoice');
      if (!inv.draft) throw new ConflictError('NOT_A_DRAFT', 'Only a draft can be deleted. Issued invoices stay on the record');
      await c.query('DELETE FROM invoices WHERE id = $1', [id]);
      await audit(c, actor, 'invoice.delete_draft', 'invoice', id, {});
    });
  }

  async recordPayment(id: string, input: z.infer<typeof InvoicePaymentSchema>, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const inv = (await c.query<{ draft: boolean }>('SELECT draft FROM invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!inv) throw new NotFoundError('Invoice');
      await assertOpen(c);
      const v = invoiceView((await c.query<InvoiceRow>(`${INVOICE_SELECT} WHERE i.id = $1`, [id])).rows[0]!);
      if (input.amountCents > v.balanceCents) throw new UnprocessableError('MORE_THAN_OWED', `The balance is only KES ${(v.balanceCents / 100).toLocaleString('en-KE')}`, { balanceCents: v.balanceCents });
      if ((await c.query('SELECT 1 FROM invoice_payments WHERE lower(ref) = lower($1) AND invoice_id = $2', [input.ref, id])).rowCount) throw new ConflictError('REF_USED', 'That reference has already been recorded on this invoice');
      if (inv.draft) await c.query('UPDATE invoices SET draft = false, issued_at = now() WHERE id = $1', [id]);
      await c.query('INSERT INTO invoice_payments (invoice_id, amount_cents, method, ref, by_name) VALUES ($1,$2,$3,$4,$5)', [id, input.amountCents, input.method, input.ref, actor.name]);
      await c.query('UPDATE invoices SET version = version + 1 WHERE id = $1', [id]);
      await audit(c, actor, 'invoice.payment', 'invoice', id, input);
    });
    return this.invoice(id);
  }

  async remind(id: string, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const inv = (await c.query<InvoiceRow>(`${INVOICE_SELECT} WHERE i.id = $1`, [id])).rows[0];
      if (!inv) throw new NotFoundError('Invoice');
      const v = invoiceView(inv);
      if (v.status === 'Draft') throw new ConflictError('NOT_SENT', 'Send the invoice before reminding anyone');
      if (v.balanceCents === 0) throw new ConflictError('ALREADY_PAID', 'This invoice is already paid');
      await c.query('INSERT INTO invoice_reminders (invoice_id, by_name) VALUES ($1,$2)', [id, actor.name]);
      await outbox(c, 'invoice', id, 'InvoiceReminder', { invoiceId: id, email: v.email, balanceCents: v.balanceCents });
      await audit(c, actor, 'invoice.remind', 'invoice', id, {});
    });
    return this.invoice(id);
  }
}

