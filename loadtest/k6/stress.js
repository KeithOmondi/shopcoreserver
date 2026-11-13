// STRESS / CAPACITY PROBE: ramp the arrival rate until SLOs break, to find the maximum
// sustainable throughput (the "knee"). abortOnFail stops the run once the system is past it.
//   k6 run -e START=1000 -e PEAK=60000 -e RAMP=10m loadtest/k6/stress.js
import { storefront, summaryTrendStats } from './lib.js';

const START = Number(__ENV.START || 1000);
const PEAK = Number(__ENV.PEAK || 60000);
export const options = {
  summaryTrendStats: summaryTrendStats(),
  scenarios: {
    stress: {
      executor: 'ramping-arrival-rate',
      startRate: START,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.VUS || Math.ceil(PEAK / 20)),
      maxVUs: Number(__ENV.MAX_VUS || Math.ceil(PEAK / 4)),
      stages: [{ target: PEAK, duration: __ENV.RAMP || '10m' }],
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '20s' }],
    http_req_duration: [{ threshold: 'p(99)<500', abortOnFail: true, delayAbortEval: '20s' }],
  },
};

export default storefront;
