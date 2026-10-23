# contacts

## 0.2.1 - 2026-10-23

- Reports to the dashboard: the number of contacts, of open leads and their value, and an alert for open leads not moved for 7 days. Needs a platform with SDK 0.1.1 or later (the optional `dashboard` field of the manifest).
- No migration; nothing else changed.

## 0.2.0 - 2026-10-23

- Service API under `/svc/contacts/` with the scopes `contacts.read`, `contacts.write`, `leads.read` and `leads.write`: read a
  contact by id or identity, list and search, create, update, list the stages, list the leads of a contact, create a lead and
  move it. No delete.
- The forms now answer 400 for an id of 0 (they answered 404).
- No migration.

## 0.1.0 - 2026-10-23

- Contacts (name, phone, email, notes and a unique channel identity) with search.
- A pipeline that starts with New, Contacted, Qualified, Won and Lost; leads with an amount and a priority, and the history of
  their stage changes.
- Events `contact.created`, `contact.deleted` and `lead.stage_changed`; pages `/contacts` and `/pipeline`; permissions
  `contacts.read` and `contacts.write`.
