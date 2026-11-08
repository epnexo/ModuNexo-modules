-- The mark of a send that started and has not finished. It is written, and committed, before DocuSeal is asked to create
-- a submission, and cleared when the submission is recorded or DocuSeal is known not to have created one. A document that
-- still carries it may already have a submission in DocuSeal that the platform does not know of, so it is never sent again
-- until the owner has checked DocuSeal and cleared the mark by hand.
-- Runs with search_path = documents. `if not exists` keeps a repeated run harmless.
alter table documents add column if not exists send_started_at timestamptz;
