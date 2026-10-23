# inbox-service-api

Objective: a service-token API in `inbox` (v0.3.0) so an agent or another service can read conversations and messages and send replies, without importing the module. Branch: feat/inbox-service-api. Delivery: single slice, merge and push only on the user's word. Test runner: `node --import tsx --test`.

## Specs

- S1. "hazlo ahora, haz la ruta de servicio del inbox": routes under `/svc/inbox/`, each guarded by a service-token scope; the pages, the webhook, the reply form and the stored data do not change.
- S2. Scopes `messages.read` and `messages.write`. [assumption: the names the platform README uses for its example]
- S3. `GET /svc/inbox/conversations` answers `{ conversations: [...] }`, most recent activity first, each `{ id, channel, contactRef, contactName, contactId, unread, lastMessageAt, lastText }`; `limit` 1 to 100 (default 50) and `unread=true` to keep only those with unread messages; anything else is 400. Scope `messages.read`.
- S4. `GET /svc/inbox/messages?conversationId=N` answers `{ conversation, messages }` with the messages oldest first, each `{ id, direction, text, status, error, createdAt }`: the newest `limit` (1 to 200, default 100), or with `afterId` the ones after that message id, oldest first, up to `limit`. 404 `not_found` for an unknown conversation, 400 for a value it cannot use. Reading does not mark anything as read. Scope `messages.read`.
- S5. `POST /svc/inbox/messages/send` (`conversationId`, `text`) stores the reply exactly as the reply form does (status `queued`, the `deliver` job queued when an outbound URL is set) and answers 201 `{ id, status }`; 404 `not_found`; 400 for a text that is blank, over 4000 characters or holds a NUL. Scope `messages.write`.
- S6. `POST /svc/inbox/conversations/read` (`conversationId`) clears the unread count: `{ ok: true }`, 404 `not_found`. Scope `messages.write`.
- S7. JSON in and out; a body over 16 KiB is 413, one that is not a JSON object is 400. No delete and no way to create a conversation over the API (they come from the webhook).

## Tasks

- T1 (S2-S7) the four routes, the extra reads, the manifest scopes and version 0.3.0, with tests. inline.
- T2 (S1) README, changelog, pack, real upgrade 0.2.0 to 0.3.0 and a call with tokens on an isolated worktree and database.

## Log

- L1: "hazlo ahora, haz la ruta de servicio del inbox" (after the pending list: the agent needs to read messages and send replies).
