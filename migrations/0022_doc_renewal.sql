-- 0022: a rider who sends a renewal early keeps working on the old, still-valid document until staff review the new one. Expand-only.
ALTER TABLE rider_docs ADD COLUMN valid_until date;
