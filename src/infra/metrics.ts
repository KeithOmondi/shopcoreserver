import client from 'prom-client';

/**
 * Prometheus metrics. RED metrics for HTTP, USE metrics for pools/caches, and
 * domain counters. Scraped by the Prometheus Operator via a ServiceMonitor.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, eventLoopMonitoringPrecision: 10 });

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query latency',
  labelNames: ['pool', 'op'] as const,
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

export const dbPool = new client.Gauge({
  name: 'db_pool_connections',
  help: 'Database pool connections by state',
  labelNames: ['pool', 'state'] as const,
  registers: [registry],
});

export const dbTxRetries = new client.Counter({
  name: 'db_tx_retries_total',
  help: 'Transaction retries due to serialization failure / deadlock',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const cacheEvents = new client.Counter({
  name: 'cache_events_total',
  help: 'Cache hits / misses / errors by tier',
  labelNames: ['cache', 'tier', 'result'] as const,
  registers: [registry],
});

export const breakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state: 0=closed 1=half-open 2=open',
  labelNames: ['name'] as const,
  registers: [registry],
});

export const rateLimited = new client.Counter({
  name: 'rate_limited_total',
  help: 'Requests rejected by the rate limiter',
  labelNames: ['bucket'] as const,
  registers: [registry],
});

export const loadShed = new client.Counter({
  name: 'load_shed_total',
  help: 'Requests rejected by load shedding',
  registers: [registry],
});

export const ordersCreated = new client.Counter({
  name: 'orders_created_total',
  help: 'Orders created',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const outboxPublished = new client.Counter({
  name: 'outbox_events_published_total',
  help: 'Outbox events published to the broker',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const outboxLag = new client.Gauge({
  name: 'outbox_oldest_event_age_seconds',
  help: 'Age of the oldest unpublished outbox event',
  registers: [registry],
});

export const authFailures = new client.Counter({
  name: 'auth_failures_total',
  help: 'Rejected bearer tokens; result=invalid (verification failed) or throttled (IP over its failure budget)',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const orderJobFailures = new client.Counter({
  name: 'order_job_failures_total',
  help: 'Per-order failures inside background jobs (e.g. payment-timeout expiry)',
  labelNames: ['job'] as const,
  registers: [registry],
});

export const orphanedPayments = new client.Counter({
  name: 'orphaned_payments_total',
  help: 'Payments confirmed for an order that was already cancelled (needs refund)',
  registers: [registry],
});
