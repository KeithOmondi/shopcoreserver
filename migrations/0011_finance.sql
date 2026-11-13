-- 0011: finance and payroll. Expand-only. Money is integer cents (KES).

-- ---- failed payments ------------------------------------------------------------------------------------------------------
-- Successful payments live on the order (payment_ref, paid_at). A failed attempt is recorded here by the payment service.
CREATE SEQUENCE failed_payment_no_seq START 10100;
CREATE TABLE failed_payments (
  id            uuid PRIMARY KEY,
  fail_no       bigint NOT NULL DEFAULT nextval('failed_payment_no_seq'),
  order_id      uuid NOT NULL REFERENCES orders (id),
  method        text NOT NULL CHECK (method IN ('mpesa', 'card')),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  ref           text NOT NULL CHECK (length(ref) BETWEEN 1 AND 128),
  attempts      integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  status        text NOT NULL DEFAULT 'failed' CHECK (status IN ('failed', 'recovered', 'manual_review')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX failed_payments_ref_key ON failed_payments (lower(ref));
CREATE UNIQUE INDEX failed_payments_no_key ON failed_payments (fail_no);
CREATE INDEX failed_payments_order_idx ON failed_payments (order_id);
CREATE INDEX failed_payments_status_idx ON failed_payments (status, created_at DESC);

-- ---- gateway statements and reconciliation ----------------------------------------------------------------------------------
CREATE TABLE statements (
  id            uuid PRIMARY KEY,
  file_name     text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  imported_by   text NOT NULL,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  completed_by  text
);
CREATE TABLE statement_lines (
  id            uuid PRIMARY KEY,
  statement_id  uuid NOT NULL REFERENCES statements (id) ON DELETE CASCADE,
  line_no       integer NOT NULL,
  ref           text NOT NULL,
  gateway_cents bigint NOT NULL CHECK (gateway_cents > 0),
  order_id      uuid REFERENCES orders (id),
  ours_cents    bigint,
  resolution    text CHECK (resolution IN ('adjusted', 'written_off', 'matched_manually')),
  note          text NOT NULL DEFAULT '',
  resolved_by   text,
  resolved_at   timestamptz
);
CREATE INDEX statement_lines_statement_idx ON statement_lines (statement_id, line_no);

-- ---- COD deposits: how the cash reached us ------------------------------------------------------------------------------------
ALTER TABLE rider_cash
  ADD COLUMN method  text,
  ADD COLUMN account text,
  ADD COLUMN note    text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX rider_cash_deposit_ref_key ON rider_cash (lower(ref)) WHERE kind = 'deposit';

-- ---- payout batches (maker-checker) -------------------------------------------------------------------------------------------
CREATE SEQUENCE payout_batch_no_seq START 1000;
CREATE TABLE payout_batches (
  id               uuid PRIMARY KEY,
  batch_no         bigint NOT NULL DEFAULT nextval('payout_batch_no_seq'),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
  note             text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_by_id    text NOT NULL,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_by_id   text,
  approved_by      text,
  sent_at          timestamptz
);
CREATE UNIQUE INDEX payout_batches_no_key ON payout_batches (batch_no);
CREATE TABLE payout_batch_items (
  batch_id    uuid NOT NULL REFERENCES payout_batches (id) ON DELETE CASCADE,
  payout_id   uuid NOT NULL REFERENCES payouts (id),
  outcome     text CHECK (outcome IN ('paid', 'failed')),
  PRIMARY KEY (batch_id, payout_id)
);
-- A payout can sit in only one batch.
CREATE UNIQUE INDEX payout_batch_items_payout_key ON payout_batch_items (payout_id);

-- ---- store settlements (what we owe the places stock is collected from) -------------------------------------------------------------
CREATE TABLE settlements (
  id           text PRIMARY KEY,              -- ST-202611-<location prefix>
  location_id  uuid REFERENCES locations (id),
  month        text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  paid_at      timestamptz,
  paid_ref     text,
  paid_by      text
);

-- ---- expenses ----------------------------------------------------------------------------------------------------------------------
CREATE SEQUENCE expense_no_seq START 1041;
CREATE TABLE expenses (
  id            uuid PRIMARY KEY,
  expense_no    bigint NOT NULL DEFAULT nextval('expense_no_seq'),
  spent_on      date NOT NULL,
  category      text NOT NULL CHECK (length(category) BETWEEN 1 AND 60),
  payee         text NOT NULL CHECK (length(payee) BETWEEN 1 AND 120),
  description   text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  by_id         text NOT NULL,
  by_name       text NOT NULL,
  decided_by    text,
  decided_at    timestamptz,
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX expenses_no_key ON expenses (expense_no);
CREATE INDEX expenses_date_idx ON expenses (spent_on DESC);
CREATE INDEX expenses_status_idx ON expenses (status);

-- ---- invoices (business accounts) --------------------------------------------------------------------------------------------------------
CREATE SEQUENCE invoice_no_seq START 2319;
CREATE TABLE invoices (
  id           uuid PRIMARY KEY,
  invoice_no   bigint NOT NULL DEFAULT nextval('invoice_no_seq'),
  customer     text NOT NULL CHECK (length(customer) BETWEEN 1 AND 120),
  contact      text NOT NULL DEFAULT '',
  email        text NOT NULL DEFAULT '',
  pin          text NOT NULL DEFAULT '',
  address      text NOT NULL DEFAULT '',
  issued_at    timestamptz NOT NULL DEFAULT now(),
  due_at       timestamptz NOT NULL,
  vat_rate     numeric(5,2) NOT NULL DEFAULT 16 CHECK (vat_rate >= 0 AND vat_rate <= 100),
  draft        boolean NOT NULL DEFAULT false,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX invoices_no_key ON invoices (invoice_no);
CREATE TABLE invoice_lines (
  invoice_id  uuid NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  line_no     smallint NOT NULL,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  quantity    integer NOT NULL CHECK (quantity > 0),
  unit_cents  bigint NOT NULL CHECK (unit_cents >= 0),
  PRIMARY KEY (invoice_id, line_no)
);
CREATE TABLE invoice_payments (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id    uuid NOT NULL REFERENCES invoices (id),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  method        text NOT NULL,
  ref           text NOT NULL,
  by_name       text NOT NULL,
  paid_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_payments_invoice_idx ON invoice_payments (invoice_id);
CREATE TABLE invoice_reminders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id  uuid NOT NULL REFERENCES invoices (id),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  by_name     text NOT NULL
);

-- ---- VAT returns, closed periods, export log ---------------------------------------------------------------------------------------------------
CREATE TABLE vat_filings (
  month        text PRIMARY KEY CHECK (month ~ '^\d{4}-\d{2}$'),
  status       text NOT NULL CHECK (status IN ('draft', 'filed')),
  prepared_by  text NOT NULL,
  prepared_at  timestamptz NOT NULL DEFAULT now(),
  ack          text,
  filed_at     timestamptz,
  filed_by     text
);
CREATE TABLE period_closes (
  month      text PRIMARY KEY CHECK (month ~ '^\d{4}-\d{2}$'),
  closed_by  text NOT NULL,
  closed_at  timestamptz NOT NULL DEFAULT now(),
  note       text NOT NULL DEFAULT ''
);
CREATE SEQUENCE export_no_seq START 13;
CREATE TABLE export_jobs (
  id          uuid PRIMARY KEY,
  export_no   bigint NOT NULL DEFAULT nextval('export_no_seq'),
  name        text NOT NULL,
  dataset     text NOT NULL,
  format      text NOT NULL CHECK (format IN ('CSV', 'Excel')),
  row_count   integer NOT NULL DEFAULT 0,
  by_name     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- payroll ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE employee_pay (
  staff_id         uuid PRIMARY KEY REFERENCES staff (id),
  basic_cents      bigint NOT NULL DEFAULT 0 CHECK (basic_cents >= 0),
  house_cents      bigint NOT NULL DEFAULT 0 CHECK (house_cents >= 0),
  transport_cents  bigint NOT NULL DEFAULT 0 CHECK (transport_cents >= 0),
  kra_pin          text NOT NULL DEFAULT '',
  nssf_no          text NOT NULL DEFAULT '',
  sha_no           text NOT NULL DEFAULT '',
  pay_to           text NOT NULL DEFAULT '',
  start_date       date,
  updated_by       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payroll_runs (
  id               uuid PRIMARY KEY,
  month            text NOT NULL UNIQUE CHECK (month ~ '^\d{4}-\d{2}$'),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'paid')),
  prepared_by_id   text NOT NULL,
  prepared_by      text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at     timestamptz,
  approved_by_id   text,
  approved_by      text,
  approved_at      timestamptz,
  paid_at          timestamptz,
  paid_by          text,
  -- The statutory rates in force when the run was prepared, kept so an old run can always be explained.
  statutory        jsonb NOT NULL,
  version          integer NOT NULL DEFAULT 1
);
CREATE TABLE payroll_lines (
  run_id           uuid NOT NULL REFERENCES payroll_runs (id) ON DELETE CASCADE,
  staff_id         uuid NOT NULL REFERENCES staff (id),
  name             text NOT NULL,
  role             text NOT NULL,
  bonus_cents      bigint NOT NULL DEFAULT 0 CHECK (bonus_cents >= 0),
  other_deduction_cents bigint NOT NULL DEFAULT 0 CHECK (other_deduction_cents >= 0),
  note             text NOT NULL DEFAULT '',
  basic_cents      bigint NOT NULL,
  allowances_cents bigint NOT NULL,
  gross_cents      bigint NOT NULL,
  nssf_cents       bigint NOT NULL,
  shif_cents       bigint NOT NULL,
  housing_cents    bigint NOT NULL,
  taxable_cents    bigint NOT NULL,
  paye_cents       bigint NOT NULL,
  net_cents        bigint NOT NULL,
  pay_to           text NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, staff_id)
);
CREATE TABLE payroll_remittances (
  run_id  uuid NOT NULL REFERENCES payroll_runs (id),
  kind    text NOT NULL CHECK (kind IN ('PAYE', 'NSSF', 'SHIF', 'Housing levy')),
  ref     text NOT NULL,
  paid_at timestamptz NOT NULL DEFAULT now(),
  by_name text NOT NULL,
  PRIMARY KEY (run_id, kind)
);
