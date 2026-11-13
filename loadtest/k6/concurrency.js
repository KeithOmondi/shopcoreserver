// CONCURRENT USERS: 100,000+ simultaneously connected users, closed model.
// Each VU is a user with its own keep-alive connection who browses with think time
// (2-6 s between actions). 100k users at ~4 s mean think time ~= 25k RPS offered.
// Needs a distributed k6 run (k6-operator, parallelism >= 10) - one generator host
// cannot hold 100k sockets and VUs comfortably.
//   k6 run -e USERS=100000 -e HOLD=20m loadtest/k6/concurrency.js
import { sleep } from 'k6';
import { storefront, summaryTrendStats } from './lib.js';

const USERS = Number(__ENV.USERS || 100000);
export const options = {
  summaryTrendStats: summaryTrendStats(),
  scenarios: {
    users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { target: USERS, duration: __ENV.RAMP || '10m' },
        { target: USERS, duration: __ENV.HOLD || '20m' },
        { target: 0, duration: '2m' },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    http_req_duration: ['p(99)<200'],
  },
};

export default function () {
  storefront();
  sleep(2 + Math.random() * 4);
}
