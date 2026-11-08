-- The PDF now lives in the platform's file store; the document keeps the id of that file. `pdf_path` stays and now holds
-- only the file's display name (REF-counterparty.pdf). A row written before this migration has no id and so no PDF to
-- download: those PDFs were files in a folder of the old platform and are not carried over.
-- Runs with search_path = documents. `if not exists` keeps a repeated run harmless.
alter table documents add column if not exists pdf_file_id text;
