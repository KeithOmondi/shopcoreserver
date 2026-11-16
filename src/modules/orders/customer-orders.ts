import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { isUuid } from '../../infra/uuid.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';

export const CustomerOrderListSchema = z.object({
  tab: z.enum(['active', 'completed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

type Step = { key: string; title: string; at: string | null; state: 'done' | 'current' | 'todo'; note?: string };

interface Row {
  id: string; order_no: number; status: 'PENDING_PAYMENT' | 'PAID' | 'CANCELLED' | 'FULFILLED'; total_cents: number; subtotal_cents: number | null; delivery_fee_cents: number; discount_cents: number; refunded_cents: number;
  payment_method: string | null; payment_ref: string | null; paid_at: Date | null; created_at: Date; fulfilled_at: Date | null; cancelled_at: Date | null; cancel_reason: string | null;
  delivery_name: string | null; delivery_phone: string | null; delivery_area: string | null; delivery_address: string | null; cod_due_cents: number | null; cod_collected_at: Date | null;
  d_status: string | null; d_accepted_at: Date | null; d_picked_up_at: Date | null; d_delivered_at: Date | null; d_failed_at: Date | null; d_failure_reason: string | null; handover_code: string | null;
  rider: string | null; rider_phone: string | null; vehicle: string | null; plate: string | null; rider_lat: number | null; rider_lng: number | null; rider_seen: Date | null;
  packed_at: Date | null; items: { productId: string; name: string; quantity: number; unitPriceCents: number }[];
}

/** What the shopper sees, in the app's own words: processing, in transit, delivered or cancelled. */
function statusOf(r: Row): 'processing' | 'in_transit' | 'delivered' | 'cancelled' {
  if (r.status === 'CANCELLED') return 'cancelled';
  if (r.status === 'FULFILLED') return 'delivered';
  return r.d_status === 'picked_up' || r.d_status === 'at_dropoff' ? 'in_transit' : 'processing';
}

const SELECT = `
  SELECT o.id, o.order_no, o.status, o.total_cents, o.subtotal_cents, o.delivery_fee_cents, o.discount_cents, o.refunded_cents, o.payment_method, o.payment_ref, o.paid_at, o.created_at, o.fulfilled_at,
         o.cancelled_at, o.cancel_reason, o.delivery_name, o.delivery_phone, o.delivery_area, o.delivery_address, o.cod_due_cents, o.cod_collected_at,
         d.status AS d_status, d.accepted_at AS d_accepted_at, d.picked_up_at AS d_picked_up_at, d.delivered_at AS d_delivered_at, d.failed_at AS d_failed_at, d.failure_reason AS d_failure_reason, d.handover_code,
         r.name AS rider, r.phone AS rider_phone, r.vehicle, r.plate, r.last_lat AS rider_lat, r.last_lng AS rider_lng, r.last_seen_at AS rider_seen,
         ps.packed_at,
         COALESCE((SELECT json_agg(json_build_object('productId', i.product_id, 'name', i.name, 'quantity', i.quantity, 'unitPriceCents', i.unit_price_cents) ORDER BY i.line_no) FROM order_items i WHERE i.order_id = o.id), '[]') AS items
    FROM orders o
    LEFT JOIN LATERAL (SELECT * FROM deliveries x WHERE x.order_id = o.id AND x.status <> 'cancelled' ORDER BY x.created_at DESC LIMIT 1) d ON true
    LEFT JOIN riders r ON r.id = d.rider_id
    LEFT JOIN pack_state ps ON ps.order_id = o.id`;

const iso = (d: Date | null) => d?.toISOString() ?? null;

type View = ReturnType<typeof view>;
/** What happened after delivery: return requests, refund requests and the shopper's review, added to each order. */
async function withAfterSales(c: Queryable, userId: string, views: View[]) {
  if (!views.length) return [];
  const ids = views.map((v) => v.id);
  const returns = (await c.query<{ id: string; order_id: string; request_no: number; product_id: string | null; item: string; qty: number; reason: string; statement: string; photos: number; status: string; note: string; submitted_at: Date }>(
    'SELECT id, order_id, request_no, product_id, item, qty, reason, statement, photos, status, note, submitted_at FROM return_requests WHERE customer_id = $1 AND order_id = ANY($2::uuid[]) ORDER BY submitted_at', [userId, ids])).rows;
  const refunds = (await c.query<{ id: string; order_id: string; refund_no: number; amount_cents: number; reason: string; status: string; decided_cents: number | null; decision_reason: string | null; submitted_at: Date; decided_at: Date | null }>(
    'SELECT id, order_id, refund_no, amount_cents, reason, status, decided_cents, decision_reason, submitted_at, decided_at FROM refunds WHERE customer_id = $1 AND order_id = ANY($2::uuid[]) ORDER BY submitted_at', [userId, ids])).rows;
  const reviews = (await c.query<{ order_id: string; rating: number; body: string; created_at: Date; reply: string | null }>(
    'SELECT order_id, rating, body, created_at, reply FROM reviews WHERE customer_id = $1 AND order_id = ANY($2::uuid[])', [userId, ids])).rows;
  const riderRatings = (await c.query<{ order_id: string; stars: number; comment: string }>(
    'SELECT d.order_id, x.stars, x.comment FROM rider_ratings x JOIN deliveries d ON d.id = x.delivery_id WHERE x.customer_id = $1 AND d.order_id = ANY($2::uuid[])', [userId, ids])).rows;
  return views.map((v) => ({
    ...v,
    riderRating: riderRatings.filter((r) => r.order_id === v.id).map((r) => ({ stars: r.stars, comment: r.comment }))[0] ?? null,
    returns: returns.filter((r) => r.order_id === v.id).map((r) => ({ id: r.id, number: `RR-${r.request_no}`, productId: r.product_id, item: r.item, qty: r.qty, reason: r.reason, details: r.statement, photos: r.photos, status: r.status, message: r.note, at: r.submitted_at.toISOString() })),
    refunds: refunds.filter((r) => r.order_id === v.id).map((r) => ({ id: r.id, number: `RF-${r.refund_no}`, amountCents: r.amount_cents, reason: r.reason, status: r.status, approvedCents: r.decided_cents, message: r.decision_reason, at: r.submitted_at.toISOString(), decidedAt: iso(r.decided_at) })),
    review: reviews.filter((r) => r.order_id === v.id).map((r) => ({ rating: r.rating, text: r.body, at: r.created_at.toISOString(), reply: r.reply }))[0] ?? null,
  }));
}

/**
 * The order's story, from the records themselves: placed, paid (or confirmed, for cash orders), packed, on the road, delivered.
 * Each step has the time it really happened; the first one that hasn't is "current".
 */
function stepsOf(r: Row): Step[] {
  const cod = r.payment_method === 'cod';
  const cancelled = r.status === 'CANCELLED';
  const raw: { key: string; title: string; at: Date | null; note?: string }[] = [
    { key: 'placed', title: 'Order placed', at: r.created_at },
    { key: 'paid', title: cod ? 'Order confirmed' : 'Payment confirmed', at: r.paid_at },
    { key: 'packed', title: 'Packed by seller', at: r.packed_at ?? (r.d_picked_up_at ? r.d_picked_up_at : null) },
    { key: 'on_the_way', title: 'On the way to you', at: r.d_picked_up_at, note: r.d_status === 'accepted' || r.d_status === 'at_pickup' ? `${r.rider ?? 'A rider'} is on the way to collect it` : undefined },
    { key: 'delivered', title: 'Delivered', at: r.fulfilled_at ?? r.d_delivered_at },
  ];
  let current = raw.findIndex((s) => !s.at);
  if (current < 0) current = raw.length;
  const steps: Step[] = raw.map((s, i) => ({ key: s.key, title: s.title, at: iso(s.at), state: s.at ? 'done' : i === current && !cancelled ? 'current' : 'todo', ...(s.note && !s.at ? { note: s.note } : {}) }));
  if (cancelled) steps.push({ key: 'cancelled', title: 'Order cancelled', at: iso(r.cancelled_at), state: 'done', note: r.cancel_reason ?? undefined });
  return steps;
}

function view(r: Row) {
  const status = statusOf(r);
  const onRoad = r.d_status === 'picked_up' || r.d_status === 'at_dropoff';
  const assigned = ['accepted', 'at_pickup', 'picked_up', 'at_dropoff', 'delivered'].includes(r.d_status ?? '');
  const subtotal = Number(r.subtotal_cents ?? r.total_cents);
  return {
    id: r.id, number: `SC-${r.order_no}`, status, rawStatus: r.status,
    placedAt: r.created_at.toISOString(), paidAt: iso(r.paid_at), deliveredAt: iso(r.fulfilled_at ?? r.d_delivered_at), cancelledAt: iso(r.cancelled_at), cancelReason: r.cancel_reason,
    paymentMethod: r.payment_method, paymentRef: r.payment_ref,
    // Online orders are paid once the money is confirmed; cash orders once the rider has collected it.
    paid: r.payment_method === 'cod' ? !!r.cod_collected_at : !!r.paid_at && r.status !== 'CANCELLED',
    cashDueCents: r.payment_method === 'cod' && !r.cod_collected_at && r.status === 'PAID' ? Number(r.cod_due_cents ?? r.total_cents) : 0,
    totals: { subtotalCents: subtotal, deliveryFeeCents: Number(r.delivery_fee_cents), discountCents: Number(r.discount_cents), totalCents: Number(r.total_cents), refundedCents: Number(r.refunded_cents) },
    items: r.items, itemCount: r.items.reduce((n, i) => n + i.quantity, 0),
    delivery: r.delivery_address ? { name: r.delivery_name ?? '', phone: r.delivery_phone ?? '', area: r.delivery_area ?? '', address: r.delivery_address } : null,
    awaitingPayment: r.status === 'PENDING_PAYMENT',
    // The shopper can cancel until the parcel is on the road.
    canCancel: (r.status === 'PENDING_PAYMENT' || r.status === 'PAID') && !onRoad,
    canTrack: status === 'processing' || status === 'in_transit',
    tracking: {
      steps: stepsOf(r),
      failure: r.d_status === 'failed' ? (r.d_failure_reason ?? 'The delivery didn’t go through. We’re sorting it out.') : null,
      rider: assigned && r.rider ? { name: r.rider, phone: r.rider_phone, vehicle: r.vehicle, plate: r.plate } : null,
      // Only while the rider is on the road: the code proves the right person got the parcel. The rider's position likewise.
      handoverCode: onRoad ? r.handover_code : null,
      riderLocation: onRoad && r.rider_lat !== null && r.rider_lng !== null ? { lat: r.rider_lat, lng: r.rider_lng, at: iso(r.rider_seen) } : null,
    },
  };
}

export class CustomerOrdersService {
  constructor(private readonly db: Database) {}

  async list(userId: string, q: z.infer<typeof CustomerOrderListSchema>) {
    let after: { at: string; id: string } | null = null;
    if (q.cursor) {
      const [at, id] = decodeCursor(q.cursor, 2) as [string, string];
      if (!isUuid(id) || Number.isNaN(Date.parse(at))) throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
      after = { at, id };
    }
    return this.db.read(async (c) => {
      // The tab is decided on the shopper's terms, so it is applied to the derived status; a page is filled up to its size.
      const out: View[] = [];
      let cursor = after;
      let more = true;
      while (out.length <= q.limit && more) {
        const { rows } = await c.query<Row>(
          `${SELECT} WHERE o.user_id = $1 AND ($2::timestamptz IS NULL OR (o.created_at, o.id) < ($2::timestamptz, $3::uuid)) ORDER BY o.created_at DESC, o.id DESC LIMIT $4`,
          [userId, cursor?.at ?? null, cursor?.id ?? null, 60]);
        more = rows.length === 60;
        for (const r of rows) {
          const v = view(r);
          const tab = v.status === 'cancelled' ? 'cancelled' : v.status === 'delivered' ? 'completed' : 'active';
          if (!q.tab || tab === q.tab) out.push(v);
          cursor = { at: r.created_at.toISOString(), id: r.id };
          if (out.length > q.limit) break;
        }
        if (!rows.length) more = false;
      }
      const page = await withAfterSales(c, userId, out.slice(0, q.limit));
      const last = page[page.length - 1];
      return { items: page, nextCursor: out.length > q.limit && last ? encodeCursor([last.placedAt, last.id]) : null };
    });
  }

  async get(userId: string, id: string) {
    if (!isUuid(id)) throw new NotFoundError('Order');
    return this.db.read(async (c: Queryable) => {
      const r = (await c.query<Row & { user_id: string }>(`${SELECT.replace('SELECT o.id,', 'SELECT o.user_id, o.id,')} WHERE o.id = $1`, [id])).rows[0];
      // The same answer for "no such order" and "someone else's order".
      if (!r || r.user_id !== userId) throw new NotFoundError('Order');
      return (await withAfterSales(c, userId, [view(r)]))[0]!;
    });
  }
}
