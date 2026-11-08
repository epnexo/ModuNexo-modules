-- The settings of a template's variables: for each marker asked per document, its label, help line, kind (line, text
-- or date), default value and, for a date, its language. A JSON object from the marker name to its settings; the
-- empty object means no settings, and the variable behaves as it did before this column existed. The application
-- validates what it writes; the check only keeps the column an object.
-- Runs with search_path = documents. `if not exists` keeps a repeated run harmless.
alter table templates add column if not exists variables jsonb not null default '{}'::jsonb check (jsonb_typeof(variables) = 'object');
