-- NULL means unknown: the adapter falls back to its own default for max output (D-034).
ALTER TABLE models ADD COLUMN context_window INTEGER;
ALTER TABLE models ADD COLUMN max_output_tokens INTEGER;
