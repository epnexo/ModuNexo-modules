# agenda

## 0.1.1 - 2026-10-23

- Reports to the dashboard: the bookings of today (in the agenda's timezone) and those to come, and an alert while no opening hours are set. Needs a platform with SDK 0.1.1 or later (the optional `dashboard` field of the manifest).
- No migration; nothing else changed.

## 0.1.0 - 2026-10-23

- Weekly opening hours in an IANA time zone (daylight saving followed), appointment length, gap between appointments and days
  offered ahead.
- Bookings that cannot clash, even when requests arrive together: book, cancel and reschedule.
- Pages `/agenda` (a week at a time) and `/agenda/settings`; event `booking.updated`.
- Service API under `/svc/agenda/` with the scopes `availability.read` and `bookings.write`.
- Zoom and Google Calendar are not included.
