import { SDK_VERSION, defineModule } from "@modunexo/sdk";

export default defineModule({
  id: "contacts",
  version: "0.2.1", // raise it whenever a migration is added: an upgrade to the same version does nothing
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
  dashboard: {
    stats: [
      { key: "people", label: "Contacts", href: "/contacts", permission: "contacts.read", sql: "select count(*) from contacts" },
      { key: "open_leads", label: "Open leads", href: "/pipeline", permission: "contacts.read", sql: "select count(*) from leads l join pipeline_stages s on s.id = l.stage_id where s.kind = 'open'" },
      { key: "open_value", label: "Value of open leads", href: "/pipeline", permission: "contacts.read", sql: "select coalesce(round(sum(l.amount)), 0)::bigint from leads l join pipeline_stages s on s.id = l.stage_id where s.kind = 'open'" },
    ],
    alerts: [
      { key: "stale_leads", label: "Open leads not moved for 7 days", href: "/pipeline", severity: "warning", permission: "contacts.read", sql: "select count(*) from leads l join pipeline_stages s on s.id = l.stage_id where s.kind = 'open' and l.updated_at < now() - interval '7 days'" },
    ],
  },
  scopes: [
    { key: "contacts.read", label: "Read contacts" },
    { key: "contacts.write", label: "Create and change contacts" },
    { key: "leads.read", label: "Read the stages and the leads" },
    { key: "leads.write", label: "Create leads and move them between stages" },
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
    { path: "/svc/contacts/contact", entry: "./web/svc-contact.ts", kind: "route", methods: ["GET"], scope: "contacts.read" },
    { path: "/svc/contacts/contacts", entry: "./web/svc-contacts.ts", kind: "route", methods: ["GET"], scope: "contacts.read" },
    { path: "/svc/contacts/contacts/create", entry: "./web/svc-contact-create.ts", kind: "route", methods: ["POST"], scope: "contacts.write" },
    { path: "/svc/contacts/contacts/update", entry: "./web/svc-contact-update.ts", kind: "route", methods: ["POST"], scope: "contacts.write" },
    { path: "/svc/contacts/stages", entry: "./web/svc-stages.ts", kind: "route", methods: ["GET"], scope: "leads.read" },
    { path: "/svc/contacts/leads", entry: "./web/svc-leads.ts", kind: "route", methods: ["GET"], scope: "leads.read" },
    { path: "/svc/contacts/leads/create", entry: "./web/svc-lead-create.ts", kind: "route", methods: ["POST"], scope: "leads.write" },
    { path: "/svc/contacts/leads/move", entry: "./web/svc-lead-move.ts", kind: "route", methods: ["POST"], scope: "leads.write" },
  ],
});
