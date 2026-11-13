# Capacity Report and Scaling Plan

**Status:** single-host benchmarks complete; 40,000 RPS certification on production-sized staging **not yet run** (procedure in §6).
**Code measured:** this repository. Runs marked † used the revision before the final checkout-transaction
change (§2.4); that change touched only the checkout path, and the read path is identical. Raw results: `loadtest/results/`.

This report separates what was **measured** from what is **derived**. The 40k RPS figure is a
derived plan built on measured per-request costs. It becomes a measured fact only after the
certification run in §6 passes. Nothing below should be read as "40k RPS demonstrated".

---

## 1. Test environment (measured)

| Item | Value |
|---|---|
| Host | 1 VM, **2 vCPU** (Intel Xeon @ 2.10 GHz), 8 GB RAM, CPU steal 0% (checked under load) |
| Co-located on the same 2 vCPU | API (1 Node 22 process), PostgreSQL 16, Redis 7, k6 load generator |
| Dataset | 100,000 products; up to 300k orders accumulated during runs |
| Traffic | Production mix (below), open-model arrival rate (k6 `constant-arrival-rate`) |
| Auth / limits | Every request carries a JWT (verified) and passes the Redis rate limiter (limits set high so the cost is measured but nothing is throttled) |
| SLO | p95 < 50 ms, p99 < 150 ms, errors < 0.1%, checkout p99 < 250 ms, achieved ≥ 98% of offered |

**Traffic mix** (`loadtest/k6/lib.js`): 52% product detail (80/20 hot-skewed), 15% product list,
10% live availability (uncached), 10% my-orders list, 5% order detail, **8% checkout** (1–3 line items,
real stock decrement, idempotency key, outbox event).

Because every component shares two cores, absolute throughput here is a **floor**, not the ceiling
of the software. The load generator alone used 0.3–0.5 vCPU. What transfers to production is the
**CPU cost per request of each component**, measured from `/proc` during each step.

## 2. Results (measured)

### 2.1 Step test: production mix, final code (`w1-shared-2vcpu.json`)

| Offered RPS | Achieved | p50 ms | p95 ms | p99 ms | Errors | API vCPU | PG vCPU | Redis vCPU | Host busy | SLO |
|---|---|---|---|---|---|---|---|---|---|---|
| 400 | 400 | 1.6 | 8.0 | 26.8 | 0% | 0.43 | 0.14 | 0.05 | 0.88 / 2 | ✅ |
| 800 | 800 | 1.7 | 12.4 | 36.1 | 0% | 0.59 | 0.21 | 0.08 | 1.22 / 2 | ✅ |
| 1,200 | 1,198 | 5.4 | 29.3 | 57.7 | 0.70% (shed) | 0.72 | 0.29 | 0.08 | 1.50 / 2 | ❌ errors |
| 1,600 | 1,587 | 9.6 | 70.8 | 148 | 35% (shed) | 0.68 | 0.35 | 0.06 | 1.60 / 2 | ❌ |

In every step, every error was a deliberate `503` from load shedding. There were no other 5xx
responses, timeouts or resets. Past the knee the shedder kept admitted-request latency bounded
instead of letting queues grow without limit.

### 2.2 Sustained, spike and soak runs

| Run | Requests | Result | p95 | p99 | Errors | Notes |
|---|---|---|---|---|---|---|
| **800 RPS × 5 min (final code)** | 239,990 | ✅ all thresholds | 7.4 ms | 15.2 ms | **0.00%** | checkout p99 28.9 ms; 18,780 orders |
| 1,100 RPS × 5 min † | 329,990 | ✅ | 12.3 ms | 24.9 ms | 0.04% (shed) | checkout 100% success; raw summary file was overwritten by the next row (figures from the run log) |
| 1,100 RPS × 5 min (final code) | 329,903 | ❌ errors | 22.5 ms | 45.2 ms | 1.87% (shed) | checkout 100% success; latency SLO met |
| 1,000 RPS × 5 min (final code) | 299,971 | ❌ errors | 17.9 ms | 35.3 ms | 0.48% (shed) | checkout 100% success |
| Spike 400 → 1,200 RPS in 10 s, hold 60 s † | 123,952 | ✅ | 18.0 ms | 39.6 ms | 0 non-shed failures | 0.83% shed at peak; checkout p99 92 ms |
| Soak 800 RPS × 12 min (1-min windows) † | ~576,000 | ✅ | — | 13.6–29.7 ms | ≤ 0.13% | RSS 212 → 215 MB, fds 34–44, PG conns 10–20: no leak trend |

