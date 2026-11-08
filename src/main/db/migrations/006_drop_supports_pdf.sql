-- PDFs are prepared locally for every model (D-057), so whether a model reads PDFs no longer matters.
ALTER TABLE models DROP COLUMN supports_pdf;
