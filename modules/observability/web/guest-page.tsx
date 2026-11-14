import { GUEST_CHART_METRICS } from "../lib/format.ts";
import { loadGuest, loadGuestSeries, loadGuestSessions } from "../lib/queries.ts";
import { parseRange } from "../lib/ranges.ts";
import GuestView from "./guest-view.tsx";
import "./observability.css";

export const metadata = { title: "Guest" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function GuestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id: rawId } = await params;
  const range = parseRange((await searchParams).range);
  const id = /^\d{1,15}$/.test(rawId) ? Number(rawId) : null;
  const now = Date.now();
  const guest = id === null ? null : await loadGuest(id, new Date(now));
  if (guest === null) {
    return <div className="obs"><h1>Guest not found</h1><p><a href="/observability">← Back to the fleet</a></p></div>;
  }
  const [series, sessions] = await Promise.all([
    Promise.all(GUEST_CHART_METRICS.map(async (metric) => ({ metric, points: await loadGuestSeries(guest.id, metric, range, new Date(now)) }))),
    loadGuestSessions(guest.id),
  ]);
  return <div className="obs"><GuestView guest={guest} range={range} series={series.filter((entry) => entry.points.length > 0)} sessions={sessions} now={now} /></div>;
}
