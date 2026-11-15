import { ago, formatDuration, formatMetric, formatTime, metricLabel, metricUnit } from "../lib/format.ts";
import type { GuestRow, GuestSession } from "../lib/queries.ts";
import { RANGES, type Range } from "../lib/ranges.ts";
import { GuestState, guestKind } from "./guests-table.tsx";
import type { HostSeries } from "./host-view.tsx";
import LiveRefresh from "./live-refresh.tsx";
import { Bar } from "./shell.tsx";
import ChartStats from "./chart-stats.tsx";
import TrendChart from "./trend-chart.tsx";

export interface GuestViewProps {
  guest: GuestRow;
  range: Range;
  series: HostSeries[];
  sessions: GuestSession[];
  /** The instant the window ends, in epoch milliseconds. */
  now: number;
}

const WINDOWS = [["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"]] as const;

/** One VM or container: who it is, how long it has been up, its sessions and its trends over the chosen range. */
export default function GuestView({ guest, range, series, sessions, now }: GuestViewProps) {
  const spec = RANGES[range];
  const lastUpAge = guest.lastUpAt === null ? null : Math.max(0, (now - guest.lastUpAt.getTime()) / 60_000);
  return (
    <>
      <Bar title={guest.name} subtitle={`${guestKind(guest.kind)} · ${guest.vmid} on ${guest.node || guest.hostName}. Times are UTC.`}>
        <GuestState running={guest.running} />
        <LiveRefresh />
        <nav className="seg" aria-label="Time range">
          {(Object.keys(RANGES) as Range[]).map((key) => (
            <a key={key} href={`?range=${key}`} aria-current={key === range ? "page" : undefined}>{RANGES[key].label}</a>
          ))}
        </nav>
      </Bar>
      <p><a href={`/observability/collector/${encodeURIComponent(guest.hostName)}`}>← Back to {guest.hostName}</a></p>
      <dl className="stats" aria-label="Time up">
        {WINDOWS.map(([key, label]) => (
          <div className="stat" key={key}>
            <dt className="stat-label">Time up, {label}</dt>
            <dd className="stat-value">{formatDuration(guest.upSeconds[key])}</dd>
            <dd className="obs-foot">{guest.availability[key] === null ? "not observed yet" : `${guest.availability[key]!.toFixed(1)}% available`}</dd>
          </div>
        ))}
        <div className="stat">
          <dt className="stat-label">{guest.running ? "Running since" : "Last up"}</dt>
          <dd className="stat-value">{guest.running ? (sessions[0]?.endedAt === null && sessions[0] !== undefined ? formatDuration((now - sessions[0].startedAt.getTime()) / 1000) : "now") : ago(lastUpAge)}</dd>
          <dd className="obs-foot">{guest.backedUp === false ? "Not backed up" : guest.backedUp === true ? "Backup covers it" : "Backup unknown"}</dd>
        </div>
      </dl>
      <section className="obs-charts" aria-label="Guest trends">
        {series.length === 0 ? <p className="obs-empty">This guest has not reported any metric yet.</p> : null}
        {series.map(({ metric, points }) => {
          const unit = metricUnit(metric);
          const last = points.at(-1);
          return (
            <section key={metric} className="card" aria-label={metricLabel(metric)}>
              <div className="obs-chart-head">
                <h3>{metricLabel(metric)}</h3>
                <span className="obs-chart-now">{last === undefined ? "—" : formatMetric(metric, last.avg)}</span>
              </div>
              <ChartStats unit={unit} points={points} />
              <TrendChart label={metricLabel(metric)} unit={unit} points={points} from={now - spec.ms} to={now} gapMs={spec.stepMs * 3} max={unit === "percent" ? 100 : undefined} />
            </section>
          );
        })}
      </section>
      <section className="obs-section" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">Sessions</h2>
        {sessions.length === 0 ? <p className="obs-empty">No session recorded yet.</p> : (
          <div className="card" style={{ padding: 0 }}>
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th scope="col">Started</th><th scope="col">Ended</th><th scope="col" className="right">Duration</th></tr></thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.startedAt.toISOString()}>
                      <td className="num">{formatTime(session.startedAt)}</td>
                      <td className="num">{session.endedAt === null ? "Still running" : formatTime(session.endedAt)}</td>
                      <td className="right num">{formatDuration(((session.endedAt?.getTime() ?? now) - session.startedAt.getTime()) / 1000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
