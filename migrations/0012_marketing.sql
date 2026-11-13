-- 0012: marketing. Expand-only. Money is integer cents (KES).

-- ---- consent: who may be contacted, and how --------------------------------------------------------------------------------
ALTER TABLE customers
  ADD COLUMN push_opt_in   boolean NOT NULL DEFAULT false,
  ADD COLUMN email_opt_in  boolean NOT NULL DEFAULT false,
  ADD COLUMN sms_opt_in    boolean NOT NULL DEFAULT false,
  ADD COLUMN consent_at    timestamptz;

-- ---- audience segments ---------------------------------------------------------------------------------------------------------
CREATE TABLE segments (
  id           uuid PRIMARY KEY,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  purpose      text NOT NULL DEFAULT 'Campaign audience' CHECK (purpose IN ('Campaign audience', 'Loyalty tier', 'Internal analysis')),
  match_mode   text NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
  rules        jsonb NOT NULL DEFAULT '[]'::jsonb,
  description  text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  is_system    boolean NOT NULL DEFAULT false,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX segments_name_key ON segments (lower(name));
INSERT INTO segments (id, name, description, is_system) VALUES ('00000000-0000-7000-8000-000000000001', 'All customers', 'Everyone with an account.', true);

-- ---- coupons ------------------------------------------------------------------------------------------------------------------------
CREATE TABLE coupons (
  id                  uuid PRIMARY KEY,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  code                text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{3,24}$'),
  kind                text NOT NULL CHECK (kind IN ('percent', 'fixed', 'free_delivery')),
  value               bigint NOT NULL DEFAULT 0 CHECK (value >= 0),       -- percent (1-100) or cents
  min_spend_cents     bigint NOT NULL DEFAULT 0 CHECK (min_spend_cents >= 0),
  max_discount_cents  bigint NOT NULL DEFAULT 0 CHECK (max_discount_cents >= 0),
  usage_limit         integer NOT NULL CHECK (usage_limit >= 1),
  per_customer        integer NOT NULL DEFAULT 1 CHECK (per_customer >= 1),
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  state               text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'live', 'paused')),
  category_ids        uuid[] NOT NULL DEFAULT '{}',
  audience            text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'new', 'segment')),
  segment_id          uuid REFERENCES segments (id),
  combine             boolean NOT NULL DEFAULT false,
  note                text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  CHECK (ends_at > starts_at),
  CHECK (kind <> 'percent' OR value BETWEEN 1 AND 100),
  CHECK (kind <> 'fixed' OR value >= 1)
);
CREATE UNIQUE INDEX coupons_code_key ON coupons (code);

ALTER TABLE orders
  ADD COLUMN discount_cents bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  ADD COLUMN coupon_id      uuid REFERENCES coupons (id);

-- One row per order that used a coupon. A cancelled order gives its use back (released_at), so limits count only live uses.
CREATE TABLE coupon_redemptions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coupon_id       uuid NOT NULL REFERENCES coupons (id),
  order_id        uuid NOT NULL REFERENCES orders (id),
  customer_id     uuid NOT NULL,
  discount_cents  bigint NOT NULL CHECK (discount_cents >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz
);
CREATE UNIQUE INDEX coupon_redemptions_order_key ON coupon_redemptions (order_id);
CREATE INDEX coupon_redemptions_coupon_idx ON coupon_redemptions (coupon_id) WHERE released_at IS NULL;
CREATE INDEX coupon_redemptions_customer_idx ON coupon_redemptions (coupon_id, customer_id) WHERE released_at IS NULL;

-- ---- flash sales and bundles ------------------------------------------------------------------------------------------------------------
CREATE TABLE flash_sales (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value       bigint NOT NULL CHECK (value >= 1),                     -- percent (1-99) or cents off
  placement   text NOT NULL DEFAULT 'Home carousel',
  stock_guard integer NOT NULL DEFAULT 10 CHECK (stock_guard >= 0),   -- products at or below this stock are left out
  state       text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'live')),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1,
  CHECK (ends_at > starts_at),
  CHECK (kind <> 'percent' OR value <= 99)
);
CREATE TABLE flash_sale_products (
  sale_id     uuid NOT NULL REFERENCES flash_sales (id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products (id),
  PRIMARY KEY (sale_id, product_id)
);
CREATE INDEX flash_sale_products_product_idx ON flash_sale_products (product_id);

ALTER TABLE order_items ADD COLUMN flash_sale_id uuid REFERENCES flash_sales (id);
CREATE INDEX order_items_flash_idx ON order_items (flash_sale_id) WHERE flash_sale_id IS NOT NULL;

CREATE TABLE bundles (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind        text NOT NULL CHECK (kind IN ('Bundle', 'Multi-buy', 'Cross-sell')),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  price_cents bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  percent     numeric(5,2) NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 90),
  min_items   integer NOT NULL DEFAULT 0 CHECK (min_items >= 0),
  state       text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'live')),
  starts_at   timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);
