import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RidersService } from '../modules/dispatch/riders.js';
import {
  DisputeListSchema, DisputePatchSchema, NewDisputeSchema, NoteSchema, OwnRefundSchema, OwnReturnSchema, RefundDecisionSchema, RefundListSchema, ResolveDisputeSchema, ReturnDecisionSchema, ReturnListSchema,
  StaffRefundSchema, type ClaimsActor, type ClaimsService,
} from '../modules/support/claims.js';
import {
  AgentReplySchema, ArticlePatchSchema, ArticleSchema, AssignSchema, CannedPatchSchema, CannedSchema, ChatListSchema, ChatMessageSchema, HelpSearchSchema, OwnTicketSchema, RateSchema, ReviewListSchema,
  ReviewReplySchema, ReviewSchema, ReviewStateSchema, StaffTicketSchema, StartChatSchema, TextSchema, TicketListSchema, TicketStatusSchema, type SupportService,
} from '../modules/support/support.js';
import { ForbiddenError } from '../domain/errors.js';
import { requirePrincipal, requireRole } from './auth.js';
import { makeGuard } from './guard.js';
import type { Authz } from './staff-routes.js';
import { IdParam, parse } from './validate.js';

export interface SupportServices { support: SupportService; claims: ClaimsService; riders: RidersService }

