create table settings (
  id smallint primary key default 1 check (id = 1),
  timezone text not null default 'UTC',
  slot_minutes integer not null default 30 check (slot_minutes between 5 and 480),
  buffer_minutes integer not null default 0 check (buffer_minutes between 0 and 240),
  horizon_days integer not null default 14 check (horizon_days between 1 and 90),
  updated_at timestamptz not null default now()
);

insert into settings default values;

create table weekly_hours (
  id bigserial primary key,
  weekday smallint not null check (weekday between 0 and 6),
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440),
  check (end_minute > start_minute)
);

create index weekly_hours_day_idx on weekly_hours (weekday, start_minute);

-- Monday to Friday, 09:00 to 17:00, until the administrator says otherwise.
insert into weekly_hours (weekday, start_minute, end_minute) select day, 540, 1020 from generate_series(1, 5) day;

create table bookings (
  id bigserial primary key,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'booked' check (status in ('booked', 'cancelled')),
  attendee_name text not null,
  contact_id bigint,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (ends_at > starts_at)
);

create index bookings_starts_idx on bookings (starts_at) where status = 'booked';
