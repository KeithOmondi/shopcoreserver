-- 0009: delivery zones and fees, riders, dispatch, rider money (earnings, COD cash, payouts) and incidents.
-- Expand-only: new tables, plus nullable/defaulted columns on orders.

CREATE TABLE zones (
  id              uuid PRIMARY KEY,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  fee_cents       bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  -- Share of the delivery fee ShopCore keeps; the rider earns the rest.
  commission_pct  integer NOT NULL DEFAULT 20 CHECK (commission_pct BETWEEN 0 AND 100),
  areas           text[] NOT NULL DEFAULT '{}',
  note            text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  active          boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX zones_name_key ON zones (lower(name));

ALTER TABLE orders
  ADD COLUMN subtotal_cents      bigint,
  ADD COLUMN delivery_fee_cents  bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0),
  ADD COLUMN zone_id             uuid REFERENCES zones (id) ON DELETE SET NULL,
  -- Cash on delivery: what the rider must collect, and when they did.
  ADD COLUMN cod_due_cents       bigint CHECK (cod_due_cents IS NULL OR cod_due_cents >= 0),
  ADD COLUMN cod_collected_at    timestamptz;
UPDATE orders SET subtotal_cents = total_cents WHERE subtotal_cents IS NULL;

-- ---- riders ----------------------------------------------------------------------------------------------------------

CREATE TABLE riders (
  id               uuid PRIMARY KEY,
  phone            text NOT NULL CHECK (phone ~ '^\+?[0-9]{9,15}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email            text NOT NULL DEFAULT '',
  national_id      text NOT NULL DEFAULT '',
  county           text NOT NULL DEFAULT '',
  vehicle          text NOT NULL DEFAULT 'Motorbike' CHECK (vehicle IN ('Motorbike', 'Bicycle', 'Car')),
  plate            text NOT NULL DEFAULT '',
  zone_id          uuid REFERENCES zones (id) ON DELETE SET NULL,
  password_hash    text NOT NULL,
  account_status   text NOT NULL DEFAULT 'pending' CHECK (account_status IN ('pending', 'approved', 'rejected', 'suspended')),
  availability     text NOT NULL DEFAULT 'offline' CHECK (availability IN ('offline', 'online')),
  rating           numeric(2,1) NOT NULL DEFAULT 0,
  deliveries_done  integer NOT NULL DEFAULT 0,
  review_note      text NOT NULL DEFAULT '',
  rejected_doc     text,
  reviewed_by      text,
  reviewed_at      timestamptz,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  welcomed         boolean NOT NULL DEFAULT false,
  last_lat         double precision,
  last_lng         double precision,
  last_seen_at     timestamptz,
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX riders_phone_key ON riders (phone);
CREATE INDEX riders_status_idx ON riders (account_status, availability);
CREATE INDEX riders_zone_idx ON riders (zone_id) WHERE account_status = 'approved';

CREATE TABLE rider_docs (
  rider_id     uuid NOT NULL REFERENCES riders (id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (key IN ('id', 'license', 'insurance', 'photo', 'selfie')),
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('valid', 'pending', 'rejected', 'expired')),
  expires_on   date,
  note         text NOT NULL DEFAULT '',
  file_ref     text,
  reviewed_by  text,
  reviewed_at  timestamptz,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rider_id, key)
);

CREATE TABLE rider_sessions (
  id            uuid PRIMARY KEY,
  rider_id      uuid NOT NULL REFERENCES riders (id) ON DELETE CASCADE,
  refresh_hash  text NOT NULL,
  family_id     uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoked_why   text,
  device        text
);
CREATE UNIQUE INDEX rider_sessions_refresh_key ON rider_sessions (refresh_hash);
CREATE INDEX rider_sessions_rider_idx ON rider_sessions (rider_id) WHERE revoked_at IS NULL;

-- One-time codes sent by SMS (sign-up and password reset). Only a hash of the code is kept.
CREATE TABLE rider_otps (
  phone       text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('signup', 'reset')),
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  verified_at timestamptz,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone, purpose)
);

