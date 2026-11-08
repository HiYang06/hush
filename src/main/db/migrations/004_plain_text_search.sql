-- Full-text search indexes what the reader sees, not the Markdown source (D-049): '**特**征值' must
-- match '特征值'. SQL can't strip Markdown, so the app writes `plain` alongside `content`; NULL means
-- not computed yet, and openDb fills those rows in (rows from before this migration).
ALTER TABLE messages ADD COLUMN plain TEXT;
ALTER TABLE notes ADD COLUMN plain TEXT;

DROP TRIGGER messages_fts_insert;
DROP TRIGGER messages_fts_delete;
DROP TRIGGER messages_fts_update;
DROP TABLE messages_fts;
DROP TRIGGER notes_fts_insert;
DROP TRIGGER notes_fts_delete;
DROP TRIGGER notes_fts_update;
DROP TABLE notes_fts;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  plain,
  content = 'messages',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);
-- Indexes every existing row as it stands (plain still NULL), so the 'delete' in the update trigger
-- always removes exactly what was indexed.
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, plain) VALUES (new.rowid, new.plain);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, plain) VALUES ('delete', old.rowid, old.plain);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF plain ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, plain) VALUES ('delete', old.rowid, old.plain);
  INSERT INTO messages_fts(rowid, plain) VALUES (new.rowid, new.plain);
END;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  plain,
  content = 'notes',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);
INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');

CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, plain) VALUES (new.rowid, new.plain);
END;
CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, plain) VALUES ('delete', old.rowid, old.plain);
END;
CREATE TRIGGER notes_fts_update AFTER UPDATE OF plain ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, plain) VALUES ('delete', old.rowid, old.plain);
  INSERT INTO notes_fts(rowid, plain) VALUES (new.rowid, new.plain);
END;
