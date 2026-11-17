-- A banner can be a ready-made picture: the headline, the link and the description are all optional.
ALTER TABLE banners DROP CONSTRAINT IF EXISTS banners_title_check;
ALTER TABLE banners DROP CONSTRAINT IF EXISTS banners_link_check;
ALTER TABLE banners ALTER COLUMN title SET DEFAULT '';
ALTER TABLE banners ALTER COLUMN link SET DEFAULT '';
ALTER TABLE banners ADD CONSTRAINT banners_title_check CHECK (length(title) <= 80);
ALTER TABLE banners ADD CONSTRAINT banners_link_check CHECK (length(link) <= 200);
-- It still needs something to show: a headline or a picture.
ALTER TABLE banners ADD CONSTRAINT banners_has_content CHECK (length(title) > 0 OR image_ref IS NOT NULL) NOT VALID;
