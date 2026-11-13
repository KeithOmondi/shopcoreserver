#!/usr/bin/env node
// Repeatable capacity measurement on a single host.
//
// Starts the API with N worker processes pinned to dedicated cores, then runs k6 at a series of
// fixed arrival rates (open model). For each step it records achieved RPS, latency percentiles,
// error rate, and CPU-seconds consumed by each component (API, Postgres, Redis, load generator),
// read from /proc. Output: loadtest/results/<label>.json + a printed table.
//
//   node loadtest/step-test.mjs --workers 4 --api-cpus 0-3 --rates 4000,8000,12000 --step 30s --label w4
//
// The SLO used to define "sustainable": p95 < 50 ms, p99 < 150 ms, errors < 0.1%,
// achieved >= 98% of offered rate.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), []),
);
const workers = Number(args.workers ?? 1);
const apiCpus = args['api-cpus'] ?? '0';
const k6Cpus = args['k6-cpus'] ?? 'all';
const pinned = (cpus, cmd, argv) => (cpus === 'all' ? [cmd, argv] : ['taskset', ['-c', cpus, cmd, ...argv]]);
const rates = (args.rates ?? '1000,2000').split(',').map(Number);
const step = args.step ?? '30s';
const label = args.label ?? `w${workers}`;
const port = Number(args.port ?? 8080);
const TICKS = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim());

const SLO = { p95: 50, p99: 150, err: 0.001, achieved: 0.98 };

function pidsOf(pattern) {
  try {
    return execFileSync('pgrep', ['-f', pattern]).toString().trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
function cpuSeconds(pids) {
  let t = 0;
  for (const pid of pids) {
    try {
      const f = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const parts = f.slice(f.lastIndexOf(')') + 2).split(' ');
      t += (Number(parts[11]) + Number(parts[12]) + Number(parts[13]) + Number(parts[14])) / TICKS; // utime stime cutime cstime
    } catch {
      /* exited */
    }
  }
  return t;
}
function hostBusySeconds() {
  const [, ...v] = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/);
  const n = v.map(Number); // user nice system idle iowait irq softirq steal
  return (n[0] + n[1] + n[2] + n[5] + n[6] + n[7]) / TICKS;
}
function rssMb(pids) {
  let kb = 0;
  for (const pid of pids) {
    try {
      const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/);
      if (m) kb += Number(m[1]);
    } catch {
      /* exited */
    }
  }
  return Math.round(kb / 1024);
}

