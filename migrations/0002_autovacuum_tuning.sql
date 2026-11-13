-- 0002: autovacuum thresholds for the two tables where bloat is the real risk.
--
-- inventory: every order rewrites these rows (MVCC). Default triggers (20% of 100k+ rows dead)
--   let dead versions pile up on exactly the pages HOT updates need free space on.
-- outbox: an insert-then-delete queue; default triggers let it bloat between relays.
--
-- Deliberately NOT changed here: autovacuum_vacuum_cost_limit and the settings for
-- append-mostly tables (orders, order_items, idempotency_keys). A more aggressive variant
-- (cost_limit 2000 + insert-triggered vacuums on every table) was tried in load testing on a
-- 2-vCPU host where Postgres shares cores with the API; it showed no measurable benefit and
-- possibly more CPU contention (the A/B was inconclusive: run-to-run noise at that host's
-- saturation point was larger than the difference). Those knobs are environment-specific:
-- tune them on staging under the soak profile (docs/CAPACITY.md, "Open items").
-- ALTER TABLE ... SET (storage params) takes only a SHARE UPDATE EXCLUSIVE lock: safe online.

ALTER TABLE inventory SET (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 5000
);

ALTER TABLE outbox SET (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 10000
);
