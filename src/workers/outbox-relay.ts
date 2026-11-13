import type pg from 'pg';
import type { Logger } from 'pino';
import { Kafka, CompressionTypes, logLevel, type Producer } from 'kafkajs';
import type { Config } from '../config/index.js';
import { outboxLag, outboxPublished } from '../infra/metrics.js';
import { retry } from '../infra/retry.js';

export interface OutboxEvent {
  id: number;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date;
}

export interface Publisher {
  publish(events: OutboxEvent[]): Promise<void>;
  close(): Promise<void>;
}

/** Idempotent producer, acks=all: no loss once Kafka acknowledges, no duplicates from producer retries. */
export class KafkaPublisher implements Publisher {
  private producer: Producer;
  private connected = false;
  constructor(private readonly cfg: Config) {
    const kafka = new Kafka({
      clientId: cfg.KAFKA_CLIENT_ID,
      brokers: cfg.KAFKA_BROKERS!.split(','),
      ssl: cfg.KAFKA_SSL,
      logLevel: logLevel.WARN,
      retry: { retries: 5, initialRetryTime: 100, maxRetryTime: 5000 },
    });
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  }
  async publish(events: OutboxEvent[]) {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
    const byTopic = new Map<string, OutboxEvent[]>();
    for (const e of events) {
      const t = `${this.cfg.KAFKA_TOPIC_PREFIX}.${e.aggregate_type}.v1`;
      byTopic.set(t, [...(byTopic.get(t) ?? []), e]);
    }
    await this.producer.sendBatch({
      acks: -1,
      compression: CompressionTypes.GZIP,
      topicMessages: [...byTopic].map(([topic, evs]) => ({
        topic,
        messages: evs.map((e) => ({
          key: e.aggregate_id, // per-aggregate ordering within a partition
          value: JSON.stringify({ id: e.id, type: e.event_type, occurredAt: e.created_at, data: e.payload }),
          headers: { 'event-id': String(e.id), 'event-type': e.event_type },
        })),
      })),
    });
  }
  async close() {
    if (this.connected) await this.producer.disconnect();
  }
}

/** Development / test publisher. */
export class LogPublisher implements Publisher {
  readonly published: OutboxEvent[] = [];
  constructor(private readonly log: Logger) {}
  async publish(events: OutboxEvent[]) {
    this.published.push(...events);
    this.log.debug({ count: events.length }, 'outbox events (log publisher)');
  }
  async close() {}
}

const LEADER_LOCK = 727274002;

/**
 * Transactional-outbox relay. Delivery is at-least-once: an event is deleted only
 * after the broker acknowledged it; if the relay dies between ack and delete the event
 * is re-sent, so consumers dedupe on the event id.
 *
 * Exactly one relay is active at a time (session-level advisory lock = leader election);
 * standby replicas take over within one poll interval if the leader dies, because Postgres
 * releases the lock when the session drops. A single active relay preserves per-aggregate
 * event order, which concurrent relays could not guarantee.
 *
 * No database transaction is held open while talking to the broker: the batch is read,
 * published (with retries), and only then deleted by id. Holding a transaction across network
 * retries would pin a connection, hold row locks, and trip idle_in_transaction_session_timeout.
 * Mutual exclusion comes from the advisory lock, and the leadership session is re-verified
 * on every iteration.
 */
export class OutboxRelay {
  private stopped = false;
  private leaderClient?: pg.PoolClient;

  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: Publisher,
    private readonly cfg: Pick<Config, 'OUTBOX_BATCH_SIZE' | 'OUTBOX_POLL_INTERVAL_MS'>,
    private readonly log: Logger,
  ) {}

  /** Give up leadership: destroy the session (Postgres then releases the advisory lock). */
  private dropLeader(client?: pg.PoolClient) {
    if (client && client !== this.leaderClient) return;
    const c = this.leaderClient;
    this.leaderClient = undefined;
    c?.release(true);
  }

  async tryBecomeLeader(): Promise<boolean> {
    if (this.leaderClient) {
      try {
        await this.leaderClient.query('SELECT 1'); // heartbeat: is the lock-holding session alive?
        return true;
      } catch (err) {
        this.log.warn({ err }, 'outbox relay: leadership session lost');
        this.dropLeader();
      }
    }
    const c = await this.pool.connect();
    try {
      const { rows } = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK]);
      if (rows[0]?.ok) {
        this.leaderClient = c;
        c.on('error', () => this.dropLeader(c)); // lost the session => lost leadership
        this.log.info('outbox relay: acquired leadership');
        return true;
      }
    } catch (err) {
      c.release(true); // do not return a possibly broken connection to the pool
      throw err;
    }
    c.release();
    return false;
  }

  /** Publish one batch. Returns the number of events relayed. */
  async relayOnce(): Promise<number> {
    const { rows } = await this.pool.query<OutboxEvent>(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, created_at
       FROM outbox ORDER BY id LIMIT $1`,
      [this.cfg.OUTBOX_BATCH_SIZE],
    );
    if (rows.length === 0) {
      outboxLag.set(0);
      return 0;
    }
    outboxLag.set((Date.now() - rows[0]!.created_at.getTime()) / 1000);
    try {
      await retry(() => this.publisher.publish(rows), {
        retries: 5,
        baseDelayMs: 100,
        maxDelayMs: 5000,
        shouldRetry: () => !this.stopped,
      });
    } catch (err) {
      outboxPublished.inc({ result: 'error' });
      throw err;
    }
    await this.pool.query('DELETE FROM outbox WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
    outboxPublished.inc({ result: 'ok' }, rows.length);
    return rows.length;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!(await this.tryBecomeLeader())) {
          await sleepUnlessStopped(this, this.cfg.OUTBOX_POLL_INTERVAL_MS * 5);
          continue;
        }
        const n = await this.relayOnce();
        if (n < this.cfg.OUTBOX_BATCH_SIZE) await sleepUnlessStopped(this, this.cfg.OUTBOX_POLL_INTERVAL_MS);
      } catch (err) {
        this.log.error({ err }, 'outbox relay iteration failed');
        await sleepUnlessStopped(this, 1000);
      }
    }
  }

  isStopped() {
    return this.stopped;
  }

  /** Ask the run loop to exit after its current iteration. */
  signalStop() {
    this.stopped = true;
  }

  /** Release leadership and the broker connection. Call after run() has resolved. */
  async stop() {
    this.stopped = true;
    if (this.leaderClient) {
      await this.leaderClient.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK]).catch(() => undefined);
      const c = this.leaderClient;
      this.leaderClient = undefined;
      c.release();
    }
    await this.publisher.close();
  }
}

async function sleepUnlessStopped(r: { isStopped(): boolean }, ms: number) {
  const step = 50;
  for (let t = 0; t < ms && !r.isStopped(); t += step) await new Promise((res) => setTimeout(res, step));
}
