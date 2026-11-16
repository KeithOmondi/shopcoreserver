-- The pictures a shopper attached to a return request (uploads of kind 'return-photo').
ALTER TABLE return_requests ADD COLUMN photo_ids uuid[] NOT NULL DEFAULT '{}';
