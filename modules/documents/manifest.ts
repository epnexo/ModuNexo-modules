import { defineManifest } from "@epnexo/core";

export default defineManifest({
  id: "documents",
  version: "0.1.0",
  name: "Documents",
  dependsOn: [],
  schema: "documents",
  migrationsDir: "migrations",
  nav: [{ label: "Documents", href: "/documents" }],
});
