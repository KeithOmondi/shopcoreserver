import { describe, expect, it } from 'vitest';
import { calcSlip, STATUTORY_DEFAULTS, StatutorySchema } from '../../src/modules/finance/payslip.js';

const none = { bonusCents: 0, otherDeductionCents: 0 };

describe('payslip', () => {
  it('works out a KES 100,000 salary the way the PAYE bands say', () => {
    const s = calcSlip({ basicCents: 100_000_00, houseCents: 0, transportCents: 0 }, STATUTORY_DEFAULTS, none);
    expect(s).toMatchObject({ grossCents: 100_000_00, nssfCents: 6_000_00, shifCents: 2_750_00, housingCents: 1_500_00, taxableCents: 89_750_00 });
    // 10% of 24,000 + 25% of 8,333 + 30% of the rest, less the KES 2,400 personal relief.
    expect(s.payeCents).toBe(240_000 + 208_325 + 1_722_510 - 240_000);
    expect(s.netCents).toBe(100_000_00 - 6_000_00 - 2_750_00 - 1_500_00 - s.payeCents);
  });

  it('caps NSSF at the upper limit, floors SHIF at its minimum and never goes below zero tax', () => {
    const rich = calcSlip({ basicCents: 400_000_00, houseCents: 0, transportCents: 0 }, STATUTORY_DEFAULTS, none);
    expect(rich.nssfCents).toBe(Math.round((108_000_00 * 6) / 100));
    const poor = calcSlip({ basicCents: 8_000_00, houseCents: 0, transportCents: 0 }, STATUTORY_DEFAULTS, none);
    expect(poor.shifCents).toBe(300_00);
    expect(poor.payeCents).toBe(0);
  });

  it('adds allowances and bonus to gross and takes other deductions off net only', () => {
    const s = calcSlip({ basicCents: 60_000_00, houseCents: 8_000_00, transportCents: 5_000_00 }, STATUTORY_DEFAULTS, { bonusCents: 10_000_00, otherDeductionCents: 2_000_00 });
    expect(s.grossCents).toBe(83_000_00);
    expect(s.allowancesCents).toBe(13_000_00);
    expect(s.netCents).toBe(s.grossCents - s.nssfCents - s.shifCents - s.housingCents - s.payeCents - 2_000_00);
    expect(s.taxableCents).toBe(s.grossCents - s.nssfCents - s.shifCents - s.housingCents);
  });

  it('refuses rates whose last band has a size', () => {
    expect(StatutorySchema.safeParse(STATUTORY_DEFAULTS).success).toBe(true);
    expect(StatutorySchema.safeParse({ ...STATUTORY_DEFAULTS, bands: [[1000, 10], [2000, 20]] }).success).toBe(false);
    expect(StatutorySchema.safeParse({ ...STATUTORY_DEFAULTS, bands: [[null, 10], [null, 20]] }).success).toBe(false);
  });
});
