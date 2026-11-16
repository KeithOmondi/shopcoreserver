-- 0023: the language shoppers want messages in, and "back in stock" alerts for saved items. Expand-only.
ALTER TABLE customers ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'sw'));

-- When an item that was sold out has stock again, everyone who saved it is told. A trigger catches every way stock can come back
-- (restocks, returns, cancelled orders, manual adjustments), so no code path can forget.
CREATE FUNCTION notify_back_in_stock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.available <= 0 AND NEW.available > 0 THEN
    INSERT INTO push_queue (owner_type, owner_id, kind, template, params, data)
    SELECT 'customer', w.customer_id, 'stock', 'back_in_stock', jsonb_build_object('product', p.name), jsonb_build_object('productId', p.id, 'screen', 'product')
      FROM wishlist_items w JOIN products p ON p.id = w.product_id
     WHERE w.product_id = NEW.product_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_back_in_stock AFTER UPDATE OF available ON inventory FOR EACH ROW EXECUTE FUNCTION notify_back_in_stock();
