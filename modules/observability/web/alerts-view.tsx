import { describeRule } from "../lib/format.ts";
import type { AlertRow, RuleRow } from "../lib/queries.ts";
import AlertsTable from "./alerts-table.tsx";
import { Bar, SeverityBadge, SubNav, withVar } from "./shell.tsx";

export default function AlertsView({ firing, history, rules }: { firing: AlertRow[]; history: AlertRow[]; rules: RuleRow[] }) {
  const critical = firing.filter((alert) => alert.severity === "critical").length;
  return (
    <>
      <Bar title="Alerts" subtitle="What is wrong now, what went wrong before, and the rules that decide it. Alerts are also sent to the webhook set in the module settings.">
        <SubNav current="alerts" firing={firing.length} />
        <a className="btn btn-sm" href="/observability/rules">Manage rules</a>
      </Bar>
      <dl className="stats" aria-label="Alert summary">
        <div className="stat" style={withVar("--stat-tone", firing.length > 0 ? "var(--danger)" : "var(--success)")}><dt className="stat-label">Firing now</dt><dd className="stat-value">{firing.length}</dd></div>
        <div className="stat" style={withVar("--stat-tone", critical > 0 ? "var(--danger)" : "var(--success)")}><dt className="stat-label">Critical</dt><dd className="stat-value">{critical}</dd></div>
        <div className="stat"><dt className="stat-label">Rules enabled</dt><dd className="stat-value">{rules.filter((rule) => rule.enabled).length} / {rules.length}</dd></div>
      </dl>
      <section className="obs-section" aria-labelledby="firing-heading">
        <h2 id="firing-heading">Firing now</h2>
        <AlertsTable rows={firing} empty="Nothing is firing. Every enabled rule is within its limits." />
      </section>
      <section className="obs-section" aria-labelledby="history-heading">
        <h2 id="history-heading">Recent history</h2>
        <AlertsTable rows={history} empty="No alert has fired yet." />
      </section>
      <section className="obs-section" aria-labelledby="rules-heading">
        <h2 id="rules-heading">Rules</h2>
        <div className="card" style={{ padding: 0 }}>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th scope="col">Rule</th><th scope="col">Condition</th><th scope="col">Applies to</th><th scope="col">Severity</th><th scope="col">State</th></tr></thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <th scope="row">{rule.name}</th>
                    <td>{describeRule(rule)}</td>
                    <td>{rule.host ?? "All hosts"}</td>
                    <td><SeverityBadge severity={rule.severity} /></td>
                    <td><span className={rule.enabled ? "badge badge-success" : "badge"}>{rule.enabled ? "Enabled" : "Disabled"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
