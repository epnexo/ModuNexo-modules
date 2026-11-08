-- Activity (prompts, tool calls, turn durations) is deduplicated across source files by the tool's own ids.
-- Resumed sessions and subagent logs repeat earlier lines in other files, so a per-file counter over-counts.
-- Each item is stored once per tool; its source file is remembered so the file's counters can be recomputed
-- exactly after any re-read. Only ids and a duration are stored, never text. Runs with search_path = ai_usage.
--
-- kind: 'prompt' (a prompt typed by the user), 'tool_call', or 'turn' (a finished turn, carrying duration_ms).
create table activity_items (
  tool_id      smallint not null references tools (id),
  kind         text not null check (kind in ('prompt', 'tool_call', 'turn')),
  external_id  text not null,
  source_key   text not null,
  session_id   bigint references sessions (id) on delete cascade,
  duration_ms  bigint not null default 0 check (duration_ms >= 0),
  primary key (tool_id, kind, external_id)
);

create index activity_items_source_idx on activity_items (tool_id, source_key);
create index activity_items_session_idx on activity_items (session_id);

-- A source such as OpenCode's database holds many sessions, so file-level counters cannot say which session an
-- item belongs to. Session totals now come from the items when a session has any, and from ingest_state
-- (Codex, which has no items) otherwise. The columns are unchanged.
create or replace view session_summary as
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
  coalesce(a.message_count, c.message_count, 0) as message_count,
  coalesce(a.tool_call_count, c.tool_call_count, 0) as tool_call_count,
  coalesce(a.duration_ms, c.duration_ms, 0) as duration_ms
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
) c on c.session_id = s.id
left join (
  select session_id,
         count(*) filter (where kind = 'prompt') as message_count,
         count(*) filter (where kind = 'tool_call') as tool_call_count,
         coalesce(sum(duration_ms) filter (where kind = 'turn'), 0) as duration_ms
  from activity_items
  where session_id is not null
  group by session_id
) a on a.session_id = s.id;

-- Claude Code counters were summed per file before activity_items existed and may contain repeats. Dropping
-- its file progress makes the next ingest re-read those files and recompute every counter from activity_items.
-- Events are keyed by natural key, so this inserts no duplicate events or sessions.
delete from ingest_state where tool_id = (select id from tools where slug = 'claude-code');
