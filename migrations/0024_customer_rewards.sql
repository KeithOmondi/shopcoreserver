-- 0024: shopper points and referrals. Expand-only.
ALTER TABLE customers
  ADD COLUMN referral_code        text,
  ADD COLUMN referred_by          uuid REFERENCES customers (id) ON DELETE SET NULL,
  ADD COLUMN referral_rewarded_at timestamptz;
UPDATE customers SET referral_code = upper(substr(md5(id::text), 1, 8)) WHERE referral_code IS NULL;
CREATE UNIQUE INDEX customers_referral_code_key ON customers (referral_code);
ALTER TABLE customer_signups ADD COLUMN referral_code text;

-- Every change to a shopper's points. The balance is the sum, so nothing can drift.
CREATE TABLE points_ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('earned', 'referral', 'welcome', 'redeemed', 'adjusted')),
  points       integer NOT NULL CHECK (points <> 0),
  order_id     uuid REFERENCES orders (id) ON DELETE SET NULL,
  coupon_code  text,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX points_ledger_customer_idx ON points_ledger (customer_id, id DESC);
-- An order earns points once, however many times delivery is confirmed.
CREATE UNIQUE INDEX points_ledger_order_once ON points_ledger (order_id) WHERE kind = 'earned';
