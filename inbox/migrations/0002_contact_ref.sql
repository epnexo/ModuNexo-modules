-- The inbox stops owning contacts: people live in the contacts module. A conversation keeps the reference the channel
-- uses for the person, a snapshot of their name, and (once linked) the id of the contact over there, with no foreign key.

alter table conversations add column contact_ref text;
alter table conversations add column contact_name text;

update conversations v set contact_ref = k.ref, contact_name = k.name from contacts k where k.id = v.contact_id;

alter table conversations alter column contact_ref set not null;

-- Dropping the column drops its foreign key; the new column has the same name and means something else.
alter table conversations drop column contact_id;
alter table conversations add column contact_id bigint;

drop table contacts;

create index conversations_person_idx on conversations (channel, contact_ref);
