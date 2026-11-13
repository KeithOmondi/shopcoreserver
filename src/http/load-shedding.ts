import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';

export type Priority = 'critical' | 'normal';

/**
 * Adaptive, priority-aware load shedding.
 *
 * When the event loop is saturated, accepting more work only increases latency for
 * everyone (queueing collapse). We reject early with 503 + Retry-After so admitted
 * requests keep bounded latency, the load balancer shifts traffic, and the HPA has
 * time to add pods.
 *
 * Rather than flipping between "accept all" and "reject all" (which oscillates), the
 * rejection probability for normal-priority traffic is adjusted AIMD-style every
 * sample: +15 points while overloaded, -5 points while healthy. Critical traffic
 * (checkout, payment confirmation) is never shed probabilistically; only the hard
 * in-flight cap applies to it, so revenue paths degrade last.
 *
 * Signals (sampled every 250 ms, not per request):
 *   - p99 event-loop delay over the window
 *   - event-loop utilization over the window
 *   - in-flight request count (hard cap, checked per request)
 */
export class LoadShedder {
  private readonly hist = monitorEventLoopDelay({ resolution: 10 });
  private lastElu: EventLoopUtilization = performance.eventLoopUtilization();
  private timer: NodeJS.Timeout;
  inflight = 0;
  shedProbability = 0;
  lastDelayMs = 0;
  lastUtilization = 0;

  constructor(
    private readonly maxDelayMs: number,
    private readonly maxUtilization: number,
    private readonly maxInflight: number,
    private readonly random: () => number = Math.random,
  ) {
    this.hist.enable();
    this.timer = setInterval(() => this.sample(), 250);
    this.timer.unref();
  }

  /** Visible for tests. */
  sample(delayMs?: number, utilization?: number) {
    this.lastDelayMs = delayMs ?? this.hist.percentile(99) / 1e6;
    this.hist.reset();
    if (utilization === undefined) {
      const elu = performance.eventLoopUtilization(this.lastElu);
      this.lastElu = performance.eventLoopUtilization();
      this.lastUtilization = elu.utilization;
    } else {
      this.lastUtilization = utilization;
    }
    const overloaded =
      (this.maxDelayMs > 0 && this.lastDelayMs > this.maxDelayMs) ||
      (this.maxUtilization < 1 && this.lastUtilization > this.maxUtilization);
    this.shedProbability = overloaded
      ? Math.min(0.95, this.shedProbability + 0.15)
      : Math.max(0, this.shedProbability - 0.05);
  }

  shouldShed(priority: Priority = 'normal'): boolean {
    if (this.inflight >= this.maxInflight) return true;
    if (priority === 'critical') return false;
    return this.shedProbability > 0 && this.random() < this.shedProbability;
  }

  stop() {
    clearInterval(this.timer);
    this.hist.disable();
  }
}
