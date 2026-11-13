import { createHash, randomBytes, randomInt } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database, Queryable } from '../../infra/db.js';
import { AppError, ConflictError, NotFoundError, UnauthorizedError, UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { dummyHash, hashPassword, verifyPassword } from '../staff/password.js';
import { normalisePhone, type SmsSender } from '../dispatch/riders.js';
import { audit } from '../products/products.js';

const phone = z.string().trim().transform((v, ctx) => { const p = normalisePhone(v); if (!p) ctx.addIssue({ code: 'custom', message: 'Enter a valid Kenyan phone number' }); return p ?? v; });
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8, 'Use at least 8 characters').max(128);
/** A person signs in with the email or the number they joined with. */
const identifier = z.string().trim().min(3).max(254);
const code = z.string().regex(/^\d{6}$/, 'The code is 6 digits');

export const SignUpSchema = z.strictObject({ fullName: z.string().trim().min(2).max(120), email, phone, password });
export const VerifySignupSchema = z.strictObject({ phone, code });
export const ResendSchema = z.strictObject({ phone });
export const CustomerLoginSchema = z.strictObject({ identifier, password: z.string().min(1).max(128) });
export const ForgotSchema = z.strictObject({ identifier });
export const VerifyResetSchema = z.strictObject({ identifier, code });
export const ResetSchema = z.strictObject({ resetToken: z.string().min(20).max(200), password });
export const CustomerRefreshSchema = z.strictObject({ refreshToken: z.string().min(20).max(200) });
export const ProfilePatchSchema = z.strictObject({ fullName: z.string().trim().min(2).max(120), email }).partial().refine((v) => Object.keys(v).length > 0, 'nothing to change');
export const CustomerPasswordSchema = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: password });
export const DeleteAccountSchema = z.strictObject({ password: z.string().min(1).max(128) });

const hashToken = (t: string) => createHash('sha256').update(t).digest('base64url');
const hashCode = (who: string, c: string) => createHash('sha256').update(`${who}|${c}`).digest('base64url');

export interface CustomerContext { id: string; sessionId: string }

export class CustomerAuthService {
  private key?: Promise<CryptoKey>;
  constructor(private readonly db: Database, private readonly cfg: Config, private readonly sms: SmsSender) {}

  private signingKey() {
    if (!this.cfg.STAFF_JWT_PRIVATE_KEY) throw new AppError('LOGIN_UNAVAILABLE', 'Sign-in is not configured on this server', 503);
    return (this.key ??= importPKCS8(this.cfg.STAFF_JWT_PRIVATE_KEY.replace(/\\n/g, '\n'), 'EdDSA') as Promise<CryptoKey>);
  }
  private async access(id: string, sid: string) {
    return new SignJWT({ roles: ['customer'], sid }).setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' }).setSubject(id).setIssuer(this.cfg.JWT_ISSUER).setAudience(this.cfg.JWT_AUDIENCE)
      .setIssuedAt().setExpirationTime(`${this.cfg.CUSTOMER_ACCESS_TTL_S}s`).sign(await this.signingKey());
  }
  private newCode() { return this.cfg.CUSTOMER_DEV_OTP && this.cfg.NODE_ENV !== 'production' ? this.cfg.CUSTOMER_DEV_OTP : String(randomInt(100000, 1000000)); }

  private async startSession(c: Queryable, id: string, device: string, family = uuidv7()) {
    const sid = uuidv7();
    const refresh = randomBytes(32).toString('base64url');
    await c.query('INSERT INTO customer_sessions (id, customer_id, refresh_hash, family_id, device, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6))', [sid, id, hashToken(refresh), family, device.slice(0, 200), this.cfg.CUSTOMER_SESSION_TTL_S]);
    return { sid, refresh };
  }
  private async tokens(id: string, sid: string, refresh: string) {
    return { accessToken: await this.access(id, sid), expiresIn: this.cfg.CUSTOMER_ACCESS_TTL_S, refreshToken: refresh, user: await this.me(id) };
  }

