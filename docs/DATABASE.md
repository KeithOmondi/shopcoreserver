# Database

Aurora PostgreSQL 16 (I/O-Optimized). Writer + 2–6 readers across 3 AZs, accessed through RDS
Proxy. Migrations in `migrations/` are forward-only and applied by a Helm pre-upgrade Job.

## Schema

```mermaid
erDiagram
  products ||--|| inventory : "stock"
  products ||--o{ order_items : "sold as"
  orders ||--|{ order_items : contains
  orders ||--|| idempotency_keys : "created by"
  products { uuid id PK; text sku UK; bigint price_cents; char currency; bool active; int version }
  inventory { uuid product_id PK,FK; int available "CHECK >= 0"; int reserved "CHECK >= 0" }
  orders { uuid id PK; uuid user_id; text status "CHECK enum"; bigint total_cents; int version }
  order_items { uuid order_id PK,FK; smallint line_no PK; uuid product_id FK; int quantity; bigint unit_price_cents }
  idempotency_keys { uuid user_id PK; text key PK; text request_hash; uuid order_id }
  outbox { bigint id PK; text aggregate_type; uuid aggregate_id; text event_type; jsonb payload }
  audit_log { bigint id PK; text actor_id; text action; text entity_id; jsonb data }
```

| Table | Purpose / key decisions |
|---|---|
| `products` | Catalog. Unique SKU, format CHECK. `version` for optimistic concurrency. |
| `inventory` | Kept narrow and separate so the hottest updated row is small; `fillfactor=70` for HOT updates; `available >= 0` is the oversell guard of last resort. |
| `orders` / `order_items` | Prices are snapshotted into items at purchase time. |
| `idempotency_keys` | Separate from orders so it can be purged (48 h) and orders can be partitioned later. |
| `outbox` | Transactional outbox; relay deletes rows after the broker acks. |
| `audit_log` | Append-only; the app role has no UPDATE/DELETE on it. |

## Indexes and the queries they serve

| Index | Query |
|---|---|
| `products_active_id_idx (id) WHERE active` | catalog keyset pagination |
| `orders_user_created_idx (user_id, created_at DESC, id DESC)` | "my orders" keyset pagination |
| `orders_pending_created_idx (created_at) WHERE status='PENDING_PAYMENT'` | unpaid-order expiry job |
| `order_items_product_idx (product_id)` | sales by product / reconciliation |
| `idempotency_keys_created_idx (created_at)` | retention purge |
| `audit_log_entity_idx (entity_type, entity_id, created_at DESC)` | audit lookups |

Every request-path query is a primary-key or index-range lookup with a `LIMIT`. There are no
OFFSET scans and no unbounded queries. UUIDv7 keys append to the right edge of B-trees.

## Concurrency rules

- Lock order for inventory is always `ORDER BY product_id`, and an order row is always locked
  before its inventory. This rules out deadlock cycles. Residual 40P01/40001 errors are retried.
- Session guards: `statement_timeout` 2 s (app) / 5 s (server), `idle_in_transaction_session_timeout`,
  `lock_timeout` 3 s; migrations use `lock_timeout` 5 s.

## Roles (least privilege)

```sql
CREATE ROLE shopcore_migrator LOGIN;          -- DDL; used only by the migration Job (direct writer endpoint)
CREATE ROLE shopcore_app LOGIN;               -- DML only; used via RDS Proxy
GRANT SELECT, INSERT, UPDATE, DELETE ON products, inventory, orders, order_items, idempotency_keys, outbox TO shopcore_app;
GRANT SELECT, INSERT ON audit_log TO shopcore_app;   -- append-only
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO shopcore_app;
```

## Growth plan

At 3,200 orders/s peak (typical daily average far lower), `orders` grows by tens of millions of
rows per day at sustained peak. Plan: range-partition `orders`/`order_items` by month (with
`pg_partman`) before 500M rows; UUIDv7 ids embed the timestamp, so `GET /orders/:id` can prune
partitions. Archive partitions older than 13 months to S3 (Parquet).

## Backup and recovery

- Continuous backup with **35-day point-in-time restore** (Aurora).
- AWS Backup daily/monthly snapshots, copied to the DR region into a **vault-locked** vault.
- Aurora Global Database secondary in `us-west-2` (RPO ≈ 1 s).
- Restore drills: quarterly (see RUNBOOK).
