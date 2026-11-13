import http from 'node:http';
import { loadConfig } from './config/index.js';
import { createLogger } from './infra/logger.js';
import { registry } from './infra/metrics.js';
import { Database } from './infra/db.js';
import { OrderRepository, OrderService } from './modules/orders/orders.js';
import { DispatchService } from './modules/dispatch/dispatch.js';
import { EngageService } from './modules/marketing/engage.js';
import { KafkaPublisher, LogPublisher, OutboxRelay } from './workers/outbox-relay.js';

/**
 * Background worker deployment (separate from API pods so request latency is never
 * affected by batch work, and each scales independently):
 *   - outbox relay (leader-elected)
 *   - expiry of unpaid orders (releases reserved stock)
 *   - expiry of unanswered rider offers
 *   - purge of expired idempotency keys
 */
async function main() {
  const cfg = loadConfig(process.env, 'worker');
  const log = createLogger({ level: cfg.LOG_LEVEL, service: `${cfg.SERVICE_NAME}-worker` });
  const db = new Database(cfg, log);
  await db.ping();

  const publisher = cfg.KAFKA_BROKERS ? new KafkaPublisher(cfg) : new LogPublisher(log);
  if (!cfg.KAFKA_BROKERS) log.warn('KAFKA_BROKERS not set: using log publisher (development only)');
  const relay = new OutboxRelay(db.writer, publisher, cfg, log);
  const orders = new OrderService(db, new OrderRepository());
  const dispatch = new DispatchService(db);
  const engage = new EngageService(db);

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let running = false;
    timers.push(
      setInterval(async () => {
        if (running) return; // never overlap runs of the same job
        running = true;
        try {
          await fn();
        } catch (err) {
          log.error({ err, job: name }, 'job failed');
        } finally {
          running = false;
        }
      }, ms),
    );
  };

  every(30_000, 'expire-unpaid', async () => {
    let total = 0;
    for (let n = -1; n !== 0; total += n) n = await orders.expireUnpaid(cfg.ORDER_PAYMENT_TIMEOUT_MIN);
    if (total) log.info({ cancelled: total }, 'expired unpaid orders');
  });
  // Rider offers nobody answered within 75 seconds go back to the dispatch board.
  every(10_000, 'expire-offers', async () => {
    const n = await dispatch.expireOffers();
    if (n) log.info({ expired: n }, 'expired rider offers');
  });
  // Scheduled pushes, emails and texts that have come due, and a homepage layout waiting for its time.
  every(30_000, 'marketing-due', async () => {
    const r = await engage.runDue();
    if (r.pushes || r.messages || r.layout) log.info(r, 'marketing sends');
  });
  every(60_000, 'purge-idempotency', async () => {
    // Batched delete keeps each transaction short and avoids long locks / WAL spikes.
    for (;;) {
      const { rowCount } = await db.writer.query(
        `DELETE FROM idempotency_keys WHERE ctid = ANY (ARRAY(
           SELECT ctid FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1) LIMIT 5000))`,
        [cfg.IDEMPOTENCY_RETENTION_HOURS],
      );
      if (!rowCount) break;
    }
  });

  const metrics = http.createServer(async (req, res) => {
    if (req.url === '/health/live' || req.url === '/health/ready') return res.end('ok');
    if (req.url !== '/metrics') {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('content-type', registry.contentType);
    res.end(await registry.metrics());
  });
  metrics.listen(cfg.METRICS_PORT, cfg.HOST);

  const running = relay.run();
  log.info('worker started');

  const shutdown = async () => {
    log.info('worker shutting down');
    timers.forEach(clearInterval);
    relay.signalStop();
    await running;
    await relay.stop();
    metrics.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'worker startup failed', err: String(err?.stack ?? err) }));
  process.exit(1);
});
