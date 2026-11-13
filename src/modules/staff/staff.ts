import { createHash, randomBytes } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import type pg from 'pg';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Config } from '../../config/index.js';
import type { Database, Queryable } from '../../infra/db.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import {
  ACCOUNT_MANAGERS, ACTIONS, DEFAULT_ROLES, OWNER_ROLE, isModule, matrixToPairs, pairsToMatrix,
  type Action, type Matrix, type Module,
} from './permissions.js';
import { dummyHash, hashPassword, passwordProblem, temporaryPassword, verifyPassword } from './password.js';

// ---- public shapes ---------------------------------------------------------------------------

export interface StaffView {
  id: string; name: string; email: string; phone: string; role: string;
  status: 'invited' | 'active' | 'suspended'; mustChangePassword: boolean;
  lastLoginAt: string | null; createdAt: string; version: number;
}
export interface RoleView { name: string; blurb: string; system: boolean; staffCount: number; permissions: Matrix }
export interface Actor { id: string; name: string; role: string; requestId: string }
export interface ClientInfo { ip?: string; userAgent?: string; requestId: string }

/** Who is asking, after the token, the account and the session have all been checked. */
export interface StaffContext extends Actor {
  email: string;
  mustChangePassword: boolean;
  sessionId: string;
  can: (module: Module, action: Action) => boolean;
  permissions: Matrix;
}

interface StaffRow {
  id: string; name: string; email: string; phone: string; role: string; status: StaffView['status'];
  password_hash: string; must_change_password: boolean; failed_attempts: number; locked_until: Date | null;
  last_login_at: Date | null; created_at: Date; version: number;
}
const toView = (r: StaffRow): StaffView => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, role: r.role, status: r.status,
  mustChangePassword: r.must_change_password, lastLoginAt: r.last_login_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(), version: r.version,
});

// ---- request schemas -------------------------------------------------------------------------

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const LoginSchema = z.strictObject({ email, password: z.string().min(1).max(256) });
export const RefreshSchema = z.strictObject({ refreshToken: z.string().min(20).max(200).optional() });
export const ChangePasswordSchema = z.strictObject({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) });
export const CreateStaffSchema = z.strictObject({
  name: z.string().trim().min(1).max(120), email,
  phone: z.string().trim().max(32).default(''), role: z.string().trim().min(1).max(60),
});
export const UpdateStaffSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(), phone: z.string().trim().max(32).optional(),
  role: z.string().trim().min(1).max(60).optional(), status: z.enum(['active', 'suspended']).optional(),
  version: z.number().int().min(1).optional(),
}).refine((v) => Object.keys(v).some((k) => k !== 'version'), 'nothing to change');
export const UpdateProfileSchema = z.strictObject({ name: z.string().trim().min(1).max(120).optional(), phone: z.string().trim().max(32).optional() })
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export const StaffListSchema = z.object({ q: z.string().trim().max(100).optional(), role: z.string().max(60).optional(), status: z.enum(['invited', 'active', 'suspended']).optional() });
const matrixShape = z.record(z.string(), z.array(z.boolean()).length(ACTIONS.length));
export const CreateRoleSchema = z.strictObject({ name: z.string().trim().min(2).max(60), blurb: z.string().trim().max(200).default(''), permissions: matrixShape.default({}) });
export const UpdateRoleSchema = z.strictObject({ blurb: z.string().trim().max(200).optional(), permissions: matrixShape.optional() })
  .refine((v) => v.blurb !== undefined || v.permissions !== undefined, 'nothing to change');
export const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional(),
  module: z.string().max(40).optional(), q: z.string().trim().max(100).optional(),
});

// ---- service ---------------------------------------------------------------------------------

const hashToken = (t: string) => createHash('sha256').update(t).digest('base64url');
const newRefreshToken = () => randomBytes(32).toString('base64url');
const CACHE_TTL_MS = 10_000;

interface CacheEntry { at: number; ctx: Omit<StaffContext, 'requestId'> | null }

