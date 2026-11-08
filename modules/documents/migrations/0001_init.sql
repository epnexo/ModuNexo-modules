-- Schema `documents` holds document templates, the documents generated from them and their signature state.
-- Runs with search_path = documents. `updated_at` is set by the queries that change a row, not by a trigger.
-- No rows are inserted here: templates and the owner profile are created from the web or by an explicit command.

-- A template is a document type written as HTML with {{MARKERS}}.
create table templates (
  id           bigint generated always as identity primary key,
  slug         text not null unique,
  name         text not null,
  kind         text not null check (kind in ('nda', 'contract', 'proposal', 'other')),
  -- Prefix of the document numbers taken from this template, for example NDA in NDA-2026-001.
  ref_prefix   text not null,
  body_html    text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz
);

create table documents (
  id                       bigint generated always as identity primary key,
  -- Human number, PREFIX-YYYY-NNN, taken from `counters`.
  ref                      text not null unique,
  template_id              bigint not null references templates (id),
  -- The body this document was generated from, so editing a template never changes a document already created.
  template_body_snapshot   text not null,
  title                    text not null,
  counterparty_name        text not null,
  -- Values of the template variables.
  data                     jsonb not null default '{}'::jsonb,
  status                   text not null default 'draft' check (status in ('draft', 'generated', 'sent', 'completed', 'declined', 'expired')),
  pdf_path                 text,
  signature_fields         jsonb,
  docuseal_template_id     bigint,
  docuseal_submission_id   bigint,
  signing_links            jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  completed_at             timestamptz
);

create index documents_created_at_idx on documents (created_at desc);
create index documents_status_idx on documents (status);
create index documents_template_idx on documents (template_id);

-- Last number issued per prefix and year; taken inside the transaction that creates the document.
create table counters (
  prefix       text not null,
  year         integer not null,
  last_number  integer not null default 0 check (last_number >= 0),
  primary key (prefix, year)
);

-- The owner profile (company data, branding, default terms): one row, enforced by the constraint on `id`.
create table settings (
  id          smallint primary key default 1 check (id = 1),
  profile     jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
