# contacts

> Module reference. For the full catalog and installation, see the [README](../../README.md).

People, a pipeline and leads. Needs no settings. Permissions: `contacts.read` opens the pages, `contacts.write` can change
anything (a page cannot ask who is looking, so the forms are shown to every reader and the gate refuses the send).

- **Contacts** (`/contacts`): name (required), phone, email, notes and an optional channel `identity` (for example
  `wa:+573001112233`) that no two contacts share. Search covers name, phone, email and identity, ignoring case. The list
  shows the newest 100. Deleting a contact deletes its leads and their history.
- **Pipeline** (`/pipeline`): a column per stage. It starts with New, Contacted, Qualified, Won and Lost; Won and Lost are
  closing stages. A writer can add a stage (placed just before the first closing one) and rename any stage; stages are
  not deleted or reordered yet.
- **Leads**: a title, an optional amount (up to 2 decimals) and a priority (`low`, `normal`, `high`), belonging to one
  contact and starting in the first stage. Every move writes a history row; moving to a closing stage sets `closed_at`,
  moving back to an open one clears it.
- **Events**: `contacts.contact.created` `{ contactId }`, `contacts.contact.deleted` `{ contactId }` and
  `contacts.lead.stage_changed` `{ leadId, contactId, fromStageId, toStageId, toKind }`, each published in the same
  transaction as the write. Creating a lead, editing a contact and moving a lead to the stage it is already in announce
  nothing. Other modules subscribe to these events; none imports this one.
- **Service API** (0.2.0), for other modules, an agent or a script. Create a token with the scopes you need, then call it:

```bash
npm run modunexo -- tokens create contacts --name agent --scope contacts.read --scope leads.read --scope leads.write
curl -H "Authorization: Bearer mdnx_..." "https://host/svc/contacts/contact?identity=wa:%2B573001112233"
curl -H "Authorization: Bearer mdnx_..." -X POST https://host/svc/contacts/leads/create -d '{"contactId":12,"title":"Website","amount":1500}'
```

  | Route | Scope | Does |
  | --- | --- | --- |
  | `GET /svc/contacts/contact?id=` or `?identity=` | `contacts.read` | one contact; 404 `not_found` |
  | `GET /svc/contacts/contacts?q=&limit=` | `contacts.read` | `{ contacts }`, newest first, `limit` 1 to 100 (default 50) |
  | `POST /svc/contacts/contacts/create` | `contacts.write` | 201 with the contact; 409 `{ error: "identity_taken", id }` |
  | `POST /svc/contacts/contacts/update` | `contacts.write` | `{ id, ...fields }`: absent fields stay, null or empty clears |
  | `GET /svc/contacts/stages` | `leads.read` | `{ stages: [{ id, name, position, kind }] }` |
  | `GET /svc/contacts/leads?contactId=` | `leads.read` | `{ leads: [{ id, title, amount, priority, stage, closedAt }] }` |
  | `POST /svc/contacts/leads/create` | `leads.write` | `{ contactId, title, amount?, priority? }`: 201 `{ id }` |
  | `POST /svc/contacts/leads/move` | `leads.write` | `{ leadId, stageId }`: `{ ok, changed }`, announces `lead.stage_changed` |

  JSON in and out; a body over 16 KiB is 413 and one it cannot use is 400 naming the field. Creating through the API
  announces `contact.created` like the form does. There is no delete over the API.
- **Not yet**: CSV import, deleting or reordering stages, and assigning an owner.
