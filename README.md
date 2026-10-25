<div align="center">

# ModuNexo modules

**Ready-made business modules for the [ModuNexo](https://github.com/epnexo/ModuNexo) platform.**
Inbox, contacts, scheduling and an AI assistant, each packed as an archive you install with one command.

![License](https://img.shields.io/badge/license-MIT-0D9488)
![Platform](https://img.shields.io/badge/platform-ModuNexo-162c4c)
![SDK](https://img.shields.io/badge/SDK-%E2%89%A50.1.1-162c4c)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)

[Modules](#modules) · [How they fit together](#how-they-fit-together) · [Install](#install-a-module) · [Develop](#develop) · [Dashboard](#dashboard-cards) · [License](#license)

</div>

---

The platform ships no business module. Each module here is a self-contained package with its own manifest, database
schema, migrations, permissions and pages, and it talks to the others only through events and service APIs, never by
importing their code.

## Modules

| Module | Version | What it does | Reference |
| --- | --- | --- | --- |
| **inbox** | 0.3.1 | Receives signed messages from a channel, lists conversations, lets an operator reply, and updates live. Offers a service API for agents. | [docs](docs/modules/inbox.md) |
| **contacts** | 0.2.1 | People, pipeline stages and leads with their stage history. Emits `contact.created`, `contact.deleted` and `lead.stage_changed`. | [docs](docs/modules/contacts.md) |
| **agenda** | 0.1.1 | Weekly hours and bookings that cannot clash, a week page, the `booking.updated` event and a service API for availability and booking. | [docs](docs/modules/agenda.md) |
| **assistant** | 0.1.1 | Answers customers' messages through the inbox with a language model. Off until you switch it on. | [docs](docs/modules/assistant.md) |

Versions come from each module's `manifest.ts`. Earlier packed versions and a changelog per module are kept in
[`versions/`](versions/README.md).

## How they fit together

```mermaid
flowchart LR
    Channel([Customer channel]) -- signed webhook --> Inbox
    Inbox -- inbox.message.received --> Assistant
    Assistant -- service API: send reply --> Inbox
    Inbox -- service API: link person --> Contacts
    Contacts -. contact and lead events .-> Others([Other modules])
    Agenda -. booking.updated .-> Others
```

- The **assistant** reads nothing directly: it reacts to an inbox event and answers through the inbox's service API,
  so its replies are stored and delivered exactly like a reply written by hand.
- The **inbox** can link each conversation to a person in **contacts**. This is optional and runs through a service token.
- **agenda** does not know about contacts: a booking holds a plain contact id.

## Install a module

```bash
npm run pack -- inbox                                   # writes dist/inbox-<version>.tgz and prints its SHA-256

# on the platform:
npm run modunexo -- modules add inbox-<version>.tgz --sha256 <hex>   # stage and review
npm run modunexo -- modules apply <hex>                              # place, build, restart without downtime
```

`pack` needs the platform checkout beside this folder (`../ModuNexo`, or set `MODUNEXO_PLATFORM`).
Installing a module is a trust decision: it runs with full access to the platform and its database.

## Develop

The platform is linked as a local dependency (`file:../ModuNexo/packages/...`), so clone `ModuNexo` and
`ModuNexo-modules` side by side and run `npm install` here.

```bash
export TEST_DATABASE_URL=postgres://epnexo:epnexo@127.0.0.1:5436/epnexo_test
npm test               # each module's tests, in tests/<module>/
npm run typecheck
```

| Path | What it is |
| --- | --- |
| `inbox/`, `contacts/`, `agenda/`, `assistant/` | One folder per module: manifest, migrations and sources |
| `tests/<module>/` | Tests live outside the module, so the archive carries none |
| `versions/` | Earlier packed versions with their hashes, plus a changelog per module |
| `docs/modules/` | Per-module reference: contract, permissions, settings, service API |
| `docs/GUIDE.md` | Which modules to build, in which order, and the rules every module follows |
| `scripts/` | `pack.sh` builds the archive; `archive-old.sh` moves superseded versions into `versions/` |

Each module has its own version, written in `manifest.ts` and `package.json`, which must agree. `dist/` holds only
the current packed version of each module.

## Dashboard cards

The platform's dashboard (`/`) shows what the modules report. Every module here declares a `dashboard` in its manifest:
a few figures and the alerts that need someone's attention, each a read-only `select` on the module's own tables and
each behind the module's read permission, so a person only sees what they may open. A test (`tests/dashboard/`) fails
if a module declares none, if a statement does not run against the real tables, or if a card is not behind a permission.
It needs a platform with SDK 0.1.1 or later; an older one refuses the archive with `unknown field "dashboard"`.

| Module | Figures | Alerts |
| --- | --- | --- |
| `contacts` | contacts, open leads, value of open leads | open leads not moved for 7 days |
| `agenda` | bookings today, bookings to come | no opening hours set |
| `inbox` | conversations, unread, messages in 24 hours | unread waiting over an hour, replies that failed this week |
| `assistant` | replies in 24 hours, conversations stopped | replies that failed, switched off |

## License

MIT, see [`LICENSE`](LICENSE). The platform itself is licensed separately (AGPL-3.0, with a module exception) in its
[own repository](https://github.com/epnexo/ModuNexo).
