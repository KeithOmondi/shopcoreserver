-- 0025: what a product carries depends on its category (a phone has storage and RAM, a shirt has size and colour).
-- Each category defines its own attributes. Some are specifications (shown to shoppers as facts), and some are options the shopper
-- chooses between (size, colour, storage). Every combination of options is its own sellable product (own SKU, price and stock),
-- and the combinations of one item share a group_id. Expand-only.

CREATE TABLE category_attributes (
  id           uuid PRIMARY KEY,
  category_id  uuid NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  kind         text NOT NULL CHECK (kind IN ('text', 'number', 'choice', 'yes_no')),
  unit         text NOT NULL DEFAULT '' CHECK (length(unit) <= 12),
  choices      jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_option    boolean NOT NULL DEFAULT false,   -- the shopper picks this one (it makes variants)
  required     boolean NOT NULL DEFAULT false,
  filterable   boolean NOT NULL DEFAULT false,   -- offered as a filter in the shop
  position     integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX category_attributes_key ON category_attributes (category_id, key);

ALTER TABLE products
  ADD COLUMN group_id uuid,
  ADD COLUMN options  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN specs    jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX products_group_idx ON products (group_id) WHERE group_id IS NOT NULL;
-- Two variants of one item can't have the same choices.
CREATE UNIQUE INDEX products_group_options_key ON products (group_id, options) WHERE group_id IS NOT NULL AND status <> 'archived';
