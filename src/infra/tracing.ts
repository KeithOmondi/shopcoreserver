/**
 * OpenTelemetry bootstrap. Load before the app with:  node --require ./dist/src/infra/tracing.js dist/src/server.js
 * Auto-instruments http, fastify, pg, ioredis and kafkajs; exports OTLP/gRPC to the
 * OpenTelemetry Collector DaemonSet, which forwards to AWS X-Ray / Tempo / Jaeger.
 * Sampling is controlled by the standard OTEL_TRACES_SAMPLER(_ARG) env vars
 * (production default: parentbased_traceidratio at 0.05).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

if (process.env.OTEL_ENABLED === 'true' || process.env.OTEL_ENABLED === '1') {
  const sdk = new NodeSDK({
    serviceName: process.env.SERVICE_NAME ?? 'shopcore-api',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();
  const stop = () => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
