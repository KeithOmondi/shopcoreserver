import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { ConflictError, NotFoundError } from '../../domain/errors.js';
import { isUuid, uuidv7 } from '../../infra/uuid.js';
import { audit, type Actor } from '../products/products.js';

const uuid = z.string().refine(isUuid, 'must be a UUID');

export const ZoneSchema = z.strictObject({
  name: z.string().trim().min(1).max(60), feeCents: z.number().int().min(0).max(100_000_00), commissionPct: z.number().int().min(0).max(100).default(20),
  areas: z.array(z.string().trim().min(1).max(60)).max(100).default([]), note: z.string().trim().max(300).default(''), active: z.boolean().default(true),
  county: z.string().trim().min(1).max(40).default('Nairobi'),
});
export const ZonePatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(60), feeCents: z.number().int().min(0).max(100_000_00), commissionPct: z.number().int().min(0).max(100),
  areas: z.array(z.string().trim().min(1).max(60)).max(100), note: z.string().trim().max(300), active: z.boolean(), county: z.string().trim().min(1).max(40),
}).partial().refine((v) => Object.keys(v).length > 0, 'nothing to change');
/** Whether the shop is closed for maintenance, and the oldest app version still allowed to run. Staff set it; the apps read it at launch. */
export const AppStatusSchema = z.strictObject({
  maintenance: z.boolean(), message: z.string().trim().max(300).default(''),
  /** When service is expected back (ISO time), or null. */
  returnAt: z.string().datetime().nullable().default(null),
  minVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'), latestVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
});
export type AppStatus = z.infer<typeof AppStatusSchema>;
/** Who the business is: shown on invoices and receipts. */
export const BusinessProfileSchema = z.strictObject({
  name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(254).or(z.literal('')).default(''), phone: z.string().trim().max(32).default(''),
  kraPin: z.string().trim().toUpperCase().regex(/^[AP]\d{9}[A-Z]$/, 'A KRA PIN looks like P051234567X').or(z.literal('')).default(''), address: z.string().trim().max(200).default(''),
});
export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;
export const DeliverySettingsSchema = z.strictObject({ baseFeeCents: z.number().int().min(0).max(100_000_00), minBasketCents: z.number().int().min(0).max(100_000_000) });
export const ZoneIdParam = z.object({ id: uuid });

export interface Fee { zoneId: string | null; feeCents: number }

/** The delivery fee for an area: its zone’s fee, or the business’s base fee when no zone lists it. */
export async function feeFor(c: Queryable, area: string): Promise<Fee> {
  const z = (await c.query<{ id: string; fee_cents: number }>(
    `SELECT id, fee_cents FROM zones WHERE active AND EXISTS (SELECT 1 FROM unnest(areas) a WHERE lower(a) = lower($1)) ORDER BY sort_order LIMIT 1`, [area])).rows[0];
  if (z) return { zoneId: z.id, feeCents: z.fee_cents };
  return { zoneId: null, feeCents: (await deliverySettings(c)).baseFeeCents };
}

export async function deliverySettings(c: Queryable): Promise<z.infer<typeof DeliverySettingsSchema>> {
  const rows = (await c.query<{ key: string; value: number }>(`SELECT key, value FROM settings WHERE key IN ('delivery.base_fee_cents', 'delivery.min_basket_cents')`)).rows;
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.value ?? 0) || 0;
  return { baseFeeCents: get('delivery.base_fee_cents'), minBasketCents: get('delivery.min_basket_cents') };
}

interface ZoneRow { id: string; county: string; name: string; fee_cents: number; commission_pct: number; areas: string[]; note: string; active: boolean; riders: number }
const view = (r: ZoneRow) => ({ id: r.id, county: r.county, name: r.name, feeCents: r.fee_cents, commissionPct: r.commission_pct, areas: r.areas, note: r.note, active: r.active, riders: r.riders });

