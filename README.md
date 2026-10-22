# modunexo-modules

Modules for the [Modunexo](https://github.com/epnexo/ModuNexo) platform. The platform ships no business module; each
module here is packed into an archive and installed on a running platform.

| Module | What it does |
| --- | --- |
| `contacts` | People, pipeline stages, leads with their stage history, and the events `contact.created`, `contact.deleted` and `lead.stage_changed`. |
| `inbox` | Receives signed messages from a channel at `/hooks/inbox/messages`, lists conversations, lets an operator reply, and updates live. |

## Install a module

```bash
npm run pack -- inbox                                # writes dist/inbox-<version>.tgz and prints its SHA-256
# on the platform:
npm run modunexo -- modules add inbox-0.1.0.tgz --sha256 <hex>
npm run modunexo -- modules apply <hex>              # place, build, restart without downtime
```

`pack` needs the platform checkout beside this folder (`../CRM Module`, or set `MODUNEXO_PLATFORM`).

## Develop

The platform is linked as a local dependency (`file:../CRM Module/packages/...`), so run `npm install` here after
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
- **Not yet.** Attachments, adapters for WhatsApp, Instagram or Messenger (their `GET` handshake cannot be a public route
  yet), assigning conversations, search, deleting, and sending replies that were queued before an outbound URL was set. The
  AI agent is an external service that talks to this module with a service token, not part of it.

## Guide

`docs/GUIDE.md` says which modules to build for the Vocero areas, in which order, with the rules every module follows and what the platform still lacks.
