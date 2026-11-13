create table collector_events (
  id bigserial primary key,
  collector_id bigint not null references collectors (id) on delete cascade,
  event_key text not null,
  occurred_at timestamptz not null,
  level text not null check (level in ('warning', 'error')),
  unit text not null,
  message text not null,
  created_at timestamptz not null default now(),
  unique (collector_id, event_key)
);

create index collector_events_collector_occurred_idx on collector_events (collector_id, occurred_at desc);
