import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyServerOptions, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { z } from 'zod';
import type { Logger } from 'pino';
import { parseTrustProxy, type Config } from '../config/index.js';
import { AppError, RateLimitedError, ServiceUnavailableError, ValidationError } from '../domain/errors.js';
import { authFailures, httpDuration, loadShed, rateLimited } from '../infra/metrics.js';
import { uuidv7 } from '../infra/uuid.js';
import { bearer, requirePrincipal, requireRole, type TokenVerifier } from './auth.js';
import { IdParam, parse } from './validate.js';
import { makeAuthz, registerStaffRoutes } from './staff-routes.js';
import type { StaffService } from '../modules/staff/staff.js';
import { FailureThrottle, type BucketSpec, type RateLimiter } from './rate-limiter.js';
import type { LoadShedder } from './load-shedding.js';
import {
  AdjustStockSchema,
  CreateProductSchema,
  ListQuerySchema,
  UpdateProductSchema,
  type ProductService,
} from '../modules/products/products.js';
import { makeCreateOrderSchema, type OrderService } from '../modules/orders/orders.js';

export interface AppDeps {
  cfg: Config;
  log: Logger;
  verifier: TokenVerifier;
  limiter: RateLimiter;
  shedder: LoadShedder;
  products: ProductService;
  orders: OrderService;
  staff: StaffService;
  health: { ready: () => boolean; deps: () => Promise<Record<string, string>> };
}

const REQ_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;


