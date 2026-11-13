import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../infra/db.js';
import type { Logger } from 'pino';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { uuidv7 } from '../../infra/uuid.js';
import { audit } from '../products/products.js';
import type { OrderService } from '../orders/orders.js';
import type { PaymentsService } from '../finance/payments.js';
import { normalisePhone } from '../dispatch/riders.js';

export const PayBodySchema = z.strictObject({ phone: z.string().trim().min(9).max(20) });

export interface StkRequest { phone: string; amountKes: number; accountRef: string; description: string; callbackUrl: string }
export interface StkAck { checkoutRequestId: string; merchantRequestId: string }
/** The part of Daraja we use. Swapped for a stand-in in tests and in the local simulator. */
export interface MpesaClient { stkPush(r: StkRequest): Promise<StkAck> }

/** Safaricom Daraja over HTTPS. Sandbox and production differ only in the host. */
export class DarajaClient implements MpesaClient {
  private token: { value: string; expires: number } | null = null;
  constructor(private readonly cfg: Config, private readonly fetchFn: typeof fetch = fetch) {}
  private get base() { return this.cfg.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke'; }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.MPESA_CONSUMER_KEY}:${this.cfg.MPESA_CONSUMER_SECRET}`).toString('base64');
    const res = await this.fetchFn(`${this.base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new UnprocessableError('MPESA_UNAVAILABLE', 'M-Pesa is not reachable right now. Try again in a moment');
    const j = (await res.json()) as { access_token: string; expires_in: string };
    this.token = { value: j.access_token, expires: Date.now() + Number(j.expires_in) * 1000 };
    return j.access_token;
  }

  async stkPush(r: StkRequest): Promise<StkAck> {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const shortcode = this.cfg.MPESA_SHORTCODE!;
    const res = await this.fetchFn(`${this.base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        BusinessShortCode: shortcode, Password: Buffer.from(`${shortcode}${this.cfg.MPESA_PASSKEY}${ts}`).toString('base64'), Timestamp: ts, TransactionType: 'CustomerPayBillOnline',
        Amount: r.amountKes, PartyA: r.phone, PartyB: shortcode, PhoneNumber: r.phone, CallBackURL: r.callbackUrl, AccountReference: r.accountRef.slice(0, 12), TransactionDesc: r.description.slice(0, 13),
      }),
    });
    const j = (await res.json().catch(() => ({}))) as { ResponseCode?: string; CheckoutRequestID?: string; MerchantRequestID?: string; errorMessage?: string; ResponseDescription?: string };
    if (!res.ok || j.ResponseCode !== '0' || !j.CheckoutRequestID) throw new UnprocessableError('MPESA_REFUSED', j.errorMessage ?? j.ResponseDescription ?? 'M-Pesa didn’t accept the request');
    return { checkoutRequestId: j.CheckoutRequestID, merchantRequestId: j.MerchantRequestID ?? '' };
  }
}

/** Development only: no network. The "prompt" is acknowledged and the test (or you) posts the callback by hand. */
export class SimulatedMpesa implements MpesaClient {
  async stkPush(): Promise<StkAck> {
    const id = `ws_CO_SIM_${uuidv7().replace(/-/g, '').slice(-18)}`;
    return { checkoutRequestId: id, merchantRequestId: `SIM-${id.slice(-8)}` };
  }
}

export function makeMpesaClient(cfg: Config): MpesaClient | null {
  if (cfg.MPESA_ENV === 'simulator') return new SimulatedMpesa();
  if (cfg.MPESA_ENV === 'sandbox' || cfg.MPESA_ENV === 'production') return new DarajaClient(cfg);
  return null;
}

/** What Safaricom posts to the callback address. */
const CallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string().optional(),
      CheckoutRequestID: z.string().min(5).max(100),
      ResultCode: z.coerce.number().int(),
      ResultDesc: z.string().max(300).default(''),
      CallbackMetadata: z.object({ Item: z.array(z.object({ Name: z.string(), Value: z.union([z.string(), z.number()]).optional() })) }).optional(),
    }),
  }),
});

