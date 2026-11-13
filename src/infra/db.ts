import pg from 'pg';
import type { Logger } from 'pino';
import type CircuitBreaker from 'opossum';
import type { Config } from '../config/index.js';
import { AppError, ServiceUnavailableError } from '../domain/errors.js';
import { createBreaker } from './circuit-breaker.js';
import { dbPool, dbQueryDuration, dbTxRetries } from './metrics.js';
import { retry } from './retry.js';

// Return BIGINT/NUMERIC as JS numbers only where safe; money is stored as bigint cents.
// Cents up to 2^53 (~$90 trillion) are exact as doubles, so parse int8 to number.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 out of safe range: ${v}`);
  return n;
});

export type Queryable = Pick<pg.PoolClient, 'query'>;

/** Failure to obtain a connection at all (refused, timed out, DB not accepting connections). */
export class DbConnectError extends Error {
  constructor(public override readonly cause: unknown) {
    super(`database connection failed: ${(cause as Error)?.message ?? cause}`);
  }
}

async function acquire(pool: pg.Pool): Promise<pg.PoolClient> {
  try {
    return await pool.connect();
  } catch (err) {
    throw new DbConnectError(err);
  }
}

/** Postgres SQLSTATEs that are safe to retry by re-running the whole transaction. */
const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected
/** Connection-level failures: count against the breaker. */
const CONNECTION_CLASS = ['08', '57P01', '57P02', '57P03', '53300'];

function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

/** Business errors and data errors (constraint violations etc.) are not dependency failures. */
function isNonFailure(err: unknown): boolean {
  if (err instanceof AppError) return true;
  const code = pgCode(err);
  if (!code) return false;
  if (code.startsWith('23') || code.startsWith('22')) return true;
  return false;
}

export function isConnectionError(err: unknown): boolean {
  const code = pgCode(err);
  if (code && CONNECTION_CLASS.some((c) => code.startsWith(c))) return true;
  const msg = err instanceof Error ? err.message : '';
  return /timeout exceeded when trying to connect|Connection terminated|ECONNREFUSED|ECONNRESET/i.test(msg);
}

function makePool(url: string, max: number, cfg: Config, name: string, log: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    min: 0,
    idleTimeoutMillis: cfg.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: cfg.DB_CONNECT_TIMEOUT_MS,
    statement_timeout: cfg.DB_STATEMENT_TIMEOUT_MS,
    query_timeout: cfg.DB_STATEMENT_TIMEOUT_MS + 500,
    idle_in_transaction_session_timeout: cfg.DB_STATEMENT_TIMEOUT_MS * 2,
    application_name: `${cfg.SERVICE_NAME}:${name}`,
    keepAlive: true,
    ssl: cfg.DB_SSL ? { rejectUnauthorized: true } : undefined,
    allowExitOnIdle: false,
  });
  // An idle client erroring (e.g. failover) must never crash the process.
  pool.on('error', (err) => log.error({ err, pool: name }, 'idle pg client error'));
  return pool;
}

export class Database {
  readonly writer: pg.Pool;
  readonly reader: pg.Pool;
  private readonly readBreaker: CircuitBreaker<[(c: Queryable) => Promise<unknown>], unknown>;
  private readonly writeBreaker: CircuitBreaker<[(c: pg.PoolClient) => Promise<unknown>], unknown>;
  private readonly gaugeTimer: NodeJS.Timeout;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {
    this.writer = makePool(cfg.DATABASE_URL, cfg.DB_POOL_MAX, cfg, 'writer', log);
    this.reader = cfg.DATABASE_READ_URL
      ? makePool(cfg.DATABASE_READ_URL, cfg.DB_READ_POOL_MAX, cfg, 'reader', log)
      : this.writer;

    const timeoutMs = cfg.DB_STATEMENT_TIMEOUT_MS * (cfg.DB_TX_MAX_RETRIES + 2);
    this.readBreaker = createBreaker(
      (fn: (c: Queryable) => Promise<unknown>) =>
        this.timed('reader', 'read', async () => {
          const client = await acquire(this.reader);
          let broken = false;
          try {
            return await fn(client);
          } catch (err) {
            broken = isConnectionError(err);
            throw err;
          } finally {
            client.release(broken);
          }
        }),
      { name: 'postgres-reader', timeoutMs, isNonFailure },
      log,
    );
    this.writeBreaker = createBreaker(
      (fn: (c: pg.PoolClient) => Promise<unknown>) => this.runTx(fn),
      { name: 'postgres-writer', timeoutMs, isNonFailure },
      log,
    );

    this.gaugeTimer = setInterval(() => this.reportPoolStats(), 5000);
    this.gaugeTimer.unref();
  }

