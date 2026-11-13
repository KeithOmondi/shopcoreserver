import pino, { type Logger } from 'pino';
import { trace } from '@opentelemetry/api';

/**
 * Structured JSON logs to stdout (collected by Fluent Bit -> CloudWatch/OpenSearch).
 * Every line carries trace_id/span_id when a span is active so logs and traces correlate.
 * Secrets and PII-bearing headers are redacted at the serializer level.
 */
export function createLogger(opts: { level: string; service: string }): Logger {
  return pino({
    level: opts.level,
    base: { service: opts.service, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: { level: (label) => ({ level: label }) },
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const ctx = span.spanContext();
      return { trace_id: ctx.traceId, span_id: ctx.spanId };
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        '*.password',
        '*.token',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },
  });
}
