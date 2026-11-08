import { defineManifest } from "@epnexo/core";

export default defineManifest({
  id: "ai-usage",
  version: "0.1.0",
  name: "AI usage",
  dependsOn: [],
  schema: "ai_usage",
  migrationsDir: "migrations",
  nav: [{ label: "AI usage", href: "/ai-usage", icon: "chart" }],
});
