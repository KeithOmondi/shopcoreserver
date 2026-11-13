-- 0008: customer profiles and the delivery/payment details staff need on an order.
-- The customer's id is their sign-in subject (the same uuid orders.user_id already holds).

CREATE TABLE customers (
  id          uuid PRIMARY KEY,
  name        text NOT NULL DEFAULT '' CHECK (length(name) <= 120),
  email       text NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  phone       text NOT NULL DEFAULT '' CHECK (length(phone) <= 32),
  area        text NOT NULL DEFAULT '' CHECK (length(area) <= 80),
  street      text NOT NULL DEFAULT '' CHECK (length(street) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);
CREATE INDEX customers_name_idx ON customers (lower(name));
CREATE INDEX customers_phone_idx ON customers (phone) WHERE phone <> '';

CREATE TABLE customer_notes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  by_id        text NOT NULL,
  by_name      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_notes_customer_idx ON customer_notes (customer_id, id DESC);

-- Expand-only: all nullable, so the running release keeps working during the rollout.
ALTER TABLE orders
  ADD COLUMN payment_method    text CHECK (payment_method IN ('mpesa', 'card', 'cod')),
  ADD COLUMN delivery_name     text,
  ADD COLUMN delivery_phone    text,
  ADD COLUMN delivery_area     text,
  ADD COLUMN delivery_address  text,
  ADD COLUMN paid_at           timestamptz,
  ADD COLUMN fulfilled_at      timestamptz,
  ADD COLUMN cancelled_at      timestamptz,
  ADD COLUMN cancel_reason     text;
-- Back-fill what we can for orders that already exist.
UPDATE orders SET paid_at = updated_at WHERE status IN ('PAID', 'FULFILLED') AND paid_at IS NULL;
UPDATE orders SET fulfilled_at = updated_at WHERE status = 'FULFILLED' AND fulfilled_at IS NULL;
UPDATE orders SET cancelled_at = updated_at WHERE status = 'CANCELLED' AND cancelled_at IS NULL;

CREATE INDEX orders_created_idx ON orders (created_at DESC, id DESC);
CREATE INDEX orders_status_created_idx ON orders (status, created_at DESC);

CREATE TABLE order_notes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  by_id       text NOT NULL,
  by_name     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_notes_order_idx ON order_notes (order_id, id);

-- Customers who already ordered get a (blank) profile so they show up in the admin.
INSERT INTO customers (id, created_at) SELECT user_id, min(created_at) FROM orders GROUP BY user_id ON CONFLICT DO NOTHING;
