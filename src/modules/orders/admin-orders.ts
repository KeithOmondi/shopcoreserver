import { z } from 'zod';
import type { Database } from '../../infra/db.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { isUuid } from '../../infra/uuid.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { audit, type Actor } from '../products/products.js';

const uuid = z.string().refine(isUuid, 'must be a UUID');

export const ORDER_STATUSES = ['Pending', 'Processing', 'Packed', 'Out for delivery', 'Shipped', 'Delivered', 'Cancelled'] as const;
/** What staff see. Derived from the order state plus whether the warehouse has packed it. */
const DISPLAY_STATUS = `(CASE o.status WHEN 'PENDING_PAYMENT' THEN 'Pending' WHEN 'CANCELLED' THEN 'Cancelled'
    WHEN 'FULFILLED' THEN CASE WHEN EXISTS (SELECT 1 FROM deliveries dv WHERE dv.order_id = o.id AND dv.status = 'delivered') THEN 'Delivered' ELSE 'Shipped' END
    ELSE CASE WHEN EXISTS (SELECT 1 FROM deliveries dv WHERE dv.order_id = o.id AND dv.status IN ('picked_up','at_dropoff')) THEN 'Out for delivery' WHEN ps.stage = 'packed' THEN 'Packed' ELSE 'Processing' END END)`;