**Reading the 1,000–1,200 RPS rows honestly:** the stack saturates this host between roughly
1,000 and 1,200 RPS. Repeated runs at the same rate shed anywhere from 0.04% to 1.9%. Latency
SLOs held in all of them; the error SLO failed whenever shedding passed 0.1%. The run-to-run
spread at the knee was larger than any effect I tried to isolate (§5, autovacuum). The **maximum
cleanly sustained rate on this host is 800 RPS** (5 minutes, zero errors, wide latency margin).

### 2.3 Per-request CPU cost (the transferable numbers)

| Path | API ms CPU/req | Postgres ms CPU/req | Redis ms CPU/req | Source |
|---|---|---|---|---|
| Production mix | **0.60–0.63** at 1,200 RPS (0.74 at 800) | **0.22–0.26** | **0.07** | step tests at 800–1,200 RPS |
| Browse only (reads) | 0.57 | 0.10 | 0.08 | `w1-browse-only.json` |
| Checkout only (writes) | 1.25 | **1.55** | 0.08 | `w1-checkout-only.json`, final code |

Cross-check: weighting the separately measured paths 8% / 92% predicts 0.62 ms (API) and 0.21 ms (PG)
for the mix, against 0.63 and 0.22 measured. The model is internally consistent.

Per-request API cost falls as utilization rises, because fixed per-process work (timers, GC,
metrics) is amortized over more requests: 0.74 ms at 800 RPS, 0.60–0.63 ms at 1,200. A pod at its
60% target serves ~960 RPS, between those points; the +15% overhead allowance in §3 covers the
difference (0.625 × 1.15 = 0.72 ms). The costs were measured on an oversubscribed host (context
switching, shared caches), so they are likely **pessimistic** for pods on dedicated vCPUs.

### 2.4 Hot-SKU (flash sale) ceiling (`hotsku-before.json`, `hotsku-after.json`)

Every checkout buys the same product, so all of them serialize on one inventory row lock.

| Version | Highest rate within SLO | Max achieved | p99 at 300/s |
|---|---|---|---|
| Lock taken mid-transaction (original) | 200 orders/s | 293/s | 171 ms |
| **Lock taken last, single statement (final)** | **300 orders/s** | **~405/s** | **58 ms** |

The change shortened the critical section (locks are now held only for one statement plus COMMIT)
and raised the single-SKU ceiling by about 38%. It is still the **tightest limit in the system**.
See §5.

### 2.5 Correctness under load (measured)

After all runs (168,419 orders, then again after the database process was **killed uncleanly**
and recovered from WAL), these checks returned zero violations:
`available + reserved = initial stock` for every product, `reserved = Σ pending order quantities`,
`order total = Σ lines`, every order has exactly one idempotency key and exactly one `OrderCreated`
outbox event, and no stock is negative. The concurrency suite (400 buyers for 50 units, opposite
lock-order multi-line orders, 50 concurrent retries of one idempotency key) passes on every run.

## 3. Capacity model for 40,000 RPS (derived)

Peak: 40,000 RPS with the production mix = **3,200 checkouts/s + 36,800 reads/s**.

