-- When a tool's data last reached the platform. One row per tool, moved forward on every batch received through
-- the ingest endpoint, including a batch that changes nothing. A local run records the same moment in
-- ingest_state.updated_at, so the page reads the later of the two. Runs with search_path = ai_usage.
create table ingest_receipts (
  tool_id      smallint primary key references tools (id),
  received_at  timestamptz not null default now()
);
