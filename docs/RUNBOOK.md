# Runbook: Operations, Incidents and Disaster Recovery

SLOs: availability 99.95% / 30 days (non-shed 5xx), p99 < 150 ms, checkout p99 < 250 ms.
Dashboards: RED per route, pool/breaker/cache/outbox panels, Aurora Performance Insights.

## Observability map
| Signal | Where | Key series |
|---|---|---|
| Metrics | Prometheus (`:9464/metrics`) | `http_request_duration_seconds`, `load_shed_total`, `circuit_breaker_state`, `db_pool_connections`, `db_tx_retries_total`, `cache_events_total`, `rate_limited_total`, `orders_created_total`, `outbox_oldest_event_age_seconds`, Node runtime (event loop lag, heap, GC) |
| Traces | OTel → X-Ray/Tempo (5% parent-based sampling) | http → fastify → pg / ioredis / kafkajs spans |
| Logs | stdout JSON → Fluent Bit → CloudWatch/OpenSearch | `trace_id` on every line; all errors and slow requests (≥ 250 ms), 1% sample of the rest |

## Alerts and responses

### High error rate
`ShopcoreErrorBudgetFastBurn`. 1) Check `/health/deps` and `circuit_breaker_state`.
2) Check a recent deploy: if yes, `kubectl argo rollouts abort shopcore-api` or roll back.
3) Errors by route and code in logs (`level=error`), filtered by `trace_id`.

### High latency
`ShopcoreHighLatencyP99`. Check CPU vs HPA (at max?), `db_pool_connections{state="waiting"}`,
Aurora Performance Insights top SQL, `db_tx_retries_total` (hot-row contention → see Flash sales),
Redis CPU per shard.

### Load shedding
`ShopcoreLoadShedding`. HPA is behind or at max. `kubectl -n shopcore scale` won't stick under the
HPA; raise `minReplicas` with `kubectl patch hpa shopcore-api -p '{"spec":{"minReplicas":80}}'`.
Check Karpenter for pending pods (`kubectl get nodeclaims`) and the `cpu: 600` NodePool limit.

### Dependency outage
- **Redis:** service continues (DB-backed reads, per-pod limits). Watch Aurora reader CPU: readers
  autoscale, and you can add one manually with `aws rds create-db-instance ...`. ElastiCache fails over automatically.
- **Aurora writer:** automatic failover to the tier-1 reader (~30 s); RDS Proxy holds client
  connections. Checkouts get 503 during the window; clients retry with the same idempotency key.
- **Kafka:** no customer impact; outbox grows. Alert `ShopcoreOutboxLag` once brokers are back:
  confirm the age drops to 0.

### Outbox lag
1) `kubectl logs deploy/shopcore-worker` for publish errors. 2) Is any worker the leader
(`outbox relay: acquired leadership`)? 3) `SELECT count(*), min(created_at) FROM outbox;`
4) If the leader is wedged, delete its pod; the standby takes over within ~1 s.

## Planned high-traffic events (flash sales)
1. T-24h: confirm the expected peak against CAPACITY.md; pre-scale `minReplicas` to 72+, Aurora readers to 4+.
2. Single-SKU demand above ~150–300 orders/s per SKU (measure on staging) → enable bucketed stock
   for that SKU, or put a waiting room in front of the sale page.
3. T-1h: warm caches (crawl the sale products), verify dashboards and on-call.
4. After: return `minReplicas` to baseline.

## Disaster recovery

| Scenario | RPO | RTO | Procedure |
|---|---|---|---|
| Pod / node / AZ loss | 0 | automatic (s–min) | none: capacity is planned for the loss of 1 AZ |
| Aurora instance failure | 0 | ~30 s | automatic failover |
| Data corruption / bad write (logical) | to the second | 1–2 h | PITR restore (below) |
| Region loss | ~1 s | < 1 h | Global DB failover (below) |

**Point-in-time restore**
```bash
aws rds restore-db-cluster-to-point-in-time --source-db-cluster-identifier shopcore-production \
  --db-cluster-identifier shopcore-restore-$(date +%s) --restore-to-time 2026-01-01T12:00:00Z --use-latest-restorable-time false
# add an instance, verify with the integrity queries (CAPACITY.md §2.5), then either
# repoint the secret DATABASE_URL to the restored cluster, or copy the affected rows back.
```

**Region failover**
1. Declare the incident; freeze deploys.
2. `aws rds failover-global-cluster --global-cluster-identifier shopcore-production-global --target-db-cluster-identifier <dr-cluster-arn> --allow-data-loss` (only when the primary region is unreachable).
3. `terraform apply -var-file=environments/production-dr.tfvars` in the DR region (EKS, Redis, MSK, edge). Same modules, different region.
4. Update the secret and deploy the same image tag with Helm; switch Route 53 to the DR ALB.
5. Reconcile: compare the last outbox ids and Kafka offsets; consumers dedupe by `event-id`.

**Drills:** quarterly PITR restore with integrity verification; twice yearly a regional failover
game day on staging; monthly chaos during the staging load gate (pod kill, AZ drain, DB failover).
