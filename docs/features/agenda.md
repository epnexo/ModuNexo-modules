# agenda

Objective: a module `agenda` (weekly availability, bookings that cannot clash, a week page, one event, a service-token API) built here and installed as an archive, never inside the platform. Branch: feat/agenda-module. Delivery: single slice, merge and push only on the user's word. Test runner: `node --import tsx --test`.

## Specs

- S1. Scope the user approved: "Disponibilidad: horario semanal, zona horaria, duración de cada cita y margen entre citas. Citas: crear, cancelar y reprogramar, con control de choques de horario. Cada cita referencia a un contacto solo por su id. Página de calendario: vista de la semana, con el formulario para agendar. Evento: `booking.updated`. Ruta con token de servicio: disponibilidad y crear cita." Out of scope: "Zoom y Google Calendar". "sí, esa v1 está bien, empieza".
- S2. Settings (one row): IANA `timezone` (default `UTC`), `slot_minutes` (5 to 480, default 30), `buffer_minutes` (0 to 240, default 0), `horizon_days` (1 to 90, default 14). Weekly hours: per weekday (0 = Sunday to 6 = Saturday) any number of windows `start`-`end` in minutes of the day (end after start, no overlap inside a day); starts as Monday to Friday 09:00-17:00.
- S3. Free slots: inside each window, slots start at the window's start and follow every `slot_minutes`; a slot must end inside the window; times are local to `timezone` (daylight saving included: a local time that does not exist is skipped, one that happens twice is taken once); a slot in the past, beyond the horizon, or closer than `buffer_minutes` to a booked one (before or after) is not free.
- S4. Bookings: attendee name (required, up to 200 characters), optional `contactId` (a plain number, no reference to another module), optional notes (up to 2000). A booking is for a free slot only, lasts `slot_minutes`, and is `booked` or `cancelled`. Two bookings never overlap nor sit closer than the buffer, even when requests arrive together. Cancelling frees the slot. Rescheduling moves a booked booking to another free slot (its own current slot counts as free for it).
- S5. Event `booking.updated` `{ bookingId, contactId, change, status, startsAt, endsAt }` with `change` one of `created`, `rescheduled`, `cancelled`, published in the same transaction as the write. A refused request announces nothing; cancelling a cancelled booking changes nothing and announces nothing.
- S6. Pages: `/agenda` (the week from a chosen day: bookings per day, free slots with a form to book, cancel and reschedule forms) and `/agenda/settings` (timezone, slot, buffer, horizon, hours per weekday). Forms post to routes that check the origin is this site and answer 303 back. Permissions `agenda.read` and `agenda.write`.
- S7. Service API under `/svc/agenda/` with scopes `availability.read` and `bookings.write`: `GET availability`, `POST bookings`, `POST bookings/cancel`, `POST bookings/reschedule`, JSON in and out; a taken or invalid slot answers 409 `not_available`.
- S8. No foreign key to, nor import of, any other module.

## Tasks

- [x] T1 (S3) time: local to UTC with daylight saving, the weekday and date of an instant in a zone. inline. 9 tests.
- [x] T2 (S2) settings and weekly hours store with validation. inline. 7 tests.
- [x] T3 (S3) free slots. inline. 13 tests (buffer, horizon, zones, both clock changes).
- [x] T4 (S4, S5) bookings: book, reschedule, cancel, clash control, events. inline. 16 tests, includes simultaneous requests.
- [x] T5 (S6, S7) form routes and service routes. inline. 21 tests.
- [x] T6 (S6) the two pages and the manifest. inline. 9 tests plus 7 for the week arithmetic; `tsc --noEmit` clean.
- [x] T7 (S1-S8) README, pack, real install in an isolated worktree and database, smoke over HTTP. No independent verifier: a new module with its own schema, no change to stored data; the clash control is proved by simultaneous-request tests and the access by the platform gate and token scopes.

## Log

- L1: "sí, esa v1 está bien, empieza" (after the proposal: availability, bookings, week page, `booking.updated`, service-token route for availability and booking; Zoom and Google out).
- L2: real install proved on an isolated worktree and database (`modules add` + `modules apply` built and migrated). Over HTTP, with a service token: availability 200, booking 201, the same slot again 409 `not_available`, a read-only token booking 403, no token 401; a same-origin form booking 303 and a foreign origin 403; two `agenda.booking.updated` events with change `created`. The scratch shell redirected pages to `/setup` because that database has no site identity yet; the response body held the page with the booking.
