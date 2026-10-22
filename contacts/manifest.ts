import { SDK_VERSION, defineModule } from "@modunexo/sdk";

export default defineModule({
  id: "contacts",
  version: "0.1.0", // raise it whenever a migration is added: an upgrade to the same version does nothing
  name: "Contacts",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "contacts", // the Postgres schema this module owns
  migrationsDir: "migrations",
  permissions: [
    { key: "contacts.read", label: "Read contacts and the pipeline" },
    { key: "contacts.write", label: "Create and change contacts, leads and stages" },
  ],
  nav: [],
  events: [
    { name: "contact.created", permission: "contacts.read" },
    { name: "contact.deleted", permission: "contacts.read" },
    { name: "lead.stage_changed", permission: "contacts.read" },
  ],
});
