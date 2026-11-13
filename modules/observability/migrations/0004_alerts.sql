create table alert_rules (
  id bigserial primary key,
  name text not null unique,
  kind text not null default 'metric' check (kind in ('metric', 'offline')),
  metric text check ((kind = 'metric') = (metric is not null) and (metric is null or metric ~ '^[a-z][a-zA-Z0-9_]{0,63}$')),
  operator text not null default '>' check (operator in ('>', '<')),
  threshold double precision not null,
  for_minutes integer not null default 0 check (for_minutes between 0 and 1440),
  severity text not null default 'warning' check (severity in ('warning', 'critical')),
  host_name text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table alerts (
  id bigserial primary key,
  rule_id bigint not null references alert_rules (id) on delete cascade,
  collector_id bigint not null references collectors (id) on delete cascade,
  severity text not null check (severity in ('warning', 'critical')),
  state text not null check (state in ('firing', 'resolved')),
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  last_value double precision,
  updated_at timestamptz not null default now()
);

create unique index alerts_one_firing_idx on alerts (rule_id, collector_id) where state = 'firing';
create index alerts_started_idx on alerts (started_at desc);
create index alerts_collector_started_idx on alerts (collector_id, started_at desc);

-- For an offline rule the threshold is the minutes without a sample; for a metric rule it is the metric value.
insert into alert_rules (name, kind, metric, operator, threshold, for_minutes, severity) values
  ('Host offline', 'offline', null, '>', 5, 0, 'critical'),
  ('Low disk space', 'metric', 'diskUsedPercent', '>', 85, 15, 'warning'),
  ('High CPU', 'metric', 'cpuPercent', '>', 90, 15, 'warning'),
  ('High temperature', 'metric', 'tempCelsius', '>', 80, 5, 'warning');
