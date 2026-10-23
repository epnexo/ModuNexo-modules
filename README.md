# modunexo-modules

Modules for the [Modunexo](https://github.com/epnexo/ModuNexo) platform. The platform ships no business module; each
module here is packed into an archive and installed on a running platform.

| Module | What it does |
| --- | --- |
| `assistant` | Answers customers' messages by itself with a language model, through the inbox. Off until you switch it on. |
| `agenda` | Weekly hours, bookings that cannot clash, a week page, the event `booking.updated` and a service API for availability and booking. |
| `contacts` | People, pipeline stages, leads with their stage history, and the events `contact.created`, `contact.deleted` and `lead.stage_changed`. |
| `inbox` | Receives signed messages from a channel at `/hooks/inbox/messages`, lists conversations, lets an operator reply, and updates live. |

## Install a module

```bash
npm run pack -- inbox                                # writes dist/inbox-<version>.tgz and prints its SHA-256
# on the platform:
npm run modunexo -- modules add inbox-0.1.0.tgz --sha256 <hex>
npm run modunexo -- modules apply <hex>              # place, build, restart without downtime
```

`pack` needs the platform checkout beside this folder (`../ModuNexo`, or set `MODUNEXO_PLATFORM`).

## Versions

Each module has its own version (in `manifest.ts` and `package.json`, which must agree). `dist/` holds only the current packed
version of each module; the earlier ones are kept in `versions/<module>/<version>/`, with their hashes and a changelog per module.
See `versions/README.md`.

## Develop

The platform is linked as a local dependency (`file:../ModuNexo/packages/...`), so clone `ModuNexo` and `ModuNexo-modules` side by side and run `npm install` here after
cloning both repositories side by side.

```bash
export TEST_DATABASE_URL=postgres://epnexo:epnexo@127.0.0.1:5436/epnexo_test
npm test                                             # each module's tests, in tests/<module>/
```

A module is a folder (`inbox/`) with its manifest, migrations and sources; its tests live outside it, in
`tests/<module>/`, so the archive carries no tests.

## inbox

`inbox/` is the first module that does business work, and it uses most of the capabilities above: a public route,
a job, an event, secret settings and a live page. Pack and install it like any other (`modules pack`, `modules add`,
`modules apply`), then set its three settings on `/settings`.

- **Receive.** A channel posts JSON to `POST /hooks/inbox/messages`, signed with HMAC-SHA256 of the body in the header
  `x-signature: sha256=<hex>`, keyed by the secret setting `webhook_secret`. The body is `channel` (lowercase, up to 32
  characters), `threadRef`, `messageId`, `text` (1 to 4000 characters) and optionally `contact: { ref, name }`. The answer is
  `{ "ok": true, "duplicate": false }`; a message already delivered (same `channel` and `messageId`) answers `duplicate: true`
  and changes nothing. A body that cannot be used answers 400 with the reason.
- **Show.** `/inbox` lists the newest 50 conversations and shows the selected one with its newest 200 messages. Opening a
  conversation marks it read. A new message refreshes the page by itself through `inbox.message.received`.
- **Reply.** The form posts to `/inbox/reply` (permission `inbox.write`, same site only). The reply is stored as `queued`
  and the job `deliver` posts it, signed with `outbound_secret` in the same way, to the setting `outbound_url`; it becomes
  `sent`, or `failed` with the reason after 5 attempts. The reason is the HTTP status or a fixed phrase, never the URL or
  the provider's answer. Without an outbound URL a reply stays `queued` and the page says so. The URL must be `http` or `https`
  (any other scheme fails the reply at once), and it is whatever an administrator sets, so point it only at a service you trust.
  Delivery is at-least-once: if the worker stops after the provider accepted a reply and before it was marked `sent`, the reply is
  sent again, so the receiving side should ignore a `messageId` it has already seen.
- **Permissions.** `inbox.read` opens the page and receives the event; `inbox.write` can reply. A page cannot ask the SDK
  who is looking, so the reply form is shown to everyone who can read and the gate refuses the send to the rest.
- **The person** (0.2.0). The inbox does not keep contacts. Each conversation holds `contact_ref` (what the channel calls the
  person; the `threadRef` when the message names nobody), `contact_name` (a snapshot: the first message that carries a name
  sets it, a later one never replaces it, and a new thread of a person known by name in that channel starts with it) and
  `contact_id`, the id of the contact in the `contacts` module, empty until linked. The webhook's body and answers did not change.
- **Linking to contacts** (optional). Set the settings `contacts_url` (the platform's own address, for example
  `http://127.0.0.1:3000`) and `contacts_token` (a service token of `contacts` with `contacts.read` and `contacts.write`:
  `tokens create contacts --name inbox --scope contacts.read --scope contacts.write`). While either is empty nothing is asked.
  Once both are set, the first message of a conversation that has no `contact_id` queues a job `link_contact` (5 attempts, one
  waiting per conversation) that looks the person up by identity `<channel>:<reference>`, creates them when nobody holds it,
  and keeps the id. A failure never changes the webhook's answer, and the retry shows the HTTP status or a fixed phrase, never
  the address, the token or what the service said. The address is whatever an administrator sets, so point it only at your own platform.
- **Upgrading from 0.1.0.** Migration `0002` copies each contact's reference and name onto its conversations, sets `contact_id`
  to empty and drops the `contacts` table of the inbox; messages, threads, unread counts and dedupe keys are untouched.
- **Service API** (0.3.0), for an agent or another service. Create a token with the scopes you need, then call it:

```bash
npm run modunexo -- tokens create inbox --name agent --scope messages.read --scope messages.write
curl -H "Authorization: Bearer mdnx_..." "https://host/svc/inbox/conversations?unread=true"
curl -H "Authorization: Bearer mdnx_..." -X POST https://host/svc/inbox/messages/send -d '{"conversationId":12,"text":"Hello!"}'
```

  | Route | Scope | Does |
  | --- | --- | --- |
  | `GET /svc/inbox/conversations?limit=&unread=` | `messages.read` | `{ conversations }`, most recent activity first; each has `id`, `channel`, `contactRef`, `contactName`, `contactId`, `unread`, `lastMessageAt`, `lastText`; `limit` 1 to 100 (default 50), `unread=true` keeps those with unread messages |
  | `GET /svc/inbox/messages?conversationId=&limit=&afterId=` | `messages.read` | `{ conversation, messages }`, oldest first: the newest `limit` (1 to 200, default 100) or, with `afterId`, those after that message id. Does not mark anything as read; 404 `not_found` |
  | `POST /svc/inbox/messages/send` | `messages.write` | `{ conversationId, text }`: stored as the reply form does, 201 `{ id, status }`; 400 for a text that is blank, over 4000 characters or holds a NUL |
  | `POST /svc/inbox/conversations/read` | `messages.write` | `{ conversationId }`: clears its unread count, `{ ok: true }` |

  JSON in and out; a body over 16 KiB is 413. A conversation cannot be created or deleted over the API: conversations come from the
  webhook. To follow a conversation without missing messages, keep the highest message `id` you have seen and ask with `afterId`.
- **Not yet.** Attachments, adapters for WhatsApp, Instagram or Messenger (their `GET` handshake cannot be a public route
  yet), assigning conversations, search, deleting, and sending replies that were queued before an outbound URL was set. The
  AI agent is an external service that talks to this module with a service token, not part of it.

## assistant

Answers the messages your customers send to the inbox by itself, with a language model. **It is off until you switch it on**, because
while it is on each customer's messages are read by the model provider you configure.

**Set it up** (needs the `inbox` module, 0.3.0 or later, and the worker running, because the answers are produced by a job):

1. In the platform's Settings screen, section Assistant: `llm.url` (the model endpoint, OpenAI-compatible: `https://api.openai.com/v1`,
   or `http://127.0.0.1:11434/v1` for a local server such as Ollama), `llm.key` (empty for a local server), `llm.model`, `inbox_url`
   (this platform's own address, for example `http://127.0.0.1:3000`) and `inbox_token`. The token is a service token of the inbox:
   `npm run modunexo -- tokens create inbox --name assistant --scope messages.write` (it is shown once).
2. On `/assistant/settings`, write the **instructions** (who the business is, what it sells, hours, prices, tone, what the assistant
   must not do: the model only knows what is written there) and tick *Answer customers by itself*.
3. `/assistant` shows the state, a line per recent conversation with Pause and Resume, and the latest replies with their text.

**How it decides**
- A customer message makes the inbox announce `inbox.message.received`; the assistant's job waits a few seconds (default 5) so a burst
  of lines is answered once, answers only the newest customer message, and never one older than 15 minutes.
- It asks the model with your instructions, fixed rules (reply in the customer's language, keep it short, never invent prices,
  availability or promises, answer with `[[HANDOFF]]` to pass the customer to a person) and the last messages of the conversation
  (default 20). Only message texts are sent; no names or contact details.
- It sends the answer through the inbox's service API, so it is stored and delivered exactly like a reply written by hand.
- **One reply per customer message**, even if the job runs twice or two jobs run together; and if a send fails halfway, a retry does
  not send a second reply.
- **It stops by itself** in a conversation, and shows why on `/assistant`, when a person has written in it (`human`), when the model
  asked for a person (`handoff`; any text around the marker is still sent), or at the hourly limit (`limit`, default 10 replies per
  conversation). It stays stopped until someone presses Resume. You can also stop one by hand.
- **If the customer writes again while it works**, it throws away the answer it was preparing (it was about an older message) and
  answers the newest one with everything in view, up to three rounds. Just before sending it checks again that the assistant is still
  on, that the conversation is not stopped and that no person has written meanwhile; if any changed, nothing is sent.
- **Resume starts the conversation again from its newest message**: a person who wrote earlier, or the replies of the last hour, no
  longer stop it at once. If a person writes after that, it stops again.
- If the connection to the inbox drops while a reply is being sent, the assistant cannot know whether it went out, so it stops in
  that conversation (shown as *a person wrote*) rather than risk answering twice. Press Resume if it did not go out.
- A failing model or inbox makes the job retry (3 attempts); the error shows the status or a fixed phrase, never the address,
  the key, the token or what the provider said.

**Not yet**: it cannot look up contacts or book appointments on its own (the contacts and agenda APIs exist, but the model has no tools
yet), it reads text only (no images or voice), one set of instructions for every channel, and it cannot be switched on for just
some conversations.

## Guide

`docs/GUIDE.md` says which modules to build for the Vocero areas, in which order, with the rules every module follows and what the platform still lacks.

## contacts

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

## agenda

Weekly availability and bookings. No settings in the platform's Settings screen: the module has its own page,
`/agenda/settings`. Permissions: `agenda.read` opens the pages, `agenda.write` can book, cancel, reschedule and change the
hours (a page cannot ask who is looking, so the forms are shown to every reader and the gate refuses the send).

- **Hours** (`/agenda/settings`): a time zone (an IANA name), the length of an appointment (5 to 480 minutes), a gap
  between appointments (0 to 240), how many days ahead to offer (1 to 90) and one window per weekday. It starts in UTC,
  30 minutes, no gap, 14 days, Monday to Friday 09:00 to 17:00. Change the zone first: the hours are read in it, and
  daylight saving is followed (a local time that does not exist is skipped, one that happens twice is offered once).
- **Free slots**: each window is cut into slots from its start; a slot must end inside the window, start in the future,
  fall within the horizon and keep the gap from every booking, before and after.
- **Bookings** (`/agenda`, a week at a time): book a free slot for a name, with an optional contact id (a plain number; the
  agenda does not know the contacts module) and notes; cancel; move to another free slot. Two bookings never overlap nor sit
  closer than the gap, even when requests arrive together (the writes are serialised with a database lock).
- **Event**: `agenda.booking.updated` `{ bookingId, contactId, change, status, startsAt, endsAt }` with `change` one of
  `created`, `rescheduled`, `cancelled`, published in the same transaction as the write. A refused request, cancelling a
  cancelled booking and asking for the slot a booking already has announce nothing.
- **Service API**, for an agent or another service: create a token with the scopes you want, then call it.

```bash
npm run modunexo -- tokens create agenda --name agent --scope availability.read --scope bookings.write
curl -H "Authorization: Bearer mdnx_..." "https://host/svc/agenda/availability?days=7"
curl -H "Authorization: Bearer mdnx_..." -X POST https://host/svc/agenda/bookings \
  -d '{"startsAt":"2026-10-26T09:00:00Z","attendeeName":"Ada","contactId":12,"notes":"first visit"}'
```

  `GET /svc/agenda/availability[?days=1..90]` (scope `availability.read`) answers `{ timezone, slotMinutes, slots: [{ startsAt, endsAt }] }`,
  at most 500 slots. `POST /svc/agenda/bookings` creates (201 with `{ id, startsAt, endsAt }`), `POST /svc/agenda/bookings/cancel`
  takes `{ id }` and `POST /svc/agenda/bookings/reschedule` takes `{ id, startsAt }` (scope `bookings.write`). Times are ISO 8601
  with their zone. A time that is not a free slot answers 409 `not_available`; a bad body 400; a body over 16 KiB 413.
- **Not yet**: Zoom and Google Calendar links, reminders, choosing a contact by name (it needs the contacts module's
  service API), several windows per day from the screen, and moving existing bookings when the hours change.

## License

MIT, see `LICENSE`. The platform itself is licensed separately (AGPL-3.0, with a module exception) in its own repository.
