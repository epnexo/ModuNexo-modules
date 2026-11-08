import { SDK_VERSION, defineModule } from "@modunexo/sdk";

export default defineModule({
  id: "documents",
  version: "0.5.0", // raise it whenever a migration is added: an upgrade to the same version does nothing
  name: "Documents",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "documents", // the Postgres schema this module owns
  migrationsDir: "migrations",
  files: { maxBytes: 20 * 1024 * 1024, accept: ["application/pdf"] }, // generated PDFs; no `permission`, so only this module's own route serves them
  settings: [
    { key: "docuseal.url", label: "DocuSeal address", type: "string", description: "The address of your DocuSeal server, for example http://127.0.0.1:3001. Leave empty to keep signing switched off." },
    { key: "docuseal.token", label: "DocuSeal API token", type: "secret", description: "The API token of your DocuSeal account." },
    { key: "engine.url", label: "PDF engine address", type: "string", description: "The address of the PDF engine service, for example http://documents-engine:8080. When set, it is used instead of the Python setting." },
    { key: "engine.token", label: "PDF engine token", type: "secret", description: "The token the PDF engine service was started with (ENGINE_TOKEN)." },
    { key: "engine.python", label: "Python for the PDF engine", type: "string", description: "Path of a Python interpreter that has WeasyPrint installed, for example /usr/bin/python3. Used only when no engine address is set." },
    { key: "engine.assets_dir", label: "Assets folder", type: "string", description: "Folder with the fonts and images that templates may use. Optional." },
    { key: "engine.timeout_ms", label: "PDF time limit (ms)", type: "number", description: "How long one PDF may take to render. Optional." },
  ],
  permissions: [
    { key: "documents.read", label: "Read documents and templates" },
    { key: "documents.write", label: "Create and change documents, templates and the owner profile" },
    { key: "documents.send", label: "Send a document to be signed" },
  ],
  nav: [{ label: "Documents", href: "/documents", icon: "file", permission: "documents.read" }],
  dashboard: {
    stats: [
      { key: "generated", label: "Documents ready to send", href: "/documents", permission: "documents.read", sql: "select count(*) from documents where status = 'generated'" },
      { key: "awaiting", label: "Awaiting signature", href: "/documents", permission: "documents.read", sql: "select count(*) from documents where status = 'sent'" },
      { key: "completed", label: "Signed documents", href: "/documents", permission: "documents.read", sql: "select count(*) from documents where status = 'completed'" },
    ],
    alerts: [
      { key: "stale_sent", label: "Documents unsigned for 7 days", href: "/documents", severity: "warning", permission: "documents.read", sql: "select count(*) from documents where status = 'sent' and updated_at < now() - interval '7 days'" },
    ],
  },
  pages: [
    { path: "/documents", entry: "./web/page.tsx", kind: "page", dynamic: "force-dynamic", permission: "documents.read" },
    { path: "/documents/new", entry: "./web/page-new-document.tsx", kind: "page", dynamic: "force-dynamic", permission: "documents.write" },
    { path: "/documents/settings", entry: "./web/page-settings.tsx", kind: "page", dynamic: "force-dynamic", permission: "documents.write" },
    { path: "/documents/templates", entry: "./web/page-templates.tsx", kind: "page", dynamic: "force-dynamic", permission: "documents.read" },
    { path: "/documents/templates/new", entry: "./web/page-template-new.tsx", kind: "page", dynamic: "force-dynamic", permission: "documents.write" },
    { path: "/documents/templates/[id]", entry: "./web/page-template-edit.tsx", kind: "page", dynamic: "force-dynamic", permission: "documents.write" },
    { path: "/documents/templates/[id]/preview", entry: "./web/template-preview-route.ts", kind: "route", methods: ["GET"], permission: "documents.read" },
    { path: "/documents/[id]", entry: "./web/page-document.tsx", kind: "page", dynamic: "force-dynamic", permission: "documents.read" },
    { path: "/documents/[id]/pdf", entry: "./web/pdf-route.ts", kind: "route", methods: ["GET"], permission: "documents.read" },
    { path: "/documents/[id]/signed-pdf", entry: "./web/signed-pdf-route.ts", kind: "route", methods: ["GET"], permission: "documents.read" },
    { path: "/documents/templates/create", entry: "./web/template-create.ts", kind: "route", methods: ["POST"], permission: "documents.write" },
    { path: "/documents/templates/update", entry: "./web/template-update.ts", kind: "route", methods: ["POST"], permission: "documents.write" },
    { path: "/documents/templates/archive", entry: "./web/template-archive.ts", kind: "route", methods: ["POST"], permission: "documents.write" },
    { path: "/documents/settings/save", entry: "./web/profile-save.ts", kind: "route", methods: ["POST"], permission: "documents.write" },
    { path: "/documents/create", entry: "./web/document-create.ts", kind: "route", methods: ["POST"], permission: "documents.write" },
    { path: "/documents/refresh", entry: "./web/refresh.ts", kind: "route", methods: ["POST"], permission: "documents.write" },
    { path: "/documents/send", entry: "./web/send.ts", kind: "route", methods: ["POST"], permission: "documents.send" },
    { path: "/documents/send/clear", entry: "./web/send-clear.ts", kind: "route", methods: ["POST"], permission: "documents.send" },
  ],
});
