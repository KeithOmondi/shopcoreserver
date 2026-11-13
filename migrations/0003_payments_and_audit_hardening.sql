-- 0003: payment reference on orders + make the audit trail genuinely append-only.
-- Expand-only and backward compatible: the previous release ignores the new nullable column.

ALTER TABLE orders
  ADD COLUMN payment_ref text CHECK (payment_ref IS NULL OR length(payment_ref) BETWEEN 1 AND 128);
-- The unique index is built CONCURRENTLY in 0004 so it never blocks writes on a large table.

-- audit_log: reject UPDATE/DELETE/TRUNCATE for every role, including the table owner.
-- (Retention must be done by dropping partitions or by a DBA temporarily disabling these triggers.)
CREATE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- Defence in depth: the application role gets no rewrite privileges where that role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopcore_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM shopcore_app;
  END IF;
END $$;
