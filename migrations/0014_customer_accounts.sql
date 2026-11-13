-- 0014: customer sign-in (phone code to join, email or phone plus password to come back). Expand-only.

CREATE TABLE customer_accounts (
  id               uuid PRIMARY KEY REFERENCES customers (id),
  email            text NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  phone            text NOT NULL CHECK (phone ~ '^\+254[17]\d{8}$'),
  password_hash    text NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
-- Only live accounts hold on to an email or number, so a person who deleted their account can join again.
CREATE UNIQUE INDEX customer_accounts_email_key ON customer_accounts (email) WHERE status = 'active';
CREATE UNIQUE INDEX customer_accounts_phone_key ON customer_accounts (phone) WHERE status = 'active';

-- A sign-up waiting for its code. Nothing exists as an account until the phone is confirmed.
CREATE TABLE customer_signups (
  phone          text PRIMARY KEY,
  full_name      text NOT NULL,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  code_hash      text NOT NULL,
  attempts       integer NOT NULL DEFAULT 0,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);

-- A forgotten-password code, then (once it is right) a one-time reset token.
CREATE TABLE customer_resets (
  customer_id  uuid PRIMARY KEY REFERENCES customers (id),
  code_hash    text NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  token_hash   text,
  token_expires_at timestamptz
);

CREATE TABLE customer_sessions (
  id            uuid PRIMARY KEY,
  customer_id   uuid NOT NULL REFERENCES customers (id),
  refresh_hash  text NOT NULL,
  family_id     uuid NOT NULL,
  device        text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoked_why   text
);
CREATE UNIQUE INDEX customer_sessions_refresh_key ON customer_sessions (refresh_hash);
CREATE INDEX customer_sessions_customer_idx ON customer_sessions (customer_id) WHERE revoked_at IS NULL;
