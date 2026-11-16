import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { audit, type Actor } from '../products/products.js';
import { queuePush } from '../integrations/push.js';

/** What staff set for shopper rewards. */
export const RewardsSchema = z.strictObject({
  earnPerHundredKes: z.number().min(0).max(100),
  pointValueCents: z.number().int().min(1).max(100_000),
  minRedeemPoints: z.number().int().min(1).max(1_000_000),
  referralPoints: z.number().int().min(0).max(1_000_000),
  couponDays: z.number().int().min(1).max(365),
});
export type Rewards = z.infer<typeof RewardsSchema>;
export const RedeemSchema = z.strictObject({ points: z.number().int().min(1).max(10_000_000) });
const DEFAULTS: Rewards = { earnPerHundredKes: 1, pointValueCents: 100, minRedeemPoints: 100, referralPoints: 200, couponDays: 60 };
const KEYS: Record<keyof Rewards, string> = { earnPerHundredKes: 'rewards.earn_per_100', pointValueCents: 'rewards.point_value_cents', minRedeemPoints: 'rewards.min_redeem', referralPoints: 'rewards.referral_points', couponDays: 'rewards.coupon_days' };

export async function rewardsProgramme(c: Queryable): Promise<Rewards> {
  const rows = (await c.query<{ key: string; value: unknown }>('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [Object.values(KEYS)])).rows;
  const out = { ...DEFAULTS };
  for (const [f, k] of Object.entries(KEYS) as [keyof Rewards, string][]) {
    const v = rows.find((r) => r.key === k)?.value;
    if (v !== undefined && Number.isFinite(Number(v))) out[f] = Number(v);
  }
  return out;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (n: number) => Array.from(randomBytes(n), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
export const newReferralCode = () => randomCode(8);

/**
 * Called inside the delivery transaction: the order earns its points, and if this is the first order of someone who joined with a
 * friend's code, both of them get the referral points (once).
 */
export async function rewardDelivered(c: Queryable, orderId: string): Promise<void> {
  const o = (await c.query<{ user_id: string | null; total_cents: string; fee: string | null; order_no: number }>('SELECT user_id, total_cents, delivery_fee_cents AS fee, order_no FROM orders WHERE id = $1', [orderId])).rows[0];
  if (!o?.user_id) return;
  if (!(await c.query('SELECT 1 FROM customers WHERE id = $1', [o.user_id])).rowCount) return;
  const p = await rewardsProgramme(c);
  const points = Math.floor(((Number(o.total_cents) - Number(o.fee ?? 0)) / 10_000) * p.earnPerHundredKes);
  if (points > 0) await c.query(`INSERT INTO points_ledger (customer_id, kind, points, order_id, note) VALUES ($1,'earned',$2,$3,$4) ON CONFLICT DO NOTHING`, [o.user_id, points, orderId, `Order SC-${o.order_no}`]);
  const me = (await c.query<{ referred_by: string | null; referral_rewarded_at: Date | null; name: string }>('SELECT referred_by, referral_rewarded_at, name FROM customers WHERE id = $1 FOR UPDATE', [o.user_id])).rows[0];
  if (me?.referred_by && !me.referral_rewarded_at && p.referralPoints > 0) {
    const first = me.name.split(' ')[0] || 'Your friend';
    await c.query('UPDATE customers SET referral_rewarded_at = now() WHERE id = $1', [o.user_id]);
    await c.query(`INSERT INTO points_ledger (customer_id, kind, points, note) VALUES ($1,'referral',$3,'You joined with a friend''s code'), ($2,'referral',$3,$4)`, [o.user_id, me.referred_by, p.referralPoints, `${first} placed their first order`]);
    await queuePush(c, { type: 'customer', id: me.referred_by }, 'referral_points', { name: first, points: String(p.referralPoints) }, { screen: 'rewards' });
  }
}

export class RewardsService {
  constructor(private readonly db: Database) {}

  programme() { return this.db.read((c) => rewardsProgramme(c)); }

  async saveProgramme(input: Rewards, actor: Actor) {
    await this.db.tx(async (c) => {
      for (const [f, k] of Object.entries(KEYS) as [keyof Rewards, string][]) {
        await c.query('INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()', [k, JSON.stringify(input[f]), actor.id]);
      }
      await audit(c, actor, 'rewards.programme', 'settings', 'rewards', input);
    });
    return input;
  }

  /** Points, the shopper's invite code, who they have invited, and recent changes. */
  async account(customerId: string) {
    return this.db.read(async (c) => {
      const p = await rewardsProgramme(c);
      const me = (await c.query<{ referral_code: string }>('SELECT referral_code FROM customers WHERE id = $1', [customerId])).rows[0];
      if (!me) throw new NotFoundError('Account');
      const bal = Number((await c.query<{ s: string | null }>('SELECT sum(points) AS s FROM points_ledger WHERE customer_id = $1', [customerId])).rows[0]!.s ?? 0);
      const history = (await c.query<{ kind: string; points: number; note: string; coupon_code: string | null; created_at: Date }>('SELECT kind, points, note, coupon_code, created_at FROM points_ledger WHERE customer_id = $1 ORDER BY id DESC LIMIT 50', [customerId])).rows;
      const invited = (await c.query<{ name: string; rewarded: boolean }>(`SELECT split_part(name, ' ', 1) AS name, referral_rewarded_at IS NOT NULL AS rewarded FROM customers WHERE referred_by = $1 ORDER BY created_at DESC LIMIT 50`, [customerId])).rows;
      return {
        points: bal, valueCents: bal * p.pointValueCents, pointValueCents: p.pointValueCents, minRedeemPoints: p.minRedeemPoints, earnPerHundredKes: p.earnPerHundredKes,
        referral: { code: me.referral_code, rewardPoints: p.referralPoints, invited: invited.map((i) => ({ name: i.name || 'A friend', rewarded: i.rewarded })) },
        history: history.map((h) => ({ kind: h.kind, points: h.points, note: h.note, couponCode: h.coupon_code, at: h.created_at.toISOString() })),
      };
    });
  }

  /** Turns points into a single-use discount code the shopper enters at checkout. */
  async redeem(customerId: string, points: number) {
    return this.db.tx(async (c) => {
      await c.query('SELECT 1 FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
      const p = await rewardsProgramme(c);
      const bal = Number((await c.query<{ s: string | null }>('SELECT sum(points) AS s FROM points_ledger WHERE customer_id = $1', [customerId])).rows[0]!.s ?? 0);
      if (points < p.minRedeemPoints) throw new UnprocessableError('BELOW_MINIMUM', `You can redeem at least ${p.minRedeemPoints} points at a time`);
      if (points > bal) throw new UnprocessableError('NOT_ENOUGH_POINTS', 'You don’t have that many points');
      const code = `RW${randomCode(8)}`;
      const value = points * p.pointValueCents;
      await c.query(
        `INSERT INTO coupons (id, name, code, kind, value, usage_limit, per_customer, starts_at, ends_at, state, audience, note, created_by)
         VALUES ($1,$2,$3,'fixed',$4,1,1, now(), now() + make_interval(days => $5::int), 'live', 'all', $6, 'rewards')`,
        [uuidv7(), `Points ${points}`, code, value, p.couponDays, `Redeemed by customer ${customerId}`]);
      await c.query(`INSERT INTO points_ledger (customer_id, kind, points, coupon_code, note) VALUES ($1,'redeemed',$2,$3,$4)`, [customerId, -points, code, `${points} points for a discount code`]);
      return { code, valueCents: value, points, expiresInDays: p.couponDays };
    });
  }
}
