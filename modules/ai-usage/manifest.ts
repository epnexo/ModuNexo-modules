import { SDK_VERSION, defineModule } from "@modunexo/sdk";

export default defineModule({
  id: "ai-usage",
  version: "0.6.6", // raise it whenever a migration is added: an upgrade to the same version does nothing
  name: "AI usage",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "ai_usage", // the Postgres schema this module owns
  migrationsDir: "migrations",
  permissions: [{ key: "ai_usage.read", label: "Read the AI token usage" }],
  nav: [{ label: "AI usage", href: "/ai-usage", icon: "chart", permission: "ai_usage.read" }],
  // The platform shows these in Settings, which only an administrator can open, so how to connect a machine is not shown to other users.
  settings: [
    {
      key: "platform_url",
      label: "Platform address",
      type: "string",
      description:
        "The address of this platform as the computers see it, for example https://modunexo.example.com. It only fills in the send command shown on the AI usage page. To connect a computer, open API access on this module in Settings: it lists the endpoint and creates one token per computer, with the scope ai_usage.write. Check what would be sent with --dry-run before sending. Only counters, model names, dates and project names are sent, never prompts, answers or file paths.",
    },
    {
      key: "model_prices",
      label: "Model prices",
      type: "string",
      description:
        "Prices in US dollars per million tokens, one entry per model as model=input/cache read/cache write/output, separated by semicolons, for example claude-model=3/0.3/3.75/15; gpt-model=1.25/0.125/0/10. A model ending in * matches every model that starts with the rest. The AI usage page uses them for an estimated cost at API prices; models with no entry are left out and counted as unpriced. The module ships no prices, so enter the ones you trust.",
    },
  ],
  dashboard: {
    stats: [
      { key: "tokens_7d", label: "Tokens, last 7 days", href: "/ai-usage", permission: "ai_usage.read", sql: "select coalesce(sum(total_tokens), 0)::bigint from usage_events where occurred_at >= now() - interval '7 days'" },
      { key: "sessions_7d", label: "Sessions, last 7 days", href: "/ai-usage", permission: "ai_usage.read", sql: "select count(*) from sessions where started_at >= now() - interval '7 days'" },
    ],
    // One bar per day for the last 14 days (UTC), a day with nothing recorded counts as zero. The platform draws it.
    charts: [
      {
        key: "tokens_by_day",
        label: "Tokens per day, last 14 days",
        href: "/ai-usage",
        permission: "ai_usage.read",
        sql: "select to_char(d, 'DD Mon') as label, coalesce(sum(e.total_tokens), 0)::bigint as value from generate_series((now() at time zone 'utc')::date - 13, (now() at time zone 'utc')::date, interval '1 day') d left join usage_events e on e.occurred_at >= d at time zone 'utc' and e.occurred_at < (d + interval '1 day') at time zone 'utc' group by d order by d",
      },
    ],
    alerts: [],
  },
  scopes: [{ key: "ai_usage.write", label: "Send token usage from a collector" }],
  pages: [
    { path: "/ai-usage", entry: "./web/page.tsx", kind: "page", dynamic: "force-dynamic", permission: "ai_usage.read" },
    { path: "/ai-usage/[tool]", entry: "./web/tool-page.tsx", kind: "page", dynamic: "force-dynamic", permission: "ai_usage.read" },
    { path: "/ai-usage/data/daily", entry: "./web/chart-data.ts", kind: "route", methods: ["GET"], dynamic: "force-dynamic", permission: "ai_usage.read" },
    { path: "/svc/ai-usage/ingest", entry: "./web/svc-ingest.ts", kind: "route", methods: ["POST"], scope: "ai_usage.write" },
  ],
});
