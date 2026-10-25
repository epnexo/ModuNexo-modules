# inbox

> Module reference. For the full catalog and installation, see the [README](../../README.md).

`inbox/` is the first module that does business work, and it uses most of the platform's capabilities: a public route,
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
