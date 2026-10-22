# contacts

Objective: a module `contacts` (people, pipeline stages, deals, stage history, two events) built here and installed as an archive, never inside the platform. Branch: feat/contacts-module. Delivery: single slice, local until the user says push. Test runner: `node --import tsx --test`.

## Specs

- S1. Scope the user approved: "contactos, etapas del pipeline, negocios (leads) con su historial de cambios de etapa, y los eventos `contact.created` y `lead.stage_changed`"; CSV import is a later version. "sí, ese alcance está bien, empieza para crear esos modulos son independientes para subirlos".
- S2. Contacts: a contact has a name (required, up to 200 characters), optional phone, email, `identity` (a channel identity such as `wa:+573001112233`, unique when set) and notes. Create, edit, delete, list newest first with a search over name, phone, email and identity. [assumption: list shows at most 100]
- S3. Pipeline stages: the module starts with `New`, `Contacted`, `Qualified`, `Won` (kind won), `Lost` (kind lost), in that order. A writer can add a stage (kind open, placed just before the first `won` or `lost` stage) and rename one. [assumption: no delete and no reorder in v1]
- S4. Leads: a lead belongs to one contact and sits in one stage; it has a title (required), an optional amount, a priority (`low`, `normal`, `high`) and starts in the first stage. Creating it records a first history row (from nothing, to that stage) and announces nothing. Moving it to another stage records a history row (from, to, when). Moving to a `won` or `lost` stage sets `closed_at`; moving back to an open stage clears it.
- S5. Events: `contact.created` `{ contactId }`, `contact.deleted` `{ contactId }` and `lead.stage_changed` `{ leadId, contactId, fromStageId, toStageId, toKind }`, each published in the same transaction as the write. Deleting a contact deletes its leads and history; moving a lead to the stage it already has changes nothing and announces nothing.
- S6. Pages: `/contacts` (list, search, create form, a contact's detail and its leads with `?c=<id>`) and `/pipeline` (a column per stage with its leads and a form to move each lead). Forms post to routes that check the origin is this site and answer 303 back to the page. Permissions `contacts.read` and `contacts.write`.
- S7. No foreign key to any other module, and no import of another module.

## Tasks

- T1 (S2, S5) manifest, migration, contacts store with tests. inline.
- T2 (S3, S4, S5) pipeline store (stages, leads, move, board) with tests. inline.
- T3 (S2, S3, S4, S6) form routes with tests (origin, validation, redirect). inline.
- T4 (S6) the two pages. inline.
- T5 (S1-S7) README section, pack, `modules add` review, install on a scratch data dir, verifier.

## Log

- L1: "sí, ese alcance está bien, empieza para crear esos modulos son independientes para subirlos".
