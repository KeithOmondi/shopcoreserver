import cluster from 'node:cluster';
import http from 'node:http';
import { loadConfig } from './config/index.js';
import { createLogger } from './infra/logger.js';
import { registry } from './infra/metrics.js';
import { createContainer } from './container.js';
import { buildApp } from './http/app.js';

/**
 * Process entrypoint.
 * In Kubernetes run WORKERS=1 (one process per pod, scale with pods; the kubelet
 * and HPA see real per-process CPU). WORKERS>1 uses node:cluster for bare VMs and
 * for single-host benchmarking.
 */
async function startWorker() {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.LOG_LEVEL, service: cfg.SERVICE_NAME });

  process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => {
    // State may be corrupt after an uncaught exception: log, then exit and let the orchestrator restart us.
    log.fatal({ err }, 'uncaughtException; exiting');
    setTimeout(() => process.exit(1), 100).unref();
  });

  const container = await createContainer(cfg, log);
  const app = await buildApp(container);

  let metricsServer: http.Server | undefined;
  if (cfg.METRICS_ENABLED && cluster.isPrimary) {
    // Separate port: metrics are scraped in-cluster and never exposed through the ingress.
    metricsServer = http.createServer(async (req, res) => {
      if (req.url !== '/metrics') {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('content-type', registry.contentType);
      res.end(await registry.metrics());
    });
    metricsServer.listen(cfg.METRICS_PORT, cfg.HOST);
  }

  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  log.info({ port: cfg.PORT, pid: process.pid }, 'listening');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutdown: draining');
    // 1. Fail readiness so the endpoint is removed from the Service / target group.
    container.setShuttingDown();
    // 2. Keep serving while the removal propagates (kube-proxy, ALB deregistration).
    //    The pod's preStop sleep covers most of this; the grace here covers the rest.
    const hardStop = setTimeout(() => {
      log.error('shutdown: grace period exceeded, forcing exit');
      process.exit(1);
    }, cfg.SHUTDOWN_GRACE_MS + 10_000);
    hardStop.unref();
    await new Promise((r) => setTimeout(r, Math.min(5000, cfg.SHUTDOWN_GRACE_MS)));
    // 3. Stop accepting, finish in-flight requests, then release pools.
    await app.close();
    metricsServer?.close();
    await container.close();
    log.info('shutdown: complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function main() {
  const workers = Number(process.env.WORKERS ?? 1);
  if (workers > 1 && cluster.isPrimary) {
    let stopping = false;
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on('exit', (w, code) => {
      if (stopping) {
        // Primary exits once the last worker has drained.
        if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
        return;
      }
      console.error(JSON.stringify({ level: 'error', msg: 'worker exited; restarting', pid: w.process.pid, code }));
      cluster.fork();
    });
    const stop = () => {
      if (stopping) return;
      stopping = true;
      for (const w of Object.values(cluster.workers ?? {})) w?.process.kill('SIGTERM');
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    return;
  }
  await startWorker();
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'startup failed', err: String(err?.stack ?? err) }));
  process.exit(1);
});
