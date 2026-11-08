-- Schema `ai_usage` records how much the AI coding CLIs are used. Only metadata and counters are stored:
-- never prompts, responses, tool inputs or outputs, or file paths. Runs with search_path = ai_usage.
--
-- Counter conventions: a counter a tool does not report is NULL, never 0.
--   input_tokens        fresh input, excluding cache reads and writes
--   cache_read_tokens   tokens served from the prompt cache
--   cache_write_tokens  tokens written to the prompt cache
--   output_tokens       all generated tokens, including reasoning
--   reasoning_tokens    the reasoning part of output_tokens (informational, not added to totals)

create table tools (
  id    smallint generated always as identity primary key,
  slug  text not null unique,
  name  text not null
);

insert into tools (slug, name) values ('claude-code', 'Claude Code'), ('codex', 'Codex');

create table sessions (
  id             bigint generated always as identity primary key,
  tool_id        smallint not null references tools (id),
  external_id    text not null,
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  project_label  text,
  unique (tool_id, external_id)
);

create index sessions_started_at_idx on sessions (started_at);

-- One row per model response (Claude Code) or per token_count change (Codex): the finest grain with counters.
create table usage_events (
  id                  bigint generated always as identity primary key,
  tool_id             smallint not null references tools (id),
  session_id          bigint not null references sessions (id) on delete cascade,
  -- Natural key from the tool's own ids; makes ingestion idempotent.
  external_id         text not null,
  occurred_at         timestamptz not null,
  model               text,
  input_tokens        bigint check (input_tokens >= 0),
  cache_read_tokens   bigint check (cache_read_tokens >= 0),
  cache_write_tokens  bigint check (cache_write_tokens >= 0),
  output_tokens       bigint check (output_tokens >= 0),
  reasoning_tokens    bigint check (reasoning_tokens >= 0),
  total_tokens        bigint generated always as (
    coalesce(input_tokens, 0) + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0) + coalesce(output_tokens, 0)
  ) stored,
  unique (tool_id, external_id)
);

create index usage_events_occurred_at_idx on usage_events (occurred_at);
create index usage_events_session_idx on usage_events (session_id);

-- Progress per source log file, so a re-run only reads what was appended. The path is stored as a SHA-256
-- hash because paths contain project and session names. The counters are running totals for the file.
create table ingest_state (
  tool_id           smallint not null references tools (id),
  source_key        text not null,
  size_bytes        bigint not null,
  mtime_ms          bigint not null,
  byte_offset       bigint not null,
  session_id        bigint references sessions (id) on delete set null,
  message_count     integer not null default 0,
  tool_call_count   integer not null default 0,
  duration_ms       bigint not null default 0,
  parser_state      jsonb,
  updated_at        timestamptz not null default now(),
  primary key (tool_id, source_key)
);

create index ingest_state_session_idx on ingest_state (session_id);

-- Daily rollup per tool and model. Days are UTC dates.
create view daily_usage as
select
  (e.occurred_at at time zone 'UTC')::date as day,
  t.slug as tool,
  e.model,
  count(*) as events,
  count(distinct e.session_id) as sessions,
  sum(e.input_tokens) as input_tokens,
  sum(e.cache_read_tokens) as cache_read_tokens,
  sum(e.cache_write_tokens) as cache_write_tokens,
  sum(e.output_tokens) as output_tokens,
  sum(e.reasoning_tokens) as reasoning_tokens,
  sum(e.total_tokens) as total_tokens
from usage_events e
join tools t on t.id = e.tool_id
group by 1, 2, 3;

-- One row per session with its totals; `model` is set only when every event used the same model.
create view session_summary as
select
  s.id,
  t.slug as tool,
  s.external_id,
  s.started_at,
  s.ended_at,
  s.project_label,
  u.model,
  coalesce(u.events, 0) as events,
  coalesce(u.total_tokens, 0) as total_tokens,
  coalesce(c.message_count, 0) as message_count,
  coalesce(c.tool_call_count, 0) as tool_call_count,
  coalesce(c.duration_ms, 0) as duration_ms
from sessions s
join tools t on t.id = s.tool_id
left join (
  select session_id,
         count(*) as events,
         sum(total_tokens) as total_tokens,
         case when count(distinct model) = 1 and count(model) = count(*) then min(model) end as model
  from usage_events
  group by session_id
) u on u.session_id = s.id
left join (
  select session_id,
         sum(message_count) as message_count,
         sum(tool_call_count) as tool_call_count,
         sum(duration_ms) as duration_ms
  from ingest_state
  group by session_id
) c on c.session_id = s.id;
