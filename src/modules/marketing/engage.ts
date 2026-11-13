import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { audit, outbox, type Actor } from '../products/products.js';
import { patchOf } from '../../http/validate.js';
import { segmentAudience } from './audience.js';

const uuid = z.string().uuid();
const when = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date and time').transform((s) => new Date(s).toISOString());
const TZ = 'Africa/Nairobi';

/** Sends to customers. Push, email and SMS providers are connected in the wire-up phase; until then a development sender only records the send. */
export interface MessageSender {
  send(m: { channel: 'push' | 'email' | 'sms'; segmentId: string; title: string; body: string; recipients: number; ref: string }): Promise<void>;
}
export const devSender: MessageSender = { async send() { /* nothing leaves the building in development */ } };

/** An SMS up to 160 characters is one part; longer messages are split and billed per part. */
export const smsParts = (s: string) => (s.length <= 160 ? 1 : Math.ceil(s.length / 153));

// ============ banners and the homepage ==================================================================================================================

export const BannerSchema = z.strictObject({
  title: z.string().trim().min(1).max(80),
  label: z.string().trim().max(40).default(''),
  link: z.string().trim().min(1).max(200),
  platform: z.enum(['Web and mobile', 'Mobile only', 'Web only']).default('Web and mobile'),
  startsAt: when,
  endsAt: when,
  tone: z.number().int().min(0).max(3).default(0),
  alt: z.string().trim().max(200).default(''),
  imageRef: z.string().trim().max(300).nullable().default(null),
  published: z.boolean().default(false),
});
export const BannerPatchSchema = patchOf(BannerSchema);
export const BannerSettingsSchema = z.strictObject({ interval: z.string().trim().min(1).max(40), ratio: z.string().trim().min(1).max(60) });
export const SectionSchema = z.strictObject({ name: z.string().trim().min(1).max(60), sub: z.string().trim().max(60).default(''), enabled: z.boolean().default(true), count: z.number().int().min(0).max(100).default(0) });
export const SectionPatchSchema = patchOf(SectionSchema);
export const MoveSchema = z.strictObject({ dir: z.union([z.literal(-1), z.literal(1)]) });
export const PublishLayoutSchema = z.strictObject({ mode: z.enum(['now', 'later']), at: when.optional() });

// ============ pushes and messages ===========================================================================================================================

export const PushSchema = z.strictObject({
  title: z.string().trim().min(1).max(65),
  body: z.string().trim().min(1).max(240),
  segmentId: uuid,
  deepLink: z.string().trim().max(200).default(''),
  sendAt: when.nullable().default(null),
  quiet: z.boolean().default(true),
  cap: z.boolean().default(true),
  action: z.enum(['draft', 'schedule', 'now']).default('draft'),
});
export const PushPatchSchema = patchOf(PushSchema);
export const MessageSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  channel: z.enum(['Email', 'SMS']),
  segmentId: uuid,
  subject: z.string().trim().max(150).default(''),
  body: z.string().trim().min(1).max(5000),
  sendAt: when.nullable().default(null),
  action: z.enum(['draft', 'schedule', 'now']).default('draft'),
});
export const MessagePatchSchema = patchOf(MessageSchema);
export const ResultsSchema = z.strictObject({ opened: z.number().int().min(0).optional(), converted: z.number().int().min(0).optional(), delivered: z.number().int().min(0).optional(), clicks: z.number().int().min(0).optional() });

/** Quiet hours are 21:00 to 07:00 in Nairobi: a send inside them waits until 07:00. */
export function respectQuietHours(at: Date): { at: Date; moved: boolean } {
  const local = new Date(at.getTime() + 3 * 3_600_000);
  const h = local.getUTCHours();
  if (h >= 7 && h < 21) return { at, moved: false };
  const next = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (h >= 21 ? 1 : 0), 7, 0, 0));
  return { at: new Date(next.getTime() - 3 * 3_600_000), moved: true };
}

// ============ campaigns, loyalty, referrals, highlights ============================================================================================================

export const CampaignSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['Coupon', 'Push', 'Bundle', 'Banner', 'Flash sale']),
  offer: z.string().trim().max(200).default(''),
  audience: z.string().trim().max(80).default('All customers'),
  spendCents: z.number().int().min(0).max(100_000_000_000).default(0),
  startsAt: when,
  endsAt: when,
  couponId: uuid.nullable().default(null),
});
export const CampaignPatchSchema = patchOf(CampaignSchema);
export const ChannelResultSchema = z.strictObject({ name: z.string().trim().min(1).max(60), reach: z.number().int().min(0), clicks: z.number().int().min(0), conversions: z.number().int().min(0), salesCents: z.number().int().min(0) });