const env = { ...process.env, WORKERS: String(workers), PORT: String(port), LOG_LEVEL: 'warn' };
const api = spawn(...pinned(apiCpus, process.execPath, ['dist/src/server.js']), { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('API not ready');
}

const results = [];
try {
  await waitReady();
  await new Promise((r) => setTimeout(r, 1000));
  const apiPids = () => pidsOf('dist/src/server.js');
  const pgPids = () => pidsOf('postgres');
  const redisPids = () => pidsOf('redis-server');

  for (const rate of rates) {
    const out = path.join('/tmp', `k6-${label}-${rate}.json`);
    const before = { api: cpuSeconds(apiPids()), pg: cpuSeconds(pgPids()), redis: cpuSeconds(redisPids()), host: hostBusySeconds() };
    const t0 = Date.now();
    const k6 = spawn(
      ...pinned(k6Cpus, 'k6', ['run', '-q', '--no-thresholds', '--summary-export', out, '-e', `RATE=${rate}`, '-e', `DURATION=${step}`,
        '-e', `BASE_URL=http://127.0.0.1:${port}`, '-e', `MIX=${args.mix ?? 'production'}`, '-e', `VUS=${Math.max(50, Math.ceil(rate / 25))}`, '-e', `MAX_VUS=${Math.max(200, Math.ceil(rate / 5))}`, 'load.js']),
      { cwd: path.join(here, 'k6'), stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const k6Code = await new Promise((r) => k6.on('exit', r));
    const wall = (Date.now() - t0) / 1000;
    const after = { api: cpuSeconds(apiPids()), pg: cpuSeconds(pgPids()), redis: cpuSeconds(redisPids()), host: hostBusySeconds() };
    const s = JSON.parse(readFileSync(out, 'utf8')).metrics;
    const reqs = s.http_reqs.count;
    const dur = s.http_req_duration;
    const achieved = s.http_reqs.rate;
    const row = {
      offered: rate,
      achieved: Math.round(achieved),
      requests: reqs,
      p50: +dur.med.toFixed(2),
      p95: +dur['p(95)'].toFixed(2),
      p99: +dur['p(99)'].toFixed(2),
      max: +dur.max.toFixed(1),
      errRate: +(s.http_req_failed.value ?? s.http_req_failed.rate ?? 0).toFixed(5),
      checkoutP99: s.checkout_latency ? +s.checkout_latency['p(99)'].toFixed(2) : null,
      orders: s.orders_created?.count ?? 0,
      droppedIterations: s.dropped_iterations?.count ?? 0,
      apiCpuCores: +((after.api - before.api) / wall).toFixed(2),
      pgCpuCores: +((after.pg - before.pg) / wall).toFixed(2),
      redisCpuCores: +((after.redis - before.redis) / wall).toFixed(2),
      hostBusyCores: +((after.host - before.host) / wall).toFixed(2),
      apiRssMb: rssMb(apiPids()),
      k6Exit: k6Code,
    };
    row.loadGenCpuCores = +(row.hostBusyCores - row.apiCpuCores - row.pgCpuCores - row.redisCpuCores).toFixed(2);
    row.apiCpuMsPerReq = +((row.apiCpuCores * 1000) / Math.max(1, achieved)).toFixed(4);
    row.pgCpuMsPerReq = +((row.pgCpuCores * 1000) / Math.max(1, achieved)).toFixed(4);
    row.redisCpuMsPerReq = +((row.redisCpuCores * 1000) / Math.max(1, achieved)).toFixed(4);
    row.meetsSlo =
      row.p95 < SLO.p95 && row.p99 < SLO.p99 && row.errRate < SLO.err && achieved >= rate * SLO.achieved;
    results.push(row);
    console.log(
      `${label} offered=${rate} achieved=${row.achieved} p50=${row.p50} p95=${row.p95} p99=${row.p99} err=${row.errRate} ` +
        `apiCPU=${row.apiCpuCores} pgCPU=${row.pgCpuCores} redisCPU=${row.redisCpuCores} k6CPU=${row.loadGenCpuCores} host=${row.hostBusyCores} rss=${row.apiRssMb}MB slo=${row.meetsSlo ? 'PASS' : 'FAIL'}`,
    );
    if (!row.meetsSlo && results.filter((r) => !r.meetsSlo).length >= 2) break; // two consecutive-ish failures: past the knee
    await new Promise((r) => setTimeout(r, 3000));
  }
} finally {
  api.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 7000));
}

const best = results.filter((r) => r.meetsSlo).sort((a, b) => b.achieved - a.achieved)[0];
const summary = {
  label,
  workers,
  apiCpus,
  host: { cpus: readdirSync('/sys/devices/system/cpu').filter((d) => /^cpu\d+$/.test(d)).length, model: readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s+:\s+(.*)/)?.[1] },
  node: process.version,
  slo: SLO,
  step,
  mix: args.mix ?? 'production',
  maxSustainableRps: best?.achieved ?? 0,
  rpsPerWorkerAtMax: best ? Math.round(best.achieved / workers) : 0,
  steps: results,
  measuredAt: new Date().toISOString(),
};
mkdirSync(path.join(here, 'results'), { recursive: true });
writeFileSync(path.join(here, 'results', `${label}.json`), JSON.stringify(summary, null, 2));
console.log(`\n${label}: max sustainable within SLO = ${summary.maxSustainableRps} RPS (${summary.rpsPerWorkerAtMax}/worker)`);
