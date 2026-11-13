import type { Logger } from 'pino';
import type { Config } from './config/index.js';
import { Database } from './infra/db.js';
import { createRedis, type RedisClient } from './infra/redis.js';
import { ReadThroughCache } from './infra/cache.js';
import { TokenVerifier } from './http/auth.js';
import { RateLimiter } from './http/rate-limiter.js';
import { LoadShedder } from './http/load-shedding.js';
import { ProductRepository, ProductService, type Product, type ProductPage } from './modules/products/products.js';
import { OrderRepository, OrderService } from './modules/orders/orders.js';
import { StaffService } from './modules/staff/staff.js';
import type { AppDeps } from './http/app.js';

/**
 * Composition root: the only place that wires concrete infrastructure into services.
 * Everything below takes its dependencies through constructors (DIP), which is what
 * lets tests substitute real or fake implementations.
 */
export interface Container extends AppDeps {
  db: Database;
  redis: RedisClient;
  close: () => Promise<void>;
  setShuttingDown: () => void;
}

export async function createContainer(cfg: Config, log: Logger): Promise<Container> {
  const db = new Database(cfg, log);
  const redis = createRedis(cfg, log);
  const verifier = await TokenVerifier.create(cfg);
  const limiter = new RateLimiter(redis, log);
  const shedder = new LoadShedder(cfg.MAX_EVENT_LOOP_DELAY_MS, cfg.MAX_EVENT_LOOP_UTILIZATION, cfg.MAX_INFLIGHT_REQUESTS);

  const productCache = new ReadThroughCache<Product>(
    'product',
    redis,
    { ttlSec: cfg.CACHE_PRODUCT_TTL_S, negativeTtlSec: 30, l1TtlMs: cfg.CACHE_LOCAL_TTL_MS, l1Max: cfg.CACHE_LOCAL_MAX_ENTRIES },
    log,
  );
  const listCache = new ReadThroughCache<ProductPage>(
    'product-list',
    redis,
    { ttlSec: 30, negativeTtlSec: 5, l1TtlMs: cfg.CACHE_LOCAL_TTL_MS, l1Max: 1000, generational: true },
    log,
  );

  const products = new ProductService(db, new ProductRepository(), productCache, listCache, log);
  const orders = new OrderService(db, new OrderRepository());

  const staff = new StaffService(db, cfg, log);

  // Verify connectivity once at boot, so a misconfigured pod never becomes Ready.
  await db.ping();

  let shuttingDown = false;
  return {
    cfg,
    log,
    db,
    redis,
    verifier,
    limiter,
    shedder,
    products,
    orders,
    staff,
    health: {
      // Readiness reflects *this pod's* ability to serve; it deliberately does not
      // ping shared dependencies on every probe, otherwise one database blip would mark
      // every pod unready simultaneously and the LB would have nowhere to send traffic
      // (turning partial degradation into a total outage). Dependency status is
      // exposed separately and drives alerts instead.
      ready: () => !shuttingDown,
      deps: async () => {
        const out: Record<string, string> = {};
        out.postgres = await db.ping().then(() => (db.breakersOpen ? 'degraded' : 'ok'), () => 'down');
        out.redis = await redis.ping().then(() => 'ok', () => 'down');
        return out;
      },
    },
    setShuttingDown: () => {
      shuttingDown = true;
    },
    close: async () => {
      shedder.stop();
      limiter.shutdown();
      productCache.shutdown();
      listCache.shutdown();
      await Promise.allSettled([db.close(), redis.quit()]);
    },
  };
}
