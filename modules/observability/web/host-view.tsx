import type { SeriesPoint } from "../lib/chart.ts";
import { ago, formatMetric, formatTime, metricLabel, metricUnit } from "../lib/format.ts";
import type { AlertRow, EventRow, FleetRow, GuestRow } from "../lib/queries.ts";
import { RANGES, type Range } from "../lib/ranges.ts";
import AlertsTable from "./alerts-table.tsx";
import GuestsTable from "./guests-table.tsx";
import LiveRefresh from "./live-refresh.tsx";
import { Bar, StatusBadge } from "./shell.tsx";
import TrendChart from "./trend-chart.tsx";

export interface HostSeries {
  metric: string;
  points: SeriesPoint[];
}

export interface HostViewProps {
  host: FleetRow;
  range: Range;
  series: HostSeries[];
  firing: AlertRow[];
  history: AlertRow[];
  events: EventRow[];
  /** Guests (VMs and containers) this host reports, when it is a hypervisor. */
  guests?: GuestRow[];
  /** The instant the window ends, in epoch milliseconds. */
  now: number;
}

export default function HostView({ host, range, series, firing, history, events, guests = [], now }: HostViewProps) {
  const spec = RANGES[range];
  const age = host.lastSampleAt === null ? null : Math.max(0, (now - host.lastSampleAt.getTime()) / 60_000);
  const latest = Object.entries(host.metrics).filter(([key]) => key !== "up");
  return (
    <>
      <Bar title={host.hostName} subtitle={`Collector ${host.version} · last sample ${ago(age)}. Times are UTC.`}>
        <StatusBadge status={host.status} />
        <LiveRefresh />
        <nav className="seg" aria-label="Time range">
          {(Object.keys(RANGES) as Range[]).map((key) => (
            <a key={key} href={`?range=${key}`} aria-current={key === range ? "page" : undefined}>{RANGES[key].label}</a>
          ))}
        </nav>
      </Bar>
      <p><a href="/observability">← Back to the fleet</a></p>
      {firing.length > 0 ? <div className="notice notice-error" role="alert"><strong>{firing.length} {firing.length === 1 ? "alert is" : "alerts are"} firing on this host.</strong></div> : null}
      <section className="obs-charts" aria-label="Metric trends">
        {series.length === 0 ? <p className="obs-empty">This host has not reported any metric yet.</p> : null}
        {series.map(({ metric, points }) => {
          const unit = metricUnit(metric);
          const last = points.at(-1);
          return (
            <section key={metric} className="card" aria-label={metricLabel(metric)}>
              <div className="obs-chart-head">
                <h3>{metricLabel(metric)}</h3>
                <span className="obs-chart-now">{last === undefined ? "—" : formatMetric(metric, last.avg)}</span>
              </div>
              <TrendChart label={metricLabel(metric)} unit={unit} points={points} from={now - spec.ms} to={now} gapMs={spec.stepMs * 3} max={unit === "percent" ? 100 : undefined} />
            </section>
          );
        })}
      </section>
      {guests.length > 0 ? (
        <section className="obs-section" aria-labelledby="guests-heading">
          <h2 id="guests-heading">Guests</h2>
          <GuestsTable guests={guests} now={now} />
        </section>
      ) : null}
      <section className="obs-section" aria-labelledby="alerts-heading">
        <h2 id="alerts-heading">Alerts on this host</h2>
        <AlertsTable rows={history} showHost={false} empty="No alert has fired on this host." />
      </section>
      <section className="card" aria-label="Latest values">
        <h2 className="obs-chart-head">Latest values</h2>
        {latest.length === 0 ? <p className="obs-empty">No samples yet.</p> : (
          <dl className="detail-list">
            {latest.map(([key, value]) => <div key={key}><dt>{metricLabel(key)}</dt><dd>{formatMetric(key, value)}</dd></div>)}
          </dl>
        )}
      </section>
      {events.length > 0 ? (
        <section className="obs-section" aria-labelledby="events-heading">
          <h2 id="events-heading">Warnings and errors reported by the host</h2>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th scope="col">When</th><th scope="col">Level</th><th scope="col">Unit</th><th scope="col">Message</th></tr></thead>
                <tbody>{events.map((event) => <tr key={`${event.occurredAt.toISOString()}-${event.message}`}><td className="num">{formatTime(event.occurredAt)}</td><td><span className={event.level === "error" ? "badge badge-danger" : "badge badge-warning"}>{event.level === "error" ? "Error" : "Warning"}</span></td><td>{event.unit || "system"}</td><td>{event.message}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
