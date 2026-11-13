import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CustomerAuthService, CustomerLoginSchema, CustomerPasswordSchema, CustomerRefreshSchema, DeleteAccountSchema, ForgotSchema, ProfilePatchSchema, ResendSchema, ResetSchema, SignUpSchema,
  VerifyResetSchema, VerifySignupSchema, type CustomerContext,
} from '../modules/customers/auth.js';
import { UnauthorizedError } from '../domain/errors.js';
import { requireRole } from './auth.js';
import { parse } from './validate.js';

/** Shopper sign-in and the shopper's own account. */
export function registerCustomerRoutes(app: FastifyInstance, auth: CustomerAuthService) {
  const device = (req: FastifyRequest) => String(req.headers['user-agent'] ?? '');
  const noStore = (reply: { header: (k: string, v: string) => unknown }) => reply.header('cache-control', 'no-store');
  /** The signed-in shopper, with their session confirmed (so signing out or deleting the account takes effect at once). */
  const me = async (req: FastifyRequest): Promise<CustomerContext> => {
    const p = requireRole(req, 'customer');
    if (!p.sid) throw new UnauthorizedError('Please log in again');
    await auth.assertSession(p.sub, p.sid);
    return { id: p.sub, sessionId: p.sid };
  };

  app.post('/v1/customer/auth/signup', async (req, reply) => { noStore(reply); await auth.signUp(parse(SignUpSchema, req.body)); return reply.status(202).send({ message: 'We sent a code to your phone.' }); });
  app.post('/v1/customer/auth/resend', async (req, reply) => { await auth.resendSignup(parse(ResendSchema, req.body).phone); return reply.status(204).send(); });
  app.post('/v1/customer/auth/verify-signup', async (req, reply) => { noStore(reply); const b = parse(VerifySignupSchema, req.body); return reply.status(201).send(await auth.verifySignup(b.phone, b.code, device(req))); });
  app.post('/v1/customer/auth/login', async (req, reply) => { noStore(reply); const b = parse(CustomerLoginSchema, req.body); return auth.login(b.identifier, b.password, device(req)); });
  app.post('/v1/customer/auth/refresh', async (req, reply) => { noStore(reply); return auth.refresh(parse(CustomerRefreshSchema, req.body).refreshToken, device(req)); });
  app.post('/v1/customer/auth/logout', async (req, reply) => { await auth.logout(await me(req)); return reply.status(204).send(); });
  app.post('/v1/customer/auth/forgot', async (req, reply) => { await auth.forgot(parse(ForgotSchema, req.body).identifier); return reply.status(202).send({ message: 'If that account exists, we sent a code to its phone.' }); });
  app.post('/v1/customer/auth/verify-reset', async (req, reply) => { noStore(reply); const b = parse(VerifyResetSchema, req.body); return auth.verifyReset(b.identifier, b.code); });
  app.post('/v1/customer/auth/reset', async (req, reply) => { await auth.reset(parse(ResetSchema, req.body)); return reply.status(204).send(); });

  app.get('/v1/customer/me', async (req, reply) => { noStore(reply); return auth.me((await me(req)).id); });
  app.patch('/v1/customer/me', async (req) => auth.updateProfile((await me(req)).id, parse(ProfilePatchSchema, req.body)));
  app.post('/v1/customer/me/password', async (req, reply) => { const b = parse(CustomerPasswordSchema, req.body); await auth.changePassword(await me(req), b.currentPassword, b.newPassword); return reply.status(204).send(); });
  app.post('/v1/customer/me/delete', async (req, reply) => { await auth.deleteAccount(await me(req), parse(DeleteAccountSchema, req.body).password); return reply.status(204).send(); });
}
