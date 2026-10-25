# agenda

> Module reference. For the full catalog and installation, see the [README](../../README.md).

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
