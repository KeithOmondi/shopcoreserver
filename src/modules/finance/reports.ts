import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { audit } from '../products/products.js';
import { currentMonth, financeSettings, FinanceSettingsSchema, monthOf, monthRange, MonthSchema, shiftMonth, toCsv, TZ, type FinanceSettings } from './common.js';
import type { CashService, FinanceActor } from './cash.js';

export const CloseSchema = z.strictObject({ note: z.string().trim().max(500).default('') });
export const FilingSchema = z.strictObject({ ack: z.string().trim().regex(/^[A-Za-z0-9-]{6,40}$/, 'Enter the acknowledgement number KRA gave you (at least 6 letters or digits)') });
export const SalesQuerySchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export const DATASETS = ['Payments', 'Refunds', 'Rider payouts', 'COD balances', 'Expenses', 'Invoices', 'VAT summary', 'Profit and loss', 'Payroll summary', 'Store settlements'] as const;
export const ExportSchema = z.strictObject({ dataset: z.enum(DATASETS), format: z.enum(['CSV', 'Excel']).default('CSV'), month: MonthSchema.optional() });
export const FinanceSettingsPatch = FinanceSettingsSchema.partial().strict().refine((o) => Object.keys(o).length > 0, 'nothing to change');

export interface MonthStats { month: string; orders: number; grossCents: number; refundsCents: number; productCents: number; deliveryCents: number; onlineCents: number; riderPayCents: number }

/** The VAT inside a price that already includes it. */
export const vatIn = (gross: number, rate: number) => Math.round(gross - gross / (1 + rate / 100));

async function monthStats(c: Queryable, only?: string[]): Promise<Map<string, MonthStats>> {
  const m = monthOf('COALESCE(o.paid_at, o.created_at)');
  const rows = (await c.query<{ month: string; orders: number; gross: number; refunds: number; product: number; delivery: number; online: number }>(
    `SELECT ${m} AS month, count(*)::int AS orders, sum(o.total_cents)::bigint AS gross, sum(o.refunded_cents)::bigint AS refunds, sum(o.total_cents - o.delivery_fee_cents)::bigint AS product,
            sum(o.delivery_fee_cents)::bigint AS delivery, COALESCE(sum(o.total_cents) FILTER (WHERE o.payment_method IN ('mpesa','card')),0)::bigint AS online
       FROM orders o WHERE o.status IN ('PAID','FULFILLED') AND ($1::text[] IS NULL OR ${m} = ANY($1)) GROUP BY 1`, [only ?? null])).rows;
  const rider = (await c.query<{ month: string; pay: number }>(
    `SELECT ${monthOf('d.delivered_at')} AS month, COALESCE(sum(d.fare_cents + d.bonus_cents),0)::bigint AS pay FROM deliveries d WHERE d.status = 'delivered' AND d.delivered_at IS NOT NULL
        AND ($1::text[] IS NULL OR ${monthOf('d.delivered_at')} = ANY($1)) GROUP BY 1`, [only ?? null])).rows;
  const out = new Map<string, MonthStats>();
  for (const r of rows) out.set(r.month, { month: r.month, orders: r.orders, grossCents: Number(r.gross), refundsCents: Number(r.refunds), productCents: Number(r.product), deliveryCents: Number(r.delivery), onlineCents: Number(r.online), riderPayCents: 0 });
  for (const r of rider) {
    const cur = out.get(r.month) ?? { month: r.month, orders: 0, grossCents: 0, refundsCents: 0, productCents: 0, deliveryCents: 0, onlineCents: 0, riderPayCents: 0 };
    cur.riderPayCents = Number(r.pay);
    out.set(r.month, cur);
  }
  return out;
}
const blank = (month: string): MonthStats => ({ month, orders: 0, grossCents: 0, refundsCents: 0, productCents: 0, deliveryCents: 0, onlineCents: 0, riderPayCents: 0 });

function pnlOf(m: MonthStats, s: FinanceSettings, expenseByCategory: [string, number][], payrollCents: number) {
  const k = 1 + s.vatRate / 100;
  const productNet = Math.round(m.productCents / k);
  const deliveryNet = Math.round(m.deliveryCents / k);
  const refundsNet = Math.round(m.refundsCents / k);
  const revenue = productNet + deliveryNet - refundsNet;
  const cogs = Math.round((productNet * s.cogsRate) / 100);
  const processing = Math.round((m.onlineCents * s.processingFee) / 100);
  const expenses = expenseByCategory.reduce((n, [, v]) => n + v, 0);
  const grossProfit = revenue - cogs;
  const opex = m.riderPayCents + processing + expenses + payrollCents;
  return { month: m.month, productNetCents: productNet, deliveryNetCents: deliveryNet, refundsNetCents: refundsNet, revenueCents: revenue, cogsCents: cogs, grossProfitCents: grossProfit, riderPayCents: m.riderPayCents, processingCents: processing, expensesCents: expenses, expenseByCategory, payrollCents, opexCents: opex, netCents: grossProfit - opex };
}

export class ReportsService {
  constructor(private readonly db: Database, private readonly cash: CashService) {}

  // ---- settings -----------------------------------------------------------------------------------------------------------------------

  async settings() { return this.db.read((c) => financeSettings(c)); }

