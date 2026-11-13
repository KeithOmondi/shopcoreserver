-- 0010: customer support: tickets, live chat, refunds, returns, disputes, reviews and the help centre.

ALTER TABLE orders ADD COLUMN refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0);

CREATE SEQUENCE ticket_no_seq START 1001;
CREATE TABLE tickets (
  id                 uuid PRIMARY KEY,
  ticket_no          bigint NOT NULL DEFAULT nextval('ticket_no_seq'),
  kind               text NOT NULL CHECK (kind IN ('customer', 'rider')),
  subject            text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  category           text NOT NULL DEFAULT 'General' CHECK (length(category) <= 60),
  priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'escalated', 'resolved')),
  assignee_id        uuid,
  assignee_name      text,
  person_id          uuid NOT NULL,
  person_name        text NOT NULL DEFAULT '',
  order_id           uuid REFERENCES orders (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  first_response_at  timestamptz,
  resolved_at        timestamptz,
  csat               smallint CHECK (csat BETWEEN 1 AND 5)
);
CREATE UNIQUE INDEX tickets_no_key ON tickets (ticket_no);
CREATE INDEX tickets_status_idx ON tickets (status, priority, created_at);
CREATE INDEX tickets_person_idx ON tickets (person_id, created_at DESC);
CREATE INDEX tickets_assignee_idx ON tickets (assignee_id) WHERE status <> 'resolved';
CREATE INDEX tickets_order_idx ON tickets (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE ticket_messages (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id  uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  from_kind  text NOT NULL CHECK (from_kind IN ('customer', 'rider', 'agent', 'note')),
  by_name    text NOT NULL,
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_messages_ticket_idx ON ticket_messages (ticket_id, id);

CREATE TABLE ticket_activity (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id  uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  text       text NOT NULL,
  by_name    text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_activity_ticket_idx ON ticket_activity (ticket_id, id DESC);

CREATE TABLE chats (
  id             uuid PRIMARY KEY,
  customer_id    uuid NOT NULL,
  name           text NOT NULL DEFAULT '',
  order_id       uuid REFERENCES orders (id),
  assignee_id    uuid,
  assignee_name  text,
  closed         boolean NOT NULL DEFAULT false,
  unread         integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_at        timestamptz NOT NULL DEFAULT now()
);
-- A customer has at most one open conversation.
CREATE UNIQUE INDEX chats_open_key ON chats (customer_id) WHERE NOT closed;
CREATE INDEX chats_queue_idx ON chats (last_at DESC) WHERE NOT closed;

CREATE TABLE chat_messages (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id    uuid NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  from_kind  text NOT NULL CHECK (from_kind IN ('customer', 'agent')),
  by_name    text NOT NULL,
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_chat_idx ON chat_messages (chat_id, id);

-- ---- refunds, returns, disputes (the Claims module) -------------------------------------------------------------------

CREATE SEQUENCE refund_no_seq START 3001;
CREATE TABLE refunds (
  id                uuid PRIMARY KEY,
  refund_no         bigint NOT NULL DEFAULT nextval('refund_no_seq'),
  order_id          uuid NOT NULL REFERENCES orders (id),
  customer_id       uuid NOT NULL,
  customer_name     text NOT NULL DEFAULT '',
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  reason            text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  note              text NOT NULL DEFAULT '',
  priority          text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status            text NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review', 'approved', 'partly_approved', 'rejected')),
  ticket_id         uuid REFERENCES tickets (id),
  opened_by         text NOT NULL DEFAULT 'Customer',
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid,
  decided_by_name   text,
  decided_at        timestamptz,
  decided_cents     bigint,
  decision_reason   text
);
CREATE UNIQUE INDEX refunds_no_key ON refunds (refund_no);
CREATE INDEX refunds_status_idx ON refunds (status, submitted_at);
CREATE INDEX refunds_order_idx ON refunds (order_id);
-- At most one undecided request per order, so the same complaint isn't refunded twice.
CREATE UNIQUE INDEX refunds_open_order_key ON refunds (order_id) WHERE status = 'needs_review';

CREATE TABLE refund_notes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_id  uuid NOT NULL REFERENCES refunds (id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  by_name    text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE return_request_no_seq START 2001;
CREATE TABLE return_requests (
  id              uuid PRIMARY KEY,
  request_no      bigint NOT NULL DEFAULT nextval('return_request_no_seq'),
  order_id        uuid NOT NULL REFERENCES orders (id),
  customer_id     uuid NOT NULL,
  customer_name   text NOT NULL DEFAULT '',
  product_id      uuid REFERENCES products (id),
  item            text NOT NULL,
  item_value_cents bigint NOT NULL DEFAULT 0,
  qty             integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  reason          text NOT NULL,
  statement       text NOT NULL DEFAULT '',
  photos          integer NOT NULL DEFAULT 0 CHECK (photos >= 0),
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'review', 'pending', 'evidence_requested', 'approved', 'rejected')),
  inspection      text NOT NULL DEFAULT 'confirmed' CHECK (inspection IN ('confirmed', 'more')),
  note            text NOT NULL DEFAULT '',
  ticket_id       uuid REFERENCES tickets (id),
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  decided_by      text,
  decided_at      timestamptz
);
CREATE UNIQUE INDEX return_requests_no_key ON return_requests (request_no);
CREATE INDEX return_requests_status_idx ON return_requests (status, submitted_at);
-- Approved returns arrive in the warehouse queue exactly once.
ALTER TABLE warehouse_returns ADD COLUMN support_request_id uuid UNIQUE REFERENCES return_requests (id);

CREATE SEQUENCE dispute_no_seq START 4001;
CREATE TABLE disputes (
  id                  uuid PRIMARY KEY,
  dispute_no          bigint NOT NULL DEFAULT nextval('dispute_no_seq'),
  order_id            uuid NOT NULL REFERENCES orders (id),
  customer_id         uuid NOT NULL,
  customer_name       text NOT NULL DEFAULT '',
  rider_id            uuid REFERENCES riders (id),
  rider_name          text NOT NULL DEFAULT 'Unassigned',
  claim_by            text NOT NULL DEFAULT 'customer' CHECK (claim_by IN ('customer', 'rider')),
  category            text NOT NULL DEFAULT 'Delivery' CHECK (length(category) <= 60),
  priority            text NOT NULL DEFAULT 'high' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status              text NOT NULL DEFAULT 'awaiting_decision' CHECK (status IN ('awaiting_decision', 'escalated', 'resolved_customer', 'resolved_rider')),
  customer_statement  text NOT NULL DEFAULT '',
  rider_statement     text NOT NULL DEFAULT '',
  evidence            jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes               text NOT NULL DEFAULT '',
  ticket_id           uuid REFERENCES tickets (id),
  assignee_name       text,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  sla_due_at          timestamptz NOT NULL DEFAULT now() + interval '2 hours',
  outcome_by          text,
  outcome_at          timestamptz,
  outcome_note        text
);
CREATE UNIQUE INDEX disputes_no_key ON disputes (dispute_no);
CREATE INDEX disputes_status_idx ON disputes (status, opened_at);

-- ---- reviews and the help centre --------------------------------------------------------------------------------------------

CREATE TABLE reviews (
  id             uuid PRIMARY KEY,
  order_id       uuid REFERENCES orders (id),
  customer_id    uuid NOT NULL,
  customer_name  text NOT NULL DEFAULT '',
  rating         smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body           text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  topic          text NOT NULL DEFAULT 'Delivery' CHECK (length(topic) <= 40),
  state          text NOT NULL DEFAULT 'visible' CHECK (state IN ('visible', 'flagged', 'hidden')),
  reply          text,
  replied_by     text,
  checked        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_state_idx ON reviews (state, created_at DESC);
CREATE UNIQUE INDEX reviews_order_key ON reviews (order_id, customer_id) WHERE order_id IS NOT NULL;

CREATE TABLE help_articles (
  id          uuid PRIMARY KEY,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  category    text NOT NULL CHECK (length(category) BETWEEN 1 AND 60),
  body        text NOT NULL CHECK (length(body) <= 20000),
  live        boolean NOT NULL DEFAULT false,
  views       integer NOT NULL DEFAULT 0,
  author      text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX help_articles_live_idx ON help_articles (category) WHERE live;

CREATE TABLE canned_replies (
  id        uuid PRIMARY KEY,
  title     text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  category  text NOT NULL CHECK (length(category) BETWEEN 1 AND 60),
  body      text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  uses      integer NOT NULL DEFAULT 0,
  live      boolean NOT NULL DEFAULT true
);

-- What shoppers searched the help centre for and didn't find: a to-do list for new articles.
CREATE TABLE help_missed_searches (
  q      text PRIMARY KEY CHECK (length(q) BETWEEN 2 AND 100),
  count  integer NOT NULL DEFAULT 1,
  last_at timestamptz NOT NULL DEFAULT now()
);
