import { getDb } from "@modunexo/sdk";
import type { SeriesPoint } from "./chart.ts";
import type { RuleKind } from "./rules.ts";
import type { ContainerInput, ContainerState, Platform } from "./containers.ts";
import { RANGES, type Range } from "./ranges.ts";
import { buildTrends, SPIKE_METRICS, WEEK_METRICS, type DayPoint, type HostTrends, type HourPoint } from "./trends.ts";

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
  /** CPU percent of the last hour, oldest first, for the sparkline; empty when the host sent none. */
  trend: number[];
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
  const trends = await getDb("observability").query<{ collector_id: number; trend: number[] }>(
    `select collector_id, array_agg((metrics ->> 'cpuPercent')::float8 order by collected_at) as trend
       from samples where collected_at >= now() - interval '1 hour' and metrics ? 'cpuPercent' group by collector_id`,
  );
  const byHost = new Map(trends.rows.map((row) => [row.collector_id, row.trend]));
  return rows.map((row) => ({ id: row.id, hostName: row.host_name, version: row.version, lastSampleAt: row.collected_at, status: statusOf(row.age_minutes), metrics: row.metrics ?? {}, firing: row.firing, trend: byHost.get(row.id) ?? [] }));
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

const SERIES_SCOPES = {
  host: { id: "collector_id", raw: "samples", hourly: "samples_hourly", daily: "samples_daily" },
  guest: { id: "guest_id", raw: "guest_samples", hourly: "guest_samples_hourly", daily: "guest_samples_daily" },
} as const;

/** One metric of one host or guest over a range, as time-ordered points (epoch ms) with the average, minimum and maximum of each bucket. The table names come from the constant map above. */
async function seriesOf(scope: keyof typeof SERIES_SCOPES, id: number, metric: string, range: Range, now: Date): Promise<SeriesPoint[]> {
  const tables = SERIES_SCOPES[scope];
  const spec = RANGES[range];
  const since = new Date(now.getTime() - spec.ms);
  const db = getDb("observability");
  const result = spec.source === "raw"
    ? spec.bucketSeconds === 0
      ? await db.query<SeriesRow>(
          `select (extract(epoch from collected_at) * 1000)::float8 as t, v as avg, v as min, v as max
             from (select collected_at, (metrics ->> $2)::float8 as v from ${tables.raw} where ${tables.id} = $1 and collected_at >= $3 and metrics ? $2) raw
            order by collected_at`,
          [id, metric, since],
        )
      : await db.query<SeriesRow>(
          `select (floor(extract(epoch from collected_at) / $4) * $4 * 1000)::float8 as t, avg(v)::float8 as avg, min(v)::float8 as min, max(v)::float8 as max
             from (select collected_at, (metrics ->> $2)::float8 as v from ${tables.raw} where ${tables.id} = $1 and collected_at >= $3 and metrics ? $2) raw
            group by 1 order by 1`,
          [id, metric, since, spec.bucketSeconds],
        )
    : await db.query<SeriesRow>(
        `select (floor(extract(epoch from bucket) / $4) * $4 * 1000)::float8 as t,
                (sum(avg_value * sample_count) / sum(sample_count))::float8 as avg, min(min_value) as min, max(max_value) as max
           from ${spec.source === "hourly" ? tables.hourly : tables.daily}
          where ${tables.id} = $1 and metric = $2 and bucket >= $3
          group by 1 order by 1`,
        [id, metric, since, spec.bucketSeconds],
      );
  return result.rows;
}

export const loadSeries = (collectorId: number, metric: string, range: Range, now = new Date()): Promise<SeriesPoint[]> => seriesOf("host", collectorId, metric, range, now);
export const loadGuestSeries = (guestId: number, metric: string, range: Range, now = new Date()): Promise<SeriesPoint[]> => seriesOf("guest", guestId, metric, range, now);

