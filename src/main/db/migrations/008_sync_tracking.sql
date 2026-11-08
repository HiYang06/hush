-- Cloud sync, step 1 (D-067): triggers record which rows changed, so the repo code never has to tell sync.
-- Only "which row" is kept; a push reads the row as it is then, so a reply streaming every 0.5s is one entry.
-- The triggers check NOT EXISTS rather than INSERT OR IGNORE: a trigger's conflict clause is overridden by
-- the outer statement's, so under an upsert (saveNote, the global prompt) OR IGNORE still fails.
CREATE TABLE sync_dirty (
  tbl    TEXT NOT NULL,
  row_id TEXT NOT NULL,
  PRIMARY KEY (tbl, row_id)
) WITHOUT ROWID;

-- applying = 1 while remote changes are written, so they aren't recorded and pushed back. A real table,
-- because triggers in the main schema can't read temp tables.
CREATE TABLE sync_state (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  applying INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sync_state (id) VALUES (1);

-- A note's id follows from its scope, so notes two devices wrote before their first sync are the same row
-- and get merged, instead of colliding on UNIQUE (scope, scope_id).
PRAGMA defer_foreign_keys = ON;
UPDATE note_revisions SET note_id = (SELECT n.scope || ':' || n.scope_id FROM notes n WHERE n.id = note_revisions.note_id);
UPDATE notes SET id = scope || ':' || scope_id;

-- Rebuilt to add 'sync_conflict': the local side of a note merge that failed is kept as a revision.
CREATE TABLE note_revisions_new (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('ai_append', 'ai_rewrite', 'migrate_in', 'migrate_out', 'merge', 'restore', 'sync_conflict')),
  created_at INTEGER NOT NULL
);
INSERT INTO note_revisions_new (rowid, id, note_id, content, reason, created_at)
  SELECT rowid, id, note_id, content, reason, created_at FROM note_revisions;
DROP TABLE note_revisions;
ALTER TABLE note_revisions_new RENAME TO note_revisions;
CREATE INDEX note_revisions_note ON note_revisions(note_id, created_at);

CREATE TRIGGER projects_sync_insert AFTER INSERT ON projects WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'projects', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'projects' AND row_id = new.id); END;
CREATE TRIGGER projects_sync_update AFTER UPDATE ON projects WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'projects', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'projects' AND row_id = new.id); END;
CREATE TRIGGER projects_sync_delete AFTER DELETE ON projects WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'projects', old.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'projects' AND row_id = old.id); END;

CREATE TRIGGER sessions_sync_insert AFTER INSERT ON sessions WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'sessions', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'sessions' AND row_id = new.id); END;
CREATE TRIGGER sessions_sync_update AFTER UPDATE ON sessions WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'sessions', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'sessions' AND row_id = new.id); END;
CREATE TRIGGER sessions_sync_delete AFTER DELETE ON sessions WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'sessions', old.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'sessions' AND row_id = old.id); END;

CREATE TRIGGER messages_sync_insert AFTER INSERT ON messages WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'messages', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'messages' AND row_id = new.id); END;
CREATE TRIGGER messages_sync_update AFTER UPDATE ON messages WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'messages', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'messages' AND row_id = new.id); END;
CREATE TRIGGER messages_sync_delete AFTER DELETE ON messages WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'messages', old.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'messages' AND row_id = old.id); END;

CREATE TRIGGER marks_sync_insert AFTER INSERT ON marks WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'marks', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'marks' AND row_id = new.id); END;
CREATE TRIGGER marks_sync_update AFTER UPDATE ON marks WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'marks', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'marks' AND row_id = new.id); END;
CREATE TRIGGER marks_sync_delete AFTER DELETE ON marks WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'marks', old.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'marks' AND row_id = old.id); END;

CREATE TRIGGER mark_categories_sync_insert AFTER INSERT ON mark_categories WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'mark_categories', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'mark_categories' AND row_id = new.id); END;
CREATE TRIGGER mark_categories_sync_update AFTER UPDATE ON mark_categories WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'mark_categories', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'mark_categories' AND row_id = new.id); END;
CREATE TRIGGER mark_categories_sync_delete AFTER DELETE ON mark_categories WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'mark_categories', old.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'mark_categories' AND row_id = old.id); END;

