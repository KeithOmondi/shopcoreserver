import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CustomerAuthService, CustomerLoginSchema, CustomerPasswordSchema, CustomerRefreshSchema, DeleteAccountSchema, ForgotSchema, ResendSchema, ResetSchema, SignUpSchema,
  VerifyResetSchema, VerifySignupSchema, type CustomerContext,
} from '../modules/customers/auth.js';
import { AddressPatchSchema, AddressSchema, CustomerAccountService, PhoneChangeSchema, PhoneVerifySchema, PreferencesPatchSchema, ProfileUpdateSchema } from '../modules/customers/account.js';
import { CustomerEngagementService, WishlistSchema } from '../modules/customers/engagement.js';
import { CustomerOrderListSchema, type CustomerOrdersService } from '../modules/orders/customer-orders.js';
import { PushTokenSchema, type PushService } from '../modules/integrations/push.js';
import { RedeemSchema, type RewardsService } from '../modules/customers/rewards.js';
import { UnauthorizedError } from '../domain/errors.js';
import { requireRole } from './auth.js';
import { IdParam, parse } from './validate.js';

/** Shopper sign-in and the shopper's own account. */
export function registerCustomerRoutes(app: FastifyInstance, auth: CustomerAuthService, account: CustomerAccountService, orders: CustomerOrdersService, engagement: CustomerEngagementService, push?: PushService, rewards?: RewardsService) {
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

  app.get('/v1/customer/me', async (req, reply) => { noStore(reply); return account.profile((await me(req)).id); });
  app.patch('/v1/customer/me', async (req) => account.updateProfile((await me(req)).id, parse(ProfileUpdateSchema, req.body)));
  // Changing the phone number: a code goes to the new number, and only the right code switches it.
  app.post('/v1/customer/me/phone', async (req, reply) => { await account.requestPhoneChange((await me(req)).id, parse(PhoneChangeSchema, req.body).phone); return reply.status(202).send({ message: 'We sent a code to the new number.' }); });
  app.post('/v1/customer/me/phone/verify', async (req) => account.verifyPhoneChange((await me(req)).id, parse(PhoneVerifySchema, req.body).code));

  // Saved items, the notification inbox, and what shoppers say about a product.
  app.get('/v1/customer/wishlist', async (req, reply) => { noStore(reply); return engagement.wishlist(requireRole(req, 'customer').sub); });
  app.post('/v1/customer/wishlist', async (req) => engagement.addToWishlist(requireRole(req, 'customer').sub, parse(WishlistSchema, req.body).productId));
  app.delete('/v1/customer/wishlist/:id', async (req, reply) => { await engagement.removeFromWishlist(requireRole(req, 'customer').sub, parse(IdParam, req.params).id); return reply.status(204).send(); });
  app.get('/v1/customer/notifications', async (req, reply) => { noStore(reply); return engagement.notifications(requireRole(req, 'customer').sub); });
  app.post('/v1/customer/notifications/read', async (req, reply) => { await engagement.markNotificationsRead(requireRole(req, 'customer').sub); return reply.status(204).send(); });
  app.get('/v1/storefront/products/:id/reviews', async (req, reply) => { reply.header('cache-control', 'public, max-age=30'); return engagement.productReviews(parse(IdParam, req.params).id); });

  app.get('/v1/customer/addresses', async (req, reply) => { noStore(reply); return account.addresses((await me(req)).id); });
  app.post('/v1/customer/addresses', async (req, reply) => reply.status(201).send(await account.addAddress((await me(req)).id, parse(AddressSchema, req.body))));
  app.patch('/v1/customer/addresses/:id', async (req) => account.updateAddress((await me(req)).id, parse(IdParam, req.params).id, parse(AddressPatchSchema, req.body)));
  app.delete('/v1/customer/addresses/:id', async (req, reply) => { await account.deleteAddress((await me(req)).id, parse(IdParam, req.params).id); return reply.status(204).send(); });

  app.post('/v1/customer/push-token', async (req, reply) => { const u = await me(req); const b = parse(PushTokenSchema, req.body); await push?.register({ type: 'customer', id: u.id }, b.token, b.platform); return reply.status(204).send(); });
  app.delete('/v1/customer/push-token', async (req, reply) => { const u = await me(req); await push?.unregister({ type: 'customer', id: u.id }, parse(PushTokenSchema.pick({ token: true }), req.body).token); return reply.status(204).send(); });
  if (rewards) {
    app.get('/v1/customer/rewards', async (req, reply) => { noStore(reply); return rewards.account((await me(req)).id); });
    app.post('/v1/customer/rewards/redeem', async (req) => rewards.redeem((await me(req)).id, parse(RedeemSchema, req.body).points));
  }
  app.get('/v1/customer/preferences', async (req, reply) => { noStore(reply); return account.preferences((await me(req)).id); });
  app.patch('/v1/customer/preferences', async (req) => account.setPreferences((await me(req)).id, parse(PreferencesPatchSchema, req.body)));

  // Orders, in the words the app uses (processing / in transit / delivered / cancelled), with a real timeline, the rider and the handover code.
  app.get('/v1/customer/orders', async (req, reply) => { noStore(reply); return orders.list(requireRole(req, 'customer').sub, parse(CustomerOrderListSchema, req.query)); });
  app.get('/v1/customer/orders/:id', async (req, reply) => { noStore(reply); return orders.get(requireRole(req, 'customer').sub, parse(IdParam, req.params).id); });

  /** Where the shop delivers and what it costs. Public: the app shows it before anyone logs in. */
  app.get('/v1/delivery/areas', async (_req, reply) => { reply.header('cache-control', 'public, max-age=60'); return account.areas(); });
  app.post('/v1/customer/me/password', async (req, reply) => { const b = parse(CustomerPasswordSchema, req.body); await auth.changePassword(await me(req), b.currentPassword, b.newPassword); return reply.status(204).send(); });
  app.post('/v1/customer/me/delete', async (req, reply) => { await auth.deleteAccount(await me(req), parse(DeleteAccountSchema, req.body).password); return reply.status(204).send(); });
}