/** What a host's daily and hourly rollups say about this week against the last, its disk and the hours that stood out. */
export async function loadTrends(collectorId: number, now = new Date()): Promise<HostTrends> {
  const db = getDb("observability");
  const today = Math.floor(now.getTime() / 86_400_000) * 86_400_000;
  const daily = await db.query<{ metric: string; t: number; avg: number }>(
    `select metric, (extract(epoch from bucket) * 1000)::float8 as t, avg_value as avg
       from samples_daily where collector_id = $1 and metric = any($2) and bucket >= $3 and bucket < $4 order by bucket`,
    [collectorId, [...WEEK_METRICS], new Date(today - 14 * 86_400_000), new Date(today)],
  );
  const hourly = await db.query<{ metric: string; t: number; avg: number; max: number }>(
    `select metric, (extract(epoch from bucket) * 1000)::float8 as t, avg_value as avg, max_value as max
       from samples_hourly where collector_id = $1 and metric = any($2) and bucket >= $3 and bucket <= $4 order by bucket`,
    [collectorId, Object.keys(SPIKE_METRICS), new Date(now.getTime() - 48 * 3_600_000), now],
  );
  const byMetric = <T extends { metric: string }, U>(rows: T[], pick: (row: T) => U): Record<string, U[]> => {
    const grouped: Record<string, U[]> = {};
    for (const row of rows) (grouped[row.metric] ??= []).push(pick(row));
    return grouped;
  };
  return buildTrends(
    byMetric<(typeof daily.rows)[number], DayPoint>(daily.rows, (row) => ({ t: row.t, avg: row.avg })),
    byMetric<(typeof hourly.rows)[number], HourPoint>(hourly.rows, (row) => ({ t: row.t, avg: row.avg, max: row.max })),
    now.getTime(),
  );
}

export type GuestWindow = "7d" | "30d" | "90d";
const GUEST_WINDOWS: GuestWindow[] = ["7d", "30d", "90d"];

export interface GuestRow {
  id: number;
  collectorId: number;
  hostName: string;
  vmid: number;
  name: string;
  kind: "qemu" | "lxc";
  node: string;
  running: boolean;
  backedUp: boolean | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastUpAt: Date | null;
  /** Seconds the guest was up in each window, counted from when it was first seen. */
  upSeconds: Record<GuestWindow, number>;
  /** Percent of the observed part of each window the guest was up; null before anything was observed. */
  availability: Record<GuestWindow, number | null>;
}

type GuestDbRow = { id: number; collector_id: number; host_name: string; vmid: number; name: string; kind: "qemu" | "lxc"; node: string; running: boolean; backed_up: boolean | null; first_seen_at: Date; last_seen_at: Date; last_up_at: Date | null; up_7: number; up_30: number; up_90: number; obs_7: number; obs_30: number; obs_90: number };

/** Seconds of overlap between the guest's sessions and the last N days (clipped to when it was first seen), and the seconds of that window it has been observed. */
const windowSql = (days: number): string => `
  coalesce((select sum(greatest(0, extract(epoch from least(coalesce(s.ended_at, $1::timestamptz), $1::timestamptz) - greatest(s.started_at, $1::timestamptz - interval '${days} days', g.first_seen_at))))
              from guest_sessions s where s.guest_id = g.id), 0)::float8 as up_${days},
  greatest(0, extract(epoch from $1::timestamptz - greatest($1::timestamptz - interval '${days} days', g.first_seen_at)))::float8 as obs_${days}`;

const GUEST_SELECT = `select g.id, g.collector_id, c.host_name, g.vmid, g.name, g.kind, g.node, g.running, g.backed_up, g.first_seen_at, g.last_seen_at, g.last_up_at,
  ${windowSql(7)}, ${windowSql(30)}, ${windowSql(90)}
  from guests g join collectors c on c.id = g.collector_id`;

const toGuest = (row: GuestDbRow): GuestRow => {
  const up = { "7d": row.up_7, "30d": row.up_30, "90d": row.up_90 };
  const observed = { "7d": row.obs_7, "30d": row.obs_30, "90d": row.obs_90 };
  return {
    id: row.id, collectorId: row.collector_id, hostName: row.host_name, vmid: row.vmid, name: row.name, kind: row.kind, node: row.node, running: row.running, backedUp: row.backed_up,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, lastUpAt: row.last_up_at, upSeconds: up,
    availability: Object.fromEntries(GUEST_WINDOWS.map((w) => [w, observed[w] > 0 ? Math.min(100, (up[w] * 100) / observed[w]) : null])) as Record<GuestWindow, number | null>,
  };
};

/** The guests of one collector (running first, then by name) with their time up. */
export async function loadGuests(collectorId: number, now = new Date()): Promise<GuestRow[]> {
  const { rows } = await getDb("observability").query<GuestDbRow>(`${GUEST_SELECT} where g.collector_id = $2 order by g.running desc, g.name, g.vmid`, [now, collectorId]);
  return rows.map(toGuest);
}

export async function loadGuest(id: number, now = new Date()): Promise<GuestRow | null> {
  const { rows } = await getDb("observability").query<GuestDbRow>(`${GUEST_SELECT} where g.id = $2`, [now, id]);
  return rows[0] === undefined ? null : toGuest(rows[0]);
}