CREATE TRIGGER notes_sync_insert AFTER INSERT ON notes WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'notes', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'notes' AND row_id = new.id); END;
CREATE TRIGGER notes_sync_update AFTER UPDATE ON notes WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'notes', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'notes' AND row_id = new.id); END;
CREATE TRIGGER notes_sync_delete AFTER DELETE ON notes WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'notes', old.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'notes' AND row_id = old.id); END;

CREATE TRIGGER note_revisions_sync_insert AFTER INSERT ON note_revisions WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'note_revisions', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'note_revisions' AND row_id = new.id); END;
CREATE TRIGGER note_revisions_sync_update AFTER UPDATE ON note_revisions WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'note_revisions', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'note_revisions' AND row_id = new.id); END;
CREATE TRIGGER note_revisions_sync_delete AFTER DELETE ON note_revisions WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'note_revisions', old.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'note_revisions' AND row_id = old.id); END;

CREATE TRIGGER files_sync_insert AFTER INSERT ON files WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'files', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'files' AND row_id = new.id); END;
CREATE TRIGGER files_sync_update AFTER UPDATE ON files WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'files', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'files' AND row_id = new.id); END;
CREATE TRIGGER files_sync_delete AFTER DELETE ON files WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'files', old.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'files' AND row_id = old.id); END;

-- Providers sync without their key (D-067); the push leaves api_key_enc out.
CREATE TRIGGER providers_sync_insert AFTER INSERT ON providers WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'providers', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'providers' AND row_id = new.id); END;
CREATE TRIGGER providers_sync_update AFTER UPDATE ON providers WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'providers', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'providers' AND row_id = new.id); END;
CREATE TRIGGER providers_sync_delete AFTER DELETE ON providers WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'providers', old.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'providers' AND row_id = old.id); END;

CREATE TRIGGER models_sync_insert AFTER INSERT ON models WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'models', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'models' AND row_id = new.id); END;
CREATE TRIGGER models_sync_update AFTER UPDATE ON models WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'models', new.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'models' AND row_id = new.id); END;
CREATE TRIGGER models_sync_delete AFTER DELETE ON models WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_dirty SELECT 'models', old.id WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'models' AND row_id = old.id); END;

-- Only settings meant to follow the account; the rest belong to this device.
CREATE TRIGGER settings_sync_insert AFTER INSERT ON settings
WHEN (SELECT applying FROM sync_state) = 0 AND new.key IN ('system_prompt')
BEGIN INSERT INTO sync_dirty SELECT 'settings', new.key WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'settings' AND row_id = new.key); END;
CREATE TRIGGER settings_sync_update AFTER UPDATE ON settings
WHEN (SELECT applying FROM sync_state) = 0 AND new.key IN ('system_prompt')
BEGIN INSERT INTO sync_dirty SELECT 'settings', new.key WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'settings' AND row_id = new.key); END;
CREATE TRIGGER settings_sync_delete AFTER DELETE ON settings
WHEN (SELECT applying FROM sync_state) = 0 AND old.key IN ('system_prompt')
BEGIN INSERT INTO sync_dirty SELECT 'settings', old.key WHERE NOT EXISTS (SELECT 1 FROM sync_dirty WHERE tbl = 'settings' AND row_id = old.key); END;

-- Everything already here goes up on the first sign-in, through the same path as later changes.
INSERT INTO sync_dirty SELECT 'projects', id FROM projects;
INSERT INTO sync_dirty SELECT 'sessions', id FROM sessions;
INSERT INTO sync_dirty SELECT 'messages', id FROM messages;
INSERT INTO sync_dirty SELECT 'marks', id FROM marks;
INSERT INTO sync_dirty SELECT 'mark_categories', id FROM mark_categories;
INSERT INTO sync_dirty SELECT 'notes', id FROM notes;
INSERT INTO sync_dirty SELECT 'note_revisions', id FROM note_revisions;
INSERT INTO sync_dirty SELECT 'files', id FROM files;
INSERT INTO sync_dirty SELECT 'providers', id FROM providers;
INSERT INTO sync_dirty SELECT 'models', id FROM models;
INSERT INTO sync_dirty SELECT 'settings', key FROM settings WHERE key IN ('system_prompt');
