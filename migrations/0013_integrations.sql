-- 0013: M-Pesa payment requests and uploaded files. Expand-only.

-- One row per prompt sent to a customer's phone. The callback finds its order through the CheckoutRequestID.
CREATE TABLE mpesa_requests (
  id                    uuid PRIMARY KEY,
  order_id              uuid NOT NULL REFERENCES orders (id),
  customer_id           uuid NOT NULL,
  phone                 text NOT NULL,
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  checkout_request_id   text NOT NULL,
  merchant_request_id   text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'cancelled')),
  result_code           integer,
  result_desc           text,
  receipt               text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mpesa_requests_checkout_key ON mpesa_requests (checkout_request_id);
CREATE INDEX mpesa_requests_order_idx ON mpesa_requests (order_id, created_at DESC);

CREATE TABLE uploads (
  id            uuid PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('rider-document', 'banner', 'return-photo', 'delivery-photo', 'avatar', 'product-image')),
  owner_id      text NOT NULL,
  owner_type    text NOT NULL CHECK (owner_type IN ('staff', 'rider', 'customer', 'service')),
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL,
  file_name     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_owner_idx ON uploads (owner_type, owner_id, created_at DESC);
