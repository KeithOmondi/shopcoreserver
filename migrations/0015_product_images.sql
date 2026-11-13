-- 0015: pictures on products. Expand-only.
CREATE TABLE product_images (
  product_id  uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  upload_id   uuid NOT NULL REFERENCES uploads (id),
  position    smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, upload_id)
);
CREATE INDEX product_images_order_idx ON product_images (product_id, position);
