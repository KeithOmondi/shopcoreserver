-- 0007: purchasing, stock counts, packing and returns handling.

CREATE SEQUENCE po_no_seq START 1031;
CREATE TABLE purchase_orders (
  id                uuid PRIMARY KEY,
  po_no             bigint NOT NULL DEFAULT nextval('po_no_seq'),
  supplier_id       uuid NOT NULL REFERENCES suppliers (id),
  location_id       uuid NOT NULL REFERENCES locations (id),
  expected_on       date NOT NULL,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'in_transit', 'partially_received', 'received', 'cancelled')),
  shipping_cents    bigint NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  tax_rate          numeric(5,2) NOT NULL DEFAULT 16 CHECK (tax_rate BETWEEN 0 AND 100),
  notes             text NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  created_by        uuid NOT NULL,
  created_by_name   text NOT NULL,
  approved_by       uuid,
  approved_by_name  text,
  approved_at       timestamptz,
  delivery_ref      text,
  received_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX purchase_orders_no_key ON purchase_orders (po_no);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (status, created_at DESC);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (supplier_id);

CREATE TABLE purchase_order_lines (
  po_id        uuid NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  line_no      smallint NOT NULL,
  product_id   uuid NOT NULL REFERENCES products (id),
  qty          integer NOT NULL CHECK (qty > 0),
  cost_cents   bigint NOT NULL CHECK (cost_cents >= 0),
  received     integer NOT NULL DEFAULT 0 CHECK (received >= 0),
  damaged      integer NOT NULL DEFAULT 0 CHECK (damaged >= 0),
  PRIMARY KEY (po_id, line_no),
  CHECK (received <= qty AND damaged <= received)
);
CREATE UNIQUE INDEX purchase_order_lines_product_key ON purchase_order_lines (po_id, product_id);

-- Each delivery against an order, so partial deliveries keep their own reference.
CREATE TABLE purchase_receipts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id           uuid NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  delivery_ref    text NOT NULL,
  lines           jsonb NOT NULL,
  received_by     text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_receipts_po_idx ON purchase_receipts (po_id);

CREATE SEQUENCE count_no_seq START 248;
CREATE TABLE stock_counts (
  id               uuid PRIMARY KEY,
  count_no         bigint NOT NULL DEFAULT nextval('count_no_seq'),
  location_id      uuid NOT NULL REFERENCES locations (id),
  zone             text NOT NULL DEFAULT 'Whole location',
  owner_id         uuid NOT NULL,
  owner_name       text NOT NULL,
  status           text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'pending_approval', 'reconciled')),
  approved_by      uuid,
  approved_by_name text,
  note             text NOT NULL DEFAULT '',
  started_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  version          integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX stock_counts_no_key ON stock_counts (count_no);
-- At most one open count per location.
CREATE UNIQUE INDEX stock_counts_open_key ON stock_counts (location_id) WHERE status <> 'reconciled';

CREATE TABLE stock_count_lines (
  count_id    uuid NOT NULL REFERENCES stock_counts (id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products (id),
  expected    integer NOT NULL CHECK (expected >= 0),
  c1          integer CHECK (c1 >= 0),
  c2          integer CHECK (c2 >= 0),
  PRIMARY KEY (count_id, product_id)
);

-- Orders being picked and packed in the warehouse.
CREATE TABLE pack_state (
  order_id    uuid PRIMARY KEY REFERENCES orders (id) ON DELETE CASCADE,
  picked      uuid[] NOT NULL DEFAULT '{}',
  stage       text NOT NULL DEFAULT 'pick' CHECK (stage IN ('pick', 'packed')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  packed_at   timestamptz,
  packed_by   text
);

-- Items coming back to the warehouse, waiting for a decision (restock, write off, return to supplier).
CREATE SEQUENCE return_no_seq START 3070;
CREATE TABLE warehouse_returns (
  id            uuid PRIMARY KEY,
  return_no     bigint NOT NULL DEFAULT nextval('return_no_seq'),
  order_id      uuid REFERENCES orders (id),
  customer      text NOT NULL DEFAULT '',
  product_id    uuid REFERENCES products (id),
  product_name  text NOT NULL,
  qty           integer NOT NULL CHECK (qty > 0),
  reason        text NOT NULL DEFAULT '',
  condition     text NOT NULL DEFAULT '',
  value_cents   bigint NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
  received_at   timestamptz NOT NULL DEFAULT now(),
  disposition   text CHECK (disposition IN ('restock_sellable', 'restock_clearance', 'write_off', 'return_to_supplier')),
  location_id   uuid REFERENCES locations (id),
  decision_note text NOT NULL DEFAULT '',
  refund_review boolean NOT NULL DEFAULT false,
  decided_by    uuid,
  decided_by_name text,
  decided_at    timestamptz
);
CREATE UNIQUE INDEX warehouse_returns_no_key ON warehouse_returns (return_no);
CREATE INDEX warehouse_returns_open_idx ON warehouse_returns (received_at DESC) WHERE disposition IS NULL;
