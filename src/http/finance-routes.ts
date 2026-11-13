import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BillingService, ExpenseDecisionSchema, ExpenseListSchema, ExpenseSchema, InvoiceListSchema, InvoicePaymentSchema, InvoiceSchema } from '../modules/finance/billing.js';
import { BatchPatchSchema, CashService, NewBatchSchema, SettlementPaySchema, type FinanceActor } from '../modules/finance/cash.js';
import { MonthSchema } from '../modules/finance/common.js';
import { FailureSchema, PaymentListSchema, PaymentsService, ResolveLineSchema, StatementImportSchema } from '../modules/finance/payments.js';
import { AdjustSchema, NewRunSchema, PayrollService, ProfilePatchSchema, RemitSchema, RunActionSchema, StatutoryBody } from '../modules/finance/payroll.js';
import { CloseSchema, ExportSchema, FilingSchema, FinanceSettingsPatch, ReportsService, SalesQuerySchema } from '../modules/finance/reports.js';
import { NotFoundError } from '../domain/errors.js';
import { OWNER_ROLE } from '../modules/staff/permissions.js';
import type { Actor } from '../modules/products/products.js';
import type { Action, Module } from '../modules/staff/permissions.js';
import type { StaffContext } from '../modules/staff/staff.js';
import { requireRole } from './auth.js';
import { makeGuard } from './guard.js';
import type { Authz } from './staff-routes.js';
import { IdParam, parse } from './validate.js';

export interface FinanceServices { payments: PaymentsService; cash: CashService; billing: BillingService; payroll: PayrollService; reports: ReportsService }

const MonthParam = z.object({ month: MonthSchema });
const MonthQuery = z.object({ month: MonthSchema.optional() });
const LineParams = z.object({ id: z.string().uuid(), lineId: z.string().uuid() });
const StaffParams = z.object({ id: z.string().uuid(), staffId: z.string().uuid() });
const SettlementParams = z.object({ id: z.string().regex(/^ST-\d{6}-[A-Z0-9-]{1,20}$/) });

