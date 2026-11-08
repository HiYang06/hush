-- Cloud sync, step 3 (D-067): what the sync engine remembers between runs.

-- The last server seq this device has pulled (or pushed, see PushResponse.cursor in src/shared/sync.ts).
ALTER TABLE sync_state ADD COLUMN pull_cursor INTEGER NOT NULL DEFAULT 0;

-- Each note as it was the last time it matched the server: seq is sent as baseSeq, content is the
-- common ancestor for the three-way merge when the server has moved on. No foreign key: a note deleted
-- here still needs its seq to push the tombstone.
CREATE TABLE sync_note_base (
  note_id TEXT PRIMARY KEY,
  seq     INTEGER NOT NULL,
  content TEXT NOT NULL
) WITHOUT ROWID;