CREATE TABLE bundle_items (
  bundle_id   uuid NOT NULL REFERENCES bundles (id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products (id),
  quantity    integer NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  PRIMARY KEY (bundle_id, product_id)
);
-- The one bundle offer an order took (its saving is part of discount_cents).
ALTER TABLE orders ADD COLUMN bundle_id uuid REFERENCES bundles (id), ADD COLUMN bundle_discount_cents bigint NOT NULL DEFAULT 0 CHECK (bundle_discount_cents >= 0);

-- ---- banners and the homepage -------------------------------------------------------------------------------------------------------------
CREATE TABLE banners (
  id          uuid PRIMARY KEY,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  label       text NOT NULL DEFAULT '' CHECK (length(label) <= 40),
  link        text NOT NULL CHECK (length(link) BETWEEN 1 AND 200),
  platform    text NOT NULL DEFAULT 'Web and mobile' CHECK (platform IN ('Web and mobile', 'Mobile only', 'Web only')),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  tone        smallint NOT NULL DEFAULT 0 CHECK (tone BETWEEN 0 AND 3),
  alt         text NOT NULL DEFAULT '' CHECK (length(alt) <= 200),
  image_ref   text,
  published   boolean NOT NULL DEFAULT false,
  position    integer NOT NULL DEFAULT 0,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1,
  CHECK (ends_at > starts_at)
);
CREATE TABLE home_sections (
  id        uuid PRIMARY KEY,
  name      text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  sub       text NOT NULL DEFAULT '' CHECK (length(sub) <= 60),
  enabled   boolean NOT NULL DEFAULT true,
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  position  integer NOT NULL DEFAULT 0
);
-- What shoppers see: a copy of the sections taken when the layout was published (one row), and one waiting for its time.
CREATE TABLE home_layouts (
  slot         text PRIMARY KEY CHECK (slot IN ('live', 'pending')),
  sections     jsonb NOT NULL,
  effective_at timestamptz NOT NULL,
  published_by text NOT NULL
);

-- ---- push and message campaigns -----------------------------------------------------------------------------------------------------------------
CREATE TABLE pushes (
  id          uuid PRIMARY KEY,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 65),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 240),
  segment_id  uuid NOT NULL REFERENCES segments (id),
  deep_link   text NOT NULL DEFAULT '',
  send_at     timestamptz,
  quiet       boolean NOT NULL DEFAULT true,
  cap         boolean NOT NULL DEFAULT true,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sent')),
  sent_at     timestamptz,
  sent_count  integer NOT NULL DEFAULT 0,
  opened      integer NOT NULL DEFAULT 0,
  converted   integer NOT NULL DEFAULT 0,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);
CREATE INDEX pushes_due_idx ON pushes (send_at) WHERE status = 'scheduled';
CREATE TABLE messages (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  channel     text NOT NULL CHECK (channel IN ('Email', 'SMS')),
  segment_id  uuid NOT NULL REFERENCES segments (id),
  subject     text NOT NULL DEFAULT '' CHECK (length(subject) <= 150),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  send_at     timestamptz,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sent')),
  sent_at     timestamptz,
  sent_count  integer NOT NULL DEFAULT 0,
  delivered   integer NOT NULL DEFAULT 0,
  clicks      integer NOT NULL DEFAULT 0,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);
CREATE INDEX messages_due_idx ON messages (send_at) WHERE status = 'scheduled';

-- ---- campaigns: the umbrella that results are reported against ------------------------------------------------------------------------------------
CREATE TABLE campaigns (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind        text NOT NULL CHECK (kind IN ('Coupon', 'Push', 'Bundle', 'Banner', 'Flash sale')),
  offer       text NOT NULL DEFAULT '' CHECK (length(offer) <= 200),
  audience    text NOT NULL DEFAULT 'All customers',
  spend_cents bigint NOT NULL DEFAULT 0 CHECK (spend_cents >= 0),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  coupon_id   uuid REFERENCES coupons (id),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1,
  CHECK (ends_at > starts_at)
);
CREATE TABLE campaign_channels (
  campaign_id  uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  name         text NOT NULL,
  reach        integer NOT NULL DEFAULT 0 CHECK (reach >= 0),
  clicks       integer NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  conversions  integer NOT NULL DEFAULT 0 CHECK (conversions >= 0),
  sales_cents  bigint NOT NULL DEFAULT 0 CHECK (sales_cents >= 0),
  PRIMARY KEY (campaign_id, name)
);

-- ---- reviews on show, pages, category copy ---------------------------------------------------------------------------------------------------------------
CREATE TABLE review_highlights (
  review_id  uuid PRIMARY KEY REFERENCES reviews (id) ON DELETE CASCADE,
  placement  text NOT NULL DEFAULT 'Home · Featured' CHECK (placement IN ('Home · Featured', 'Category page', 'App · New')),
  published  boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE content_pages (
  id          uuid PRIMARY KEY,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  slug        text NOT NULL CHECK (slug ~ '^/[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'),
  audience    text NOT NULL DEFAULT 'Website and mobile app',
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  body        text NOT NULL DEFAULT '' CHECK (length(body) <= 50000),
  seo_title   text NOT NULL DEFAULT '' CHECK (length(seo_title) <= 70),
  seo_desc    text NOT NULL DEFAULT '' CHECK (length(seo_desc) <= 170),
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX content_pages_slug_key ON content_pages (slug);
CREATE TABLE category_content (
  category_id uuid PRIMARY KEY REFERENCES categories (id) ON DELETE CASCADE,
  heading     text NOT NULL DEFAULT '' CHECK (length(heading) <= 100),
  intro       text NOT NULL DEFAULT '' CHECK (length(intro) <= 600),
  cta         text NOT NULL DEFAULT '' CHECK (length(cta) <= 40),
  collection  text NOT NULL DEFAULT 'Featured',
  seo_title   text NOT NULL DEFAULT '' CHECK (length(seo_title) <= 70),
  seo_desc    text NOT NULL DEFAULT '' CHECK (length(seo_desc) <= 170),
  canonical   text NOT NULL DEFAULT '' CHECK (length(canonical) <= 300),
  published   boolean NOT NULL DEFAULT false,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
