import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config/index.js';
import { ForbiddenError, ValidationError } from '../domain/errors.js';
import { MpesaService, PayBodySchema } from '../modules/integrations/mpesa.js';
import { ProductImagesSchema, UPLOAD_CONTENT_TYPES, UploadQuerySchema, UploadService, type Owner, type UploadKind } from '../modules/integrations/storage.js';
import { requirePrincipal, requireRole } from './auth.js';
import type { Authz } from './staff-routes.js';
import { IdParam, parse } from './validate.js';

export interface IntegrationServices { mpesa: MpesaService; uploads: UploadService }

/** Who may upload which kind of file. Staff uploads of shop content need the matching permission. */
const WHO: Record<UploadKind, ('staff' | 'rider' | 'customer')[]> = {
  'rider-document': ['rider', 'staff'], 'delivery-photo': ['rider'], 'return-photo': ['customer', 'staff'], avatar: ['staff', 'rider', 'customer'], banner: ['staff'], 'product-image': ['staff'],
};

/** M-Pesa payments, and photos and documents. */
export function registerIntegrationRoutes(app: FastifyInstance, svc: IntegrationServices, authz: Authz, cfg: Config) {
  const { mpesa, uploads } = svc;

  // ============ M-Pesa ===========================================================================================
  app.post('/v1/orders/:id/pay/mpesa', { config: { critical: true } }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return mpesa.initiate(requireRole(req, 'customer').sub, parse(IdParam, req.params).id, parse(PayBodySchema, req.body));
  });
  app.get('/v1/orders/:id/pay/mpesa', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return mpesa.status(requireRole(req, 'customer').sub, parse(IdParam, req.params).id);
  });
  // Safaricom calls this. The secret in the address is the proof it is them; never log the address.
  app.post('/v1/webhooks/mpesa/:secret', { config: { critical: true } }, async (req) => mpesa.callback(String((req.params as { secret?: string }).secret ?? ''), req.body));

  // ============ files ===========================================================================================
  /** Who is asking, if anyone. Files are opened with or without a sign-in, depending on the file. */
  const ownerOf = async (req: FastifyRequest): Promise<Owner | null> => {
    const p = req.principal;
    if (!p) return null;
    if (p.roles.has('admin')) return { id: p.sub, type: 'service' };
    if (p.roles.has('staff')) return { id: p.sub, type: 'staff' };
    if (p.roles.has('rider')) return { id: p.sub, type: 'rider' };
    if (p.roles.has('customer')) return { id: p.sub, type: 'customer' };
    return null;
  };

  // A picture or PDF is the whole request body (no form wrapping), with the kind in the query string.
  void app.register(async (scope) => {
    scope.addContentTypeParser(UPLOAD_CONTENT_TYPES, { parseAs: 'buffer', bodyLimit: cfg.UPLOAD_MAX_BYTES + 1024 }, (_req, body, done) => done(null, body));
    scope.put('/v1/uploads', async (req, reply) => {
      requirePrincipal(req);
      const q = parse(UploadQuerySchema, req.query);
      const owner = await ownerOf(req);
      if (!owner || (owner.type !== 'service' && !WHO[q.kind].includes(owner.type))) throw new ForbiddenError('You can’t upload that kind of file');
      if (owner.type === 'staff') {
        const ctx = await authz.staffContext(req);
        const need = q.kind === 'banner' ? ctx.can('Marketing', 'Edit') : q.kind === 'product-image' ? ctx.can('Products', 'Edit') : true;
        if (!need) throw new ForbiddenError('You don’t have permission to upload that');
      }
      const body = req.body;
      if (!Buffer.isBuffer(body)) throw new ValidationError([{ path: ['body'], message: 'send the file itself as the request body, with its Content-Type' }]);
      const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
      return reply.status(201).send(await uploads.save(owner, q.kind, type, q.name, body));
    });
  });

  app.put('/v1/admin/products/:id/images', async (req) => {
    const ctx = await authz.authorize(req, 'Products', 'Edit');
    return uploads.setProductImages(parse(IdParam, req.params).id, parse(ProductImagesSchema, req.body).uploadIds, ctx?.id ?? requirePrincipal(req).sub);
  });

  app.get('/v1/files/:id', async (req, reply) => {
    const f = await uploads.open(parse(IdParam, req.params).id, await ownerOf(req));
    return reply
      .header('content-type', f.contentType)
      .header('content-disposition', `inline; filename="${f.name.replace(/"/g, '')}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', f.public ? 'public, max-age=3600' : 'private, no-store')
      .send(f.bytes);
  });
}
