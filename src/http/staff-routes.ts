import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, ForbiddenError } from '../domain/errors.js';
import type { Action, Module } from '../modules/staff/permissions.js';
import {
  AuditQuerySchema, ChangePasswordSchema, CreateRoleSchema, CreateStaffSchema, LoginSchema, RefreshSchema,
  StaffListSchema, UpdateProfileSchema, UpdateRoleSchema, UpdateStaffSchema, type StaffContext, type StaffService,
} from '../modules/staff/staff.js';
import { requirePrincipal } from './auth.js';
import { IdParam, parse } from './validate.js';

/**
 * Staff authorisation for admin routes.
 *  - `staffContext` resolves the signed-in person (account active, session live, current role).
 *  - `authorize` additionally requires one permission. Service tokens carrying the `admin` role pass through.
 */
export function makeAuthz(staff: StaffService) {
  async function staffContext(req: FastifyRequest, opts: { allowPending?: boolean } = {}): Promise<StaffContext> {
    const p = requirePrincipal(req);
    if (!p.roles.has('staff') || !p.sid) throw new ForbiddenError('Staff sign-in required');
    const ctx = await staff.context(p.sub, p.sid, String(req.id));
    if (ctx.mustChangePassword && !opts.allowPending) {
      throw new AppError('PASSWORD_CHANGE_REQUIRED', 'Choose a new password before continuing', 403);
    }
    return ctx;
  }
  /** Returns the staff context, or null for a service token that carries the `admin` role. */
  async function authorize(req: FastifyRequest, module: Module, action: Action): Promise<StaffContext | null> {
    const p = requirePrincipal(req);
    if (p.roles.has('admin')) return null;
    const ctx = await staffContext(req);
    if (!ctx.can(module, action)) throw new ForbiddenError(`You don’t have permission to ${action.toLowerCase()} ${module.toLowerCase()}`);
    return ctx;
  }
  /** True when the caller may act on every record of a module (admin service token, or staff holding the permission). */
  async function canAct(req: FastifyRequest, module: Module, action: Action): Promise<boolean> {
    const p = requirePrincipal(req);
    if (p.roles.has('admin')) return true;
    if (!p.roles.has('staff')) return false;
    return (await staffContext(req)).can(module, action);
  }
  return { staffContext, authorize, canAct };
}
export type Authz = ReturnType<typeof makeAuthz>;

const NameParam = z.object({ name: z.string().min(1).max(60) });

/**
 * The web admin keeps its refresh token in an httpOnly cookie, out of reach of page scripts. A browser tells us it is the web admin
 * with `X-Client: web` (a header other sites can't send without our permission), so the cookie is never set for, or read from, anyone else.
 * The phone apps send and receive the token in the body as before.
 */
const COOKIE = 'sc_refresh';
export interface CookieOptions { secure: boolean; maxAgeS: number }

