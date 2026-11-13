-- 0006: catalogue structure (categories, brands, suppliers), stock locations, per-location stock and the movement log.
-- Expand-only. inventory.available/reserved stay the order path's source of truth; stock_levels spreads
-- (available + reserved) across locations, and every change goes through the stock engine so they always agree.

CREATE TABLE locations (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  city        text NOT NULL DEFAULT '' CHECK (length(city) <= 80),
  capacity    integer NOT NULL DEFAULT 0 CHECK (capacity >= 0),
  active      boolean NOT NULL DEFAULT true,
  -- Lowest sort_order is the primary location: where sales are taken from first and unspecified stock lands.
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX locations_name_key ON locations (lower(name));

CREATE TABLE categories (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  handle      text NOT NULL CHECK (handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_key ON categories (lower(name));
CREATE UNIQUE INDEX categories_handle_key ON categories (handle);

CREATE TABLE subcategories (
  id           uuid PRIMARY KEY,
  category_id  uuid NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 60)
);
CREATE UNIQUE INDEX subcategories_key ON subcategories (category_id, lower(name));

CREATE TABLE brands (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  origin      text NOT NULL DEFAULT '' CHECK (length(origin) <= 120),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brands_name_key ON brands (lower(name));

CREATE TABLE suppliers (
  id               uuid PRIMARY KEY,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  contact          text NOT NULL DEFAULT '',
  email            text NOT NULL DEFAULT '',
  phone            text NOT NULL DEFAULT '',
  city             text NOT NULL DEFAULT '',
  terms            text NOT NULL DEFAULT 'Net 30',
  lead_days        integer NOT NULL DEFAULT 7 CHECK (lead_days BETWEEN 0 AND 365),
  min_order_cents  bigint NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppliers_name_key ON suppliers (lower(name));

-- Products gain catalogue detail. `active` stays what the storefront filters on; the admin sets `status`
-- and the two are kept in step (only 'active' products are visible to shoppers).
ALTER TABLE products
  ADD COLUMN category_id    uuid REFERENCES categories (id) ON DELETE SET NULL,
  ADD COLUMN subcategory    text NOT NULL DEFAULT '',
  ADD COLUMN brand_id       uuid REFERENCES brands (id) ON DELETE SET NULL,
  ADD COLUMN supplier_id    uuid REFERENCES suppliers (id) ON DELETE SET NULL,
  ADD COLUMN cost_cents     bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  ADD COLUMN barcode        text NOT NULL DEFAULT '',
  ADD COLUMN tax            text NOT NULL DEFAULT 'standard' CHECK (tax IN ('standard', 'zero')),
  ADD COLUMN track_stock    boolean NOT NULL DEFAULT true,
  ADD COLUMN status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  ADD COLUMN reorder_at     integer NOT NULL DEFAULT 10 CHECK (reorder_at >= 0),
  ADD COLUMN handle         text NOT NULL DEFAULT '',
  ADD COLUMN seo_title      text NOT NULL DEFAULT '',
  ADD COLUMN seo_desc       text NOT NULL DEFAULT '',
  ADD COLUMN variants       jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE products SET status = CASE WHEN active THEN 'active' ELSE 'archived' END;
CREATE INDEX products_category_idx ON products (category_id) WHERE category_id IS NOT NULL;
CREATE UNIQUE INDEX products_barcode_key ON products (barcode) WHERE barcode <> '';

-- Units on hand at each location (not yet sold). Sum over locations = inventory.available + inventory.reserved.
CREATE TABLE stock_levels (
  product_id   uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  location_id  uuid NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  on_hand      integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location_id)
) WITH (fillfactor = 80);
CREATE INDEX stock_levels_location_idx ON stock_levels (location_id);

-- Append-only record of every change to stock, with the running balance at that location after it.
CREATE TABLE stock_movements (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id   uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  location_id  uuid NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  type         text NOT NULL CHECK (type IN ('Sale', 'Transfer in', 'Transfer out', 'Adjustment', 'PO receipt', 'Write-off', 'Return restock', 'Opening stock', 'Count correction')),
  qty          integer NOT NULL CHECK (qty <> 0),
  balance      integer NOT NULL CHECK (balance >= 0),
  ref          text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  actor_id     text NOT NULL DEFAULT 'system',
  actor_name   text NOT NULL DEFAULT 'System',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product_idx ON stock_movements (product_id, id DESC);
CREATE INDEX stock_movements_location_idx ON stock_movements (location_id, id DESC);
CREATE INDEX stock_movements_created_idx ON stock_movements (id DESC);

CREATE FUNCTION stock_movements_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER stock_movements_no_update_delete BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only();

-- Human-friendly order numbers for staff and customers (SC-48291).
CREATE SEQUENCE order_no_seq START 48000;
ALTER TABLE orders ADD COLUMN order_no bigint NOT NULL DEFAULT nextval('order_no_seq');
CREATE UNIQUE INDEX orders_order_no_key ON orders (order_no);

-- Settings the admin edits (stock alert rules and similar), as small JSON documents.
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Existing stock (from before locations existed) becomes opening stock at one default location.
DO $$
DECLARE loc uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM inventory WHERE available + reserved > 0) THEN
    loc := gen_random_uuid();
    INSERT INTO locations (id, name, city, sort_order) VALUES (loc, 'Main warehouse', '', 0);
    INSERT INTO stock_levels (product_id, location_id, on_hand)
      SELECT product_id, loc, available + reserved FROM inventory WHERE available + reserved > 0;
    INSERT INTO stock_movements (product_id, location_id, type, qty, balance, ref, note)
      SELECT product_id, loc, 'Opening stock', available + reserved, available + reserved, 'MIGRATION', 'Stock before locations existed'
        FROM inventory WHERE available + reserved > 0;
  END IF;
END $$;