export const LoyaltySchema = z.strictObject({
  active: z.boolean(), earnRate: z.number().min(0).max(100), pointValueCents: z.number().int().min(0).max(100_000), minOrderCents: z.number().int().min(0), expiry: z.string().trim().max(60),
  awardOnFees: z.boolean(), excludeRefunded: z.boolean(), minRedeem: z.number().int().min(0), maxRedeemPct: z.number().min(0).max(100), step: z.number().int().min(1), stackCoupons: z.boolean(),
  bonuses: z.array(z.strictObject({ id: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(80), sub: z.string().trim().max(120).default(''), on: z.boolean() })).max(20),
});
export const LOYALTY_DEFAULTS: z.infer<typeof LoyaltySchema> = {
  active: true, earnRate: 1, pointValueCents: 100, minOrderCents: 500_00, expiry: '12 months of inactivity', awardOnFees: true, excludeRefunded: true, minRedeem: 100, maxRedeemPct: 30, step: 100, stackCoupons: true,
  bonuses: [{ id: 'lb1', name: 'Double points Tuesdays', sub: 'All categories', on: true }, { id: 'lb2', name: 'First order bonus', sub: '500 points for new customers', on: true }],
};
export const ReferralSchema = z.strictObject({
  active: z.boolean(), advocate: z.string().trim().max(120), friend: z.string().trim().max(120), minSpendCents: z.number().int().min(0), limit: z.number().int().min(0).max(10_000),
  window: z.string().trim().max(120), expiry: z.string().trim().max(60), selfExclude: z.boolean(), fraudReview: z.boolean(), message: z.string().trim().max(400),
});
export const REFERRAL_DEFAULTS: z.infer<typeof ReferralSchema> = {
  active: true, advocate: 'KES 300 ShopCore credit', friend: '15% off first order', minSpendCents: 1500_00, limit: 20, window: 'After the first order is delivered', expiry: '30 days', selfExclude: true, fraudReview: true,
  message: 'Give a friend 15% off their first ShopCore order. You’ll get KES 300 in credit after their order is delivered.',
};
export const HighlightSchema = z.strictObject({ placement: z.enum(['Home · Featured', 'Category page', 'App · New']).default('Home · Featured'), published: z.boolean().default(false) });
export const HighlightPatchSchema = patchOf(HighlightSchema);

async function setting<T>(c: Queryable, key: string, dflt: T): Promise<T> {
  const r = (await c.query<{ value: Partial<T> }>('SELECT value FROM settings WHERE key = $1', [key])).rows[0];
  return (r ? { ...dflt, ...r.value } : dflt) as T;
}
async function putSetting(c: Queryable, key: string, value: unknown, actor: Actor) {
  await c.query(`INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`, [key, JSON.stringify(value), actor.id]);
  await audit(c, actor, `setting.${key}`, 'setting', key, value);
}

interface SectionRow { id: string; name: string; sub: string; enabled: boolean; item_count: number; position: number }
const sectionView = (s: SectionRow) => ({ id: s.id, name: s.name, sub: s.sub, enabled: s.enabled, count: s.item_count });

export class EngageService {
  constructor(private readonly db: Database, private readonly sender: MessageSender = devSender) {}

  // ---- banners -------------------------------------------------------------------------------------------------------------------------------

  /** Where a banner may point: the storefront's own routes, its categories, and published pages. Anything else is a broken link. */
  private async linkOk(c: Queryable, link: string) {
    const fixed = ['/', '/collections/new', '/collections/sale', '/loyalty', '/referral'];
    if (fixed.includes(link)) return true;
    const cat = /^\/categories\/([a-z0-9-]+)$/.exec(link);
    if (cat && (await c.query('SELECT 1 FROM categories WHERE handle = $1', [cat[1]])).rowCount) return true;
    return !!(await c.query(`SELECT 1 FROM content_pages WHERE slug = $1 AND status = 'published'`, [link])).rowCount;
  }

  private bannerView(b: { id: string; title: string; label: string; link: string; platform: string; starts_at: Date; ends_at: Date; tone: number; alt: string; image_ref: string | null; published: boolean; position: number; version: number }, linkOk: boolean) {
    const now = Date.now();
    return { id: b.id, title: b.title, label: b.label, link: b.link, linkOk, platform: b.platform, startsAt: b.starts_at.toISOString(), endsAt: b.ends_at.toISOString(), tone: b.tone, alt: b.alt, imageRef: b.image_ref, published: b.published, position: b.position, status: !b.published ? 'Draft' : now < b.starts_at.getTime() ? 'Scheduled' : now > b.ends_at.getTime() ? 'Ended' : 'Live', version: b.version };
  }

  async banners() {
    return this.db.read(async (c) => {
      const rows = (await c.query<Parameters<EngageService['bannerView']>[0]>('SELECT * FROM banners ORDER BY position, created_at')).rows;
      const items = [];
      for (const b of rows) items.push(this.bannerView(b, await this.linkOk(c, b.link)));
      return { items, settings: await setting(c, 'marketing.banner_settings', { interval: '5 seconds', ratio: '16:5 desktop · 4:3 mobile' }) };
    });
  }

