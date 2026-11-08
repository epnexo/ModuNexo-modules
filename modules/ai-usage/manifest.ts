import { SDK_VERSION, defineModule } from "@modunexo/sdk";

export default defineModule({
  id: "ai-usage",
  version: "0.3.0", // raise it whenever a migration is added: an upgrade to the same version does nothing
  name: "AI usage",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "ai_usage", // the Postgres schema this module owns
  migrationsDir: "migrations",
  permissions: [{ key: "ai_usage.read", label: "Read the AI token usage" }],
  nav: [{ label: "AI usage", href: "/ai-usage", icon: "chart", permission: "ai_usage.read" }],
  dashboard: {
    stats: [
      { key: "tokens_7d", label: "Tokens, last 7 days", href: "/ai-usage", permission: "ai_usage.read", sql: "select coalesce(sum(total_tokens), 0)::bigint from usage_events where occurred_at >= now() - interval '7 days'" },
      { key: "sessions_7d", label: "Sessions, last 7 days", href: "/ai-usage", permission: "ai_usage.read", sql: "select count(*) from sessions where started_at >= now() - interval '7 days'" },
    ],
    alerts: [],
  },
  scopes: [{ key: "ai_usage.write", label: "Send token usage from a collector" }],
  pages: [
    { path: "/ai-usage", entry: "./web/page.tsx", kind: "page", dynamic: "force-dynamic", permission: "ai_usage.read" },
    { path: "/svc/ai-usage/ingest", entry: "./web/svc-ingest.ts", kind: "route", methods: ["POST"], scope: "ai_usage.write" },
  ],
});