export const OrderListSchema = z.object({
  q: z.string().trim().max(100).optional(), status: z.enum(ORDER_STATUSES).optional(), payment: z.enum(['paid', 'unpaid']).optional(),
  method: z.enum(['mpesa', 'card', 'cod']).optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  customerId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(300).optional(),
});
export const NoteSchema = z.strictObject({ text: z.string().trim().min(1).max(1000) });
export const CustomerListSchema = z.object({
  q: z.string().trim().max(100).optional(), segment: z.enum(['new', 'returning']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(300).optional(),
});
export const CustomerPatchSchema = z.strictObject({
  name: z.string().trim().max(120), email: z.string().trim().max(254), phone: z.string().trim().max(32), area: z.string().trim().max(80), street: z.string().trim().max(200),
}).partial().refine((v) => Object.keys(v).length > 0, 'nothing to change');
export const ProfileSchema = CustomerPatchSchema;

interface ListRow {
  id: string; order_no: number; user_id: string; customer: string | null; phone: string | null; area: string | null; total_cents: number; currency: string; item_count: number;
  status: string; payment_method: string | null; paid: boolean; created_at: Date;
}
const FROM = `FROM orders o LEFT JOIN customers cu ON cu.id = o.user_id LEFT JOIN pack_state ps ON ps.order_id = o.id`;

export class AdminOrdersService {
  constructor(private readonly db: Database) {}

  async list(q: z.infer<typeof OrderListSchema>) {
    let after: { at: string; id: string } | null = null;
    if (q.cursor) {
      const [at, id] = decodeCursor(q.cursor, 2) as [string, string];
      if (!isUuid(id) || Number.isNaN(Date.parse(at))) throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
      after = { at, id };
    }
    return this.db.read(async (c) => {
      const { rows } = await c.query<ListRow>(
        `SELECT o.id, o.order_no, o.user_id, COALESCE(NULLIF(o.delivery_name, ''), NULLIF(cu.name, ''), 'Customer') AS customer, COALESCE(NULLIF(o.delivery_phone, ''), cu.phone) AS phone,
                COALESCE(NULLIF(o.delivery_area, ''), cu.area) AS area, o.total_cents, o.currency, o.item_count, ${DISPLAY_STATUS} AS status, o.payment_method,
                (o.paid_at IS NOT NULL AND (o.cod_due_cents IS NULL OR o.cod_collected_at IS NOT NULL)) AS paid, o.created_at
           ${FROM}
          WHERE ($1::timestamptz IS NULL OR (o.created_at, o.id) < ($1::timestamptz, $2::uuid))
            AND ($3::text IS NULL OR ${DISPLAY_STATUS} = $3)
            AND ($4::text IS NULL OR ($4 = 'paid' AND o.paid_at IS NOT NULL AND (o.cod_due_cents IS NULL OR o.cod_collected_at IS NOT NULL)) OR ($4 = 'unpaid' AND (o.paid_at IS NULL OR (o.cod_due_cents IS NOT NULL AND o.cod_collected_at IS NULL))))
            AND ($5::text IS NULL OR o.payment_method = $5)
            AND ($6::date IS NULL OR o.created_at >= $6::date) AND ($7::date IS NULL OR o.created_at < $7::date + 1)
            AND ($8::uuid IS NULL OR o.user_id = $8)
            AND ($9::text IS NULL OR ('SC-' || o.order_no) ILIKE '%' || $9 || '%' OR o.delivery_name ILIKE '%' || $9 || '%' OR cu.name ILIKE '%' || $9 || '%' OR o.delivery_phone ILIKE '%' || $9 || '%' OR cu.phone ILIKE '%' || $9 || '%')
          ORDER BY o.created_at DESC, o.id DESC LIMIT $10`,
        [after?.at ?? null, after?.id ?? null, q.status ?? null, q.payment ?? null, q.method ?? null, q.from ?? null, q.to ?? null, q.customerId ?? null, q.q ?? null, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => ({ id: r.id, number: `SC-${r.order_no}`, customerId: r.user_id, customer: r.customer, phone: r.phone, area: r.area, itemCount: r.item_count, totalCents: r.total_cents, currency: r.currency, status: r.status, paymentMethod: r.payment_method, paid: r.paid, createdAt: r.created_at.toISOString() })),
        nextCursor: rows.length > q.limit && last ? encodeCursor([last.created_at.toISOString(), last.id]) : null,
      };
    });
  }

  async get(id: string) {
    return this.db.read(async (c) => {
      const o = (await c.query<{
        id: string; order_no: number; user_id: string; status: string; display: string; total_cents: number; currency: string; version: number; payment_method: string | null; payment_ref: string | null;
        delivery_name: string | null; delivery_phone: string | null; delivery_area: string | null; delivery_address: string | null; cancel_reason: string | null; cod_due_cents: number | null; cod_collected_at: Date | null; refunded_cents: number; delivery_fee_cents: number; subtotal_cents: number | null;
        created_at: Date; paid_at: Date | null; fulfilled_at: Date | null; cancelled_at: Date | null; packed_at: Date | null; packed_by: string | null; picked: string[] | null;
        c_name: string | null; c_phone: string | null; c_email: string | null; c_area: string | null; c_street: string | null;
      }>(
        `SELECT o.*, ${DISPLAY_STATUS} AS display, ps.packed_at, ps.packed_by, ps.picked, cu.name AS c_name, cu.phone AS c_phone, cu.email AS c_email, cu.area AS c_area, cu.street AS c_street
           ${FROM} WHERE o.id = $1`, [id])).rows[0];
      if (!o) throw new NotFoundError('Order');
      const items = (await c.query<{ product_id: string; sku: string; name: string; quantity: number; unit_price_cents: number }>('SELECT product_id, sku, name, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY line_no', [id])).rows;
      const notes = (await c.query<{ id: number; body: string; by_name: string; created_at: Date }>('SELECT id, body, by_name, created_at FROM order_notes WHERE order_id = $1 ORDER BY id', [id])).rows;
      const events: { kind: string; at: string; by?: string; note?: string }[] = [{ kind: 'Placed', at: o.created_at.toISOString() }];
      if (o.paid_at) events.push({ kind: 'Paid', at: o.paid_at.toISOString(), note: o.payment_method ? { mpesa: 'M-Pesa', card: 'Card', cod: 'Cash on delivery' }[o.payment_method] : undefined });
      if (o.packed_at) events.push({ kind: 'Packed', at: o.packed_at.toISOString(), by: o.packed_by ?? undefined });
      if (o.fulfilled_at) events.push({ kind: 'Shipped', at: o.fulfilled_at.toISOString() });
      if (o.cancelled_at) events.push({ kind: 'Cancelled', at: o.cancelled_at.toISOString(), note: o.cancel_reason ?? undefined });
      for (const n of notes) events.push({ kind: 'Note', at: n.created_at.toISOString(), by: n.by_name, note: n.body });
      events.sort((a, b) => a.at.localeCompare(b.at));
      return {
        id: o.id, number: `SC-${o.order_no}`, status: o.display, rawStatus: o.status, version: o.version, totalCents: o.total_cents, currency: o.currency,
        paymentMethod: o.payment_method, paymentRef: o.payment_ref, paid: o.paid_at !== null && (o.cod_due_cents === null || o.cod_collected_at !== null), cashDueCents: o.cod_due_cents !== null && o.cod_collected_at === null ? o.cod_due_cents : 0, deliveryFeeCents: o.delivery_fee_cents, refundedCents: o.refunded_cents, subtotalCents: o.subtotal_cents ?? o.total_cents, createdAt: o.created_at.toISOString(),
        customer: { id: o.user_id, name: o.c_name || o.delivery_name || 'Customer', phone: o.delivery_phone || o.c_phone || '', email: o.c_email || '' },
        delivery: { name: o.delivery_name ?? o.c_name ?? '', phone: o.delivery_phone ?? o.c_phone ?? '', area: o.delivery_area ?? o.c_area ?? '', address: o.delivery_address ?? o.c_street ?? '' },
        items: items.map((i) => ({ productId: i.product_id, sku: i.sku, name: i.name, quantity: i.quantity, unitPriceCents: i.unit_price_cents, lineTotalCents: i.quantity * i.unit_price_cents })),
        events, notes: notes.map((n) => ({ id: String(n.id), text: n.body, by: n.by_name, at: n.created_at.toISOString() })),
      };
    });
  }

  async addNote(id: string, text: string, actor: Actor) {
    await this.db.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM orders WHERE id = $1', [id])).rowCount) throw new NotFoundError('Order');
      await c.query('INSERT INTO order_notes (order_id, body, by_id, by_name) VALUES ($1,$2,$3,$4)', [id, text, actor.id, actor.name ?? 'Staff']);
      await audit(c, actor, 'order.note', 'order', id, { length: text.length });
    });
    return this.get(id);
  }

  /** Counts for the orders page tabs and the overview tiles. */
  async stats() {
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ status: string; n: number }>(`SELECT ${DISPLAY_STATUS} AS status, count(*)::int AS n ${FROM} GROUP BY 1`);
      const today = (await c.query<{ orders: number; revenue: number; paid: number }>(
        `SELECT count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS orders,
                COALESCE(sum(total_cents) FILTER (WHERE paid_at >= date_trunc('day', now()) AND status <> 'CANCELLED'), 0)::bigint AS revenue,
                count(*) FILTER (WHERE paid_at >= date_trunc('day', now()))::int AS paid FROM orders`)).rows[0]!;
      return { byStatus: Object.fromEntries(ORDER_STATUSES.map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0])), todayOrders: today.orders, todayPaid: today.paid, todayRevenueCents: today.revenue };
    });
  }
}

