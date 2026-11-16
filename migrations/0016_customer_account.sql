-- 0016: shopper addresses, preferences, birth date and phone change. Expand-only.

-- Which county a delivery zone is in, so the app only offers places the shop really delivers to.
ALTER TABLE zones ADD COLUMN county text NOT NULL DEFAULT 'Nairobi' CHECK (length(county) BETWEEN 1 AND 40);

ALTER TABLE customers
  ADD COLUMN dob date,
  ADD COLUMN notify_topics jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE customer_addresses (
  id           uuid PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  label        text NOT NULL DEFAULT 'Home' CHECK (label IN ('Home', 'Work', 'Other')),
  full_name    text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 120),
  phone        text NOT NULL CHECK (phone ~ '^\+254[17]\d{8}$'),
  county       text NOT NULL CHECK (length(county) BETWEEN 1 AND 40),
  area         text NOT NULL CHECK (length(area) BETWEEN 1 AND 60),
  street       text NOT NULL CHECK (length(street) BETWEEN 3 AND 200),
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses (customer_id, created_at);
-- At most one default address per person.
CREATE UNIQUE INDEX customer_addresses_default_key ON customer_addresses (customer_id) WHERE is_default;

-- A new phone number waiting for its code. The old number stays in use until the code is entered.
CREATE TABLE customer_phone_changes (
  customer_id  uuid PRIMARY KEY REFERENCES customers (id) ON DELETE CASCADE,
  new_phone    text NOT NULL,
  code_hash    text NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
