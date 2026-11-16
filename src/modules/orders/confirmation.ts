import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import type { EmailSender } from '../integrations/email.js';

const kes = (cents: number) => `KES ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

interface Row {
  id: string; order_no: number; total_cents: number; payment_method: string | null; paid: boolean; delivery_area: string | null; delivery_address: string | null;
  email: string; customer_name: string | null;
}

/**
 * Emails a receipt for each order that is placed and paid (or cash on delivery) and not emailed yet. Shoppers with no
 * email on file are skipped (and stamped so they are not looked at again). A failed send is left for the next round.
 */
export class OrderConfirmationMailer {
  constructor(private readonly db: Database, private readonly email: EmailSender, private readonly log: Logger) {}

  async runDue(limit = 20): Promise<number> {
    const { rows } = await this.db.writer.query<Row>(
      `SELECT o.id, o.order_no, o.total_cents, o.payment_method, (o.paid_at IS NOT NULL) AS paid, o.delivery_area, o.delivery_address,
              COALESCE(cu.email, '') AS email, COALESCE(NULLIF(o.delivery_name, ''), NULLIF(cu.name, '')) AS customer_name
         FROM orders o LEFT JOIN customers cu ON cu.id = o.user_id
        WHERE o.confirmation_emailed_at IS NULL AND o.status <> 'CANCELLED' AND (o.paid_at IS NOT NULL OR o.payment_method = 'cod')
        ORDER BY o.created_at LIMIT $1`, [limit]);
    let sent = 0;
    for (const r of rows) {
      if (r.email) {
        const items = (await this.db.writer.query<{ name: string; quantity: number; unit_price_cents: number }>(
          'SELECT name, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY name', [r.id])).rows;
        const lines = items.map((i) => `  ${i.quantity} x ${i.name}  ${kes(i.quantity * i.unit_price_cents)}`).join('\n');
        const how = r.payment_method === 'cod' ? 'You pay the rider in cash when it arrives.' : r.paid ? 'We have received your payment.' : '';
        const where = [r.delivery_address, r.delivery_area].filter(Boolean).join(', ');
        const text = [`Hi ${r.customer_name ?? 'there'},`, '', `Thank you for your order SC-${r.order_no}.`, '', lines, '', `Total: ${kes(r.total_cents)}`, how, where ? `Delivering to: ${where}` : '', '',
          'We will let you know in the app as soon as a rider is on the way.', '', 'ShopCore'].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
        try {
          await this.email.send({ to: r.email, name: r.customer_name ?? undefined, subject: `Your ShopCore order SC-${r.order_no}`, text });
          sent++;
        } catch (e) {
          this.log.warn({ err: (e as Error).message, order: r.order_no }, 'order confirmation email failed, will retry');
          continue;
        }
      }
      await this.db.writer.query('UPDATE orders SET confirmation_emailed_at = now() WHERE id = $1', [r.id]);
    }
    return sent;
  }
}
