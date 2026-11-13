import type { Queryable } from '../../infra/db.js';
import { UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';

/**
 * The stock engine: the one place that changes how many units sit at each location.
 *
 * Invariant (checked by tests): for every product,  sum(stock_levels.on_hand) = inventory.available + inventory.reserved.
 *
 *  - Staff-initiated changes (adjustments, transfers, receipts, counts, write-offs) change on_hand AND inventory.available.
 *  - Order flow changes inventory itself (reserve / pay / cancel). When an order is paid, units leave the shelf, so the
 *    engine is told to take them from locations *without* touching inventory again (`syncInventory: false`).
 */
export type MoveType = 'Sale' | 'Transfer in' | 'Transfer out' | 'Adjustment' | 'PO receipt' | 'Write-off' | 'Return restock' | 'Opening stock' | 'Count correction';

export interface Move { productId: string; locationId: string; delta: number; type: MoveType; ref?: string; note?: string }
export interface StockActor { id: string; name: string }
export const SYSTEM: StockActor = { id: 'system', name: 'System' };

/** Keys used when taking moves in a stable order, so concurrent transactions never lock rows in opposite orders. */
const keyOf = (m: Move) => `${m.productId}|${m.locationId}`;

export async function applyMoves(c: Queryable, moves: Move[], actor: StockActor, opts: { syncInventory?: boolean } = {}): Promise<void> {
  const sync = opts.syncInventory ?? true;
  const ordered = moves.filter((m) => m.delta !== 0).sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
  const perProduct = new Map<string, number>();
  for (const m of ordered) {
    const negative = (): never => { throw new UnprocessableError('NEGATIVE_STOCK', 'Not enough stock at that location', { productId: m.productId, locationId: m.locationId }); };
    // Update the shelf row if there is one; otherwise this is the first stock at that location. (A bare upsert
    // can't be used: Postgres checks on_hand >= 0 on the proposed row before it notices the conflict.)
    let rows: { on_hand: number }[];
    try {
      rows = (await c.query<{ on_hand: number }>(
        'UPDATE stock_levels SET on_hand = on_hand + $3, updated_at = now() WHERE product_id = $1 AND location_id = $2 RETURNING on_hand',
        [m.productId, m.locationId, m.delta])).rows;
      if (!rows[0]) {
        if (m.delta < 0) negative();
        rows = (await c.query<{ on_hand: number }>('INSERT INTO stock_levels (product_id, location_id, on_hand) VALUES ($1,$2,$3) RETURNING on_hand', [m.productId, m.locationId, m.delta])).rows;
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23514') negative();
      if (code === '23503') throw new UnprocessableError('UNKNOWN_PRODUCT_OR_LOCATION', 'Unknown product or location');
      throw e;
    }
    const row = rows[0]!;
    await c.query(
      `INSERT INTO stock_movements (product_id, location_id, type, qty, balance, ref, note, actor_id, actor_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [m.productId, m.locationId, m.type, m.delta, row.on_hand, m.ref ?? '', m.note ?? '', actor.id, actor.name],
    );
    perProduct.set(m.productId, (perProduct.get(m.productId) ?? 0) + m.delta);
  }
  if (!sync) return;
  for (const [productId, net] of perProduct) {
    if (net === 0) continue;
    const { rowCount } = await c.query(
      `UPDATE inventory SET available = available + $2, updated_at = now() WHERE product_id = $1 AND available + $2 >= 0`,
      [productId, net],
    );
    if (!rowCount) throw new UnprocessableError('NEGATIVE_STOCK', 'That would leave less stock than is already promised to customers', { productId });
  }
}

/** The location that unspecified stock lands in and sales are taken from first. Creates one if none exists yet. */
export async function primaryLocation(c: Queryable): Promise<string> {
  const { rows } = await c.query<{ id: string }>('SELECT id FROM locations WHERE active ORDER BY sort_order, created_at LIMIT 1');
  if (rows[0]) return rows[0].id;
  const any = await c.query<{ id: string }>('SELECT id FROM locations ORDER BY sort_order, created_at LIMIT 1');
  if (any.rows[0]) return any.rows[0].id;
  const id = uuidv7();
  await c.query(`INSERT INTO locations (id, name) VALUES ($1, 'Main warehouse') ON CONFLICT DO NOTHING`, [id]);
  return (await c.query<{ id: string }>('SELECT id FROM locations ORDER BY sort_order, created_at LIMIT 1')).rows[0]!.id;
}

/**
 * Take `qty` units of a product off the shelves for a sale: primary location first, then wherever there is most.
 * Never fails: if the shelves hold less than expected the shortfall is logged in the movement note, not thrown,
 * because the customer has already paid and the order flow must not break.
 */
export async function sell(c: Queryable, items: { productId: string; quantity: number }[], ref: string): Promise<void> {
  const primary = await primaryLocation(c);
  const moves: Move[] = [];
  for (const it of [...items].sort((a, b) => (a.productId < b.productId ? -1 : 1))) {
    const { rows } = await c.query<{ location_id: string; on_hand: number }>(
      `SELECT sl.location_id, sl.on_hand FROM stock_levels sl JOIN locations l ON l.id = sl.location_id
        WHERE sl.product_id = $1 AND sl.on_hand > 0
        ORDER BY (sl.location_id = $2) DESC, sl.on_hand DESC FOR UPDATE OF sl`,
      [it.productId, primary],
    );
    let left = it.quantity;
    for (const r of rows) {
      if (left === 0) break;
      const take = Math.min(left, r.on_hand);
      moves.push({ productId: it.productId, locationId: r.location_id, delta: -take, type: 'Sale', ref });
      left -= take;
    }
    if (left > 0) console.error(`stock drift: ${left} unit(s) of ${it.productId} sold with no shelf stock (${ref})`);
  }
  await applyMoves(c, moves, SYSTEM, { syncInventory: false });
}

/** Units come back to the primary location (an order cancelled after payment). */
export async function restock(c: Queryable, items: { productId: string; quantity: number }[], ref: string, type: MoveType = 'Return restock', note = ''): Promise<void> {
  const primary = await primaryLocation(c);
  await applyMoves(c, items.map((it) => ({ productId: it.productId, locationId: primary, delta: it.quantity, type, ref, note })), SYSTEM, { syncInventory: false });
}
