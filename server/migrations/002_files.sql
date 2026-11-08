-- Attachments this account has in object storage, with the size R2 reported once the upload finished.
-- Used for the storage quota and to only sign downloads for files that are really there.
CREATE TABLE files (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256     text NOT NULL,
  size       bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sha256)
);