export function registerStaffRoutes(app: FastifyInstance, staff: StaffService, authz: Authz, cookie: CookieOptions = { secure: false, maxAgeS: 12 * 3600 }) {
  const isWeb = (req: FastifyRequest) => req.headers['x-client'] === 'web';
  const fromCookie = (req: FastifyRequest) => /(?:^|;s*)sc_refresh=([A-Za-z0-9_-]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
  const attr = `HttpOnly; SameSite=Strict; Path=/v1/auth${cookie.secure ? '; Secure' : ''}`;
  /** For the web admin: move the refresh token out of the body into the cookie. */
  const hideToken = <T extends { refreshToken: string }>(req: FastifyRequest, reply: { header: (k: string, v: string) => unknown }, out: T): Omit<T, 'refreshToken'> & { refreshToken?: string } => {
    if (!isWeb(req)) return out;
    reply.header('set-cookie', `${COOKIE}=${out.refreshToken}; Max-Age=${cookie.maxAgeS}; ${attr}`);
    const { refreshToken: _t, ...rest } = out;
    return rest;
  };
  const client = (req: FastifyRequest) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''), requestId: String(req.id) });
  const noStore = (reply: { header: (k: string, v: string) => unknown }) => reply.header('cache-control', 'no-store');

  // ---- sign in ------------------------------------------------------------------------
  app.post('/v1/auth/login', async (req, reply) => {
    noStore(reply);
    const { email, password } = parse(LoginSchema, req.body);
    return hideToken(req, reply, await staff.login(email, password, client(req)));
  });
  app.post('/v1/auth/refresh', async (req, reply) => {
    noStore(reply);
    const body = parse(RefreshSchema, req.body ?? {});
    const token = body.refreshToken ?? (isWeb(req) ? fromCookie(req) : undefined);
    if (!token) throw new AppError('SIGN_IN_REQUIRED', 'Please sign in again', 401);
    return hideToken(req, reply, await staff.refresh(token, client(req)));
  });
  app.post('/v1/auth/logout', async (req, reply) => {
    await staff.logout(await authz.staffContext(req, { allowPending: true }));
    if (isWeb(req)) reply.header('set-cookie', `${COOKIE}=; Max-Age=0; ${attr}`);
    return reply.status(204).send();
  });
  app.post('/v1/auth/change-password', async (req, reply) => {
    noStore(reply);
    const ctx = await authz.staffContext(req, { allowPending: true });
    const b = parse(ChangePasswordSchema, req.body);
    return staff.changePassword(ctx, b.currentPassword, b.newPassword);
  });

  // ---- me ---------------------------------------------------------------------------------
  app.get('/v1/me', async (req, reply) => {
    noStore(reply);
    return staff.me((await authz.staffContext(req, { allowPending: true })).id);
  });
  app.patch('/v1/me', async (req) => staff.updateProfile(await authz.staffContext(req), parse(UpdateProfileSchema, req.body)));

  // ---- staff accounts -----------------------------------------------------------------
  app.get('/v1/staff', async (req) => {
    await authz.authorize(req, 'Staff', 'View');
    return { items: await staff.list(parse(StaffListSchema, req.query)) };
  });
  app.get('/v1/staff/:id', async (req) => {
    await authz.authorize(req, 'Staff', 'View');
    return staff.get(parse(IdParam, req.params).id);
  });
  app.post('/v1/staff', async (req, reply) => {
    noStore(reply);
    const ctx = await authz.staffContext(req);
    const out = await staff.create(ctx, parse(CreateStaffSchema, req.body));
    return reply.status(201).header('location', `/v1/staff/${out.staff.id}`).send(out);
  });
  app.patch('/v1/staff/:id', async (req) => {
    const ctx = await authz.staffContext(req);
    return staff.update(ctx, parse(IdParam, req.params).id, parse(UpdateStaffSchema, req.body));
  });
  app.post('/v1/staff/:id/reset-password', async (req, reply) => {
    noStore(reply);
    return staff.resetPassword(await authz.staffContext(req), parse(IdParam, req.params).id);
  });
  app.post('/v1/staff/:id/sign-out', async (req, reply) => {
    await staff.endSessions(await authz.staffContext(req), parse(IdParam, req.params).id);
    return reply.status(204).send();
  });

  // ---- roles & permissions ----------------------------------------------------------------
  app.get('/v1/roles', async (req) => {
    const ctx = await authz.staffContext(req);
    if (!ctx.can('Access', 'View') && !ctx.can('Staff', 'View')) throw new ForbiddenError();
    return { items: await staff.roles() };
  });
  app.post('/v1/roles', async (req, reply) => reply.status(201).send(await staff.createRole(await authz.staffContext(req), parse(CreateRoleSchema, req.body))));
  app.patch('/v1/roles/:name', async (req) => staff.updateRole(await authz.staffContext(req), parse(NameParam, req.params).name, parse(UpdateRoleSchema, req.body)));
  app.delete('/v1/roles/:name', async (req, reply) => {
    await staff.deleteRole(await authz.staffContext(req), parse(NameParam, req.params).name);
    return reply.status(204).send();
  });

  // ---- audit trail ------------------------------------------------------------------------
  app.get('/v1/audit', async (req, reply) => {
    await authz.authorize(req, 'Access', 'View');
    noStore(reply);
    return staff.auditTrail(parse(AuditQuerySchema, req.query));
  });
}