/** How a Daraja result code reads in the failed-payments list (the first three are the ones worth retrying). */
const REASONS: Record<number, string> = { 1037: 'Timeout at gateway', 2001: 'Authentication failed', 1: 'Insufficient funds', 1032: 'Cancelled by customer', 1019: 'Timeout at gateway', 1025: 'Network error', 9999: 'Network error' };

export class MpesaService {
  constructor(
    private readonly db: Database,
    private readonly cfg: Config,
    private readonly client: MpesaClient | null,
    private readonly orders: OrderService,
    private readonly payments: PaymentsService,
    private readonly log: Logger,
  ) {}

  get enabled() { return this.client !== null; }

  /** Sends the pay prompt to the customer's phone for one of their unpaid orders. */
  async initiate(userId: string, orderId: string, input: z.infer<typeof PayBodySchema>) {
    if (!this.client) throw new UnprocessableError('MPESA_NOT_CONFIGURED', 'M-Pesa payments aren’t switched on yet');
    const phone = normalisePhone(input.phone);
    if (!phone) throw new UnprocessableError('BAD_PHONE', 'Enter a Safaricom number like 0712 345 678');
    const o = (await this.db.read((c) => c.query<{ user_id: string; status: string; total_cents: number; order_no: number; payment_method: string | null }>('SELECT user_id, status, total_cents, order_no, payment_method FROM orders WHERE id = $1', [orderId]))).rows[0];
    if (!o || o.user_id !== userId) throw new NotFoundError('Order');
    if (o.status !== 'PENDING_PAYMENT') throw new ConflictError('NOT_PAYABLE', o.status === 'PAID' || o.status === 'FULFILLED' ? 'This order is already paid' : 'This order can’t be paid any more');
    if (o.payment_method === 'cod') throw new ConflictError('PAY_ON_DELIVERY', 'This order is pay on delivery');
    const total = Number(o.total_cents);
    if (total % 100 !== 0) throw new UnprocessableError('AMOUNT_NOT_WHOLE_SHILLINGS', 'M-Pesa takes whole shillings, and this order has cents in its total');
    const recent = (await this.db.read((c) => c.query('SELECT 1 FROM mpesa_requests WHERE order_id = $1 AND status = \'pending\' AND created_at > now() - interval \'90 seconds\'', [orderId]))).rowCount;
    if (recent) throw new ConflictError('PROMPT_PENDING', 'A prompt was just sent to your phone. Check it before trying again');

    const base = (this.cfg.MPESA_CALLBACK_BASE_URL ?? 'http://localhost').replace(/\/$/, '');
    const ack = await this.client.stkPush({ phone: phone.slice(1), amountKes: total / 100, accountRef: `SC-${o.order_no}`, description: 'ShopCore', callbackUrl: `${base}/v1/webhooks/mpesa/${this.cfg.MPESA_CALLBACK_SECRET}` });
    const id = uuidv7();
    await this.db.tx(async (c) => {
      await c.query('INSERT INTO mpesa_requests (id, order_id, customer_id, phone, amount_cents, checkout_request_id, merchant_request_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, orderId, userId, phone, total, ack.checkoutRequestId, ack.merchantRequestId]);
    });
    return { requestId: id, checkoutRequestId: ack.checkoutRequestId, message: 'Check your phone and enter your M-Pesa PIN to pay.' };
  }

  /** What the app polls while the customer is at their phone. */
  async status(userId: string, orderId: string) {
    return this.db.read(async (c) => {
      const r = (await c.query<{ status: string; result_desc: string | null; receipt: string | null }>('SELECT status, result_desc, receipt FROM mpesa_requests WHERE order_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 1', [orderId, userId])).rows[0];
      if (!r) throw new NotFoundError('Payment request');
      return { status: r.status, message: r.status === 'failed' || r.status === 'cancelled' ? r.result_desc : null, receipt: r.receipt };
    });
  }

  private secretOk(given: string) {
    const want = Buffer.from(this.cfg.MPESA_CALLBACK_SECRET ?? '');
    const got = Buffer.from(given);
    return want.length > 0 && want.length === got.length && timingSafeEqual(want, got);
  }

  /**
   * Safaricom's result. Always answers "accepted" once the secret is right, so Safaricom doesn't keep retrying; anything odd is logged
   * and audited instead. A result is applied once: the same CheckoutRequestID arriving again changes nothing.
   */
  async callback(secret: string, raw: unknown) {
    if (!this.secretOk(secret)) throw new ForbiddenError('Not allowed');
    const parsed = CallbackSchema.safeParse(raw);
    if (!parsed.success) { this.log.warn({ issues: parsed.error.issues.length }, 'unreadable M-Pesa callback'); return { ResultCode: 0, ResultDesc: 'Accepted' }; }
    const cb = parsed.data.Body.stkCallback;
    const actor = { id: 'system:mpesa', requestId: `mpesa:${cb.CheckoutRequestID}`, name: 'M-Pesa' };
    const req = await this.db.tx(async (c) => {
      const r = (await c.query<{ id: string; order_id: string; amount_cents: number; status: string }>('SELECT id, order_id, amount_cents, status FROM mpesa_requests WHERE checkout_request_id = $1 FOR UPDATE', [cb.CheckoutRequestID])).rows[0];
      if (!r) { this.log.warn({ checkout: cb.CheckoutRequestID }, 'M-Pesa callback for an unknown request'); return null; }
      if (r.status !== 'pending') return null; // already applied
      return r;
    });
    if (!req) return { ResultCode: 0, ResultDesc: 'Accepted' };

    const item = (name: string) => cb.CallbackMetadata?.Item.find((i) => i.Name === name)?.Value;
    if (cb.ResultCode === 0) {
      const paidKes = Number(item('Amount'));
      const receipt = String(item('MpesaReceiptNumber') ?? '');
      if (!receipt || paidKes * 100 !== Number(req.amount_cents)) {
        await this.finish(req.id, 'failed', cb.ResultCode, 'The amount paid didn’t match the order', receipt || null);
        await this.db.tx((c) => audit(c, actor, 'mpesa.mismatch', 'order', req.order_id, { expectedCents: Number(req.amount_cents), paidKes, receipt }));
        this.log.error({ order: req.order_id, receipt }, 'M-Pesa amount mismatch: money was taken but the order was not marked paid');
        return { ResultCode: 0, ResultDesc: 'Accepted' };
      }
      const cur = (await this.db.read((c) => c.query<{ currency: string }>('SELECT currency FROM orders WHERE id = $1', [req.order_id]))).rows[0]!.currency;
      try {
        await this.orders.markPaid(req.order_id, actor, { paymentRef: receipt, amountCents: Number(req.amount_cents), currency: cur });
        await this.finish(req.id, 'success', 0, cb.ResultDesc, receipt);
      } catch (e) {
        // The order is gone (cancelled or expired): markPaid has already queued a refund event for the payment service.
        await this.finish(req.id, 'failed', 0, 'The order was no longer open when the payment arrived', receipt);
        this.log.error({ err: e, order: req.order_id, receipt }, 'M-Pesa payment could not be applied to its order');
      }
    } else {
      const reason = REASONS[cb.ResultCode] ?? (cb.ResultDesc.slice(0, 120) || 'Payment failed');
      await this.finish(req.id, cb.ResultCode === 1032 ? 'cancelled' : 'failed', cb.ResultCode, reason, null);
      await this.payments.recordFailure(req.order_id, { method: 'mpesa', reason, ref: cb.CheckoutRequestID }, actor).catch((e) => this.log.error({ err: e }, 'could not record the failed M-Pesa payment'));
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  private async finish(id: string, status: 'success' | 'failed' | 'cancelled', code: number, desc: string, receipt: string | null) {
    await this.db.tx((c) => c.query(`UPDATE mpesa_requests SET status = $2, result_code = $3, result_desc = $4, receipt = $5, updated_at = now() WHERE id = $1`, [id, status, code, desc, receipt]));
  }
}
