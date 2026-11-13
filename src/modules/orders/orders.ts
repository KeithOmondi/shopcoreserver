import { priceBasket, recordRedemption, releaseRedemption } from '../marketing/promotions.js';
import { sell, restock } from '../inventory/stock.js';
import { deliverySettings, feeFor } from '../dispatch/zones.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import type { Database, Queryable } from '../../infra/db.js';
import type { Config } from '../../config/index.js';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { isUuid, uuidv7, uuidv7Timestamp } from '../../infra/uuid.js';
import { orderJobFailures, ordersCreated, orphanedPayments } from '../../infra/metrics.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { audit, outbox, type Actor } from '../products/products.js';

export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'CANCELLED' | 'FULFILLED';

/**
 * Order state machine. Transitions not listed here are rejected with 409.
 *   PENDING_PAYMENT -> PAID        (payment service confirms; reserved stock is committed)
 *   PENDING_PAYMENT -> CANCELLED   (customer cancels or payment window expires; stock released)
 *   PAID            -> FULFILLED   (warehouse ships)
 *   PAID            -> CANCELLED   (before shipment; stock returned, OrderCancelled carries refundRequired)
 */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLED', 'CANCELLED'],
  CANCELLED: [],
  FULFILLED: [],
};

export function assertTransition(from: OrderStatus, to: OrderStatus) {
  if (!TRANSITIONS[from].includes(to)) {
    throw new ConflictError('INVALID_STATE_TRANSITION', `Cannot move order from ${from} to ${to}`);
  }
}

export interface OrderItem {
  lineNo: number;
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  /** Human-friendly number shown to customers and staff. */
  orderNumber: string;
  userId: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  itemCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
}

export const makeCreateOrderSchema = (cfg: Pick<Config, 'ORDER_MAX_LINES' | 'ORDER_MAX_QTY_PER_LINE'>) =>
  z.strictObject({
    items: z
      .array(
        z.strictObject({
          productId: z.string().refine(isUuid, 'must be a UUID'),
          quantity: z.number().int().min(1).max(cfg.ORDER_MAX_QTY_PER_LINE),
        }),
      )
      .min(1)
      .max(cfg.ORDER_MAX_LINES)
      .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, 'duplicate productId'),
    paymentMethod: z.enum(['mpesa', 'card', 'cod']).optional(),
    /** Where to deliver, and who to call. Also fills in the customer's profile the first time. */
    delivery: z
      .strictObject({
        name: z.string().trim().min(1).max(120),
        phone: z.string().trim().min(5).max(32),
        area: z.string().trim().max(80).default(''),
        address: z.string().trim().min(1).max(200),
      })
      .optional(),
    /** A promotion code; the discount is worked out at checkout, never trusted from the client. */
    couponCode: z.string().trim().toUpperCase().max(40).optional(),
  });

export type CreateOrderInput = z.infer<ReturnType<typeof makeCreateOrderSchema>>;

/** Window in which a replica miss is retried on the writer (covers replication lag). */
const RECENT_ORDER_MS = 30_000;

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Canonical hash of the request so a reused key with a different body is detected. */
export function requestHash(input: CreateOrderInput): string {
  const canonical = [...input.items]
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
    .map((i) => `${i.productId}:${i.quantity}`)
    .join(',');
  const extra = input.delivery || input.paymentMethod ? `|${input.paymentMethod ?? ''}|${input.delivery ? JSON.stringify(input.delivery) : ''}` : '';
  return createHash('sha256').update(canonical + extra).digest('hex');
}

interface OrderRow {
  id: string;
  order_no: number;
  user_id: string;
  status: OrderStatus;
  total_cents: number;
  currency: string;
  item_count: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}
interface ItemRow {
  line_no: number;
  product_id: string;
  sku: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
}

const ORDER_COLS = 'id, order_no, user_id, status, total_cents, currency, item_count, version, created_at, updated_at';

