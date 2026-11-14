import { CHART_METRICS } from "../lib/format.ts";
import { loadAlerts, loadEvents, loadFleet, loadGuests, loadSeries } from "../lib/queries.ts";
import { parseRange } from "../lib/ranges.ts";
import HostView from "./host-view.tsx";
import "./observability.css";

export const metadata = { title: "Collector" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CollectorPage({ params, searchParams }: { params: Promise<{ host: string }>; searchParams: SearchParams }) {
  const { host: hostName } = await params;
  const range = parseRange((await searchParams).range);
  const host = (await loadFleet()).find((row) => row.hostName === hostName);
  if (host === undefined) {
    return <div className="obs"><h1>Collector not found</h1><p><a href="/observability">← Back to the fleet</a></p></div>;
  }
  const now = Date.now();
  const metrics = CHART_METRICS.filter((metric) => host.metrics[metric] !== undefined);
  const [series, alerts, events, guests] = await Promise.all([
    Promise.all(metrics.map(async (metric) => ({ metric, points: await loadSeries(host.id, metric, range, new Date(now)) }))),
    loadAlerts({ hostName: host.hostName, historyLimit: 20 }),
    loadEvents(host.id),
    loadGuests(host.id, new Date(now)),
  ]);
  return <div className="obs"><HostView host={host} range={range} series={series} firing={alerts.firing} history={alerts.history} events={events} guests={guests} now={now} /></div>;
}
