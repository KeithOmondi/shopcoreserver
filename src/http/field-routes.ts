import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ForbiddenError, ValidationError } from '../domain/errors.js';
import type { RiderContext, RidersService } from '../modules/dispatch/riders.js';
import {
  AvailabilitySchema, CodeRequestSchema, CodeVerifySchema, DOC_KEYS, PingSchema, RegisterSchema, ReviewDocSchema, RiderActionSchema, RiderListSchema, RiderLoginSchema,
  RiderPatchSchema, RiderRefreshSchema, RiderResetSchema, ShiftQuerySchema, ShiftSchema, SubmitDocSchema,
} from '../modules/dispatch/riders.js';
import {
  AssignSchema, DeclineSchema, DeliverSchema, ExceptionListSchema, FailSchema, IncidentListSchema, IncidentSchema, IncidentUpdateSchema, ResolveSchema, StageSchema, type DispatchService,
} from '../modules/dispatch/dispatch.js';
import { AdjustSchema, DepositSchema, PayoutFailSchema, PayoutListSchema, PayoutPaySchema, WithdrawSchema, type RiderMoneyService } from '../modules/dispatch/money.js';
import { DeliverySettingsSchema, ZoneIdParam, ZonePatchSchema, ZoneSchema, type ZonesService } from '../modules/dispatch/zones.js';
import type { CustomersService } from '../modules/orders/admin-orders.js';
import { requirePrincipal, requireRole } from './auth.js';
import { makeGuard } from './guard.js';
import type { Authz } from './staff-routes.js';
import { IdParam, parse } from './validate.js';

export interface FieldServices { zones: ZonesService; riders: RidersService; dispatch: DispatchService; riderMoney: RiderMoneyService; customers: CustomersService }

