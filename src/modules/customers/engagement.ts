import { z } from 'zod';
import type { Database } from '../../infra/db.js';
import { NotFoundError } from '../../domain/errors.js';
import { isUuid } from '../../infra/uuid.js';

export const WishlistSchema = z.strictObject({ productId: z.string().refine(isUuid, 'must be a UUID') });

/** "Wanjiku Njoroge" -> "Wanjiku N." so a public review never shows a full name. */
const publicName = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  return parts.length === 1 ? parts[0]! : `${parts[0]} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`;
};

export type NotificationKind = 'order' | 'delivery' | 'return' | 'refund' | 'support';
interface Note { id: string; kind: NotificationKind; title: string; body: string; at: string; orderId?: string; ticketId?: string }

/** The shopper's saved items, the notification inbox, and what shoppers say about a product. */
export class CustomerEngagementService {
  constructor(private readonly db: Database) {}

  // ---- wishlist ---------------------------------------------------------------------------------------------------

  async wishlist(customerId: string) {
    return this.db.read(async (c) => ({
      items: (await c.query<{ product_id: string; added_at: Date }>(
        `SELECT w.product_id, w.added_at FROM wishlist_items w JOIN products p ON p.id = w.product_id WHERE w.customer_id = $1 AND p.status = 'active' AND p.active ORDER BY w.added_at DESC LIMIT 500`, [customerId])).rows
        .map((r) => ({ productId: r.product_id, addedAt: r.added_at.toISOString() })),
    }));
  }