CREATE TABLE rider_shifts (
  id        uuid PRIMARY KEY,
  rider_id  uuid NOT NULL REFERENCES riders (id) ON DELETE CASCADE,
  day       date NOT NULL,
  time_window text NOT NULL CHECK (length(time_window) BETWEEN 1 AND 40),
  zone_id   uuid REFERENCES zones (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX rider_shifts_key ON rider_shifts (rider_id, day);
CREATE INDEX rider_shifts_day_idx ON rider_shifts (day);

-- ---- deliveries ----------------------------------------------------------------------------------------------------

CREATE TABLE deliveries (
  id                  uuid PRIMARY KEY,
  order_id            uuid NOT NULL REFERENCES orders (id),
  rider_id            uuid REFERENCES riders (id),
  status              text NOT NULL CHECK (status IN ('offered', 'accepted', 'at_pickup', 'picked_up', 'at_dropoff', 'delivered', 'failed', 'cancelled')),
  offer_expires_at    timestamptz,
  pickup_location_id  uuid REFERENCES locations (id),
  distance_km         numeric(5,1) NOT NULL DEFAULT 0,
  fare_cents          bigint NOT NULL DEFAULT 0 CHECK (fare_cents >= 0),
  bonus_cents         bigint NOT NULL DEFAULT 0 CHECK (bonus_cents >= 0),
  tip_cents           bigint NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  cod_cents           bigint NOT NULL DEFAULT 0 CHECK (cod_cents >= 0),
  handover_code       text NOT NULL,
  photo_ref           text,
  assigned_by         text NOT NULL DEFAULT 'System',
  failure_kind        text CHECK (failure_kind IN ('Cancelled', 'Failed')),
  failure_reason      text,
  resolved            boolean NOT NULL DEFAULT false,
  resolution_note     text NOT NULL DEFAULT '',
  resolved_by         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  picked_up_at        timestamptz,
  delivered_at        timestamptz,
  failed_at           timestamptz,
  version             integer NOT NULL DEFAULT 1
);
-- An order has at most one live delivery at a time.
CREATE UNIQUE INDEX deliveries_live_order_key ON deliveries (order_id) WHERE status NOT IN ('delivered', 'failed', 'cancelled');
CREATE INDEX deliveries_rider_idx ON deliveries (rider_id, status);
CREATE INDEX deliveries_order_idx ON deliveries (order_id);
CREATE INDEX deliveries_open_failures_idx ON deliveries (failed_at DESC) WHERE status = 'failed' AND NOT resolved;

-- Who was asked, and what they said. Kept for the dispatcher's history and for acceptance-rate reporting.
CREATE TABLE delivery_attempts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id  uuid NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  rider_id     uuid NOT NULL REFERENCES riders (id),
  outcome      text NOT NULL CHECK (outcome IN ('offered', 'accepted', 'declined', 'expired', 'withdrawn')),
  reason       text NOT NULL DEFAULT '',
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_attempts_delivery_idx ON delivery_attempts (delivery_id, id);

-- ---- rider money -------------------------------------------------------------------------------------------------------

-- Earnings ledger: positive entries are earned, negative are paid out. Balance = sum. Append-only.
CREATE TABLE rider_ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rider_id     uuid NOT NULL REFERENCES riders (id),
  kind         text NOT NULL CHECK (kind IN ('fare', 'bonus', 'tip', 'adjustment', 'payout', 'payout_fee', 'payout_reversal')),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  delivery_id  uuid REFERENCES deliveries (id),
  payout_id    uuid,
  note         text NOT NULL DEFAULT '',
  by_name      text NOT NULL DEFAULT 'System',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rider_ledger_rider_idx ON rider_ledger (rider_id, id DESC);
CREATE UNIQUE INDEX rider_ledger_delivery_key ON rider_ledger (delivery_id, kind) WHERE delivery_id IS NOT NULL AND kind IN ('fare', 'bonus', 'tip');

-- Cash on delivery the rider is holding: collected from customers, cleared when handed in.
CREATE TABLE rider_cash (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rider_id     uuid NOT NULL REFERENCES riders (id),
  kind         text NOT NULL CHECK (kind IN ('collected', 'deposit', 'adjustment')),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  delivery_id  uuid REFERENCES deliveries (id),
  ref          text NOT NULL DEFAULT '',
  by_name      text NOT NULL DEFAULT 'System',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rider_cash_rider_idx ON rider_cash (rider_id, id DESC);
CREATE UNIQUE INDEX rider_cash_delivery_key ON rider_cash (delivery_id) WHERE kind = 'collected';

CREATE FUNCTION rider_money_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
CREATE TRIGGER rider_ledger_append_only BEFORE UPDATE OR DELETE ON rider_ledger FOR EACH ROW EXECUTE FUNCTION rider_money_append_only();
CREATE TRIGGER rider_cash_append_only BEFORE UPDATE OR DELETE ON rider_cash FOR EACH ROW EXECUTE FUNCTION rider_money_append_only();

CREATE SEQUENCE payout_no_seq START 5100;
CREATE TABLE payouts (
  id               uuid PRIMARY KEY,
  payout_no        bigint NOT NULL DEFAULT nextval('payout_no_seq'),
  rider_id         uuid NOT NULL REFERENCES riders (id),
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents        bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  phone            text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  paid_at          timestamptz,
  paid_by          text,
  provider_ref     text,
  failure_reason   text
);
CREATE UNIQUE INDEX payouts_no_key ON payouts (payout_no);
CREATE INDEX payouts_status_idx ON payouts (status, requested_at DESC);
CREATE INDEX payouts_rider_idx ON payouts (rider_id, requested_at DESC);

-- ---- incidents -----------------------------------------------------------------------------------------------------------

CREATE SEQUENCE incident_no_seq START 280;
CREATE TABLE incidents (
  id           uuid PRIMARY KEY,
  incident_no  bigint NOT NULL DEFAULT nextval('incident_no_seq'),
  rider_id     uuid NOT NULL REFERENCES riders (id),
  type         text NOT NULL CHECK (length(type) BETWEEN 1 AND 60),
  severity     text NOT NULL CHECK (severity IN ('critical', 'high', 'medium')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  sos          boolean NOT NULL DEFAULT false,
  lat          double precision,
  lng          double precision,
  delivery_id  uuid REFERENCES deliveries (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE UNIQUE INDEX incidents_no_key ON incidents (incident_no);
CREATE INDEX incidents_open_idx ON incidents (created_at DESC) WHERE status <> 'resolved';

CREATE TABLE incident_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id  uuid NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  by_name      text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_log_incident_idx ON incident_log (incident_id, id);
