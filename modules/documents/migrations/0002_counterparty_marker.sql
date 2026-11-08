-- The marker whose value is the counterparty's name in a document made from the template. Optional: a template
-- without one makes the new-document form ask for the counterparty name as a field of its own.
-- Runs with search_path = documents. `if not exists` keeps a repeated run harmless.
alter table templates add column if not exists counterparty_marker text check (counterparty_marker ~ '^[A-Z_][A-Z0-9_]*$');

-- The NDA imported by the explicit command before this column existed: its counterparty name is B_NOMBRE.
-- Only a template of that slug that still has the marker in its body and has no choice yet is touched, and only
-- this column, so nothing the owner edited is overwritten.
update templates
   set counterparty_marker = 'B_NOMBRE'
 where slug = 'nda'
   and counterparty_marker is null
   and body_html like '%{{B_NOMBRE}}%';
