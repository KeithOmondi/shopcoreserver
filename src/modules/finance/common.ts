import { z } from 'zod';
import type { Queryable } from '../../infra/db.js';
import { UnprocessableError } from '../../domain/errors.js';

export const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'use YYYY-MM');
export const Money = z.number().int().min(0).max(100_000_000_000);

/** Business time is Nairobi (UTC+3, no daylight saving). */
export const TZ = 'Africa/Nairobi';
export const monthOf = (col: string) => `to_char(${col} AT TIME ZONE '${TZ}', 'YYYY-MM')`;
export const shiftMonth = (key: string, by: number) => {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export const currentMonth = (now = new Date()) => {
  const t = new Date(now.getTime() + 3 * 3_600_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
};
/** [start, end) of a month as instants. */
export const monthRange = (key: string): [string, string] => [`${key}-01T00:00:00+03:00`, `${shiftMonth(key, 1)}-01T00:00:00+03:00`];
/** The month a date falls in, in Nairobi. */
export const monthOfDate = (d: Date | string) => currentMonth(new Date(d));

// ---- settings --------------------------------------------------------------------------------------------------------------------------

export const FinanceSettingsSchema = z.strictObject({
  /** Product cost as a share of product sales (%), until real costs flow from purchasing. */
  cogsRate: z.number().min(0).max(100),
  /** Share of product sales kept from partner stores (%). */
  storeCommission: z.number().min(0).max(100),
  /** Payment processing cost (% of card and M-Pesa sales). */
  processingFee: z.number().min(0).max(20),
  /** A rider must hand in cash within this many hours. */
  codWindowHours: z.number().int().min(1).max(720),
  /** An expense above this needs an owner. */
  expenseLimitCents: Money,
  vatRate: z.number().min(0).max(100),
});
export type FinanceSettings = z.infer<typeof FinanceSettingsSchema>;
export const FINANCE_DEFAULTS: FinanceSettings = { cogsRate: 68, storeCommission: 12, processingFee: 1.5, codWindowHours: 24, expenseLimitCents: 100_000_00, vatRate: 16 };

export async function financeSettings(c: Queryable): Promise<FinanceSettings> {
  const r = (await c.query<{ value: Partial<FinanceSettings> }>(`SELECT value FROM settings WHERE key = 'finance.settings'`)).rows[0];
  return { ...FINANCE_DEFAULTS, ...(r?.value ?? {}) };
}

/** A closed accounting period takes no new entries until an owner reopens it. */
export async function assertOpen(c: Queryable, when: Date | string = new Date()) {
  const key = monthOfDate(when);
  if ((await c.query('SELECT 1 FROM period_closes WHERE month = $1', [key])).rowCount) {
    throw new UnprocessableError('PERIOD_CLOSED', `${key} is a closed accounting period. An owner must reopen it first`, { month: key });
  }
}

export const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Cells that start with a formula character are quoted with a leading apostrophe so a spreadsheet won’t run them.
  const safe = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const toCsv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
export const kesFrom = (cents: number | string) => Math.round(Number(cents)) / 100;
