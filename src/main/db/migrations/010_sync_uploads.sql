-- Cloud sync, step 5 (D-067): attachments whose bytes this device still has to upload. Only files added
-- here: a file that came from another device is already in the cloud. Kept apart from sync_dirty so a
-- file that can't go up (no room left in the account) doesn't hold back its row or anything else.
CREATE TABLE sync_uploads (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TRIGGER files_sync_upload AFTER INSERT ON files WHEN (SELECT applying FROM sync_state) = 0
BEGIN INSERT INTO sync_uploads (file_id) VALUES (new.id); END;

INSERT INTO sync_uploads (file_id) SELECT id FROM files;
