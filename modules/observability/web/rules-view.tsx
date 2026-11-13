import type { RuleRow } from "../lib/queries.ts";
import { Bar } from "./shell.tsx";

const ACTION = "/observability/rules/save";

function Fields({ rule }: { rule?: RuleRow }) {
  return (
    <div className="obs-form-grid">
      <label className="field"><span className="field-label">Name</span><input className="input" name="name" required maxLength={80} defaultValue={rule?.name ?? ""} /></label>
      <label className="field"><span className="field-label">Kind</span>
        <select className="input" name="kind" defaultValue={rule?.kind ?? "metric"}><option value="metric">Metric threshold</option><option value="offline">No data</option></select>
      </label>
      <label className="field"><span className="field-label">Metric</span><input className="input" name="metric" placeholder="diskUsedPercent" defaultValue={rule?.metric ?? ""} /></label>
      <label className="field"><span className="field-label">Operator</span>
        <select className="input" name="operator" defaultValue={rule?.operator ?? ">"}><option value=">">above</option><option value="<">below</option></select>
      </label>
      <label className="field"><span className="field-label">Threshold</span><input className="input" name="threshold" type="number" step="any" required defaultValue={rule?.threshold ?? ""} /></label>
      <label className="field"><span className="field-label">For (minutes)</span><input className="input" name="forMinutes" type="number" min={0} max={1440} step={1} defaultValue={rule?.forMinutes ?? 0} /></label>
      <label className="field"><span className="field-label">Severity</span>
        <select className="input" name="severity" defaultValue={rule?.severity ?? "warning"}><option value="warning">Warning</option><option value="critical">Critical</option></select>
      </label>
      <label className="field"><span className="field-label">Host (empty for all)</span><input className="input" name="host" maxLength={80} defaultValue={rule?.host ?? ""} /></label>
    </div>
  );
}

export default function RulesView({ rules }: { rules: RuleRow[] }) {
  return (
    <>
      <Bar title="Alert rules" subtitle="A metric rule fires when every sample of its window crosses the threshold. A no-data rule fires when a host sends nothing for the given minutes. Changes apply on the next evaluation, within a minute.">
        <a className="btn btn-sm" href="/observability/alerts">Back to alerts</a>
      </Bar>
      <section className="obs-section" aria-labelledby="rules-heading">
        <h2 id="rules-heading">Rules</h2>
        {rules.map((rule) => (
          <form key={rule.id} method="post" action={ACTION} className="card form" aria-label={rule.name}>
            <input type="hidden" name="id" value={rule.id} />
            <Fields rule={rule} />
            <div className="form-actions">
              <label className="obs-inline"><input type="checkbox" name="enabled" defaultChecked={rule.enabled} /> Enabled</label>
              <button type="submit" className="btn btn-primary btn-sm">Save {rule.name}</button>
            </div>
          </form>
        ))}
      </section>
      <section className="obs-section" aria-labelledby="new-heading">
        <h2 id="new-heading">Add a rule</h2>
        <form method="post" action={ACTION} className="card form" aria-label="Add a rule">
          <Fields />
          <div className="form-actions">
            <label className="obs-inline"><input type="checkbox" name="enabled" defaultChecked /> Enabled</label>
            <button type="submit" className="btn btn-primary btn-sm">Add rule</button>
          </div>
        </form>
      </section>
    </>
  );
}