| Tier | Demand at 40k RPS (measured cost × rate) | Provisioned | Peak utilization | After losing 1 of 3 AZs |
|---|---|---|---|---|
| API pods | 40,000 × 0.625 ms = 25.0 vCPU, +15% tracing/metrics/runtime overhead = **28.8 vCPU** | **72 pods × 1 vCPU** (HPA max 150) | 40% | 60% (= HPA target) |
| Aurora writer | 3,200 × 1.55 ms = **5.0 vCPU** (×2 allowance for WAL, vacuum, relay, replication ≈ 10 vCPU) | db.r7g.4xlarge (16 vCPU) | 31–62% | same (promotion target is the same class) |
| Aurora readers | 36,800 × 0.10 ms = **3.7 vCPU** | 2 × db.r7g.2xlarge (16 vCPU), autoscale to 6 | 23% | 46% if one reader is lost |
| Redis | 40,000 × 0.07 ms ≈ **2.8 vCPU**, ~80k commands/s | 6 shards × cache.r7g.xlarge (+1 replica each) | ~47% of each shard's command thread | replicas promote |
| Kafka (MSK) | ~3.5k events/s × ~1.5 KB ≈ 5 MB/s | 3 × kafka.m7g.large, RF=3 | low | min.insync=2 |
| DB connections | 72 pods × (10 writer + 10 reader) = 1,440 client conns | RDS Proxy (multiplexed) | — | — |
| Load generator | 40,000 × 0.34 ms ≈ 13.6 vCPU | 16 k6 runners × 2 vCPU | — | — |

Per pod: 1 vCPU ÷ 0.625 ms ≈ 1,600 RPS at 100% CPU. At the 60% HPA target that's **~960 RPS per pod**.
The HPA keeps pods at that level, and the 1.5× zone allowance means one AZ can fail at peak
without any pod going above target.

**Why the API tier scales linearly:** pods are stateless and share nothing except Postgres,
Redis and Kafka. Caches are per-pod (L1) or sharded (L2), rate limits are keyed per principal
and spread across Redis shards, and there's no cross-pod coordination on the request path.
Throughput per pod is therefore independent of pod count until a shared tier saturates. The
table shows when that happens. This is a design argument, not yet a measurement; §6 measures it.

### 100,000+ concurrent users

Users are connections to the ALB, not to pods. The ALB keeps its own pooled keep-alive
connections to pod IPs. 100,000 active users with a 2–6 s think time (mean 4 s) offer about
**25,000 RPS**, within the 40k plan. Per-user rate limiting (100-token burst, 50/s refill) and
WAF per-IP limits bound any single client. `loadtest/k6/concurrency.js` models this, but it needs
a distributed generator (about 100k VUs, roughly 100–200 GB RAM across runners), so it was **not
run here**.

## 4. Scaling beyond the initial capacity

| Load | What changes | Limit reached |
|---|---|---|
| up to ~95k RPS | HPA to 150 pods (already configured); Karpenter adds nodes; Aurora readers autoscale to 6; Redis add shards online | Aurora writer around 60–70% |
| ~100–150k RPS | Writer to db.r7g.8xlarge/16xlarge (vertical, minutes of failover); Redis to 12 shards; parallel outbox relays (partition by aggregate hash, one leader per partition) | single-writer write throughput |
| > 150k RPS or > ~10k checkouts/s | Split inventory/reservations into its own service and database; shard orders by `user_id`; Aurora Limitless or Citus for write scale-out | architectural change |

Reads scale almost without limit through caching and replicas. Long-term scaling is bounded by
**writes**: checkouts per second, and especially checkouts per second on one SKU.

## 5. Limitations and open items

1. **40k RPS is not yet demonstrated.** It is derived from measured per-request costs and a
   shared-nothing design. Certification in §6 is required before claiming it.
2. **Hot-SKU ceiling:** ~300 orders/s per single SKU within SLO here (local disk). On Aurora,
   commit latency is higher (storage quorum), so expect it to be **lower** (estimate 150–300/s;
   measure in §6). For flash sales above that: split one SKU's stock across N inventory rows
   ("bucketed stock", chosen by hash), a Redis reservation counter with a DB reconcile, or a
   virtual waiting room. The CHECK (`available >= 0`) constraint keeps oversell impossible
   regardless; the limit only affects throughput.
3. **Single active outbox relay.** It drained 126k–168k events at well over 3,000 events/s with
   a log publisher. Real Kafka (acks=all, batches of 500) still needs measuring, since 3.5k
   events/s at peak leaves limited headroom. Scale-out path: partitioned relays (§4).
