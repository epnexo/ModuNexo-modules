import { SDK_VERSION, defineModule } from "@modunexo/sdk";

export default defineModule({
  id: "agenda",
  version: "0.1.0", // raise it whenever a migration is added: an upgrade to the same version does nothing
  name: "Agenda",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "agenda", // the Postgres schema this module owns
  migrationsDir: "migrations",
  permissions: [
    { key: "agenda.read", label: "Read the agenda" },
    { key: "agenda.write", label: "Book, cancel and reschedule, and change the hours" },
  ],
  nav: [],
  events: [{ name: "booking.updated", permission: "agenda.read" }],
});
