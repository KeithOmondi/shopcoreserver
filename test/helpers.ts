import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../src/config/index.js';
import { createLogger } from '../src/infra/logger.js';
import { createContainer, type Container } from '../src/container.js';
import { buildApp } from '../src/http/app.js';
import { migrate } from '../scripts/migrate.js';
import { generateKeys, mint } from '../scripts/dev-keys.js';
import { uuidv7 } from '../src/infra/uuid.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/shopcore_test';
export const TEST_REDIS = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
const ISS = 'https://auth.test/';
const AUD = 'shopcore-test';

export interface Harness {
  app: FastifyInstance;
  c: Container;
  cfg: Config;
  db: pg.Pool;
  token: (sub: string, roles?: string[]) => Promise<string>;
  tokenWithClaim: (sub: string, roles: string[], claim: string) => Promise<string>;
  close: () => Promise<void>;
}

export async function resetDatabase() {
  const client = new pg.Client({ connectionString: TEST_DB });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await migrate(TEST_DB, path.resolve(__dirname, '../migrations'), () => undefined);
}

export async function createHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const keys = await generateKeys();
  const cfg = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DB,
    REDIS_URL: TEST_REDIS,
    JWT_ISSUER: ISS,
    JWT_AUDIENCE: AUD,
    JWT_ALGORITHMS: 'EdDSA',
    JWT_PUBLIC_KEY: keys.publicPem,
    STAFF_JWT_PRIVATE_KEY: keys.privatePem,
    DB_POOL_MAX: '30',
    RATE_LIMIT_CAPACITY: '100000',
    RATE_LIMIT_REFILL_PER_SEC: '100000',
    RATE_LIMIT_WRITE_CAPACITY: '100000',
    RATE_LIMIT_WRITE_REFILL_PER_SEC: '100000',
    // Tests share a busy dev machine: do not let incidental event-loop jitter shed requests.
    MAX_EVENT_LOOP_DELAY_MS: '5000',
    MAX_EVENT_LOOP_UTILIZATION: '1',
    AUTH_FAIL_CAPACITY: '100000',
    AUTH_FAIL_REFILL_PER_SEC: '100000',
    CACHE_LOCAL_TTL_MS: '0',
    METRICS_ENABLED: 'false',
    ...overrides,
  });
  const log = createLogger({ level: 'silent', service: 'test' });
  const c = await createContainer(cfg, log);
  await c.redis.flushdb().catch(() => undefined);
  const app = await buildApp(c);
  await app.ready();
  const db = new pg.Pool({ connectionString: TEST_DB, max: 5 });
  return {
    app,
    c,
    cfg,
    db,
    token: (sub, roles = ['customer']) => mint(keys.privatePem, sub, roles, 600, ISS, AUD),
    tokenWithClaim: (sub, roles, claim) => mint(keys.privatePem, sub, roles, 600, ISS, AUD, claim),
    close: async () => {
      await app.close();
      await c.close();
      await db.end();
    },
  };
}

export async function createProduct(h: Harness, opts: { stock: number; priceCents?: number; sku?: string }) {
  const admin = await h.token(uuidv7(), ['admin']);
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/products',
    headers: { authorization: `Bearer ${admin}` },
    payload: {
      sku: opts.sku ?? `T-${uuidv7().slice(-12).toUpperCase()}`,
      name: 'Test product',
      priceCents: opts.priceCents ?? 1000,
      currency: 'USD',
      initialStock: opts.stock,
    },
  });
  if (res.statusCode !== 201) throw new Error(`createProduct failed: ${res.body}`);
  return res.json() as { id: string; version: number };
}

export async function stockOf(h: Harness, productId: string) {
  const { rows } = await h.db.query<{ available: number; reserved: number }>(
    'SELECT available, reserved FROM inventory WHERE product_id = $1',
    [productId],
  );
  return rows[0]!;
}

export const idemKey = () => `k-${uuidv7()}`;