/** Finance (the Payments module) and payroll (the Payroll module). */
export function registerFinanceRoutes(app: FastifyInstance, svc: FinanceServices, authz: Authz) {
  const { payments, cash, billing, payroll, reports } = svc;
  const { guard, NoStore } = makeGuard(authz);
  /** Who is acting. Owners may approve their own work in most places; service tokens never count as owners. */
  const fa = (a: Actor, ctx: StaffContext | null): FinanceActor => ({ ...a, name: a.name ?? 'Staff', isOwner: ctx?.role === OWNER_ROLE });
  const P = (a: 'View' | 'Create' | 'Edit' | 'Delete' | 'Export') => [['Payments', a]] as [Module, Action][];
  const R = (a: 'View' | 'Create' | 'Edit' | 'Delete' | 'Export') => [['Payroll', a]] as [Module, Action][];

  // ============ overview, settings, accounts, reports ==============================================================
  app.get('/v1/admin/finance/overview', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return reports.overview(); }));
  app.get('/v1/admin/finance/settings', (req) => guard(req, P('View'), () => reports.settings()));
  app.patch('/v1/admin/finance/settings', (req) => guard(req, P('Edit'), (a, ctx) => reports.saveSettings(parse(FinanceSettingsPatch, req.body), fa(a, ctx))));
  app.get('/v1/admin/accounts', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return reports.accounts(); }));
  app.get('/v1/admin/reports/profit-and-loss', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return reports.profitAndLoss(parse(MonthQuery, req.query).month ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7)); }));
  app.get('/v1/admin/reports/sales', (req, reply) => guard(req, [['Payments', 'View'], ['Reports', 'View']], async () => { NoStore(reply); return reports.sales(parse(SalesQuerySchema, req.query)); }));
  app.get('/v1/admin/reports/delivery-cost', (req, reply) => guard(req, [['Payments', 'View'], ['Reports', 'View']], async () => { NoStore(reply); return reports.deliveryCost(parse(MonthQuery, req.query).month ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7)); }));

  // ============ payments, failures, reconciliation ===============================================================
  app.get('/v1/admin/payments', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return payments.list(parse(PaymentListSchema, req.query)); }));
  app.get('/v1/admin/payments/:id', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return payments.detail(parse(IdParam, req.params).id); }));
  app.post('/v1/admin/payments/retry-eligible', (req) => guard(req, P('Edit'), (a) => payments.retryEligible(a)));
  app.post('/v1/admin/payments/:id/retry', (req) => guard(req, P('Edit'), (a) => payments.retry(parse(IdParam, req.params).id, a)));
  // The payment service reports a failed attempt (the same call that confirms a payment reports a failure).
  app.post('/v1/orders/:id/payment-failure', { config: { critical: true } }, async (req) => {
    requireRole(req, 'payments');
    return payments.recordFailure(parse(IdParam, req.params).id, parse(FailureSchema, req.body), { id: 'payments-service', requestId: String(req.id), name: 'Payment service' });
  });

  app.get('/v1/admin/reconciliation', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return (await payments.statement()) ?? { id: null, lines: [] }; }));
  app.get('/v1/admin/reconciliation/:id', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); const s = await payments.statement(parse(IdParam, req.params).id); if (!s) throw new NotFoundError('Statement'); return s; }));
  app.post('/v1/admin/reconciliation', (req, reply) => guard(req, P('Edit'), async (a) => reply.status(201).send(await payments.importStatement(parse(StatementImportSchema, req.body), a))));
  app.post('/v1/admin/reconciliation/:id/lines/:lineId/resolve', (req) => guard(req, P('Edit'), (a) => { const p = parse(LineParams, req.params); return payments.resolveLine(p.id, p.lineId, parse(ResolveLineSchema, req.body), a); }));
  app.post('/v1/admin/reconciliation/:id/complete', (req) => guard(req, P('Edit'), (a) => payments.completeStatement(parse(IdParam, req.params).id, a)));

  // ============ payout batches and settlements (cash held by riders is under /v1/admin/cash) ======================

  app.get('/v1/admin/payout-batches', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return cash.batches(); }));
  app.get('/v1/admin/payout-batches/:id', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return cash.batch(parse(IdParam, req.params).id); }));
  app.post('/v1/admin/payout-batches', (req, reply) => guard(req, P('Create'), async (a, ctx) => reply.status(201).send(await cash.createBatch(parse(NewBatchSchema, req.body), fa(a, ctx)))));
  app.patch('/v1/admin/payout-batches/:id', (req) => guard(req, P('Edit'), (a, ctx) => cash.updateBatch(parse(IdParam, req.params).id, parse(BatchPatchSchema, req.body), fa(a, ctx))));
  app.delete('/v1/admin/payout-batches/:id', (req, reply) => guard(req, P('Edit'), async (a, ctx) => { await cash.deleteBatch(parse(IdParam, req.params).id, fa(a, ctx)); return reply.status(204).send(); }));
  app.post('/v1/admin/payout-batches/:id/send', (req) => guard(req, P('Edit'), (a, ctx) => cash.sendBatch(parse(IdParam, req.params).id, fa(a, ctx))));

  app.get('/v1/admin/settlements', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return cash.settlements(); }));
  app.post('/v1/admin/settlements/:id/pay', (req) => guard(req, P('Edit'), (a, ctx) => cash.paySettlement(parse(SettlementParams, req.params).id, parse(SettlementPaySchema, req.body), fa(a, ctx))));

  // ============ expenses and invoices ===============================================================================
  app.get('/v1/admin/expenses', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return billing.expenses(parse(ExpenseListSchema, req.query)); }));
  app.get('/v1/admin/expenses/:id', (req) => guard(req, P('View'), () => billing.expense(parse(IdParam, req.params).id)));
  app.post('/v1/admin/expenses', (req, reply) => guard(req, P('Create'), async (a, ctx) => reply.status(201).send(await billing.addExpense(parse(ExpenseSchema, req.body), fa(a, ctx)))));
  app.post('/v1/admin/expenses/:id/decision', (req) => guard(req, P('Edit'), (a, ctx) => billing.decideExpense(parse(IdParam, req.params).id, parse(ExpenseDecisionSchema, req.body), fa(a, ctx))));

  app.get('/v1/admin/invoices', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return billing.invoices(parse(InvoiceListSchema, req.query)); }));
  app.get('/v1/admin/invoices/:id', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return billing.invoice(parse(IdParam, req.params).id); }));
  app.post('/v1/admin/invoices', (req, reply) => guard(req, P('Create'), async (a, ctx) => reply.status(201).send(await billing.createInvoice(parse(InvoiceSchema, req.body), fa(a, ctx)))));
  app.post('/v1/admin/invoices/:id/send', (req) => guard(req, P('Edit'), (a, ctx) => billing.sendInvoice(parse(IdParam, req.params).id, fa(a, ctx))));
  app.post('/v1/admin/invoices/:id/payments', (req) => guard(req, P('Edit'), (a, ctx) => billing.recordPayment(parse(IdParam, req.params).id, parse(InvoicePaymentSchema, req.body), fa(a, ctx))));
  app.post('/v1/admin/invoices/:id/remind', (req) => guard(req, P('Edit'), (a, ctx) => billing.remind(parse(IdParam, req.params).id, fa(a, ctx))));
  app.delete('/v1/admin/invoices/:id', (req, reply) => guard(req, P('Edit'), async (a, ctx) => { await billing.deleteDraft(parse(IdParam, req.params).id, fa(a, ctx)); return reply.status(204).send(); }));

  // ============ VAT, closing periods, exports ===============================================================================
  app.get('/v1/admin/vat', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return reports.vat(); }));
  app.post('/v1/admin/vat/:month/prepare', (req) => guard(req, P('Edit'), (a, ctx) => reports.prepareFiling(parse(MonthParam, req.params).month, fa(a, ctx))));
  app.post('/v1/admin/vat/:month/file', (req) => guard(req, P('Edit'), (a, ctx) => reports.fileReturn(parse(MonthParam, req.params).month, parse(FilingSchema, req.body), fa(a, ctx))));

  app.get('/v1/admin/periods', (req) => guard(req, P('View'), () => reports.periods()));
  app.get('/v1/admin/periods/:month', (req, reply) => guard(req, P('View'), async () => { NoStore(reply); return reports.closeStatus(parse(MonthParam, req.params).month); }));
  app.post('/v1/admin/periods/:month/close', (req) => guard(req, P('Edit'), (a, ctx) => reports.closePeriod(parse(MonthParam, req.params).month, parse(CloseSchema, req.body), fa(a, ctx))));
  app.delete('/v1/admin/periods/:month', (req) => guard(req, P('Edit'), (a, ctx) => reports.reopenPeriod(parse(MonthParam, req.params).month, fa(a, ctx))));

  app.get('/v1/admin/exports', (req) => guard(req, P('Export'), () => reports.exports()));
  app.post('/v1/admin/exports', (req, reply) => {
    const input = parse(ExportSchema, req.body);
    // Payroll figures need payroll access, not just finance access.
    return guard(req, input.dataset === 'Payroll summary' ? R('Export') : P('Export'), async (a, ctx) => {
      const out = await reports.exportData(input, fa(a, ctx));
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${out.filename}"`).header('cache-control', 'no-store').header('x-export-rows', String(out.rows)).send(out.csv);
    });
  });

  // ============ payroll ===========================================================================================
  app.get('/v1/admin/payroll/profiles', (req, reply) => guard(req, R('View'), async () => { NoStore(reply); return payroll.profiles(); }));
  app.patch('/v1/admin/payroll/profiles/:id', (req) => guard(req, R('Edit'), (a, ctx) => payroll.saveProfile(parse(IdParam, req.params).id, parse(ProfilePatchSchema, req.body), fa(a, ctx))));
  app.get('/v1/admin/payroll/statutory', (req) => guard(req, R('View'), () => payroll.statutory()));
  app.put('/v1/admin/payroll/statutory', (req) => guard(req, R('Edit'), (a, ctx) => payroll.saveStatutory(parse(StatutoryBody, req.body), fa(a, ctx))));
  app.get('/v1/admin/payroll/runs', (req, reply) => guard(req, R('View'), async () => { NoStore(reply); return payroll.runs(); }));
  app.get('/v1/admin/payroll/runs/:id', (req, reply) => guard(req, R('View'), async () => { NoStore(reply); return payroll.run(parse(IdParam, req.params).id); }));
  app.post('/v1/admin/payroll/runs', (req, reply) => guard(req, R('Create'), async (a, ctx) => reply.status(201).send(await payroll.prepare(parse(NewRunSchema, req.body).month, fa(a, ctx)))));
  app.post('/v1/admin/payroll/runs/:id/adjust/:staffId', (req) => guard(req, R('Edit'), (a, ctx) => { const p = parse(StaffParams, req.params); return payroll.adjust(p.id, p.staffId, parse(AdjustSchema, req.body), fa(a, ctx)); }));
  app.post('/v1/admin/payroll/runs/:id/action', (req) => guard(req, R('Edit'), (a, ctx) => payroll.act(parse(IdParam, req.params).id, parse(RunActionSchema, req.body).action, fa(a, ctx))));
  app.get('/v1/admin/payroll/runs/:id/payslips/:staffId', (req, reply) => guard(req, R('View'), async () => { NoStore(reply); const p = parse(StaffParams, req.params); return payroll.payslip(p.id, p.staffId); }));
  app.post('/v1/admin/payroll/runs/:id/remittances', (req) => guard(req, R('Edit'), (a, ctx) => payroll.remit(parse(IdParam, req.params).id, parse(RemitSchema, req.body), fa(a, ctx))));
}
