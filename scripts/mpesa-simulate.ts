/**
 * DEVELOPMENT ONLY. Plays the part of Safaricom when MPESA_ENV=simulator: finds the latest M-Pesa prompt that is still waiting
 * and posts the result to the API, exactly as Safaricom would.
 *
 *   npm run mpesa:simulate                 pay the latest waiting prompt
 *   npm run mpesa:simulate -- SC-4812      pay the prompt for one order
 *   npm run mpesa:simulate -- latest fail  the customer cancelled / didn't pay
 *   npm run mpesa:simulate -- latest wrong the customer paid the wrong amount
 */
import pg from 'pg';

async function main() {
  const [target = 'latest', outcome = 'pay'] = process.argv.slice(2);
  const secret = process.env.MPESA_CALLBACK_SECRET;
  if (process.env.MPESA_ENV !== 'simulator' || !secret) throw new Error('Set MPESA_ENV=simulator and MPESA_CALLBACK_SECRET in .env first.');
  if (process.env.NODE_ENV === 'production') throw new Error('Not in production.');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const m = /^SC-(\d+)$/i.exec(target);
    const { rows } = await db.query<{ checkout_request_id: string; amount_cents: number; order_no: number }>(
      `SELECT r.checkout_request_id, r.amount_cents, o.order_no FROM mpesa_requests r JOIN orders o ON o.id = r.order_id
        WHERE r.status = 'pending' AND ($1::int IS NULL OR o.order_no = $1) ORDER BY r.created_at DESC LIMIT 1`, [m ? Number(m[1]) : null]);
    const r = rows[0];
    if (!r) throw new Error('No M-Pesa prompt is waiting. Place an order in the app and choose M-Pesa first.');
    const ok = outcome === 'pay' || outcome === 'wrong';
    const amount = outcome === 'wrong' ? 1 : Number(r.amount_cents) / 100;
    const body = {
      Body: { stkCallback: {
        MerchantRequestID: 'sim', CheckoutRequestID: r.checkout_request_id, ResultCode: ok ? 0 : 1032, ResultDesc: ok ? 'The service request is processed successfully.' : 'Request cancelled by user',
        ...(ok ? { CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: `SIM${Date.now().toString(36).toUpperCase()}` }, { Name: 'PhoneNumber', Value: 254700000000 }] } } : {}),
      } },
    };
    const res = await fetch(`http://localhost:${process.env.PORT ?? 8080}/v1/webhooks/mpesa/${secret}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    console.log(`SC-${r.order_no}: ${outcome} -> API answered ${res.status}`);
  } finally {
    await db.end();
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
