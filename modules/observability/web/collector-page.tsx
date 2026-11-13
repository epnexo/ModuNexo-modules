import { getDb } from "@modunexo/sdk";

export const metadata = { title: "Collector" };

type Metrics = Record<string, number>;
type MetricInfo = { label: string; value: string; note: string };

const gib = (value: number) => `${(value / 1024 / 1024 / 1024).toFixed(1)} GiB`;
const kibToGib = (value: number) => `${(value / 1024 / 1024).toFixed(1)} GiB`;

const metric = (key: string, value: number): MetricInfo => {
  const definitions: Record<string, MetricInfo> = {
    cpuTemperatureC: { label: "CPU temperature", value: `${value.toFixed(1)} °C`, note: "Current processor temperature" },
    load1: { label: "System load · 1 minute", value: value.toFixed(2), note: "Average runnable work over 1 minute" },
    load5: { label: "System load · 5 minutes", value: value.toFixed(2), note: "Average runnable work over 5 minutes" },
    load15: { label: "System load · 15 minutes", value: value.toFixed(2), note: "Average runnable work over 15 minutes" },
    cpuCores: { label: "CPU cores", value: String(value), note: "Logical processors available to Linux" },
    memoryTotalKiB: { label: "Total memory", value: kibToGib(value), note: "Installed memory available to Linux" },
    memoryAvailableKiB: { label: "Available memory", value: kibToGib(value), note: "Memory Linux can allocate without swapping" },
    swapTotalKiB: { label: "Total swap", value: kibToGib(value), note: "Configured disk-backed memory" },
    swapFreeKiB: { label: "Available swap", value: kibToGib(value), note: "Swap capacity still available" },
    rootDiskTotalBytes: { label: "Root disk capacity", value: gib(value), note: "Total storage for the root filesystem" },
    rootDiskFreeBytes: { label: "Root disk available", value: gib(value), note: "Space available to unprivileged processes" },
    rootDiskUsedBytes: { label: "Root disk used", value: gib(value), note: "Storage currently consumed on the root filesystem" },
    uptimeSeconds: { label: "System uptime", value: `${(value / 86400).toFixed(1)} days`, note: "Time since the last reboot" },
    processCount: { label: "Running processes", value: String(value), note: "Processes currently visible to the agent" },
    thermalZoneCount: { label: "Thermal sensors", value: String(value), note: "Linux thermal zones exposed by this host" },
    dockerContainersTotal: { label: "Docker containers", value: String(value), note: "All containers visible to the local Docker daemon" },
    dockerContainersRunning: { label: "Running containers", value: String(value), note: "Containers currently in the running state" },
    dockerContainersStopped: { label: "Stopped containers", value: String(value), note: "Containers not currently running" },
    dockerContainersHealthy: { label: "Healthy containers", value: String(value), note: "Containers reporting a healthy healthcheck" },
    dockerContainersUnhealthy: { label: "Unhealthy containers", value: String(value), note: "Containers reporting an unhealthy healthcheck" },
    coolifyContainers: { label: "Coolify containers", value: String(value), note: "Containers identified by Coolify labels" },
    dokployContainers: { label: "Dokploy containers", value: String(value), note: "Containers identified by Dokploy labels" },
    plainDockerContainers: { label: "Plain Docker containers", value: String(value), note: "Containers without Coolify or Dokploy labels" },
  };
  return definitions[key] ?? { label: key, value: String(value), note: "Latest collector value" };
};

