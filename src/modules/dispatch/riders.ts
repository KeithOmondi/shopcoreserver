import { createHash, randomBytes, randomInt } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../../config/index.js';
import type { Database, Queryable } from '../../infra/db.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { isUuid, uuidv7 } from '../../infra/uuid.js';
import { audit, type Actor } from '../products/products.js';
import { dummyHash, hashPassword, verifyPassword } from '../staff/password.js';

const uuid = z.string().refine(isUuid, 'must be a UUID');
export const DOC_KEYS = ['id', 'license', 'insurance', 'photo', 'selfie'] as const;
const DOC_TITLES: Record<(typeof DOC_KEYS)[number], string> = { id: 'National ID', license: 'Driving license', insurance: 'Vehicle insurance', photo: 'Vehicle photo', selfie: 'Selfie check' };

/** Messages go out through this. Production wires a real SMS provider; development just logs. */
export interface SmsSender { send(phone: string, text: string): Promise<void> }
export const consoleSms = (log: Logger): SmsSender => ({ send: async (phone, text) => { log.info({ phone }, `SMS (not sent, dev): ${text}`); } });

/** +254 712 345 678, 0712345678 and 254712345678 all become +254712345678. */
export function normalisePhone(raw: string): string | null {
  const d = raw.replace(/[\s()-]/g, '');
  if (/^\+254[17]\d{8}$/.test(d)) return d;
  if (/^254[17]\d{8}$/.test(d)) return `+${d}`;
  if (/^0[17]\d{8}$/.test(d)) return `+254${d.slice(1)}`;
  return /^\+\d{9,15}$/.test(d) ? d : null;
}
const phone = z.string().trim().transform((v, ctx) => { const p = normalisePhone(v); if (!p) ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' }); return p ?? v; });
const riderPassword = z.string().min(8).max(128).refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Use letters and at least one number');

// ---- schemas ---------------------------------------------------------------------------------------------------------

export const CodeRequestSchema = z.strictObject({ phone, purpose: z.enum(['signup', 'reset']) });
export const CodeVerifySchema = z.strictObject({ phone, purpose: z.enum(['signup', 'reset']), code: z.string().regex(/^\d{6}$/) });
export const RegisterSchema = z.strictObject({
  phone, password: riderPassword, name: z.string().trim().min(2).max(120), nationalId: z.string().trim().max(20).default(''), county: z.string().trim().max(60).default(''),
  vehicle: z.enum(['Motorbike', 'Bicycle', 'Car']).default('Motorbike'), plate: z.string().trim().toUpperCase().max(12).default(''), zoneId: uuid.optional(),
});
export const RiderLoginSchema = z.strictObject({ phone, password: z.string().min(1).max(128) });
export const RiderResetSchema = z.strictObject({ phone, code: z.string().regex(/^\d{6}$/), password: riderPassword });
export const RiderRefreshSchema = z.strictObject({ refreshToken: z.string().min(20).max(200) });
export const SubmitDocSchema = z.strictObject({ fileRef: z.string().trim().min(1).max(300), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export const AvailabilitySchema = z.strictObject({ online: z.boolean(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() });
export const PingSchema = z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export const RiderListSchema = z.object({
  q: z.string().trim().max(100).optional(), status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional(), availability: z.enum(['online', 'offline']).optional(),
  zoneId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const ReviewDocSchema = z.strictObject({ state: z.enum(['valid', 'rejected']), note: z.string().trim().max(300).default(''), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export const RiderActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve') }),
  z.strictObject({ action: z.literal('reject'), docKey: z.enum(DOC_KEYS), note: z.string().trim().min(3).max(300) }),
  z.strictObject({ action: z.literal('suspend'), reason: z.string().trim().min(3).max(300) }),
  z.strictObject({ action: z.literal('reinstate') }),
]);
export const RiderPatchSchema = z.strictObject({
  name: z.string().trim().min(2).max(120), vehicle: z.enum(['Motorbike', 'Bicycle', 'Car']), plate: z.string().trim().toUpperCase().max(12), zoneId: uuid.nullable(), county: z.string().trim().max(60),
}).partial().refine((v) => Object.keys(v).length > 0, 'nothing to change');
export const ShiftSchema = z.strictObject({ riderId: uuid, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), window: z.string().trim().min(1).max(40), zoneId: uuid.nullable().default(null) });
export const ShiftQuerySchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), riderId: uuid.optional() });

// ---- shapes -----------------------------------------------------------------------------------------------------------------

interface RiderRow {
  id: string; phone: string; name: string; email: string; national_id: string; county: string; vehicle: string; plate: string; zone_id: string | null; zone: string | null; account_status: string;
  availability: string; rating: string; deliveries_done: number; review_note: string; rejected_doc: string | null; reviewed_by: string | null; reviewed_at: Date | null; applied_at: Date;
  welcomed: boolean; last_lat: number | null; last_lng: number | null; last_seen_at: Date | null; created_at: Date; version: number;
  cash_held: number; earnings: number; live: number;
}
const RIDER_SELECT = `SELECT r.*, z.name AS zone,
    COALESCE((SELECT sum(amount_cents) FROM rider_cash WHERE rider_id = r.id), 0)::bigint AS cash_held,
    COALESCE((SELECT sum(amount_cents) FROM rider_ledger WHERE rider_id = r.id), 0)::bigint AS earnings,
    (SELECT count(*) FROM deliveries d WHERE d.rider_id = r.id AND d.status IN ('accepted','at_pickup','picked_up','at_dropoff'))::int AS live
  FROM riders r LEFT JOIN zones z ON z.id = r.zone_id`;
const view = (r: RiderRow) => ({
  id: r.id, phone: r.phone, name: r.name, email: r.email, nationalId: r.national_id, county: r.county, vehicle: r.vehicle, plate: r.plate, zoneId: r.zone_id, zone: r.zone,
  status: r.account_status, availability: r.account_status === 'approved' ? r.availability : 'offline', rating: Number(r.rating), deliveries: r.deliveries_done,
  cashHeldCents: Number(r.cash_held), earningsBalanceCents: Number(r.earnings), activeDeliveries: r.live, appliedAt: r.applied_at.toISOString(), joinedAt: r.created_at.toISOString(),
  reviewNote: r.review_note, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at?.toISOString() ?? null,
  location: r.last_lat !== null && r.last_lng !== null ? { lat: r.last_lat, lng: r.last_lng, at: r.last_seen_at?.toISOString() ?? null } : null, version: r.version,
});

export interface RiderContext { id: string; name: string; phone: string; status: string; sessionId: string; requestId: string }

const hashToken = (t: string) => createHash('sha256').update(t).digest('base64url');
const hashCode = (p: string, purpose: string, code: string) => createHash('sha256').update(`${p}|${purpose}|${code}`).digest('base64url');

export class RidersService {
  private key?: Promise<CryptoKey>;
  private readonly cache = new Map<string, { at: number; ctx: Omit<RiderContext, 'requestId'> | null }>();
  constructor(private readonly db: Database, private readonly cfg: Config, private readonly sms: SmsSender) {}

  invalidate() { this.cache.clear(); }

  // ---- rider sign-up and sign-in ---------------------------------------------------------------------------------

  private signingKey() {
    if (!this.cfg.STAFF_JWT_PRIVATE_KEY) throw new AppError('LOGIN_UNAVAILABLE', 'Rider sign-in is not configured on this server', 503);
    return (this.key ??= importPKCS8(this.cfg.STAFF_JWT_PRIVATE_KEY.replace(/\\n/g, '\n'), 'EdDSA') as Promise<CryptoKey>);
  }
  private async access(riderId: string, sid: string) {
    return new SignJWT({ roles: ['rider'], sid }).setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' }).setSubject(riderId).setIssuer(this.cfg.JWT_ISSUER).setAudience(this.cfg.JWT_AUDIENCE)
      .setIssuedAt().setExpirationTime(`${this.cfg.RIDER_ACCESS_TTL_S}s`).sign(await this.signingKey());
  }

  async requestCode(rawPhone: string, purpose: 'signup' | 'reset') {
    const p = rawPhone;
    const exists = (await this.db.read((c) => c.query('SELECT 1 FROM riders WHERE phone = $1', [p]))).rowCount === 1;
    if (purpose === 'signup' && exists) throw new ConflictError('PHONE_EXISTS', 'This number already has a rider account. Log in instead.');
    if (purpose === 'reset' && !exists) throw new NotFoundError('Rider account');
    const code = this.cfg.RIDER_DEV_OTP && this.cfg.NODE_ENV !== 'production' ? this.cfg.RIDER_DEV_OTP : String(randomInt(100000, 1000000));
    await this.db.tx(async (c) => {
      const prev = (await c.query<{ sent_at: Date }>('SELECT sent_at FROM rider_otps WHERE phone = $1 AND purpose = $2', [p, purpose])).rows[0];
      if (prev && Date.now() - prev.sent_at.getTime() < 30_000) throw new AppError('CODE_TOO_SOON', 'Wait a moment before asking for another code', 429, undefined, 30);
      await c.query(
        `INSERT INTO rider_otps (phone, purpose, code_hash, expires_at) VALUES ($1,$2,$3, now() + interval '10 minutes')
         ON CONFLICT (phone, purpose) DO UPDATE SET code_hash = $3, expires_at = now() + interval '10 minutes', attempts = 0, verified_at = NULL, sent_at = now()`,
        [p, purpose, hashCode(p, purpose, code)]);
    });
    await this.sms.send(p, `Your ShopCore rider code is ${code}. It expires in 10 minutes.`);
  }

  async verifyCode(p: string, purpose: 'signup' | 'reset', code: string) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ code_hash: string; attempts: number; expired: boolean }>('SELECT code_hash, attempts, (expires_at < now()) AS expired FROM rider_otps WHERE phone = $1 AND purpose = $2 FOR UPDATE', [p, purpose])).rows[0];
      if (!r || r.expired) throw new UnprocessableError('CODE_EXPIRED', 'That code has expired. Ask for a new one.');
      if (r.attempts >= 5) throw new AppError('CODE_LOCKED', 'Too many wrong codes. Ask for a new one.', 429);
      if (r.code_hash !== hashCode(p, purpose, code)) {
        await c.query('UPDATE rider_otps SET attempts = attempts + 1 WHERE phone = $1 AND purpose = $2', [p, purpose]);
        // The failed attempt must persist, so report it after the transaction commits.
        throw Object.assign(new UnprocessableError('WRONG_CODE', 'That code isn’t right. Check the SMS and try again.'), { persist: true });
      }
      await c.query('UPDATE rider_otps SET verified_at = now() WHERE phone = $1 AND purpose = $2', [p, purpose]);
    }).catch(async (e) => {
      if ((e as { persist?: boolean }).persist) {
        await this.db.tx((c) => c.query('UPDATE rider_otps SET attempts = attempts + 1 WHERE phone = $1 AND purpose = $2', [p, purpose]));
      }
      throw e;
    });
  }

  private async consumeVerified(c: Queryable, p: string, purpose: 'signup' | 'reset') {
    const r = (await c.query<{ ok: boolean }>(`DELETE FROM rider_otps WHERE phone = $1 AND purpose = $2 AND verified_at IS NOT NULL AND verified_at > now() - interval '30 minutes' RETURNING true AS ok`, [p, purpose])).rows[0];
    if (!r) throw new UnprocessableError('CODE_NOT_VERIFIED', 'Verify your phone number first');
  }

  async register(input: z.infer<typeof RegisterSchema>, device: string) {
    const id = uuidv7();
    const hash = await hashPassword(input.password);
    const out = await this.db.tx(async (c) => {
      await this.consumeVerified(c, input.phone, 'signup');
      if (input.zoneId && !(await c.query('SELECT 1 FROM zones WHERE id = $1', [input.zoneId])).rowCount) throw new ValidationError([{ path: ['zoneId'], message: 'Unknown zone' }]);
      await c.query('INSERT INTO riders (id, phone, name, national_id, county, vehicle, plate, zone_id, password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, input.phone, input.name, input.nationalId, input.county, input.vehicle, input.plate, input.zoneId ?? null, hash])
        .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('PHONE_EXISTS', 'This number already has a rider account. Log in instead.'); throw e; });
      for (const k of DOC_KEYS) await c.query(`INSERT INTO rider_docs (rider_id, key, state, note) VALUES ($1,$2,'pending','')`, [id, k]);
      return this.startSession(c, id, device);
    });
    return this.tokens(id, out.id, out.refresh);
  }

  private async startSession(c: pg.PoolClient, riderId: string, device: string, family = uuidv7()) {
    const id = uuidv7();
    const refresh = randomBytes(32).toString('base64url');
    await c.query('INSERT INTO rider_sessions (id, rider_id, refresh_hash, family_id, expires_at, device) VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5), $6)',
      [id, riderId, hashToken(refresh), family, this.cfg.RIDER_SESSION_TTL_S, device.slice(0, 200)]);
    return { id, refresh };
  }

  private async tokens(riderId: string, sid: string, refresh: string) {
    return { accessToken: await this.access(riderId, sid), expiresIn: this.cfg.RIDER_ACCESS_TTL_S, refreshToken: refresh, account: await this.account(riderId) };
  }

  /** What the rider app needs to decide which screen to show. */
  async account(riderId: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<RiderRow>(`${RIDER_SELECT} WHERE r.id = $1`, [riderId])).rows[0];
      if (!r) throw new NotFoundError('Rider');
      const docs = (await c.query<{ key: string; state: string; note: string; expires_on: string | null }>(`SELECT key, state, note, to_char(expires_on,'YYYY-MM-DD') AS expires_on FROM rider_docs WHERE rider_id = $1`, [riderId])).rows;
      const bad = docs.find((d) => d.key === r.rejected_doc);
      return {
        id: r.id, phone: r.phone, name: r.name, status: r.account_status, welcomed: r.welcomed, vehicle: r.vehicle, plate: r.plate, zone: r.zone, rating: Number(r.rating), online: r.availability === 'online',
        rejection: r.account_status === 'rejected' ? { document: r.rejected_doc, title: r.rejected_doc ? `${DOC_TITLES[r.rejected_doc as keyof typeof DOC_TITLES]} needs another look` : 'Application not approved', message: r.review_note, detail: bad?.note ?? '' } : undefined,
        documents: DOC_KEYS.map((k) => ({ key: k, title: DOC_TITLES[k], ...(docs.find((d) => d.key === k) ?? { state: 'pending', note: '', expires_on: null }) })).map((d) => ({ key: d.key, title: d.title, state: d.state, note: d.note, expiresOn: d.expires_on })),
      };
    });
  }

  async login(rawPhone: string, password: string, device: string) {
    const r = await this.db.read(async (c) => (await c.query<{ id: string; password_hash: string; locked_until: Date | null }>('SELECT id, password_hash, locked_until FROM riders WHERE phone = $1', [rawPhone])).rows[0]);
    const bad = () => new UnauthorizedError('Incorrect phone number or password.');
    if (!r) { await verifyPassword(password, await dummyHash()); throw bad(); }
    if (r.locked_until && r.locked_until.getTime() > Date.now()) throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.', 429, undefined, 300);
    if (!(await verifyPassword(password, r.password_hash))) {
      await this.db.tx((c) => c.query(`UPDATE riders SET failed_attempts = failed_attempts + 1, locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '10 minutes' ELSE locked_until END WHERE id = $1`, [r.id]));
      throw bad();
    }
    const s = await this.db.tx(async (c) => { await c.query('UPDATE riders SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [r.id]); return this.startSession(c, r.id, device); });
    return this.tokens(r.id, s.id, s.refresh);
  }

  async refresh(token: string, device: string) {
    const res = await this.db.tx(async (c) => {
      const x = (await c.query<{ id: string; rider_id: string; family_id: string; revoked_at: Date | null; revoked_why: string | null; expired: boolean }>(
        `SELECT id, rider_id, family_id, revoked_at, revoked_why, (expires_at <= now()) AS expired FROM rider_sessions WHERE refresh_hash = $1 FOR UPDATE`, [hashToken(token)])).rows[0];
      if (!x || x.expired) return null;
      if (x.revoked_at) {
        if (x.revoked_why === 'rotated') await c.query(`UPDATE rider_sessions SET revoked_at = now(), revoked_why = 'reuse detected' WHERE family_id = $1 AND revoked_at IS NULL`, [x.family_id]);
        return null;
      }
      await c.query(`UPDATE rider_sessions SET revoked_at = now(), revoked_why = 'rotated' WHERE id = $1`, [x.id]);
      return { riderId: x.rider_id, s: await this.startSession(c, x.rider_id, device, x.family_id) };
    });
    this.invalidate();
    if (!res) throw new UnauthorizedError('Please log in again');
    return this.tokens(res.riderId, res.s.id, res.s.refresh);
  }

  async logout(ctx: RiderContext) {
    await this.db.tx((c) => c.query(`UPDATE rider_sessions SET revoked_at = now(), revoked_why = 'signed out' WHERE id = $1 AND revoked_at IS NULL`, [ctx.sessionId]));
    await this.db.tx((c) => c.query(`UPDATE riders SET availability = 'offline', updated_at = now() WHERE id = $1`, [ctx.id]));
    this.invalidate();
  }

  async resetPassword(input: z.infer<typeof RiderResetSchema>) {
    const hash = await hashPassword(input.password);
    await this.db.tx(async (c) => {
      await this.consumeVerified(c, input.phone, 'reset');
      const r = (await c.query<{ id: string }>('UPDATE riders SET password_hash = $2, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE phone = $1 RETURNING id', [input.phone, hash])).rows[0];
      if (!r) throw new NotFoundError('Rider account');
      await c.query(`UPDATE rider_sessions SET revoked_at = now(), revoked_why = 'password reset' WHERE rider_id = $1 AND revoked_at IS NULL`, [r.id]);
    });
    this.invalidate();
  }

  /** Verifies a rider’s token session; cached for a few seconds so a suspension takes effect almost at once. */
  async context(riderId: string, sid: string, requestId: string): Promise<RiderContext> {
    const k = `${riderId}:${sid}`;
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < 10_000) { if (!hit.ctx) throw new UnauthorizedError('Session ended'); return { ...hit.ctx, requestId }; }
    const row = (await this.db.read((c) => c.query<{ id: string; name: string; phone: string; account_status: string; ok: boolean }>(
      `SELECT r.id, r.name, r.phone, r.account_status, (s.revoked_at IS NULL AND s.expires_at > now()) AS ok FROM riders r JOIN rider_sessions s ON s.rider_id = r.id AND s.id = $2 WHERE r.id = $1`, [riderId, sid]))).rows[0];
    const ctx = row && row.ok ? { id: row.id, name: row.name, phone: row.phone, status: row.account_status, sessionId: sid } : null;
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(k, { at: Date.now(), ctx });
    if (!ctx) throw new UnauthorizedError('Session ended');
    return { ...ctx, requestId };
  }

  /** Only an approved rider can work. */
  requireApproved(ctx: RiderContext) {
    if (ctx.status === 'suspended') throw new ForbiddenError('Your account is paused. Contact ShopCore rider support.');
    if (ctx.status !== 'approved') throw new ForbiddenError('Your application hasn’t been approved yet');
  }

  async submitDoc(ctx: RiderContext, key: (typeof DOC_KEYS)[number], input: z.infer<typeof SubmitDocSchema>) {
    await this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO rider_docs (rider_id, key, state, file_ref, expires_on, note) VALUES ($1,$2,'pending',$3,$4,'')
         ON CONFLICT (rider_id, key) DO UPDATE SET state = 'pending', file_ref = $3, expires_on = $4, note = '', reviewed_by = NULL, reviewed_at = NULL, uploaded_at = now()`,
        [ctx.id, key, input.fileRef, input.expiresOn ?? null]);
      // A re-sent photo puts a rejected application back in the queue.
      await c.query(`UPDATE riders SET account_status = CASE WHEN account_status = 'rejected' THEN 'pending' ELSE account_status END, updated_at = now() WHERE id = $1`, [ctx.id]);
    });
    this.invalidate();
    return this.account(ctx.id);
  }

  async welcome(ctx: RiderContext) {
    await this.db.tx((c) => c.query('UPDATE riders SET welcomed = true WHERE id = $1', [ctx.id]));
    return this.account(ctx.id);
  }

  async setAvailability(ctx: RiderContext, input: z.infer<typeof AvailabilitySchema>) {
    this.requireApproved(ctx);
    await this.db.tx(async (c) => {
      if (input.online) {
        const bad = (await c.query<{ key: string }>(`SELECT key FROM rider_docs WHERE rider_id = $1 AND (state <> 'valid' OR (expires_on IS NOT NULL AND expires_on < current_date)) LIMIT 1`, [ctx.id])).rows[0];
        if (bad) throw new UnprocessableError('DOCS_NOT_VALID', `Your ${DOC_TITLES[bad.key as keyof typeof DOC_TITLES].toLowerCase()} needs attention before you can go online`);
      }
      await c.query(`UPDATE riders SET availability = $2, last_lat = COALESCE($3, last_lat), last_lng = COALESCE($4, last_lng), last_seen_at = now(), updated_at = now() WHERE id = $1`,
        [ctx.id, input.online ? 'online' : 'offline', input.lat ?? null, input.lng ?? null]);
    });
    return this.account(ctx.id);
  }

  async ping(ctx: RiderContext, p: z.infer<typeof PingSchema>) {
    await this.db.tx((c) => c.query('UPDATE riders SET last_lat = $2, last_lng = $3, last_seen_at = now() WHERE id = $1', [ctx.id, p.lat, p.lng]));
  }

  // ---- staff side -----------------------------------------------------------------------------------------------------

  async list(q: z.infer<typeof RiderListSchema>) {
    return this.db.read(async (c) => {
      const { rows } = await c.query<RiderRow>(
        `${RIDER_SELECT}
          WHERE ($1::text IS NULL OR r.name ILIKE '%' || $1 || '%' OR r.phone ILIKE '%' || $1 || '%' OR r.plate ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR r.account_status = $2) AND ($3::text IS NULL OR (r.account_status = 'approved' AND r.availability = $3)) AND ($4::uuid IS NULL OR r.zone_id = $4)
          ORDER BY CASE r.account_status WHEN 'pending' THEN 0 ELSE 1 END, r.name LIMIT $5`, [q.q ?? null, q.status ?? null, q.availability ?? null, q.zoneId ?? null, q.limit]);
      const counts = (await c.query<{ s: string; n: number }>(`SELECT CASE WHEN account_status = 'approved' THEN availability ELSE account_status END AS s, count(*)::int AS n FROM riders GROUP BY 1`)).rows;
      return { items: rows.map(view), counts: Object.fromEntries(counts.map((x) => [x.s, x.n])) };
    });
  }

  async get(id: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<RiderRow>(`${RIDER_SELECT} WHERE r.id = $1`, [id])).rows[0];
      if (!r) throw new NotFoundError('Rider');
      const docs = (await c.query<{ key: string; state: string; note: string; file_ref: string | null; expires_on: string | null; reviewed_by: string | null; uploaded_at: Date }>(
        `SELECT key, state, note, file_ref, to_char(expires_on,'YYYY-MM-DD') AS expires_on, reviewed_by, uploaded_at FROM rider_docs WHERE rider_id = $1`, [id])).rows;
      const recent = (await c.query<{ id: string; order_no: number; status: string; delivered_at: Date | null; created_at: Date; fare_cents: number }>(
        `SELECT d.id, o.order_no, d.status, d.delivered_at, d.created_at, d.fare_cents FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.rider_id = $1 ORDER BY d.created_at DESC LIMIT 10`, [id])).rows;
      return {
        ...view(r),
        documents: DOC_KEYS.map((k) => { const d = docs.find((x) => x.key === k); const expired = d?.expires_on && d.expires_on < new Date().toISOString().slice(0, 10);
          return { key: k, title: DOC_TITLES[k], state: expired && d?.state === 'valid' ? 'expired' : d?.state ?? 'pending', note: d?.note ?? '', fileRef: d?.file_ref ?? null, expiresOn: d?.expires_on ?? null, reviewedBy: d?.reviewed_by ?? null }; }),
        recentDeliveries: recent.map((d) => ({ id: d.id, order: `SC-${d.order_no}`, status: d.status, at: (d.delivered_at ?? d.created_at).toISOString(), fareCents: d.fare_cents })),
      };
    });
  }

  async reviewDoc(riderId: string, key: (typeof DOC_KEYS)[number], input: z.infer<typeof ReviewDocSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE rider_docs SET state = $3, note = $4, expires_on = COALESCE($5::date, expires_on), reviewed_by = $6, reviewed_at = now() WHERE rider_id = $1 AND key = $2`,
        [riderId, key, input.state, input.note, input.expiresOn ?? null, actor.name ?? 'Staff']);
      if (!rowCount) throw new NotFoundError('Document');
      await audit(c, actor, 'rider.doc_review', 'rider', riderId, { key, ...input });
    });
    return this.get(riderId);
  }

  async act(riderId: string, input: z.infer<typeof RiderActionSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const r = (await c.query<{ account_status: string; name: string }>('SELECT account_status, name FROM riders WHERE id = $1 FOR UPDATE', [riderId])).rows[0];
      if (!r) throw new NotFoundError('Rider');
      const by = actor.name ?? 'Staff';
      if (input.action === 'approve') {
        if (r.account_status !== 'pending') throw new UnprocessableError('NOT_PENDING', 'This application isn’t waiting for review');
        const notValid = (await c.query<{ key: string }>(`SELECT key FROM rider_docs WHERE rider_id = $1 AND state <> 'valid'`, [riderId])).rows;
        if (notValid.length) throw new UnprocessableError('DOCS_NOT_VERIFIED', `Verify every document first (${notValid.map((d) => DOC_TITLES[d.key as keyof typeof DOC_TITLES]).join(', ')})`);
        await c.query(`UPDATE riders SET account_status = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = '', rejected_doc = NULL, updated_at = now(), version = version + 1 WHERE id = $1`, [riderId, by]);
      } else if (input.action === 'reject') {
        if (r.account_status !== 'pending') throw new UnprocessableError('NOT_PENDING', 'This application isn’t waiting for review');
        await c.query(`UPDATE rider_docs SET state = 'rejected', note = $3, reviewed_by = $4, reviewed_at = now() WHERE rider_id = $1 AND key = $2`, [riderId, input.docKey, input.note, by]);
        await c.query(`UPDATE riders SET account_status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3, rejected_doc = $4, updated_at = now(), version = version + 1 WHERE id = $1`, [riderId, by, input.note, input.docKey]);
      } else if (input.action === 'suspend') {
        if (r.account_status === 'suspended') throw new UnprocessableError('ALREADY_SUSPENDED', 'This rider is already paused');
        const live = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM deliveries WHERE rider_id = $1 AND status IN ('accepted','at_pickup','picked_up','at_dropoff')`, [riderId])).rows[0]!.n;
        if (live > 0) throw new UnprocessableError('HAS_LIVE_DELIVERY', 'Reassign or finish their live delivery before pausing them');
        await c.query(`UPDATE riders SET account_status = 'suspended', availability = 'offline', review_note = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now(), version = version + 1 WHERE id = $1`, [riderId, input.reason, by]);
        await c.query(`UPDATE rider_sessions SET revoked_at = now(), revoked_why = 'suspended' WHERE rider_id = $1 AND revoked_at IS NULL`, [riderId]);
      } else {
        if (r.account_status !== 'suspended') throw new UnprocessableError('NOT_SUSPENDED', 'This rider isn’t paused');
        await c.query(`UPDATE riders SET account_status = 'approved', review_note = '', reviewed_by = $2, reviewed_at = now(), updated_at = now(), version = version + 1 WHERE id = $1`, [riderId, by]);
      }
      await audit(c, actor, `rider.${input.action}`, 'rider', riderId, input);
    });
    this.invalidate();
    return this.get(riderId);
  }

  async update(riderId: string, p: z.infer<typeof RiderPatchSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      if (p.zoneId && !(await c.query('SELECT 1 FROM zones WHERE id = $1', [p.zoneId])).rowCount) throw new ValidationError([{ path: ['zoneId'], message: 'Unknown zone' }]);
      const { rowCount } = await c.query(
        `UPDATE riders SET name = COALESCE($2, name), vehicle = COALESCE($3, vehicle), plate = COALESCE($4, plate), zone_id = CASE WHEN $5 THEN $6 ELSE zone_id END, county = COALESCE($7, county), updated_at = now(), version = version + 1 WHERE id = $1`,
        [riderId, p.name ?? null, p.vehicle ?? null, p.plate ?? null, p.zoneId !== undefined, p.zoneId ?? null, p.county ?? null]);
      if (!rowCount) throw new NotFoundError('Rider');
      await audit(c, actor, 'rider.update', 'rider', riderId, p);
    });
    return this.get(riderId);
  }

  // ---- shifts ------------------------------------------------------------------------------------------------------------

  async shifts(q: z.infer<typeof ShiftQuerySchema>) {
    return this.db.read(async (c) => ({ items: (await c.query<{ id: string; rider_id: string; rider: string; day: string; window: string; zone_id: string | null; zone: string | null }>(
      `SELECT s.id, s.rider_id, r.name AS rider, to_char(s.day,'YYYY-MM-DD') AS day, s.time_window AS window, s.zone_id, z.name AS zone FROM rider_shifts s JOIN riders r ON r.id = s.rider_id LEFT JOIN zones z ON z.id = s.zone_id
        WHERE s.day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR s.rider_id = $3) ORDER BY s.day, r.name`, [q.from, q.to, q.riderId ?? null])).rows
      .map((s) => ({ id: s.id, riderId: s.rider_id, rider: s.rider, day: s.day, window: s.window, zoneId: s.zone_id, zone: s.zone })) }));
  }

  async setShift(input: z.infer<typeof ShiftSchema>, actor: Actor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      const r = (await c.query<{ account_status: string }>('SELECT account_status FROM riders WHERE id = $1', [input.riderId])).rows[0];
      if (!r) throw new NotFoundError('Rider');
      if (r.account_status !== 'approved') throw new UnprocessableError('NOT_APPROVED', 'Only approved riders can be rostered');
      await c.query(`INSERT INTO rider_shifts (id, rider_id, day, time_window, zone_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (rider_id, day) DO UPDATE SET time_window = $4, zone_id = $5`, [id, input.riderId, input.day, input.window, input.zoneId]);
      await audit(c, actor, 'shift.set', 'rider', input.riderId, input);
    });
    return this.shifts({ from: input.day, to: input.day, riderId: input.riderId }).then((s) => s.items[0]!);
  }

  async clearShift(riderId: string, day: string, actor: Actor) {
    await this.db.tx(async (c) => {
      await c.query('DELETE FROM rider_shifts WHERE rider_id = $1 AND day = $2', [riderId, day]);
      await audit(c, actor, 'shift.clear', 'rider', riderId, { day });
    });
  }
}
