import { createHash, randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database, Queryable } from '../../infra/db.js';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { patchOf } from '../../http/validate.js';
import { normalisePhone, type SmsSender } from '../dispatch/riders.js';
import { audit } from '../products/products.js';

const phone = z.string().trim().transform((v, ctx) => { const p = normalisePhone(v); if (!p) ctx.addIssue({ code: 'custom', message: 'Enter a valid Kenyan phone number' }); return p ?? v; });

export const AddressSchema = z.strictObject({
  label: z.enum(['Home', 'Work', 'Other']).default('Home'),
  fullName: z.string().trim().min(2).max(120),
  phone,
  county: z.string().trim().min(1).max(40),
  area: z.string().trim().min(1).max(60),
  street: z.string().trim().min(3).max(200),
  isDefault: z.boolean().default(false),
});
export const AddressPatchSchema = patchOf(AddressSchema);

export const PreferencesSchema = z.strictObject({
  orders: z.boolean(), returns: z.boolean(), deals: z.boolean(), stock: z.boolean(), recs: z.boolean(),
  push: z.boolean(), email: z.boolean(), sms: z.boolean(),
  language: z.enum(['en', 'sw']),
});
export const PreferencesPatchSchema = patchOf(PreferencesSchema);
/** Order and return updates are on until the person turns them off; offers, stock alerts and suggestions are off until they ask. */
const TOPIC_DEFAULTS = { orders: true, returns: true, deals: false, stock: false, recs: false };

export const DobSchema = z.strictObject({ day: z.number().int().min(1).max(31), month: z.number().int().min(1).max(12), year: z.number().int().min(1900).max(new Date().getFullYear()) });
export const ProfileUpdateSchema = z.strictObject({
  fullName: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(254), dob: DobSchema.nullable(),
}).partial().refine((v) => Object.keys(v).length > 0, 'nothing to change');
export const PhoneChangeSchema = z.strictObject({ phone });
export const PhoneVerifySchema = z.strictObject({ code: z.string().regex(/^\d{6}$/, 'The code is 6 digits') });

const MAX_ADDRESSES = 10;
const hashCode = (who: string, c: string) => createHash('sha256').update(`${who}|${c}`).digest('base64url');

interface AddrRow { id: string; label: string; full_name: string; phone: string; county: string; area: string; street: string; is_default: boolean }
const addrView = (r: AddrRow) => ({ id: r.id, label: r.label, fullName: r.full_name, phone: r.phone, county: r.county, area: r.area, street: r.street, isDefault: r.is_default });

/** Where the shop delivers: each county with its areas, and what each area costs. */
export async function deliveryAreas(c: Queryable) {
  const zones = (await c.query<{ id: string; name: string; county: string; fee_cents: number; areas: string[] }>('SELECT id, name, county, fee_cents, areas FROM zones WHERE active ORDER BY county, sort_order')).rows;
  const s = (await c.query<{ key: string; value: number }>(`SELECT key, value FROM settings WHERE key IN ('delivery.base_fee_cents', 'delivery.min_basket_cents')`)).rows;
  const get = (k: string) => Number(s.find((r) => r.key === k)?.value ?? 0) || 0;
  const byCounty = new Map<string, { name: string; zone: string; feeCents: number }[]>();
  for (const z of zones) for (const a of z.areas) byCounty.set(z.county, [...(byCounty.get(z.county) ?? []), { name: a, zone: z.name, feeCents: z.fee_cents }]);
  return {
    counties: [...byCounty.entries()].map(([county, areas]) => ({ county, areas: areas.sort((a, b) => a.name.localeCompare(b.name)) })),
    baseFeeCents: get('delivery.base_fee_cents'), minBasketCents: get('delivery.min_basket_cents'),
  };
}

export class CustomerAccountService {
  constructor(private readonly db: Database, private readonly cfg: Config, private readonly sms: SmsSender) {}

  async areas() { return this.db.read((c) => deliveryAreas(c)); }

  // ---- addresses ----------------------------------------------------------------------------------------------------------------------

  async addresses(customerId: string) {
    return this.db.read(async (c) => ({ items: (await c.query<AddrRow>('SELECT * FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at', [customerId])).rows.map(addrView) }));
  }

  /** We only save places the shop delivers to, so an address in the book can always be ordered to. */
  private async assertServed(c: Queryable, county: string, area: string) {
    const ok = (await c.query(`SELECT 1 FROM zones WHERE active AND lower(county) = lower($1) AND EXISTS (SELECT 1 FROM unnest(areas) a WHERE lower(a) = lower($2))`, [county, area])).rowCount;
    if (!ok) throw new UnprocessableError('AREA_NOT_SERVED', 'We don’t deliver to that area yet', { county, area });
  }

  /** Stores the canonical spelling of the area (as the shop lists it), so fees and zones match exactly. */
  private async canonicalArea(c: Queryable, county: string, area: string) {
    return (await c.query<{ a: string; county: string }>(`SELECT a, z.county FROM zones z, unnest(z.areas) a WHERE z.active AND lower(z.county) = lower($1) AND lower(a) = lower($2) LIMIT 1`, [county, area])).rows[0]!;
  }