export interface ContainerRow extends ContainerInput {
  id: number;
  hostName: string;
  /** True when the platform stopped listing it. */
  gone: boolean;
}

/** Every known container: live ones first, then by project and name. */
export async function loadContainers(): Promise<ContainerRow[]> {
  const { rows } = await getDb("observability").query<{ id: number; host_name: string; name: string; platform: Platform; project: string; environment: string; service: string; image: string; state: ContainerState; restarts: number; started_at: Date | null; domain: string; gone_at: Date | null }>(
    `select b.id, c.host_name, b.name, b.platform, b.project, b.environment, b.service, b.image, b.state, b.restarts, b.started_at, b.domain, b.gone_at
       from containers b join collectors c on c.id = b.collector_id order by (b.gone_at is not null), b.project, b.name`,
  );
  return rows.map((row) => ({ id: row.id, hostName: row.host_name, name: row.name, platform: row.platform, project: row.project, environment: row.environment, service: row.service, image: row.image, state: row.state, restarts: row.restarts, startedAt: row.started_at ?? undefined, domain: row.domain, gone: row.gone_at !== null }));
}

export interface GuestSession {
  startedAt: Date;
  endedAt: Date | null;
}

/** The latest sessions of a guest, newest first; an open one has no end. */
export async function loadGuestSessions(guestId: number, limit = 20): Promise<GuestSession[]> {
  const { rows } = await getDb("observability").query<{ started_at: Date; ended_at: Date | null }>("select started_at, ended_at from guest_sessions where guest_id = $1 order by started_at desc limit $2", [guestId, limit]);
  return rows.map((row) => ({ startedAt: row.started_at, endedAt: row.ended_at }));
}

export interface AlertRow {
  id: number;
  state: "firing" | "resolved";
  severity: "warning" | "critical";
  startedAt: Date;
  resolvedAt: Date | null;
  value: number | null;
  rule: string;
  kind: RuleKind;
  metric: string | null;
  operator: ">" | "<";
  threshold: number;
  host: string;
  /** The container or guest an entity alert is about; null for a host alert. */
  subject: string | null;
  project: string | null;
}

type AlertDbRow = { id: number; state: "firing" | "resolved"; severity: "warning" | "critical"; started_at: Date; resolved_at: Date | null; last_value: number | null; rule: string; kind: RuleKind; metric: string | null; operator: ">" | "<"; threshold: number; host: string; subject: string | null; project: string | null };

const ALERT_SELECT = `select a.id, a.state, a.severity, a.started_at, a.resolved_at, a.last_value, r.name as rule, r.kind, r.metric, r.operator, r.threshold, c.host_name as host, a.subject, a.project
  from alerts a join alert_rules r on r.id = a.rule_id join collectors c on c.id = a.collector_id`;

const toAlert = (row: AlertDbRow): AlertRow => ({ id: row.id, state: row.state, severity: row.severity, startedAt: row.started_at, resolvedAt: row.resolved_at, value: row.last_value, rule: row.rule, kind: row.kind, metric: row.metric, operator: row.operator, threshold: row.threshold, host: row.host, subject: row.subject, project: row.project });

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
  kind: RuleKind;
  metric: string | null;
  operator: ">" | "<";
  threshold: number;
  forMinutes: number;
  severity: "warning" | "critical";
  host: string | null;
  enabled: boolean;
}

export async function loadRules(): Promise<RuleRow[]> {
  const { rows } = await getDb("observability").query<{ id: number; name: string; kind: RuleKind; metric: string | null; operator: ">" | "<"; threshold: number; for_minutes: number; severity: "warning" | "critical"; host_name: string | null; enabled: boolean }>(
    "select id, name, kind, metric, operator, threshold, for_minutes, severity, host_name, enabled from alert_rules order by name",
  );
  return rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, metric: row.metric, operator: row.operator, threshold: row.threshold, forMinutes: row.for_minutes, severity: row.severity, host: row.host_name, enabled: row.enabled }));
}

export interface EventRow {
  occurredAt: Date;
  level: "warning" | "error";
  unit: string;
  message: string;
}

/** The latest warnings and errors a collector reported about its own host (empty for collectors that send none). */
export async function loadEvents(collectorId: number, limit = 20): Promise<EventRow[]> {
  const { rows } = await getDb("observability").query<{ occurred_at: Date; level: "warning" | "error"; unit: string; message: string }>("select occurred_at, level, unit, message from collector_events where collector_id = $1 order by occurred_at desc limit $2", [collectorId, limit]);
  return rows.map((row) => ({ occurredAt: row.occurred_at, level: row.level, unit: row.unit, message: row.message }));
}