  private reportPoolStats() {
    for (const [name, pool] of [['writer', this.writer], ['reader', this.reader]] as const) {
      dbPool.set({ pool: name, state: 'total' }, pool.totalCount);
      dbPool.set({ pool: name, state: 'idle' }, pool.idleCount);
      dbPool.set({ pool: name, state: 'waiting' }, pool.waitingCount);
    }
  }

  private async timed<T>(pool: string, op: string, fn: () => Promise<T>): Promise<T> {
    const end = dbQueryDuration.startTimer({ pool, op });
    try {
      return await fn();
    } finally {
      end();
    }
  }

  /** Read-only query against the reader endpoint (replicas). Guarded by a circuit breaker. */
  async read<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    try {
      return (await this.readBreaker.fire(fn)) as T;
    } catch (err) {
      throw this.translate(err);
    }
  }

  /**
   * Run fn in a READ COMMITTED transaction on the writer. The whole transaction is retried
   * with backoff on serialization failures and deadlocks, so fn must be idempotent with
   * respect to its own side effects (it is: everything it does is inside the transaction).
   */
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    try {
      return (await this.writeBreaker.fire(fn)) as T;
    } catch (err) {
      throw this.translate(err);
    }
  }

  private async runTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    return retry(
      async () => {
        const client = await acquire(this.writer);
        let broken = false;
        try {
          await client.query('BEGIN');
          const result = await this.timed('writer', 'tx', () => fn(client));
          await client.query('COMMIT');
          return result;
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch (rbErr) {
            broken = true; // connection is unusable; destroy it instead of returning to pool
            this.log.warn({ err: rbErr }, 'rollback failed; discarding connection');
          }
          throw err;
        } finally {
          client.release(broken);
        }
      },
      {
        retries: this.cfg.DB_TX_MAX_RETRIES,
        baseDelayMs: 5,
        maxDelayMs: 200,
        shouldRetry: (err) => RETRYABLE.has(pgCode(err) ?? ''),
        onRetry: (err, attempt, delay) => {
          dbTxRetries.inc({ reason: pgCode(err) ?? 'unknown' });
          this.log.debug({ attempt, delay, code: pgCode(err) }, 'retrying transaction');
        },
      },
    );
  }

  private translate(err: unknown): unknown {
    if (err instanceof AppError) return err;
    const e = err as { code?: string; message?: string };
    if (err instanceof DbConnectError) return new ServiceUnavailableError('Database unavailable', 2);
    if (e?.code === 'EOPENBREAKER') return new ServiceUnavailableError('Database temporarily unavailable', 2);
    if (e?.code === 'ETIMEDOUT') return new ServiceUnavailableError('Database timeout', 1);
    if (pgCode(err) === '57014') return new ServiceUnavailableError('Query timed out', 1); // query_canceled
    if (isConnectionError(err)) return new ServiceUnavailableError('Database unavailable', 2);
    return err;
  }

  async ping(): Promise<void> {
    await this.writer.query('SELECT 1');
    if (this.reader !== this.writer) await this.reader.query('SELECT 1');
  }

  get breakersOpen(): boolean {
    return this.writeBreaker.opened || this.readBreaker.opened;
  }

  async close(): Promise<void> {
    clearInterval(this.gaugeTimer);
    this.readBreaker.shutdown();
    this.writeBreaker.shutdown();
    await this.writer.end();
    if (this.reader !== this.writer) await this.reader.end();
  }
}
