-- The module's own behaviour settings: one row. It starts switched off.
create table config (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  instructions text not null default '',
  wait_seconds integer not null default 5 check (wait_seconds between 0 and 60),
  history_messages integer not null default 20 check (history_messages between 1 and 50),
  max_replies_per_hour integer not null default 10 check (max_replies_per_hour between 1 and 100),
  updated_at timestamptz not null default now()
);

insert into config default values;

-- A row means the assistant does not answer that conversation. The id is the inbox's conversation id, a plain number.
create table paused (
  conversation_id bigint primary key,
  reason text not null check (reason in ('human', 'handoff', 'limit', 'manual')),
  since timestamptz not null default now()
);

-- One row per reply the assistant decided to write. 'sending' is a claim: it is taken before the model is asked.
create table replies (
  id bigserial primary key,
  conversation_id bigint not null,
  in_reply_to bigint not null,
  message_id bigint,
  status text not null check (status in ('sending', 'sent', 'failed')),
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Never two replies in flight for one conversation, and never two for the same customer message.
create unique index replies_one_in_flight on replies (conversation_id) where status = 'sending';
create unique index replies_one_per_message on replies (conversation_id, in_reply_to) where status in ('sending', 'sent');
create index replies_recent_idx on replies (created_at desc);
create index replies_conversation_idx on replies (conversation_id, created_at desc);
