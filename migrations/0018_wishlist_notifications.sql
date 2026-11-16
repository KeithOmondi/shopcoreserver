-- 0018: the shopper's saved items, and when they last looked at their notifications.
CREATE TABLE wishlist_items (
  customer_id  uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);
CREATE INDEX wishlist_customer_idx ON wishlist_items (customer_id, added_at DESC);

CREATE TABLE customer_notification_state (
  customer_id  uuid PRIMARY KEY REFERENCES customers (id) ON DELETE CASCADE,
  read_at      timestamptz NOT NULL DEFAULT now()
);
