import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * All runtime configuration comes from the environment and is validated at boot.
 * The process refuses to start on invalid config (fail fast) rather than running
 * with silently wrong defaults. Nothing environment-specific is hardcoded.
 */
const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('shopcore-api'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  WORKERS: z.coerce.number().int().min(1).max(256).default(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Postgres: writer and reader endpoints are separate (Aurora writer / reader endpoints, via RDS Proxy).
  DATABASE_URL: z.string().url(),
  DATABASE_READ_URL: z.string().url().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
  DB_READ_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(2000),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(3000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  DB_SSL: bool.default(false),
  DB_TX_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),

  REDIS_URL: z.string().url(),
  REDIS_CLUSTER: bool.default(false),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(10).default(250),

  // Caching
  CACHE_PRODUCT_TTL_S: z.coerce.number().int().min(1).default(300),
  CACHE_LOCAL_TTL_MS: z.coerce.number().int().min(0).default(1000),
  CACHE_LOCAL_MAX_ENTRIES: z.coerce.number().int().min(0).default(10000),

  // Auth: verify tokens issued by an external IdP (Cognito / Auth0 / Keycloak).
  JWT_ISSUER: z.string().min(1).optional(),
  JWT_AUDIENCE: z.string().min(1).optional(),
  JWT_JWKS_URL: z.string().url().optional(),
  JWT_PUBLIC_KEY: z.string().optional(), // PEM (SPKI). Used when no JWKS URL (tests, air-gapped).
  JWT_PUBLIC_KEY_FILE: z.string().optional(), // path to a mounted PEM; takes effect when JWT_PUBLIC_KEY is unset
  JWT_ALGORITHMS: z.string().default('EdDSA,RS256,ES256'),
  // Claim carrying roles/groups. Cognito uses 'cognito:groups'; Auth0/Keycloak need a custom claim.
  // Accepts an array of strings or a space/comma separated string.
  JWT_ROLES_CLAIM: z.string().min(1).default('roles'),
  // 'uuid': token `sub` must already be a UUID. 'hash': any `sub` (e.g. 'auth0|abc') is mapped to a
  // stable UUID derived from it, so user_id columns stay uuid. Changing this later re-keys every user.
  JWT_SUB_MODE: z.enum(['uuid', 'hash']).default('uuid'),

  // Staff sign-in: this API issues its own short-lived admin tokens, signed with this Ed25519 key (PKCS8 PEM).
  // The matching public key is what JWT_PUBLIC_KEY verifies. Unset => staff sign-in is disabled.
  STAFF_JWT_PRIVATE_KEY: z.string().optional(),
  STAFF_JWT_PRIVATE_KEY_FILE: z.string().optional(),
  STAFF_ACCESS_TTL_S: z.coerce.number().int().min(60).max(3600).default(900),
  STAFF_SESSION_TTL_S: z.coerce.number().int().min(900).default(12 * 3600),
  STAFF_LOCK_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  STAFF_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  // Rider app sign-in (same signing key as staff). RIDER_DEV_OTP fixes the SMS code for demos; ignored in production.
  RIDER_ACCESS_TTL_S: z.coerce.number().int().min(60).max(86400).default(3600),
  RIDER_SESSION_TTL_S: z.coerce.number().int().min(3600).default(30 * 86400),
  RIDER_DEV_OTP: z.string().regex(/^\d{6}$/).optional(),

  // Rate limiting (per principal, token bucket)
  RATE_LIMIT_ENABLED: bool.default(true),
  RATE_LIMIT_CAPACITY: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_REFILL_PER_SEC: z.coerce.number().min(0.1).default(50),
  RATE_LIMIT_WRITE_CAPACITY: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_WRITE_REFILL_PER_SEC: z.coerce.number().min(0.1).default(2),
  // Failed-authentication throttle (per client IP, per process). Once an IP has used up its
  // failures, further requests carrying a bearer token are rejected with 429 *before* any
  // signature verification work is done.
  AUTH_FAIL_CAPACITY: z.coerce.number().int().min(1).default(20),
  AUTH_FAIL_REFILL_PER_SEC: z.coerce.number().min(0.01).default(0.5),

  // Load shedding
  MAX_EVENT_LOOP_DELAY_MS: z.coerce.number().int().min(0).default(200),
  MAX_EVENT_LOOP_UTILIZATION: z.coerce.number().min(0).max(1).default(0.98),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).default(10000),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(65536),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(15000),

  // Business limits
  ORDER_MAX_LINES: z.coerce.number().int().min(1).max(500).default(50),
  ORDER_MAX_QTY_PER_LINE: z.coerce.number().int().min(1).default(100),

  // Messaging / outbox
  KAFKA_BROKERS: z.string().optional(),
  KAFKA_CLIENT_ID: z.string().default('shopcore'),
  KAFKA_TOPIC_PREFIX: z.string().default('shopcore'),
  KAFKA_SSL: bool.default(false),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(200),

  // Observability
  OTEL_ENABLED: bool.default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  METRICS_ENABLED: bool.default(true),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  // 'false' | hop count (e.g. '1' = one load balancer in front) | comma-separated CIDRs/IPs.
  // 'true' (trust every X-Forwarded-For hop) lets clients spoof their IP and is refused in production.
  TRUST_PROXY: z.string().default('false'),
  // Shared secret for GET /health/deps (sent as x-health-token). Unset => endpoint disabled in production.
  HEALTH_DEPS_TOKEN: z.string().min(16).optional(),
  CORS_ORIGINS: z.string().default(''), // comma-separated allow-list; empty = CORS disabled
  ACCESS_LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.01),
  SLOW_REQUEST_MS: z.coerce.number().min(1).default(250),
  MAX_INFLIGHT_REQUESTS: z.coerce.number().int().min(1).default(2048),
  ORDER_PAYMENT_TIMEOUT_MIN: z.coerce.number().int().min(1).default(30),
  IDEMPOTENCY_RETENTION_HOURS: z.coerce.number().int().min(1).default(48),
});

