-- 0004: a payment reference can settle at most one order.
-- CONCURRENTLY: no write lock on orders. Cannot run in a transaction (hence .notx.sql).
-- If a previous attempt failed it leaves an INVALID index: DROP INDEX orders_payment_ref_uniq and re-run.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS orders_payment_ref_uniq
  ON orders (payment_ref) WHERE payment_ref IS NOT NULL;
