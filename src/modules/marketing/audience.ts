import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { audit, type Actor } from '../products/products.js';
import { patchOf } from '../../http/validate.js';

export const ALL_CUSTOMERS = '00000000-0000-7000-8000-000000000001';

export const RULE_OPS = {
  area: ['is', 'is not'],
  spend: ['greater than', 'less than'],
  orders: ['at least', 'at most'],
  lastOrder: ['within last (days)', 'more than (days) ago', 'never'],
} as const;
export const RuleSchema = z.strictObject({
  field: z.enum(['area', 'spend', 'orders', 'lastOrder']),
  op: z.string().max(40),
  value: z.string().trim().max(80).default(''),
}).superRefine((r, ctx) => {
  if (!(RULE_OPS[r.field] as readonly string[]).includes(r.op)) ctx.addIssue({ code: 'custom', path: ['op'], message: `not a valid choice for ${r.field}` });
  else if (r.field === 'area' && !r.value) ctx.addIssue({ code: 'custom', path: ['value'], message: 'enter an area' });
  else if (r.field !== 'area' && r.op !== 'never' && !(r.value !== '' && Number.isFinite(Number(r.value)) && Number(r.value) >= 0)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'enter a number' });
});
export type Rule = z.infer<typeof RuleSchema>;

export const SegmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  purpose: z.enum(['Campaign audience', 'Loyalty tier', 'Internal analysis']).default('Campaign audience'),
  match: z.enum(['all', 'any']).default('all'),
  rules: z.array(RuleSchema).max(10).default([]),
  description: z.string().trim().max(300).default(''),
});
export const SegmentPatchSchema = patchOf(SegmentSchema);
export const PreviewSchema = z.strictObject({ match: z.enum(['all', 'any']).default('all'), rules: z.array(RuleSchema).max(10).default([]) });
export const PreferencesSchema = z.strictObject({ push: z.boolean(), email: z.boolean(), sms: z.boolean() });

/** One row per customer with what the rules look at. Orders count once paid. */
const FACTS = `(SELECT cu.id, cu.name, cu.area, cu.push_opt_in, cu.email_opt_in, cu.sms_opt_in, COALESCE(o.spend, 0)::bigint AS spend_cents, COALESCE(o.n, 0)::int AS orders, o.last_at
                  FROM customers cu LEFT JOIN (SELECT user_id, sum(total_cents) AS spend, count(*) AS n, max(created_at) AS last_at FROM orders WHERE status IN ('PAID','FULFILLED') GROUP BY user_id) o ON o.user_id = cu.id) f`;

/** The WHERE clause for a segment's rules. Fields and operators come from a fixed list; values are always parameters. */
export function segmentWhere(match: 'all' | 'any', rules: Rule[], params: unknown[]): string {
  if (!rules.length) return 'TRUE';
  const parts = rules.map((r) => {
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    switch (r.field) {
      case 'area': return r.op === 'is' ? `lower(f.area) = lower(${p(r.value)})` : `lower(f.area) <> lower(${p(r.value)})`;
      case 'spend': return `f.spend_cents ${r.op === 'greater than' ? '>' : '<'} ${p(Math.round(Number(r.value) * 100))}::bigint`;
      case 'orders': return `f.orders ${r.op === 'at least' ? '>=' : '<='} ${p(Math.floor(Number(r.value)))}::int`;
      default:
        if (r.op === 'never') return 'f.last_at IS NULL';
        return r.op.startsWith('within') ? `f.last_at >= now() - make_interval(days => ${p(Math.floor(Number(r.value)))}::int)` : `f.last_at < now() - make_interval(days => ${p(Math.floor(Number(r.value)))}::int)`;
    }
  });
  return `(${parts.join(match === 'all' ? ' AND ' : ' OR ')})`;
}

interface SegRow { id: string; name: string; purpose: string; match_mode: 'all' | 'any'; rules: Rule[]; description: string; is_system: boolean; version: number }
export interface Audience { total: number; push: number; email: number; sms: number }
const view = (s: SegRow, a?: Audience) => ({ id: s.id, name: s.name, purpose: s.purpose, match: s.match_mode, rules: s.rules, description: s.description, system: s.is_system, version: s.version, ...(a ? { audience: a } : {}) });