export type Config = z.infer<typeof schema> & { JWT_ISSUER: string; JWT_AUDIENCE: string };

/**
 * role=api requires token-verification settings; role=worker does not (it never sees user requests).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, role: 'api' | 'worker' = 'api'): Config {
  if (!env.JWT_PUBLIC_KEY && env.JWT_PUBLIC_KEY_FILE) {
    env = { ...env, JWT_PUBLIC_KEY: readFileSync(env.JWT_PUBLIC_KEY_FILE, 'utf8') };
  }
  if (!env.STAFF_JWT_PRIVATE_KEY && env.STAFF_JWT_PRIVATE_KEY_FILE) {
    env = { ...env, STAFF_JWT_PRIVATE_KEY: readFileSync(env.STAFF_JWT_PRIVATE_KEY_FILE, 'utf8') };
  }
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (role === 'api') {
    if (!cfg.JWT_ISSUER || !cfg.JWT_AUDIENCE) throw new Error('Invalid configuration: JWT_ISSUER and JWT_AUDIENCE are required');
    if (!cfg.JWT_JWKS_URL && !cfg.JWT_PUBLIC_KEY) {
      throw new Error('Invalid configuration: one of JWT_JWKS_URL, JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_FILE is required');
    }
  }
  if (cfg.NODE_ENV === 'production' && !cfg.DB_SSL) {
    throw new Error('Invalid configuration: DB_SSL must be true in production');
  }
  if (cfg.NODE_ENV === 'production' && cfg.TRUST_PROXY.trim().toLowerCase() === 'true') {
    throw new Error('Invalid configuration: TRUST_PROXY=true is unsafe in production; use a hop count or CIDR list');
  }
  return cfg as Config;
}

/** Fastify `trustProxy` option from the TRUST_PROXY string. */
export function parseTrustProxy(v: string): boolean | number | string[] {
  const t = v.trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false' || t === '') return false;
  if (/^\d+$/.test(t)) return Number(t);
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}