export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { cfg, log } = deps;
  const app = Fastify({
    // pino Logger is a FastifyBaseLogger at runtime; the cast only bridges the generic parameter.
    loggerInstance: log as unknown as FastifyBaseLogger,
    // We emit one structured access-log line per request ourselves (onResponse hook).
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: cfg.BODY_LIMIT_BYTES,
    requestTimeout: cfg.REQUEST_TIMEOUT_MS,
    connectionTimeout: cfg.REQUEST_TIMEOUT_MS,
    keepAliveTimeout: 65_000, // > ALB idle timeout (60s) to avoid 502s from races on reused sockets
    trustProxy: parseTrustProxy(cfg.TRUST_PROXY) as FastifyServerOptions['trustProxy'],
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQ_ID_RE.test(h) ? h : uuidv7();
    },
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  const origins = cfg.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length) {
    await app.register(cors, {
      origin: origins,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'If-Match', 'X-Request-Id'],
      maxAge: 600,
    });
  }

  // ---- cross-cutting hooks ------------------------------------------------
  const isInfraRoute = (url: string) => url.startsWith('/health');
  const authThrottle = new FailureThrottle(cfg.AUTH_FAIL_CAPACITY, cfg.AUTH_FAIL_REFILL_PER_SEC);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    if (isInfraRoute(req.url)) return;
    // Routes flagged `config: { critical: true }` are shed last (order creation, payment confirmation).
    const critical = (req.routeOptions.config as { critical?: boolean } | undefined)?.critical === true;
    if (deps.shedder.shouldShed(critical ? 'critical' : 'normal')) {
      loadShed.inc();
      (req as { shed?: boolean }).shed = true;
      throw new ServiceUnavailableError('Server overloaded', 1);
    }
    deps.shedder.inflight++;
    (req as { counted?: boolean }).counted = true;

    const token = bearer(req);
    if (token) {
      // Failed-auth throttle runs BEFORE signature verification so garbage tokens cannot be used
      // to burn CPU, and is keyed by the (trusted-proxy-aware) client IP.
      const wait = authThrottle.blocked(req.ip);
      if (wait) {
        authFailures.inc({ result: 'throttled' });
        throw new RateLimitedError(wait);
      }
      try {
        req.principal = await deps.verifier.verify(token);
      } catch (err) {
        authThrottle.fail(req.ip);
        authFailures.inc({ result: 'invalid' });
        throw err;
      }
    }

    if (cfg.RATE_LIMIT_ENABLED) {
      const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
      const spec: BucketSpec = isWrite
        ? { name: 'write', capacity: cfg.RATE_LIMIT_WRITE_CAPACITY, refillPerSec: cfg.RATE_LIMIT_WRITE_REFILL_PER_SEC }
        : { name: 'read', capacity: cfg.RATE_LIMIT_CAPACITY, refillPerSec: cfg.RATE_LIMIT_REFILL_PER_SEC };
      const key = req.principal ? `u:${req.principal.sub}` : `ip:${req.ip}`;
      const r = await deps.limiter.take(key, spec);
      reply.header('ratelimit-limit', spec.capacity);
      reply.header('ratelimit-remaining', r.remaining);
      if (!r.allowed) {
        rateLimited.inc({ bucket: spec.name });
        throw new RateLimitedError(Math.max(1, r.retryAfterSec));
      }
    }
  });

  const release = (req: FastifyRequest) => {
    const r = req as { counted?: boolean };
    if (r.counted) {
      r.counted = false;
      deps.shedder.inflight--;
    }
  };
  app.addHook('onRequestAbort', async (req) => release(req));

  app.addHook('onResponse', async (req, reply) => {
    release(req);
    const route = req.routeOptions.url ?? 'unmatched';
    const seconds = reply.elapsedTime / 1000;
    httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, seconds);
    // Access logging is sampled: every error and every slow request is logged; fast
    // successful requests are logged at ACCESS_LOG_SAMPLE_RATE. At tens of thousands of
    // RPS, one line per request is a large CPU and log-ingest cost for little value
    // (metrics and traces carry the aggregate picture). Shed requests are never logged
    // individually: logging during overload would add load exactly when there is none to spare.
    const shed = (req as { shed?: boolean }).shed;
    const slow = reply.elapsedTime >= cfg.SLOW_REQUEST_MS;
    const sampled = reply.statusCode >= 400 || slow || Math.random() < cfg.ACCESS_LOG_SAMPLE_RATE;
    if (!isInfraRoute(req.url) && !shed && sampled) {
      const line = {
        method: req.method,
        route,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime * 100) / 100,
        sub: req.principal?.sub,
      };
      if (reply.statusCode >= 500) req.log.error(line, 'request');
      else if (slow) req.log.warn(line, 'slow request');
      else req.log.info(line, 'request');
    }
  });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      if (err.retryAfterSec) reply.header('retry-after', err.retryAfterSec);
      if (err.status >= 500 && !(req as { shed?: boolean }).shed) req.log.warn({ code: err.code }, err.message);
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details }, requestId: req.id });
    }
    const fe = err as { statusCode?: number; code?: string; message?: string };
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      // Fastify-level client errors: malformed JSON, body too large, unsupported media type.
      return reply
        .status(fe.statusCode)
        .send({ error: { code: fe.code ?? 'BAD_REQUEST', message: fe.message ?? 'Bad request' }, requestId: req.id });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' }, requestId: req.id });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' }, requestId: req.id }),
  );

  // ---- health ------------------------------------------------------------
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    if (!deps.health.ready()) return reply.status(503).send({ status: 'not_ready' });
    return { status: 'ready' };
  });
  // Dependency detail is operational data: require a shared secret, and disable it entirely in
  // production when none is configured. (Probes and alerts use /health/ready and metrics.)
  app.get('/health/deps', async (req, reply) => {
    const secret = cfg.HEALTH_DEPS_TOKEN;
    if (secret ? req.headers['x-health-token'] !== secret : cfg.NODE_ENV === 'production') {
      return reply.status(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' }, requestId: req.id });
    }
    return deps.health.deps();
  });

  const actorOf = (req: FastifyRequest) => ({ id: requirePrincipal(req).sub, requestId: String(req.id) });
  const authz = makeAuthz(deps.staff);
  registerStaffRoutes(app, deps.staff, authz);

  // ---- catalog (public reads) ---------------------------------------------
  app.get('/v1/products', async (req, reply) => {
    const q = parse(ListQuerySchema, req.query);
    reply.header('cache-control', 'public, max-age=5');
    return deps.products.list(q.limit, q.cursor);
  });

  app.get('/v1/products/:id', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const p = await deps.products.get(id);
    const etag = `"${p.version}"`;
    reply.header('etag', etag);
    reply.header('cache-control', 'public, max-age=5');
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      return reply.status(304).send();
    }
    return p;
  });

  app.get('/v1/products/:id/availability', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    reply.header('cache-control', 'no-store');
    return deps.products.availability(id);
  });

  // ---- catalog admin ----------------------------------------------------------
  app.post('/v1/products', async (req, reply) => {
    await authz.authorize(req, 'Products', 'Create');
    const body = parse(CreateProductSchema, req.body);
    const p = await deps.products.create(body, actorOf(req));
    return reply.status(201).header('location', `/v1/products/${p.id}`).send(p);
  });

  app.patch('/v1/products/:id', async (req) => {
    await authz.authorize(req, 'Products', 'Edit');
    const { id } = parse(IdParam, req.params);
    const ifMatch = req.headers['if-match'];
    const version = typeof ifMatch === 'string' ? Number(ifMatch.replace(/"/g, '')) : NaN;
    if (!Number.isInteger(version) || version < 1) {
      throw new ValidationError([{ path: ['If-Match'], message: 'required: the product version you read' }]);
    }
    return deps.products.update(id, version, parse(UpdateProductSchema, req.body), actorOf(req));
  });

  app.post('/v1/products/:id/stock-adjustments', async (req) => {
    await authz.authorize(req, 'Inventory', 'Edit');
    const { id } = parse(IdParam, req.params);
    return deps.products.adjustStock(id, parse(AdjustStockSchema, req.body), actorOf(req));
  });

  // ---- orders (authenticated) ---------------------------------------------
  const CreateOrder = makeCreateOrderSchema(cfg);

  app.post('/v1/orders', { config: { critical: true } }, async (req, reply) => {
    const p = requireRole(req, 'customer', 'admin');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string') {
      throw new ValidationError([{ path: ['Idempotency-Key'], message: 'header is required' }]);
    }
    const body = parse(CreateOrder, req.body);
    const { order, replayed } = await deps.orders.create(p.sub, key, body);
    reply.header('location', `/v1/orders/${order.id}`);
    if (replayed) reply.header('idempotent-replayed', 'true');
    return reply.status(replayed ? 200 : 201).send(order);
  });

  app.get('/v1/orders', async (req) => {
    const p = requirePrincipal(req);
    const q = parse(ListQuerySchema, req.query);
    return deps.orders.list(p.sub, q.limit, q.cursor);
  });

  app.get('/v1/orders/:id', async (req, reply) => {
    const p = requirePrincipal(req);
    const { id } = parse(IdParam, req.params);
    reply.header('cache-control', 'private, no-store');
    return deps.orders.get(id, { sub: p.sub, isAdmin: await authz.canAct(req, 'Orders', 'View') });
  });

  const CancelBody = z.strictObject({ reason: z.string().trim().min(1).max(200).default('customer_request') });
  app.post('/v1/orders/:id/cancel', async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(CancelBody, req.body ?? {});
    return deps.orders.cancel(id, { sub: p.sub, isAdmin: await authz.canAct(req, 'Orders', 'Edit'), requestId: String(req.id) }, reason);
  });

  // The payment service must state what it charged; it is checked against the order total.
  const PaidBody = z.strictObject({
    paymentRef: z.string().trim().min(1).max(128),
    amountCents: z.number().int().min(0),
    currency: z.string().regex(/^[A-Z]{3}$/),
  });
  app.post('/v1/orders/:id/payment-confirmation', { config: { critical: true } }, async (req) => {
    requireRole(req, 'payments');
    const { id } = parse(IdParam, req.params);
    const { paymentRef, amountCents, currency } = parse(PaidBody, req.body);
    return deps.orders.markPaid(id, actorOf(req), { paymentRef, amountCents, currency });
  });

  // Warehouse shipment (PAID -> FULFILLED). Admin only.
  app.post('/v1/orders/:id/fulfillment', async (req) => {
    await authz.authorize(req, 'Orders', 'Edit');
    const { id } = parse(IdParam, req.params);
    return deps.orders.fulfill(id, actorOf(req));
  });

  return app;
}
