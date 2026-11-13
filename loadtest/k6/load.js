// LOAD: sustain the target rate with the production mix and assert the SLOs.
//   k6 run -e RATE=40000 -e DURATION=15m -e BASE_URL=https://api.example.com loadtest/k6/load.js
import { storefront, SLO_THRESHOLDS, summaryTrendStats } from './lib.js';

const RATE = Number(__ENV.RATE || 40000);
export const options = {
  discardResponseBodies: false,
  summaryTrendStats: summaryTrendStats(),
  scenarios: {
    load: {
      executor: 'constant-arrival-rate', // open model: arrivals do not slow down when the server does
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '15m',
      preAllocatedVUs: Number(__ENV.VUS || Math.ceil(RATE / 20)),
      maxVUs: Number(__ENV.MAX_VUS || Math.ceil(RATE / 4)),
    },
  },
  thresholds: SLO_THRESHOLDS,
};

export default storefront;
