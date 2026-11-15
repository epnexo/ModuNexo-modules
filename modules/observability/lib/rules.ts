export type RuleKind = "metric" | "offline" | "container_down" | "guest_down";

export interface RuleInput {
  name: string;
  kind: RuleKind;
  metric: string | null;
  operator: ">" | "<";
  threshold: number;
  forMinutes: number;
  severity: "warning" | "critical";
  host: string | null;
  enabled: boolean;
}

export type RuleResult = { ok: true; value: RuleInput } | { ok: false; error: string };

const KINDS: RuleKind[] = ["metric", "offline", "container_down", "guest_down"];
const METRIC_KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/;

/**
 * An alert rule from the fields of a form. An offline rule always reads "no data for more than N minutes", so its
 * metric, operator and duration are fixed; a container or guest rule only has a duration; an unchecked "enabled" box sends nothing and means disabled.
 */
export function parseRule(fields: Record<string, string>): RuleResult {
  const name = (fields.name ?? "").trim();
  if (name === "" || name.length > 80) return { ok: false, error: "The name must be 1 to 80 characters." };
  const kind: RuleKind | null = fields.kind === undefined ? "metric" : KINDS.find((candidate) => candidate === fields.kind) ?? null;
  if (kind === null) return { ok: false, error: "The kind must be metric, offline, container_down or guest_down." };
  const severity = fields.severity === "critical" ? "critical" : fields.severity === undefined || fields.severity === "warning" ? "warning" : null;
  if (severity === null) return { ok: false, error: "The severity must be warning or critical." };
  if (kind === "container_down" || kind === "guest_down") {
    const minutes = (fields.forMinutes ?? "5").trim();
    const forMinutes = minutes === "" ? 5 : Number(minutes);
    if (!Number.isInteger(forMinutes) || forMinutes < 0 || forMinutes > 1440) return { ok: false, error: "The duration must be a whole number of minutes from 0 to 1440." };
    const where = (fields.host ?? "").trim();
    if (where.length > 80) return { ok: false, error: "The host must be at most 80 characters." };
    return { ok: true, value: { name, kind, metric: null, operator: ">", threshold: 0, forMinutes, severity, host: where === "" ? null : where, enabled: fields.enabled === "on" } };
  }
  const raw = (fields.threshold ?? "").trim();
  const threshold = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(threshold)) return { ok: false, error: "The threshold must be a number." };
  const host = (fields.host ?? "").trim();
  if (host.length > 80) return { ok: false, error: "The host must be at most 80 characters." };
  const enabled = fields.enabled === "on";
  if (kind === "offline") {
    if (threshold <= 0) return { ok: false, error: "The minutes without data must be above zero." };
    return { ok: true, value: { name, kind, metric: null, operator: ">", threshold, forMinutes: 0, severity, host: host === "" ? null : host, enabled } };
  }
  const metric = (fields.metric ?? "").trim();
  if (!METRIC_KEY.test(metric)) return { ok: false, error: "The metric must be a name such as cpuPercent." };
  const operator = fields.operator === "<" ? "<" : fields.operator === undefined || fields.operator === ">" ? ">" : null;
  if (operator === null) return { ok: false, error: "The operator must be > or <." };
  const minutes = (fields.forMinutes ?? "0").trim();
  const forMinutes = minutes === "" ? 0 : Number(minutes);
  if (!Number.isInteger(forMinutes) || forMinutes < 0 || forMinutes > 1440) return { ok: false, error: "The duration must be a whole number of minutes from 0 to 1440." };
  return { ok: true, value: { name, kind, metric, operator, threshold, forMinutes, severity, host: host === "" ? null : host, enabled } };
}
