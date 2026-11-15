-- Context compaction: only the latest summary is kept; the messages it covers stay untouched (D-087).
-- compact_through_id is a message id, not a seq: a fork thread's conversation mixes its main session's messages with its own.
ALTER TABLE sessions ADD COLUMN compact_summary TEXT;
ALTER TABLE sessions ADD COLUMN compact_through_id TEXT;
ALTER TABLE sessions ADD COLUMN compacted_at INTEGER;
-- Input tokens of a reply's first request: the size of the context it was given. input_tokens sums every tool round.
ALTER TABLE messages ADD COLUMN context_tokens INTEGER;
