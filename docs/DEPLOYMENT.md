# Deployment

## Infrastructure requirements (production, 40k RPS peak)

| Component | Spec |
|---|---|
| Region / AZs | us-east-1, 3 AZs; DR us-west-2 |
| EKS | 1.31; system node group 3 × m7g.large; Karpenter app pool (c7g/m7g 2xl–4xl, on-demand) |
| API | 30–150 pods (72 at 40k peak), 1 vCPU / 512 Mi request, 768 Mi limit |
| Worker | 2 pods (leader + standby) |
| Aurora PG 16 | writer db.r7g.4xlarge, 2–6 readers (r7g.4xlarge promotion tier + r7g.2xlarge), RDS Proxy, Global DB |
| ElastiCache Redis 7.1 | cluster mode, 6 shards × cache.r7g.xlarge + 1 replica each |
| MSK | 3 × kafka.m7g.large, RF 3, min.insync 2 |
| Edge | ALB + WAF; ACM certificate |
| Add-ons | AWS Load Balancer Controller, External Secrets, Karpenter, Argo Rollouts, kube-prometheus-stack, OTel Collector, Fluent Bit |

## First-time setup
1. Bootstrap state: an S3 bucket (versioned, encrypted) and a DynamoDB lock table per account.
2. `terraform -chdir=deploy/terraform init -backend-config="bucket=..." -backend-config="dynamodb_table=..." -backend-config="region=us-east-1"`
3. `terraform -chdir=deploy/terraform apply -var-file=environments/production.tfvars`
4. Install cluster add-ons (Helm), apply `deploy/k8s/karpenter-nodepool.yaml`.
5. Create the DB roles (DATABASE.md §Roles). Populate secret `shopcore/production/app` with
   `DATABASE_URL` (proxy writer, app role), `DATABASE_READ_URL` (proxy reader endpoint),
   `DATABASE_MIGRATION_URL` (cluster writer, migrator role) and `REDIS_URL` (`rediss://:token@cfg-endpoint:6379`).
6. Deploy: `helm upgrade --install shopcore deploy/helm/shopcore -n shopcore --create-namespace -f deploy/helm/shopcore/values-production.yaml --set image.tag=<sha>`

## Pipeline (`.github/workflows`)
- **ci.yml** (every PR): lint, typecheck, `npm audit`, unit, integration + e2e against real
  Postgres/Redis, 60 s perf regression check, multi-arch image build + Trivy, Terraform
  fmt/validate, Trivy IaC, Helm lint + kubeconform.
- **cd.yml** (main): push an immutable image (SBOM, provenance) → staging deploy (migrations
  hook) → smoke → **10-min 20k RPS load gate** → manual approval → production canary
  5% → 25% → 50% → 100%, gated on Prometheus error-rate and p99 analysis.

## Zero-downtime guarantees
- Rolling/canary with `maxUnavailable: 0`; readiness gates traffic; startup probe for slow boots.
- Shutdown sequence: preStop sleep 10 s → SIGTERM → readiness fails → 5 s drain → server closes
  (in-flight requests finish) → pools close. Grace period 45 s > ALB deregistration delay 30 s.
  Verified in e2e (`drains gracefully on SIGTERM`).
- ALB slow start 60 s warms new pods.
- **Expand/contract migrations only.** Each release must work against both the old and new
  schema: add nullable columns or new tables first; backfill in batches; switch reads;
  drop in a later release. `CREATE INDEX CONCURRENTLY IF NOT EXISTS` goes in its own file
  named `NNNN_name.notx.sql`, which the runner executes outside a transaction. `lock_timeout` stops a
  migration from queueing behind traffic.

## Rollback
- **Application:** `gh workflow run cd.yml -f rollback_to=<previous-sha>`, or
  `kubectl argo rollouts abort shopcore-api` (instant shift back to stable) / `helm rollback shopcore <rev>`.
  Images are immutable, so the rollback is bit-for-bit what ran before.
- **Schema:** forward-only. Because migrations are backward compatible, rolling the app back
  never needs a schema rollback. A bad migration is fixed with a new forward migration.
- **Infrastructure:** revert the Terraform commit and apply; Aurora deletion protection and final
  snapshots prevent destructive mistakes.
