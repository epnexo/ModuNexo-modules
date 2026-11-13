import { getDb, type JobContext } from "@modunexo/sdk";

/**
 * Keeps raw samples 14 days, hourly rollups 180 days and daily rollups 2 years. A raw sample is never dropped before
 * the rollup has covered its hour (it must be older than the newest hourly bucket), so a stalled rollup loses no history.
 */
export default async function retention(ctx?: JobContext): Promise<void> {
  const db = getDb("observability");
  ctx?.signal?.throwIfAborted();
  await db.query(
    `delete from samples
      where collected_at < now() - interval '14 days'
        and collected_at < coalesce((select max(bucket) from samples_hourly), '-infinity'::timestamptz)`,
  );
  ctx?.signal?.throwIfAborted();
  await db.query("delete from samples_hourly where bucket < now() - interval '180 days'");
  ctx?.signal?.throwIfAborted();
  await db.query("delete from samples_daily where bucket < now() - interval '2 years'");
}