/** Support desk (Support and Claims modules) plus what shoppers and riders can do for themselves. */
export function registerSupportRoutes(app: FastifyInstance, svc: SupportServices, authz: Authz) {
  const { support, claims, riders } = svc;
  const { guard, NoStore } = makeGuard(authz);
  const staffName = (a: { name?: string }) => a.name ?? 'Staff';
  /** Claims actors may approve large refunds only with payments access. */
  const claimsActor = (a: { id: string; requestId: string; name?: string }, canLarge: boolean): ClaimsActor => ({ ...a, name: staffName(a), canApproveLarge: canLarge });

  // ============ staff: the support desk ============================================================================
  app.get('/v1/admin/support/overview', (req, reply) => guard(req, [['Support', 'View'], ['Claims', 'View']], async () => { NoStore(reply); return support.overview(); }));
  app.get('/v1/admin/support/agents', (req) => guard(req, [['Support', 'View']], () => support.agents()));

  app.get('/v1/admin/tickets', (req, reply) => guard(req, [['Support', 'View']], async (a) => { NoStore(reply); return support.tickets(parse(TicketListSchema, req.query), a.id); }));
  app.get('/v1/admin/tickets/:id', (req, reply) => guard(req, [['Support', 'View']], async () => { NoStore(reply); return support.ticket(parse(IdParam, req.params).id); }));
  app.post('/v1/admin/tickets', (req, reply) => guard(req, [['Support', 'Create']], async (a) => reply.status(201).send(await support.openForPerson(parse(StaffTicketSchema, req.body), a))));
  app.post('/v1/admin/tickets/:id/reply', (req) => guard(req, [['Support', 'Edit']], (a) => support.reply(parse(IdParam, req.params).id, parse(AgentReplySchema, req.body), { ...a, name: staffName(a) })));
  app.post('/v1/admin/tickets/:id/assign', (req) => guard(req, [['Support', 'Edit']], (a) => support.assign(parse(IdParam, req.params).id, parse(AssignSchema, req.body).assigneeId, a)));
  app.post('/v1/admin/tickets/:id/status', (req) => guard(req, [['Support', 'Edit']], (a) => support.setStatus(parse(IdParam, req.params).id, parse(TicketStatusSchema, req.body), a)));

  app.get('/v1/admin/chats', (req, reply) => guard(req, [['Support', 'View']], async (a) => { NoStore(reply); return support.chats(parse(ChatListSchema, req.query), a.id); }));
  app.get('/v1/admin/chats/:id', (req, reply) => guard(req, [['Support', 'View']], async () => { NoStore(reply); return support.chat(parse(IdParam, req.params).id); }));
  app.post('/v1/admin/chats', (req, reply) => guard(req, [['Support', 'Create']], async (a) => reply.status(201).send(await support.chatStart(parse(StartChatSchema, req.body), a))));
  app.post('/v1/admin/chats/:id/messages', (req) => guard(req, [['Support', 'Edit']], (a) => support.chatSend(parse(IdParam, req.params).id, parse(TextSchema, req.body).text, a)));
  app.post('/v1/admin/chats/:id/take', (req) => guard(req, [['Support', 'Edit']], (a) => support.chatTake(parse(IdParam, req.params).id, a)));
  app.post('/v1/admin/chats/:id/close', (req, reply) => guard(req, [['Support', 'Edit']], async (a) => { await support.chatClose(parse(IdParam, req.params).id, a); return reply.status(204).send(); }));

  app.get('/v1/admin/reviews', (req, reply) => guard(req, [['Support', 'View']], async () => { NoStore(reply); return support.reviews(parse(ReviewListSchema, req.query)); }));
  app.post('/v1/admin/reviews/:id/reply', (req, reply) => guard(req, [['Support', 'Edit']], async (a) => { await support.replyReview(parse(IdParam, req.params).id, parse(ReviewReplySchema, req.body).text, { ...a, name: staffName(a) }); return reply.status(204).send(); }));
  app.post('/v1/admin/reviews/:id/state', (req, reply) => guard(req, [['Support', 'Edit']], async (a) => { await support.setReviewState(parse(IdParam, req.params).id, parse(ReviewStateSchema, req.body).state, a); return reply.status(204).send(); }));

  app.get('/v1/admin/articles', (req) => guard(req, [['Support', 'View']], async () => ({ items: await support.articles(false, parse(HelpSearchSchema, req.query).q) })));
  app.get('/v1/admin/articles/:id', (req) => guard(req, [['Support', 'View']], () => support.readArticle(parse(IdParam, req.params).id, false)));
  app.get('/v1/admin/help/missed-searches', (req) => guard(req, [['Support', 'View']], () => support.missedSearches()));
  app.post('/v1/admin/articles', (req, reply) => guard(req, [['Support', 'Create']], async (a) => reply.status(201).send(await support.saveArticle(null, parse(ArticleSchema, req.body), { ...a, name: staffName(a) }))));
  app.patch('/v1/admin/articles/:id', (req) => guard(req, [['Support', 'Edit']], (a) => support.saveArticle(parse(IdParam, req.params).id, parse(ArticlePatchSchema, req.body), { ...a, name: staffName(a) })));

  app.get('/v1/admin/canned-replies', (req) => guard(req, [['Support', 'View']], () => support.canned()));
  app.post('/v1/admin/canned-replies', (req, reply) => guard(req, [['Support', 'Create']], async (a) => reply.status(201).send(await support.saveCanned(null, parse(CannedSchema, req.body), a))));
  app.patch('/v1/admin/canned-replies/:id', (req) => guard(req, [['Support', 'Edit']], (a) => support.saveCanned(parse(IdParam, req.params).id, parse(CannedPatchSchema, req.body), a)));
  app.post('/v1/admin/canned-replies/:id/use', (req, reply) => guard(req, [['Support', 'Edit']], async () => { await support.useCanned(parse(IdParam, req.params).id); return reply.status(204).send(); }));

  // ============ staff: refunds, returns, disputes (Claims) ==========================================================
  app.get('/v1/admin/refunds', (req, reply) => guard(req, [['Claims', 'View']], async () => { NoStore(reply); return claims.refunds(parse(RefundListSchema, req.query)); }));
  app.get('/v1/admin/refunds/:id', (req, reply) => guard(req, [['Claims', 'View']], async () => { NoStore(reply); return claims.refund(parse(IdParam, req.params).id); }));
  app.post('/v1/admin/refunds', (req, reply) => guard(req, [['Claims', 'Create']], async (a) => reply.status(201).send(await claims.openRefund(parse(StaffRefundSchema, req.body), claimsActor(a, false)))));
  // Refunds above the limit need someone who also has payments access (service tokens count as trusted).
  app.post('/v1/admin/refunds/:id/decision', (req) => guard(req, [['Claims', 'Edit']], (a, ctx) => claims.decideRefund(parse(IdParam, req.params).id, parse(RefundDecisionSchema, req.body), claimsActor(a, ctx ? ctx.can('Payments', 'Edit') : true))));
  app.post('/v1/admin/refunds/:id/notes', (req) => guard(req, [['Claims', 'Edit']], (a) => claims.refundNote(parse(IdParam, req.params).id, parse(NoteSchema, req.body).text, { ...a, name: staffName(a) })));

  app.get('/v1/admin/returns', (req, reply) => guard(req, [['Claims', 'View']], async () => { NoStore(reply); return claims.returns(parse(ReturnListSchema, req.query)); }));
  app.post('/v1/admin/returns/:id/decision', (req) => guard(req, [['Claims', 'Edit']], (a) => claims.decideReturn(parse(IdParam, req.params).id, parse(ReturnDecisionSchema, req.body), claimsActor(a, false))));

  app.get('/v1/admin/disputes', (req, reply) => guard(req, [['Claims', 'View']], async () => { NoStore(reply); return claims.disputes(parse(DisputeListSchema, req.query)); }));
  app.get('/v1/admin/disputes/:id', (req, reply) => guard(req, [['Claims', 'View']], async () => { NoStore(reply); return claims.dispute(parse(IdParam, req.params).id); }));
  app.post('/v1/admin/disputes', (req, reply) => guard(req, [['Claims', 'Create']], async (a) => reply.status(201).send(await claims.openDispute(parse(NewDisputeSchema, req.body), claimsActor(a, false)))));
  app.patch('/v1/admin/disputes/:id', (req) => guard(req, [['Claims', 'Edit']], (a) => claims.updateDispute(parse(IdParam, req.params).id, parse(DisputePatchSchema, req.body), claimsActor(a, false))));
  app.post('/v1/admin/disputes/:id/escalate', (req) => guard(req, [['Claims', 'Edit']], (a) => claims.escalate(parse(IdParam, req.params).id, claimsActor(a, false))));
  app.post('/v1/admin/disputes/:id/resolve', (req) => guard(req, [['Claims', 'Edit']], (a) => claims.resolve(parse(IdParam, req.params).id, parse(ResolveDisputeSchema, req.body), claimsActor(a, false))));

  // ============ shoppers ====================================================================================================
  const shopper = async (req: FastifyRequest) => support.personFor('customer', requireRole(req, 'customer').sub);

  app.get('/v1/help/articles', async (req) => { const q = parse(HelpSearchSchema, req.query); return support.search(q.q, q.category); });
  app.get('/v1/help/articles/:id', async (req) => support.readArticle(parse(IdParam, req.params).id, true));

  app.post('/v1/support/tickets', async (req, reply) => reply.status(201).send(await support.open('customer', await shopper(req), parse(OwnTicketSchema, req.body))));
  app.get('/v1/support/tickets', async (req, reply) => { NoStore(reply); return support.myTickets(requireRole(req, 'customer').sub); });
  app.get('/v1/support/tickets/:id', async (req, reply) => { NoStore(reply); return support.mine(requireRole(req, 'customer').sub, parse(IdParam, req.params).id); });
  app.post('/v1/support/tickets/:id/messages', async (req) => support.customerReply(await shopper(req), parse(IdParam, req.params).id, parse(TextSchema, req.body).text));
  app.post('/v1/support/tickets/:id/rating', async (req) => support.rate(await shopper(req), parse(IdParam, req.params).id, parse(RateSchema, req.body).csat));
  app.get('/v1/support/chat', async (req, reply) => { NoStore(reply); return support.myChat(requireRole(req, 'customer').sub); });
  app.post('/v1/support/chat/messages', async (req) => support.customerChatSend(await shopper(req), parse(ChatMessageSchema, req.body)));

  app.post('/v1/orders/:id/returns', async (req, reply) => reply.status(201).send(await claims.submitReturn(await shopper(req), parse(IdParam, req.params).id, parse(OwnReturnSchema, req.body))));
  app.post('/v1/orders/:id/refund-requests', async (req, reply) => reply.status(201).send(await claims.requestRefund(await shopper(req), parse(IdParam, req.params).id, parse(OwnRefundSchema, req.body))));
  app.post('/v1/orders/:id/review', async (req, reply) => reply.status(201).send(await support.submitReview(await shopper(req), parse(IdParam, req.params).id, parse(ReviewSchema, req.body))));
  app.get('/v1/support/claims', async (req, reply) => { NoStore(reply); return claims.mine(requireRole(req, 'customer').sub); });

  // ============ riders ======================================================================================================
  async function riderPerson(req: FastifyRequest) {
    const p = requirePrincipal(req);
    if (!p.roles.has('rider') || !p.sid) throw new ForbiddenError('Rider sign-in required');
    const ctx = await riders.context(p.sub, p.sid, String(req.id));
    return { id: ctx.id, name: ctx.name };
  }
  app.post('/v1/rider/support/tickets', async (req, reply) => reply.status(201).send(await support.open('rider', await riderPerson(req), parse(OwnTicketSchema, req.body))));
  app.get('/v1/rider/support/tickets', async (req, reply) => { NoStore(reply); return support.myTickets((await riderPerson(req)).id); });
  app.get('/v1/rider/support/tickets/:id', async (req, reply) => { NoStore(reply); return support.mine((await riderPerson(req)).id, parse(IdParam, req.params).id); });
  app.post('/v1/rider/support/tickets/:id/messages', async (req) => support.customerReply(await riderPerson(req), parse(IdParam, req.params).id, parse(TextSchema, req.body).text));
}
