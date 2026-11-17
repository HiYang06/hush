-- Preserves Markdown/LaTeX delimiters on quoted passages so right-panel quotes render formulas and formatting,
-- while anchor_quote / quote keep the plain-text form used to locate DOM highlights.
ALTER TABLE sessions ADD COLUMN anchor_markdown TEXT;
ALTER TABLE marks ADD COLUMN quote_markdown TEXT;
