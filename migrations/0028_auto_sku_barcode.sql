-- SKUs and barcodes are made by the system. Staff never type them.
-- SKU:     SC-000123
-- Barcode: EAN-13 in the store-internal range (starts with 200), so it never clashes with a manufacturer's code.
CREATE SEQUENCE IF NOT EXISTS product_sku_seq START 1000;
CREATE SEQUENCE IF NOT EXISTS product_barcode_seq START 1;

CREATE OR REPLACE FUNCTION next_product_sku() RETURNS text LANGUAGE sql AS $$
  SELECT 'SC-' || lpad(nextval('product_sku_seq')::text, 6, '0')
$$;

CREATE OR REPLACE FUNCTION next_product_barcode() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  body text;
  total int := 0;
  i int;
BEGIN
  LOOP
    body := '200' || lpad(nextval('product_barcode_seq')::text, 9, '0');
    FOR i IN 1..12 LOOP
      total := total + substr(body, i, 1)::int * (CASE WHEN i % 2 = 1 THEN 1 ELSE 3 END);
    END LOOP;
    body := body || ((10 - total % 10) % 10)::text;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM products WHERE barcode = body);
    total := 0;
  END LOOP;
  RETURN body;
END
$$;

-- Give every product that has no barcode one.
UPDATE products SET barcode = next_product_barcode() WHERE barcode = '';