const toOrder = (o: OrderRow, items: ItemRow[]): Order => ({
  id: o.id,
  orderNumber: `SC-${o.order_no}`,
  userId: o.user_id,
  status: o.status,
  totalCents: o.total_cents,
  currency: o.currency,
  itemCount: o.item_count,
  version: o.version,
  createdAt: o.created_at.toISOString(),
  updatedAt: o.updated_at.toISOString(),
  items: items.map((i) => ({
    lineNo: i.line_no,
    productId: i.product_id,
    sku: i.sku,
    name: i.name,
    quantity: i.quantity,
    unitPriceCents: i.unit_price_cents,
  })),
});

export class OrderRepository {
  async load(c: Queryable, id: string, forUpdate = false): Promise<Order | null> {
    const { rows } = await c.query<OrderRow>(
      `SELECT ${ORDER_COLS} FROM orders WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!rows[0]) return null;
    const items = await c.query<ItemRow>(
      'SELECT line_no, product_id, sku, name, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY line_no',
      [id],
    );
    return toOrder(rows[0], items.rows);
  }

  async listForUser(c: Queryable, userId: string, limit: number, after?: { createdAt: string; id: string }) {
    const { rows } = after
      ? await c.query<OrderRow>(
          `SELECT ${ORDER_COLS} FROM orders WHERE user_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
           ORDER BY created_at DESC, id DESC LIMIT $4`,
          [userId, after.createdAt, after.id, limit],
        )
      : await c.query<OrderRow>(
          `SELECT ${ORDER_COLS} FROM orders WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
          [userId, limit],
        );
    return rows.map((r) => toOrder(r, []));
  }

  /**
   * Lock (in product_id order) and reserve stock for every line in one round trip.
   * Returns how many lines were reserved; fewer than requested means some line was short
   * and the caller must roll back. The CHECK (available >= 0) constraint backs this up.
   */
  async reserveStock(c: pg.PoolClient, productIds: string[], quantities: number[]): Promise<number> {
    const { rowCount } = await c.query(
      `WITH locked AS MATERIALIZED (
         SELECT product_id FROM inventory WHERE product_id = ANY($1::uuid[]) ORDER BY product_id FOR UPDATE
       )
       UPDATE inventory i
          SET available = i.available - v.qty, reserved = i.reserved + v.qty, updated_at = now()
         FROM unnest($1::uuid[], $2::int[]) AS v(id, qty), locked l
        WHERE i.product_id = v.id AND l.product_id = v.id AND i.available >= v.qty`,
      [productIds, quantities],
    );
    return rowCount ?? 0;
  }

  /**
   * Lock inventory rows in a deterministic (product_id) order. Every transaction that
   * touches several inventory rows acquires locks in the same order, which rules out
   * lock-order deadlocks between concurrent multi-line orders.
   */
  async lockInventory(c: pg.PoolClient, productIds: string[]) {
    const { rows } = await c.query<{ product_id: string; available: number; reserved: number }>(
      'SELECT product_id, available, reserved FROM inventory WHERE product_id = ANY($1::uuid[]) ORDER BY product_id FOR UPDATE',
      [productIds],
    );
    return new Map(rows.map((r) => [r.product_id, r]));
  }
}

const qtyFor = (input: CreateOrderInput, sortedIds: string[]) =>
  sortedIds.map((id) => input.items.find((i) => i.productId === id)!.quantity);

export interface CreateResult {
  order: Order;
  replayed: boolean;
}

export class OrderService {
  constructor(
    private readonly db: Database,
    private readonly repo: OrderRepository,
  ) {}

