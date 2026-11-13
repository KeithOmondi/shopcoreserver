// SPIKE: baseline -> sudden 3x surge (flash sale / marketing push) -> back to baseline.
// Pass criteria: no 5xx other than deliberate 503 load-shedding, latency recovers to baseline
// within 60s of the spike ending, and HPA/Karpenter add capacity during the surge.
//   k6 run -e BASE_RATE=15000 -e SPIKE_RATE=45000 loadtest/k6/spike.js
import http from 'k6/http';
import { storefront, summaryTrendStats } from './lib.js';

// Deliberate load-shedding (503 + Retry-After) is an expected, correct response during a spike;
// everything else (5xx, timeouts, resets) counts as a failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 503));

const BASE_RATE = Number(__ENV.BASE_RATE || 15000);
const SPIKE_RATE = Number(__ENV.SPIKE_RATE || 45000);
export const options = {
  summaryTrendStats: summaryTrendStats(),
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: BASE_RATE,
      timeUnit: '1s',
      preAllocatedVUs: Math.ceil(SPIKE_RATE / 20),
      maxVUs: Math.ceil(SPIKE_RATE / 3),
      stages: [
        { target: BASE_RATE, duration: __ENV.WARM || '2m' },
        { target: SPIKE_RATE, duration: '10s' }, // near-instant surge
        { target: SPIKE_RATE, duration: __ENV.HOLD || '3m' },
        { target: BASE_RATE, duration: '10s' },
        { target: BASE_RATE, duration: __ENV.COOL || '3m' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'], // no failures other than deliberate shedding
    'http_req_duration{expected_response:true}': ['p(99)<1000'],
    checks: ['rate>0.95'], // at most 5% of requests shed at the peak of the surge
  },
};

export default storefront;
