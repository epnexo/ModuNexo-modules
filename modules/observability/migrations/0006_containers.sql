-- Snapshot of the Docker containers each collector's platform (Dokploy, Coolify or plain Docker) reports.
-- No per-container series: containers are many and short-lived, so only the latest state is kept.
create table containers (
  id bigserial primary key,
  collector_id bigint not null references collectors (id) on delete cascade,
  name text not null,
  platform text not null check (platform in ('dokploy', 'coolify', 'docker')),
  project text not null default '',
  environment text not null default '',
  service text not null default '',
  image text not null default '',
  state text not null check (state in ('running', 'exited', 'restarting', 'paused', 'created', 'dead', 'removing')),
  restarts integer not null default 0 check (restarts >= 0),
  started_at timestamptz,
  domain text not null default '',
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  gone_at timestamptz,
  unique (collector_id, name)
);
create index containers_project_idx on containers (project, name);