  /**
   * Create an order atomically:
   *   1. claim the idempotency key (unique PK; a concurrent duplicate blocks then sees the winner)
   *   2. read authoritative prices inside the transaction (never from cache or the client)
   *   3. lock inventory rows in id order and reserve stock (CHECK available >= 0 backs this up)
   *   4. insert order + items + OrderCreated outbox event
   * Any failure rolls back everything, including the idempotency claim, so the client
   * can safely retry with the same key.
   */
  async create(userId: string, idempotencyKey: string, input: CreateOrderInput): Promise<CreateResult> {
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw new ValidationError([{ path: ['Idempotency-Key'], message: 'must match [A-Za-z0-9_-]{8,128}' }]);
    }
    const hash = requestHash(input);
    const orderId = uuidv7();
    try {
      const result = await this.db.tx<CreateResult>(async (c) => {
        const claim = await c.query<{ order_id: string }>(
          `INSERT INTO idempotency_keys (user_id, key, request_hash, order_id) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, key) DO NOTHING RETURNING order_id`,
          [userId, idempotencyKey, hash, orderId],
        );
        if (!claim.rowCount) {
          const prev = await c.query<{ request_hash: string; order_id: string }>(
            'SELECT request_hash, order_id FROM idempotency_keys WHERE user_id = $1 AND key = $2',
            [userId, idempotencyKey],
          );
          const row = prev.rows[0]!;
          if (row.request_hash !== hash) {
            throw new UnprocessableError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request');
          }
          const existing = await this.repo.load(c, row.order_id);
          return { order: existing!, replayed: true };
        }

        const ids = input.items.map((i) => i.productId).sort();
        const products = await c.query<{
          id: string;
          sku: string;
          name: string;
          price_cents: number;
          currency: string;
          active: boolean;
          category_id: string | null;
        }>('SELECT id, sku, name, price_cents, currency, active, category_id FROM products WHERE id = ANY($1::uuid[])', [ids]);
        const byId = new Map(products.rows.map((p) => [p.id, p]));
        const missing = ids.filter((id) => !byId.get(id)?.active);
        if (missing.length) throw new UnprocessableError('PRODUCT_UNAVAILABLE', 'Some products are unavailable', { productIds: missing });
        const currencies = new Set(products.rows.map((p) => p.currency));
        if (currencies.size > 1) throw new UnprocessableError('MIXED_CURRENCY', 'All items must share a currency');

        const lines = input.items.map((i, idx) => {
          const p = byId.get(i.productId)!;
          return { lineNo: idx + 1, p, quantity: i.quantity };
        });
        const listSubtotal = lines.reduce((sum, l) => sum + l.p.price_cents * l.quantity, 0);
        // Delivery fee: only when the order says where it is going (the zone’s fee, or the base fee).
        let fee = 0;
        let zoneId: string | null = null;
        if (input.delivery) {
          const s = await deliverySettings(c);
          if (listSubtotal < s.minBasketCents) throw new UnprocessableError('BELOW_MINIMUM_BASKET', 'The basket is below the minimum for delivery', { minBasketCents: s.minBasketCents });
          ({ zoneId, feeCents: fee } = await feeFor(c, input.delivery.area));
        }
        // Sale prices, bundle offers and the coupon are worked out here, on the server, from live data.
        const pricing = await priceBasket(c, userId, lines.map((l) => ({ productId: l.p.id, priceCents: l.p.price_cents, categoryId: l.p.category_id, quantity: l.quantity })), fee, input.couponCode, true);
        const subtotal = pricing.subtotalCents;
        const total = Math.max(0, subtotal + fee - pricing.discountCents);
        if (!Number.isSafeInteger(total)) throw new UnprocessableError('TOTAL_OVERFLOW', 'Order total too large');
        const itemCount = lines.reduce((s, l) => s + l.quantity, 0);
        const currency = products.rows[0]!.currency;

        const o = await c.query<OrderRow>(
          `INSERT INTO orders (id, user_id, status, total_cents, currency, item_count, payment_method, delivery_name, delivery_phone, delivery_area, delivery_address, subtotal_cents, delivery_fee_cents, zone_id, discount_cents, coupon_id, bundle_id, bundle_discount_cents)
           VALUES ($1,$2,'PENDING_PAYMENT',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${ORDER_COLS}`,
          [orderId, userId, total, currency, itemCount, input.paymentMethod ?? null, input.delivery?.name ?? null, input.delivery?.phone ?? null, input.delivery?.area ?? null, input.delivery?.address ?? null, subtotal, fee, zoneId, pricing.discountCents, pricing.coupon?.id ?? null, pricing.bundle?.id ?? null, pricing.bundle?.discountCents ?? 0],
        );
        await recordRedemption(c, orderId, userId, pricing);
        await this.touchCustomer(c, userId, input.delivery);
        const items = await c.query<ItemRow>(
          `INSERT INTO order_items (order_id, line_no, product_id, sku, name, quantity, unit_price_cents, flash_sale_id)
           SELECT $1, * FROM unnest($2::smallint[], $3::uuid[], $4::text[], $5::text[], $6::int[], $7::bigint[], $8::uuid[])
           RETURNING line_no, product_id, sku, name, quantity, unit_price_cents`,
          [
            orderId,
            lines.map((l) => l.lineNo),
            lines.map((l) => l.p.id),
            lines.map((l) => l.p.sku),
            lines.map((l) => l.p.name),
            lines.map((l) => l.quantity),
            pricing.lines.map((l) => l.unitCents),
            pricing.lines.map((l) => l.flashSaleId),
          ],
        );
        const order = toOrder(o.rows[0]!, items.rows.sort((a, b) => a.line_no - b.line_no));
        await outbox(c, 'order', orderId, 'OrderCreated', order);

        // Reserve stock LAST, immediately before COMMIT. Inventory row locks are the only
        // contended resource (a flash-sale SKU serializes every order on one row), so the time
        // between acquiring them and committing bounds hot-SKU throughput. One statement both
        // locks the rows in product_id order (the materialized FOR UPDATE CTE, which keeps lock
        // order deterministic => no deadlocks) and decrements them conditionally.
        const reserved = await this.repo.reserveStock(c, ids, qtyFor(input, ids));
        if (reserved < ids.length) {
          const stock = await c.query<{ product_id: string; available: number }>(
            'SELECT product_id, available FROM inventory WHERE product_id = ANY($1::uuid[])',
            [ids],
          );
          const avail = new Map(stock.rows.map((r) => [r.product_id, r.available]));
          const short = input.items
            .filter((i) => (avail.get(i.productId) ?? 0) < i.quantity)
            .map((i) => ({ productId: i.productId, requested: i.quantity, available: avail.get(i.productId) ?? 0 }));
          throw new ConflictError('INSUFFICIENT_STOCK', 'Insufficient stock', { items: short });
        }
        // Cash on delivery is confirmed on the spot: the stock leaves the shelf now and the rider collects the money at the door.
        if (input.paymentMethod === 'cod') {
          await c.query(
            `UPDATE inventory i SET reserved = i.reserved - v.qty, updated_at = now() FROM unnest($1::uuid[], $2::int[]) AS v(id, qty) WHERE i.product_id = v.id`,
            [ids, qtyFor(input, ids)],
          );
          await c.query(
            `UPDATE orders SET status = 'PAID', payment_ref = $2, cod_due_cents = total_cents, paid_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
            [orderId, `COD-SC-${o.rows[0]!.order_no}`],
          );
          await sell(c, order.items, `SC-${o.rows[0]!.order_no}`);
          await outbox(c, 'order', orderId, 'OrderPaid', { orderId, paymentRef: `COD-SC-${o.rows[0]!.order_no}`, amountCents: total, currency, method: 'cod' });
          return { order: (await this.repo.load(c, orderId))!, replayed: false };
        }
        return { order, replayed: false };
      });
      ordersCreated.inc({ result: result.replayed ? 'replayed' : 'created' });
      return result;
    } catch (err) {
      ordersCreated.inc({ result: (err as { code?: string }).code ?? 'error' });
      throw err;
    }
  }

  /**
   * Owner (or admin) read. Reads from a replica first; on miss falls back to the
   * writer so a client that just created an order never sees a 404 due to replica lag.
   */
  async get(id: string, requester: { sub: string; isAdmin: boolean }): Promise<Order> {
    if (!isUuid(id)) throw new NotFoundError('Order');
    let order = await this.db.read((c) => this.repo.load(c, id));
    // Replica lag can only hide an order created moments ago. Ids are UUIDv7 (time-ordered), so
    // only fall back to the writer for ids minted recently; random/enumerated ids never reach it.
    const born = uuidv7Timestamp(id);
    if (!order && born !== null && Date.now() - born < RECENT_ORDER_MS) {
      order = await this.db.read(() => this.repo.load(this.db.writer, id));
    }
    // Same 404 for "missing" and "not yours": do not leak existence of other users' orders.
    if (!order || (order.userId !== requester.sub && !requester.isAdmin)) throw new NotFoundError('Order');
    return order;
  }

  async list(userId: string, limit: number, cursor?: string) {
    let after: { createdAt: string; id: string } | undefined;
    if (cursor) {
      const [createdAt, id] = decodeCursor(cursor, 2) as [string, string];
      if (!isUuid(id) || Number.isNaN(Date.parse(createdAt))) {
        throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
      }
      after = { createdAt, id };
    }
    const rows = await this.db.read((c) => this.repo.listForUser(c, userId, limit + 1, after));
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(({ items: _items, ...summary }) => summary);
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? encodeCursor([last.createdAt, last.id]) : null };
  }

  /** Customer- or system-initiated cancellation; releases reserved stock. */
  async cancel(id: string, requester: { sub: string; isAdmin: boolean; requestId: string }, reason: string) {
    return this.db.tx(async (c) => {
      const order = await this.repo.load(c, id, true);
      if (!order || (order.userId !== requester.sub && !requester.isAdmin)) throw new NotFoundError('Order');
      assertTransition(order.status, 'CANCELLED');
      // Everything that doesn't need the (hot) inventory row is done first, so that lock is held for as short a time as possible.
      let refundRequired = false;
      let paymentRef: string | null = null;
      if (order.status === 'PAID') {
        const p = (await c.query<{ cod: boolean; collected: boolean; payment_ref: string | null }>(
          'SELECT (cod_due_cents IS NOT NULL) AS cod, (cod_collected_at IS NOT NULL) AS collected, payment_ref FROM orders WHERE id = $1', [id])).rows[0]!;
        // Cash orders have taken no money until the rider collects it, so there is nothing to refund before then.
        refundRequired = !p.cod || p.collected;
        paymentRef = refundRequired ? p.payment_ref : null;
        // An offer nobody accepted just disappears; a rider already on the job shows up under exceptions so dispatch can tell them.
        await c.query(
          `UPDATE deliveries SET status = CASE WHEN status = 'offered' THEN 'cancelled' ELSE 'failed' END,
                  failure_kind = CASE WHEN status = 'offered' THEN NULL ELSE 'Cancelled' END, failure_reason = CASE WHEN status = 'offered' THEN NULL ELSE $2 END,
                  failed_at = CASE WHEN status = 'offered' THEN NULL ELSE now() END, version = version + 1
            WHERE order_id = $1 AND status IN ('offered','accepted','at_pickup','picked_up','at_dropoff')`, [id, reason]);
      }
      const updated = await this.setStatus(c, order, 'CANCELLED', reason);
      await outbox(c, 'order', id, 'OrderCancelled', { orderId: id, reason, refundRequired, paymentRef });
      await audit(c, { id: requester.sub, requestId: requester.requestId }, 'order.cancel', 'order', id, { reason, refundRequired });
      // Stock last: the inventory row is the contended resource, so it is locked only for the final statements before COMMIT.
      await this.releaseStock(c, order);
      return updated;
    });
  }

  /**
   * Called by the payment service (role=payments) once the charge has succeeded.
   *  - The charged amount/currency must equal the order total (422 PAYMENT_AMOUNT_MISMATCH otherwise).
   *  - Re-delivery with the same paymentRef is a no-op; a different paymentRef on a paid order is 409.
   *  - A paymentRef can pay at most one order (unique index).
   *  - If the order was already cancelled/expired, the payment is recorded as an
   *    OrderPaymentOrphaned event (so the payment service can refund) and the call returns 409.
   */
  async markPaid(id: string, actor: Actor, pay: { paymentRef: string; amountCents: number; currency: string }) {
    let orphaned = false;
    try {
      const result = await this.db.tx(async (c) => {
        orphaned = false; // the transaction may be retried
        const order = await this.repo.load(c, id, true);
        if (!order) throw new NotFoundError('Order');
        const existingRef = await this.paymentRef(c, id);
        if (order.status === 'PAID' || order.status === 'FULFILLED') {
          if (existingRef === pay.paymentRef) return order; // idempotent confirmation
          throw new ConflictError('ORDER_ALREADY_PAID', 'Order was already paid with a different paymentRef');
        }
        if (order.status === 'CANCELLED') {
          const seen = await c.query(
            `SELECT 1 FROM audit_log WHERE entity_type = 'order' AND entity_id = $1
               AND action = 'order.payment_orphaned' AND data->>'paymentRef' = $2 LIMIT 1`,
            [id, pay.paymentRef],
          );
          if (!seen.rowCount) {
            await outbox(c, 'order', id, 'OrderPaymentOrphaned', { orderId: id, ...pay });
            await audit(c, actor, 'order.payment_orphaned', 'order', id, pay);
            orphanedPayments.inc();
          }
          orphaned = true;
          return order;
        }
        if (pay.currency !== order.currency || pay.amountCents !== order.totalCents) {
          throw new UnprocessableError('PAYMENT_AMOUNT_MISMATCH', 'Charged amount does not match the order total', {
            expected: { amountCents: order.totalCents, currency: order.currency },
          });
        }
        assertTransition(order.status, 'PAID');
        const ids = order.items.map((i) => i.productId).sort();
        await this.repo.lockInventory(c, ids);
        await c.query(
          `UPDATE inventory i SET reserved = i.reserved - v.qty, updated_at = now()
           FROM unnest($1::uuid[], $2::int[]) AS v(id, qty) WHERE i.product_id = v.id`,
          [ids, ids.map((pid) => order.items.find((i) => i.productId === pid)!.quantity)],
        );
        await c.query('UPDATE orders SET payment_ref = $2 WHERE id = $1', [id, pay.paymentRef]);
        await sell(c, order.items, await this.orderRef(c, id));
        const updated = await this.setStatus(c, order, 'PAID');
        await outbox(c, 'order', id, 'OrderPaid', {
          orderId: id,
          paymentRef: pay.paymentRef,
          amountCents: pay.amountCents,
          currency: pay.currency,
        });
        await audit(c, actor, 'order.paid', 'order', id, pay);
        return updated;
      });
      if (orphaned) {
        throw new ConflictError('ORDER_CANCELLED', 'Order is cancelled; the payment was recorded and must be refunded', {
          orderId: id,
          paymentRef: pay.paymentRef,
        });
      }
      return result;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('PAYMENT_REF_REUSED', 'paymentRef was already used for another order');
      }
      throw err;
    }
  }

  /** Warehouse shipment: PAID -> FULFILLED. */
  async fulfill(id: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const order = await this.repo.load(c, id, true);
      if (!order) throw new NotFoundError('Order');
      assertTransition(order.status, 'FULFILLED');
      const updated = await this.setStatus(c, order, 'FULFILLED');
      await outbox(c, 'order', id, 'OrderFulfilled', { orderId: id });
      await audit(c, actor, 'order.fulfilled', 'order', id, {});
      return updated;
    });
  }

  /**
   * Background job: cancel orders whose payment window elapsed. Returns the number cancelled.
   * Each order is cancelled in its OWN short transaction. A single transaction over a batch would
   * accumulate inventory row locks in arbitrary order across orders and could deadlock with
   * concurrent checkouts; per-order transactions hold locks only for one order's (sorted) rows.
   */
  async expireUnpaid(olderThanMinutes: number, batch = 200): Promise<number> {
    const ids = await this.db.tx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM orders WHERE status = 'PENDING_PAYMENT' AND created_at < now() - make_interval(mins => $1)
         ORDER BY created_at LIMIT $2`,
        [olderThanMinutes, batch],
      );
      return rows.map((r) => r.id);
    });
    let cancelled = 0;
    for (const id of ids) {
      try {
        const done = await this.db.tx(async (c) => {
          const order = await this.repo.load(c, id, true);
          if (!order || order.status !== 'PENDING_PAYMENT') return false; // paid/cancelled meanwhile
          await this.releaseStock(c, order);
          await this.setStatus(c, order, 'CANCELLED');
          await outbox(c, 'order', id, 'OrderCancelled', {
            orderId: id,
            reason: 'payment_timeout',
            refundRequired: false,
            paymentRef: null,
          });
          await audit(c, { id: 'system:expiry', requestId: 'job:expire-unpaid' }, 'order.expire', 'order', id, {
            olderThanMinutes,
          });
          return true;
        });
        if (done) cancelled++;
      } catch {
        orderJobFailures.inc({ job: 'expire-unpaid' });
      }
    }
    return cancelled;
  }

  /** Make sure the buyer has a profile; the first delivery details fill in anything still blank. */
  private async touchCustomer(c: Queryable, userId: string, d?: { name: string; phone: string; area: string; address: string }) {
    if (!d) {
      await c.query('INSERT INTO customers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [userId]);
      return;
    }
    await c.query(
      `INSERT INTO customers (id, name, phone, area, street) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name = CASE WHEN customers.name = '' THEN EXCLUDED.name ELSE customers.name END,
         phone = CASE WHEN customers.phone = '' THEN EXCLUDED.phone ELSE customers.phone END,
         area = CASE WHEN customers.area = '' THEN EXCLUDED.area ELSE customers.area END,
         street = CASE WHEN customers.street = '' THEN EXCLUDED.street ELSE customers.street END`,
      [userId, d.name, d.phone, d.area, d.address],
    );
  }

  private async orderRef(c: Queryable, id: string): Promise<string> {
    const { rows } = await c.query<{ order_no: number }>('SELECT order_no FROM orders WHERE id = $1', [id]);
    return rows[0] ? `SC-${rows[0].order_no}` : id;
  }

  private async paymentRef(c: Queryable, id: string): Promise<string | null> {
    const { rows } = await c.query<{ payment_ref: string | null }>('SELECT payment_ref FROM orders WHERE id = $1', [id]);
    return rows[0]?.payment_ref ?? null;
  }

  /**
   * Return an order's stock. PENDING_PAYMENT: move reserved -> available. PAID: the reservation was
   * already consumed at payment, so just add the units back to available.
   */
  private async releaseStock(c: pg.PoolClient, order: Order) {
    const ids = order.items.map((i) => i.productId).sort();
    await this.repo.lockInventory(c, ids);
    const fromReserved = order.status === 'PENDING_PAYMENT';
    // Paid orders had already left the shelves: put them back.
    if (!fromReserved) await restock(c, order.items, await this.orderRef(c, order.id), 'Return restock', 'Order cancelled after payment');
    await c.query(
      `UPDATE inventory i SET available = i.available + v.qty,
              reserved = i.reserved - CASE WHEN $3::boolean THEN v.qty ELSE 0 END, updated_at = now()
       FROM unnest($1::uuid[], $2::int[]) AS v(id, qty) WHERE i.product_id = v.id`,
      [ids, ids.map((pid) => order.items.find((i) => i.productId === pid)!.quantity), fromReserved],
    );
  }

  private async setStatus(c: pg.PoolClient, order: Order, to: OrderStatus, cancelReason?: string): Promise<Order> {
    const { rowCount } = await c.query(
      `UPDATE orders SET status = $2, version = version + 1, updated_at = now(),
              paid_at = CASE WHEN $2 = 'PAID' THEN now() ELSE paid_at END,
              fulfilled_at = CASE WHEN $2 = 'FULFILLED' THEN now() ELSE fulfilled_at END,
              cancelled_at = CASE WHEN $2 = 'CANCELLED' THEN now() ELSE cancelled_at END,
              cancel_reason = COALESCE($4, cancel_reason)
        WHERE id = $1 AND version = $3`,
      [order.id, to, order.version, cancelReason ?? null],
    );
    if (!rowCount) throw new ConflictError('VERSION_CONFLICT', 'Order was modified concurrently');
    if (to === 'CANCELLED') await releaseRedemption(c, order.id);
    return (await this.repo.load(c, order.id))!;
  }
}

