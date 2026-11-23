import { ago, formatMetric, metricLabel, toneOf } from "../lib/format.ts";
import type { FleetRow } from "../lib/queries.ts";
import { sparkPoints } from "../lib/spark.ts";
import LiveRefresh from "./live-refresh.tsx";
import { Bar, StatusBadge, SubNav, withVar } from "./shell.tsx";

const GAUGES = ["cpuPercent", "memUsedPercent", "diskUsedPercent"] as const;
const FACTS = ["load1", "tempCelsius", "uptimeSeconds", "guestsRunning", "guestsNotBackedUp"] as const;

function Gauge({ metric, value }: { metric: string; value: number }) {
  return (
    <div className="obs-gauge">
      <dt>{metricLabel(metric)}</dt>
      <dd><span className="obs-track"><span className="obs-fill" data-tone={toneOf(metric, value)} style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} /></span></dd>
      <dd>{formatMetric(metric, value)}</dd>
    </div>
  );
}

function HostCard({ host, now, index }: { host: FleetRow; now: number; index: number }) {
  const gauges = GAUGES.filter((metric) => host.metrics[metric] !== undefined);
  const facts = FACTS.filter((metric) => host.metrics[metric] !== undefined);
  const age = host.lastSampleAt === null ? null : Math.max(0, (now - host.lastSampleAt.getTime()) / 60_000);
  return (
    <section className="card card-link rise" style={withVar("--rise-i", String(Math.min(index, 3)))} aria-label={host.hostName}>
      <div className="obs-host-head">
        <a className="obs-host-name" href={`/observability/collector/${encodeURIComponent(host.hostName)}`}>{host.hostName}</a>
        <span className="obs-badges">
          {host.firing > 0 ? <span className="badge badge-danger">{host.firing} {host.firing === 1 ? "alert" : "alerts"}</span> : null}
          <StatusBadge status={host.status} />
        </span>
      </div>
      {gauges.length === 0 && facts.length === 0 ? <p className="empty">No samples yet.</p> : null}
      {gauges.length > 0 ? <dl className="obs-gauges">{gauges.map((metric) => <Gauge key={metric} metric={metric} value={host.metrics[metric]!} />)}</dl> : null}
      {host.trend.length >= 2 ? <svg className="obs-spark" viewBox="0 0 120 28" role="img" aria-label="CPU, last hour" preserveAspectRatio="none"><polyline points={sparkPoints(host.trend, 120, 28, 100)} fill="none" /></svg> : null}
      {facts.length > 0 ? <dl className="obs-facts">{facts.map((metric) => <div key={metric}><dt>{metricLabel(metric)}</dt><dd>{formatMetric(metric, host.metrics[metric]!)}</dd></div>)}</dl> : null}
      <p className="obs-foot">Last sample {ago(age)}</p>
    </section>
  );
}

export default function FleetView({ fleet, now }: { fleet: FleetRow[]; now: number }) {
  const online = fleet.filter((host) => host.status === "online").length;
  const firing = fleet.reduce((total, host) => total + host.firing, 0);
  const worst = (metric: string) => fleet.reduce<number | null>((max, host) => (host.metrics[metric] === undefined ? max : Math.max(max ?? 0, host.metrics[metric]!)), null);
  const disk = worst("diskUsedPercent");
  const temp = worst("tempCelsius");
  const tone = (metric: string, value: number | null) => (value === null ? undefined : withVar("--stat-tone", toneOf(metric, value) === "danger" ? "var(--danger)" : toneOf(metric, value) === "warning" ? "var(--warning)" : "var(--success)"));
  return (
    <>
      <Bar title="Observability" subtitle="Where the fleet stands now and what went wrong. The live detail is in Grafana; this page keeps the history and the alerts.">
        <LiveRefresh />
        <SubNav current="fleet" firing={firing} />
      </Bar>
      {firing > 0 ? <div className="notice notice-error" role="alert"><strong>{firing} {firing === 1 ? "alert is" : "alerts are"} firing.</strong> <a href="/observability/alerts">See which hosts and why.</a></div> : null}
      <dl className="stats" aria-label="Fleet summary">
        <div className="stat" style={withVar("--stat-tone", online === fleet.length && fleet.length > 0 ? "var(--success)" : "var(--warning)")}><dt className="stat-label">Hosts online</dt><dd className="stat-value">{online} / {fleet.length}</dd></div>
        <div className="stat" style={withVar("--stat-tone", firing > 0 ? "var(--danger)" : "var(--success)")}><dt className="stat-label">Alerts firing</dt><dd className="stat-value">{firing}</dd></div>
        <div className="stat" style={tone("diskUsedPercent", disk)}><dt className="stat-label">Fullest disk</dt><dd className="stat-value">{disk === null ? "—" : formatMetric("diskUsedPercent", disk)}</dd></div>
        <div className="stat" style={tone("tempCelsius", temp)}><dt className="stat-label">Hottest host</dt><dd className="stat-value">{temp === null ? "—" : formatMetric("tempCelsius", temp)}</dd></div>
      </dl>
      <section className="obs-section" aria-labelledby="hosts-heading">
        <h2 id="hosts-heading">Hosts</h2>
        {fleet.length === 0 ? (
          <div className="notice notice-info" role="status"><strong>No hosts have reported yet.</strong> Point a collector at this module and it appears here after its first heartbeat.</div>
        ) : (
          <div className="obs-hosts">{fleet.map((host, index) => <HostCard key={host.id} host={host} now={now} index={index} />)}</div>
        )}
      </section>
    </>
  );
}
