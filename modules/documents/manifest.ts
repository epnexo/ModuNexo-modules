import { SDK_VERSION, defineModule } from "@modunexo/sdk";

export default defineModule({
  id: "documents",
  version: "0.3.0", // raise it whenever a migration is added: an upgrade to the same version does nothing
  name: "Documents",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "documents", // the Postgres schema this module owns
  migrationsDir: "migrations",
  files: { maxBytes: 20 * 1024 * 1024, accept: ["application/pdf"] }, // generated PDFs; no `permission`, so only this module's own route serves them
  permissions: [
    { key: "documents.read", label: "Read documents and templates" },
    { key: "documents.write", label: "Create and change documents, templates and the owner profile" },
    { key: "documents.send", label: "Send a document to be signed" },
  ],
  nav: [{ label: "Documents", href: "/documents", icon: "file", permission: "documents.read" }],
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
