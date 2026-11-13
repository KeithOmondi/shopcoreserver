import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeys, mint } from '../../scripts/dev-keys.js';
import { resetDatabase, TEST_DB, TEST_REDIS } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';

/**
 * End-to-end: the compiled artifact (dist/) runs as a real OS process, exactly as in
 * the container, and is exercised over real HTTP. Requires `npm run build` first.
 */
const ROOT = path.resolve(__dirname, '../..');
const PORT = 18080 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;
let keys: { publicPem: string; privatePem: string };
let exitCode: Promise<number | null>;
const ISS = 'https://auth.e2e/';
const AUD = 'shopcore-e2e';

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health/ready`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready');
}

beforeAll(async () => {
  if (!existsSync(path.join(ROOT, 'dist/src/server.js'))) throw new Error('run `npm run build` before e2e tests');
  await resetDatabase();
  keys = await generateKeys();
  proc = spawn(process.execPath, ['dist/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      METRICS_PORT: String(PORT + 1000),
      LOG_LEVEL: 'warn',
      DATABASE_URL: TEST_DB,
      REDIS_URL: TEST_REDIS,
      JWT_ISSUER: ISS,
      JWT_AUDIENCE: AUD,
      JWT_ALGORITHMS: 'EdDSA',
      JWT_PUBLIC_KEY: keys.publicPem,
      SHUTDOWN_GRACE_MS: '1500',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  exitCode = new Promise((r) => proc.on('exit', (code) => r(code)));
  await waitReady();
});

afterAll(() => {
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

describe('e2e: compiled server over HTTP', () => {
  it('runs a full purchase flow', async () => {
    const admin = await mint(keys.privatePem, uuidv7(), ['admin'], 600, ISS, AUD);
    const user = await mint(keys.privatePem, uuidv7(), ['customer'], 600, ISS, AUD);
    const payments = await mint(keys.privatePem, uuidv7(), ['payments'], 600, ISS, AUD);
    const json = { 'content-type': 'application/json' };

    const created = await fetch(`${BASE}/v1/products`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${admin}` },
      body: JSON.stringify({ sku: 'E2E-1', name: 'E2E', priceCents: 1999, currency: 'USD', initialStock: 3 }),
    });
    expect(created.status).toBe(201);
    const product = await created.json();

    const view = await fetch(`${BASE}/v1/products/${product.id}`);
    expect(view.status).toBe(200);
    expect(view.headers.get('x-content-type-options')).toBe('nosniff'); // security headers present

    const ord = await fetch(`${BASE}/v1/orders`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${user}`, 'idempotency-key': 'e2e-key-0001' },
      body: JSON.stringify({ items: [{ productId: product.id, quantity: 2 }] }),
    });
    expect(ord.status).toBe(201);
    const order = await ord.json();
    expect(order.totalCents).toBe(3998);

    const paid = await fetch(`${BASE}/v1/orders/${order.id}/payment-confirmation`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${payments}` },
      body: JSON.stringify({ paymentRef: 'pi_e2e', amountCents: 3998, currency: 'USD' }),
    });
    expect((await paid.json()).status).toBe('PAID');

    const avail = await fetch(`${BASE}/v1/products/${product.id}/availability`);
    expect((await avail.json()).available).toBe(1);

    const metrics = await (await fetch(`http://127.0.0.1:${PORT + 1000}/metrics`)).text();
    expect(metrics).toMatch(/http_request_duration_seconds_bucket/);
    expect(metrics).toMatch(/orders_created_total\{result="created"\} 1/);
  });

  // Windows has no POSIX signals: kill('SIGTERM') hard-terminates the process, so graceful drain is Linux/CI-only.
  it.skipIf(process.platform === 'win32')('drains gracefully on SIGTERM: fails readiness, finishes in-flight work, exits 0', async () => {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    const ready = await fetch(`${BASE}/health/ready`);
    expect(ready.status).toBe(503);
    // Still serving during the drain window (LB deregistration in progress).
    const live = await fetch(`${BASE}/v1/products`);
    expect(live.status).toBe(200);
    expect(await exitCode).toBe(0);
  });
});