const DocParam = z.object({ id: z.string(), key: z.enum(DOC_KEYS) });
const ShiftDelete = z.object({ riderId: z.string().uuid(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** Everything about riders and delivery: the rider app’s API, and the dispatch, rider and money screens for staff. */
export function registerFieldRoutes(app: FastifyInstance, svc: FieldServices, authz: Authz) {
  const { zones, riders, dispatch, riderMoney } = svc;
  const { guard, NoStore } = makeGuard(authz);
  const device = (req: FastifyRequest) => String(req.headers['user-agent'] ?? '');

  /** The signed-in rider behind a rider token. */
  async function rider(req: FastifyRequest, opts: { approved?: boolean } = {}): Promise<RiderContext> {
    const p = requirePrincipal(req);
    if (!p.roles.has('rider') || !p.sid) throw new ForbiddenError('Rider sign-in required');
    const ctx = await riders.context(p.sub, p.sid, String(req.id));
    if (opts.approved !== false) riders.requireApproved(ctx);
    return ctx;
  }
  const anyRider = (req: FastifyRequest) => rider(req, { approved: false });

  // ================= the rider app =========================================================================
  app.post('/v1/rider/auth/code', async (req, reply) => { const b = parse(CodeRequestSchema, req.body); await riders.requestCode(b.phone, b.purpose); return reply.status(204).send(); });
  app.post('/v1/rider/auth/verify', async (req, reply) => { const b = parse(CodeVerifySchema, req.body); await riders.verifyCode(b.phone, b.purpose, b.code); return reply.status(204).send(); });
  app.post('/v1/rider/auth/register', async (req, reply) => { NoStore(reply); return reply.status(201).send(await riders.register(parse(RegisterSchema, req.body), device(req))); });
  app.post('/v1/rider/auth/login', async (req, reply) => { NoStore(reply); const b = parse(RiderLoginSchema, req.body); return riders.login(b.phone, b.password, device(req)); });
  app.post('/v1/rider/auth/refresh', async (req, reply) => { NoStore(reply); return riders.refresh(parse(RiderRefreshSchema, req.body).refreshToken, device(req)); });
  app.post('/v1/rider/auth/reset', async (req, reply) => { await riders.resetPassword(parse(RiderResetSchema, req.body)); return reply.status(204).send(); });
  app.post('/v1/rider/auth/logout', async (req, reply) => { await riders.logout(await anyRider(req)); return reply.status(204).send(); });

  app.get('/v1/rider/me', async (req, reply) => { NoStore(reply); return riders.account((await anyRider(req)).id); });
  app.post('/v1/rider/me/welcome', async (req) => riders.welcome(await anyRider(req)));
  app.put('/v1/rider/me/documents/:key', async (req) => riders.submitDoc(await anyRider(req), parse(z.object({ key: z.enum(DOC_KEYS) }), req.params).key, parse(SubmitDocSchema, req.body)));
  app.put('/v1/rider/availability', async (req) => riders.setAvailability(await anyRider(req), parse(AvailabilitySchema, req.body)));
  app.post('/v1/rider/location', async (req, reply) => { await riders.ping(await rider(req), parse(PingSchema, req.body)); return reply.status(204).send(); });

  app.get('/v1/rider/offers', async (req, reply) => { NoStore(reply); return dispatch.offers(await rider(req)); });
  app.post('/v1/rider/offers/:id/accept', async (req) => dispatch.accept(await rider(req), parse(IdParam, req.params).id));
  app.post('/v1/rider/offers/:id/decline', async (req, reply) => { await dispatch.decline(await rider(req), parse(IdParam, req.params).id, parse(DeclineSchema, req.body ?? {}).reason); return reply.status(204).send(); });
  app.get('/v1/rider/active', async (req, reply) => { NoStore(reply); return dispatch.activeFor(await rider(req)); });
  app.post('/v1/rider/deliveries/:id/stage', async (req) => dispatch.stage(await rider(req), parse(IdParam, req.params).id, parse(StageSchema, req.body).stage));
  app.post('/v1/rider/deliveries/:id/deliver', async (req) => dispatch.deliver(await rider(req), parse(IdParam, req.params).id, parse(DeliverSchema, req.body)));
  app.post('/v1/rider/deliveries/:id/fail', async (req, reply) => { await dispatch.fail(await rider(req), parse(IdParam, req.params).id, parse(FailSchema, req.body)); return reply.status(204).send(); });
  app.get('/v1/rider/history', async (req, reply) => { NoStore(reply); return dispatch.history_(await rider(req)); });
  app.get('/v1/rider/earnings', async (req, reply) => { NoStore(reply); return riderMoney.mine(await anyRider(req)); });
  app.post('/v1/rider/withdrawals', async (req, reply) => reply.status(201).send(await riderMoney.withdraw(await rider(req), parse(WithdrawSchema, req.body).amountCents)));
  app.post('/v1/rider/incidents', async (req, reply) => reply.status(201).send(await dispatch.report(await rider(req), parse(IncidentSchema, req.body))));

  // ================= the shopper follows their delivery ======================================================
  app.get('/v1/orders/:id/delivery', async (req, reply) => {
    NoStore(reply);
    return dispatch.forCustomer(requireRole(req, 'customer').sub, parse(IdParam, req.params).id);
  });

  // ================= delivery zones and fees =================================================================
  app.get('/v1/admin/zones', (req, reply) => guard(req, [['Settings', 'View'], ['Dispatch', 'View'], ['Riders', 'View']], async () => { NoStore(reply); return zones.list(); }));
  app.post('/v1/admin/zones', (req, reply) => guard(req, [['Settings', 'Edit']], async (a) => reply.status(201).send(await zones.create(parse(ZoneSchema, req.body), a))));
  app.patch('/v1/admin/zones/:id', (req) => guard(req, [['Settings', 'Edit']], (a) => zones.update(parse(ZoneIdParam, req.params).id, parse(ZonePatchSchema, req.body), a)));
  app.delete('/v1/admin/zones/:id', (req, reply) => guard(req, [['Settings', 'Edit']], async (a) => { await zones.remove(parse(ZoneIdParam, req.params).id, a); return reply.status(204).send(); }));
  app.put('/v1/admin/delivery-settings', (req) => guard(req, [['Settings', 'Edit']], (a) => zones.saveSettings(parse(DeliverySettingsSchema, req.body), a)));

  // ================= riders ======================================================================================
  app.get('/v1/admin/riders', (req, reply) => guard(req, [['Riders', 'View'], ['Dispatch', 'View']], async () => { NoStore(reply); return riders.list(parse(RiderListSchema, req.query)); }));
  app.get('/v1/admin/riders/:id', (req, reply) => guard(req, [['Riders', 'View'], ['Dispatch', 'View']], async () => { NoStore(reply); return riders.get(parse(IdParam, req.params).id); }));
  app.patch('/v1/admin/riders/:id', (req) => guard(req, [['Riders', 'Edit']], (a) => riders.update(parse(IdParam, req.params).id, parse(RiderPatchSchema, req.body), a)));
  app.post('/v1/admin/riders/:id/actions', (req) => guard(req, [['Riders', 'Edit']], (a) => riders.act(parse(IdParam, req.params).id, parse(RiderActionSchema, req.body), a)));
  app.put('/v1/admin/riders/:id/documents/:key', (req) => guard(req, [['Riders', 'Edit']], (a) => { const p = parse(DocParam, req.params); return riders.reviewDoc(parse(IdParam, { id: p.id }).id, p.key, parse(ReviewDocSchema, req.body), a); }));
  app.get('/v1/admin/riders/:id/ledger', (req) => guard(req, [['Payments', 'View'], ['Riders', 'View']], () => riderMoney.ledger(parse(IdParam, req.params).id)));
  app.get('/v1/admin/shifts', (req) => guard(req, [['Riders', 'View'], ['Dispatch', 'View']], () => riders.shifts(parse(ShiftQuerySchema, req.query))));
  app.put('/v1/admin/shifts', (req) => guard(req, [['Riders', 'Edit']], (a) => riders.setShift(parse(ShiftSchema, req.body), a)));
  app.delete('/v1/admin/shifts', (req, reply) => guard(req, [['Riders', 'Edit']], async (a) => { const q = parse(ShiftDelete, req.query); await riders.clearShift(q.riderId, q.day, a); return reply.status(204).send(); }));

  // ================= dispatch ====================================================================================
  app.get('/v1/admin/dispatch/board', (req, reply) => guard(req, [['Dispatch', 'View']], async () => { NoStore(reply); return dispatch.board(); }));
  app.get('/v1/admin/dispatch/orders/:id/suggestions', (req) => guard(req, [['Dispatch', 'View']], () => dispatch.suggest(parse(IdParam, req.params).id)));
  app.get('/v1/admin/dispatch/orders/:id/history', (req) => guard(req, [['Dispatch', 'View'], ['Orders', 'View']], () => dispatch.history(parse(IdParam, req.params).id)));
  app.post('/v1/admin/dispatch/orders/:id/assign', (req) => guard(req, [['Dispatch', 'Edit']], (a) => dispatch.assign(parse(IdParam, req.params).id, parse(AssignSchema, req.body), { ...a, name: a.name ?? 'Staff' })));
  app.post('/v1/admin/dispatch/orders/:id/unassign', (req, reply) => guard(req, [['Dispatch', 'Edit']], async (a) => { await dispatch.unassign(parse(IdParam, req.params).id, { ...a, name: a.name ?? 'Staff' }); return reply.status(204).send(); }));
  app.get('/v1/admin/exceptions', (req, reply) => guard(req, [['Dispatch', 'View']], async () => { NoStore(reply); return dispatch.exceptions(parse(ExceptionListSchema, req.query)); }));
  app.post('/v1/admin/exceptions/:id/resolve', (req, reply) => guard(req, [['Dispatch', 'Edit']], async (a) => { await dispatch.resolve(parse(IdParam, req.params).id, parse(ResolveSchema, req.body).note, { ...a, name: a.name ?? 'Staff' }); return reply.status(204).send(); }));
  app.get('/v1/admin/incidents', (req, reply) => guard(req, [['Dispatch', 'View'], ['Riders', 'View']], async () => { NoStore(reply); return dispatch.incidents(parse(IncidentListSchema, req.query)); }));
  app.get('/v1/admin/incidents/:id', (req) => guard(req, [['Dispatch', 'View'], ['Riders', 'View']], () => dispatch.incident(parse(IdParam, req.params).id)));
  app.post('/v1/admin/incidents/:id', (req) => guard(req, [['Dispatch', 'Edit'], ['Riders', 'Edit']], (a) => dispatch.updateIncident(parse(IdParam, req.params).id, parse(IncidentUpdateSchema, req.body), { ...a, name: a.name ?? 'Staff' })));

  // ================= rider money =================================================================================
  app.get('/v1/admin/payouts', (req, reply) => guard(req, [['Payments', 'View']], async () => { NoStore(reply); return riderMoney.payouts(parse(PayoutListSchema, req.query)); }));
  app.post('/v1/admin/payouts/:id/paid', (req) => guard(req, [['Payments', 'Edit']], (a) => riderMoney.markPaid(parse(IdParam, req.params).id, parse(PayoutPaySchema, req.body), a)));
  app.post('/v1/admin/payouts/:id/failed', (req) => guard(req, [['Payments', 'Edit']], (a) => riderMoney.markFailed(parse(IdParam, req.params).id, parse(PayoutFailSchema, req.body), a)));
  app.post('/v1/admin/riders/:id/adjustments', (req, reply) => guard(req, [['Payments', 'Edit']], async (a) => { await riderMoney.adjust(parse(IdParam, req.params).id, parse(AdjustSchema, req.body), a); return reply.status(204).send(); }));
  app.get('/v1/admin/cash', (req, reply) => guard(req, [['Payments', 'View']], async () => { NoStore(reply); return riderMoney.cash(); }));
  app.post('/v1/admin/cash/:id/deposit', (req) => guard(req, [['Payments', 'Edit']], (a) => riderMoney.receiveDeposit(parse(IdParam, req.params).id, parse(DepositSchema, req.body), a)));

  void ValidationError;
}
