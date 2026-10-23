# Guide: building the Vocero modules for Modunexo

The platform (`ModuNexo`) stays empty: it ships no business module. Every area of the Vocero CRM becomes a module in
this repository, packed as an archive and installed on a running platform with `modules add`. This guide says what to
build, in which order, how, and what the platform still lacks.

Source of the map: a read of `kevinrivm/vocero-crm` (specs and `src/`). Nothing there is labeled "module"; the split
below is a reading of the code, so treat it as a proposal to adjust.

## 1. Rules that shape every module

- **A module is a folder** (`<id>/`) with `manifest.ts`, `migrations/`, `lib/`, `web/`, `jobs/`. Its tests live outside
  it, in `tests/<id>/`, so the archive carries none.
- **A module owns its schema.** Tables are unqualified in migrations; the module's schema is the `search_path`.
  Migrations are append-only.
- **Modules never import each other.** They talk through events (`publishEvent` and subscriptions) or through HTTP
  with a service token (`/svc/<module-id>/...`).
- **No foreign key across modules.** A module stores the other module's id as a plain value and resolves it through an
  event or an HTTP read. Deleting the referenced row is announced by an event (`contact.deleted`), not enforced by the
  database.
- **Nothing is installed in the platform repository.** Create modules here (or with `modules new <id> --dir <parent>`
  anywhere), never in the platform's `modules-src/`.
- **Public webhooks live under `/hooks/<module-id>/`** and are verified by the shell (HMAC, size, rate) before the
  module's handler runs. Deduplication is the module's job.
- **Secrets are module settings** (`type: "secret"`), encrypted with the platform key, never environment variables of
  the module.

## 2. The loop for each module

1. Write the feature document in the platform repo style (`S#` specs quoting the request, `T#` tasks, `L#` log), or
   keep it in this repo under `docs/features/<id>.md`.
2. `modules new <id> --dir <this repo>`; edit the manifest (permissions, settings, pages, jobs, events).
3. Tests first (RED), in `tests/<id>/`, against a scratch database (`TEST_DATABASE_URL`, name ending in `_test`).
4. `npm test` and `npm run typecheck` here. Then `npm run pack -- <id>` (writes `dist/<id>-<version>.tgz` and prints its
   SHA-256), and read the review with `modules add <archive> --data-dir <tmp>` from the platform checkout (public routes,
   jobs, permissions are listed before anything runs).
5. Install for real: `modules add ... --sha256 <hex>` then `modules apply <hex>`. The build goes beside the serving
   one and the restart is the switch, so the site does not go down. Check `/status` for jobs and events.
6. Bump the module version for every change that ships; keep `platform: ^<SDK_VERSION>` in the manifest.

## 3. The modules, in build order

Sizes: S small, M medium, L large. "Needs" are platform capabilities; **gap** marks something the platform does not
offer yet (section 4).

| # | Module | What it does | Needs | Depends on (by events/HTTP) | Size |
| --- | --- | --- | --- | --- | --- |
| 1 | `contacts` (built, v0.2.0, with its service API) | People, pipeline stages, deals, stage history, CSV import. Emits `contact.created`, `lead.stage_changed`. | pages, events | nothing | M |
| 2 | `inbox` (built, v0.2.0, keeps only a contact reference) | Conversations and messages, reply window, live updates. Becomes the hub every channel feeds. | public route, jobs, events, files | contacts | L |
| 3 | `whatsapp` | Meta Cloud API: receive, send, templates, media. | public route with **GET handshake (gap)**, jobs (template sync), files, secrets | inbox | L |
| 4 | `agent-bridge` | Sends each turn to an external brain over HTTP, serves the brain's callbacks (messages, context, stage, handoff, bookings) and an LLM proxy. | jobs (outbox with retries), events, service tokens, llm | inbox, contacts, agenda | L |
| 5 | `agenda` (built, v0.1.0, without Zoom and Google) | Availability, slots, bookings, rescheduling, Zoom and Google connectors. | pages, events, jobs, service tokens, secrets | contacts | L |
| 6 | `social-channels` | Instagram, Messenger, TikTok through Zernio (one module sharing the client, or three). | public routes with **GET handshake (gap)**, secrets | inbox | M |
| 7 | `attribution` | Which ad a lead came from; sends conversions to Meta CAPI when a stage changes. | events, jobs (retries), secrets | inbox, contacts | M |
| 8 | `results` | Read-only dashboards: funnel, ads, bot, hygiene. | pages; reads other modules by **events or HTTP (gap)** | contacts, agenda, attribution, inbox | M |
| 9 | `lab` | Runs scripted persona conversations against the brain and scores them with a judge model. | jobs (long run), events, llm | agent-bridge | M |

