-- 0021: push notifications, customer ratings of riders, rider referrals and training progress, and the rider's own preferences.

-- Where to send a phone's notifications. A token belongs to whoever signed in last on that phone.
CREATE TABLE push_tokens (
  token       text PRIMARY KEY,
  owner_type  text NOT NULL CHECK (owner_type IN ('rider', 'customer')),
  owner_id    uuid NOT NULL,
  platform    text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_owner_idx ON push_tokens (owner_type, owner_id);

-- Messages waiting to be sent. The worker sends them in the language and with the preferences the person chose.
CREATE TABLE push_queue (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_type  text NOT NULL CHECK (owner_type IN ('rider', 'customer')),
  owner_id    uuid NOT NULL,
  kind        text NOT NULL,
  template    text NOT NULL,
  params      jsonb NOT NULL DEFAULT '{}',
  data        jsonb NOT NULL DEFAULT '{}',
  attempts    integer NOT NULL DEFAULT 0,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX push_queue_pending_idx ON push_queue (id) WHERE sent_at IS NULL;

ALTER TABLE riders ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'sw'));
ALTER TABLE riders ADD COLUMN notify jsonb NOT NULL DEFAULT '{}';
ALTER TABLE riders ADD COLUMN referral_code text;
ALTER TABLE riders ADD COLUMN referred_by uuid REFERENCES riders (id);
ALTER TABLE riders ADD COLUMN referral_paid_at timestamptz;
UPDATE riders SET referral_code = upper(substr(md5(id::text), 1, 8)) WHERE referral_code IS NULL;
CREATE UNIQUE INDEX riders_referral_code_key ON riders (referral_code);
CREATE INDEX riders_referred_by_idx ON riders (referred_by) WHERE referred_by IS NOT NULL;

-- A customer's rating of the rider who brought their order.
CREATE TABLE rider_ratings (
  delivery_id  uuid PRIMARY KEY REFERENCES deliveries (id),
  rider_id     uuid NOT NULL REFERENCES riders (id),
  customer_id  uuid NOT NULL,
  stars        smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment      text NOT NULL DEFAULT '' CHECK (length(comment) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rider_ratings_rider_idx ON rider_ratings (rider_id, created_at DESC);

-- Which training lessons (help articles in the "Rider · Training" category) a rider has finished.
CREATE TABLE rider_lessons_done (
  rider_id    uuid NOT NULL REFERENCES riders (id) ON DELETE CASCADE,
  article_id  uuid NOT NULL REFERENCES help_articles (id) ON DELETE CASCADE,
  done_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rider_id, article_id)
);
