import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { isUuid, uuidv7 } from '../../infra/uuid.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { flag, patchOf } from '../../http/validate.js';
import { audit, type Actor } from '../products/products.js';

const uuid = z.string().refine(isUuid, 'must be a UUID');
export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
/** Minutes to a first reply before a ticket counts as late. */
export const SLA_MIN: Record<(typeof PRIORITIES)[number], number> = { urgent: 15, high: 60, normal: 240, low: 1440 };
const SLA_SQL = `(CASE t.priority WHEN 'urgent' THEN 15 WHEN 'high' THEN 60 WHEN 'normal' THEN 240 ELSE 1440 END)`;
export const REOPEN_DAYS = 7;

// ---- schemas ----------------------------------------------------------------------------------------------------------

export const TicketListSchema = z.object({
  q: z.string().trim().max(100).optional(), status: z.enum(['open', 'pending', 'escalated', 'resolved']).optional(), priority: z.enum(PRIORITIES).optional(),
  kind: z.enum(['customer', 'rider']).optional(), assignee: z.union([z.literal('me'), z.literal('none'), uuid]).optional(), sla: z.enum(['breached', 'risk']).optional(),
  orderId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional(),
});
export const StaffTicketSchema = z.strictObject({
  kind: z.enum(['customer', 'rider']).default('customer'), personId: uuid, subject: z.string().trim().min(1).max(200), category: z.string().trim().max(60).default('General'),
  priority: z.enum(PRIORITIES).default('normal'), orderId: uuid.optional(), message: z.string().trim().max(5000).default(''),
});
export const OwnTicketSchema = z.strictObject({ subject: z.string().trim().min(1).max(200), category: z.string().trim().max(60).default('General'), orderId: uuid.optional(), message: z.string().trim().min(1).max(5000) });
export const TextSchema = z.strictObject({ text: z.string().trim().min(1).max(5000) });
export const AgentReplySchema = z.strictObject({ text: z.string().trim().min(1).max(5000), internal: z.boolean().default(false) });
export const AssignSchema = z.strictObject({ assigneeId: uuid.nullable() });
export const TicketStatusSchema = z.strictObject({ status: z.enum(['open', 'pending', 'escalated', 'resolved']), priority: z.enum(PRIORITIES).optional() });
export const RateSchema = z.strictObject({ csat: z.number().int().min(1).max(5) });