Onboarding, doctor, mock servers and seed data are tooling, not modules.

Why this order: `contacts` is referenced by everything and depends on nothing; `inbox` is the hub; `whatsapp` proves the
whole webhook, media and template path; the bridge is where the product value is; `agenda` is self-contained and can
move earlier; `social-channels` repeat the WhatsApp pattern; `attribution` needs the referral data and stage events;
`results` and `lab` are layers on top.

### Couplings to design before coding

- **Contacts and conversations are shared by almost everything.** Today our `inbox` has its own `contacts` table. When
  `contacts` becomes a module, the inbox keeps only a `contact_ref` (the id) plus a display-name snapshot, and reads the
  rest through an event or a service-token call. This is decided (decision A): `contacts` is its own module.
- **Stage change is the busiest hook.** Define one event, `contacts.lead.stage_changed`, with a stable payload; the bridge,
  the agenda and attribution subscribe to it instead of calling each other.
- **Ingest is called from every channel.** In Vocero all channels call one `ingestInboundMessage`. Here each channel
  module posts to the inbox's signed webhook (or a service-token route), so the inbox contract
  (`channel`, `threadRef`, `messageId`, `text`, `contact`) is the single entry. Extend it before adding channels:
  media references, the ad referral, and the sender's identity type.
- **Analytics reads five areas.** Give `results` its own projection fed by events, not direct reads of other schemas.
- **Tenancy.** Vocero scopes every table by organization. The platform is single-tenant per installation; drop the
  organization column rather than carrying it.

## 4. What the platform still lacks (blocks or slows modules)

Ordered by what blocks first. Each is a small feature in the platform repo, done before the module that needs it.

1. **A public route that answers GET** (Meta's webhook verification handshake). Blocks `whatsapp` and `social-channels`.
2. **A way for a page to know who is viewing** (their permissions). Today the reply form is shown to everyone and the
   gate refuses the send.
3. **A same-origin helper in the SDK.** The inbox copies the rule; every form-posting module will.
4. **Cross-module reads without a database foreign key.** The pattern now exists (`contacts` has a service API, section 3), but
   there is no SDK helper yet to call another module's `/svc` route, nor a way for a module to hold a token for another.
5. **Roles as data.** Only `admin` and `operator` exist.
6. **Storage adapter for S3** (the files capability has the local adapter).
7. **OpenAPI contract** for `/hooks`, `/svc` and `/api/events`, so a brain or a channel can be built against it.
8. **Replies queued before an outbound URL is set are not sent when it is set.** Small; inbox-side.

## 5. Definition of done for a module

- Specs quote the request; every rule has a test that failed first; the module's tests pass here.
- The archive packs, and `modules add` lists its public routes, jobs, events, permissions and settings as intended.
- Installed on a real instance: the pages answer, a signed request to its webhook is accepted, a bad signature gets 401,
  a failing build leaves the serving build untouched.
- A reader can learn from the module's README section: its contract, permissions, settings and what it does not do yet.
- Nothing was added to the platform repository except a gap listed in section 4.

## 6. Open decisions

- **A. Decided: `contacts` is its own module.** The existing inbox is refactored to keep only a contact reference
  (the id) plus a display-name snapshot, and reads the rest through an event or a service-token call.
- **B.** `social-channels`: one module (shared Zernio client) or three.
- **C.** Where the external brain lives: Vocero already treats it as an external service (ADR-001 question 3); keep that.
- **D.** Publishing: this repository on GitHub, and whether archives are attached to releases.
