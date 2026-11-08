CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL UNIQUE,
  -- The next seq to hand out; pushes take it under FOR UPDATE, so a user's seqs commit in order.
  next_seq   bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One pending code per email; a new request replaces it.
CREATE TABLE login_codes (
  email      text PRIMARY KEY,
  code_hash  text NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  sent_at    timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Only the token's sha256 is kept, so a leaked database can't be used to sign in.
CREATE TABLE tokens (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tokens_user ON tokens(user_id);

-- The latest state of every synced row. A delete keeps the row as a tombstone (deleted, data NULL),
-- so devices that pull later still learn about it.
CREATE TABLE sync_rows (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tbl     text NOT NULL,
  row_id  text NOT NULL,
  seq     bigint NOT NULL,
  deleted boolean NOT NULL,
  data    jsonb,
  PRIMARY KEY (user_id, tbl, row_id)
);
CREATE INDEX sync_rows_user_seq ON sync_rows(user_id, seq);
