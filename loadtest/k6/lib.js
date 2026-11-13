// Shared traffic model for every k6 profile.
//
// Request mix (per request, modelled on a typical storefront at peak):
//   52%  GET  /v1/products/:id             product detail page (hot-skewed: 80% of hits on 20% of SKUs)
//   15%  GET  /v1/products?limit=20        category / listing pages
//   10%  GET  /v1/products/:id/availability live stock badge (uncached, hits DB replicas)
//   10%  GET  /v1/orders?limit=10          "my orders"
//    5%  GET  /v1/orders/:id               order status
//    8%  POST /v1/orders                   checkout (write transaction)
// Every request carries a bearer token, so JWT verification and per-user rate limiting are
// always on the measured path (conservative: real traffic has anonymous browsers too).
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';

export const BASE = __ENV.BASE_URL || 'http://127.0.0.1:8080';
const products = new SharedArray('products', () => JSON.parse(open(__ENV.PRODUCTS_FILE || '../data/product-ids.json')));
const tokens = new SharedArray('tokens', () => open(__ENV.TOKENS_FILE || '../data/tokens.txt').split('\n').filter(Boolean));

export const ordersCreated = new Counter('orders_created');
export const checkoutLatency = new Trend('checkout_latency', true);

const HOT = Math.max(1, Math.floor(products.length * 0.2));
function pickProduct() {
  return Math.random() < 0.8
    ? products[Math.floor(Math.random() * HOT)]
    : products[HOT + Math.floor(Math.random() * (products.length - HOT))];
}

// Each VU acts as one user and remembers the orders it created.
let myToken;
const myOrders = [];
function token() {
  if (!myToken) myToken = tokens[(__VU - 1) % tokens.length];
  return myToken;
}

function uuidish() {
  return `${Date.now().toString(36)}-${__VU}-${__ITER}-${Math.random().toString(36).slice(2, 10)}`;
}

const ok = (res, name, statuses = [200]) =>
  check(res, { [`${name} status ok`]: (r) => statuses.includes(r.status) });

// MIX=production (default) | browse (reads only) | checkout (writes only) | hotsku (every
// checkout buys the same product: flash-sale row-lock contention): used to measure the read
// path, the write path and the hot-row ceiling separately for database sizing.
const MIX = __ENV.MIX || 'production';

export function storefront() {
  const headers = { authorization: `Bearer ${token()}` };
  const r = MIX === 'checkout' || MIX === 'hotsku' ? 99 : MIX === 'browse' ? Math.random() * 92 : Math.random() * 100;
  if (r < 52) {
    ok(http.get(`${BASE}/v1/products/${pickProduct()}`, { headers, tags: { name: 'GET /v1/products/:id' } }), 'product');
  } else if (r < 67) {
    ok(http.get(`${BASE}/v1/products?limit=20`, { headers, tags: { name: 'GET /v1/products' } }), 'list');
  } else if (r < 77) {
    ok(http.get(`${BASE}/v1/products/${pickProduct()}/availability`, { headers, tags: { name: 'GET /availability' } }), 'availability');
  } else if (r < 87) {
    ok(http.get(`${BASE}/v1/orders?limit=10`, { headers, tags: { name: 'GET /v1/orders' } }), 'my orders');
  } else if (r < 92) {
    const id = myOrders.length ? myOrders[Math.floor(Math.random() * myOrders.length)] : null;
    if (id) ok(http.get(`${BASE}/v1/orders/${id}`, { headers, tags: { name: 'GET /v1/orders/:id' } }), 'order');
    else ok(http.get(`${BASE}/v1/orders?limit=10`, { headers, tags: { name: 'GET /v1/orders' } }), 'my orders');
  } else {
    const lines = MIX === 'hotsku' ? 0 : 1 + Math.floor(Math.random() * 3);
    const seen = {};
    const items = MIX === 'hotsku' ? [{ productId: products[0], quantity: 1 }] : [];
    while (items.length < lines) {
      const p = pickProduct();
      if (!seen[p]) {
        seen[p] = true;
        items.push({ productId: p, quantity: 1 + Math.floor(Math.random() * 2) });
      }
    }
    const res = http.post(`${BASE}/v1/orders`, JSON.stringify({ items }), {
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': uuidish() },
      tags: { name: 'POST /v1/orders' },
    });
    checkoutLatency.add(res.timings.duration);
    if (ok(res, 'checkout', [201])) {
      ordersCreated.add(1);
      if (myOrders.length < 50) myOrders.push(res.json('id'));
    }
  }
}

// SLOs enforced as pass/fail thresholds in every profile.
export const SLO_THRESHOLDS = {
  http_req_failed: ['rate<0.001'], // < 0.1% errors
  http_req_duration: ['p(95)<50', 'p(99)<150'],
  checkout_latency: ['p(99)<250'],
  checks: ['rate>0.999'],
};

export function summaryTrendStats() {
  return ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'];
}