  async addToWishlist(customerId: string, productId: string) {
    await this.db.tx(async (c) => {
      if (!(await c.query(`SELECT 1 FROM products WHERE id = $1 AND status = 'active'`, [productId])).rowCount) throw new NotFoundError('Product');
      await c.query('INSERT INTO wishlist_items (customer_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [customerId, productId]);
    });
    return this.wishlist(customerId);
  }

  async removeFromWishlist(customerId: string, productId: string) {
    await this.db.tx((c) => c.query('DELETE FROM wishlist_items WHERE customer_id = $1 AND product_id = $2', [customerId, productId]));
  }

  // ---- reviews of a product (from the orders that contained it, any variant of it) ---------------------------------------------------------

  async productReviews(productId: string) {
    if (!isUuid(productId)) throw new NotFoundError('Product');
    return this.db.read(async (c) => {
      const rows = (await c.query<{ id: string; customer_name: string; rating: number; body: string; topic: string; reply: string | null; created_at: Date }>(
        `SELECT DISTINCT ON (r.id) r.id, r.customer_name, r.rating, r.body, r.topic, r.reply, r.created_at
           FROM reviews r JOIN order_items oi ON oi.order_id = r.order_id
          WHERE oi.product_id IN (SELECT x.id FROM products x WHERE x.id = $1 OR (x.group_id IS NOT NULL AND x.group_id = (SELECT group_id FROM products WHERE id = $1)))
            AND r.state = 'visible' ORDER BY r.id DESC LIMIT 200`, [productId])).rows
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      const split = [5, 4, 3, 2, 1].map((s) => rows.filter((r) => r.rating === s).length);
      const total = rows.length;
      return {
        count: total, average: total ? Math.round((rows.reduce((n, r) => n + r.rating, 0) / total) * 10) / 10 : 0, split,
        items: rows.map((r) => ({ id: r.id, name: publicName(r.customer_name), rating: r.rating, text: r.body, topic: r.topic, reply: r.reply, at: r.created_at.toISOString(), verified: true })),
      };
    });
  }

  // ---- notifications ------------------------------------------------------------------------------------------------------
  // Built from what really happened to the shopper's orders, returns, refunds and support tickets: nothing is stored twice.

  async notifications(customerId: string) {
    return this.db.read(async (c) => {
      const out: Note[] = [];
      const orders = (await c.query<{ id: string; order_no: number; status: string; created_at: Date; paid_at: Date | null; cancelled_at: Date | null; fulfilled_at: Date | null; payment_method: string | null; picked_up_at: Date | null }>(
        `SELECT o.id, o.order_no, o.status, o.created_at, o.paid_at, o.cancelled_at, o.fulfilled_at, o.payment_method,
                (SELECT d.picked_up_at FROM deliveries d WHERE d.order_id = o.id AND d.status <> 'cancelled' ORDER BY d.created_at DESC LIMIT 1) AS picked_up_at
           FROM orders o WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 30`, [customerId])).rows;
      for (const o of orders) {
        const no = `SC-${o.order_no}`;
        out.push({ id: `o-${o.id}-placed`, kind: 'order', title: `Order ${no} placed`, body: o.payment_method === 'cod' ? 'Pay in cash when it arrives.' : 'We’ll start preparing it as soon as your payment is confirmed.', at: o.created_at.toISOString(), orderId: o.id });
        if (o.paid_at && o.payment_method !== 'cod') out.push({ id: `o-${o.id}-paid`, kind: 'order', title: `Payment received for ${no}`, body: 'Thank you. Your order is being prepared.', at: o.paid_at.toISOString(), orderId: o.id });
        if (o.picked_up_at) out.push({ id: `o-${o.id}-out`, kind: 'delivery', title: `${no} is on its way`, body: 'Your rider has collected it. Keep your delivery code ready.', at: o.picked_up_at.toISOString(), orderId: o.id });
        if (o.fulfilled_at) out.push({ id: `o-${o.id}-done`, kind: 'delivery', title: `${no} was delivered`, body: 'We hope you love it. You can rate your order or request a return from the order page.', at: o.fulfilled_at.toISOString(), orderId: o.id });
        if (o.cancelled_at) out.push({ id: `o-${o.id}-cancelled`, kind: 'order', title: `${no} was cancelled`, body: 'If you paid, your money will be returned to you.', at: o.cancelled_at.toISOString(), orderId: o.id });
      }
      const returns = (await c.query<{ id: string; request_no: number; item: string; status: string; note: string; submitted_at: Date; decided_at: Date | null; order_id: string }>(
        `SELECT id, request_no, item, status, note, submitted_at, decided_at, order_id FROM return_requests WHERE customer_id = $1 ORDER BY submitted_at DESC LIMIT 20`, [customerId])).rows;
      for (const r of returns) {
        if (r.status === 'evidence_requested') out.push({ id: `r-${r.id}-more`, kind: 'return', title: `More information needed for RR-${r.request_no}`, body: r.note || `We need a little more detail about your return of ${r.item}.`, at: (r.decided_at ?? r.submitted_at).toISOString(), orderId: r.order_id });
        else if (r.status === 'approved' || r.status === 'rejected') out.push({ id: `r-${r.id}-${r.status}`, kind: 'return', title: `Return RR-${r.request_no} ${r.status === 'approved' ? 'approved' : 'declined'}`, body: r.note || (r.status === 'approved' ? `Your return of ${r.item} was approved.` : `We couldn’t approve your return of ${r.item}.`), at: (r.decided_at ?? r.submitted_at).toISOString(), orderId: r.order_id });
      }
      const refunds = (await c.query<{ id: string; refund_no: number; status: string; decided_cents: number | null; decision_reason: string | null; decided_at: Date | null; order_id: string }>(
        `SELECT id, refund_no, status, decided_cents, decision_reason, decided_at, order_id FROM refunds WHERE customer_id = $1 AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT 20`, [customerId])).rows;
      for (const r of refunds) {
        out.push({ id: `f-${r.id}`, kind: 'refund', title: r.status === 'rejected' ? `Refund RF-${r.refund_no} declined` : `Refund RF-${r.refund_no} approved`, body: r.status === 'rejected' ? (r.decision_reason ?? 'We couldn’t approve this refund.') : `KES ${Math.round((r.decided_cents ?? 0) / 100).toLocaleString('en-US')} is on its way back to you.`, at: r.decided_at!.toISOString(), orderId: r.order_id });
      }
      const replies = (await c.query<{ ticket_id: string; ticket_no: number; subject: string; at: Date; body: string }>(
        `SELECT DISTINCT ON (t.id) t.id AS ticket_id, t.ticket_no, t.subject, m.at, m.body
           FROM tickets t JOIN ticket_messages m ON m.ticket_id = t.id AND m.from_kind = 'agent'
          WHERE t.person_id = $1 AND t.kind = 'customer' ORDER BY t.id, m.at DESC LIMIT 20`, [customerId])).rows;
      for (const r of replies) out.push({ id: `t-${r.ticket_id}-${r.at.getTime()}`, kind: 'support', title: `Support replied: ${r.subject}`, body: r.body.length > 140 ? `${r.body.slice(0, 137)}…` : r.body, at: r.at.toISOString(), ticketId: r.ticket_id });

      out.sort((a, b) => b.at.localeCompare(a.at));
      const items = out.slice(0, 60);
      const readAt = (await c.query<{ read_at: Date }>('SELECT read_at FROM customer_notification_state WHERE customer_id = $1', [customerId])).rows[0]?.read_at;
      return { items: items.map((n) => ({ ...n, unread: !readAt || new Date(n.at) > readAt })), unread: items.filter((n) => !readAt || new Date(n.at) > readAt).length };
    });
  }

  async markNotificationsRead(customerId: string) {
    await this.db.tx((c) => c.query(
      `INSERT INTO customer_notification_state (customer_id, read_at) VALUES ($1, now()) ON CONFLICT (customer_id) DO UPDATE SET read_at = now()`, [customerId]));
  }
}
