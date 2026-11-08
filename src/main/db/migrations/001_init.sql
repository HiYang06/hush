CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  system_prompt TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  protocol    TEXT NOT NULL CHECK (protocol IN ('openai_chat', 'openai_responses', 'anthropic', 'gemini')),
  base_url    TEXT NOT NULL,
  api_key_enc BLOB,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE models (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_name        TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  supports_vision   INTEGER NOT NULL DEFAULT 0,
  supports_pdf      INTEGER NOT NULL DEFAULT 0,
  supports_thinking INTEGER NOT NULL DEFAULT 0,
  UNIQUE (provider_id, model_name)
);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('main', 'thread')),
  project_id        TEXT REFERENCES projects(id) ON DELETE CASCADE,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  anchor_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  anchor_quote      TEXT,
  anchor_start      INTEGER,
  anchor_end        INTEGER,
  anchor_prefix     TEXT,
  anchor_suffix     TEXT,
  context_mode      TEXT CHECK (context_mode IN ('fork', 'new')),
  title             TEXT NOT NULL DEFAULT '',
  provider_id       TEXT REFERENCES providers(id) ON DELETE SET NULL,
  model_id          TEXT REFERENCES models(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (
    (kind = 'main' AND parent_session_id IS NULL AND anchor_message_id IS NULL AND context_mode IS NULL)
    OR (kind = 'thread' AND project_id IS NULL AND parent_session_id IS NOT NULL
        AND anchor_message_id IS NOT NULL AND context_mode IS NOT NULL)
  )
);
CREATE INDEX sessions_project ON sessions(project_id);
CREATE INDEX sessions_parent ON sessions(parent_session_id);
CREATE INDEX sessions_anchor ON sessions(anchor_message_id);

-- Explicit INTEGER rowid: FTS5 external content keys on rowid, and VACUUM may renumber implicit rowids.
CREATE TABLE messages (
  rowid         INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content       TEXT NOT NULL DEFAULT '',
  thinking      TEXT,
  thinking_ms   INTEGER,
  attachments   TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL CHECK (status IN ('streaming', 'done', 'stopped', 'error')),
  error         TEXT,
  provider_id   TEXT,
  model_id      TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE mark_categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE marks (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  quote        TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset   INTEGER NOT NULL,
  prefix       TEXT NOT NULL,
  suffix       TEXT NOT NULL,
  comment      TEXT,
  category_id  TEXT REFERENCES mark_categories(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX marks_session ON marks(session_id);
CREATE INDEX marks_message ON marks(message_id);
CREATE INDEX marks_category ON marks(category_id);

-- Same explicit rowid as messages, for notes_fts.
CREATE TABLE notes (
  rowid      INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  scope      TEXT NOT NULL CHECK (scope IN ('global', 'project', 'session')),
  scope_id   TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  UNIQUE (scope, scope_id)
);

CREATE TABLE note_revisions (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('ai_append', 'ai_rewrite', 'migrate_in', 'migrate_out', 'merge', 'restore')),
  created_at INTEGER NOT NULL
);
CREATE INDEX note_revisions_note ON note_revisions(note_id, created_at);

CREATE TABLE files (
  id         TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  path       TEXT NOT NULL,
  extracted  TEXT,
  is_scanned INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content = 'messages',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  content,
  content = 'notes',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER notes_fts_update AFTER UPDATE OF content ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO notes_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Fixed ids so the defaults are recognizable; user-created categories get UUIDs.
INSERT INTO mark_categories (id, name, color, sort_order) VALUES
  ('cat-knowledge', '知识点', 'amber', 1),
  ('cat-question',  '疑问',   'blue',  2),
  ('cat-quote',     '原话',   'green', 3);
