/**
 * DEVELOPMENT ONLY. Adds sample segments, coupons, banners, homepage sections, pages and a draft push so the marketing screens have something to show.
 *
 *   npm run demo:marketing
 *
 * Safe to run twice: it does nothing if any coupon already exists.
 */
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/infra/logger.js';
import { Database } from '../src/infra/db.js';
import { AudienceService } from '../src/modules/marketing/audience.js';
import { PromotionsService } from '../src/modules/marketing/promotions.js';
import { EngageService } from '../src/modules/marketing/engage.js';
import { ContentService } from '../src/modules/marketing/content.js';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

async function main() {
  const cfg = loadConfig({ ...process.env, JWT_ISSUER: process.env.JWT_ISSUER ?? 'x', JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'x', JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY ?? 'x' }, 'worker');
  if (cfg.NODE_ENV === 'production') throw new Error('Demo content can’t be created in production');
  const db = new Database(cfg, createLogger({ level: 'warn', service: 'demo-marketing' }));
  const actor = { id: 'system', name: 'Demo seed', requestId: 'demo-marketing' };
  const audience = new AudienceService(db);
  const promotions = new PromotionsService(db);
  const engage = new EngageService(db);
  const content = new ContentService(db);
  try {
    if ((await promotions.coupons({ limit: 1 })).items.length) { console.log('Coupons already exist; nothing to do.'); return; }

    const newbies = await audience.save(null, { name: 'New customers', description: 'Three orders or fewer.', rules: [{ field: 'orders', op: 'at most', value: '3' }] }, actor);
    await audience.save(null, { name: 'High-value regulars', description: 'Recent, higher-spend customers.', rules: [{ field: 'spend', op: 'greater than', value: '20000' }, { field: 'lastOrder', op: 'within last (days)', value: '30' }] }, actor);
    await audience.save(null, { name: 'Lapsed customers', description: 'Used to order, quiet for two weeks.', rules: [{ field: 'orders', op: 'at least', value: '4' }, { field: 'lastOrder', op: 'more than (days) ago', value: '14' }] }, actor);

    const c = (name: string, code: string, extra: Record<string, unknown>) => promotions.saveCoupon(null, { name, code, type: 'percent', value: 10, limit: 1000, startsAt: iso(-20 * DAY), endsAt: iso(30 * DAY), state: 'live', ...extra } as never, actor);
    await c('Fresh start offer', 'FRESH10', { minSpendCents: 1_000_00, limit: 5000 });
    await c('Nairobi 500 off', 'NAIROBI500', { type: 'fixed', value: 500_00, minSpendCents: 2_500_00, limit: 2000 });
    await c('Welcome offer', 'WELCOME15', { value: 15, maxDiscountCents: 750_00, minSpendCents: 1_000_00, audience: 'new', limit: 3000 });
    await c('Free delivery weekend', 'FREESHIP', { type: 'free_delivery', value: 0, minSpendCents: 1_500_00, startsAt: iso(-40 * DAY), endsAt: iso(-3 * DAY) });
    await c('Payday treat', 'PAYDAY200', { type: 'fixed', value: 200_00, minSpendCents: 1_200_00, state: 'paused' });
    await c('Bundle week', 'BUNDLE20', { value: 20, minSpendCents: 2_000_00, startsAt: iso(5 * DAY), endsAt: iso(12 * DAY), limit: 1000, state: 'draft' });

    const banner = (title: string, link: string, tone: number, alt: string, extra: Record<string, unknown> = {}) =>
      engage.saveBanner(null, { title, link, tone, alt, startsAt: iso(-4 * DAY), endsAt: iso(20 * DAY), published: true, ...extra } as never, actor);
    await banner('New arrivals this week', '/collections/new', 0, 'Models wearing this week’s new arrivals', { label: 'New arrivals' });
    await banner('Join ShopCore Rewards', '/loyalty', 2, 'ShopCore Rewards member card', { label: 'Member perks', platform: 'Mobile only' });
    await banner('Summer sale preview', '/collections/sale', 3, '', { label: 'Summer sale', published: false, startsAt: iso(6 * DAY), endsAt: iso(30 * DAY) });

    for (const [name, sub, count, enabled] of [['Hero banners', 'Carousel', 4, true], ['Shop by category', 'Category tiles', 8, true], ['Featured this week', 'Product grid', 8, true], ['New arrivals', 'Product carousel', 12, true], ['Member benefits', 'Loyalty callout', 1, false]] as const) {
      await engage.addSection({ name, sub, count, enabled }, actor);
    }
    await engage.publishLayout({ mode: 'now' }, actor);

    await engage.savePush(null, { title: 'New arrivals just landed', body: 'Fresh styles picked for you. Delivery in as little as 45 minutes.', segmentId: newbies.id, deepLink: 'shopcore://collection/new', action: 'draft' }, actor);

    const pages: [string, string, string][] = [
      ['About ShopCore', '/about', 'ShopCore brings Nairobi’s best fashion and home labels to your door, fast.\n\nWe work with partner stores and deliver with our own riders.'],
      ['Terms of service', '/terms', 'These terms explain how ShopCore provides online shopping and delivery services. By placing an order, you agree to the conditions described here.'],
      ['Privacy policy', '/privacy', 'We collect only what we need to deliver your order and improve ShopCore. You can ask us to export or delete your data at any time.'],
      ['Delivery and returns', '/delivery-returns', 'We deliver every day from 7:00 AM to 10:00 PM. Report a problem in the app within 48 hours of delivery.'],
    ];
    for (const [title, slug, body] of pages) await content.savePage(null, { title, slug, body, status: 'published' }, actor);
    console.log('Added 3 segments, 6 coupons, 3 banners, 5 homepage sections, 1 draft push and 4 pages.');
  } finally {
    await db.close();
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