  async saveBanner(id: string | null, input: Partial<z.infer<typeof BannerSchema>>, actor: Actor) {
    const bid = id ?? uuidv7();
    await this.db.tx(async (c) => {
      let m: z.infer<typeof BannerSchema>;
      if (id) {
        const cur = (await c.query<{ title: string; label: string; link: string; platform: string; starts_at: Date; ends_at: Date; tone: number; alt: string; image_ref: string | null; published: boolean }>('SELECT * FROM banners WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw new NotFoundError('Banner');
        m = BannerSchema.parse({ title: cur.title, label: cur.label, link: cur.link, platform: cur.platform, startsAt: cur.starts_at.toISOString(), endsAt: cur.ends_at.toISOString(), tone: cur.tone, alt: cur.alt, imageRef: cur.image_ref, published: cur.published, ...input });
      } else m = BannerSchema.parse(input);
      if (Date.parse(m.endsAt) <= Date.parse(m.startsAt)) throw new UnprocessableError('BAD_DATES', 'The end must be after the start');
      if (m.published) {
        if (!m.alt) throw new UnprocessableError('ALT_REQUIRED', 'Add alt text before publishing, so screen readers can describe the banner');
        if (!(await this.linkOk(c, m.link))) throw new UnprocessableError('BROKEN_LINK', 'That link doesn’t go anywhere in the shop. Fix it before publishing', { link: m.link });
      }
      const cols = [m.title, m.label, m.link, m.platform, m.startsAt, m.endsAt, m.tone, m.alt, m.imageRef, m.published];
      if (id) await c.query('UPDATE banners SET title=$2, label=$3, link=$4, platform=$5, starts_at=$6, ends_at=$7, tone=$8, alt=$9, image_ref=$10, published=$11, version = version + 1, updated_at = now() WHERE id = $1', [id, ...cols]);
      else {
        const pos = (await c.query<{ p: number }>('SELECT COALESCE(max(position), 0) + 1 AS p FROM banners')).rows[0]!.p;
        await c.query('INSERT INTO banners (id, title, label, link, platform, starts_at, ends_at, tone, alt, image_ref, published, position, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [bid, ...cols, pos, actor.name ?? actor.id]);
      }
      await audit(c, actor, id ? 'banner.update' : 'banner.create', 'banner', bid, { title: m.title, published: m.published });
    });
    return (await this.banners()).items.find((b) => b.id === bid)!;
  }

  async moveBanner(id: string, dir: -1 | 1, actor: Actor) {
    await this.db.tx(async (c) => {
      const all = (await c.query<{ id: string }>('SELECT id FROM banners ORDER BY position, created_at FOR UPDATE')).rows.map((r) => r.id);
      const i = all.indexOf(id);
      if (i < 0) throw new NotFoundError('Banner');
      const j = i + dir;
      if (j < 0 || j >= all.length) return;
      [all[i], all[j]] = [all[j]!, all[i]!];
      for (const [pos, bid] of all.entries()) await c.query('UPDATE banners SET position = $2 WHERE id = $1', [bid, pos + 1]);
      await audit(c, actor, 'banner.move', 'banner', id, { dir });
    });
    return this.banners();
  }

  async deleteBanner(id: string, actor: Actor) {
    await this.db.tx(async (c) => {
      if (!(await c.query('DELETE FROM banners WHERE id = $1', [id])).rowCount) throw new NotFoundError('Banner');
      await audit(c, actor, 'banner.delete', 'banner', id, {});
    });
  }

  async saveBannerSettings(s: z.infer<typeof BannerSettingsSchema>, actor: Actor) {
    await this.db.tx((c) => putSetting(c, 'marketing.banner_settings', s, actor));
    return s;
  }

  // ---- homepage layout ---------------------------------------------------------------------------------------------------------------------------

  async layout() {
    return this.db.read(async (c) => {
      const sections = (await c.query<SectionRow>('SELECT * FROM home_sections ORDER BY position')).rows.map(sectionView);
      const live = (await c.query<{ sections: ReturnType<typeof sectionView>[]; effective_at: Date; published_by: string }>(`SELECT * FROM home_layouts WHERE slot = 'live'`)).rows[0];
      const pending = (await c.query<{ effective_at: Date; published_by: string }>(`SELECT * FROM home_layouts WHERE slot = 'pending'`)).rows[0];
      const same = (a: ReturnType<typeof sectionView>[], b: ReturnType<typeof sectionView>[]) => a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.enabled === b[i]!.enabled && x.count === b[i]!.count && x.name === b[i]!.name);
      const liveSections = live?.sections ?? [];
      return {
        sections, liveAt: live?.effective_at.toISOString() ?? null, liveBy: live?.published_by ?? null,
        unpublished: live ? sections.filter((s, i) => !same([s], liveSections[i] ? [liveSections[i]!] : [])).length + Math.max(0, liveSections.length - sections.length) : sections.length,
        pending: pending ? { at: pending.effective_at.toISOString(), by: pending.published_by } : null,
      };
    });
  }

  async addSection(input: z.infer<typeof SectionSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const pos = (await c.query<{ p: number }>('SELECT COALESCE(max(position), 0) + 1 AS p FROM home_sections')).rows[0]!.p;
      const id = uuidv7();
      await c.query('INSERT INTO home_sections (id, name, sub, enabled, item_count, position) VALUES ($1,$2,$3,$4,$5,$6)', [id, input.name, input.sub, input.enabled, input.count, pos]);
      await audit(c, actor, 'layout.add_section', 'home_section', id, input);
    });
    return this.layout();
  }
  async patchSection(id: string, patch: Partial<z.infer<typeof SectionSchema>>, actor: Actor) {
    await this.db.tx(async (c) => {
      const cur = (await c.query<SectionRow>('SELECT * FROM home_sections WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new NotFoundError('Section');
      const m = { name: cur.name, sub: cur.sub, enabled: cur.enabled, count: cur.item_count, ...patch };
      await c.query('UPDATE home_sections SET name = $2, sub = $3, enabled = $4, item_count = $5 WHERE id = $1', [id, m.name, m.sub, m.enabled, m.count]);
      await audit(c, actor, 'layout.update_section', 'home_section', id, patch);
    });
    return this.layout();
  }
  async removeSection(id: string, actor: Actor) {
    await this.db.tx(async (c) => {
      if (!(await c.query('DELETE FROM home_sections WHERE id = $1', [id])).rowCount) throw new NotFoundError('Section');
      await audit(c, actor, 'layout.remove_section', 'home_section', id, {});
    });
    return this.layout();
  }
  async moveSection(id: string, dir: -1 | 1, actor: Actor) {
    await this.db.tx(async (c) => {
      const all = (await c.query<{ id: string }>('SELECT id FROM home_sections ORDER BY position FOR UPDATE')).rows.map((r) => r.id);
      const i = all.indexOf(id);
      if (i < 0) throw new NotFoundError('Section');
      const j = i + dir;
      if (j < 0 || j >= all.length) return;
      [all[i], all[j]] = [all[j]!, all[i]!];
      for (const [pos, sid] of all.entries()) await c.query('UPDATE home_sections SET position = $2 WHERE id = $1', [sid, pos + 1]);
      await audit(c, actor, 'layout.move_section', 'home_section', id, { dir });
    });
    return this.layout();
  }

  /** Publish the sections as they stand, now or at a set time. */
  async publishLayout(input: z.infer<typeof PublishLayoutSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const sections = (await c.query<SectionRow>('SELECT * FROM home_sections ORDER BY position')).rows.map(sectionView);
      if (!sections.some((s) => s.enabled)) throw new UnprocessableError('NO_SECTIONS', 'Turn on at least one section before publishing');
      const by = actor.name ?? actor.id;
      if (input.mode === 'later') {
        if (!input.at || Date.parse(input.at) <= Date.now()) throw new UnprocessableError('PAST_TIME', 'Choose a time in the future');
        await c.query(`INSERT INTO home_layouts (slot, sections, effective_at, published_by) VALUES ('pending', $1, $2, $3) ON CONFLICT (slot) DO UPDATE SET sections = $1, effective_at = $2, published_by = $3`, [JSON.stringify(sections), input.at, by]);
      } else {
        await c.query(`INSERT INTO home_layouts (slot, sections, effective_at, published_by) VALUES ('live', $1, now(), $2) ON CONFLICT (slot) DO UPDATE SET sections = $1, effective_at = now(), published_by = $2`, [JSON.stringify(sections), by]);
        await c.query(`DELETE FROM home_layouts WHERE slot = 'pending'`);
      }
      await audit(c, actor, 'layout.publish', 'home_layout', input.mode, { at: input.at ?? null });
    });
    return this.layout();
  }