export const ChatListSchema = z.object({ state: z.enum(['open', 'closed']).default('open'), mine: flag.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const StartChatSchema = z.strictObject({ customerId: uuid, orderId: uuid.optional() });
export const ChatMessageSchema = z.strictObject({ text: z.string().trim().min(1).max(2000), orderId: uuid.optional() });

export const ReviewListSchema = z.object({ state: z.enum(['visible', 'flagged', 'hidden']).optional(), rating: z.coerce.number().int().min(1).max(5).optional(), complaints: flag.optional(), unchecked: flag.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const ReviewSchema = z.strictObject({ rating: z.number().int().min(1).max(5), text: z.string().trim().max(2000).default(''), topic: z.string().trim().max(40).default('Delivery') });
export const ReviewReplySchema = z.strictObject({ text: z.string().trim().min(1).max(1000) });
export const ReviewStateSchema = z.strictObject({ state: z.enum(['visible', 'flagged', 'hidden']) });

export const ArticleSchema = z.strictObject({ title: z.string().trim().min(1).max(200), category: z.string().trim().min(1).max(60), body: z.string().max(20000).default(''), live: z.boolean().default(false) });
export const ArticlePatchSchema = patchOf(ArticleSchema);
export const HelpSearchSchema = z.object({ q: z.string().trim().max(100).optional(), category: z.string().max(60).optional() });
export const CannedSchema = z.strictObject({ title: z.string().trim().min(1).max(100), category: z.string().trim().min(1).max(60), text: z.string().trim().min(1).max(2000), live: z.boolean().default(true) });
export const CannedPatchSchema = patchOf(CannedSchema);

export interface Person { id: string; name: string }

interface TicketRow {
  id: string; ticket_no: number; kind: string; subject: string; category: string; priority: string; status: string; assignee_id: string | null; assignee_name: string | null;
  person_id: string; person_name: string; order_id: string | null; order_no: number | null; created_at: Date; updated_at: Date; first_response_at: Date | null; resolved_at: Date | null;
  csat: number | null; breached: boolean; at_risk: boolean; due: Date; messages: number;
}
const TICKET_SELECT = `SELECT t.*, o.order_no, (t.created_at + make_interval(mins => ${SLA_SQL})) AS due,
    (t.status <> 'resolved' AND t.first_response_at IS NULL AND now() > t.created_at + make_interval(mins => ${SLA_SQL})) AS breached,
    (t.status <> 'resolved' AND t.first_response_at IS NULL AND now() <= t.created_at + make_interval(mins => ${SLA_SQL}) AND t.created_at + make_interval(mins => ${SLA_SQL}) - now() <= interval '1 hour') AS at_risk,
    (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id AND m.from_kind <> 'note') AS messages
  FROM tickets t LEFT JOIN orders o ON o.id = t.order_id`;
const ticketView = (t: TicketRow) => ({
  id: t.id, number: `T-${t.ticket_no}`, kind: t.kind, subject: t.subject, category: t.category, priority: t.priority, status: t.status, assigneeId: t.assignee_id, assignee: t.assignee_name,
  personId: t.person_id, person: t.person_name, orderId: t.order_id, order: t.order_no ? `SC-${t.order_no}` : null, createdAt: t.created_at.toISOString(), updatedAt: t.updated_at.toISOString(),
  firstResponseAt: t.first_response_at?.toISOString() ?? null, resolvedAt: t.resolved_at?.toISOString() ?? null, csat: t.csat, dueAt: t.due.toISOString(), breached: t.breached, atRisk: t.at_risk, messages: t.messages,
});

export class SupportService {
  constructor(private readonly db: Database) {}

  // ---- overview -------------------------------------------------------------------------------------------------------

  async overview() {
    return this.db.read(async (c) => {
      const t = (await c.query<{ open: number; urgent: number; breached: number; at_risk: number; unassigned: number; resolved_today: number; avg_first: number | null; csat: string | null; escalated: number }>(
        `SELECT count(*) FILTER (WHERE t.status <> 'resolved')::int AS open,
                count(*) FILTER (WHERE t.status <> 'resolved' AND t.priority = 'urgent')::int AS urgent,
                count(*) FILTER (WHERE t.status <> 'resolved' AND t.first_response_at IS NULL AND now() > t.created_at + make_interval(mins => ${SLA_SQL}))::int AS breached,
                count(*) FILTER (WHERE t.status <> 'resolved' AND t.first_response_at IS NULL AND now() <= t.created_at + make_interval(mins => ${SLA_SQL}) AND t.created_at + make_interval(mins => ${SLA_SQL}) - now() <= interval '1 hour')::int AS at_risk,
                count(*) FILTER (WHERE t.status <> 'resolved' AND t.assignee_id IS NULL)::int AS unassigned,
                count(*) FILTER (WHERE t.resolved_at >= date_trunc('day', now()))::int AS resolved_today,
                avg(extract(epoch FROM (t.first_response_at - t.created_at)) / 60) FILTER (WHERE t.first_response_at > now() - interval '30 days')::float AS avg_first,
                avg(t.csat) FILTER (WHERE t.updated_at > now() - interval '30 days')::numeric(3,2) AS csat,
                count(*) FILTER (WHERE t.status = 'escalated')::int AS escalated
           FROM tickets t`)).rows[0]!;
      const chat = (await c.query<{ waiting: number; open: number }>(`SELECT count(*) FILTER (WHERE unread > 0 OR assignee_id IS NULL)::int AS waiting, count(*)::int AS open FROM chats WHERE NOT closed`)).rows[0]!;
      const claims = (await c.query<{ refunds: number; returns: number; disputes: number }>(
        `SELECT (SELECT count(*) FROM refunds WHERE status = 'needs_review')::int AS refunds, (SELECT count(*) FROM return_requests WHERE status IN ('new','review','pending','evidence_requested'))::int AS returns,
                (SELECT count(*) FROM disputes WHERE status IN ('awaiting_decision','escalated'))::int AS disputes`)).rows[0]!;
      const reviews = (await c.query<{ flagged: number; unchecked: number }>(`SELECT count(*) FILTER (WHERE state = 'flagged')::int AS flagged, count(*) FILTER (WHERE NOT checked AND rating <= 2)::int AS unchecked FROM reviews`)).rows[0]!;
      return {
        tickets: { open: t.open, urgent: t.urgent, breached: t.breached, atRisk: t.at_risk, unassigned: t.unassigned, escalated: t.escalated, resolvedToday: t.resolved_today, avgFirstResponseMin: t.avg_first === null ? null : Math.round(t.avg_first), csat: t.csat === null ? null : Number(t.csat) },
        chats: { open: chat.open, waiting: chat.waiting },
        claims: { refundsToReview: claims.refunds, returnsToReview: claims.returns, openDisputes: claims.disputes },
        reviews: { flagged: reviews.flagged, complaintsToCheck: reviews.unchecked },
      };
    });
  }

  // ---- tickets: staff ---------------------------------------------------------------------------------------------------

  async tickets(q: z.infer<typeof TicketListSchema>, staffId: string) {
    const before = q.cursor ? decodeCursor(q.cursor, 1)[0]! : null;
    if (before !== null && !isUuid(before)) throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
    const assignee = q.assignee === 'me' ? staffId : q.assignee && q.assignee !== 'none' ? q.assignee : null;
    return this.db.read(async (c) => {
      const { rows } = await c.query<TicketRow>(
        `${TICKET_SELECT}
          WHERE ($1::uuid IS NULL OR t.id < $1) AND ($2::text IS NULL OR t.status = $2) AND ($3::text IS NULL OR t.priority = $3) AND ($4::text IS NULL OR t.kind = $4)
            AND ($5::uuid IS NULL OR t.assignee_id = $5) AND (NOT $6 OR t.assignee_id IS NULL) AND ($8::uuid IS NULL OR t.order_id = $8)
            AND ($7::text IS NULL OR t.subject ILIKE '%' || $7 || '%' OR t.person_name ILIKE '%' || $7 || '%' OR ('T-' || t.ticket_no) ILIKE '%' || $7 || '%' OR ('SC-' || o.order_no) ILIKE '%' || $7 || '%')
            AND ($9::text IS NULL OR ($9 = 'breached' AND t.status <> 'resolved' AND t.first_response_at IS NULL AND now() > t.created_at + make_interval(mins => ${SLA_SQL}))
                 OR ($9 = 'risk' AND t.status <> 'resolved' AND t.first_response_at IS NULL AND now() <= t.created_at + make_interval(mins => ${SLA_SQL}) AND t.created_at + make_interval(mins => ${SLA_SQL}) - now() <= interval '1 hour'))
          ORDER BY t.id DESC LIMIT $10`,
        [before, q.status ?? null, q.priority ?? null, q.kind ?? null, assignee, q.assignee === 'none', q.q ?? null, q.orderId ?? null, q.sla ?? null, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return { items: page.map(ticketView), nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1]!.id]) : null };
    });
  }

  private async loadTicket(c: Queryable, id: string, forStaff: boolean) {
    const t = (await c.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [id])).rows[0];
    if (!t) throw new NotFoundError('Ticket');
    const msgs = (await c.query<{ id: number; from_kind: string; by_name: string; body: string; at: Date }>(
      `SELECT id, from_kind, by_name, body, at FROM ticket_messages WHERE ticket_id = $1 ${forStaff ? '' : `AND from_kind <> 'note'`} ORDER BY id`, [id])).rows;
    const activity = forStaff ? (await c.query<{ text: string; by_name: string; at: Date }>('SELECT text, by_name, at FROM ticket_activity WHERE ticket_id = $1 ORDER BY id DESC LIMIT 50', [id])).rows : [];
    return {
      ...ticketView(t),
      messages: msgs.map((m) => ({ id: String(m.id), from: m.from_kind, by: m.by_name, text: m.body, at: m.at.toISOString() })),
      activity: activity.map((a) => ({ text: a.text, by: a.by_name, at: a.at.toISOString() })),
    };
  }

  async ticket(id: string) { return this.db.read((c) => this.loadTicket(c, id, true)); }

  private async note(c: Queryable, ticketId: string, text: string, by: string) {
    await c.query('INSERT INTO ticket_activity (ticket_id, text, by_name) VALUES ($1,$2,$3)', [ticketId, text, by]);
  }

  /** Staff open a ticket for a customer (or rider), for example after a phone call. */
  async openForPerson(input: z.infer<typeof StaffTicketSchema>, actor: Actor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      const name = await this.personName(c, input.kind, input.personId);
      await c.query(
        `INSERT INTO tickets (id, kind, subject, category, priority, person_id, person_name, order_id, assignee_id, assignee_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, input.kind, input.subject, input.category, input.priority, input.personId, name, input.orderId ?? null, actor.id, actor.name ?? 'Staff']);
      if (input.message) await c.query(`INSERT INTO ticket_messages (ticket_id, from_kind, by_name, body) VALUES ($1,'agent',$2,$3)`, [id, actor.name ?? 'Staff', input.message]);
      await this.note(c, id, 'Ticket opened', actor.name ?? 'Staff');
      await audit(c, actor, 'ticket.open', 'ticket', id, { personId: input.personId });
    });
    return this.ticket(id);
  }

  private async personName(c: Queryable, kind: 'customer' | 'rider', id: string): Promise<string> {
    const r = (await c.query<{ name: string }>(kind === 'rider' ? 'SELECT name FROM riders WHERE id = $1' : 'SELECT name FROM customers WHERE id = $1', [id])).rows[0];
    if (!r) throw new NotFoundError(kind === 'rider' ? 'Rider' : 'Customer');
    return r.name || 'Customer';
  }

  async reply(id: string, input: z.infer<typeof AgentReplySchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const t = (await c.query<{ status: string; first_response_at: Date | null; assignee_id: string | null }>('SELECT status, first_response_at, assignee_id FROM tickets WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!t) throw new NotFoundError('Ticket');
      await c.query('INSERT INTO ticket_messages (ticket_id, from_kind, by_name, body) VALUES ($1,$2,$3,$4)', [id, input.internal ? 'note' : 'agent', actor.name ?? 'Staff', input.text]);
      if (!input.internal) {
        await c.query(
          `UPDATE tickets SET first_response_at = COALESCE(first_response_at, now()), assignee_id = COALESCE(assignee_id, $2), assignee_name = COALESCE(assignee_name, $3),
                  status = CASE WHEN status = 'open' THEN 'pending' ELSE status END, updated_at = now() WHERE id = $1`, [id, actor.id, actor.name ?? 'Staff']);
        await this.note(c, id, 'Replied to the customer', actor.name ?? 'Staff');
      } else {
        await this.note(c, id, 'Added an internal note', actor.name ?? 'Staff');
      }
    });
    return this.ticket(id);
  }

  async assign(id: string, assigneeId: string | null, actor: Actor) {
    await this.db.tx(async (c) => {
      let name: string | null = null;
      if (assigneeId) {
        const s = (await c.query<{ name: string; status: string }>('SELECT name, status FROM staff WHERE id = $1', [assigneeId])).rows[0];
        if (!s || s.status === 'suspended') throw new ValidationError([{ path: ['assigneeId'], message: 'That person can’t take tickets' }]);
        name = s.name;
      }
      const { rowCount } = await c.query('UPDATE tickets SET assignee_id = $2, assignee_name = $3, updated_at = now() WHERE id = $1', [id, assigneeId, name]);
      if (!rowCount) throw new NotFoundError('Ticket');
      await this.note(c, id, name ? `Assigned to ${name}` : 'Unassigned', actor.name ?? 'Staff');
    });
    return this.ticket(id);
  }

  async setStatus(id: string, input: z.infer<typeof TicketStatusSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE tickets SET status = $2, priority = COALESCE($3, priority), updated_at = now(), resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END WHERE id = $1`, [id, input.status, input.priority ?? null]);
      if (!rowCount) throw new NotFoundError('Ticket');
      await this.note(c, id, input.status === 'resolved' ? 'Marked resolved' : `Status set to ${input.status}`, actor.name ?? 'Staff');
      await audit(c, actor, 'ticket.status', 'ticket', id, input);
    });
    return this.ticket(id);
  }

  // ---- tickets: the customer's or rider's own -------------------------------------------------------------------------------

  async open(kind: 'customer' | 'rider', person: Person, input: z.infer<typeof OwnTicketSchema>) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      if (input.orderId && kind === 'customer' && !(await c.query('SELECT 1 FROM orders WHERE id = $1 AND user_id = $2', [input.orderId, person.id])).rowCount) throw new NotFoundError('Order');
      await c.query('INSERT INTO tickets (id, kind, subject, category, person_id, person_name, order_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, kind, input.subject, input.category, person.id, person.name, kind === 'customer' ? input.orderId ?? null : null]);
      await c.query('INSERT INTO ticket_messages (ticket_id, from_kind, by_name, body) VALUES ($1,$2,$3,$4)', [id, kind, person.name, input.message]);
      await this.note(c, id, 'Ticket opened by the ' + kind, person.name);
    });
    return this.mine(person.id, id);
  }

  async myTickets(personId: string) {
    return this.db.read(async (c) => ({ items: (await c.query<TicketRow>(`${TICKET_SELECT} WHERE t.person_id = $1 ORDER BY t.created_at DESC LIMIT 50`, [personId])).rows.map((t) => {
      const v = ticketView(t);
      return { id: v.id, number: v.number, subject: v.subject, category: v.category, status: v.status, order: v.order, createdAt: v.createdAt, updatedAt: v.updatedAt, csat: v.csat };
    }) }));
  }

  async mine(personId: string, id: string) {
    return this.db.read(async (c) => {
      const t = await this.loadTicket(c, id, false);
      if (t.personId !== personId) throw new NotFoundError('Ticket');
      return { id: t.id, number: t.number, subject: t.subject, category: t.category, status: t.status, order: t.order, createdAt: t.createdAt, csat: t.csat, messages: t.messages.map((m) => ({ ...m, by: m.from === 'agent' ? 'ShopCore support' : m.by })) };
    });
  }

  async customerReply(person: Person, id: string, text: string) {
    await this.db.tx(async (c) => {
      const t = (await c.query<{ person_id: string; status: string; kind: string; resolved_at: Date | null }>('SELECT person_id, status, kind, resolved_at FROM tickets WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!t || t.person_id !== person.id) throw new NotFoundError('Ticket');
      if (t.status === 'resolved' && t.resolved_at && Date.now() - t.resolved_at.getTime() > REOPEN_DAYS * 86_400_000) throw new UnprocessableError('TICKET_CLOSED', 'This ticket was closed a while ago. Please open a new one.');
      await c.query('INSERT INTO ticket_messages (ticket_id, from_kind, by_name, body) VALUES ($1,$2,$3,$4)', [id, t.kind, person.name, text]);
      await c.query(`UPDATE tickets SET status = CASE WHEN status IN ('pending','resolved') THEN 'open' ELSE status END, resolved_at = NULL, updated_at = now() WHERE id = $1`, [id]);
      if (t.status === 'resolved') await this.note(c, id, 'Reopened by the customer’s reply', person.name);
    });
    return this.mine(person.id, id);
  }

  async rate(person: Person, id: string, csat: number) {
    await this.db.tx(async (c) => {
      const t = (await c.query<{ person_id: string; status: string; csat: number | null }>('SELECT person_id, status, csat FROM tickets WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!t || t.person_id !== person.id) throw new NotFoundError('Ticket');
      if (t.status !== 'resolved') throw new UnprocessableError('NOT_RESOLVED', 'You can rate a ticket once it is resolved');
      if (t.csat !== null) throw new ConflictError('ALREADY_RATED', 'You have already rated this ticket');
      await c.query('UPDATE tickets SET csat = $2 WHERE id = $1', [id, csat]);
    });
    return this.mine(person.id, id);
  }

  // ---- live chat -----------------------------------------------------------------------------------------------------------------

  async chats(q: z.infer<typeof ChatListSchema>, staffId: string) {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; customer_id: string; name: string; assignee_id: string | null; assignee_name: string | null; closed: boolean; unread: number; last_at: Date; order_no: number | null; last: string | null }>(
        `SELECT ch.id, ch.customer_id, ch.name, ch.assignee_id, ch.assignee_name, ch.closed, ch.unread, ch.last_at, o.order_no,
                (SELECT body FROM chat_messages m WHERE m.chat_id = ch.id ORDER BY m.id DESC LIMIT 1) AS last
           FROM chats ch LEFT JOIN orders o ON o.id = ch.order_id WHERE ch.closed = ($1 = 'closed') AND (NOT $2 OR ch.assignee_id = $3) ORDER BY ch.unread DESC, ch.last_at DESC LIMIT $4`,
        [q.state, q.mine === true, staffId, q.limit]);
      return { items: rows.map((r) => ({ id: r.id, customerId: r.customer_id, name: r.name, assigneeId: r.assignee_id, assignee: r.assignee_name, closed: r.closed, unread: r.unread, lastAt: r.last_at.toISOString(), order: r.order_no ? `SC-${r.order_no}` : null, lastMessage: r.last })) };
    });
  }

  private async loadChat(c: Queryable, id: string) {
    const ch = (await c.query<{ id: string; customer_id: string; name: string; assignee_id: string | null; assignee_name: string | null; closed: boolean; unread: number; order_no: number | null }>(
      `SELECT ch.id, ch.customer_id, ch.name, ch.assignee_id, ch.assignee_name, ch.closed, ch.unread, o.order_no FROM chats ch LEFT JOIN orders o ON o.id = ch.order_id WHERE ch.id = $1`, [id])).rows[0];
    if (!ch) throw new NotFoundError('Chat');
    const msgs = (await c.query<{ id: number; from_kind: string; by_name: string; body: string; at: Date }>('SELECT id, from_kind, by_name, body, at FROM chat_messages WHERE chat_id = $1 ORDER BY id', [id])).rows;
    return { id: ch.id, customerId: ch.customer_id, name: ch.name, assigneeId: ch.assignee_id, assignee: ch.assignee_name, closed: ch.closed, unread: ch.unread, order: ch.order_no ? `SC-${ch.order_no}` : null,
      messages: msgs.map((m) => ({ id: String(m.id), from: m.from_kind, by: m.by_name, text: m.body, at: m.at.toISOString() })) };
  }

  /** Opening a chat marks the customer’s messages as read. */
  async chat(id: string) {
    await this.db.tx((c) => c.query('UPDATE chats SET unread = 0 WHERE id = $1', [id]));
    return this.db.read((c) => this.loadChat(c, id));
  }

  async chatSend(id: string, text: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const ch = (await c.query<{ closed: boolean }>('SELECT closed FROM chats WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!ch) throw new NotFoundError('Chat');
      if (ch.closed) throw new UnprocessableError('CHAT_CLOSED', 'This chat has ended');
      await c.query('INSERT INTO chat_messages (chat_id, from_kind, by_name, body) VALUES ($1,$2,$3,$4)', [id, 'agent', actor.name ?? 'Staff', text]);
      await c.query('UPDATE chats SET assignee_id = COALESCE(assignee_id, $2), assignee_name = COALESCE(assignee_name, $3), unread = 0, last_at = now() WHERE id = $1', [id, actor.id, actor.name ?? 'Staff']);
    });
    return this.db.read((c) => this.loadChat(c, id));
  }

  async chatTake(id: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query('UPDATE chats SET assignee_id = $2, assignee_name = $3 WHERE id = $1 AND NOT closed', [id, actor.id, actor.name ?? 'Staff']);
      if (!rowCount) throw new NotFoundError('Open chat');
    });
    return this.db.read((c) => this.loadChat(c, id));
  }

  async chatClose(id: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query('UPDATE chats SET closed = true, unread = 0 WHERE id = $1', [id]);
      if (!rowCount) throw new NotFoundError('Chat');
      await audit(c, actor, 'chat.close', 'chat', id, {});
    });
  }

  /** Staff reach out to a customer. If they already have an open chat, that one is used. */
  async chatStart(input: z.infer<typeof StartChatSchema>, actor: Actor) {
    const id = await this.db.tx(async (c) => {
      const name = await this.personName(c, 'customer', input.customerId);
      const open = (await c.query<{ id: string }>('SELECT id FROM chats WHERE customer_id = $1 AND NOT closed', [input.customerId])).rows[0];
      if (open) return open.id;
      const nid = uuidv7();
      await c.query('INSERT INTO chats (id, customer_id, name, order_id, assignee_id, assignee_name) VALUES ($1,$2,$3,$4,$5,$6)', [nid, input.customerId, name, input.orderId ?? null, actor.id, actor.name ?? 'Staff']);
      return nid;
    });
    return this.db.read((c) => this.loadChat(c, id));
  }

  /** The shopper’s side: their open conversation, if any. */
  async myChat(customerId: string) {
    return this.db.read(async (c) => {
      const open = (await c.query<{ id: string }>('SELECT id FROM chats WHERE customer_id = $1 AND NOT closed', [customerId])).rows[0];
      if (!open) return { chat: null };
      const ch = await this.loadChat(c, open.id);
      return { chat: { id: ch.id, agent: ch.assignee, order: ch.order, messages: ch.messages.map((m) => ({ ...m, by: m.from === 'agent' ? ch.assignee ?? 'ShopCore support' : m.by })) } };
    });
  }

  async customerChatSend(person: Person, input: z.infer<typeof ChatMessageSchema>) {
    await this.db.tx(async (c) => {
      if (input.orderId && !(await c.query('SELECT 1 FROM orders WHERE id = $1 AND user_id = $2', [input.orderId, person.id])).rowCount) throw new NotFoundError('Order');
      await c.query('INSERT INTO chats (id, customer_id, name, order_id) VALUES ($1,$2,$3,$4) ON CONFLICT (customer_id) WHERE NOT closed DO NOTHING', [uuidv7(), person.id, person.name, input.orderId ?? null]);
      const ch = (await c.query<{ id: string }>('SELECT id FROM chats WHERE customer_id = $1 AND NOT closed FOR UPDATE', [person.id])).rows[0]!;
      await c.query('INSERT INTO chat_messages (chat_id, from_kind, by_name, body) VALUES ($1,$2,$3,$4)', [ch.id, 'customer', person.name, input.text]);
      await c.query('UPDATE chats SET unread = unread + 1, last_at = now() WHERE id = $1', [ch.id]);
    });
    return this.myChat(person.id);
  }

  // ---- reviews -------------------------------------------------------------------------------------------------------------------------

  async reviews(q: z.infer<typeof ReviewListSchema>) {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; customer_name: string; rating: number; body: string; topic: string; state: string; reply: string | null; replied_by: string | null; checked: boolean; created_at: Date; order_no: number | null }>(
        `SELECT r.*, o.order_no FROM reviews r LEFT JOIN orders o ON o.id = r.order_id
          WHERE ($1::text IS NULL OR r.state = $1) AND ($2::int IS NULL OR r.rating = $2) AND (NOT $3 OR r.rating <= 2) AND (NOT $4 OR NOT r.checked)
          ORDER BY r.created_at DESC LIMIT $5`, [q.state ?? null, q.rating ?? null, q.complaints === true, q.unchecked === true, q.limit]);
      const stats = (await c.query<{ n: number; avg: string | null; complaints: number }>(`SELECT count(*)::int AS n, avg(rating)::numeric(3,2) AS avg, count(*) FILTER (WHERE rating <= 2)::int AS complaints FROM reviews WHERE state <> 'hidden'`)).rows[0]!;
      return {
        items: rows.map((r) => ({ id: r.id, customer: r.customer_name, rating: r.rating, text: r.body, topic: r.topic, state: r.state, reply: r.reply, repliedBy: r.replied_by, checked: r.checked, order: r.order_no ? `SC-${r.order_no}` : null, at: r.created_at.toISOString(), complaint: r.rating <= 2 })),
        summary: { count: stats.n, average: stats.avg === null ? null : Number(stats.avg), complaints: stats.complaints },
      };
    });
  }

  async replyReview(id: string, text: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query('UPDATE reviews SET reply = $2, replied_by = $3, checked = true WHERE id = $1', [id, text, actor.name ?? 'Staff']);
      if (!rowCount) throw new NotFoundError('Review');
      await audit(c, actor, 'review.reply', 'review', id, {});
    });
  }

  async setReviewState(id: string, state: 'visible' | 'flagged' | 'hidden', actor: Actor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query('UPDATE reviews SET state = $2, checked = true WHERE id = $1', [id, state]);
      if (!rowCount) throw new NotFoundError('Review');
      await audit(c, actor, 'review.state', 'review', id, { state });
    });
  }

  /** A shopper reviews a delivered order, once. */
  async submitReview(person: Person, orderId: string, input: z.infer<typeof ReviewSchema>) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      const o = (await c.query<{ status: string }>('SELECT status FROM orders WHERE id = $1 AND user_id = $2', [orderId, person.id])).rows[0];
      if (!o) throw new NotFoundError('Order');
      if (o.status !== 'FULFILLED') throw new UnprocessableError('NOT_DELIVERED', 'You can review an order once it has arrived');
      await c.query('INSERT INTO reviews (id, order_id, customer_id, customer_name, rating, body, topic) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, orderId, person.id, person.name, input.rating, input.text, input.topic])
        .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('ALREADY_REVIEWED', 'You have already reviewed this order'); throw e; });
    });
    return { id };
  }

  // ---- help centre -------------------------------------------------------------------------------------------------------------------------

  async articles(onlyLive: boolean, q?: string, category?: string) {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; title: string; category: string; body: string; live: boolean; views: number; author: string; updated_at: Date }>(
        `SELECT id, title, category, body, live, views, author, updated_at FROM help_articles
          WHERE (NOT $1 OR live) AND ($2::text IS NULL OR category = $2) AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%' OR body ILIKE '%' || $3 || '%')
          ORDER BY category, title LIMIT 200`, [onlyLive, category ?? null, q ?? null]);
      return rows.map((a) => ({ id: a.id, title: a.title, category: a.category, body: onlyLive && !q ? '' : a.body, live: a.live, views: a.views, author: a.author, updatedAt: a.updated_at.toISOString() }));
    });
  }

  /** Public help search. A search that finds nothing is remembered so the team can write that article. */
  async search(q: string | undefined, category?: string) {
    const items = await this.articles(true, q, category);
    if (q && q.length >= 2 && items.length === 0) {
      await this.db.tx((c) => c.query(`INSERT INTO help_missed_searches (q) VALUES ($1) ON CONFLICT (q) DO UPDATE SET count = help_missed_searches.count + 1, last_at = now()`, [q.toLowerCase()])).catch(() => undefined);
    }
    return { items: items.map((a) => ({ id: a.id, title: a.title, category: a.category, excerpt: a.body.slice(0, 160) })) };
  }

  async readArticle(id: string, live: boolean) {
    return this.db.tx(async (c) => {
      const a = (await c.query<{ id: string; title: string; category: string; body: string; updated_at: Date }>(
        `UPDATE help_articles SET views = views + CASE WHEN $2 THEN 1 ELSE 0 END WHERE id = $1 AND (live OR NOT $2) RETURNING id, title, category, body, updated_at`, [id, live])).rows[0];
      if (!a) throw new NotFoundError('Article');
      return { id: a.id, title: a.title, category: a.category, body: a.body, updatedAt: a.updated_at.toISOString() };
    });
  }

  async missedSearches() {
    return this.db.read(async (c) => ({ items: (await c.query<{ q: string; count: number }>('SELECT q, count FROM help_missed_searches ORDER BY count DESC, last_at DESC LIMIT 50')).rows }));
  }

  async saveArticle(id: string | null, input: z.infer<typeof ArticleSchema> | z.infer<typeof ArticlePatchSchema>, actor: Actor) {
    const aid = id ?? uuidv7();
    await this.db.tx(async (c) => {
      if (!id) {
        const a = input as z.infer<typeof ArticleSchema>;
        await c.query('INSERT INTO help_articles (id, title, category, body, live, author) VALUES ($1,$2,$3,$4,$5,$6)', [aid, a.title, a.category, a.body, a.live, actor.name ?? 'Staff']);
      } else {
        const p = input as z.infer<typeof ArticlePatchSchema>;
        const { rowCount } = await c.query('UPDATE help_articles SET title = COALESCE($2,title), category = COALESCE($3,category), body = COALESCE($4,body), live = COALESCE($5,live), author = $6, updated_at = now() WHERE id = $1',
          [id, p.title ?? null, p.category ?? null, p.body ?? null, p.live ?? null, actor.name ?? 'Staff']);
        if (!rowCount) throw new NotFoundError('Article');
      }
      await audit(c, actor, id ? 'article.update' : 'article.create', 'article', aid, { live: (input as { live?: boolean }).live });
    });
    return this.readArticle(aid, false);
  }

  // ---- canned replies ----------------------------------------------------------------------------------------------------------------------

  async canned() {
    return this.db.read(async (c) => ({ items: (await c.query<{ id: string; title: string; category: string; body: string; uses: number; live: boolean }>('SELECT id, title, category, body, uses, live FROM canned_replies ORDER BY category, title')).rows
      .map((r) => ({ id: r.id, title: r.title, category: r.category, text: r.body, uses: r.uses, live: r.live })) }));
  }
  async saveCanned(id: string | null, input: z.infer<typeof CannedSchema> | z.infer<typeof CannedPatchSchema>, actor: Actor) {
    const cid = id ?? uuidv7();
    await this.db.tx(async (c) => {
      if (!id) {
        const a = input as z.infer<typeof CannedSchema>;
        await c.query('INSERT INTO canned_replies (id, title, category, body, live) VALUES ($1,$2,$3,$4,$5)', [cid, a.title, a.category, a.text, a.live]);
      } else {
        const p = input as z.infer<typeof CannedPatchSchema>;
        const { rowCount } = await c.query('UPDATE canned_replies SET title = COALESCE($2,title), category = COALESCE($3,category), body = COALESCE($4,body), live = COALESCE($5,live) WHERE id = $1', [id, p.title ?? null, p.category ?? null, p.text ?? null, p.live ?? null]);
        if (!rowCount) throw new NotFoundError('Canned reply');
      }
      await audit(c, actor, id ? 'canned.update' : 'canned.create', 'canned_reply', cid, {});
    });
    return (await this.canned()).items.find((x) => x.id === cid)!;
  }
  async useCanned(id: string) {
    await this.db.tx(async (c) => { const { rowCount } = await c.query('UPDATE canned_replies SET uses = uses + 1 WHERE id = $1', [id]); if (!rowCount) throw new NotFoundError('Canned reply'); });
  }

  /** Used by routes: a customer’s or rider’s display name. */
  async personFor(kind: 'customer' | 'rider', id: string): Promise<Person> {
    return this.db.read(async (c) => ({ id, name: await this.personName(c, kind, id).catch(() => 'Customer') }));
  }

  /** Staff can only be assigned tickets if they exist; exposes the roster for the assignee picker. */
  async agents() {
    return this.db.read(async (c) => ({ items: (await c.query<{ id: string; name: string; role: string }>(
      `SELECT s.id, s.name, s.role FROM staff s WHERE s.status <> 'suspended' AND (s.role = 'Owner admin' OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role = s.role AND rp.module = 'Support' AND rp.action = 'Edit')) ORDER BY s.name`)).rows }));
  }
}

