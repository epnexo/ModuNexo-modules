import { SDK_VERSION, defineModule } from "@modunexo/sdk";

export default defineModule({
  id: "observability",
  version: "0.1.12",
  name: "Observability",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "observability",
  migrationsDir: "migrations",
  permissions: [
    { key: "observability.read", label: "Read fleet health and metrics" },
    { key: "observability.admin", label: "Manage observability collectors" },
  ],
  scopes: [{ key: "collectors.write", label: "Send collector telemetry" }],
  settings: [
    { key: "collector_ca", label: "Collector CA certificate", type: "secret", description: "CA certificate trusted by outbound collectors." },
  ],
  nav: [{ label: "Observability", href: "/observability", icon: "activity", permission: "observability.read" }],
  dashboard: {
    stats: [{ key: "collectors", label: "Collectors", href: "/observability", permission: "observability.read", sql: "select count(*) from collectors" }],
    alerts: [{ key: "offline_collectors", label: "Collectors offline", href: "/observability", severity: "warning", permission: "observability.read", sql: "select count(*) from collectors where last_seen_at is null or last_seen_at < now() - interval '10 minutes'" }],
  },
  jobs: [
    { name: "rollup", entry: "./jobs/rollup.ts", every: "1h" },
    { name: "retention", entry: "./jobs/retention.ts", every: "1d" },
  ],
  pages: [
    { path: "/observability", entry: "./web/observability-page.tsx", kind: "page", dynamic: "force-dynamic", permission: "observability.read" },
    { path: "/observability/collector/[host]", entry: "./web/collector-page.tsx", kind: "page", dynamic: "force-dynamic", permission: "observability.read" },
    { path: "/observability/settings", entry: "./web/settings-page.tsx", kind: "page", dynamic: "force-dynamic", permission: "observability.admin" },
    { path: "/svc/observability/heartbeat", entry: "./web/heartbeat.ts", kind: "route", methods: ["POST"], scope: "collectors.write" },
    { path: "/svc/observability/ingest", entry: "./web/ingest.ts", kind: "route", methods: ["POST"], scope: "collectors.write" },
    { path: "/svc/observability/events", entry: "./web/events.ts", kind: "route", methods: ["POST"], scope: "collectors.write" },
  ],
});