  // ---- joining ----------------------------------------------------------------------------------------------------------------------------

  /** Step one: details and a code by SMS. Nothing is created until the code is entered. */
  async signUp(input: z.infer<typeof SignUpSchema>) {
    const hash = await hashPassword(input.password);
    const c = this.newCode();
    await this.db.tx(async (q) => {
      if ((await q.query(`SELECT 1 FROM customer_accounts WHERE email = $1 AND status = 'active'`, [input.email])).rowCount) throw new ConflictError('EMAIL_EXISTS', 'An account with this email already exists', { field: 'email' });
      if ((await q.query(`SELECT 1 FROM customer_accounts WHERE phone = $1 AND status = 'active'`, [input.phone])).rowCount) throw new ConflictError('PHONE_EXISTS', 'An account with this phone number already exists', { field: 'phone' });
      const prev = (await q.query<{ sent_at: Date }>('SELECT sent_at FROM customer_signups WHERE phone = $1', [input.phone])).rows[0];
      if (prev && Date.now() - prev.sent_at.getTime() < 30_000) throw new AppError('CODE_TOO_SOON', 'Wait a moment before asking for another code', 429, undefined, 30);
      await q.query(
        `INSERT INTO customer_signups (phone, full_name, email, password_hash, code_hash, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '10 minutes')
         ON CONFLICT (phone) DO UPDATE SET full_name = $2, email = $3, password_hash = $4, code_hash = $5, attempts = 0, sent_at = now(), expires_at = now() + interval '10 minutes'`,
        [input.phone, input.fullName, input.email, hash, hashCode(input.phone, c)]);
    });
    await this.sms.send(input.phone, `Your ShopCore code is ${c}. It expires in 10 minutes.`);
  }

  async resendSignup(p: string) {
    const c = this.newCode();
    await this.db.tx(async (q) => {
      const r = (await q.query<{ sent_at: Date }>('SELECT sent_at FROM customer_signups WHERE phone = $1 FOR UPDATE', [p])).rows[0];
      if (!r) throw new NotFoundError('Sign-up');
      if (Date.now() - r.sent_at.getTime() < 30_000) throw new AppError('CODE_TOO_SOON', 'Wait a moment before asking for another code', 429, undefined, 30);
      await q.query(`UPDATE customer_signups SET code_hash = $2, attempts = 0, sent_at = now(), expires_at = now() + interval '10 minutes' WHERE phone = $1`, [p, hashCode(p, c)]);
    });
    await this.sms.send(p, `Your ShopCore code is ${c}. It expires in 10 minutes.`);
  }