export class ZonesService {
  async businessProfile(): Promise<BusinessProfile> {
    const row = (await this.db.read((c) => c.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'business.profile'`))).rows[0];
    const parsed = BusinessProfileSchema.safeParse(row?.value ?? { name: 'ShopCore' });
    return parsed.success ? parsed.data : BusinessProfileSchema.parse({ name: 'ShopCore' });
  }

  async saveBusinessProfile(s: BusinessProfile, actor: Actor) {
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO settings (key, value, updated_by) VALUES ('business.profile',$1,$2) ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`, [JSON.stringify(s), actor.id]);
      await audit(c, actor, 'business.profile', 'setting', 'business.profile', { name: s.name });
    });
    return s;
  }

  async appStatus(): Promise<AppStatus> {
    const row = (await this.db.read((c) => c.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'app.status'`))).rows[0];
    const parsed = AppStatusSchema.safeParse(row?.value ?? { maintenance: false });
    return parsed.success ? parsed.data : AppStatusSchema.parse({ maintenance: false });
  }

  async saveAppStatus(s: AppStatus, actor: Actor) {
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO settings (key, value, updated_by) VALUES ('app.status',$1,$2) ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`, [JSON.stringify(s), actor.id]);
      await audit(c, actor, 'app.status', 'setting', 'app.status', s);
    });
    return s;
  }

  constructor(private readonly db: Database) {}

  async list() {
    return this.db.read(async (c) => {
      const zones = (await c.query<ZoneRow>(
        `SELECT z.*, count(r.id) FILTER (WHERE r.account_status = 'approved')::int AS riders FROM zones z LEFT JOIN riders r ON r.zone_id = z.id GROUP BY z.id ORDER BY z.sort_order, z.name`)).rows;
      return { items: zones.map(view), settings: await deliverySettings(c) };
    });
  }

  private async clashes(c: Queryable, areas: string[], exceptId: string | null) {
    if (!areas.length) return;
    const clash = (await c.query<{ name: string; area: string }>(
      `SELECT z.name, a AS area FROM zones z, unnest(z.areas) a WHERE z.active AND ($2::uuid IS NULL OR z.id <> $2) AND lower(a) = ANY($1::text[]) LIMIT 1`,
      [areas.map((a) => a.toLowerCase()), exceptId])).rows[0];
    if (clash) throw new ConflictError('AREA_IN_ANOTHER_ZONE', `${clash.area} already belongs to ${clash.name}. Remove it there first.`);
  }

  async create(input: z.infer<typeof ZoneSchema>, actor: Actor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      await this.clashes(c, input.areas, null);
      await c.query('INSERT INTO zones (id, name, fee_cents, commission_pct, areas, note, active, county, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT COALESCE(max(sort_order),0)+1 FROM zones))',
        [id, input.name, input.feeCents, input.commissionPct, input.areas, input.note, input.active, input.county])
        .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('ZONE_EXISTS', 'You already have a zone with that name'); throw e; });
      await audit(c, actor, 'zone.create', 'zone', id, input);
    });
    return (await this.list()).items.find((z) => z.id === id)!;
  }

  async update(id: string, p: z.infer<typeof ZonePatchSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      if (p.areas) await this.clashes(c, p.areas, id);
      const { rowCount } = await c.query(
        `UPDATE zones SET name = COALESCE($2, name), fee_cents = COALESCE($3, fee_cents), commission_pct = COALESCE($4, commission_pct), areas = COALESCE($5, areas),
                note = COALESCE($6, note), active = COALESCE($7, active), county = COALESCE($8, county), updated_at = now() WHERE id = $1`,
        [id, p.name ?? null, p.feeCents ?? null, p.commissionPct ?? null, p.areas ?? null, p.note ?? null, p.active ?? null, p.county ?? null])
        .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('ZONE_EXISTS', 'You already have a zone with that name'); throw e; }) as { rowCount: number };
      if (!rowCount) throw new NotFoundError('Zone');
      await audit(c, actor, 'zone.update', 'zone', id, p);
    });
    return (await this.list()).items.find((z) => z.id === id)!;
  }

  async remove(id: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const n = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM riders WHERE zone_id = $1 AND account_status IN ('approved','pending')`, [id])).rows[0]!.n;
      if (n > 0) throw new ConflictError('ZONE_IN_USE', `${n} rider${n === 1 ? ' is' : 's are'} based in this zone. Move them first.`);
      const { rowCount } = await c.query('DELETE FROM zones WHERE id = $1', [id]);
      if (!rowCount) throw new NotFoundError('Zone');
      await audit(c, actor, 'zone.delete', 'zone', id, {});
    });
  }

  async saveSettings(s: z.infer<typeof DeliverySettingsSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      for (const [key, value] of [['delivery.base_fee_cents', s.baseFeeCents], ['delivery.min_basket_cents', s.minBasketCents]] as const) {
        await c.query(`INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`, [key, JSON.stringify(value), actor.id]);
      }
      await audit(c, actor, 'delivery.settings', 'setting', 'delivery', s);
    });
    return s;
  }
}
