import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from '../../infra/db.js';
import type pg from 'pg';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { isUuid, uuidv7 } from '../../infra/uuid.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { audit, outbox, type Actor } from '../products/products.js';
import { primaryLocation } from '../inventory/stock.js';
import type { RiderContext } from './riders.js';

const uuid = z.string().refine(isUuid, 'must be a UUID');
export const OFFER_SECONDS = 75;
export const DECLINE_REASONS = ['too_far', 'busy', 'vehicle', 'safety', 'other'] as const;
export const FAILURE_REASONS = ['Customer unavailable', 'Item damaged', 'Store closed', 'Incorrect address', 'Customer refused', 'Rider unreachable'] as const;
export const INCIDENT_TYPES = ['Road accident', 'Vehicle issue', 'Customer conflict', 'Medical assistance', 'Theft or robbery', 'Other'] as const;

// ---- schemas ----------------------------------------------------------------------------------------------------------

export const AssignSchema = z.strictObject({ riderId: uuid, force: z.boolean().default(false), note: z.string().trim().max(200).default('') });
export const DeclineSchema = z.strictObject({ reason: z.enum(DECLINE_REASONS).default('other') });
export const StageSchema = z.strictObject({ stage: z.enum(['at_pickup', 'picked_up', 'at_dropoff']) });
export const DeliverSchema = z.strictObject({ code: z.string().regex(/^\d{4}$/), cashCents: z.number().int().min(0).optional(), photoRef: z.string().trim().max(300).optional() });
export const FailSchema = z.strictObject({ reason: z.enum(FAILURE_REASONS), note: z.string().trim().max(300).default('') });
export const ResolveSchema = z.strictObject({ note: z.string().trim().min(3).max(300) });
export const ExceptionListSchema = z.object({ state: z.enum(['open', 'resolved']).default('open'), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional() });
export const IncidentSchema = z.strictObject({ type: z.enum(INCIDENT_TYPES), sos: z.boolean().default(false), note: z.string().trim().max(500).default(''), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() });
export const IncidentListSchema = z.object({ status: z.enum(['open', 'investigating', 'resolved']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const IncidentUpdateSchema = z.strictObject({ status: z.enum(['investigating', 'resolved']).optional(), note: z.string().trim().min(1).max(1000).optional() }).refine((v) => v.status || v.note, 'nothing to change');

const LIVE = `('accepted','at_pickup','picked_up','at_dropoff')`;
const NEXT: Record<string, string> = { accepted: 'at_pickup', at_pickup: 'picked_up', picked_up: 'at_dropoff' };

export interface RiderActor extends Actor { name: string }

interface DeliveryRow {
  id: string; order_id: string; order_no: number; rider_id: string | null; rider: string | null; status: string; offer_expires_at: Date | null; created_at: Date; accepted_at: Date | null;
  picked_up_at: Date | null; fare_cents: number; bonus_cents: number; tip_cents: number; cod_cents: number; distance_km: string; assigned_by: string; total_cents: number;
  customer: string | null; phone: string | null; area: string | null; address: string | null; zone: string | null; location: string | null; items: { name: string; quantity: number }[];
}
const DELIVERY_SELECT = `SELECT d.id, d.order_id, o.order_no, d.rider_id, r.name AS rider, d.status, d.offer_expires_at, d.created_at, d.accepted_at, d.picked_up_at, d.fare_cents, d.bonus_cents, d.tip_cents,
    d.cod_cents, d.distance_km, d.assigned_by, o.total_cents, COALESCE(NULLIF(o.delivery_name,''), NULLIF(cu.name,''), 'Customer') AS customer,
    COALESCE(NULLIF(o.delivery_phone,''), cu.phone) AS phone, COALESCE(NULLIF(o.delivery_area,''), cu.area) AS area, COALESCE(NULLIF(o.delivery_address,''), cu.street) AS address,
    z.name AS zone, l.name AS location,
    (SELECT json_agg(json_build_object('name', oi.name, 'quantity', oi.quantity) ORDER BY oi.line_no) FROM order_items oi WHERE oi.order_id = d.order_id) AS items
  FROM deliveries d JOIN orders o ON o.id = d.order_id LEFT JOIN riders r ON r.id = d.rider_id LEFT JOIN customers cu ON cu.id = o.user_id
  LEFT JOIN zones z ON z.id = o.zone_id LEFT JOIN locations l ON l.id = d.pickup_location_id`;

const deliveryView = (d: DeliveryRow) => ({
  id: d.id, orderId: d.order_id, order: `SC-${d.order_no}`, riderId: d.rider_id, rider: d.rider, status: d.status, offerExpiresAt: d.offer_expires_at?.toISOString() ?? null,
  assignedAt: d.created_at.toISOString(), acceptedAt: d.accepted_at?.toISOString() ?? null, pickedUpAt: d.picked_up_at?.toISOString() ?? null, assignedBy: d.assigned_by,
  customer: d.customer, phone: d.phone, area: d.area, address: d.address, zone: d.zone, pickup: d.location, items: d.items ?? [], totalCents: d.total_cents,
  earningsCents: d.fare_cents + d.bonus_cents + d.tip_cents, fareCents: d.fare_cents, bonusCents: d.bonus_cents, tipCents: d.tip_cents, codCents: d.cod_cents, distanceKm: Number(d.distance_km),
});

export class DispatchService {
  constructor(private readonly db: Database) {}

  /** Offers nobody answered in time go back to the pool. Runs whenever the board or an offer list is read, and from the worker. */
  async expireOffers(c?: Queryable): Promise<number> {
    const run = async (q: Queryable) => {
      const { rows } = await q.query<{ id: string; rider_id: string }>(
        `UPDATE deliveries SET status = 'cancelled', version = version + 1 WHERE status = 'offered' AND offer_expires_at < now() RETURNING id, rider_id`);
      for (const r of rows) await q.query(`INSERT INTO delivery_attempts (delivery_id, rider_id, outcome) VALUES ($1,$2,'expired')`, [r.id, r.rider_id]);
      return rows.length;
    };
    return c ? run(c) : this.db.tx(run);
  }

  // ---- staff: the board -------------------------------------------------------------------------------------------------

  /** Paid orders still waiting for a rider, deliveries in progress, and the riders who could take work. */
  async board() {
    await this.expireOffers();
    return this.db.read(async (c) => {
      const un = (await c.query<{ id: string; order_no: number; created_at: Date; total_cents: number; cod: boolean; customer: string; area: string | null; zone: string | null; packed: boolean; items: number }>(
        `SELECT o.id, o.order_no, o.created_at, o.total_cents, (o.cod_due_cents IS NOT NULL) AS cod, COALESCE(NULLIF(o.delivery_name,''), NULLIF(cu.name,''), 'Customer') AS customer,
                COALESCE(NULLIF(o.delivery_area,''), cu.area) AS area, z.name AS zone, (ps.stage = 'packed') AS packed, o.item_count AS items
           FROM orders o LEFT JOIN customers cu ON cu.id = o.user_id LEFT JOIN zones z ON z.id = o.zone_id LEFT JOIN pack_state ps ON ps.order_id = o.id
          WHERE o.status = 'PAID' AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id AND d.status NOT IN ('failed','cancelled'))
          ORDER BY o.created_at LIMIT 200`)).rows;
      const active = (await c.query<DeliveryRow>(`${DELIVERY_SELECT} WHERE d.status IN ('offered','accepted','at_pickup','picked_up','at_dropoff') ORDER BY d.created_at DESC LIMIT 200`)).rows;
      const riders = (await c.query<{ id: string; name: string; phone: string; vehicle: string; zone: string | null; zone_id: string | null; availability: string; lat: number | null; lng: number | null; seen: Date | null; live: number }>(
        `SELECT r.id, r.name, r.phone, r.vehicle, z.name AS zone, r.zone_id, r.availability, r.last_lat AS lat, r.last_lng AS lng, r.last_seen_at AS seen,
                (SELECT count(*)::int FROM deliveries d WHERE d.rider_id = r.id AND d.status IN ${LIVE}) AS live
           FROM riders r LEFT JOIN zones z ON z.id = r.zone_id WHERE r.account_status = 'approved' AND r.availability = 'online' ORDER BY live, r.name`)).rows;
      return {
        unassigned: un.map((o) => ({ orderId: o.id, order: `SC-${o.order_no}`, placedAt: o.created_at.toISOString(), totalCents: o.total_cents, cod: o.cod, customer: o.customer, area: o.area, zone: o.zone, packed: o.packed === true, items: o.items })),
        active: active.map(deliveryView),
        riders: riders.map((r) => ({ id: r.id, name: r.name, phone: r.phone, vehicle: r.vehicle, zoneId: r.zone_id, zone: r.zone, activeDeliveries: r.live, location: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng, at: r.seen?.toISOString() ?? null } : null })),
      };
    });
  }

  /** Online riders ranked for an order: same zone first, then fewest live deliveries. */
  async suggest(orderId: string) {
    const b = await this.board();
    const o = await this.db.read(async (c) => (await c.query<{ zone_id: string | null }>('SELECT zone_id FROM orders WHERE id = $1', [orderId])).rows[0]);
    if (!o) throw new NotFoundError('Order');
    return { items: [...b.riders].sort((a, c) => Number(c.zoneId === o.zone_id) - Number(a.zoneId === o.zone_id) || a.activeDeliveries - c.activeDeliveries) };
  }

  private fare(feeCents: number, commissionPct: number) { return Math.round(feeCents * (100 - commissionPct) / 100); }

  /** Offer an order to a rider (they have 75 seconds), or hand it to them outright with `force`. */
  async assign(orderId: string, input: z.infer<typeof AssignSchema>, actor: RiderActor) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      const o = (await c.query<{ status: string; order_no: number; delivery_fee_cents: number; cod: number | null; zone_commission: number | null; total_cents: number }>(
        `SELECT o.status, o.order_no, o.delivery_fee_cents, o.cod_due_cents AS cod, z.commission_pct AS zone_commission, o.total_cents FROM orders o LEFT JOIN zones z ON z.id = o.zone_id WHERE o.id = $1 FOR UPDATE OF o`, [orderId])).rows[0];
      if (!o) throw new NotFoundError('Order');
      if (o.status !== 'PAID') throw new UnprocessableError('NOT_DISPATCHABLE', o.status === 'CANCELLED' ? 'This order was cancelled' : o.status === 'FULFILLED' ? 'This order has already been delivered' : 'Only paid orders can be sent out');
      const rider = (await c.query<{ account_status: string; availability: string; name: string }>('SELECT account_status, availability, name FROM riders WHERE id = $1 FOR UPDATE', [input.riderId])).rows[0];
      if (!rider) throw new NotFoundError('Rider');
      if (rider.account_status !== 'approved') throw new UnprocessableError('RIDER_NOT_APPROVED', `${rider.name} isn’t an active rider`);
      if (rider.availability !== 'online' && !input.force) throw new UnprocessableError('RIDER_OFFLINE', `${rider.name} is offline. Send it anyway to assign it without waiting for them to accept.`);

      const live = (await c.query<{ id: string; status: string; rider_id: string }>(`SELECT id, status, rider_id FROM deliveries WHERE order_id = $1 AND status NOT IN ('delivered','failed','cancelled') FOR UPDATE`, [orderId])).rows[0];
      if (live) {
        if (['picked_up', 'at_dropoff'].includes(live.status)) throw new UnprocessableError('ALREADY_OUT', 'The rider already has this order on the road');
        if (live.rider_id === input.riderId) throw new ConflictError('ALREADY_ASSIGNED', 'This rider already has this order');
        await c.query(`UPDATE deliveries SET status = 'cancelled', version = version + 1 WHERE id = $1`, [live.id]);
        await c.query(`INSERT INTO delivery_attempts (delivery_id, rider_id, outcome, reason) VALUES ($1,$2,'withdrawn','Reassigned by dispatch')`, [live.id, live.rider_id]);
      }
      const fare = this.fare(o.delivery_fee_cents, o.zone_commission ?? 20);
      const direct = input.force;
      await c.query(
        `INSERT INTO deliveries (id, order_id, rider_id, status, offer_expires_at, pickup_location_id, fare_cents, cod_cents, handover_code, assigned_by, accepted_at)
         VALUES ($1,$2,$3,$4, CASE WHEN $4 = 'offered' THEN now() + make_interval(secs => $5) END, $6,$7,$8,$9,$10, CASE WHEN $4 = 'accepted' THEN now() END)`,
        [id, orderId, input.riderId, direct ? 'accepted' : 'offered', OFFER_SECONDS, await primaryLocation(c), fare, o.cod ?? 0, String(randomInt(1000, 10000)), actor.name]);
      await c.query(`INSERT INTO delivery_attempts (delivery_id, rider_id, outcome, reason) VALUES ($1,$2,$3,$4)`, [id, input.riderId, direct ? 'accepted' : 'offered', input.note]);
      await audit(c, actor, direct ? 'delivery.assign' : 'delivery.offer', 'order', orderId, { riderId: input.riderId, note: input.note });
      await outbox(c, 'order', orderId, direct ? 'DeliveryAssigned' : 'DeliveryOffered', { orderId, riderId: input.riderId, deliveryId: id });
    });
    return this.deliveryById(id);
  }

  async unassign(orderId: string, actor: RiderActor) {
    await this.db.tx(async (c) => {
      const d = (await c.query<{ id: string; status: string; rider_id: string }>(`SELECT id, status, rider_id FROM deliveries WHERE order_id = $1 AND status NOT IN ('delivered','failed','cancelled') FOR UPDATE`, [orderId])).rows[0];
      if (!d) throw new NotFoundError('Live delivery');
      if (['picked_up', 'at_dropoff'].includes(d.status)) throw new UnprocessableError('ALREADY_OUT', 'The rider already has this order on the road. Record a failed delivery instead.');
      await c.query(`UPDATE deliveries SET status = 'cancelled', version = version + 1 WHERE id = $1`, [d.id]);
      await c.query(`INSERT INTO delivery_attempts (delivery_id, rider_id, outcome, reason) VALUES ($1,$2,'withdrawn','Removed by dispatch')`, [d.id, d.rider_id]);
      await audit(c, actor, 'delivery.unassign', 'order', orderId, {});
    });
  }

  private async deliveryById(id: string) {
    const r = (await this.db.read((c) => c.query<DeliveryRow>(`${DELIVERY_SELECT} WHERE d.id = $1`, [id]))).rows[0];
    if (!r) throw new NotFoundError('Delivery');
    return deliveryView(r);
  }

  /** Every delivery attempt for an order, newest last: who was asked, who said yes. */
  async history(orderId: string) {
    return this.db.read(async (c) => ({
      deliveries: (await c.query<DeliveryRow & { failure_reason: string | null; failure_kind: string | null; delivered_at: Date | null }>(`${DELIVERY_SELECT.replace('d.assigned_by,', 'd.assigned_by, d.failure_reason, d.failure_kind, d.delivered_at,')} WHERE d.order_id = $1 ORDER BY d.created_at`, [orderId])).rows
        .map((d) => ({ ...deliveryView(d), failureKind: d.failure_kind, failureReason: d.failure_reason, deliveredAt: d.delivered_at?.toISOString() ?? null })),
      attempts: (await c.query<{ rider: string; outcome: string; reason: string; at: Date }>(
        `SELECT r.name AS rider, a.outcome, a.reason, a.at FROM delivery_attempts a JOIN deliveries d ON d.id = a.delivery_id JOIN riders r ON r.id = a.rider_id WHERE d.order_id = $1 ORDER BY a.id`, [orderId])).rows
        .map((a) => ({ rider: a.rider, outcome: a.outcome, reason: a.reason, at: a.at.toISOString() })),
    }));
  }

  // ---- rider: offers and the trip ------------------------------------------------------------------------------------------

  async offers(rider: RiderContext) {
    await this.expireOffers();
    return this.db.read(async (c) => ({ items: (await c.query<DeliveryRow>(`${DELIVERY_SELECT} WHERE d.rider_id = $1 AND d.status = 'offered' ORDER BY d.created_at`, [rider.id])).rows.map(deliveryView) }));
  }

  async accept(rider: RiderContext, deliveryId: string) {
    await this.db.tx(async (c) => {
      const d = (await c.query<{ status: string; rider_id: string; expired: boolean; order_id: string }>(`SELECT status, rider_id, (offer_expires_at < now()) AS expired, order_id FROM deliveries WHERE id = $1 FOR UPDATE`, [deliveryId])).rows[0];
      if (!d || d.rider_id !== rider.id) throw new NotFoundError('Offer');
      if (d.status === 'accepted') return;
      if (d.status !== 'offered' || d.expired) throw new UnprocessableError('OFFER_GONE', 'This request is no longer available');
      await c.query(`UPDATE deliveries SET status = 'accepted', accepted_at = now(), offer_expires_at = NULL, version = version + 1 WHERE id = $1`, [deliveryId]);
      await c.query(`INSERT INTO delivery_attempts (delivery_id, rider_id, outcome) VALUES ($1,$2,'accepted')`, [deliveryId, rider.id]);
    });
    return this.activeFor(rider);
  }

  async decline(rider: RiderContext, deliveryId: string, reason: string) {
    await this.db.tx(async (c) => {
      const d = (await c.query<{ status: string; rider_id: string }>('SELECT status, rider_id FROM deliveries WHERE id = $1 FOR UPDATE', [deliveryId])).rows[0];
      if (!d || d.rider_id !== rider.id) throw new NotFoundError('Offer');
      if (d.status !== 'offered') throw new UnprocessableError('OFFER_GONE', 'This request is no longer available');
      await c.query(`UPDATE deliveries SET status = 'cancelled', version = version + 1 WHERE id = $1`, [deliveryId]);
      await c.query(`INSERT INTO delivery_attempts (delivery_id, rider_id, outcome, reason) VALUES ($1,$2,'declined',$3)`, [deliveryId, rider.id, reason]);
    });
  }

  /** The delivery the rider is on right now (with the handover details they need), if any. */
  async activeFor(rider: RiderContext) {
    return this.db.read(async (c) => {
      const d = (await c.query<DeliveryRow & { handover_code: string; picked: string[] | null }>(`${DELIVERY_SELECT.replace('d.assigned_by,', 'd.assigned_by, d.handover_code,')} WHERE d.rider_id = $1 AND d.status IN ${LIVE} ORDER BY d.created_at LIMIT 1`, [rider.id])).rows[0];
      if (!d) return { active: null };
      // The handover code belongs to the customer; the rider only learns it by being told at the door.
      return { active: deliveryView(d) };
    });
  }

  private async mine(c: pg.PoolClient, rider: RiderContext, id: string) {
    const d = (await c.query<{ id: string; order_id: string; status: string; rider_id: string; handover_code: string; fare_cents: number; bonus_cents: number; tip_cents: number; cod_cents: number }>(
      'SELECT id, order_id, status, rider_id, handover_code, fare_cents, bonus_cents, tip_cents, cod_cents FROM deliveries WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!d || d.rider_id !== rider.id) throw new NotFoundError('Delivery');
    return d;
  }

  async stage(rider: RiderContext, id: string, stage: z.infer<typeof StageSchema>['stage']) {
    await this.db.tx(async (c) => {
      const d = await this.mine(c, rider, id);
      if (NEXT[d.status] !== stage) throw new UnprocessableError('WRONG_STAGE', 'That step isn’t next for this delivery');
      await c.query(`UPDATE deliveries SET status = $2, picked_up_at = CASE WHEN $2 = 'picked_up' THEN now() ELSE picked_up_at END, version = version + 1 WHERE id = $1`, [id, stage]);
    });
    return this.activeFor(rider);
  }

  /** Hand over the order: the customer’s code proves it, cash on delivery is counted, and the rider is credited. */
  async deliver(rider: RiderContext, id: string, input: z.infer<typeof DeliverSchema>) {
    await this.db.tx(async (c) => {
      const d = await this.mine(c, rider, id);
      if (d.status !== 'at_dropoff') throw new UnprocessableError('WRONG_STAGE', 'Confirm you’ve arrived before handing the order over');
      if (d.handover_code !== input.code) throw new UnprocessableError('WRONG_CODE', 'That code isn’t right. Ask the customer to check their app.');
      if (d.cod_cents > 0 && input.cashCents !== d.cod_cents) throw new UnprocessableError('CASH_MISMATCH', 'Enter the exact cash you collected', { expectedCents: d.cod_cents });
      const o = (await c.query<{ status: string; order_no: number }>('SELECT status, order_no FROM orders WHERE id = $1 FOR UPDATE', [d.order_id])).rows[0]!;
      if (o.status !== 'PAID') throw new UnprocessableError('ORDER_CLOSED', 'This order was cancelled');
      await c.query(`UPDATE deliveries SET status = 'delivered', delivered_at = now(), photo_ref = $2, version = version + 1 WHERE id = $1`, [id, input.photoRef ?? null]);
      await c.query(`UPDATE orders SET status = 'FULFILLED', fulfilled_at = now(), cod_collected_at = CASE WHEN cod_due_cents IS NOT NULL THEN now() END, version = version + 1, updated_at = now() WHERE id = $1`, [d.order_id]);
      for (const [kind, amount] of [['fare', d.fare_cents], ['bonus', d.bonus_cents], ['tip', d.tip_cents]] as const) {
        if (amount > 0) await c.query(`INSERT INTO rider_ledger (rider_id, kind, amount_cents, delivery_id, note) VALUES ($1,$2,$3,$4,$5)`, [rider.id, kind, amount, id, `SC-${o.order_no}`]);
      }
      if (d.cod_cents > 0) await c.query(`INSERT INTO rider_cash (rider_id, kind, amount_cents, delivery_id, ref) VALUES ($1,'collected',$2,$3,$4)`, [rider.id, d.cod_cents, id, `SC-${o.order_no}`]);
      await c.query('UPDATE riders SET deliveries_done = deliveries_done + 1 WHERE id = $1', [rider.id]);
      await outbox(c, 'order', d.order_id, 'OrderDelivered', { orderId: d.order_id, riderId: rider.id, deliveryId: id });
    });
    return { delivered: true };
  }

  async fail(rider: RiderContext, id: string, input: z.infer<typeof FailSchema>) {
    await this.db.tx(async (c) => {
      const d = await this.mine(c, rider, id);
      if (!['accepted', 'at_pickup', 'picked_up', 'at_dropoff'].includes(d.status)) throw new UnprocessableError('WRONG_STAGE', 'This delivery can’t be marked as failed now');
      await c.query(`UPDATE deliveries SET status = 'failed', failure_kind = 'Failed', failure_reason = $2, failed_at = now(), version = version + 1 WHERE id = $1`, [id, input.note ? `${input.reason}. ${input.note}` : input.reason]);
    });
  }

  async history_(rider: RiderContext) {
    return this.db.read(async (c) => ({ items: (await c.query<DeliveryRow & { delivered_at: Date | null; failed_at: Date | null; failure_reason: string | null }>(
      `${DELIVERY_SELECT.replace('d.assigned_by,', 'd.assigned_by, d.delivered_at, d.failed_at, d.failure_reason,')} WHERE d.rider_id = $1 AND d.status IN ('delivered','failed') ORDER BY COALESCE(d.delivered_at, d.failed_at) DESC LIMIT 100`, [rider.id])).rows
      .map((d) => ({ ...deliveryView(d), deliveredAt: d.delivered_at?.toISOString() ?? null, failedAt: d.failed_at?.toISOString() ?? null, failureReason: d.failure_reason })) }));
  }

  /** What a shopper sees about their own delivery: who is bringing it, and the code to read out at the door. */
  async forCustomer(userId: string, orderId: string) {
    return this.db.read(async (c) => {
      const o = (await c.query<{ user_id: string; status: string }>('SELECT user_id, status FROM orders WHERE id = $1', [orderId])).rows[0];
      if (!o || o.user_id !== userId) throw new NotFoundError('Order');
      const d = (await c.query<{ status: string; handover_code: string; rider: string | null; phone: string | null; vehicle: string | null; plate: string | null; delivered_at: Date | null }>(
        `SELECT d.status, d.handover_code, r.name AS rider, r.phone, r.vehicle, r.plate, d.delivered_at FROM deliveries d LEFT JOIN riders r ON r.id = d.rider_id
          WHERE d.order_id = $1 AND d.status NOT IN ('cancelled') ORDER BY d.created_at DESC LIMIT 1`, [orderId])).rows[0];
      if (!d) return { status: o.status === 'CANCELLED' ? 'cancelled' : 'preparing', rider: null, handoverCode: null };
      const onTheWay = ['accepted', 'at_pickup', 'picked_up', 'at_dropoff'].includes(d.status);
      return {
        status: d.status === 'offered' ? 'preparing' : d.status, deliveredAt: d.delivered_at?.toISOString() ?? null,
        rider: onTheWay || d.status === 'delivered' ? { name: d.rider, phone: d.phone, vehicle: d.vehicle, plate: d.plate } : null,
        // Only while the rider is on the road: the code proves the right person got the parcel.
        handoverCode: d.status === 'picked_up' || d.status === 'at_dropoff' ? d.handover_code : null,
      };
    });
  }

  // ---- exceptions: deliveries that failed or were cancelled in flight ------------------------------------------------------------

  async exceptions(q: z.infer<typeof ExceptionListSchema>) {
    const before = q.cursor ? decodeCursor(q.cursor, 1)[0]! : null;
    if (before !== null && !isUuid(before)) throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
    return this.db.read(async (c) => {
      const { rows } = await c.query<{ id: string; order_id: string; order_no: number; customer: string; rider: string | null; reason: string | null; kind: string | null; zone: string | null; at: Date; resolved: boolean; note: string; resolved_by: string | null }>(
        `SELECT d.id, d.order_id, o.order_no, COALESCE(NULLIF(o.delivery_name,''), NULLIF(cu.name,''), 'Customer') AS customer, r.name AS rider, d.failure_reason AS reason, d.failure_kind AS kind,
                COALESCE(z.name, o.delivery_area) AS zone, d.failed_at AS at, d.resolved, d.resolution_note AS note, d.resolved_by
           FROM deliveries d JOIN orders o ON o.id = d.order_id LEFT JOIN customers cu ON cu.id = o.user_id LEFT JOIN riders r ON r.id = d.rider_id LEFT JOIN zones z ON z.id = o.zone_id
          WHERE d.status = 'failed' AND d.resolved = ($1 = 'resolved') AND ($2::uuid IS NULL OR d.id < $2) ORDER BY d.id DESC LIMIT $3`, [q.state, before, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({ id: r.id, orderId: r.order_id, order: `SC-${r.order_no}`, customer: r.customer, rider: r.rider, reason: r.reason, kind: r.kind, zone: r.zone, at: r.at.toISOString(), resolved: r.resolved, note: r.note, resolvedBy: r.resolved_by })),
        nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1]!.id]) : null,
      };
    });
  }

  async resolve(id: string, note: string, actor: RiderActor) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query(`UPDATE deliveries SET resolved = true, resolution_note = $2, resolved_by = $3 WHERE id = $1 AND status = 'failed' AND NOT resolved`, [id, note, actor.name]);
      if (!rowCount) throw new NotFoundError('Open exception');
      await audit(c, actor, 'exception.resolve', 'delivery', id, { note });
    });
  }

  // ---- incidents and SOS ---------------------------------------------------------------------------------------------------------------

  async report(rider: RiderContext, input: z.infer<typeof IncidentSchema>) {
    const id = uuidv7();
    await this.db.tx(async (c) => {
      const live = (await c.query<{ id: string }>(`SELECT id FROM deliveries WHERE rider_id = $1 AND status IN ${LIVE} LIMIT 1`, [rider.id])).rows[0];
      const r = (await c.query<{ last_lat: number | null; last_lng: number | null }>('SELECT last_lat, last_lng FROM riders WHERE id = $1', [rider.id])).rows[0]!;
      const sev = input.sos || input.type === 'Medical assistance' || input.type === 'Theft or robbery' ? 'critical' : input.type === 'Road accident' || input.type === 'Vehicle issue' ? 'high' : 'medium';
      await c.query('INSERT INTO incidents (id, rider_id, type, severity, sos, lat, lng, delivery_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, rider.id, input.type, sev, input.sos, input.lat ?? r.last_lat, input.lng ?? r.last_lng, live?.id ?? null]);
      await c.query('INSERT INTO incident_log (incident_id, body, by_name) VALUES ($1,$2,$3)', [id, `${input.type} reported${input.note ? `: ${input.note}` : ''}`, input.sos ? 'Rider app (SOS)' : rider.name]);
      await outbox(c, 'incident', id, input.sos ? 'RiderSos' : 'IncidentReported', { incidentId: id, riderId: rider.id, type: input.type });
    });
    return { id };
  }

  async incidents(q: z.infer<typeof IncidentListSchema>) {
    return this.db.read(async (c) => ({ items: (await c.query<{ id: string; incident_no: number; rider_id: string; rider: string; type: string; severity: string; status: string; sos: boolean; lat: number | null; lng: number | null; zone: string | null; created_at: Date }>(
      `SELECT i.id, i.incident_no, i.rider_id, r.name AS rider, i.type, i.severity, i.status, i.sos, i.lat, i.lng, z.name AS zone, i.created_at FROM incidents i JOIN riders r ON r.id = i.rider_id LEFT JOIN zones z ON z.id = r.zone_id
        WHERE ($1::text IS NULL OR i.status = $1) ORDER BY (i.status = 'resolved'), CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, i.created_at DESC LIMIT $2`, [q.status ?? null, q.limit])).rows
      .map((i) => ({ id: i.id, number: `${i.sos ? 'SOS' : 'INC'}-${i.incident_no}`, riderId: i.rider_id, rider: i.rider, type: i.type, severity: i.severity, status: i.status, sos: i.sos, zone: i.zone, location: i.lat !== null && i.lng !== null ? { lat: i.lat, lng: i.lng } : null, at: i.created_at.toISOString() })) }));
  }

  async incident(id: string) {
    const all = await this.incidents({ limit: 200 });
    const i = all.items.find((x) => x.id === id);
    if (!i) throw new NotFoundError('Incident');
    const log = await this.db.read(async (c) => (await c.query<{ body: string; by_name: string; at: Date }>('SELECT body, by_name, at FROM incident_log WHERE incident_id = $1 ORDER BY id', [id])).rows);
    return { ...i, log: log.map((l) => ({ text: l.body, by: l.by_name, at: l.at.toISOString() })) };
  }

  async updateIncident(id: string, input: z.infer<typeof IncidentUpdateSchema>, actor: RiderActor) {
    await this.db.tx(async (c) => {
      const cur = (await c.query<{ status: string }>('SELECT status FROM incidents WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new NotFoundError('Incident');
      if (cur.status === 'resolved' && input.status) throw new ForbiddenError('This incident is already resolved');
      if (input.status) {
        await c.query(`UPDATE incidents SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN now() END WHERE id = $1`, [id, input.status]);
        await c.query('INSERT INTO incident_log (incident_id, body, by_name) VALUES ($1,$2,$3)', [id, input.status === 'resolved' ? 'Marked resolved' : 'Started investigating', actor.name]);
      }
      if (input.note) await c.query('INSERT INTO incident_log (incident_id, body, by_name) VALUES ($1,$2,$3)', [id, input.note, actor.name]);
      await audit(c, actor, 'incident.update', 'incident', id, input);
    });
    return this.incident(id);
  }
}
