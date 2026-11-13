import { getDb } from "@modunexo/sdk";
import { fieldsOf, idOf, readForm, redirect, refuse } from "../lib/form.ts";
import { parseRule } from "../lib/rules.ts";

/** Adds an alert rule, or updates the one named by `id`. The gate has already required `observability.admin`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const fields = fieldsOf(form);
  const parsed = parseRule(fields);
  if (!parsed.ok) return refuse(parsed.error, 400);
  const rule = parsed.value;
  const values = [rule.name, rule.kind, rule.metric, rule.operator, rule.threshold, rule.forMinutes, rule.severity, rule.host, rule.enabled];
  const db = getDb("observability");
  try {
    if (fields.id === undefined || fields.id.trim() === "") {
      await db.query("insert into alert_rules (name, kind, metric, operator, threshold, for_minutes, severity, host_name, enabled) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)", values);
    } else {
      const id = idOf(fields.id);
      if (id === null) return refuse('"id" must be a number.', 400);
      const updated = await db.query("update alert_rules set name = $1, kind = $2, metric = $3, operator = $4, threshold = $5, for_minutes = $6, severity = $7, host_name = $8, enabled = $9, updated_at = now() where id = $10 returning id", [...values, id]);
      if (updated.rows.length === 0) return refuse("No such rule.", 404);
    }
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return refuse("A rule with that name already exists.", 409);
    throw error;
  }
  return redirect("/observability/rules");
}