export async function audienceOf(c: Queryable, match: 'all' | 'any', rules: Rule[]): Promise<Audience> {
  const params: unknown[] = [];
  const where = segmentWhere(match, rules, params);
  return (await c.query<Audience>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE f.push_opt_in)::int AS push, count(*) FILTER (WHERE f.email_opt_in)::int AS email, count(*) FILTER (WHERE f.sms_opt_in)::int AS sms FROM ${FACTS} WHERE ${where}`, params)).rows[0]!;
}
export async function segmentAudience(c: Queryable, segmentId: string): Promise<Audience> {
  const s = (await c.query<SegRow>('SELECT * FROM segments WHERE id = $1', [segmentId])).rows[0];
  if (!s) throw new NotFoundError('Segment');
  return audienceOf(c, s.match_mode, s.rules);
}
/** Does this customer fall in the segment right now? */
export async function inSegment(c: Queryable, segmentId: string, customerId: string): Promise<boolean> {
  const s = (await c.query<SegRow>('SELECT * FROM segments WHERE id = $1', [segmentId])).rows[0];
  if (!s) return false;
  const params: unknown[] = [customerId];
  const where = segmentWhere(s.match_mode, s.rules, params);
  return !!(await c.query(`SELECT 1 FROM ${FACTS} WHERE f.id = $1 AND ${where}`, params)).rowCount;
}

export class AudienceService {
  constructor(private readonly db: Database) {}

  async list() {
    return this.db.read(async (c) => {
      const rows = (await c.query<SegRow>('SELECT * FROM segments ORDER BY is_system DESC, name')).rows;
      const used = new Set((await c.query<{ id: string }>(`SELECT segment_id AS id FROM pushes UNION ALL SELECT segment_id FROM messages UNION ALL SELECT segment_id FROM coupons WHERE segment_id IS NOT NULL`)).rows.map((r) => r.id));
      const items = [];
      for (const s of rows) items.push({ ...view(s, await audienceOf(c, s.match_mode, s.rules)), inUse: used.has(s.id) });
      return { items };
    });
  }

  async get(id: string) {
    return this.db.read(async (c) => {
      const s = (await c.query<SegRow>('SELECT * FROM segments WHERE id = $1', [id])).rows[0];
      if (!s) throw new NotFoundError('Segment');
      return view(s, await audienceOf(c, s.match_mode, s.rules));
    });
  }

  /** How many people some rules would reach, before they are saved. */
  async preview(input: z.infer<typeof PreviewSchema>) { return this.db.read((c) => audienceOf(c, input.match, input.rules)); }

  async save(id: string | null, input: Partial<z.infer<typeof SegmentSchema>>, actor: Actor) {
    const sid = id ?? uuidv7();
    await this.db.tx(async (c) => {
      if (id) {
        const cur = (await c.query<SegRow>('SELECT * FROM segments WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw new NotFoundError('Segment');
        if (cur.is_system) throw new ConflictError('SYSTEM_SEGMENT', 'This segment is built in and can’t be changed');
        const m = { name: cur.name, purpose: cur.purpose, match: cur.match_mode, rules: cur.rules, description: cur.description, ...input };
        if (input.name && (await c.query('SELECT 1 FROM segments WHERE lower(name) = lower($1) AND id <> $2', [m.name, id])).rowCount) throw new ConflictError('SEGMENT_EXISTS', 'A segment with that name already exists');
        await c.query('UPDATE segments SET name = $2, purpose = $3, match_mode = $4, rules = $5, description = $6, version = version + 1, updated_at = now() WHERE id = $1', [id, m.name, m.purpose, m.match, JSON.stringify(m.rules), m.description]);
      } else {
        const m = SegmentSchema.parse(input);
        if ((await c.query('SELECT 1 FROM segments WHERE lower(name) = lower($1)', [m.name])).rowCount) throw new ConflictError('SEGMENT_EXISTS', 'A segment with that name already exists');
        await c.query('INSERT INTO segments (id, name, purpose, match_mode, rules, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [sid, m.name, m.purpose, m.match, JSON.stringify(m.rules), m.description, actor.name ?? actor.id]);
      }
      await audit(c, actor, id ? 'segment.update' : 'segment.create', 'segment', sid, input);
    });
    return this.get(sid);
  }

  async remove(id: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const cur = (await c.query<{ is_system: boolean }>('SELECT is_system FROM segments WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new NotFoundError('Segment');
      if (cur.is_system) throw new ConflictError('SYSTEM_SEGMENT', 'This segment is built in and can’t be deleted');
      if ((await c.query(`SELECT 1 FROM pushes WHERE segment_id = $1 UNION ALL SELECT 1 FROM messages WHERE segment_id = $1 UNION ALL SELECT 1 FROM coupons WHERE segment_id = $1`, [id])).rowCount) {
        throw new UnprocessableError('SEGMENT_IN_USE', 'This segment is used by a campaign or coupon, so it can’t be deleted');
      }
      await c.query('DELETE FROM segments WHERE id = $1', [id]);
      await audit(c, actor, 'segment.delete', 'segment', id, {});
    });
  }

  // ---- what a shopper agreed to ---------------------------------------------------------------------------------------------------------------

  async preferences(customerId: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<{ push_opt_in: boolean; email_opt_in: boolean; sms_opt_in: boolean; consent_at: Date | null }>('SELECT push_opt_in, email_opt_in, sms_opt_in, consent_at FROM customers WHERE id = $1', [customerId])).rows[0];
      return { push: r?.push_opt_in ?? false, email: r?.email_opt_in ?? false, sms: r?.sms_opt_in ?? false, updatedAt: r?.consent_at?.toISOString() ?? null };
    });
  }

  async setPreferences(customerId: string, p: z.infer<typeof PreferencesSchema>) {
    await this.db.tx(async (c) => {
      await c.query('INSERT INTO customers (id) VALUES ($1) ON CONFLICT DO NOTHING', [customerId]);
      await c.query('UPDATE customers SET push_opt_in = $2, email_opt_in = $3, sms_opt_in = $4, consent_at = now() WHERE id = $1', [customerId, p.push, p.email, p.sms]);
    });
    return this.preferences(customerId);
  }
}
