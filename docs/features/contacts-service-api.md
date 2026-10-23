# contacts-service-api

Objective: a service-token API in `contacts` (v0.2.0) so other modules, agents and scripts can read and write contacts and leads without importing the module. Branch: feat/contacts-service-api. Delivery: single slice, merge and push only on the user's word. Test runner: `node --import tsx --test`.

## Specs

- S1. "empieza por la ruta de servicio de contacts": routes under `/svc/contacts/`, each guarded by a service-token scope; no change to the pages, the forms, the events or the data.
- S2. Scopes: `contacts.read`, `contacts.write`, `leads.read`, `leads.write`. [assumption: same words as the permissions; the platform keeps scopes and permissions apart]
- S3. `GET /svc/contacts/contact` with exactly one of `id` or `identity` answers the contact: `{ id, name, phone, email, identity, notes, createdAt, updatedAt }`; 404 `not_found`; 400 when neither or both, or the id is not a number. Scope `contacts.read`.
- S4. `GET /svc/contacts/contacts` answers `{ contacts: [...] }` newest first, filtered by `q` (name, phone, email, identity, ignoring case) and cut at `limit` (1 to 100, default 50; anything else is 400). Scope `contacts.read`.
- S5. `POST /svc/contacts/contacts/create` takes the same fields as the form and answers 201 with the contact and announces `contact.created`; an identity another contact holds answers 409 `{ error: "identity_taken", id }` with that contact's id. Scope `contacts.write`.
- S6. `POST /svc/contacts/contacts/update` takes `id` and any of the fields; a field that is absent keeps its value, an empty or null optional field clears it; 404 `not_found`; 409 `identity_taken`; 400 naming the field. Scope `contacts.write`.
- S7. `GET /svc/contacts/stages` answers `{ stages: [{ id, name, position, kind }] }`; `GET /svc/contacts/leads?contactId=N` answers `{ leads: [{ id, title, amount, priority, stage, closedAt }] }` (404 `not_found` for an unknown contact, 400 without a number). Scope `leads.read`.
- S8. `POST /svc/contacts/leads/create` (`contactId`, `title`, optional `amount` and `priority`) answers 201 `{ id }` or 404 `contact_not_found`; `POST /svc/contacts/leads/move` (`leadId`, `stageId`) answers `{ ok: true, changed }` and announces `lead.stage_changed` when it changed, 404 `lead_not_found` or `stage_not_found`. Scope `leads.write`.
- S9. JSON in and out. A body over 16 KiB is 413, one that is not a JSON object is 400, a field it cannot use is 400 naming the field. There is no delete over the API.

## Tasks

- [x] T1 (S2-S9) the eight routes, a lookup by identity, a `limit` on the list, the manifest scopes and version 0.2.0, with tests. inline. 18 tests; the repo's 185 pass and `tsc --noEmit` is clean. `idOf` now refuses 0 for the forms too (an id is above zero).
- T2 (S1) README section, pack, `modules add` review. inline.

## Log

- L1: "empieza por la ruta de servicio de contacts" (after the pending list, where it was recommended because it unblocks the inbox, the agent and the results).
