import { getDb, publishEvent, type JobContext } from "@modunexo/sdk";

type Rule = { id: number; name: string; kind: "metric" | "offline"; metric: string | null; operator: ">" | "<"; threshold: number; for_minutes: number; severity: "warning" | "critical"; host_name: string | null };
type Reading = { collector_id: number; host_name: string; value: number | null; breached: boolean; resolved: boolean };

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

const readings = async (rule: Rule): Promise<Reading[]> => {
  const db = getDb("observability");
  const result = rule.kind === "offline"
    ? await db.query<Reading>(OFFLINE_READINGS, [rule.threshold, rule.host_name])
    : await db.query<Reading>(METRIC_READINGS, [rule.metric, rule.operator, rule.for_minutes, rule.threshold, FRESH_MINUTES, COVERAGE_SLACK_SECONDS, rule.host_name]);
  return result.rows;
};

const payloadOf = (rule: Rule, reading: Reading, state: "firing" | "resolved") => ({
  state, severity: rule.severity, rule: rule.name, kind: rule.kind, host: reading.host_name, metric: rule.metric,
  operator: rule.operator, threshold: rule.threshold, forMinutes: rule.for_minutes, value: reading.value,
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
          const opened = await tx.query("insert into alerts (rule_id, collector_id, severity, state, last_value) values ($1, $2, $3, 'firing', $4) on conflict do nothing returning id", [rule.id, reading.collector_id, rule.severity, reading.value]);
          if (opened.rows.length > 0) await publishEvent("observability", "alert", payloadOf(rule, reading, "firing"), { tx });
          else await tx.query("update alerts set last_value = $3, updated_at = now() where rule_id = $1 and collector_id = $2 and state = 'firing'", [rule.id, reading.collector_id, reading.value]);
        });
      } else if (reading.resolved) {
        await db.transaction(async (tx) => {
          const closed = await tx.query("update alerts set state = 'resolved', resolved_at = now(), last_value = $3, updated_at = now() where rule_id = $1 and collector_id = $2 and state = 'firing' returning id", [rule.id, reading.collector_id, reading.value]);
          if (closed.rows.length > 0) await publishEvent("observability", "alert", payloadOf(rule, reading, "resolved"), { tx });
        });
      }
    }
  }
}
