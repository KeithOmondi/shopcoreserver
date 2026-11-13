/**
 * DEVELOPMENT ONLY. Adds sample pay profiles, expenses and invoices so the finance screens have something to show.
 *
 *   npm run demo:finance
 *
 * Safe to run twice: it does nothing if any expense already exists. Run `npm run staff -- demo` first for the pay profiles.
 */
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/infra/logger.js';
import { Database } from '../src/infra/db.js';
import { BillingService } from '../src/modules/finance/billing.js';
import { PayrollService } from '../src/modules/finance/payroll.js';
import type { FinanceActor } from '../src/modules/finance/cash.js';

/** Monthly [basic, house, transport] in whole shillings by role. */
const SALARY: Record<string, [number, number, number]> = {
  'Owner admin': [280_000, 40_000, 15_000], 'Operations manager': [150_000, 20_000, 10_000], 'Dispatch manager': [110_000, 15_000, 8_000], 'Finance analyst': [120_000, 15_000, 8_000],
  'Customer support': [62_000, 8_000, 5_000], 'Rider manager': [85_000, 10_000, 6_000], 'IT support': [95_000, 10_000, 6_000],
};
const EXPENSES: [number, string, string, string, number][] = [
  [2, 'Marketing', 'Meta Platforms', 'Customer acquisition campaign', 248_000], [4, 'Fuel & fleet', 'PetroCity Kenya', 'Rider fuel reimbursements', 86_400],
  [5, 'Software', 'CloudRoute Ltd', 'Monthly platform subscription', 54_000], [7, 'Office & hub', 'Nairobi Workspaces', 'Hub utilities and rent', 186_000],
  [9, 'Professional fees', 'Mwangi & Co. Advocates', 'Rider contract review', 72_000], [12, 'Insurance', 'Jubilee Insurance', 'Rider accident cover (monthly)', 64_500],
];

async function main() {
  const cfg = loadConfig({ ...process.env, JWT_ISSUER: process.env.JWT_ISSUER ?? 'x', JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'x', JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY ?? 'x' }, 'worker');
  if (cfg.NODE_ENV === 'production') throw new Error('Demo content can’t be created in production');
  const db = new Database(cfg, createLogger({ level: 'warn', service: 'demo-finance' }));
  const actor: FinanceActor = { id: 'system', name: 'Demo seed', requestId: 'demo-finance', isOwner: true };
  const billing = new BillingService(db);
  const payroll = new PayrollService(db);
  try {
    if ((await billing.expenses({ limit: 1 })).items.length) { console.log('Expenses already exist; nothing to do.'); return; }
    const staff = (await db.read((c) => c.query<{ id: string; role: string }>(`SELECT id, role FROM staff WHERE status = 'active'`))).rows;
    for (const s of staff) {
      const [basic, house, transport] = SALARY[s.role] ?? [60_000, 5_000, 4_000];
      await payroll.saveProfile(s.id, { basicCents: basic * 100, houseCents: house * 100, transportCents: transport * 100 }, actor);
    }
    const day = (ago: number) => new Date(Date.now() + 3 * 3_600_000 - ago * 86_400_000).toISOString().slice(0, 10);
    for (const [ago, category, payee, description, amount] of EXPENSES) await billing.addExpense({ date: day(ago), category, payee, description, amountCents: amount * 100 }, actor);
    const invoices: [string, string, string, number, number][] = [
      ['Kifaru Roasters Ltd', 'Joseph Kariuki', 'accounts@kifaru.co.ke', 118, 1_300], ['Coastline Home Ltd', 'Mercy Wanjiru', 'accounts@coastlinehome.co.ke', 42, 1_500],
      ['Savannah Bakers', 'Daniel Ouma', 'daniel@savannahbakers.co.ke', 64, 1_100],
    ];
    for (const [customer, contact, email, qty, unit] of invoices) {
      await billing.createInvoice({ customer, contact, email, pin: '', address: 'Nairobi, Kenya', dueInDays: 30, draft: false, lines: [{ description: 'Marketplace orders · month to date', quantity: qty, unitCents: unit * 100 }, { description: 'Delivery service fees', quantity: qty, unitCents: 180_00 }] }, actor);
    }
    console.log(`Added ${staff.length} pay profiles, ${EXPENSES.length} expenses and ${invoices.length} invoices.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
