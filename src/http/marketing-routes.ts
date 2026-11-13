import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AudienceService, PreferencesSchema, PreviewSchema, SegmentPatchSchema, SegmentSchema } from '../modules/marketing/audience.js';
import { CategoryContentPatchSchema, ContentService, PagePatchSchema, PageSchema, StorefrontService } from '../modules/marketing/content.js';
import {
  BannerPatchSchema, BannerSchema, BannerSettingsSchema, CampaignPatchSchema, CampaignSchema, ChannelResultSchema, EngageService, HighlightPatchSchema, LoyaltySchema, MessagePatchSchema, MessageSchema, MoveSchema,
  PublishLayoutSchema, PushPatchSchema, PushSchema, ReferralSchema, ResultsSchema, SectionPatchSchema, SectionSchema,
} from '../modules/marketing/engage.js';
import { BundlePatchSchema, BundleSchema, CouponListSchema, CouponPatchSchema, CouponSchema, CouponStateSchema, FlashPatchSchema, FlashSchema, PromotionsService, QuoteSchema, RulesSchema } from '../modules/marketing/promotions.js';
import type { Actor } from '../modules/products/products.js';
import { requireRole } from './auth.js';
import { makeGuard } from './guard.js';
import type { Authz } from './staff-routes.js';
import { IdParam, parse } from './validate.js';

export interface MarketingServices { audience: AudienceService; promotions: PromotionsService; engage: EngageService; content: ContentService; storefront: StorefrontService }

const StateBody = z.strictObject({ state: z.enum(['draft', 'live']) });
const ReviewParam = z.object({ reviewId: z.string().uuid() });
const SectionParam = z.object({ id: z.string().uuid() });
const KindParam = z.object({ kind: z.enum(['push', 'message']), id: z.string().uuid() });
const SlugQuery = z.object({ slug: z.string().trim().min(1).max(200) });
const HandleParam = z.object({ handle: z.string().regex(/^[a-z0-9-]{1,60}$/) });
const PlatformQuery = z.object({ platform: z.enum(['web', 'mobile']).default('web') });

