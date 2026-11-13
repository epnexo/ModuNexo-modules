create table samples_hourly (
  collector_id bigint not null references collectors (id) on delete cascade,
  bucket timestamptz not null,
  metric text not null,
  avg_value double precision not null,
  min_value double precision not null,
  max_value double precision not null,
  sample_count integer not null check (sample_count > 0),
  primary key (collector_id, metric, bucket)
);

create table samples_daily (
  collector_id bigint not null references collectors (id) on delete cascade,
  bucket timestamptz not null,
  metric text not null,
  avg_value double precision not null,
  min_value double precision not null,
  max_value double precision not null,
  sample_count integer not null check (sample_count > 0),
  primary key (collector_id, metric, bucket)
);

create index samples_hourly_bucket_idx on samples_hourly (bucket);
create index samples_daily_bucket_idx on samples_daily (bucket);
create index samples_collected_idx on samples (collected_at);
