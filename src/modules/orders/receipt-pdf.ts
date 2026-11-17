import { createHmac, timingSafeEqual } from 'node:crypto';

import PDFDocument from 'pdfkit';

import type { Order } from './orders.js';

const kes = (cents: number) => `KES ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const METHOD: Record<string, string> = { mpesa: 'M-Pesa', card: 'Card', cod: 'Cash on delivery' };

/** A short-lived link token for one order, so the phone can hand the PDF to its browser or PDF viewer without sending headers. */
export function signReceiptToken(secret: string, orderId: string, ttlMs = 10 * 60_000): string {
  const exp = Date.now() + ttlMs;
  const body = `${orderId}.${exp}`;
  return `${exp}.${createHmac('sha256', secret).update(`receipt:${body}`).digest('base64url')}`;
}

export function receiptTokenOk(secret: string, orderId: string, token: string): boolean {
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = createHmac('sha256', secret).update(`receipt:${orderId}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The official receipt as a one-page PDF. */
export function renderReceipt(o: Order, shop = 'ShopCore'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Receipt ${o.orderNumber}`, Author: shop } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50;
    const right = doc.page.width - 50;
    const paid = !!o.paidAt;
    const line = (y: number) => doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor('#cccccc').stroke();
    const pair = (label: string, value: string, y: number, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor('#111111');
      doc.text(label, left, y, { width: 300 });
      doc.text(value, left + 300, y, { width: right - left - 300, align: 'right' });
    };

    doc.font('Helvetica-Bold').fontSize(22).fillColor('#111111').text(shop, left, 50);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(paid ? '#1a7f37' : '#b45309').text(paid ? 'PAID' : 'PAY ON DELIVERY', left, 56, { width: right - left, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#666666').text('OFFICIAL RECEIPT', left, 82);
    line(104);

    let y = 118;
    for (const [k, v] of [
      ['Receipt no.', o.orderNumber],
      ['Date', new Date(o.createdAt).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' })],
      ['Payment', o.paymentMethod ? METHOD[o.paymentMethod] ?? o.paymentMethod : '—'],
      ...(o.delivery ? [['Customer', o.delivery.name], ['Delivered to', [o.delivery.address, o.delivery.area].filter(Boolean).join(', ')]] : []),
    ] as [string, string][]) {
      pair(k, v, y);
      y += 16;
    }
    y += 6;
    line(y);
    y += 12;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666666');
    doc.text('ITEM', left, y, { width: 280 });
    doc.text('QTY', left + 290, y, { width: 40, align: 'right' });
    doc.text('AMOUNT', left + 340, y, { width: right - left - 340, align: 'right' });
    y += 16;
    for (const it of o.items) {
      if (y > doc.page.height - 200) { doc.addPage(); y = 50; }
      doc.font('Helvetica').fontSize(10).fillColor('#111111');
      const h = doc.heightOfString(it.name, { width: 280 });
      doc.text(it.name, left, y, { width: 280 });
      doc.text(String(it.quantity), left + 290, y, { width: 40, align: 'right' });
      doc.text(kes(it.quantity * it.unitPriceCents), left + 340, y, { width: right - left - 340, align: 'right' });
      y += Math.max(h, 12) + 6;
    }
    line(y);
    y += 12;
    pair('Subtotal', kes(o.subtotalCents), y); y += 16;
    if (o.discountCents > 0) { pair('Discount', `- ${kes(o.discountCents)}`, y); y += 16; }
    pair('Delivery', o.deliveryFeeCents ? kes(o.deliveryFeeCents) : 'Free', y); y += 16;
    pair('Tax', 'Included', y); y += 20;
    line(y - 4);
    pair(paid ? 'Total paid' : 'Total due', kes(o.totalCents), y, true);
    doc.font('Helvetica').fontSize(9).fillColor('#888888').text('Thank you for shopping with us.', left, y + 50, { width: right - left, align: 'center' });
    doc.end();
  });
}
