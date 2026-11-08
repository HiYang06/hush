-- Keys for the search services behind the web tools; one row per configured service.
CREATE TABLE search_services (
  id TEXT PRIMARY KEY CHECK (id IN ('tavily', 'exa')),
  api_key_enc BLOB NOT NULL
);

-- Whether the model accepts function tools; unchecked means no tools are sent, so no web search.
ALTER TABLE models ADD COLUMN supports_tools INTEGER NOT NULL DEFAULT 1;

-- JSON: the searches and pages read for a reply and its numbered sources; NULL when it didn't go online.
ALTER TABLE messages ADD COLUMN web TEXT;