export class StaffService {
  private key?: Promise<CryptoKey>;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly db: Database, private readonly cfg: Config, private readonly log: Logger) {}

  get loginEnabled() { return Boolean(this.cfg.STAFF_JWT_PRIVATE_KEY); }

  /** Forget cached permissions (after any change to accounts, roles or sessions). */
  invalidate() { this.cache.clear(); }

  // -- tokens ------------------------------------------------------------------------------

  private signingKey() {
    if (!this.cfg.STAFF_JWT_PRIVATE_KEY) throw new AppError('LOGIN_UNAVAILABLE', 'Staff sign-in is not configured on this server', 503);
    return (this.key ??= importPKCS8(this.cfg.STAFF_JWT_PRIVATE_KEY.replace(/\\n/g, '\n'), 'EdDSA') as Promise<CryptoKey>);
  }

  private async accessToken(staffId: string, sessionId: string) {
    const ttl = this.cfg.STAFF_ACCESS_TTL_S;
    return new SignJWT({ roles: ['staff'], sid: sessionId })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setSubject(staffId).setIssuer(this.cfg.JWT_ISSUER).setAudience(this.cfg.JWT_AUDIENCE)
      .setIssuedAt().setExpirationTime(`${ttl}s`)
      .sign(await this.signingKey());
  }

  // -- audit -------------------------------------------------------------------------------

  private async audit(c: Queryable, who: { id: string; name: string }, requestId: string, action: string, module: string, entityType: string, entityId: string, data: Record<string, unknown> = {}) {
    await c.query(
      'INSERT INTO audit_log (actor_id, actor_name, action, module, entity_type, entity_id, data, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [who.id, who.name, action, module, entityType, entityId, JSON.stringify(data), requestId],
    );
  }

  // -- permissions -------------------------------------------------------------------------

  private async loadMatrix(c: Queryable, role: string): Promise<Matrix> {
    if (role === OWNER_ROLE) return pairsToMatrix([], true);
    const { rows } = await c.query<{ module: string; action: string }>('SELECT module, action FROM role_permissions WHERE role = $1', [role]);
    return pairsToMatrix(rows);
  }

  private contextFrom(r: { id: string; name: string; email: string; role: string; must: boolean; sid: string }, matrix: Matrix): Omit<StaffContext, 'requestId'> {
    return {
      id: r.id, name: r.name, email: r.email, role: r.role, mustChangePassword: r.must, sessionId: r.sid, permissions: matrix,
      can: (m, a) => matrix[m]?.[ACTIONS.indexOf(a)] === true,
    };
  }

  /**
   * Checks the person behind a verified token: account still active, session not revoked, current role.
   * Results are cached for a few seconds, so a suspension or role change takes effect almost at once.
   */
  async context(staffId: string, sessionId: string, requestId: string): Promise<StaffContext> {
    const k = `${staffId}:${sessionId}`;
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      if (!hit.ctx) throw new UnauthorizedError('Session ended');
      return { ...hit.ctx, requestId };
    }
    const fresh = await this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; name: string; email: string; role: string; status: string; must: boolean; ok: boolean }>(
        `SELECT s.id, s.name, s.email, s.role, s.status, s.must_change_password AS must,
                (x.revoked_at IS NULL AND x.expires_at > now()) AS ok
           FROM staff s JOIN staff_sessions x ON x.staff_id = s.id AND x.id = $2 WHERE s.id = $1`, [staffId, sessionId]);
      const r = rows[0];
      if (!r || !r.ok || r.status === 'suspended') return null;
      return this.contextFrom({ ...r, sid: sessionId }, await this.loadMatrix(c, r.role));
    });
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(k, { at: Date.now(), ctx: fresh });
    if (!fresh) throw new UnauthorizedError('Session ended');
    return { ...fresh, requestId };
  }

  // -- sign in -----------------------------------------------------------------------------

  private async startSession(c: pg.PoolClient, staffId: string, client: ClientInfo, familyId = uuidv7()) {
    const id = uuidv7();
    const refresh = newRefreshToken();
    await c.query(
      `INSERT INTO staff_sessions (id, staff_id, refresh_hash, family_id, expires_at, ip, user_agent)
       VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5), $6, $7)`,
      [id, staffId, hashToken(refresh), familyId, this.cfg.STAFF_SESSION_TTL_S, client.ip ?? null, (client.userAgent ?? '').slice(0, 300)],
    );
    return { id, refresh };
  }

  async login(emailIn: string, password: string, client: ClientInfo) {
    const row = await this.db.read(async (c) => (await c.query<StaffRow>('SELECT * FROM staff WHERE email = $1', [emailIn])).rows[0]);
    const bad = () => new UnauthorizedError('Incorrect email or password');
    if (!row) {
      await verifyPassword(password, await dummyHash());
      throw bad();
    }
    if (row.locked_until && row.locked_until.getTime() > Date.now()) {
      const mins = Math.ceil((row.locked_until.getTime() - Date.now()) / 60_000);
      throw new AppError('ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or ask IT support.`, 429, undefined, mins * 60);
    }
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      await this.db.tx(async (c) => {
        const { rows } = await c.query<{ failed_attempts: number }>(
          `UPDATE staff SET failed_attempts = failed_attempts + 1,
                  locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1 RETURNING failed_attempts`, [row.id, this.cfg.STAFF_LOCK_ATTEMPTS, this.cfg.STAFF_LOCK_MINUTES]);
        if (rows[0] && rows[0].failed_attempts === this.cfg.STAFF_LOCK_ATTEMPTS) {
          await this.audit(c, { id: row.id, name: row.name }, client.requestId, 'Account locked after failed sign-ins', 'Staff', 'staff', row.id, { ip: client.ip });
        }
      });
      throw bad();
    }
    if (row.status === 'suspended') throw new ForbiddenError('This account is suspended. Ask IT support or the owner.');

    const out = await this.db.tx(async (c) => {
      await c.query(`UPDATE staff SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), status = CASE WHEN must_change_password THEN status ELSE 'active' END WHERE id = $1`, [row.id]);
      const s = await this.startSession(c, row.id, client);
      await this.audit(c, { id: row.id, name: row.name }, client.requestId, 'Signed in', 'Staff', 'staff', row.id, { ip: client.ip });
      return s;
    });
    return this.tokens(row.id, out.id, out.refresh, row.must_change_password);
  }

  private async tokens(staffId: string, sessionId: string, refresh: string, mustChange: boolean) {
    const access = await this.accessToken(staffId, sessionId);
    const me = await this.me(staffId);
    return { accessToken: access, expiresIn: this.cfg.STAFF_ACCESS_TTL_S, refreshToken: refresh, mustChangePassword: mustChange, staff: me };
  }

  async refresh(token: string, client: ClientInfo) {
    const hash = hashToken(token);
    const result = await this.db.tx(async (c) => {
      const { rows } = await c.query<{ id: string; staff_id: string; family_id: string; revoked_at: Date | null; revoked_why: string | null; expired: boolean; status: string; must: boolean }>(
        `SELECT x.id, x.staff_id, x.family_id, x.revoked_at, x.revoked_why, (x.expires_at <= now()) AS expired, s.status, s.must_change_password AS must
           FROM staff_sessions x JOIN staff s ON s.id = x.staff_id WHERE x.refresh_hash = $1 FOR UPDATE OF x`, [hash]);
      const r = rows[0];
      if (!r) return { fail: 'unknown' as const };
      if (r.revoked_at) {
        // A rotated token showing up again means it was copied: end the whole sign-in family.
        if (r.revoked_why === 'rotated') {
          await c.query(`UPDATE staff_sessions SET revoked_at = now(), revoked_why = 'reuse detected' WHERE family_id = $1 AND revoked_at IS NULL`, [r.family_id]);
          return { fail: 'reuse' as const };
        }
        return { fail: 'revoked' as const };
      }
      if (r.expired || r.status === 'suspended') return { fail: 'expired' as const };
      await c.query(`UPDATE staff_sessions SET revoked_at = now(), revoked_why = 'rotated' WHERE id = $1`, [r.id]);
      const s = await this.startSession(c, r.staff_id, client, r.family_id);
      return { staffId: r.staff_id, s, must: r.must };
    });
    this.invalidate();
    if ('fail' in result) throw new UnauthorizedError('Please sign in again');
    return this.tokens(result.staffId, result.s.id, result.s.refresh, result.must);
  }

  async logout(ctx: StaffContext) {
    await this.db.tx(async (c) => {
      await c.query(`UPDATE staff_sessions SET revoked_at = now(), revoked_why = 'signed out' WHERE id = $1 AND revoked_at IS NULL`, [ctx.sessionId]);
      await this.audit(c, ctx, ctx.requestId, 'Signed out', 'Staff', 'staff', ctx.id);
    });
    this.invalidate();
  }

  async changePassword(ctx: StaffContext, current: string, next: string) {
    const row = (await this.db.read(async (c) => (await c.query<StaffRow>('SELECT * FROM staff WHERE id = $1', [ctx.id])).rows[0]))!;
    if (!(await verifyPassword(current, row.password_hash))) throw new UnprocessableError('WRONG_PASSWORD', 'Your current password isn’t right');
    const problem = passwordProblem(next, row.email);
    if (problem) throw new UnprocessableError('WEAK_PASSWORD', problem);
    if (await verifyPassword(next, row.password_hash)) throw new UnprocessableError('PASSWORD_REUSED', 'Choose a password you haven’t used before');
    const hash = await hashPassword(next);
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE staff SET password_hash = $2, must_change_password = false, status = 'active', password_changed_at = now(), failed_attempts = 0, locked_until = NULL,
                updated_at = now(), version = version + 1 WHERE id = $1`, [ctx.id, hash]);
      await c.query(`UPDATE staff_sessions SET revoked_at = now(), revoked_why = 'password changed' WHERE staff_id = $1 AND id <> $2 AND revoked_at IS NULL`, [ctx.id, ctx.sessionId]);
      await this.audit(c, ctx, ctx.requestId, 'Chose a new password', 'Staff', 'staff', ctx.id);
    });
    this.invalidate();
    return { accessToken: await this.accessToken(ctx.id, ctx.sessionId), expiresIn: this.cfg.STAFF_ACCESS_TTL_S };
  }

  async me(staffId: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<StaffRow>('SELECT * FROM staff WHERE id = $1', [staffId])).rows[0];
      if (!r) throw new NotFoundError('Staff member');
      return { ...toView(r), permissions: await this.loadMatrix(c, r.role) };
    });
  }

  async updateProfile(ctx: StaffContext, patch: z.infer<typeof UpdateProfileSchema>) {
    await this.db.tx(async (c) => {
      await c.query('UPDATE staff SET name = COALESCE($2, name), phone = COALESCE($3, phone), updated_at = now(), version = version + 1 WHERE id = $1', [ctx.id, patch.name ?? null, patch.phone ?? null]);
      await this.audit(c, ctx, ctx.requestId, 'Updated own profile', 'Staff', 'staff', ctx.id);
    });
    this.invalidate();
    return this.me(ctx.id);
  }

  // -- staff management --------------------------------------------------------------------

  /** Accounts are created, reset and suspended only by the owner and IT support. */
  private requireManager(ctx: StaffContext, action: Action) {
    if (!ACCOUNT_MANAGERS.includes(ctx.role) || !ctx.can('Staff', action)) throw new ForbiddenError('Only the owner and IT support can manage staff accounts');
  }

  async list(filter: z.infer<typeof StaffListSchema>): Promise<StaffView[]> {
    return this.db.read(async (c) => {
      const { rows } = await c.query<StaffRow>(
        `SELECT * FROM staff
          WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR role = $2) AND ($3::text IS NULL OR status = $3)
          ORDER BY name LIMIT 500`, [filter.q ?? null, filter.role ?? null, filter.status ?? null]);
      return rows.map(toView);
    });
  }

  async get(id: string): Promise<StaffView> {
    return this.db.read(async (c) => {
      const r = (await c.query<StaffRow>('SELECT * FROM staff WHERE id = $1', [id])).rows[0];
      if (!r) throw new NotFoundError('Staff member');
      return toView(r);
    });
  }

  private async assertRoleExists(c: Queryable, role: string) {
    const { rowCount } = await c.query('SELECT 1 FROM roles WHERE name = $1', [role]);
    if (!rowCount) throw new ValidationError([{ path: ['role'], message: `Unknown role “${role}”` }]);
  }

  async create(ctx: StaffContext, input: z.infer<typeof CreateStaffSchema>) {
    this.requireManager(ctx, 'Create');
    if (input.role === OWNER_ROLE && ctx.role !== OWNER_ROLE) throw new ForbiddenError('Only an owner can create another owner');
    const temp = temporaryPassword();
    const hash = await hashPassword(temp);
    const id = uuidv7();
    const row = await this.db.tx(async (c) => {
      await this.assertRoleExists(c, input.role);
      try {
        const { rows } = await c.query<StaffRow>(
          `INSERT INTO staff (id, name, email, phone, role, status, password_hash, must_change_password, created_by)
           VALUES ($1,$2,$3,$4,$5,'invited',$6,true,$7) RETURNING *`, [id, input.name, input.email, input.phone, input.role, hash, ctx.id]);
        await this.audit(c, ctx, ctx.requestId, `Created staff account · ${input.name}`, 'Staff', 'staff', id, { role: input.role });
        return rows[0]!;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictError('EMAIL_EXISTS', 'Someone already has an account with that email');
        throw e;
      }
    });
    return { staff: toView(row), temporaryPassword: temp };
  }

  private async lockedTarget(c: pg.PoolClient, id: string) {
    const r = (await c.query<StaffRow>('SELECT * FROM staff WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new NotFoundError('Staff member');
    return r;
  }

  private async otherActiveOwners(c: Queryable, exceptId: string) {
    const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM staff WHERE role = $1 AND status <> 'suspended' AND id <> $2`, [OWNER_ROLE, exceptId]);
    return rows[0]!.n;
  }

  async update(ctx: StaffContext, id: string, patch: z.infer<typeof UpdateStaffSchema>) {
    this.requireManager(ctx, 'Edit');
    const out = await this.db.tx(async (c) => {
      const t = await this.lockedTarget(c, id);
      if (patch.version !== undefined && patch.version !== t.version) throw new ConflictError('VERSION_CONFLICT', 'Someone else changed this account. Reload and try again.');
      if (t.role === OWNER_ROLE && ctx.role !== OWNER_ROLE) throw new ForbiddenError('Only an owner can change an owner account');
      const roleChange = patch.role !== undefined && patch.role !== t.role;
      const statusChange = patch.status !== undefined && patch.status !== (t.status === 'suspended' ? 'suspended' : 'active');
      if ((roleChange || statusChange) && id === ctx.id) throw new ForbiddenError('You can’t change your own role or status');
      if (roleChange) {
        await this.assertRoleExists(c, patch.role!);
        if (patch.role === OWNER_ROLE && ctx.role !== OWNER_ROLE) throw new ForbiddenError('Only an owner can make someone an owner');
      }
      const leavesOwners = t.role === OWNER_ROLE && ((roleChange && patch.role !== OWNER_ROLE) || patch.status === 'suspended');
      if (leavesOwners && (await this.otherActiveOwners(c, id)) === 0) throw new ConflictError('LAST_OWNER', 'There must always be at least one active owner');

      let status: StaffView['status'] = t.status;
      if (patch.status === 'suspended') status = 'suspended';
      else if (patch.status === 'active' && t.status === 'suspended') status = t.last_login_at && !t.must_change_password ? 'active' : 'invited';

      const { rows } = await c.query<StaffRow>(
        `UPDATE staff SET name = COALESCE($2, name), phone = COALESCE($3, phone), role = COALESCE($4, role), status = $5, updated_at = now(), version = version + 1
          WHERE id = $1 RETURNING *`, [id, patch.name ?? null, patch.phone ?? null, patch.role ?? null, status]);
      if (status === 'suspended' && t.status !== 'suspended') {
        await c.query(`UPDATE staff_sessions SET revoked_at = now(), revoked_why = 'suspended' WHERE staff_id = $1 AND revoked_at IS NULL`, [id]);
        await this.audit(c, ctx, ctx.requestId, `Suspended account · ${t.name}`, 'Staff', 'staff', id);
      } else if (t.status === 'suspended' && status !== 'suspended') {
        await this.audit(c, ctx, ctx.requestId, `Reactivated account · ${t.name}`, 'Staff', 'staff', id);
      }
      if (roleChange) {
        await c.query(`UPDATE staff_sessions SET revoked_at = now(), revoked_why = 'role changed' WHERE staff_id = $1 AND revoked_at IS NULL`, [id]);
        await this.audit(c, ctx, ctx.requestId, `Changed role · ${t.name}: ${t.role} → ${patch.role}`, 'Staff', 'staff', id, { from: t.role, to: patch.role });
      }
      if (patch.name !== undefined || patch.phone !== undefined) await this.audit(c, ctx, ctx.requestId, `Edited staff details · ${t.name}`, 'Staff', 'staff', id);
      return toView(rows[0]!);
    });
    this.invalidate();
    return out;
  }

  async resetPassword(ctx: StaffContext, id: string) {
    this.requireManager(ctx, 'Edit');
    if (id === ctx.id) throw new ForbiddenError('Use “Change password” for your own account');
    const temp = temporaryPassword();
    const hash = await hashPassword(temp);
    await this.db.tx(async (c) => {
      const t = await this.lockedTarget(c, id);
      if (t.role === OWNER_ROLE && ctx.role !== OWNER_ROLE) throw new ForbiddenError('Only an owner can reset an owner’s password');
      await c.query(`UPDATE staff SET password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = NULL, updated_at = now(), version = version + 1 WHERE id = $1`, [id, hash]);
      await c.query(`UPDATE staff_sessions SET revoked_at = now(), revoked_why = 'password reset' WHERE staff_id = $1 AND revoked_at IS NULL`, [id]);
      await this.audit(c, ctx, ctx.requestId, `Reset password · ${t.name}`, 'Staff', 'staff', id);
    });
    this.invalidate();
    return { temporaryPassword: temp };
  }

  async endSessions(ctx: StaffContext, id: string) {
    this.requireManager(ctx, 'Edit');
    await this.db.tx(async (c) => {
      const t = await this.lockedTarget(c, id);
      if (t.role === OWNER_ROLE && ctx.role !== OWNER_ROLE) throw new ForbiddenError('Only an owner can sign an owner out');
      await c.query(`UPDATE staff_sessions SET revoked_at = now(), revoked_why = 'signed out by admin' WHERE staff_id = $1 AND revoked_at IS NULL`, [id]);
      await this.audit(c, ctx, ctx.requestId, `Signed out everywhere · ${t.name}`, 'Staff', 'staff', id);
    });
    this.invalidate();
  }

  // -- roles -------------------------------------------------------------------------------

  async roles(): Promise<RoleView[]> {
    return this.db.read(async (c) => {
      // One client runs one query at a time.
      const { rows: rs } = await c.query<{ name: string; blurb: string; is_system: boolean }>('SELECT name, blurb, is_system FROM roles ORDER BY is_system DESC, name');
      const { rows: ps } = await c.query<{ role: string; module: string; action: string }>('SELECT role, module, action FROM role_permissions');
      const { rows: cs } = await c.query<{ role: string; n: number }>('SELECT role, count(*)::int AS n FROM staff GROUP BY role');
      return rs.map((r) => ({
        name: r.name, blurb: r.blurb, system: r.is_system, staffCount: cs.find((x) => x.role === r.name)?.n ?? 0,
        permissions: pairsToMatrix(ps.filter((p) => p.role === r.name), r.is_system && r.name === OWNER_ROLE),
      }));
    });
  }

  private parseMatrix(raw: Record<string, boolean[]>) {
    for (const k of Object.keys(raw)) if (!isModule(k)) throw new ValidationError([{ path: ['permissions', k], message: `Unknown module “${k}”` }]);
    return matrixToPairs(raw);
  }

  /** IT support may edit roles, but can never hand out a permission they don’t hold themselves. */
  private assertNoEscalation(ctx: StaffContext, pairs: { module: Module; action: Action }[]) {
    if (ctx.role === OWNER_ROLE) return;
    const bad = pairs.find((p) => !ctx.can(p.module, p.action));
    if (bad) throw new ForbiddenError(`You can’t grant ${bad.action} on ${bad.module}, because you don’t have it yourself`);
  }

  async createRole(ctx: StaffContext, input: z.infer<typeof CreateRoleSchema>) {
    if (!ctx.can('Access', 'Edit')) throw new ForbiddenError();
    const pairs = this.parseMatrix(input.permissions);
    this.assertNoEscalation(ctx, pairs);
    await this.db.tx(async (c) => {
      try {
        await c.query('INSERT INTO roles (name, blurb) VALUES ($1,$2)', [input.name, input.blurb]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictError('ROLE_EXISTS', 'A role with that name already exists');
        throw e;
      }
      await this.writePairs(c, input.name, pairs);
      await this.audit(c, ctx, ctx.requestId, `Created role · ${input.name}`, 'Access', 'role', input.name);
    });
    this.invalidate();
    return (await this.roles()).find((r) => r.name === input.name)!;
  }

  private async writePairs(c: Queryable, role: string, pairs: { module: Module; action: Action }[]) {
    await c.query('DELETE FROM role_permissions WHERE role = $1', [role]);
    if (pairs.length) {
      await c.query('INSERT INTO role_permissions (role, module, action) SELECT $1, m, a FROM unnest($2::text[], $3::text[]) AS t(m, a)', [role, pairs.map((p) => p.module), pairs.map((p) => p.action)]);
    }
  }

  async updateRole(ctx: StaffContext, name: string, patch: z.infer<typeof UpdateRoleSchema>) {
    if (!ctx.can('Access', 'Edit')) throw new ForbiddenError();
    await this.db.tx(async (c) => {
      const r = (await c.query<{ is_system: boolean }>('SELECT is_system FROM roles WHERE name = $1 FOR UPDATE', [name])).rows[0];
      if (!r) throw new NotFoundError('Role');
      if (r.is_system) throw new ForbiddenError('The owner role always has full access and can’t be changed');
      if (name === ctx.role && patch.permissions) throw new ForbiddenError('You can’t change the permissions of your own role');
      if (patch.permissions) {
        const pairs = this.parseMatrix(patch.permissions);
        this.assertNoEscalation(ctx, pairs);
        await this.writePairs(c, name, pairs);
      }
      if (patch.blurb !== undefined) await c.query('UPDATE roles SET blurb = $2 WHERE name = $1', [name, patch.blurb]);
      await c.query('UPDATE roles SET updated_at = now() WHERE name = $1', [name]);
      await this.audit(c, ctx, ctx.requestId, `Changed permissions · ${name}`, 'Access', 'role', name);
    });
    this.invalidate();
    return (await this.roles()).find((r) => r.name === name)!;
  }

  async deleteRole(ctx: StaffContext, name: string) {
    if (ctx.role !== OWNER_ROLE || !ctx.can('Access', 'Delete')) throw new ForbiddenError('Only an owner can delete a role');
    await this.db.tx(async (c) => {
      const r = (await c.query<{ is_system: boolean }>('SELECT is_system FROM roles WHERE name = $1 FOR UPDATE', [name])).rows[0];
      if (!r) throw new NotFoundError('Role');
      if (r.is_system) throw new ForbiddenError('The owner role can’t be deleted');
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM staff WHERE role = $1', [name])).rows[0]!.n;
      if (n > 0) throw new ConflictError('ROLE_IN_USE', `${n} staff still have this role. Move them to another role first.`);
      await c.query('DELETE FROM roles WHERE name = $1', [name]);
      await this.audit(c, ctx, ctx.requestId, `Deleted role · ${name}`, 'Access', 'role', name);
    });
    this.invalidate();
  }

  // -- audit trail -------------------------------------------------------------------------

  async auditTrail(q: z.infer<typeof AuditQuerySchema>) {
    const before = q.cursor ? Number(decodeCursor(q.cursor, 1)[0]) : null;
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: number; actor_id: string; actor_name: string | null; action: string; module: string | null; entity_type: string; entity_id: string; data: unknown; created_at: Date }>(
        `SELECT id, actor_id, actor_name, action, module, entity_type, entity_id, data, created_at FROM audit_log
          WHERE ($1::bigint IS NULL OR id < $1) AND ($2::text IS NULL OR module = $2)
            AND ($3::text IS NULL OR action ILIKE '%' || $3 || '%' OR actor_name ILIKE '%' || $3 || '%')
          ORDER BY id DESC LIMIT $4`, [before, q.module ?? null, q.q ?? null, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({ id: String(r.id), actorId: r.actor_id, actor: r.actor_name ?? 'System', action: r.action, module: r.module ?? r.entity_type, entityType: r.entity_type, entityId: r.entity_id, data: r.data, at: r.created_at.toISOString() })),
        nextCursor: rows.length > q.limit ? encodeCursor([String(page[page.length - 1]!.id)]) : null,
      };
    });
  }

  // -- seeding -----------------------------------------------------------------------------

  /** Makes sure the standard roles exist. Existing roles keep whatever permissions an owner has set. */
  async ensureDefaultRoles() {
    await this.db.tx(async (c) => {
      for (const r of DEFAULT_ROLES) {
        const ins = await c.query('INSERT INTO roles (name, blurb, is_system) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING', [r.name, r.blurb, r.system ?? false]);
        if (ins.rowCount) await this.writePairs(c, r.name, matrixToPairs(r.matrix));
      }
    });
  }

  /** First-run: creates the owner if there are no staff at all. Returns the one-time password, or null if staff already exist. */
  async bootstrapOwner(name: string, emailIn: string, password?: string): Promise<string | null> {
    await this.ensureDefaultRoles();
    const temp = password ?? temporaryPassword();
    const hash = await hashPassword(temp);
    const made = await this.db.tx(async (c) => {
      await c.query('LOCK TABLE staff IN EXCLUSIVE MODE');
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM staff')).rows[0]!.n;
      if (n > 0) return false;
      const id = uuidv7();
      await c.query(`INSERT INTO staff (id, name, email, role, status, password_hash, must_change_password) VALUES ($1,$2,$3,$4,'invited',$5,true)`, [id, name, emailIn.toLowerCase(), OWNER_ROLE, hash]);
      await this.audit(c, { id, name }, 'bootstrap', 'Created the owner account', 'Staff', 'staff', id);
      return true;
    });
    return made ? temp : null;
  }

  /** Inserts a staff record directly (seed and tests only). */
  async insertRaw(v: { name: string; email: string; phone?: string; role: string; status: StaffView['status']; password: string; mustChange: boolean }) {
    const hash = await hashPassword(v.password);
    const id = uuidv7();
    await this.db.tx((c) => c.query(
      `INSERT INTO staff (id, name, email, phone, role, status, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (email) DO NOTHING`,
      [id, v.name, v.email.toLowerCase(), v.phone ?? '', v.role, v.status, hash, v.mustChange]));
    return id;
  }
}

