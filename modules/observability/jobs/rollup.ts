import { getDb, type JobContext } from "@modunexo/sdk";

/**
 * Aggregates raw samples into hourly buckets and hourly buckets into daily ones (UTC), per collector and metric.
 * It recomputes from the last bucket it wrote minus one period, so a late sample in the latest hour is picked up and a
 * rerun, or a run after downtime, gives the same rows. Daily buckets weigh each hour by its sample count.
 */
export default async function rollup(ctx?: JobContext): Promise<void> {
  const db = getDb("observability");
  ctx?.signal?.throwIfAborted();
  await db.query(
    `insert into samples_hourly (collector_id, bucket, metric, avg_value, min_value, max_value, sample_count)
     select s.collector_id, date_trunc('hour', s.collected_at at time zone 'UTC') at time zone 'UTC', m.key,
            avg(m.value::double precision), min(m.value::double precision), max(m.value::double precision), count(*)::integer
       from samples s cross join lateral jsonb_each_text(s.metrics) as m(key, value)
      where s.collected_at >= coalesce((select max(bucket) from samples_hourly) - interval '1 hour', '-infinity'::timestamptz)
      group by 1, 2, 3
     on conflict (collector_id, metric, bucket) do update
       set avg_value = excluded.avg_value, min_value = excluded.min_value, max_value = excluded.max_value, sample_count = excluded.sample_count`,
  );
  ctx?.signal?.throwIfAborted();
  await db.query(
    `insert into samples_daily (collector_id, bucket, metric, avg_value, min_value, max_value, sample_count)
     select collector_id, date_trunc('day', bucket at time zone 'UTC') at time zone 'UTC', metric,
            sum(avg_value * sample_count) / sum(sample_count), min(min_value), max(max_value), sum(sample_count)::integer
       from samples_hourly
      where bucket >= coalesce((select max(bucket) from samples_daily) - interval '1 day', '-infinity'::timestamptz)
      group by 1, 2, 3
     on conflict (collector_id, metric, bucket) do update
       set avg_value = excluded.avg_value, min_value = excluded.min_value, max_value = excluded.max_value, sample_count = excluded.sample_count`,
  );
}
