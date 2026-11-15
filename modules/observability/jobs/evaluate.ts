import { getDb, publishEvent, type JobContext } from "@modunexo/sdk";
import type { RuleKind } from "../lib/rules.ts";

type Rule = { id: number; name: string; kind: RuleKind; metric: string | null; operator: ">" | "<"; threshold: number; for_minutes: number; severity: "warning" | "critical"; host_name: string | null };
type Reading = { collector_id: number; host_name: string; value: number | null; breached: boolean; resolved: boolean; subject?: string | null; project?: string | null };

/** A host whose newest sample is older than this has no data: its metric alerts are neither fired nor resolved. */
const FRESH_MINUTES = 5;
/** Samples arrive about once a minute, so the window start is covered when the oldest sample is within this slack. */
const COVERAGE_SLACK_SECONDS = 90;

/** Metric rules: breached when every sample of the window violates the threshold and the window is covered. */
const METRIC_READINGS = `
  select c.id as collector_id, c.host_name,
         (array_agg((s.metrics ->> $1)::double precision order by s.collected_at desc))[1] as value,
         (max(s.collected_at) >= now() - make_interval(mins => $5)
           and min(s.collected_at) <= now() - make_interval(mins => $3::int) + make_interval(secs => $6)
           and bool_and(case when $2 = '>' then (s.metrics ->> $1)::double precision > $4 else (s.metrics ->> $1)::double precision < $4 end)) as breached,
         (max(s.collected_at) >= now() - make_interval(mins => $5)
           and not bool_and(case when $2 = '>' then (s.metrics ->> $1)::double precision > $4 else (s.metrics ->> $1)::double precision < $4 end)) as resolved
    from collectors c join samples s on s.collector_id = c.id
   where s.metrics ? $1
     and s.collected_at >= now() - make_interval(mins => greatest($3::int, 2))
     and ($7::text is null or c.host_name = $7)
   group by c.id, c.host_name`;

/** Offline rules: the value is the minutes since the newest sample (or the last heartbeat, or creation). */
const OFFLINE_READINGS = `
  select c.id as collector_id, c.host_name, age.minutes as value, age.minutes > $1 as breached, age.minutes <= $1 as resolved
    from collectors c
    left join lateral (select max(collected_at) as at from samples where collector_id = c.id) last on true
    cross join lateral (select extract(epoch from now() - coalesce(last.at, c.last_seen_at, c.created_at)) / 60 as minutes) age
   where ($2::text is null or c.host_name = $2)`;

/** Container rules: out of the running state for the whole duration, on data that is still arriving. A container the platform dropped resolves. */
const CONTAINER_READINGS = `
  select c.id as collector_id, c.host_name, b.name as subject, b.project,
         case when b.gone_at is null and b.state <> 'running' then extract(epoch from now() - b.state_since) / 60 end as value,
         (b.gone_at is null and b.state <> 'running' and b.last_seen_at >= now() - make_interval(mins => $3)
           and b.state_since <= now() - make_interval(mins => $2::int)) as breached,
         (b.gone_at is not null or b.state = 'running') as resolved
    from containers b join collectors c on c.id = b.collector_id
   where ($1::text is null or c.host_name = $1)`;

/** Guest rules: only guests seen up before; the clock starts when their last session ended. */
const GUEST_READINGS = `
  select c.id as collector_id, c.host_name, g.name as subject, null::text as project,
         case when not g.running then extract(epoch from now() - coalesce(down.at, g.last_seen_at)) / 60 end as value,
         (not g.running and g.last_up_at is not null and g.last_seen_at >= now() - make_interval(mins => $3)
           and coalesce(down.at, g.last_seen_at) <= now() - make_interval(mins => $2::int)) as breached,
         g.running as resolved
    from guests g join collectors c on c.id = g.collector_id
    left join lateral (select max(ended_at) as at from guest_sessions where guest_id = g.id) down on true
   where ($1::text is null or c.host_name = $1)`;

const readings = async (rule: Rule): Promise<Reading[]> => {
  const db = getDb("observability");
  if (rule.kind === "container_down" || rule.kind === "guest_down") {
    return (await db.query<Reading>(rule.kind === "container_down" ? CONTAINER_READINGS : GUEST_READINGS, [rule.host_name, rule.for_minutes, FRESH_MINUTES])).rows;
  }
  const result = rule.kind === "offline"
    ? await db.query<Reading>(OFFLINE_READINGS, [rule.threshold, rule.host_name])
    : await db.query<Reading>(METRIC_READINGS, [rule.metric, rule.operator, rule.for_minutes, rule.threshold, FRESH_MINUTES, COVERAGE_SLACK_SECONDS, rule.host_name]);
  return result.rows;
};

const payloadOf = (rule: Rule, reading: Reading, state: "firing" | "resolved") => ({
  state, severity: rule.severity, rule: rule.name, kind: rule.kind, host: reading.host_name, metric: rule.metric,
  operator: rule.operator, threshold: rule.threshold, forMinutes: rule.for_minutes, value: reading.value,
  subject: reading.subject ?? null, project: reading.project ?? null,
});

/**
 * Evaluates every enabled alert rule against the newest samples. A breach opens one alert per rule and host (a partial
 * unique index keeps it single even under a double run) and a recovery closes it; each change publishes
 * `observability.alert` in the same transaction, so the event exists exactly when the alert row does. Idempotent.
 */
export default async function evaluate(ctx?: JobContext): Promise<void> {
  const db = getDb("observability");
  const rules = (await db.query<Rule>("select id, name, kind, metric, operator, threshold, for_minutes, severity, host_name from alert_rules where enabled order by id")).rows;
  for (const rule of rules) {
    ctx?.signal?.throwIfAborted();
    for (const reading of await readings(rule)) {
      if (reading.breached) {
        await db.transaction(async (tx) => {
          const opened = await tx.query("insert into alerts (rule_id, collector_id, severity, state, last_value, subject, project) values ($1, $2, $3, 'firing', $4, $5, $6) on conflict do nothing returning id", [rule.id, reading.collector_id, rule.severity, reading.value, reading.subject ?? null, reading.project ?? null]);
          if (opened.rows.length > 0) await publishEvent("observability", "alert", payloadOf(rule, reading, "firing"), { tx });
          else await tx.query("update alerts set last_value = $3, updated_at = now() where rule_id = $1 and collector_id = $2 and coalesce(subject, '') = $4 and state = 'firing'", [rule.id, reading.collector_id, reading.value, reading.subject ?? ""]);
        });
      } else if (reading.resolved) {
        await db.transaction(async (tx) => {
          const closed = await tx.query("update alerts set state = 'resolved', resolved_at = now(), last_value = $3, updated_at = now() where rule_id = $1 and collector_id = $2 and coalesce(subject, '') = $4 and state = 'firing' returning id", [rule.id, reading.collector_id, reading.value, reading.subject ?? ""]);
          if (closed.rows.length > 0) await publishEvent("observability", "alert", payloadOf(rule, reading, "resolved"), { tx });
        });
      }
    }
  }
}