function Trend({ label, samples, metricKey }: { label: string; samples: Array<{ metrics: Metrics }>; metricKey: string }) {
  const values = samples.map((sample) => sample.metrics[metricKey]).filter((value): value is number => value !== undefined);
  if (values.length < 2) return <div className="card"><h3 className="font-medium">{label}</h3><p className="mt-4 text-sm text-muted">Waiting for more samples to draw a trend.</p></div>;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = high - low || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 320},${96 - ((value - low) / range) * 80}`).join(" ");
  return <div className="card"><div className="flex items-baseline justify-between gap-3"><h3 className="font-medium">{label}</h3><span className="text-sm text-muted tabular-nums">{metric(metricKey, values.at(-1)!).value}</span></div><svg viewBox="0 0 320 104" className="mt-4 h-28 w-full" role="img" aria-label={`${label} trend`}><path d="M0 96 H320" stroke="currentColor" className="text-border" strokeWidth="1" /><polyline points={points} fill="none" stroke="currentColor" className="text-foreground" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg><p className="text-xs text-muted">Range {metric(metricKey, low).value} – {metric(metricKey, high).value}</p></div>;
}

export default async function CollectorPage({ params }: { params: Promise<{ host: string }> }) {
  const { host } = await params;
  const found = await getDb("observability").query<{ id: number; host_name: string; version: string; capabilities: string[]; last_seen_at: Date | null; metrics: Metrics | null; collected_at: Date | null }>("select c.id, c.host_name, c.version, c.capabilities, c.last_seen_at, s.metrics, s.collected_at from collectors c left join lateral (select metrics, collected_at from samples where collector_id = c.id order by collected_at desc limit 1) s on true where c.host_name = $1", [host]);
  const collector = found.rows[0];
  if (!collector) return <div className="flex flex-col gap-3"><a href="/observability" className="text-sm underline-offset-4 hover:underline">Back to fleet</a><h1 className="text-2xl font-semibold tracking-tight">Collector not found</h1></div>;
  const history = await getDb("observability").query<{ metrics: Metrics; collected_at: Date }>("select metrics, collected_at from samples where collector_id = $1 order by collected_at desc limit 48", [collector.id]);
  const events = await getDb("observability").query<{ occurred_at: Date; level: "warning" | "error"; unit: string; message: string }>("select occurred_at, level, unit, message from collector_events where collector_id = $1 order by occurred_at desc limit 20", [collector.id]);
  const samples = [...history.rows].reverse();
  const metrics = Object.entries(collector.metrics ?? {}).filter(([key]) => key !== "collectedUnix" && key !== "coolifyContainers" && key !== "dokployContainers" && key !== "plainDockerContainers");
  const platforms = (["coolifyContainers", "dokployContainers"] as const).filter((key) => (collector.metrics?.[key] ?? 0) > 0).map((key) => key === "coolifyContainers" ? "Coolify" : "Dokploy");
  return <div className="flex flex-col gap-4"><header className="flex flex-wrap items-end justify-between gap-2"><div><a href="/observability" className="text-sm underline-offset-4 hover:underline">Back to fleet</a><h1 className="mt-3 text-2xl font-semibold tracking-tight">{collector.host_name}</h1><p className="mt-1 text-sm text-muted">Agent {collector.version} · Last metric {collector.collected_at?.toISOString() ?? "not received"}</p></div><span className="rounded-full border border-border bg-surface px-3 py-1 text-sm font-medium">{collector.last_seen_at ? "Connected" : "Not connected"}</span></header><section aria-label="Metric trends" className="card"><div><h2 className="text-lg font-semibold tracking-tight">Trends</h2><p className="mt-1 text-sm text-muted">The most recent 48 samples received from this collector.</p></div><div className="mt-4 grid gap-3 lg:grid-cols-3"><Trend label="CPU temperature" samples={samples} metricKey="cpuTemperatureC" /><Trend label="System load" samples={samples} metricKey="load1" /><Trend label="Available memory" samples={samples} metricKey="memoryAvailableKiB" /></div></section><section aria-label="Latest metrics" className="card"><div><h2 className="text-lg font-semibold tracking-tight">Latest metrics</h2><p className="mt-1 text-sm text-muted">Values received in the most recent collector delivery.</p></div><dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{metrics.map(([key, value]) => { const item = metric(key, value); return <div key={key} className="rounded-md border border-border p-3"><dt className="text-sm text-muted">{item.label}</dt><dd className="mt-2 text-2xl font-semibold tabular-nums">{item.value}</dd><p className="mt-2 text-xs text-muted">{item.note}</p></div>; })}</dl></section><section className="card"><h2 className="font-semibold">Platform</h2><p className="mt-2 text-sm text-muted">{platforms.length ? platforms.join(" · ") : "No Coolify or Dokploy labels detected."}</p></section><section aria-label="Recent warnings and errors" className="card"><h2 className="font-semibold">Recent warnings and errors</h2>{events.rows.length === 0 ? <p className="mt-2 text-sm text-muted">No sanitized warning or error events received yet.</p> : <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">{events.rows.map((event) => <li key={`${event.occurred_at.toISOString()}-${event.message}`} className="px-3 py-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{event.level === "error" ? "Error" : "Warning"} · {event.unit || "system"}</span><time className="text-xs text-muted" dateTime={event.occurred_at.toISOString()}>{event.occurred_at.toISOString()}</time></div><p className="mt-1 break-words text-muted">{event.message}</p></li>)}</ul>}</section><section className="card"><h2 className="font-semibold">Collection capabilities</h2><p className="mt-2 text-sm text-muted">{collector.capabilities.length ? collector.capabilities.map((capability) => metric(capability, 0).label).join(" · ") : "No capabilities reported"}</p></section></div>;
}