  /** Step two: the right code creates the account and signs the person in. */
  async verifySignup(p: string, given: string, device: string) {
    let failed = false;
    const id = uuidv7();
    const out = await this.db.tx(async (q) => {
      const r = (await q.query<{ full_name: string; email: string; password_hash: string; code_hash: string; attempts: number; expired: boolean }>('SELECT full_name, email, password_hash, code_hash, attempts, (expires_at < now()) AS expired FROM customer_signups WHERE phone = $1 FOR UPDATE', [p])).rows[0];
      if (!r || r.expired) throw new UnprocessableError('CODE_EXPIRED', 'That code has expired. Ask for a new one.');
      if (r.attempts >= 5) throw new AppError('CODE_LOCKED', 'Too many wrong codes. Ask for a new one.', 429);
      if (r.code_hash !== hashCode(p, given)) { failed = true; await q.query('UPDATE customer_signups SET attempts = attempts + 1 WHERE phone = $1', [p]); return null; }
      await q.query('DELETE FROM customer_signups WHERE phone = $1', [p]);
      // A guest who ordered before has a row for this number; a new account is a fresh person.
      await q.query('INSERT INTO customers (id, name, email, phone) VALUES ($1,$2,$3,$4)', [id, r.full_name, r.email, p]);
      await q.query('INSERT INTO customer_accounts (id, email, phone, password_hash) VALUES ($1,$2,$3,$4)', [id, r.email, p, r.password_hash])
        .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('ACCOUNT_EXISTS', 'An account with these details already exists'); throw e; });
      await audit(q, { id, requestId: `signup:${id}`, name: r.full_name }, 'customer.signup', 'customer', id, {});
      return this.startSession(q, id, device);
    });
    if (failed || !out) throw new UnprocessableError('WRONG_CODE', 'That code isn’t right. Check the SMS and try again.');
    return this.tokens(id, out.sid, out.refresh);
  }

  // ---- coming back ---------------------------------------------------------------------------------------------------------------------------

  private async find(c: Queryable, who: string) {
    const p = normalisePhone(who);
    const e = who.includes('@') ? who.trim().toLowerCase() : null;
    return (await c.query<{ id: string; password_hash: string; locked_until: Date | null; phone: string }>(
      `SELECT id, password_hash, locked_until, phone FROM customer_accounts WHERE status = 'active' AND (($1::text IS NOT NULL AND phone = $1) OR ($2::text IS NOT NULL AND email = $2))`, [p, e])).rows[0];
  }

  async login(who: string, pw: string, device: string) {
    const r = await this.db.read((c) => this.find(c, who));
    const bad = () => new UnauthorizedError('Incorrect email, phone number or password');
    if (!r) { await verifyPassword(pw, await dummyHash()); throw bad(); }
    if (r.locked_until && r.locked_until.getTime() > Date.now()) throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.', 429, undefined, 300);
    if (!(await verifyPassword(pw, r.password_hash))) {
      await this.db.tx((c) => c.query(`UPDATE customer_accounts SET failed_attempts = failed_attempts + 1, locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '10 minutes' ELSE locked_until END WHERE id = $1`, [r.id]));
      throw bad();
    }
    const s = await this.db.tx(async (c) => { await c.query('UPDATE customer_accounts SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [r.id]); return this.startSession(c, r.id, device); });
    return this.tokens(r.id, s.sid, s.refresh);
  }

  async refresh(token: string, device: string) {
    const res = await this.db.tx(async (c) => {
      const x = (await c.query<{ id: string; customer_id: string; family_id: string; revoked_at: Date | null; revoked_why: string | null; expired: boolean; status: string }>(
        `SELECT s.id, s.customer_id, s.family_id, s.revoked_at, s.revoked_why, (s.expires_at <= now()) AS expired, a.status FROM customer_sessions s JOIN customer_accounts a ON a.id = s.customer_id WHERE s.refresh_hash = $1 FOR UPDATE OF s`, [hashToken(token)])).rows[0];
      if (!x || x.expired || x.status !== 'active') return null;
      if (x.revoked_at) {
        if (x.revoked_why === 'rotated') await c.query(`UPDATE customer_sessions SET revoked_at = now(), revoked_why = 'reuse detected' WHERE family_id = $1 AND revoked_at IS NULL`, [x.family_id]);
        return null;
      }
      await c.query(`UPDATE customer_sessions SET revoked_at = now(), revoked_why = 'rotated' WHERE id = $1`, [x.id]);
      return { id: x.customer_id, s: await this.startSession(c, x.customer_id, device, x.family_id) };
    });
    if (!res) throw new UnauthorizedError('Please log in again');
    return this.tokens(res.id, res.s.sid, res.s.refresh);
  }

  /** The token's session must still be live and the account open. */
  async assertSession(id: string, sid: string) {
    const ok = (await this.db.read((c) => c.query(`SELECT 1 FROM customer_sessions s JOIN customer_accounts a ON a.id = s.customer_id WHERE s.id = $1 AND s.customer_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.status = 'active'`, [sid, id]))).rowCount;
    if (!ok) throw new UnauthorizedError('Please log in again');
  }

  async logout(ctx: CustomerContext) {
    await this.db.tx((c) => c.query(`UPDATE customer_sessions SET revoked_at = now(), revoked_why = 'signed out' WHERE id = $1 AND revoked_at IS NULL`, [ctx.sessionId]));
  }

  // ---- forgotten password: code, then a one-time token, then the new password --------------------------------------------------------------------------

  /** Always looks the same from outside, so it can't be used to find out who has an account. */
  async forgot(who: string) {
    const c = this.newCode();
    const target = await this.db.tx(async (q) => {
      const r = await this.find(q, who);
      if (!r) return null;
      const prev = (await q.query<{ sent_at: Date }>('SELECT sent_at FROM customer_resets WHERE customer_id = $1', [r.id])).rows[0];
      if (prev && Date.now() - prev.sent_at.getTime() < 30_000) return null;
      await q.query(
        `INSERT INTO customer_resets (customer_id, code_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes')
         ON CONFLICT (customer_id) DO UPDATE SET code_hash = $2, attempts = 0, sent_at = now(), expires_at = now() + interval '10 minutes', token_hash = NULL, token_expires_at = NULL`, [r.id, hashCode(r.id, c)]);
      return r.phone;
    });
    if (target) await this.sms.send(target, `Your ShopCore password reset code is ${c}. It expires in 10 minutes. If you didn’t ask for it, ignore this message.`);
  }

  async verifyReset(who: string, given: string) {
    let failed = false;
    const token = randomBytes(32).toString('base64url');
    const ok = await this.db.tx(async (q) => {
      const a = await this.find(q, who);
      const r = a && (await q.query<{ code_hash: string; attempts: number; expired: boolean }>('SELECT code_hash, attempts, (expires_at < now()) AS expired FROM customer_resets WHERE customer_id = $1 FOR UPDATE', [a.id])).rows[0];
      if (!a || !r || r.expired) throw new UnprocessableError('CODE_EXPIRED', 'That code has expired. Ask for a new one.');
      if (r.attempts >= 5) throw new AppError('CODE_LOCKED', 'Too many wrong codes. Ask for a new one.', 429);
      if (r.code_hash !== hashCode(a.id, given)) { failed = true; await q.query('UPDATE customer_resets SET attempts = attempts + 1 WHERE customer_id = $1', [a.id]); return false; }
      await q.query(`UPDATE customer_resets SET token_hash = $2, token_expires_at = now() + interval '15 minutes', code_hash = '' WHERE customer_id = $1`, [a.id, hashToken(token)]);
      return true;
    });
    if (failed || !ok) throw new UnprocessableError('WRONG_CODE', 'That code isn’t right. Check the SMS and try again.');
    return { resetToken: token };
  }

  async reset(input: z.infer<typeof ResetSchema>) {
    const hash = await hashPassword(input.password);
    await this.db.tx(async (q) => {
      const r = (await q.query<{ customer_id: string }>(`DELETE FROM customer_resets WHERE token_hash = $1 AND token_expires_at > now() RETURNING customer_id`, [hashToken(input.resetToken)])).rows[0];
      if (!r) throw new UnprocessableError('RESET_EXPIRED', 'This reset has expired. Start again.');
      await q.query('UPDATE customer_accounts SET password_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1', [r.customer_id, hash]);
      await q.query(`UPDATE customer_sessions SET revoked_at = now(), revoked_why = 'password reset' WHERE customer_id = $1 AND revoked_at IS NULL`, [r.customer_id]);
      await audit(q, { id: r.customer_id, requestId: `reset:${r.customer_id}` }, 'customer.password_reset', 'customer', r.customer_id, {});
    });
  }

  // ---- the signed-in customer ---------------------------------------------------------------------------------------------------------------------

  async me(id: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<{ id: string; name: string; email: string; phone: string; area: string; street: string; created_at: Date }>(
        `SELECT cu.id, cu.name, a.email, a.phone, cu.area, cu.street, a.created_at FROM customers cu JOIN customer_accounts a ON a.id = cu.id WHERE cu.id = $1 AND a.status = 'active'`, [id])).rows[0];
      if (!r) throw new NotFoundError('Account');
      return { id: r.id, fullName: r.name, email: r.email, phone: r.phone, area: r.area, street: r.street, joinedAt: r.created_at.toISOString() };
    });
  }

  async updateProfile(id: string, patch: z.infer<typeof ProfilePatchSchema>) {
    await this.db.tx(async (c) => {
      if (patch.email && (await c.query(`SELECT 1 FROM customer_accounts WHERE email = $1 AND status = 'active' AND id <> $2`, [patch.email, id])).rowCount) throw new ConflictError('EMAIL_EXISTS', 'An account with this email already exists', { field: 'email' });
      await c.query('UPDATE customers SET name = COALESCE($2, name), email = COALESCE($3, email), updated_at = now(), version = version + 1 WHERE id = $1', [id, patch.fullName ?? null, patch.email ?? null]);
      if (patch.email) await c.query('UPDATE customer_accounts SET email = $2 WHERE id = $1', [id, patch.email]);
    });
    return this.me(id);
  }

  async changePassword(ctx: CustomerContext, current: string, next: string) {
    const a = (await this.db.read((c) => c.query<{ password_hash: string }>('SELECT password_hash FROM customer_accounts WHERE id = $1', [ctx.id]))).rows[0];
    if (!a || !(await verifyPassword(current, a.password_hash))) throw new UnprocessableError('WRONG_PASSWORD', 'That isn’t your current password');
    const hash = await hashPassword(next);
    await this.db.tx(async (c) => {
      await c.query('UPDATE customer_accounts SET password_hash = $2 WHERE id = $1', [ctx.id, hash]);
      await c.query(`UPDATE customer_sessions SET revoked_at = now(), revoked_why = 'password changed' WHERE customer_id = $1 AND id <> $2 AND revoked_at IS NULL`, [ctx.id, ctx.sessionId]);
    });
  }

  /** Closes the account and wipes the personal details. Orders stay on the shop's books, without a name on them. */
  async deleteAccount(ctx: CustomerContext, pw: string) {
    const a = (await this.db.read((c) => c.query<{ password_hash: string }>(`SELECT password_hash FROM customer_accounts WHERE id = $1 AND status = 'active'`, [ctx.id]))).rows[0];
    if (!a || !(await verifyPassword(pw, a.password_hash))) throw new UnprocessableError('WRONG_PASSWORD', 'That isn’t your password');
    await this.db.tx(async (c) => {
      const open = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE user_id = $1 AND status = 'PAID' AND fulfilled_at IS NULL`, [ctx.id])).rows[0]!.n;
      if (open) throw new UnprocessableError('ORDERS_IN_PROGRESS', 'You have orders on their way. You can delete your account once they arrive.', { orders: open });
      await c.query(`UPDATE customer_accounts SET status = 'deleted', deleted_at = now(), email = 'deleted-' || id || '@deleted.invalid', phone = '+254100000000' WHERE id = $1`, [ctx.id]);
      await c.query(`UPDATE customers SET name = 'Deleted customer', email = '', phone = '', area = '', street = '', push_opt_in = false, email_opt_in = false, sms_opt_in = false, updated_at = now() WHERE id = $1`, [ctx.id]);
      await c.query(`UPDATE customer_sessions SET revoked_at = now(), revoked_why = 'account deleted' WHERE customer_id = $1 AND revoked_at IS NULL`, [ctx.id]);
      await audit(c, { id: ctx.id, requestId: `delete:${ctx.id}` }, 'customer.delete_account', 'customer', ctx.id, {});
    });
  }
}
