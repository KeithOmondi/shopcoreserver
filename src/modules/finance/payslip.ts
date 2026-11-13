import { z } from 'zod';

/**
 * Kenya statutory deductions. These are settings, not code, because they change by law: the owner’s accountant confirms the
 * rates before the first real payroll. Amounts are in cents; a band with no size (null) has no upper limit.
 */
export const StatutorySchema = z.strictObject({
  nssfRate: z.number().min(0).max(30),
  nssfLowerCents: z.number().int().min(0),
  nssfUpperCents: z.number().int().min(0),
  shifRate: z.number().min(0).max(30),
  shifMinCents: z.number().int().min(0),
  housingRate: z.number().min(0).max(30),
  reliefCents: z.number().int().min(0),
  bands: z.array(z.tuple([z.number().int().min(1).nullable(), z.number().min(0).max(100)])).min(1).max(10)
    .refine((b) => b.slice(0, -1).every(([s]) => s !== null) && b[b.length - 1]![0] === null, 'every band needs a size except the last, which has none'),
});
export type Statutory = z.infer<typeof StatutorySchema>;

export const STATUTORY_DEFAULTS: Statutory = {
  nssfRate: 6, nssfLowerCents: 9_000_00, nssfUpperCents: 108_000_00, shifRate: 2.75, shifMinCents: 300_00, housingRate: 1.5, reliefCents: 2_400_00,
  bands: [[24_000_00, 10], [8_333_00, 25], [467_667_00, 30], [300_000_00, 32.5], [null, 35]],
};

export interface PayProfile { basicCents: number; houseCents: number; transportCents: number }
export interface PayAdjust { bonusCents: number; otherDeductionCents: number }
export interface Slip {
  basicCents: number; allowancesCents: number; bonusCents: number; grossCents: number;
  nssfCents: number; shifCents: number; housingCents: number; taxableCents: number; payeCents: number;
  otherDeductionCents: number; netCents: number; employerNssfCents: number; employerHousingCents: number;
}

function bandTax(taxable: number, bands: Statutory['bands']) {
  let left = taxable;
  let tax = 0;
  for (const [size, rate] of bands) {
    if (left <= 0) break;
    const part = size === null ? left : Math.min(left, size);
    tax += (part * rate) / 100;
    left -= part;
  }
  return tax;
}

export function calcSlip(p: PayProfile, st: Statutory, adj: PayAdjust): Slip {
  const allowances = p.houseCents + p.transportCents;
  const gross = p.basicCents + allowances + adj.bonusCents;
  const nssf = Math.round((Math.min(gross, st.nssfUpperCents) * st.nssfRate) / 100);
  const shif = gross === 0 ? 0 : Math.round(Math.max(st.shifMinCents, (gross * st.shifRate) / 100));
  const housing = Math.round((gross * st.housingRate) / 100);
  const taxable = Math.max(0, gross - nssf - shif - housing);
  const paye = Math.max(0, Math.round(bandTax(taxable, st.bands) - st.reliefCents));
  const net = gross - nssf - shif - housing - paye - adj.otherDeductionCents;
  return { basicCents: p.basicCents, allowancesCents: allowances, bonusCents: adj.bonusCents, grossCents: gross, nssfCents: nssf, shifCents: shif, housingCents: housing, taxableCents: taxable, payeCents: paye, otherDeductionCents: adj.otherDeductionCents, netCents: net, employerNssfCents: nssf, employerHousingCents: housing };
}
