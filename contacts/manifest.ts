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
  nav: [
    { label: "Contacts", href: "/contacts", icon: "users", permission: "contacts.read" },
    { label: "Pipeline", href: "/pipeline", icon: "dashboard", permission: "contacts.read" },
  ],
  events: [
    { name: "contact.created", permission: "contacts.read" },
    { name: "contact.deleted", permission: "contacts.read" },
    { name: "lead.stage_changed", permission: "contacts.read" },
  ],
  pages: [
    { path: "/contacts", entry: "./web/contacts-page.tsx", kind: "page", dynamic: "force-dynamic", permission: "contacts.read" },
    { path: "/pipeline", entry: "./web/pipeline-page.tsx", kind: "page", dynamic: "force-dynamic", permission: "contacts.read" },
    { path: "/contacts/save", entry: "./web/contact-save.ts", kind: "route", methods: ["POST"], permission: "contacts.write" },
    { path: "/contacts/delete", entry: "./web/contact-delete.ts", kind: "route", methods: ["POST"], permission: "contacts.write" },
    { path: "/pipeline/lead", entry: "./web/lead-create.ts", kind: "route", methods: ["POST"], permission: "contacts.write" },
    { path: "/pipeline/move", entry: "./web/lead-move.ts", kind: "route", methods: ["POST"], permission: "contacts.write" },
    { path: "/pipeline/stage", entry: "./web/stage-save.ts", kind: "route", methods: ["POST"], permission: "contacts.write" },
  ],
});