/** Marketing (campaigns, coupons, content), plus what the shop and app read from it. */
export function registerMarketingRoutes(app: FastifyInstance, svc: MarketingServices, authz: Authz) {
  const { audience, promotions, engage, content, storefront } = svc;
  const { guard, NoStore } = makeGuard(authz);
  const M = (a: 'View' | 'Create' | 'Edit' | 'Delete') => [['Marketing', a]] as [import('../modules/staff/permissions.js').Module, import('../modules/staff/permissions.js').Action][];
  const named = (a: Actor): Actor => ({ ...a, name: a.name ?? 'Staff' });

  // ============ audiences and rules ===================================================================================
  app.get('/v1/admin/marketing/rules', (req) => guard(req, M('View'), () => promotions.rules()));
  app.put('/v1/admin/marketing/rules', (req) => guard(req, M('Edit'), (a) => promotions.saveRules(parse(RulesSchema, req.body), named(a))));
  app.get('/v1/admin/segments', (req, reply) => guard(req, M('View'), async () => { NoStore(reply); return audience.list(); }));
  app.post('/v1/admin/segments/preview', (req) => guard(req, M('View'), () => audience.preview(parse(PreviewSchema, req.body))));
  app.get('/v1/admin/segments/:id', (req) => guard(req, M('View'), () => audience.get(parse(IdParam, req.params).id)));
  app.post('/v1/admin/segments', (req, reply) => guard(req, M('Create'), async (a) => reply.status(201).send(await audience.save(null, parse(SegmentSchema, req.body), named(a)))));
  app.patch('/v1/admin/segments/:id', (req) => guard(req, M('Edit'), (a) => audience.save(parse(IdParam, req.params).id, parse(SegmentPatchSchema, req.body), named(a))));
  app.delete('/v1/admin/segments/:id', (req, reply) => guard(req, M('Delete'), async (a) => { await audience.remove(parse(IdParam, req.params).id, named(a)); return reply.status(204).send(); }));

  // ============ coupons, flash sales, bundles ==========================================================================
  app.get('/v1/admin/coupons', (req, reply) => guard(req, M('View'), async () => { NoStore(reply); return promotions.coupons(parse(CouponListSchema, req.query)); }));
  app.get('/v1/admin/coupons/:id', (req) => guard(req, M('View'), () => promotions.coupon(parse(IdParam, req.params).id)));
  app.post('/v1/admin/coupons', (req, reply) => guard(req, M('Create'), async (a) => reply.status(201).send(await promotions.saveCoupon(null, parse(CouponSchema, req.body), named(a)))));
  app.post('/v1/admin/coupons/state', (req) => guard(req, M('Edit'), (a) => promotions.setCouponState(parse(CouponStateSchema, req.body), named(a))));
  app.patch('/v1/admin/coupons/:id', (req) => guard(req, M('Edit'), (a) => promotions.saveCoupon(parse(IdParam, req.params).id, parse(CouponPatchSchema, req.body), named(a))));
  app.delete('/v1/admin/coupons/:id', (req, reply) => guard(req, M('Delete'), async (a) => { await promotions.deleteCoupon(parse(IdParam, req.params).id, named(a)); return reply.status(204).send(); }));

  app.get('/v1/admin/flash-sales', (req, reply) => guard(req, M('View'), async () => { NoStore(reply); return promotions.flashSales(); }));
  app.get('/v1/admin/flash-sales/:id', (req) => guard(req, M('View'), () => promotions.flashSale(parse(IdParam, req.params).id)));
  app.post('/v1/admin/flash-sales', (req, reply) => guard(req, M('Create'), async (a) => reply.status(201).send(await promotions.saveFlash(null, parse(FlashSchema, req.body), named(a)))));
  app.patch('/v1/admin/flash-sales/:id', (req) => guard(req, M('Edit'), (a) => promotions.saveFlash(parse(IdParam, req.params).id, parse(FlashPatchSchema, req.body), named(a))));

  app.get('/v1/admin/bundles', (req, reply) => guard(req, M('View'), async () => { NoStore(reply); return promotions.bundles(); }));
  app.get('/v1/admin/bundles/:id', (req) => guard(req, M('View'), () => promotions.bundle(parse(IdParam, req.params).id)));
  app.post('/v1/admin/bundles', (req, reply) => guard(req, M('Create'), async (a) => reply.status(201).send(await promotions.saveBundle(null, parse(BundleSchema, req.body), named(a)))));
  app.patch('/v1/admin/bundles/:id', (req) => guard(req, M('Edit'), (a) => promotions.saveBundle(parse(IdParam, req.params).id, parse(BundlePatchSchema, req.body), named(a))));
  app.post('/v1/admin/bundles/:id/state', (req) => guard(req, M('Edit'), (a) => promotions.setBundleState(parse(IdParam, req.params).id, parse(StateBody, req.body).state, named(a))));

  // ============ banners and the homepage ================================================================================
  app.get('/v1/admin/banners', (req, reply) => guard(req, M('View'), async () => { NoStore(reply); return engage.banners(); }));
  app.post('/v1/admin/banners', (req, reply) => guard(req, M('Create'), async (a) => reply.status(201).send(await engage.saveBanner(null, parse(BannerSchema, req.body), named(a)))));
  app.patch('/v1/admin/banners/:id', (req) => guard(req, M('Edit'), (a) => engage.saveBanner(parse(IdParam, req.params).id, parse(BannerPatchSchema, req.body), named(a))));
  app.post('/v1/admin/banners/:id/move', (req) => guard(req, M('Edit'), (a) => engage.moveBanner(parse(IdParam, req.params).id, parse(MoveSchema, req.body).dir, named(a))));
  app.delete('/v1/admin/banners/:id', (req, reply) => guard(req, M('Delete'), async (a) => { await engage.deleteBanner(parse(IdParam, req.params).id, named(a)); return reply.status(204).send(); }));
  app.put('/v1/admin/banner-settings', (req) => guard(req, M('Edit'), (a) => engage.saveBannerSettings(parse(BannerSettingsSchema, req.body), named(a))));

  app.get('/v1/admin/homepage', (req, reply) => guard(req, M('View'), async () => { NoStore(reply); return engage.layout(); }));
  app.post('/v1/admin/homepage/sections', (req, reply) => guard(req, M('Edit'), async (a) => reply.status(201).send(await engage.addSection(parse(SectionSchema, req.body), named(a)))));
  app.patch('/v1/admin/homepage/sections/:id', (req) => guard(req, M('Edit'), (a) => engage.patchSection(parse(SectionParam, req.params).id, parse(SectionPatchSchema, req.body), named(a))));
  app.post('/v1/admin/homepage/sections/:id/move', (req) => guard(req, M('Edit'), (a) => engage.moveSection(parse(SectionParam, req.params).id, parse(MoveSchema, req.body).dir, named(a))));
  app.delete('/v1/admin/homepage/sections/:id', (req) => guard(req, M('Edit'), (a) => engage.removeSection(parse(SectionParam, req.params).id, named(a))));
  app.post('/v1/admin/homepage/publish', (req) => guard(req, M('Edit'), (a) => engage.publishLayout(parse(PublishLayoutSchema, req.body), named(a))));

  // ============ push, email and SMS =====================================================================================
  app.get('/v1/admin/pushes', (req, reply) => guard(req, M('View'), async () => { NoStore(reply); return engage.pushes(); }));
  app.get('/v1/admin/pushes/:id', (req) => guard(req, M('View'), () => engage.push(parse(IdParam, req.params).id)));
  app.post('/v1/admin/pushes', (req, reply) => guard(req, M('Create'), async (a) => reply.status(201).send(await engage.savePush(null, parse(PushSchema, req.body), named(a)))));
  app.patch('/v1/admin/pushes/:id', (req) => guard(req, M('Edit'), (a) => engage.savePush(parse(IdParam, req.params).id, parse(PushPatchSchema, req.body), named(a))));
  app.get('/v1/admin/messages', (req, reply) => guard(req, M('View'), async () => { NoStore(reply); return engage.messages(); }));
  app.get('/v1/admin/messages/:id', (req) => guard(req, M('View'), () => engage.message(parse(IdParam, req.params).id)));
  app.post('/v1/admin/messages', (req, reply) => guard(req, M('Create'), async (a) => reply.status(201).send(await engage.saveMessage(null, parse(MessageSchema, req.body), named(a)))));
  app.patch('/v1/admin/messages/:id', (req) => guard(req, M('Edit'), (a) => engage.saveMessage(parse(IdParam, req.params).id, parse(MessagePatchSchema, req.body), named(a))));
  app.post('/v1/admin/:kind(pushes|messages)/:id/unschedule', (req) => guard(req, M('Edit'), (a) => {
    const p = req.params as { kind: string; id: string };
    return engage.cancelSchedule(p.kind === 'pushes' ? 'push' : 'message', parse(IdParam, { id: p.id }).id, named(a));
  }));
  // The notification provider reports opens, deliveries and clicks.
  app.post('/v1/internal/marketing/:kind/:id/results', async (req, reply) => {
    requireRole(req, 'notifications');
    const p = parse(KindParam, req.params);
    await engage.recordResults(p.kind, p.id, parse(ResultsSchema, req.body));
    return reply.status(204).send();
  });

  // ============ campaigns, programmes, highlights ===========================================================================
  app.get('/v1/admin/campaigns', (req, reply) => guard(req, M('View'), async () => { NoStore(reply); return engage.campaigns(); }));
  app.get('/v1/admin/campaigns/:id', (req) => guard(req, M('View'), () => engage.campaign(parse(IdParam, req.params).id)));
  app.post('/v1/admin/campaigns', (req, reply) => guard(req, M('Create'), async (a) => reply.status(201).send(await engage.saveCampaign(null, parse(CampaignSchema, req.body), named(a)))));
  app.patch('/v1/admin/campaigns/:id', (req) => guard(req, M('Edit'), (a) => engage.saveCampaign(parse(IdParam, req.params).id, parse(CampaignPatchSchema, req.body), named(a))));
  app.put('/v1/admin/campaigns/:id/channels', (req) => guard(req, M('Edit'), (a) => engage.setChannelResult(parse(IdParam, req.params).id, parse(ChannelResultSchema, req.body), named(a))));
  app.get('/v1/admin/loyalty', (req) => guard(req, M('View'), () => engage.loyalty()));
  app.put('/v1/admin/loyalty', (req) => guard(req, M('Edit'), (a) => engage.saveLoyalty(parse(LoyaltySchema, req.body), named(a))));
  app.get('/v1/admin/referrals', (req) => guard(req, M('View'), () => engage.referral()));
  app.put('/v1/admin/referrals', (req) => guard(req, M('Edit'), (a) => engage.saveReferral(parse(ReferralSchema, req.body), named(a))));
  app.get('/v1/admin/review-highlights', (req, reply) => guard(req, M('View'), async () => { NoStore(reply); return engage.highlights(); }));
  app.put('/v1/admin/review-highlights/:reviewId', (req) => guard(req, M('Edit'), (a) => engage.setHighlight(parse(ReviewParam, req.params).reviewId, parse(HighlightPatchSchema, req.body), named(a))));
  app.delete('/v1/admin/review-highlights/:reviewId', (req, reply) => guard(req, M('Edit'), async (a) => { await engage.removeHighlight(parse(ReviewParam, req.params).reviewId, named(a)); return reply.status(204).send(); }));

  // ============ pages and category copy ===============================================================================================
  app.get('/v1/admin/pages', (req) => guard(req, M('View'), () => content.pages()));
  app.get('/v1/admin/pages/:id', (req) => guard(req, M('View'), () => content.page(parse(IdParam, req.params).id)));
  app.post('/v1/admin/pages', (req, reply) => guard(req, M('Create'), async (a) => reply.status(201).send(await content.savePage(null, parse(PageSchema, req.body), named(a)))));
  app.patch('/v1/admin/pages/:id', (req) => guard(req, M('Edit'), (a) => content.savePage(parse(IdParam, req.params).id, parse(PagePatchSchema, req.body), named(a))));
  app.delete('/v1/admin/pages/:id', (req, reply) => guard(req, M('Delete'), async (a) => { await content.deletePage(parse(IdParam, req.params).id, named(a)); return reply.status(204).send(); }));
  app.get('/v1/admin/category-content', (req) => guard(req, M('View'), () => content.categories()));
  app.patch('/v1/admin/category-content/:id', (req) => guard(req, M('Edit'), (a) => content.saveCategory(parse(IdParam, req.params).id, parse(CategoryContentPatchSchema, req.body), named(a))));

  // ============ the shop and the app (no login needed to read) =========================================================================
  const cached = (reply: { header: (k: string, v: string) => unknown }) => reply.header('cache-control', 'public, max-age=30');
  app.get('/v1/storefront/home', async (req, reply) => { cached(reply); return storefront.home(parse(PlatformQuery, req.query).platform); });
  app.get('/v1/storefront/pages', async (_req, reply) => { cached(reply); return storefront.pages(); });
  app.get('/v1/storefront/page', async (req, reply) => { cached(reply); return storefront.page(parse(SlugQuery, req.query).slug); });
  app.get('/v1/storefront/categories/:handle', async (req, reply) => { cached(reply); return storefront.category(parse(HandleParam, req.params).handle); });
  app.get('/v1/storefront/catalogue', async (_req, reply) => { cached(reply); return storefront.catalogue(); });
  app.get('/v1/storefront/bundles', async (_req, reply) => { cached(reply); return storefront.bundles(); });
  app.get('/v1/storefront/programmes', async (_req, reply) => { cached(reply); return storefront.programmes(); });

  // ============ shoppers ====================================================================================================================
  const shopper = (req: Parameters<typeof requireRole>[0]) => requireRole(req, 'customer').sub;
  app.post('/v1/coupons/quote', async (req, reply) => { reply.header('cache-control', 'no-store'); return promotions.quote(shopper(req), parse(QuoteSchema, req.body)); });
  app.get('/v1/me/marketing', async (req, reply) => { reply.header('cache-control', 'no-store'); return audience.preferences(shopper(req)); });
  app.put('/v1/me/marketing', async (req) => audience.setPreferences(shopper(req), parse(PreferencesSchema, req.body)));
}
