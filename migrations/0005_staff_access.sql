-- 0005: staff accounts, roles, permission matrix and sign-in sessions for the admin.
-- Expand-only: nothing here touches the customer-facing tables.

CREATE TABLE roles (
  name        text PRIMARY KEY CHECK (length(name) BETWEEN 2 AND 60),
  blurb       text NOT NULL DEFAULT '' CHECK (length(blurb) <= 200),
  -- System roles (Owner admin) cannot be edited or deleted; Owner admin always has every permission.
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role    text NOT NULL REFERENCES roles (name) ON UPDATE CASCADE ON DELETE CASCADE,
  module  text NOT NULL,
  action  text NOT NULL CHECK (action IN ('View', 'Create', 'Edit', 'Delete', 'Export')),
  PRIMARY KEY (role, module, action)
);

CREATE TABLE staff (
  id                    uuid PRIMARY KEY,
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email                 text NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  phone                 text NOT NULL DEFAULT '' CHECK (length(phone) <= 32),
  role                  text NOT NULL REFERENCES roles (name) ON UPDATE CASCADE,
  status                text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended')),
  password_hash         text NOT NULL,
  -- True while the person is on a temporary password: they may only choose a new one.
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_attempts       integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  password_changed_at   timestamptz,
  last_login_at         timestamptz,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX staff_email_key ON staff (email);
CREATE INDEX staff_role_idx ON staff (role);

-- One row per signed-in browser. The refresh token is stored only as a SHA-256 hash and rotates on every use.
CREATE TABLE staff_sessions (
  id            uuid PRIMARY KEY,
  staff_id      uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  refresh_hash  text NOT NULL,
  family_id     uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoked_why   text,
  ip            text,
  user_agent    text
);
CREATE UNIQUE INDEX staff_sessions_refresh_key ON staff_sessions (refresh_hash);
CREATE INDEX staff_sessions_staff_idx ON staff_sessions (staff_id) WHERE revoked_at IS NULL;

-- The audit trail gets a readable actor and a module for filtering in the admin.
ALTER TABLE audit_log ADD COLUMN actor_name text, ADD COLUMN module text;
CREATE INDEX audit_log_created_idx ON audit_log (id DESC);
