-- 0020: the rest of the papers a rider has to give: vehicle logbook, KRA PIN certificate, certificate of good conduct,
-- plus the KRA PIN itself and an emergency contact.
ALTER TABLE rider_docs DROP CONSTRAINT rider_docs_key_check;
ALTER TABLE rider_docs ADD CONSTRAINT rider_docs_key_check CHECK (key IN ('id', 'license', 'insurance', 'logbook', 'photo', 'selfie', 'kra', 'conduct'));
ALTER TABLE riders ADD COLUMN kra_pin            text NOT NULL DEFAULT '';
ALTER TABLE riders ADD COLUMN emergency_name     text NOT NULL DEFAULT '';
ALTER TABLE riders ADD COLUMN emergency_relation text NOT NULL DEFAULT '';
ALTER TABLE riders ADD COLUMN emergency_phone    text NOT NULL DEFAULT '';