interface CustomerRow { id: string; name: string; email: string; phone: string; area: string; street: string; created_at: Date; version: number; orders: number; spent: number; last_order: Date | null }
const customerView = (r: CustomerRow) => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, area: r.area, street: r.street, orders: r.orders, spentCents: r.spent,
  segment: r.orders >= 2 ? 'returning' : 'new', lastOrderAt: r.last_order?.toISOString() ?? null, joinedAt: r.created_at.toISOString(), version: r.version,
});
const CUSTOMER_SELECT = `SELECT cu.*, count(o.id) FILTER (WHERE o.status <> 'CANCELLED')::int AS orders,
    COALESCE(sum(o.total_cents) FILTER (WHERE o.paid_at IS NOT NULL AND o.status <> 'CANCELLED'), 0)::bigint AS spent, max(o.created_at) AS last_order
  FROM customers cu LEFT JOIN orders o ON o.user_id = cu.id`;

export class CustomersService {
  constructor(private readonly db: Database) {}

  async list(q: z.infer<typeof CustomerListSchema>) {
    const after = q.cursor ? decodeCursor(q.cursor, 1)[0]! : null;
    if (after !== null && !isUuid(after)) throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
    return this.db.read(async (c) => {
      const { rows } = await c.query<CustomerRow>(
        `${CUSTOMER_SELECT}
          WHERE ($1::uuid IS NULL OR cu.id < $1)
            AND ($2::text IS NULL OR cu.name ILIKE '%' || $2 || '%' OR cu.phone ILIKE '%' || $2 || '%' OR cu.email ILIKE '%' || $2 || '%')
          GROUP BY cu.id HAVING ($3::text IS NULL OR ($3 = 'returning' AND count(o.id) FILTER (WHERE o.status <> 'CANCELLED') >= 2) OR ($3 = 'new' AND count(o.id) FILTER (WHERE o.status <> 'CANCELLED') < 2))
          ORDER BY cu.id DESC LIMIT $4`, [after, q.q ?? null, q.segment ?? null, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return { items: page.map(customerView), nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1]!.id]) : null };
    });
  }

  async get(id: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<CustomerRow>(`${CUSTOMER_SELECT} WHERE cu.id = $1 GROUP BY cu.id`, [id])).rows[0];
      if (!r) throw new NotFoundError('Customer');
      const recent = (await c.query<{ id: string; order_no: number; total_cents: number; created_at: Date; status: string }>(
        `SELECT o.id, o.order_no, o.total_cents, o.created_at, ${DISPLAY_STATUS} AS status FROM orders o LEFT JOIN pack_state ps ON ps.order_id = o.id WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 10`, [id])).rows;
      const notes = (await c.query<{ id: number; body: string; by_name: string; created_at: Date }>('SELECT id, body, by_name, created_at FROM customer_notes WHERE customer_id = $1 ORDER BY id DESC LIMIT 50', [id])).rows;
      return {
        ...customerView(r),
        recentOrders: recent.map((o) => ({ id: o.id, number: `SC-${o.order_no}`, totalCents: o.total_cents, status: o.status, at: o.created_at.toISOString() })),
        notes: notes.map((n) => ({ id: String(n.id), text: n.body, by: n.by_name, at: n.created_at.toISOString() })),
      };
    });
  }

  async update(id: string, patch: z.infer<typeof CustomerPatchSchema>, actor: Actor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE customers SET name = COALESCE($2, name), email = COALESCE($3, email), phone = COALESCE($4, phone), area = COALESCE($5, area), street = COALESCE($6, street), updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, patch.name ?? null, patch.email ?? null, patch.phone ?? null, patch.area ?? null, patch.street ?? null]);
      if (!rowCount) throw new NotFoundError('Customer');
      await audit(c, actor, 'customer.update', 'customer', id, { fields: Object.keys(patch) });
    });
    return this.get(id);
  }

  async addNote(id: string, text: string, actor: Actor) {
    await this.db.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM customers WHERE id = $1', [id])).rowCount) throw new NotFoundError('Customer');
      await c.query('INSERT INTO customer_notes (customer_id, body, by_id, by_name) VALUES ($1,$2,$3,$4)', [id, text, actor.id, actor.name ?? 'Staff']);
      await audit(c, actor, 'customer.note', 'customer', id, {});
    });
    return this.get(id);
  }

  /** A shopper reading or editing their own profile (customer tokens). */
  async mine(userId: string) {
    return this.db.tx(async (c) => {
      await c.query('INSERT INTO customers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [userId]);
      const r = (await c.query<CustomerRow>(`${CUSTOMER_SELECT} WHERE cu.id = $1 GROUP BY cu.id`, [userId])).rows[0]!;
      const { orders: _o, spentCents: _s, segment: _g, lastOrderAt: _l, ...profile } = customerView(r);
      return profile;
    });
  }

  async updateMine(userId: string, patch: z.infer<typeof ProfileSchema>) {
    await this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO customers (id, name, email, phone, area, street) VALUES ($1, COALESCE($2,''), COALESCE($3,''), COALESCE($4,''), COALESCE($5,''), COALESCE($6,''))
         ON CONFLICT (id) DO UPDATE SET name = COALESCE($2, customers.name), email = COALESCE($3, customers.email), phone = COALESCE($4, customers.phone),
           area = COALESCE($5, customers.area), street = COALESCE($6, customers.street), updated_at = now(), version = customers.version + 1`,
        [userId, patch.name ?? null, patch.email ?? null, patch.phone ?? null, patch.area ?? null, patch.street ?? null]);
    });
    return this.mine(userId);
  }
}
