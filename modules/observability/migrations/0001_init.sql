create table collectors (
  id bigserial primary key,
  host_name text not null,
  version text not null,
  capabilities jsonb not null default '[]'::jsonb,
  payload_shape jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (host_name)
);

create table samples (
  id bigserial primary key,
  collector_id bigint not null references collectors (id) on delete cascade,
  collected_at timestamptz not null,
  metrics jsonb not null,
  created_at timestamptz not null default now()
);

create index samples_collector_collected_idx on samples (collector_id, collected_at desc);
