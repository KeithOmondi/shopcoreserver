/**
 * DEVELOPMENT ONLY. Adds the help-centre articles and canned replies from the admin designs.
 *
 *   npm run demo:support
 *
 * Safe to run twice: it does nothing if any article already exists.
 */
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/infra/logger.js';
import { Database } from '../src/infra/db.js';
import { SupportService } from '../src/modules/support/support.js';

const ARTICLES: [string, string, string][] = [
  ['Where is my order?', 'Delivery and tracking', 'Open Orders in the app and tap your order, then Track. You will see your rider on the map once they have picked it up, and the 4-digit code to read out at the door.'],
  ['What if I am not home when the rider arrives?', 'Delivery and tracking', 'Call or message your rider from the tracking screen. If we can’t reach you, the rider waits a few minutes and then the order is returned to us. Contact support to arrange another delivery.'],
  ['How do I pay with M-Pesa?', 'Payments', 'Choose M-Pesa at checkout, enter your number, and approve the prompt on your phone. Your order is confirmed as soon as the payment goes through.'],
  ['Can I pay cash on delivery?', 'Payments', 'Yes. Choose Cash on delivery at checkout and pay the rider the exact amount when your order arrives.'],
  ['How do I return an item?', 'Returns and refunds', 'You can return an item within 14 days of delivery. Open the order, tap Return an item, choose a reason and add photos if it arrived damaged. We will confirm by message.'],
  ['When will I get my refund?', 'Returns and refunds', 'Approved refunds go back to the way you paid. M-Pesa refunds usually arrive within a day; card refunds can take up to 7 working days.'],
  ['How do I change my phone number or address?', 'Account', 'Open Profile, then Details. Changes apply to your next order.'],
];
const CANNED: [string, string, string][] = [
  ['Delay apology', 'Delivery', 'Hi {{customer_name}}, sorry about the wait with order {{order_id}}. Your rider is on the way and I am keeping an eye on it. — {{agent_name}}'],
  ['Refund received', 'Refunds', 'Hi {{customer_name}}, we have approved your refund for order {{order_id}}. It should reach you within a day. — {{agent_name}}'],
  ['Wrong item', 'Order issue', 'Hi {{customer_name}}, I am sorry we sent the wrong item. Could you send a photo? I will arrange a replacement for {{order_id}} right away. — {{agent_name}}'],
  ['Rider support', 'Rider support', 'Hi, thanks for getting in touch. I have noted the issue and will update you shortly. — {{agent_name}}'],
];

async function main() {
  const cfg = loadConfig({ ...process.env, JWT_ISSUER: process.env.JWT_ISSUER ?? 'x', JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'x', JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY ?? 'x' }, 'worker');
  if (cfg.NODE_ENV === 'production') throw new Error('Demo content can’t be created in production');
  const db = new Database(cfg, createLogger({ level: 'warn', service: 'demo-support' }));
  const actor = { id: 'system', name: 'Demo seed', requestId: 'demo-support' };
  const support = new SupportService(db);
  try {
    if ((await support.articles(false)).length) { console.log('Articles already exist; nothing to do.'); return; }
    for (const [title, category, body] of ARTICLES) await support.saveArticle(null, { title, category, body, live: true }, actor);
    for (const [title, category, text] of CANNED) await support.saveCanned(null, { title, category, text, live: true }, actor);
    console.log(`Added ${ARTICLES.length} articles and ${CANNED.length} canned replies.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
