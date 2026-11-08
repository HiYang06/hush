-- Which kind of failure a reply hit, so the window can offer the right way out (a link to settings for a bad key).
ALTER TABLE messages ADD COLUMN error_kind TEXT;