  // ---- pushes ---------------------------------------------------------------------------------------------------------------------------------------

  private pushView(p: { id: string; title: string; body: string; segment_id: string; segment: string | null; deep_link: string; send_at: Date | null; quiet: boolean; cap: boolean; status: string; sent_at: Date | null; sent_count: number; opened: number; converted: number; created_by: string; version: number }) {
    return { id: p.id, title: p.title, body: p.body, segmentId: p.segment_id, segment: p.segment, deepLink: p.deep_link, sendAt: p.send_at?.toISOString() ?? null, quiet: p.quiet, cap: p.cap, status: p.status, sentAt: p.sent_at?.toISOString() ?? null, stats: p.status === 'sent' ? { sent: p.sent_count, opened: p.opened, converted: p.converted } : null, createdBy: p.created_by, version: p.version };
  }
  async pushes() {
    return this.db.read(async (c) => ({ items: (await c.query<Parameters<EngageService['pushView']>[0]>(`SELECT p.*, s.name AS segment FROM pushes p JOIN segments s ON s.id = p.segment_id ORDER BY COALESCE(p.send_at, p.created_at) DESC LIMIT 200`)).rows.map((p) => this.pushView(p)) }));
  }
  async push(id: string) {
    const r = (await this.db.read((c) => c.query<Parameters<EngageService['pushView']>[0]>('SELECT p.*, s.name AS segment FROM pushes p JOIN segments s ON s.id = p.segment_id WHERE p.id = $1', [id]))).rows[0];
    if (!r) throw new NotFoundError('Push notification');
    return this.pushView(r);
  }

