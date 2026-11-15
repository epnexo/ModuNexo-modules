-- Alerts about one container or guest instead of a whole host. Existing rows keep working: a host alert has no subject.
-- Existing containers get the current time as the start of their state, so nothing alerts on history it never saw.
alter table containers add column state_since timestamptz not null default now();

alter table alert_rules drop constraint alert_rules_kind_check;
alter table alert_rules add constraint alert_rules_kind_check check (kind in ('metric', 'offline', 'container_down', 'guest_down'));

alter table alerts add column subject text;
alter table alerts add column project text;
drop index alerts_one_firing_idx;
create unique index alerts_one_firing_idx on alerts (rule_id, collector_id, coalesce(subject, '')) where state = 'firing';

-- For these rules only for_minutes counts: how long the container or guest has been out of the running state.
insert into alert_rules (name, kind, metric, operator, threshold, for_minutes, severity) values
  ('Container not running', 'container_down', null, '>', 0, 5, 'warning'),
  ('Guest down', 'guest_down', null, '>', 0, 5, 'warning')
on conflict (name) do nothing;
