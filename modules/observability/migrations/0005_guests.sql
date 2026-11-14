create table guests (
  id bigserial primary key,
  collector_id bigint not null references collectors (id) on delete cascade,
  vmid integer not null,
  name text not null,
  kind text not null check (kind in ('qemu', 'lxc')),
  node text not null default '',
  running boolean not null default false,
  backed_up boolean,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_up_at timestamptz,
  unique (collector_id, vmid)
);

create table guest_sessions (
  id bigserial primary key,
  guest_id bigint not null references guests (id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create unique index guest_sessions_open_idx on guest_sessions (guest_id) where ended_at is null;
create index guest_sessions_started_idx on guest_sessions (guest_id, started_at desc);

create table guest_samples (
  guest_id bigint not null references guests (id) on delete cascade,
  collected_at timestamptz not null,
  metrics jsonb not null
);
create index guest_samples_idx on guest_samples (guest_id, collected_at);

create table guest_samples_hourly (
  guest_id bigint not null references guests (id) on delete cascade,
  bucket timestamptz not null,
  metric text not null,
  avg_value double precision not null,
  min_value double precision not null,
  max_value double precision not null,
  sample_count integer not null check (sample_count > 0),
  primary key (guest_id, metric, bucket)
);

create table guest_samples_daily (
  guest_id bigint not null references guests (id) on delete cascade,
  bucket timestamptz not null,
  metric text not null,
  avg_value double precision not null,
  min_value double precision not null,
  max_value double precision not null,
  sample_count integer not null check (sample_count > 0),
  primary key (guest_id, metric, bucket)
);
