import type { FastifyRequest } from 'fastify';
import { ForbiddenError, ValidationError } from '../domain/errors.js';
import type { Action, Module } from '../modules/staff/permissions.js';
import type { StaffContext } from '../modules/staff/staff.js';
import type { Actor } from '../modules/products/products.js';
import { requirePrincipal } from './auth.js';
import type { Authz } from './staff-routes.js';

/** Shared plumbing for permission-checked admin routes. */
export function makeGuard(authz: Authz) {
  const actorOf = (req: FastifyRequest, ctx: StaffContext | null): Actor => ({ id: ctx?.id ?? requirePrincipal(req).sub, name: ctx?.name ?? 'Service', requestId: String(req.id) });

  /** Runs `fn` with the caller’s actor once they hold at least one of the listed permissions. Service tokens with the `admin` role pass. */
  async function guard<T>(req: FastifyRequest, needs: [Module, Action][], fn: (actor: Actor, ctx: StaffContext | null) => Promise<T>): Promise<T> {
    const p = requirePrincipal(req);
    if (p.roles.has('admin')) return fn(actorOf(req, null), null);
    const ctx = await authz.staffContext(req);
    if (!needs.some(([m, a]) => ctx.can(m, a))) throw new ForbiddenError(`You don’t have permission to ${needs[0]![1].toLowerCase()} ${needs[0]![0].toLowerCase()}`);
    return fn(actorOf(req, ctx), ctx);
  }

  const ifMatch = (req: FastifyRequest) => {
    const h = req.headers['if-match'];
    const v = typeof h === 'string' ? Number(h.replace(/"/g, '')) : NaN;
    if (!Number.isInteger(v) || v < 1) throw new ValidationError([{ path: ['If-Match'], message: 'required: the version you read' }]);
    return v;
  };
  const NoStore = (reply: { header: (k: string, v: string) => unknown }) => reply.header('cache-control', 'no-store');

  return { guard, actorOf, ifMatch, NoStore };
}