4. **Autovacuum tuning** is environment-specific. A more aggressive variant was A/B tested here,
   and the result was inconclusive within run-to-run noise. Migration 0002 keeps only
   conservative threshold changes. Tune cost limits on staging during the soak. (A checkout run that
   overlapped a large autovacuum pass, p95 132 ms vs 33 ms normally, is kept as
   `checkout-during-autovacuum.json`.)
5. **Cold pods shed briefly:** a freshly started pod at full traffic share shed ~0.35% for a few
   seconds (JIT warm-up, empty L1 cache). Mitigated by ALB slow start (60 s) and HPA scale-up
   before saturation; verify in the spike test.
6. **Helm chart rendering was not executed in this workspace** (the Helm binary was not
   downloadable here). CI runs `helm lint`, `helm template` and kubeconform on every PR.
   Terraform **was** validated (`tofu validate`: success, no warnings).
7. **Cache-staleness window:** product data can be up to 300 s stale on other pods' L2 entries
   (invalidated on write, best effort) and up to 1 s in L1. List pages up to 30 s. Prices and
   stock used for checkout are always read inside the transaction, so staleness affects display
   only.

## 6. Certification procedure: proving 40,000 RPS

Run on **staging at production size** (`deploy/terraform/environments/staging.tfvars`, Helm
`values-staging.yaml`), with the k6-operator on a separate node pool. Seed ≥ 1M products and
≥ 50k user tokens.

| # | Test | Command | Pass criteria |
|---|---|---|---|
| 1 | Capacity probe | `stress.js` START=5000 PEAK=60000 RAMP=20m (16 runners) | knee > 48,000 RPS (20% margin over target) |
| 2 | **Load** | `deploy/k8s/loadtest-40k.yaml` (16 × 2,500 RPS, 30 min) | all `SLO_THRESHOLDS` pass |
| 3 | Spike | `spike.js` BASE_RATE=15000 SPIKE_RATE=45000 | 0 non-shed failures; p99 back to baseline < 60 s after spike; HPA scales |
| 4 | Soak | `soak.js` RATE=25000 DURATION=8h | thresholds pass; RSS slope < 1 MB/h per pod; p99 drift < 20% first vs last hour |
| 5 | Concurrency | `concurrency.js` USERS=100000 | thresholds pass |
| 6 | Hot SKU | MIX=hotsku step test | record the Aurora single-SKU ceiling; size bucketing if below business need |
| 7 | Chaos during #2 | kill 10% of API pods; drain one AZ's nodes; `aws rds failover-db-cluster`; ElastiCache primary failover; restart one MSK broker | error budget for the window holds (≤ 0.05%), no data-integrity violations (§2.5 queries) |

Record results in `loadtest/results/` with this report updated. Re-certify after any change to
the request path, the data tier sizing, or the Node/runtime major version. CI runs a 60-second
fixed-rate regression check on every PR (`perf-smoke`), and CD runs a 10-minute 20k RPS gate on
every staging deploy.

## 7. Reproducing the single-host numbers

```bash
npm ci && npm run build
DATABASE_URL=postgres://postgres@127.0.0.1:5432/shopcore npm run migrate
SEED_PRODUCTS=100000 SEED_STOCK=100000000 DATABASE_URL=... npm run seed
npm run dev:keys && npx tsx scripts/dev-keys.ts tokens 5000 loadtest/data/tokens.txt
source scripts/env-local.sh
export RATE_LIMIT_CAPACITY=1000000000 RATE_LIMIT_REFILL_PER_SEC=1000000000 \
       RATE_LIMIT_WRITE_CAPACITY=1000000000 RATE_LIMIT_WRITE_REFILL_PER_SEC=1000000000
node loadtest/step-test.mjs --workers 1 --rates 400,800,1200,1600 --step 30s --label my-run
node loadtest/step-test.mjs --mix checkout --rates 200,400,500 --label my-checkout
node loadtest/step-test.mjs --mix hotsku   --rates 200,300,400 --label my-hotsku
```
