# inbox-contact-ref

Objective: the `inbox` (v0.2.0) stops owning contacts. A conversation keeps the channel's reference to the person, a snapshot of their name and, when the contacts module is reachable, the id of the contact there. Branch: feat/inbox-contact-ref. Delivery: single slice, merge and push only on the user's word. Test runner: `node --import tsx --test`.

## Specs

- S1. "hazlo ahora, refactoriza el inbox", after decision A of the guide: "el inbox pasa a guardar solo la referencia al contacto" and "reads the rest through an event or a service-token call". The inbox has no `contacts` table; each conversation has `contact_ref` (what the channel calls the person, formerly `contacts.ref`), `contact_name` (a snapshot, may be null) and `contact_id` (a plain number for the contacts module, null until linked; no foreign key).
- S2. The webhook does not change: same body, same answers (200 `{ ok, duplicate }`, 400 with the reason), same deduplication, same event payload. Without a `contact` the reference is the `threadRef` and the name is null. A conversation takes the name of the first message that carries one; a new thread of a person the inbox already knows by name (same channel and reference) starts with that name.
- S3. Migration `0002`: every conversation gets the `ref` and `name` of the contact it pointed to, `contact_id` becomes null, the `contacts` table goes away; messages, threads, unread counts and dedupe keys are untouched.
- S4. Reads and delivery use the new columns: the page shows `contact_name`, else `contact_ref`, as before; the `deliver` job sends the same `contactRef` as before.
- S5. Optional link to the contacts module, off until configured: settings `contacts_url` (string, the platform's address, http or https) and `contacts_token` (secret, a service token with `contacts.read` and `contacts.write`). When both are set and a message arrives for a conversation with no `contact_id`, a job `link_contact` (up to 5 attempts, deduplicated per conversation) looks the person up at `GET <url>/svc/contacts/contact?identity=<channel>:<ref>`, creates them at `POST <url>/svc/contacts/contacts/create` (`name` = the snapshot or the reference, `identity` = `<channel>:<ref>`) when there is none, uses the id of the contact an identity conflict (409) names, and stores the id. A failure never affects the webhook's answer and the log never shows the URL, the token or a body.
- S6. Nothing else of the inbox changes (permissions, event, pages, reply flow).

## Tasks

- [x] T1 (S1-S4) migration 0002, store, reads, delivery; the existing tests move to the new columns; a migration test over data written by 0001. inline.
- [x] T2 (S5) settings, job `link_contact`, enqueue after a message; tests with a local fake of the contacts service. inline.
- [x] T3 (S1-S6) README, version 0.2.0, pack, real upgrade 0.1.0 to 0.2.0 over data on an isolated worktree and database.

## Log

- L1: "hazlo ahora, refactoriza el inbox" (after the service API of contacts was published, and the pending list said the refactor unblocks the agent).
- L2: proved end to end on an isolated worktree and database, with the real build, the web server and the worker. Phase 1: inbox 0.1.0 installed, two signed messages received. Phase 2: contacts 0.2.0 installed and inbox upgraded to 0.2.0 (`upgraded inbox 0.2.0`): both conversations kept their reference and name, `contact_id` empty, both messages intact, the `contacts` table gone. Phase 3: with `contacts_url` and `contacts_token` set, one message from a new person (Grace) and one in the conversation that came from 0.1.0 (Ada) each queued a `link_contact` job; the worker ran both on the first attempt, the contacts module got two contacts through its service API (`web:c-2`, `web:c-1`), and each conversation holds the id. The conversation with no new message (`t-9`) stayed unlinked, as designed. Events: four `inbox.message.received`, two `contacts.contact.created`.
- L3: the first run of that script failed on my side (secrets must be given on standard input, not as arguments, which the platform enforces on purpose); fixed in the script, not in the module.
