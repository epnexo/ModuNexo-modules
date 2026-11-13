import { getDb } from "@modunexo/sdk";
import type { SeriesPoint } from "./chart.ts";
import { RANGES, type Range } from "./ranges.ts";

type SeriesRow = { t: number; avg: number; min: number; max: number };

export type HostStatus = "online" | "stale" | "offline";

/** A host with a sample this recent is online; up to the second limit it is stale; beyond it, or with no sample, offline. */
export const ONLINE_MINUTES = 3;
export const STALE_MINUTES = 10;

export const statusOf = (ageMinutes: number | null): HostStatus =>
  ageMinutes === null ? "offline" : ageMinutes <= ONLINE_MINUTES ? "online" : ageMinutes <= STALE_MINUTES ? "stale" : "offline";

export interface FleetRow {
  id: number;
  hostName: string;
  version: string;
  lastSampleAt: Date | null;
  status: HostStatus;
  metrics: Record<string, number>;
  firing: number;
}

export async function loadFleet(): Promise<FleetRow[]> {
  const { rows } = await getDb("observability").query<{ id: number; host_name: string; version: string; collected_at: Date | null; metrics: Record<string, number> | null; age_minutes: number | null; firing: number }>(
    `select c.id, c.host_name, c.version, s.collected_at, s.metrics,
            extract(epoch from now() - s.collected_at)::float8 / 60 as age_minutes,
            (select count(*)::int from alerts a where a.collector_id = c.id and a.state = 'firing') as firing
       from collectors c
       left join lateral (select metrics, collected_at from samples where collector_id = c.id order by collected_at desc limit 1) s on true
      order by c.host_name`,
  );
  return rows.map((row) => ({ id: row.id, hostName: row.host_name, version: row.version, lastSampleAt: row.collected_at, status: statusOf(row.age_minutes), metrics: row.metrics ?? {}, firing: row.firing }));
}

export interface HostRow {
  id: number;
  hostName: string;
  version: string;
  capabilities: string[];
}

export async function loadHost(hostName: string): Promise<HostRow | null> {
  const { rows } = await getDb("observability").query<{ id: number; host_name: string; version: string; capabilities: string[] }>("select id, host_name, version, capabilities from collectors where host_name = $1", [hostName]);
  const row = rows[0];
  return row === undefined ? null : { id: row.id, hostName: row.host_name, version: row.version, capabilities: row.capabilities };
}

/** One metric of one host over a range, as time-ordered points (epoch ms) with the average, minimum and maximum of each bucket. */
export async function loadSeries(collectorId: number, metric: string, range: Range, now = new Date()): Promise<SeriesPoint[]> {
  const spec = RANGES[range];
  const since = new Date(now.getTime() - spec.ms);
  const db = getDb("observability");
  const result = spec.source === "raw"
    ? spec.bucketSeconds === 0
      ? await db.query<SeriesRow>(
          `select (extract(epoch from collected_at) * 1000)::float8 as t, v as avg, v as min, v as max
             from (select collected_at, (metrics ->> $2)::float8 as v from samples where collector_id = $1 and collected_at >= $3 and metrics ? $2) raw
            order by collected_at`,
          [collectorId, metric, since],
        )
      : await db.query<SeriesRow>(
          `select (floor(extract(epoch from collected_at) / $4) * $4 * 1000)::float8 as t, avg(v)::float8 as avg, min(v)::float8 as min, max(v)::float8 as max
             from (select collected_at, (metrics ->> $2)::float8 as v from samples where collector_id = $1 and collected_at >= $3 and metrics ? $2) raw
            group by 1 order by 1`,
          [collectorId, metric, since, spec.bucketSeconds],
        )
    : await db.query<SeriesRow>(
        `select (floor(extract(epoch from bucket) / $4) * $4 * 1000)::float8 as t,
                (sum(avg_value * sample_count) / sum(sample_count))::float8 as avg, min(min_value) as min, max(max_value) as max
           from ${spec.source === "hourly" ? "samples_hourly" : "samples_daily"}
          where collector_id = $1 and metric = $2 and bucket >= $3
          group by 1 order by 1`,
        [collectorId, metric, since, spec.bucketSeconds],
      );
  return result.rows;
}

export interface AlertRow {
  id: number;
  state: "firing" | "resolved";
  severity: "warning" | "critical";
  startedAt: Date;
  resolvedAt: Date | null;
  value: number | null;
  rule: string;
  kind: "metric" | "offline";
  metric: string | null;
  operator: ">" | "<";
  threshold: number;
  host: string;
}

type AlertDbRow = { id: number; state: "firing" | "resolved"; severity: "warning" | "critical"; started_at: Date; resolved_at: Date | null; last_value: number | null; rule: string; kind: "metric" | "offline"; metric: string | null; operator: ">" | "<"; threshold: number; host: string };

const ALERT_SELECT = `select a.id, a.state, a.severity, a.started_at, a.resolved_at, a.last_value, r.name as rule, r.kind, r.metric, r.operator, r.threshold, c.host_name as host
  from alerts a join alert_rules r on r.id = a.rule_id join collectors c on c.id = a.collector_id`;

const toAlert = (row: AlertDbRow): AlertRow => ({ id: row.id, state: row.state, severity: row.severity, startedAt: row.started_at, resolvedAt: row.resolved_at, value: row.last_value, rule: row.rule, kind: row.kind, metric: row.metric, operator: row.operator, threshold: row.threshold, host: row.host });

/** The alerts firing now (critical first) and the most recent ones of any state. `hostName` limits both to one host. */
export async function loadAlerts(options: { hostName?: string; historyLimit?: number } = {}): Promise<{ firing: AlertRow[]; history: AlertRow[] }> {
  const db = getDb("observability");
  const host = options.hostName ?? null;
  const firing = await db.query<AlertDbRow>(`${ALERT_SELECT} where a.state = 'firing' and ($1::text is null or c.host_name = $1) order by (a.severity = 'critical') desc, a.started_at desc`, [host]);
  const history = await db.query<AlertDbRow>(`${ALERT_SELECT} where ($1::text is null or c.host_name = $1) order by a.started_at desc, a.id desc limit $2`, [host, options.historyLimit ?? 50]);
  return { firing: firing.rows.map(toAlert), history: history.rows.map(toAlert) };
}

export interface RuleRow {
  id: number;
  name: string;
  kind: "metric" | "offline";
  metric: string | null;
  operator: ">" | "<";
  threshold: number;
  forMinutes: number;
  severity: "warning" | "critical";
  host: string | null;
  enabled: boolean;
}

export async function loadRules(): Promise<RuleRow[]> {
  const { rows } = await getDb("observability").query<{ id: number; name: string; kind: "metric" | "offline"; metric: string | null; operator: ">" | "<"; threshold: number; for_minutes: number; severity: "warning" | "critical"; host_name: string | null; enabled: boolean }>(
    "select id, name, kind, metric, operator, threshold, for_minutes, severity, host_name, enabled from alert_rules order by name",
  );
  return rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, metric: row.metric, operator: row.operator, threshold: row.threshold, forMinutes: row.for_minutes, severity: row.severity, host: row.host_name, enabled: row.enabled }));
}
