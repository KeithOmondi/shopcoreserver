// SOAK: moderate rate for hours to surface memory leaks, connection leaks, slow query plan
// drift as tables grow, autovacuum interference, and log/disk growth.
// Watch alongside: process_resident_memory_bytes per pod, db_pool_connections, outbox lag,
// Aurora FreeableMemory / ReplicaLag, and p99 drift between the first and last hour.
//   k6 run -e RATE=25000 -e DURATION=8h loadtest/k6/soak.js
import { storefront, SLO_THRESHOLDS, summaryTrendStats } from './lib.js';

const RATE = Number(__ENV.RATE || 25000);
export const options = {
  summaryTrendStats: summaryTrendStats(),
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '8h',
      preAllocatedVUs: Math.ceil(RATE / 20),
      maxVUs: Math.ceil(RATE / 4),
    },
  },
  thresholds: SLO_THRESHOLDS,
};

export default storefront;
