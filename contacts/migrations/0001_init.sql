create table contacts (
  id bigserial primary key,
  name text not null,
  phone text,
  email text,
  identity text unique,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index contacts_created_idx on contacts (id desc);

create table pipeline_stages (
  id bigserial primary key,
  name text not null,
  position integer not null,
  kind text not null check (kind in ('open', 'won', 'lost')),
  created_at timestamptz not null default now(),
  unique (position) deferrable initially deferred
);

insert into pipeline_stages (name, position, kind) values
  ('New', 1, 'open'),
  ('Contacted', 2, 'open'),
  ('Qualified', 3, 'open'),
  ('Won', 4, 'won'),
  ('Lost', 5, 'lost');

create table leads (
  id bigserial primary key,
  contact_id bigint not null references contacts (id) on delete cascade,
  stage_id bigint not null references pipeline_stages (id),
  title text not null,
  amount numeric(14, 2) check (amount is null or amount >= 0),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index leads_stage_idx on leads (stage_id, id);
create index leads_contact_idx on leads (contact_id);

create table lead_stage_events (
  id bigserial primary key,
  lead_id bigint not null references leads (id) on delete cascade,
  from_stage_id bigint references pipeline_stages (id),
  to_stage_id bigint not null references pipeline_stages (id),
  occurred_at timestamptz not null default now()
);

create index lead_stage_events_lead_idx on lead_stage_events (lead_id, id);
