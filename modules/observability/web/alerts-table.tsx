import { describeRule, formatMetric, formatTime } from "../lib/format.ts";
import type { AlertRow } from "../lib/queries.ts";
import { SeverityBadge } from "./shell.tsx";

const condition = (alert: AlertRow): string => describeRule({ kind: alert.kind, metric: alert.metric, operator: alert.operator, threshold: alert.threshold, forMinutes: 0 });
const isEntity = (alert: AlertRow): boolean => alert.subject !== null;
const valueOf = (alert: AlertRow): string => alert.value === null ? "—" : isEntity(alert) ? `${Math.round(alert.value)} min` : alert.kind === "offline" ? `${Math.round(alert.value)} min` : formatMetric(alert.metric ?? "", alert.value);

/** Alerts as a table: firing ones show since when, history ones also when they resolved. `showHost` is off on a host page. */
export default function AlertsTable({ rows, showHost = true, empty }: { rows: AlertRow[]; showHost?: boolean; empty: string }) {
  if (rows.length === 0) return <p className="obs-empty">{empty}</p>;
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {showHost ? <th scope="col">Host</th> : null}
              <th scope="col">Rule</th>
              <th scope="col">Severity</th>
              <th scope="col">State</th>
              <th scope="col" className="right">Value</th>
              <th scope="col">Started</th>
              <th scope="col">Resolved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((alert) => (
              <tr key={alert.id}>
                {showHost ? <th scope="row"><a href={`/observability/collector/${encodeURIComponent(alert.host)}`}>{alert.host}</a>{isEntity(alert) ? <><br /><span className="obs-foot">{alert.subject}{alert.project ? ` · ${alert.project}` : ""}</span></> : null}</th> : null}
                <td>{alert.rule}<br /><span className="obs-foot">{isEntity(alert) && !showHost ? `${alert.subject} · ` : ""}{condition(alert)}</span></td>
                <td><SeverityBadge severity={alert.severity} /></td>
                <td><span className={alert.state === "firing" ? "badge badge-danger" : "badge badge-success"}>{alert.state === "firing" ? "Firing" : "Resolved"}</span></td>
                <td className="right num">{valueOf(alert)}</td>
                <td className="num">{formatTime(alert.startedAt)}</td>
                <td className="num">{alert.resolvedAt === null ? "—" : formatTime(alert.resolvedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
