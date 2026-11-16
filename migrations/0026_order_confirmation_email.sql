-- Order confirmation emails: the worker sends one email per order that has been placed and paid for (or is cash on delivery),
-- then stamps the order so it is never sent twice. Orders that already exist are stamped now so nobody gets old receipts.
ALTER TABLE orders ADD COLUMN confirmation_emailed_at timestamptz;
UPDATE orders SET confirmation_emailed_at = now();
CREATE INDEX orders_unconfirmed_idx ON orders (created_at) WHERE confirmation_emailed_at IS NULL AND status <> 'CANCELLED';