  async addAddress(customerId: string, input: z.infer<typeof AddressSchema>) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      await c.query('SELECT 1 FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM customer_addresses WHERE customer_id = $1', [customerId])).rows[0]!.n;
      if (n >= MAX_ADDRESSES) throw new UnprocessableError('TOO_MANY_ADDRESSES', `You can save up to ${MAX_ADDRESSES} addresses`);
      await this.assertServed(c, input.county, input.area);
      const canon = await this.canonicalArea(c, input.county, input.area);
      const makeDefault = input.isDefault || n === 0;
      if (makeDefault) await c.query('UPDATE customer_addresses SET is_default = false WHERE customer_id = $1', [customerId]);
      await c.query('INSERT INTO customer_addresses (id, customer_id, label, full_name, phone, county, area, street, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, customerId, input.label, input.fullName, input.phone, canon.county, canon.a, input.street, makeDefault]);
    });
    return (await this.addresses(customerId)).items.find((a) => a.id === id)!;
  }

  async updateAddress(customerId: string, id: string, patch: Partial<z.infer<typeof AddressSchema>>) {
    await this.db.tx(async (c) => {
      const cur = (await c.query<AddrRow>('SELECT * FROM customer_addresses WHERE id = $1 AND customer_id = $2 FOR UPDATE', [id, customerId])).rows[0];
      if (!cur) throw new NotFoundError('Address');
      const m = { label: cur.label, fullName: cur.full_name, phone: cur.phone, county: cur.county, area: cur.area, street: cur.street, ...patch };
      let county = m.county, area = m.area;
      if (patch.county !== undefined || patch.area !== undefined) {
        await this.assertServed(c, m.county, m.area);
        const canon = await this.canonicalArea(c, m.county, m.area);
        county = canon.county; area = canon.a;
      }
      if (patch.isDefault) await c.query('UPDATE customer_addresses SET is_default = false WHERE customer_id = $1 AND id <> $2', [customerId, id]);
      await c.query('UPDATE customer_addresses SET label=$3, full_name=$4, phone=$5, county=$6, area=$7, street=$8, is_default = COALESCE($9, is_default), updated_at = now() WHERE id = $1 AND customer_id = $2',
        [id, customerId, m.label, m.fullName, m.phone, county, area, m.street, patch.isDefault ?? null]);
    });
    return (await this.addresses(customerId)).items.find((a) => a.id === id)!;
  }

  async deleteAddress(customerId: string, id: string) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ is_default: boolean }>('DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2 RETURNING is_default', [id, customerId])).rows[0];
      if (!r) throw new NotFoundError('Address');
      // If the default went, the oldest remaining address takes over.
      if (r.is_default) await c.query('UPDATE customer_addresses SET is_default = true WHERE id = (SELECT id FROM customer_addresses WHERE customer_id = $1 ORDER BY created_at LIMIT 1)', [customerId]);
    });
  }

  // ---- preferences ----------------------------------------------------------------------------------------------------------------------------

  async preferences(customerId: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<{ push_opt_in: boolean; email_opt_in: boolean; sms_opt_in: boolean; notify_topics: Partial<typeof TOPIC_DEFAULTS>; language: 'en' | 'sw' }>('SELECT push_opt_in, email_opt_in, sms_opt_in, notify_topics, language FROM customers WHERE id = $1', [customerId])).rows[0];
      if (!r) throw new NotFoundError('Account');
      return { ...TOPIC_DEFAULTS, ...r.notify_topics, push: r.push_opt_in, email: r.email_opt_in, sms: r.sms_opt_in, language: r.language };
    });
  }

  async setPreferences(customerId: string, patch: Partial<z.infer<typeof PreferencesSchema>>) {
    await this.db.tx(async (c) => {
      const cur = await this.preferences(customerId);
      const m = { ...cur, ...patch };
      await c.query('UPDATE customers SET push_opt_in=$2, email_opt_in=$3, sms_opt_in=$4, notify_topics=$5, language=$6, consent_at = now(), updated_at = now() WHERE id = $1',
        [customerId, m.push, m.email, m.sms, JSON.stringify({ orders: m.orders, returns: m.returns, deals: m.deals, stock: m.stock, recs: m.recs }), m.language]);
    });
    return this.preferences(customerId);
  }

  // ---- profile: birth date and a changed phone number ---------------------------------------------------------------------------------------------

  async profile(customerId: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<{ id: string; name: string; email: string; phone: string; dob: string | null; created_at: Date }>(
        `SELECT cu.id, cu.name, a.email, a.phone, to_char(cu.dob, 'YYYY-MM-DD') AS dob, a.created_at FROM customers cu JOIN customer_accounts a ON a.id = cu.id WHERE cu.id = $1 AND a.status = 'active'`, [customerId])).rows[0];
      if (!r) throw new NotFoundError('Account');
      const [y, m, d] = r.dob ? r.dob.split('-').map(Number) : [];
      return { id: r.id, fullName: r.name, email: r.email, phone: r.phone, dob: r.dob ? { day: d!, month: m!, year: y! } : null, joinedAt: r.created_at.toISOString() };
    });
  }

  async updateProfile(customerId: string, input: z.infer<typeof ProfileUpdateSchema>) {
    await this.db.tx(async (c) => {
      if (input.email && (await c.query(`SELECT 1 FROM customer_accounts WHERE email = $1 AND status = 'active' AND id <> $2`, [input.email, customerId])).rowCount) throw new ConflictError('EMAIL_EXISTS', 'An account with this email already exists', { field: 'email' });
      const dob = input.dob === undefined ? undefined : input.dob === null ? null : `${input.dob.year}-${String(input.dob.month).padStart(2, '0')}-${String(input.dob.day).padStart(2, '0')}`;
      if (dob && Number.isNaN(Date.parse(dob))) throw new UnprocessableError('BAD_DATE', 'That isn’t a real date', { field: 'dob' });
      if (dob && new Date(dob).toISOString().slice(0, 10) !== dob) throw new UnprocessableError('BAD_DATE', 'That isn’t a real date', { field: 'dob' });
      await c.query('UPDATE customers SET name = COALESCE($2, name), email = COALESCE($3, email), dob = CASE WHEN $4::boolean THEN $5::date ELSE dob END, updated_at = now(), version = version + 1 WHERE id = $1',
        [customerId, input.fullName ?? null, input.email ?? null, dob !== undefined, dob ?? null]);
      if (input.email) await c.query('UPDATE customer_accounts SET email = $2 WHERE id = $1', [customerId, input.email]);
    });
    return this.profile(customerId);
  }

  /** Step one of changing a number: a code goes to the NEW number. */
  async requestPhoneChange(customerId: string, newPhone: string) {
    const code = this.cfg.CUSTOMER_DEV_OTP && this.cfg.NODE_ENV !== 'production' ? this.cfg.CUSTOMER_DEV_OTP : String(randomInt(100000, 1000000));
    await this.db.tx(async (c) => {
      if ((await c.query(`SELECT 1 FROM customer_accounts WHERE phone = $1 AND status = 'active'`, [newPhone])).rowCount) throw new ConflictError('PHONE_EXISTS', 'An account with this phone number already exists', { field: 'phone' });
      const prev = (await c.query<{ sent_at: Date }>('SELECT sent_at FROM customer_phone_changes WHERE customer_id = $1', [customerId])).rows[0];
      if (prev && Date.now() - prev.sent_at.getTime() < 30_000) throw new AppError('CODE_TOO_SOON', 'Wait a moment before asking for another code', 429, undefined, 30);
      await c.query(
        `INSERT INTO customer_phone_changes (customer_id, new_phone, code_hash, expires_at) VALUES ($1,$2,$3, now() + interval '10 minutes')
         ON CONFLICT (customer_id) DO UPDATE SET new_phone = $2, code_hash = $3, attempts = 0, sent_at = now(), expires_at = now() + interval '10 minutes'`, [customerId, newPhone, hashCode(customerId + newPhone, code)]);
    });
    await this.sms.send(newPhone, `Your ShopCore code is ${code}. It expires in 10 minutes.`);
  }

  /** Step two: the right code switches the number (and the number that sign-in and delivery calls use). */
  async verifyPhoneChange(customerId: string, code: string) {
    let wrong = false;
    await this.db.tx(async (c) => {
      const r = (await c.query<{ new_phone: string; code_hash: string; attempts: number; expired: boolean }>('SELECT new_phone, code_hash, attempts, (expires_at < now()) AS expired FROM customer_phone_changes WHERE customer_id = $1 FOR UPDATE', [customerId])).rows[0];
      if (!r || r.expired) throw new UnprocessableError('CODE_EXPIRED', 'That code has expired. Ask for a new one.');
      if (r.attempts >= 5) throw new AppError('CODE_LOCKED', 'Too many wrong codes. Ask for a new one.', 429);
      if (r.code_hash !== hashCode(customerId + r.new_phone, code)) { wrong = true; await c.query('UPDATE customer_phone_changes SET attempts = attempts + 1 WHERE customer_id = $1', [customerId]); return; }
      await c.query('DELETE FROM customer_phone_changes WHERE customer_id = $1', [customerId]);
      await c.query('UPDATE customer_accounts SET phone = $2 WHERE id = $1', [customerId, r.new_phone])
        .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('PHONE_EXISTS', 'An account with this phone number already exists', { field: 'phone' }); throw e; });
      await c.query('UPDATE customers SET phone = $2, updated_at = now() WHERE id = $1', [customerId, r.new_phone]);
      await audit(c, { id: customerId, requestId: `phone:${customerId}` }, 'customer.phone_changed', 'customer', customerId, {});
    });
    if (wrong) throw new UnprocessableError('WRONG_CODE', 'That code isn’t right. Check the SMS and try again.');
    return this.profile(customerId);
  }
}
