# ShopCore: high-throughput e-commerce orders API

Node.js 22 / TypeScript / Fastify · PostgreSQL (Aurora) · Redis (ElastiCache) · Kafka (MSK) · EKS · Terraform

Catalog, inventory and order management, designed for **40,000 RPS** and **100,000+ concurrent
users**, with strict data integrity (no oversell, no duplicate orders, no lost events).

| Read | For |
|---|---|
| [docs/CAPACITY.md](docs/CAPACITY.md) | **Benchmarks, capacity model, limits, how to certify 40k RPS** |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, request path, resilience matrix |
| [docs/API.md](docs/API.md) | Endpoints, errors, idempotency, events |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, indexes, locking rules, backups |
| [docs/SECURITY.md](docs/SECURITY.md) | Security model and threat controls |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Infra requirements, CI/CD, zero-downtime, rollback |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Alerts, incident response, disaster recovery |

## Status, plainly
- ✅ 44 automated tests (unit, integration against real Postgres + Redis, concurrency, resilience, e2e on the compiled server).
- ✅ Load-tested on a 2-vCPU host with everything co-located: **800 RPS sustained, 0 errors, p99 15 ms**;
  knee at ~1,000–1,200 RPS; spike, soak and data-integrity checks passed. Per-request CPU cost measured per component.
- ✅ Terraform validated; Helm chart and pipelines written (Helm rendering runs in CI).
- ⏳ **40k RPS is a derived plan (72 pods + sized data tier), not yet demonstrated.** Run the
  certification in CAPACITY.md §6 on production-sized staging before relying on it.

## Quick start (local)
```bash
npm ci
docker compose up -d postgres redis            # or local Postgres 16 / Redis 7
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/shopcore
npm run migrate && npm run seed && npm run dev:keys
source scripts/env-local.sh && npm run dev
npx tsx scripts/dev-keys.ts token "$(uuidgen)" customer   # dev token
```

## Tests
```bash
# needs Postgres with an empty database `shopcore_test` (it is reset) + Redis; override with TEST_DATABASE_URL / TEST_REDIS_URL
npm run build && npm test
```

## Load tests
`loadtest/k6/{load,stress,spike,soak,concurrency}.js` share one traffic model (`lib.js`) and the SLO
thresholds. `loadtest/step-test.mjs` measures throughput and per-component CPU cost per step.
`deploy/k8s/loadtest-40k.yaml` runs the 40k certification with the k6-operator.

## Layout
```
src/            application (config, domain, infra, http, modules, workers)
migrations/     forward-only SQL migrations
scripts/        migrate, seed, dev keys/tokens, CI helpers
test/           unit / integration / e2e
loadtest/       k6 profiles, step-test driver, results/
deploy/         terraform/ (AWS), helm/shopcore/, k8s/ (Karpenter, k6 TestRun)
.github/        CI and CD pipelines
docs/           architecture, API, database, security, deployment, runbook, capacity
```