  async savePush(id: string | null, input: Partial<z.infer<typeof PushSchema>>, actor: Actor) {
    const pid = id ?? uuidv7();
    let moved = false;
    await this.db.tx(async (c) => {
      let m: z.infer<typeof PushSchema>;
      if (id) {
        const cur = (await c.query<{ title: string; body: string; segment_id: string; deep_link: string; send_at: Date | null; quiet: boolean; cap: boolean; status: string }>('SELECT * FROM pushes WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw new NotFoundError('Push notification');
        if (cur.status === 'sent') throw new ConflictError('ALREADY_SENT', 'A sent notification can’t be changed');
        m = PushSchema.parse({ title: cur.title, body: cur.body, segmentId: cur.segment_id, deepLink: cur.deep_link, sendAt: cur.send_at?.toISOString() ?? null, quiet: cur.quiet, cap: cur.cap, action: 'draft', ...input });
      } else m = PushSchema.parse(input);
      if (!(await c.query('SELECT 1 FROM segments WHERE id = $1', [m.segmentId])).rowCount) throw new NotFoundError('Segment');
      let at: Date | null = m.sendAt ? new Date(m.sendAt) : null;
      if (m.action === 'schedule') {
        if (!at || at.getTime() <= Date.now()) throw new UnprocessableError('PAST_TIME', 'Choose a time in the future');
        if (m.quiet) { const q = respectQuietHours(at); at = q.at; moved = q.moved; }
      }
      if (m.action === 'now') {
        if (m.quiet && respectQuietHours(new Date()).moved) throw new UnprocessableError('QUIET_HOURS', 'It’s quiet hours (9 pm to 7 am). Schedule it for the morning instead');
        at = new Date();
      }
      if (m.action !== 'draft' && m.cap) {
        const day = (await c.query<{ d: string }>(`SELECT to_char($1::timestamptz AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS d`, [at!.toISOString()])).rows[0]!.d;
        const clash = (await c.query<{ title: string; send_at: Date }>(
          `SELECT title, send_at FROM pushes WHERE id <> $1 AND cap AND status IN ('scheduled','sent') AND to_char(send_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') = $2
              AND (segment_id = $3 OR segment_id = '00000000-0000-7000-8000-000000000001' OR $3 = '00000000-0000-7000-8000-000000000001') LIMIT 1`, [pid, day, m.segmentId])).rows[0];
        if (clash) throw new ConflictError('FREQUENCY_CAP', `“${clash.title}” already goes to this audience that day. Turn off the one-a-day limit or choose another day`, { title: clash.title, at: clash.send_at.toISOString() });
      }
      const status = m.action === 'draft' ? 'draft' : 'scheduled';
      const cols = [m.title, m.body, m.segmentId, m.deepLink, at, m.quiet, m.cap, status];
      if (id) await c.query('UPDATE pushes SET title=$2, body=$3, segment_id=$4, deep_link=$5, send_at=$6, quiet=$7, cap=$8, status=$9, version = version + 1 WHERE id = $1', [id, ...cols]);
      else await c.query('INSERT INTO pushes (id, title, body, segment_id, deep_link, send_at, quiet, cap, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [pid, ...cols, actor.name ?? actor.id]);
      await audit(c, actor, id ? 'push.update' : 'push.create', 'push', pid, { action: m.action });
    });
    if (input.action === 'now') await this.deliverPush(pid, actor);
    return { ...(await this.push(pid)), movedOutOfQuietHours: moved };
  }

  async deliverPush(id: string, actor: Actor) {
    const p = await this.db.tx(async (c) => {
      const r = (await c.query<{ title: string; body: string; segment_id: string; status: string }>(`SELECT title, body, segment_id, status FROM pushes WHERE id = $1 FOR UPDATE SKIP LOCKED`, [id])).rows[0];
      if (!r || r.status !== 'scheduled') return null;
      const a = await segmentAudience(c, r.segment_id);
      await c.query(`UPDATE pushes SET status = 'sent', sent_at = now(), sent_count = $2, version = version + 1 WHERE id = $1`, [id, a.push]);
      await audit(c, actor, 'push.send', 'push', id, { recipients: a.push });
      return { ...r, recipients: a.push };
    });
    if (p) await this.sender.send({ channel: 'push', segmentId: p.segment_id, title: p.title, body: p.body, recipients: p.recipients, ref: id });
  }

  async cancelSchedule(kind: 'push' | 'message', id: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const t = kind === 'push' ? 'pushes' : 'messages';
      const r = (await c.query<{ status: string }>(`SELECT status FROM ${t} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!r) throw new NotFoundError(kind === 'push' ? 'Push notification' : 'Message');
      if (r.status !== 'scheduled') throw new ConflictError('NOT_SCHEDULED', 'Only a scheduled send can be taken back to a draft');
      await c.query(`UPDATE ${t} SET status = 'draft', version = version + 1 WHERE id = $1`, [id]);
      await audit(c, actor, `${kind}.unschedule`, kind, id, {});
    });
    return kind === 'push' ? this.push(id) : this.message(id);
  }

  // ---- email and SMS ----------------------------------------------------------------------------------------------------------------------------------

  private messageView(m: { id: string; name: string; channel: string; segment_id: string; segment: string | null; subject: string; body: string; send_at: Date | null; status: string; sent_at: Date | null; sent_count: number; delivered: number; clicks: number; created_by: string; version: number }) {
    return { id: m.id, name: m.name, channel: m.channel, segmentId: m.segment_id, segment: m.segment, subject: m.subject, body: m.body, smsParts: m.channel === 'SMS' ? smsParts(m.body) : null, sendAt: m.send_at?.toISOString() ?? null, status: m.status, sentAt: m.sent_at?.toISOString() ?? null, stats: m.status === 'sent' ? { sent: m.sent_count, delivered: m.delivered, clicks: m.clicks } : null, createdBy: m.created_by, version: m.version };
  }
  async messages() {
    return this.db.read(async (c) => ({ items: (await c.query<Parameters<EngageService['messageView']>[0]>(`SELECT m.*, s.name AS segment FROM messages m JOIN segments s ON s.id = m.segment_id ORDER BY COALESCE(m.send_at, m.created_at) DESC LIMIT 200`)).rows.map((m) => this.messageView(m)) }));
  }
  async message(id: string) {
    const r = (await this.db.read((c) => c.query<Parameters<EngageService['messageView']>[0]>('SELECT m.*, s.name AS segment FROM messages m JOIN segments s ON s.id = m.segment_id WHERE m.id = $1', [id]))).rows[0];
    if (!r) throw new NotFoundError('Message');
    return this.messageView(r);
  }

  async saveMessage(id: string | null, input: Partial<z.infer<typeof MessageSchema>>, actor: Actor) {
    const mid = id ?? uuidv7();
    await this.db.tx(async (c) => {
      let m: z.infer<typeof MessageSchema>;
      if (id) {
        const cur = (await c.query<{ name: string; channel: 'Email' | 'SMS'; segment_id: string; subject: string; body: string; send_at: Date | null; status: string }>('SELECT * FROM messages WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw new NotFoundError('Message');
        if (cur.status === 'sent') throw new ConflictError('ALREADY_SENT', 'A sent message can’t be changed');
        m = MessageSchema.parse({ name: cur.name, channel: cur.channel, segmentId: cur.segment_id, subject: cur.subject, body: cur.body, sendAt: cur.send_at?.toISOString() ?? null, action: 'draft', ...input });
      } else m = MessageSchema.parse(input);
      if (!(await c.query('SELECT 1 FROM segments WHERE id = $1', [m.segmentId])).rowCount) throw new NotFoundError('Segment');
      if (m.channel === 'Email' && m.action !== 'draft' && !m.subject) throw new UnprocessableError('SUBJECT_REQUIRED', 'An email needs a subject before it can be sent');
      let at: Date | null = m.sendAt ? new Date(m.sendAt) : null;
      if (m.action === 'schedule' && (!at || at.getTime() <= Date.now())) throw new UnprocessableError('PAST_TIME', 'Choose a time in the future');
      if (m.action === 'now') at = new Date();
      const cols = [m.name, m.channel, m.segmentId, m.channel === 'Email' ? m.subject : '', m.body, at, m.action === 'draft' ? 'draft' : 'scheduled'];
      if (id) await c.query('UPDATE messages SET name=$2, channel=$3, segment_id=$4, subject=$5, body=$6, send_at=$7, status=$8, version = version + 1 WHERE id = $1', [id, ...cols]);
      else await c.query('INSERT INTO messages (id, name, channel, segment_id, subject, body, send_at, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [mid, ...cols, actor.name ?? actor.id]);
      await audit(c, actor, id ? 'message.update' : 'message.create', 'message', mid, { action: m.action, channel: m.channel });
    });
    if (input.action === 'now') await this.deliverMessage(mid, actor);
    return this.message(mid);
  }

  async deliverMessage(id: string, actor: Actor) {
    const m = await this.db.tx(async (c) => {
      const r = (await c.query<{ name: string; channel: 'Email' | 'SMS'; segment_id: string; subject: string; body: string; status: string }>(`SELECT name, channel, segment_id, subject, body, status FROM messages WHERE id = $1 FOR UPDATE SKIP LOCKED`, [id])).rows[0];
      if (!r || r.status !== 'scheduled') return null;
      const a = await segmentAudience(c, r.segment_id);
      const reach = r.channel === 'Email' ? a.email : a.sms;
      await c.query(`UPDATE messages SET status = 'sent', sent_at = now(), sent_count = $2, version = version + 1 WHERE id = $1`, [id, reach]);
      await outbox(c, 'message', id, 'MessageSent', { id, channel: r.channel, segmentId: r.segment_id, recipients: reach });
      await audit(c, actor, 'message.send', 'message', id, { recipients: reach });
      return { ...r, recipients: reach };
    });
    if (m) await this.sender.send({ channel: m.channel === 'Email' ? 'email' : 'sms', segmentId: m.segment_id, title: m.subject || m.name, body: m.body, recipients: m.recipients, ref: id });
  }

  /** Delivery results reported back by the provider. */
  async recordResults(kind: 'push' | 'message', id: string, r: z.infer<typeof ResultsSchema>) {
    await this.db.tx(async (c) => {
      const n = kind === 'push'
        ? (await c.query(`UPDATE pushes SET opened = COALESCE($2, opened), converted = COALESCE($3, converted) WHERE id = $1 AND status = 'sent'`, [id, r.opened ?? null, r.converted ?? null])).rowCount
        : (await c.query(`UPDATE messages SET delivered = COALESCE($2, delivered), clicks = COALESCE($3, clicks) WHERE id = $1 AND status = 'sent'`, [id, r.delivered ?? null, r.clicks ?? null])).rowCount;
      if (!n) throw new NotFoundError('Sent campaign');
    });
  }

  // ---- background: sends that are due, and a layout that is due -------------------------------------------------------------------------------------

  async runDue(): Promise<{ pushes: number; messages: number; layout: boolean }> {
    const actor: Actor = { id: 'system:marketing', requestId: 'job:marketing-due', name: 'Scheduler' };
    const ids = await this.db.read(async (c) => ({
      p: (await c.query<{ id: string }>(`SELECT id FROM pushes WHERE status = 'scheduled' AND send_at <= now() ORDER BY send_at LIMIT 50`)).rows.map((r) => r.id),
      m: (await c.query<{ id: string }>(`SELECT id FROM messages WHERE status = 'scheduled' AND send_at <= now() ORDER BY send_at LIMIT 50`)).rows.map((r) => r.id),
    }));
    for (const id of ids.p) await this.deliverPush(id, actor);
    for (const id of ids.m) await this.deliverMessage(id, actor);
    const layout = await this.db.tx(async (c) => {
      const p = (await c.query<{ sections: unknown; published_by: string }>(`SELECT sections, published_by FROM home_layouts WHERE slot = 'pending' AND effective_at <= now() FOR UPDATE`)).rows[0];
      if (!p) return false;
      await c.query(`INSERT INTO home_layouts (slot, sections, effective_at, published_by) VALUES ('live', $1, now(), $2) ON CONFLICT (slot) DO UPDATE SET sections = $1, effective_at = now(), published_by = $2`, [JSON.stringify(p.sections), p.published_by]);
      await c.query(`DELETE FROM home_layouts WHERE slot = 'pending'`);
      return true;
    });
    return { pushes: ids.p.length, messages: ids.m.length, layout };
  }

  // ---- campaigns -----------------------------------------------------------------------------------------------------------------------------------------

  private async campaignViews(c: Queryable, id?: string) {
    const rows = (await c.query<{ id: string; name: string; kind: string; offer: string; audience: string; spend_cents: number; starts_at: Date; ends_at: Date; coupon_id: string | null; code: string | null; created_by: string; version: number; channels: { name: string; reach: number; clicks: number; conversions: number; salesCents: number }[]; c_conv: number; c_sales: number }>(
      `SELECT k.*, cp.code,
              COALESCE((SELECT json_agg(json_build_object('name', ch.name, 'reach', ch.reach, 'clicks', ch.clicks, 'conversions', ch.conversions, 'salesCents', ch.sales_cents) ORDER BY ch.name) FROM campaign_channels ch WHERE ch.campaign_id = k.id), '[]') AS channels,
              COALESCE((SELECT count(*) FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id WHERE r.coupon_id = k.coupon_id AND r.released_at IS NULL AND o.status IN ('PAID','FULFILLED') AND r.created_at BETWEEN k.starts_at AND k.ends_at),0)::int AS c_conv,
              COALESCE((SELECT sum(o.total_cents) FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id WHERE r.coupon_id = k.coupon_id AND r.released_at IS NULL AND o.status IN ('PAID','FULFILLED') AND r.created_at BETWEEN k.starts_at AND k.ends_at),0)::bigint AS c_sales
         FROM campaigns k LEFT JOIN coupons cp ON cp.id = k.coupon_id WHERE ($1::uuid IS NULL OR k.id = $1) ORDER BY k.starts_at DESC`, [id ?? null])).rows;
    const now = Date.now();
    return rows.map((k) => {
      const channels = [...(k.coupon_id ? [{ name: `Coupon ${k.code}`, reach: 0, clicks: 0, conversions: k.c_conv, salesCents: Number(k.c_sales) }] : []), ...k.channels.map((x) => ({ ...x, salesCents: Number(x.salesCents) }))];
      const sales = channels.reduce((n, x) => n + x.salesCents, 0);
      return {
        id: k.id, name: k.name, type: k.kind, offer: k.offer, audience: k.audience, spendCents: Number(k.spend_cents), startsAt: k.starts_at.toISOString(), endsAt: k.ends_at.toISOString(), couponId: k.coupon_id, createdBy: k.created_by, version: k.version,
        status: now < k.starts_at.getTime() ? 'Scheduled' : now > k.ends_at.getTime() ? 'Ended' : 'Active', channels,
        totals: { reach: channels.reduce((n, x) => n + x.reach, 0), clicks: channels.reduce((n, x) => n + x.clicks, 0), conversions: channels.reduce((n, x) => n + x.conversions, 0), salesCents: sales, returnOnSpend: Number(k.spend_cents) ? Math.round((sales / Number(k.spend_cents)) * 100) / 100 : null },
      };
    });
  }
  async campaigns() {
    return this.db.read(async (c) => {
      const items = await this.campaignViews(c);
      return { items, summary: { active: items.filter((i) => i.status === 'Active').length, salesCents: items.reduce((n, i) => n + i.totals.salesCents, 0), spendCents: items.reduce((n, i) => n + i.spendCents, 0) } };
    });
  }
  async campaign(id: string) {
    const r = (await this.db.read((c) => this.campaignViews(c, id)))[0];
    if (!r) throw new NotFoundError('Campaign');
    return r;
  }
  async saveCampaign(id: string | null, input: Partial<z.infer<typeof CampaignSchema>>, actor: Actor) {
    const kid = id ?? uuidv7();
    await this.db.tx(async (c) => {
      let m: z.infer<typeof CampaignSchema>;
      if (id) {
        const cur = (await c.query<{ name: string; kind: string; offer: string; audience: string; spend_cents: number; starts_at: Date; ends_at: Date; coupon_id: string | null }>('SELECT * FROM campaigns WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw new NotFoundError('Campaign');
        m = CampaignSchema.parse({ name: cur.name, type: cur.kind, offer: cur.offer, audience: cur.audience, spendCents: Number(cur.spend_cents), startsAt: cur.starts_at.toISOString(), endsAt: cur.ends_at.toISOString(), couponId: cur.coupon_id, ...input });
      } else m = CampaignSchema.parse(input);
      if (Date.parse(m.endsAt) <= Date.parse(m.startsAt)) throw new UnprocessableError('BAD_DATES', 'The end must be after the start');
      if (m.couponId && !(await c.query('SELECT 1 FROM coupons WHERE id = $1', [m.couponId])).rowCount) throw new NotFoundError('Coupon');
      const cols = [m.name, m.type, m.offer, m.audience, m.spendCents, m.startsAt, m.endsAt, m.couponId];
      if (id) await c.query('UPDATE campaigns SET name=$2, kind=$3, offer=$4, audience=$5, spend_cents=$6, starts_at=$7, ends_at=$8, coupon_id=$9, version = version + 1 WHERE id = $1', [id, ...cols]);
      else await c.query('INSERT INTO campaigns (id, name, kind, offer, audience, spend_cents, starts_at, ends_at, coupon_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [kid, ...cols, actor.name ?? actor.id]);
      await audit(c, actor, id ? 'campaign.update' : 'campaign.create', 'campaign', kid, { name: m.name });
    });
    return this.campaign(kid);
  }
  /** Results for one channel of a campaign (from a provider callback, or typed in from a report). */
  async setChannelResult(id: string, r: z.infer<typeof ChannelResultSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM campaigns WHERE id = $1', [id])).rowCount) throw new NotFoundError('Campaign');
      await c.query(`INSERT INTO campaign_channels (campaign_id, name, reach, clicks, conversions, sales_cents) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (campaign_id, name) DO UPDATE SET reach = $3, clicks = $4, conversions = $5, sales_cents = $6`, [id, r.name, r.reach, r.clicks, r.conversions, r.salesCents]);
      await audit(c, actor, 'campaign.results', 'campaign', id, { channel: r.name });
    });
    return this.campaign(id);
  }

  // ---- loyalty, referrals, highlights ---------------------------------------------------------------------------------------------------------------------

  async loyalty() { return this.db.read((c) => setting(c, 'marketing.loyalty', LOYALTY_DEFAULTS)); }
  async saveLoyalty(v: z.infer<typeof LoyaltySchema>, actor: Actor) { await this.db.tx((c) => putSetting(c, 'marketing.loyalty', v, actor)); return v; }
  async referral() { return this.db.read((c) => setting(c, 'marketing.referral', REFERRAL_DEFAULTS)); }
  async saveReferral(v: z.infer<typeof ReferralSchema>, actor: Actor) { await this.db.tx((c) => putSetting(c, 'marketing.referral', v, actor)); return v; }

  /** Good reviews that could go on show, with where they are shown now. */
  async highlights() {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; customer_name: string; rating: number; body: string; topic: string; placement: string | null; published: boolean | null; created_at: Date }>(
        `SELECT r.id, r.customer_name, r.rating, r.body, r.topic, h.placement, h.published, r.created_at FROM reviews r LEFT JOIN review_highlights h ON h.review_id = r.id
          WHERE r.state = 'visible' AND r.rating >= 4 ORDER BY (h.review_id IS NOT NULL) DESC, r.created_at DESC LIMIT 100`);
      return { items: rows.map((r) => ({ reviewId: r.id, customer: r.customer_name, rating: r.rating, body: r.body, topic: r.topic, at: r.created_at.toISOString(), highlight: r.placement ? { placement: r.placement, published: !!r.published } : null })) };
    });
  }
  async setHighlight(reviewId: string, patch: Partial<z.infer<typeof HighlightSchema>>, actor: Actor) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ state: string; rating: number }>('SELECT state, rating FROM reviews WHERE id = $1', [reviewId])).rows[0];
      if (!r) throw new NotFoundError('Review');
      if (r.state !== 'visible') throw new UnprocessableError('REVIEW_HIDDEN', 'A hidden or flagged review can’t go on show');
      const cur = (await c.query<{ placement: string; published: boolean }>('SELECT placement, published FROM review_highlights WHERE review_id = $1', [reviewId])).rows[0];
      const m = HighlightSchema.parse({ placement: cur?.placement, published: cur?.published, ...patch });
      await c.query(`INSERT INTO review_highlights (review_id, placement, published, updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (review_id) DO UPDATE SET placement = $2, published = $3, updated_by = $4, updated_at = now()`, [reviewId, m.placement, m.published, actor.name ?? actor.id]);
      await audit(c, actor, 'highlight.set', 'review', reviewId, m);
    });
    return (await this.highlights()).items.find((h) => h.reviewId === reviewId)!;
  }
  async removeHighlight(reviewId: string, actor: Actor) {
    await this.db.tx(async (c) => {
      await c.query('DELETE FROM review_highlights WHERE review_id = $1', [reviewId]);
      await audit(c, actor, 'highlight.remove', 'review', reviewId, {});
    });
  }
}