  async saveSettings(patch: z.infer<typeof FinanceSettingsPatch>, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const next = { ...(await financeSettings(c)), ...patch };
      await c.query(`INSERT INTO settings (key, value, updated_by) VALUES ('finance.settings', $1, $2) ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`, [JSON.stringify(next), actor.id]);
      await audit(c, actor, 'finance.settings', 'setting', 'finance.settings', patch);
    });
    return this.settings();
  }

  // ---- profit and loss ------------------------------------------------------------------------------------------------------------------

  private async pnl(c: Queryable, month: string, settings: FinanceSettings, stats?: Map<string, MonthStats>) {
    const m = (stats ?? (await monthStats(c, [month]))).get(month) ?? blank(month);
    const exp = (await c.query<{ category: string; v: number }>(`SELECT category, sum(amount_cents)::bigint AS v FROM expenses WHERE status = 'approved' AND to_char(spent_on, 'YYYY-MM') = $1 GROUP BY category ORDER BY 2 DESC`, [month])).rows;
    const pay = (await c.query<{ v: number }>(
      `SELECT COALESCE(sum(l.gross_cents + l.nssf_cents + l.housing_cents),0)::bigint AS v FROM payroll_runs r JOIN payroll_lines l ON l.run_id = r.id WHERE r.month = $1 AND r.status IN ('approved','paid')`, [month])).rows[0]!;
    return pnlOf(m, settings, exp.map((e) => [e.category, Number(e.v)] as [string, number]), Number(pay.v));
  }

  async profitAndLoss(month: string) {
    return this.db.read(async (c) => {
      const s = await financeSettings(c);
      const trendMonths = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
      const stats = await monthStats(c, trendMonths);
      const closed = (await c.query<{ closed_by: string; closed_at: Date; note: string }>('SELECT closed_by, closed_at, note FROM period_closes WHERE month = $1', [month])).rows[0];
      const trend = [];
      for (const k of trendMonths) trend.push(await this.pnl(c, k, s, stats));
      return { ...trend[trend.length - 1]!, closed: closed ? { by: closed.closed_by, at: closed.closed_at.toISOString(), note: closed.note } : null, trend: trend.map((t) => ({ month: t.month, netCents: t.netCents })), assumptions: { cogsRate: s.cogsRate, processingFee: s.processingFee, vatRate: s.vatRate } };
    });
  }

  // ---- overview ---------------------------------------------------------------------------------------------------------------------------

  async overview() {
    return this.db.read(async (c) => {
      const s = await financeSettings(c);
      const cur = currentMonth();
      const prev = shiftMonth(cur, -1);
      const stats = await monthStats(c, [cur, prev]);
      const now = stats.get(cur) ?? blank(cur);
      const before = stats.get(prev) ?? blank(prev);
      const daily = (await c.query<{ day: string; revenue: number; payouts: number }>(
        `WITH days AS (SELECT to_char(d, 'YYYY-MM-DD') AS day FROM generate_series((now() AT TIME ZONE '${TZ}')::date - 29, (now() AT TIME ZONE '${TZ}')::date, '1 day') d)
         SELECT days.day,
                COALESCE((SELECT sum(total_cents) FROM orders o WHERE o.status IN ('PAID','FULFILLED') AND to_char(COALESCE(o.paid_at, o.created_at) AT TIME ZONE '${TZ}', 'YYYY-MM-DD') = days.day),0)::bigint AS revenue,
                COALESCE((SELECT sum(amount_cents) FROM payouts p WHERE p.status = 'paid' AND to_char(p.paid_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') = days.day),0)::bigint AS payouts
           FROM days ORDER BY days.day`)).rows;
      const att = (await c.query<{ failed: number; review: number; pending_payouts: number; pending_payout_cents: number; pending_expenses: number; overdue_invoices: number; payroll_waiting: number; payroll_unpaid: number; unbatched: number }>(
        `SELECT (SELECT count(*) FROM failed_payments WHERE status = 'failed')::int AS failed, (SELECT count(*) FROM failed_payments WHERE status = 'manual_review')::int AS review,
                (SELECT count(*) FROM payouts WHERE status = 'pending')::int AS pending_payouts, (SELECT COALESCE(sum(amount_cents),0) FROM payouts WHERE status = 'pending')::bigint AS pending_payout_cents,
                (SELECT count(*) FROM expenses WHERE status = 'pending')::int AS pending_expenses,
                (SELECT count(*) FROM invoices i WHERE NOT i.draft AND i.due_at < now()
                    AND (SELECT COALESCE(sum(quantity * unit_cents),0) FROM invoice_lines WHERE invoice_id = i.id) * (1 + i.vat_rate / 100) > (SELECT COALESCE(sum(amount_cents),0) FROM invoice_payments WHERE invoice_id = i.id))::int AS overdue_invoices,
                (SELECT count(*) FROM payroll_runs WHERE status = 'pending_approval')::int AS payroll_waiting, (SELECT count(*) FROM payroll_runs WHERE status = 'approved')::int AS payroll_unpaid,
                (SELECT count(*) FROM payouts p WHERE p.status = 'pending' AND NOT EXISTS (SELECT 1 FROM payout_batch_items i WHERE i.payout_id = p.id))::int AS unbatched`)).rows[0]!;
      const cod = await this.cash.cashSummary();
      const lastFiled = (await c.query('SELECT 1 FROM vat_filings WHERE month = $1 AND status = $2', [prev, 'filed'])).rowCount ? true : false;
      const recent = (await c.query<{ id: string; order_no: number; customer: string; method: string; amount_cents: number; at: Date }>(
        `SELECT o.id, o.order_no, COALESCE(NULLIF(o.delivery_name, ''), NULLIF(cu.name, ''), 'Customer') AS customer, o.payment_method AS method, o.total_cents AS amount_cents, o.paid_at AS at
           FROM orders o LEFT JOIN customers cu ON cu.id = o.user_id WHERE o.paid_at IS NOT NULL AND o.payment_method IN ('mpesa','card') ORDER BY o.paid_at DESC LIMIT 8`)).rows;
      const change = (a: number, b: number) => (b === 0 ? null : Math.round(((a - b) / b) * 1000) / 10);
      return {
        month: cur,
        summary: { orders: now.orders, grossCents: now.grossCents, refundsCents: now.refundsCents, vatCents: vatIn(now.grossCents, s.vatRate) - vatIn(now.refundsCents, s.vatRate), codHeldCents: cod.heldCents, pendingPayoutsCents: Number(att.pending_payout_cents), grossChangePct: change(now.grossCents, before.grossCents), ordersChangePct: change(now.orders, before.orders) },
        daily: daily.map((d) => ({ day: d.day, revenueCents: Number(d.revenue), payoutsCents: Number(d.payouts) })),
        recentPayments: recent.map((r) => ({ id: r.id, number: `PAY-${r.order_no}`, customer: r.customer, method: r.method === 'card' ? 'Card' : 'M-Pesa', amountCents: Number(r.amount_cents), at: r.at.toISOString() })),
        attention: [
          { key: 'failed-payments', label: 'Failed payments to retry', count: att.failed, to: '/payments/failed' },
          { key: 'manual-review', label: 'Payments needing manual review', count: att.review, to: '/payments/failed' },
          { key: 'cod-overdue', label: 'Riders late handing in cash', count: cod.overdueRiders, to: '/finance/cod' },
          { key: 'payouts', label: 'Rider payouts waiting', count: att.unbatched, to: '/payouts' },
          { key: 'expenses', label: 'Expenses to approve', count: att.pending_expenses, to: '/finance/expenses' },
          { key: 'invoices', label: 'Overdue invoices', count: att.overdue_invoices, to: '/finance/invoices' },
          { key: 'payroll', label: 'Payroll waiting for approval or payment', count: att.payroll_waiting + att.payroll_unpaid, to: '/finance/payroll' },
          { key: 'vat', label: `VAT return for ${prev} not filed`, count: lastFiled ? 0 : 1, to: '/finance/vat' },
        ].filter((a) => a.count > 0),
      };
    });
  }

  // ---- VAT ---------------------------------------------------------------------------------------------------------------------------------

  async vat() {
    return this.db.read(async (c) => {
      const s = await financeSettings(c);
      const stats = await monthStats(c);
      const filings = new Map((await c.query<{ month: string; status: string; prepared_by: string; prepared_at: Date; ack: string | null; filed_at: Date | null }>('SELECT month, status, prepared_by, prepared_at, ack, filed_at FROM vat_filings')).rows.map((f) => [f.month, f]));
      const months = [...new Set([...stats.keys(), ...filings.keys()])].sort().reverse().slice(0, 24);
      const items = months.map((k) => {
        const m = stats.get(k) ?? blank(k);
        const collected = vatIn(m.grossCents, s.vatRate);
        const adj = vatIn(m.refundsCents, s.vatRate);
        const f = filings.get(k);
        return { month: k, taxableCents: m.grossCents - collected, collectedCents: collected, adjustmentsCents: adj, netCents: collected - adj, filing: f ? { status: f.status, preparedBy: f.prepared_by, preparedAt: f.prepared_at.toISOString(), ack: f.ack, filedAt: f.filed_at?.toISOString() ?? null } : null };
      });
      return { vatRate: s.vatRate, items, unfiledCents: items.filter((i) => i.filing?.status !== 'filed' && i.month < currentMonth()).reduce((n, i) => n + i.netCents, 0) };
    });
  }

  async prepareFiling(month: string, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      if (month >= currentMonth()) throw new UnprocessableError('MONTH_NOT_OVER', 'A month’s return can be prepared once the month is over');
      const f = (await c.query<{ status: string }>('SELECT status FROM vat_filings WHERE month = $1 FOR UPDATE', [month])).rows[0];
      if (f?.status === 'filed') throw new ConflictError('ALREADY_FILED', 'That return has already been filed');
      await c.query(`INSERT INTO vat_filings (month, status, prepared_by) VALUES ($1,'draft',$2) ON CONFLICT (month) DO UPDATE SET prepared_by = $2, prepared_at = now()`, [month, actor.name]);
      await audit(c, actor, 'vat.prepare', 'vat_filing', month, {});
    });
    return this.vat();
  }

  async fileReturn(month: string, input: z.infer<typeof FilingSchema>, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      const f = (await c.query<{ status: string }>('SELECT status FROM vat_filings WHERE month = $1 FOR UPDATE', [month])).rows[0];
      if (!f) throw new ConflictError('NOT_PREPARED', 'Prepare the return before filing it');
      if (f.status === 'filed') throw new ConflictError('ALREADY_FILED', 'That return has already been filed');
      await c.query(`UPDATE vat_filings SET status = 'filed', ack = $2, filed_at = now(), filed_by = $3 WHERE month = $1`, [month, input.ack, actor.name]);
      await audit(c, actor, 'vat.file', 'vat_filing', month, input);
    });
    return this.vat();
  }

  // ---- accounts ---------------------------------------------------------------------------------------------------------------------------

  /** What ShopCore holds or is owed, and what it owes. Worked out from the source records, so it can never drift from them. */
  async accounts() {
    const settlements = await this.cash.settlements();
    return this.db.read(async (c) => {
      const s = await financeSettings(c);
      const r = (await c.query<{ received: number; refunded: number; cod: number; rider_balance: number; pending_payouts: number; invoices: number; payroll: number }>(
        `SELECT (SELECT COALESCE(sum(total_cents),0) FROM orders WHERE paid_at IS NOT NULL AND payment_method IN ('mpesa','card') AND status IN ('PAID','FULFILLED','CANCELLED'))::bigint AS received,
                (SELECT COALESCE(sum(refunded_cents),0) FROM orders)::bigint AS refunded,
                (SELECT COALESCE(sum(amount_cents),0) FROM rider_cash)::bigint AS cod,
                (SELECT COALESCE(sum(amount_cents),0) FROM rider_ledger)::bigint AS rider_balance,
                (SELECT COALESCE(sum(amount_cents + fee_cents),0) FROM payouts WHERE status = 'pending')::bigint AS pending_payouts,
                (SELECT COALESCE(sum(GREATEST(0, round((SELECT COALESCE(sum(quantity * unit_cents),0) FROM invoice_lines WHERE invoice_id = i.id) * (1 + i.vat_rate / 100)) - (SELECT COALESCE(sum(amount_cents),0) FROM invoice_payments WHERE invoice_id = i.id))),0) FROM invoices i WHERE NOT i.draft)::bigint AS invoices,
                (SELECT COALESCE(sum(l.net_cents),0) FROM payroll_runs r JOIN payroll_lines l ON l.run_id = r.id WHERE r.status = 'approved')::bigint AS payroll`)).rows[0]!;
      const stats = await monthStats(c);
      const filed = new Set((await c.query<{ month: string }>(`SELECT month FROM vat_filings WHERE status = 'filed'`)).rows.map((x) => x.month));
      const vatOwed = [...stats.values()].filter((m) => !filed.has(m.month)).reduce((n, m) => n + vatIn(m.grossCents, s.vatRate) - vatIn(m.refundsCents, s.vatRate), 0);
      const holds = [
        { key: 'payments', label: 'Customer payments received', cents: Number(r.received) - Number(r.refunded), to: '/payments' },
        { key: 'cod', label: 'Cash held by riders (COD)', cents: Number(r.cod), to: '/finance/cod' },
        { key: 'invoices', label: 'Business invoices unpaid', cents: Number(r.invoices), to: '/finance/invoices' },
      ];
      const owes = [
        { key: 'riders', label: 'Rider earnings not yet paid', cents: Number(r.rider_balance) + Number(r.pending_payouts), to: '/payouts' },
        { key: 'stores', label: 'Partner stores not yet settled', cents: settlements.payableCents, to: '/finance/settlements' },
        { key: 'vat', label: 'VAT to pay KRA', cents: vatOwed, to: '/finance/vat' },
        { key: 'payroll', label: 'Approved payroll not yet paid', cents: Number(r.payroll), to: '/finance/payroll' },
      ];
      const holdsTotal = holds.reduce((n, h) => n + h.cents, 0);
      const owesTotal = owes.reduce((n, h) => n + h.cents, 0);
      const journal = (await c.query<{ at: Date; ref: string; debit: string; credit: string; cents: number }>(
        `SELECT * FROM (
           SELECT o.paid_at AS at, 'PAY-' || o.order_no AS ref, CASE o.payment_method WHEN 'card' THEN 'Card gateway' ELSE 'M-Pesa paybill' END AS debit, 'Customer funds held · SC-' || o.order_no AS credit, o.total_cents AS cents
             FROM orders o WHERE o.paid_at IS NOT NULL AND o.payment_method IN ('mpesa','card')
           UNION ALL SELECT d.created_at, 'COD-' || d.id, 'Cash held by ' || r.name, 'COD received from ' || r.name, -d.amount_cents FROM rider_cash d JOIN riders r ON r.id = d.rider_id WHERE d.kind = 'deposit'
           UNION ALL SELECT p.paid_at, 'PO-' || p.payout_no, 'Rider earnings owed', 'M-Pesa payout to ' || r.name, p.amount_cents FROM payouts p JOIN riders r ON r.id = p.rider_id WHERE p.status = 'paid'
           UNION ALL SELECT f.decided_at, 'RF-' || f.refund_no, 'Customer funds held · SC-' || o.order_no, 'Refund to customer', f.decided_cents FROM refunds f JOIN orders o ON o.id = f.order_id WHERE f.status IN ('approved','partly_approved') AND f.decided_cents > 0
           UNION ALL SELECT e.paid_at, 'INV-' || i.invoice_no, 'Bank / M-Pesa', 'Receivable · ' || i.customer, e.amount_cents FROM invoice_payments e JOIN invoices i ON i.id = e.invoice_id
         ) j WHERE j.at IS NOT NULL ORDER BY j.at DESC LIMIT 30`)).rows;
      return {
        holds, owes, holdsTotalCents: holdsTotal, owesTotalCents: owesTotal, netCents: holdsTotal - owesTotal,
        journal: journal.map((j) => ({ at: j.at.toISOString(), ref: j.ref, debit: j.debit, credit: j.credit, amountCents: Number(j.cents) })),
        note: 'Balances are worked out from orders, payouts, cash, invoices and payroll, not stored separately.',
      };
    });
  }

  // ---- sales and delivery reports ------------------------------------------------------------------------------------------------------------

  async sales(q: z.infer<typeof SalesQuerySchema>) {
    const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
    const to = q.to ?? today;
    const from = q.from ?? new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw new ValidationError([{ path: ['from'], message: 'must not be after "to"' }]);
    if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw new ValidationError([{ path: ['from'], message: 'at most a year at a time' }]);
    return this.db.read(async (c) => {
      const when = `(COALESCE(o.paid_at, o.created_at) AT TIME ZONE '${TZ}')::date`;
      const base = `FROM orders o WHERE o.status IN ('PAID','FULFILLED') AND ${when} BETWEEN $1::date AND $2::date`;
      const byDay = (await c.query<{ day: string; orders: number; total: number }>(`SELECT to_char(${when}, 'YYYY-MM-DD') AS day, count(*)::int AS orders, sum(o.total_cents)::bigint AS total ${base} GROUP BY 1 ORDER BY 1`, [from, to])).rows;
      const byArea = (await c.query<{ area: string; orders: number; total: number }>(`SELECT COALESCE(NULLIF(o.delivery_area, ''), 'Unknown') AS area, count(*)::int AS orders, sum(o.total_cents)::bigint AS total ${base} GROUP BY 1 ORDER BY 3 DESC LIMIT 10`, [from, to])).rows;
      const items = `FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id LEFT JOIN categories c ON c.id = p.category_id WHERE o.status IN ('PAID','FULFILLED') AND ${when} BETWEEN $1::date AND $2::date`;
      const byCategory = (await c.query<{ name: string; total: number }>(`SELECT COALESCE(c.name, 'Uncategorised') AS name, sum(i.quantity * i.unit_price_cents)::bigint AS total ${items} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [from, to])).rows;
      const topProducts = (await c.query<{ name: string; units: number; total: number }>(`SELECT i.name, sum(i.quantity)::int AS units, sum(i.quantity * i.unit_price_cents)::bigint AS total ${items} GROUP BY i.product_id, i.name ORDER BY 3 DESC LIMIT 10`, [from, to])).rows;
      const t = (await c.query<{ orders: number; total: number }>(`SELECT count(*)::int AS orders, COALESCE(sum(o.total_cents),0)::bigint AS total ${base}`, [from, to])).rows[0]!;
      return {
        from, to, orders: t.orders, totalCents: Number(t.total), averageCents: t.orders ? Math.round(Number(t.total) / t.orders) : 0,
        byDay: byDay.map((d) => ({ day: d.day, orders: d.orders, totalCents: Number(d.total) })),
        byCategory: byCategory.map((x) => ({ name: x.name, totalCents: Number(x.total) })),
        byArea: byArea.map((x) => ({ area: x.area, orders: x.orders, totalCents: Number(x.total) })),
        topProducts: topProducts.map((x) => ({ name: x.name, units: x.units, totalCents: Number(x.total) })),
      };
    });
  }

  /** Delivery fees against rider pay, by zone, for a month. */
  async deliveryCost(month: string) {
    return this.db.read(async (c) => {
      const s = await financeSettings(c);
      const [from, to] = monthRange(month);
      const rows = (await c.query<{ area: string; n: number; fees: number; rider: number }>(
        `SELECT COALESCE(z.name, NULLIF(o.delivery_area, ''), 'Unknown') AS area, count(*)::int AS n, sum(o.delivery_fee_cents)::bigint AS fees, sum(d.fare_cents + d.bonus_cents)::bigint AS rider
           FROM deliveries d JOIN orders o ON o.id = d.order_id LEFT JOIN zones z ON z.id = o.zone_id WHERE d.status = 'delivered' AND d.delivered_at >= $1 AND d.delivered_at < $2 GROUP BY 1 ORDER BY 4 DESC`, [from, to])).rows;
      const k = 1 + s.vatRate / 100;
      const items = rows.map((r) => { const fees = Math.round(Number(r.fees) / k); return { area: r.area, deliveries: r.n, feesCents: fees, riderPayCents: Number(r.rider), marginCents: fees - Number(r.rider) }; });
      return { month, items, totals: { deliveries: items.reduce((n, i) => n + i.deliveries, 0), feesCents: items.reduce((n, i) => n + i.feesCents, 0), riderPayCents: items.reduce((n, i) => n + i.riderPayCents, 0), marginCents: items.reduce((n, i) => n + i.marginCents, 0) } };
    });
  }

  // ---- closing a period ------------------------------------------------------------------------------------------------------------------------

  async periods() {
    return this.db.read(async (c) => ({ items: (await c.query<{ month: string; closed_by: string; closed_at: Date; note: string }>('SELECT * FROM period_closes ORDER BY month DESC')).rows.map((p) => ({ month: p.month, closedBy: p.closed_by, closedAt: p.closed_at.toISOString(), note: p.note })) }));
  }

  private async checklist(c: Queryable, month: string) {
    const [from, to] = monthRange(month);
    const st = (await c.query<{ id: string; completed_at: Date | null; open: number }>(
      `SELECT s.id, s.completed_at, (SELECT count(*) FROM statement_lines l WHERE l.statement_id = s.id AND l.resolution IS NULL AND (l.ours_cents IS NULL OR l.ours_cents <> l.gateway_cents))::int AS open FROM statements s ORDER BY s.imported_at DESC LIMIT 1`)).rows[0];
    const cod = await this.cash.cashSummary(c);
    const pend = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM payouts WHERE status = 'pending'`)).rows[0]!.n;
    const exp = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM expenses WHERE status = 'pending' AND spent_on >= ($1::timestamptz AT TIME ZONE '${TZ}')::date AND spent_on < ($2::timestamptz AT TIME ZONE '${TZ}')::date`, [from, to])).rows[0]!.n;
    const vat = (await c.query<{ status: string; ack: string | null }>('SELECT status, ack FROM vat_filings WHERE month = $1', [month])).rows[0];
    const run = (await c.query<{ status: string }>('SELECT status FROM payroll_runs WHERE month = $1', [month])).rows[0];
    const stOk = !!st?.completed_at && st.open === 0;
    return [
      { key: 'reconcile', title: 'Reconcile gateway settlements', ok: stOk, detail: !st ? 'No statement imported' : stOk ? 'Statement reconciled with no open lines' : `${st.open} open line${st.open === 1 ? '' : 's'}${st.completed_at ? '' : ' · not completed'}`, to: '/finance/reconciliation' },
      { key: 'cod', title: 'Review COD balances', ok: cod.overdueRiders === 0, detail: cod.overdueRiders ? `${cod.overdueRiders} rider balance${cod.overdueRiders === 1 ? '' : 's'} overdue` : 'No overdue cash', to: '/finance/cod' },
      { key: 'payouts', title: 'Approve and send rider payouts', ok: pend === 0, detail: pend ? `${pend} payout${pend === 1 ? '' : 's'} not sent` : 'Every payout sent', to: '/finance/batch' },
      { key: 'expenses', title: 'Review expense submissions', ok: exp === 0, detail: exp ? 'Expenses waiting for a decision' : 'All expenses decided', to: '/finance/expenses' },
      { key: 'vat', title: 'Prepare and file the VAT return', ok: vat?.status === 'filed', detail: vat?.status === 'filed' ? `Filed · ${vat.ack}` : vat ? 'Draft prepared, not filed' : 'No return prepared', to: '/finance/vat' },
      { key: 'payroll', title: 'Pay payroll for the month', ok: run?.status === 'paid', detail: run ? `Run is ${STATUS_TEXT[run.status] ?? run.status}` : 'No payroll run for this month', to: '/finance/payroll' },
    ];
  }

  async closeStatus(month: string) {
    return this.db.read(async (c) => {
      const checks = await this.checklist(c, month);
      const closed = (await c.query<{ closed_by: string; closed_at: Date; note: string }>('SELECT closed_by, closed_at, note FROM period_closes WHERE month = $1', [month])).rows[0];
      const s = await financeSettings(c);
      const p = await this.pnl(c, month, s);
      const stats = (await monthStats(c, [month])).get(month) ?? blank(month);
      return {
        month, checks, done: checks.filter((x) => x.ok).length, ready: checks.every((x) => x.ok), closed: closed ? { by: closed.closed_by, at: closed.closed_at.toISOString(), note: closed.note } : null,
        snapshot: { revenueCents: p.revenueCents, refundsCents: stats.refundsCents, operatingCostsCents: p.opexCents, netProfitCents: p.netCents },
      };
    });
  }

  async closePeriod(month: string, input: z.infer<typeof CloseSchema>, actor: FinanceActor) {
    await this.db.tx(async (c) => {
      if (month >= currentMonth()) throw new UnprocessableError('MONTH_NOT_OVER', 'A month can be closed once it is over');
      if ((await c.query('SELECT 1 FROM period_closes WHERE month = $1', [month])).rowCount) throw new ConflictError('ALREADY_CLOSED', 'That period is already closed');
      const open = (await this.checklist(c, month)).filter((x) => !x.ok);
      if (open.length) throw new UnprocessableError('CONTROLS_OPEN', `${open.length} close control${open.length === 1 ? ' is' : 's are'} still open`, { open: open.map((o) => o.key) });
      await c.query('INSERT INTO period_closes (month, closed_by, note) VALUES ($1,$2,$3)', [month, actor.name, input.note]);
      await audit(c, actor, 'period.close', 'period', month, input);
    });
    return this.closeStatus(month);
  }

  /** Only an owner can reopen a closed month. */
  async reopenPeriod(month: string, actor: FinanceActor) {
    if (!actor.isOwner) throw new ForbiddenError('Only an owner can reopen a closed period');
    await this.db.tx(async (c) => {
      if (!(await c.query('DELETE FROM period_closes WHERE month = $1', [month])).rowCount) throw new NotFoundError('Closed period');
      await audit(c, actor, 'period.reopen', 'period', month, {});
    });
    return this.closeStatus(month);
  }

  // ---- exports ---------------------------------------------------------------------------------------------------------------------------------

  async exports() {
    return this.db.read(async (c) => ({
      datasets: DATASETS,
      items: (await c.query<{ id: string; export_no: number; name: string; dataset: string; format: string; row_count: number; by_name: string; created_at: Date }>('SELECT * FROM export_jobs ORDER BY created_at DESC LIMIT 100')).rows
        .map((j) => ({ id: j.id, number: `XP-${j.export_no}`, name: j.name, dataset: j.dataset, format: j.format, rows: j.row_count, by: j.by_name, at: j.created_at.toISOString() })),
    }));
  }

  /** Builds a dataset as CSV and records who took it. Excel files come with the wire-up phase. */
  async exportData(input: z.infer<typeof ExportSchema>, actor: FinanceActor) {
    if (input.format === 'Excel') throw new UnprocessableError('FORMAT_UNAVAILABLE', 'Excel export isn’t available yet. Use CSV, which opens in Excel');
    const month = input.month ?? shiftMonth(currentMonth(), -1);
    const kes = (n: number | string) => Math.round(Number(n)) / 100;
    let head: string[] = [];
    let rows: unknown[][] = [];
    await this.db.read(async (c) => {
      switch (input.dataset) {
        case 'Payments': {
          head = ['Payment', 'Order', 'Method', 'Amount (KES)', 'Reference', 'Paid at'];
          rows = (await c.query<{ order_no: number; payment_method: string; total_cents: number; payment_ref: string; paid_at: Date }>(`SELECT order_no, payment_method, total_cents, payment_ref, paid_at FROM orders WHERE paid_at IS NOT NULL AND payment_method IN ('mpesa','card') ORDER BY paid_at DESC LIMIT 50000`)).rows
            .map((r) => [`PAY-${r.order_no}`, `SC-${r.order_no}`, r.payment_method, kes(r.total_cents), r.payment_ref, r.paid_at.toISOString()]);
          break;
        }
        case 'Refunds': {
          head = ['Refund', 'Order', 'Customer', 'Amount (KES)', 'Reason', 'Decided'];
          rows = (await c.query<{ refund_no: number; order_no: number; customer_name: string; decided_cents: number; reason: string; decided_at: Date }>(
            `SELECT f.refund_no, o.order_no, f.customer_name, f.decided_cents, f.reason, f.decided_at FROM refunds f JOIN orders o ON o.id = f.order_id WHERE f.status IN ('approved','partly_approved') ORDER BY f.decided_at DESC LIMIT 50000`)).rows
            .map((r) => [`RF-${r.refund_no}`, `SC-${r.order_no}`, r.customer_name, kes(r.decided_cents), r.reason, r.decided_at.toISOString()]);
          break;
        }
        case 'Rider payouts': {
          head = ['Payout', 'Rider', 'Amount (KES)', 'Fee (KES)', 'Status', 'Requested', 'Paid', 'Reference'];
          rows = (await c.query<{ payout_no: number; rider: string; amount_cents: number; fee_cents: number; status: string; requested_at: Date; paid_at: Date | null; provider_ref: string | null }>(
            `SELECT p.payout_no, r.name AS rider, p.amount_cents, p.fee_cents, p.status, p.requested_at, p.paid_at, p.provider_ref FROM payouts p JOIN riders r ON r.id = p.rider_id ORDER BY p.requested_at DESC LIMIT 50000`)).rows
            .map((r) => [`PO-${r.payout_no}`, r.rider, kes(r.amount_cents), kes(r.fee_cents), r.status, r.requested_at.toISOString(), r.paid_at?.toISOString() ?? '', r.provider_ref ?? '']);
          break;
        }
        case 'COD balances': {
          head = ['Rider', 'Phone', 'Held (KES)', 'Orders', 'Since', 'Overdue'];
          rows = (await this.cash.cashSummary(c)).owed.map((o) => [o.rider, o.phone, kes(o.heldCents), o.orders, o.since ?? '', o.overdue ? 'Yes' : 'No']);
          break;
        }
        case 'Expenses': {
          head = ['Expense', 'Date', 'Category', 'Payee', 'Description', 'Amount (KES)', 'Status', 'Entered by', 'Decided by'];
          rows = (await c.query<{ expense_no: number; spent_on: string; category: string; payee: string; description: string; amount_cents: number; status: string; by_name: string; decided_by: string | null }>(
            `SELECT expense_no, to_char(spent_on, 'YYYY-MM-DD') AS spent_on, category, payee, description, amount_cents, status, by_name, decided_by FROM expenses ORDER BY spent_on DESC, expense_no DESC LIMIT 50000`)).rows
            .map((r) => [`EX-${r.expense_no}`, r.spent_on, r.category, r.payee, r.description, kes(r.amount_cents), r.status, r.by_name, r.decided_by ?? '']);
          break;
        }
        case 'Invoices': {
          head = ['Invoice', 'Business', 'Issued', 'Due', 'Subtotal (KES)', 'VAT (KES)', 'Total (KES)', 'Paid (KES)', 'Balance (KES)', 'Status'];
          const inv = (await c.query<{ invoice_no: number; customer: string; issued_at: Date; due_at: Date; vat_rate: string; draft: boolean; subtotal: number; paid: number }>(
            `SELECT i.invoice_no, i.customer, i.issued_at, i.due_at, i.vat_rate, i.draft, COALESCE((SELECT sum(quantity * unit_cents) FROM invoice_lines WHERE invoice_id = i.id),0)::bigint AS subtotal, COALESCE((SELECT sum(amount_cents) FROM invoice_payments WHERE invoice_id = i.id),0)::bigint AS paid FROM invoices i ORDER BY i.invoice_no DESC LIMIT 5000`)).rows;
          rows = inv.map((r) => {
            const sub = Number(r.subtotal); const vat = Math.round((sub * Number(r.vat_rate)) / 100); const total = sub + vat; const bal = Math.max(0, total - Number(r.paid));
            return [`INV-${r.invoice_no}`, r.customer, r.issued_at.toISOString().slice(0, 10), r.due_at.toISOString().slice(0, 10), kes(sub), kes(vat), kes(total), kes(r.paid), kes(bal), r.draft ? 'Draft' : bal === 0 ? 'Paid' : Date.now() > r.due_at.getTime() ? 'Overdue' : Number(r.paid) > 0 ? 'Partly paid' : 'Sent'];
          });
          break;
        }
        case 'VAT summary': {
          head = ['Month', 'Taxable sales (KES)', 'VAT collected (KES)', 'Refund adjustments (KES)', 'Net VAT payable (KES)', 'Return'];
          rows = (await this.vat()).items.map((i) => [i.month, kes(i.taxableCents), kes(i.collectedCents), kes(i.adjustmentsCents), kes(i.netCents), i.filing?.status ?? 'Not prepared']);
          break;
        }
        case 'Profit and loss': {
          const p = await this.pnl(c, month, await financeSettings(c));
          head = ['Account', 'Amount (KES)'];
          rows = [['Product sales (ex VAT)', kes(p.productNetCents)], ['Delivery fees (ex VAT)', kes(p.deliveryNetCents)], ['Refunds (ex VAT)', -kes(p.refundsNetCents)], ['Revenue', kes(p.revenueCents)], ['Cost of goods', -kes(p.cogsCents)], ['Gross profit', kes(p.grossProfitCents)],
            ['Rider pay', -kes(p.riderPayCents)], ['Payment processing', -kes(p.processingCents)], ...p.expenseByCategory.map(([k, v]): [string, number] => [`Expense · ${k}`, -kes(v)]), ['Payroll (employer cost)', -kes(p.payrollCents)], ['Net profit', kes(p.netCents)]];
          break;
        }
        case 'Payroll summary': {
          head = ['Month', 'Status', 'People', 'Gross (KES)', 'PAYE (KES)', 'NSSF (KES)', 'SHIF (KES)', 'Housing levy (KES)', 'Net (KES)', 'Employer cost (KES)'];
          const runs = (await c.query<{ month: string; status: string; n: number; gross: number; paye: number; nssf: number; shif: number; housing: number; net: number }>(
            `SELECT r.month, r.status, count(l.staff_id)::int AS n, sum(l.gross_cents)::bigint AS gross, sum(l.paye_cents)::bigint AS paye, sum(l.nssf_cents)::bigint AS nssf, sum(l.shif_cents)::bigint AS shif, sum(l.housing_cents)::bigint AS housing, sum(l.net_cents)::bigint AS net
               FROM payroll_runs r JOIN payroll_lines l ON l.run_id = r.id GROUP BY r.id ORDER BY r.month DESC`)).rows;
          rows = runs.map((r) => [r.month, r.status, r.n, kes(r.gross), kes(r.paye), kes(Number(r.nssf) * 2), kes(r.shif), kes(Number(r.housing) * 2), kes(r.net), kes(Number(r.gross) + Number(r.nssf) + Number(r.housing))]);
          break;
        }
        case 'Store settlements': {
          head = ['Store', 'Month', 'Orders', 'Sales (KES)', 'Commission (KES)', 'Net payable (KES)', 'Status'];
          rows = (await this.cash.settlements()).items.map((s) => [s.store, s.month, s.orders, kes(s.salesCents), kes(s.commissionCents), kes(s.netCents), s.paid ? 'Paid' : 'Payable']);
          break;
        }
      }
    });
    const csv = toCsv(head, rows);
    const id = uuidv7();
    const name = `${input.dataset}${['Profit and loss'].includes(input.dataset) ? ` · ${month}` : ''}`;
    await this.db.tx(async (c) => {
      await c.query('INSERT INTO export_jobs (id, name, dataset, format, row_count, by_name) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, input.dataset, 'CSV', rows.length, actor.name]);
      await audit(c, actor, 'finance.export', 'export', id, { dataset: input.dataset, rows: rows.length });
    });
    return { name, filename: `${input.dataset.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${input.dataset === 'Profit and loss' ? `-${month}` : ''}.csv`, csv, rows: rows.length };
  }
}

const STATUS_TEXT: Record<string, string> = { draft: 'draft', pending_approval: 'pending approval', approved: 'approved', paid: 'paid' };
