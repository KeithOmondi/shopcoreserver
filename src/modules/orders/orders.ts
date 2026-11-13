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
  return createHash('sha256').update(canonical).digest('hex');
}

interface OrderRow {
  id: string;
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

const ORDER_COLS = 'id, user_id, status, total_cents, currency, item_count, version, created_at, updated_at';

const toOrder = (o: OrderRow, items: ItemRow[]): Order => ({
  id: o.id,
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
        }>('SELECT id, sku, name, price_cents, currency, active FROM products WHERE id = ANY($1::uuid[])', [ids]);
        const byId = new Map(products.rows.map((p) => [p.id, p]));
        const missing = ids.filter((id) => !byId.get(id)?.active);
        if (missing.length) throw new UnprocessableError('PRODUCT_UNAVAILABLE', 'Some products are unavailable', { productIds: missing });
        const currencies = new Set(products.rows.map((p) => p.currency));
        if (currencies.size > 1) throw new UnprocessableError('MIXED_CURRENCY', 'All items must share a currency');

        const lines = input.items.map((i, idx) => {
          const p = byId.get(i.productId)!;
          return { lineNo: idx + 1, p, quantity: i.quantity };
        });
        const total = lines.reduce((sum, l) => sum + l.p.price_cents * l.quantity, 0);
        if (!Number.isSafeInteger(total)) throw new UnprocessableError('TOTAL_OVERFLOW', 'Order total too large');
        const itemCount = lines.reduce((s, l) => s + l.quantity, 0);
        const currency = products.rows[0]!.currency;

        const o = await c.query<OrderRow>(
          `INSERT INTO orders (id, user_id, status, total_cents, currency, item_count)
           VALUES ($1,$2,'PENDING_PAYMENT',$3,$4,$5) RETURNING ${ORDER_COLS}`,
          [orderId, userId, total, currency, itemCount],
        );
        const items = await c.query<ItemRow>(
          `INSERT INTO order_items (order_id, line_no, product_id, sku, name, quantity, unit_price_cents)
           SELECT $1, * FROM unnest($2::smallint[], $3::uuid[], $4::text[], $5::text[], $6::int[], $7::bigint[])
           RETURNING line_no, product_id, sku, name, quantity, unit_price_cents`,
          [
            orderId,
            lines.map((l) => l.lineNo),
            lines.map((l) => l.p.id),
            lines.map((l) => l.p.sku),
            lines.map((l) => l.p.name),
            lines.map((l) => l.quantity),
            lines.map((l) => l.p.price_cents),
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
      const refundRequired = order.status === 'PAID';
      const paymentRef = refundRequired ? await this.paymentRef(c, id) : null;
      await this.releaseStock(c, order);
      const updated = await this.setStatus(c, order, 'CANCELLED');
      await outbox(c, 'order', id, 'OrderCancelled', { orderId: id, reason, refundRequired, paymentRef });
      await audit(c, { id: requester.sub, requestId: requester.requestId }, 'order.cancel', 'order', id, { reason, refundRequired });
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
    await c.query(
      `UPDATE inventory i SET available = i.available + v.qty,
              reserved = i.reserved - CASE WHEN $3::boolean THEN v.qty ELSE 0 END, updated_at = now()
       FROM unnest($1::uuid[], $2::int[]) AS v(id, qty) WHERE i.product_id = v.id`,
      [ids, ids.map((pid) => order.items.find((i) => i.productId === pid)!.quantity), fromReserved],
    );
  }

  private async setStatus(c: pg.PoolClient, order: Order, to: OrderStatus): Promise<Order> {
    const { rowCount } = await c.query(
      'UPDATE orders SET status = $2, version = version + 1, updated_at = now() WHERE id = $1 AND version = $3',
      [order.id, to, order.version],
    );
    if (!rowCount) throw new ConflictError('VERSION_CONFLICT', 'Order was modified concurrently');
    return (await this.repo.load(c, order.id))!;
  }
}

