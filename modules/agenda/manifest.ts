import { SDK_VERSION, defineModule } from "@modunexo/sdk";

export default defineModule({
  id: "agenda",
  version: "0.1.1", // raise it whenever a migration is added: an upgrade to the same version does nothing
  name: "Agenda",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "agenda", // the Postgres schema this module owns
  migrationsDir: "migrations",
  permissions: [
    { key: "agenda.read", label: "Read the agenda" },
    { key: "agenda.write", label: "Book, cancel and reschedule, and change the hours" },
  ],
  scopes: [
    { key: "availability.read", label: "Read the free slots" },
    { key: "bookings.write", label: "Book, cancel and reschedule" },
  ],
  nav: [{ label: "Agenda", href: "/agenda", icon: "calendar", permission: "agenda.read" }],
  dashboard: {
    stats: [
      { key: "today", label: "Bookings today", href: "/agenda", permission: "agenda.read", sql: "select count(*) from bookings b cross join settings s where b.status = 'booked' and (b.starts_at at time zone s.timezone)::date = (now() at time zone s.timezone)::date" },
      { key: "upcoming", label: "Bookings to come", href: "/agenda", permission: "agenda.read", sql: "select count(*) from bookings where status = 'booked' and starts_at >= now()" },
    ],
    alerts: [
      { key: "no_hours", label: "No opening hours are set, so nobody can book", href: "/agenda/settings", severity: "warning", permission: "agenda.read", sql: "select case when exists (select 1 from weekly_hours) then 0 else 1 end" },
    ],
  },
  events: [{ name: "booking.updated", permission: "agenda.read" }],
  pages: [
    { path: "/agenda", entry: "./web/agenda-page.tsx", kind: "page", dynamic: "force-dynamic", permission: "agenda.read" },
    { path: "/agenda/settings", entry: "./web/settings-page.tsx", kind: "page", dynamic: "force-dynamic", permission: "agenda.read" },
    { path: "/agenda/book", entry: "./web/book.ts", kind: "route", methods: ["POST"], permission: "agenda.write" },
    { path: "/agenda/cancel", entry: "./web/cancel.ts", kind: "route", methods: ["POST"], permission: "agenda.write" },
    { path: "/agenda/reschedule", entry: "./web/reschedule.ts", kind: "route", methods: ["POST"], permission: "agenda.write" },
    { path: "/agenda/settings/save", entry: "./web/settings-save.ts", kind: "route", methods: ["POST"], permission: "agenda.write" },
    { path: "/svc/agenda/availability", entry: "./web/svc-availability.ts", kind: "route", methods: ["GET"], scope: "availability.read" },
    { path: "/svc/agenda/bookings", entry: "./web/svc-book.ts", kind: "route", methods: ["POST"], scope: "bookings.write" },
    { path: "/svc/agenda/bookings/cancel", entry: "./web/svc-cancel.ts", kind: "route", methods: ["POST"], scope: "bookings.write" },
    { path: "/svc/agenda/bookings/reschedule", entry: "./web/svc-reschedule.ts", kind: "route", methods: ["POST"], scope: "bookings.write" },
  ],
});
