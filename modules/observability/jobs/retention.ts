import { getDb, type JobContext } from "@modunexo/sdk";

const SCOPES = [
  { raw: "samples", hourly: "samples_hourly", daily: "samples_daily" },
  { raw: "guest_samples", hourly: "guest_samples_hourly", daily: "guest_samples_daily" },
] as const;

/**
 * Keeps raw samples 14 days, hourly rollups 180 days and daily rollups 2 years, for hosts and for guests. A raw sample
 * is never dropped before the rollup has covered its hour (it must be older than the newest hourly bucket), so a
 * stalled rollup loses no history. Guest sessions are kept: they are small and they are the record of time up.
 * The table names come from the constant list above, never from input.
 */
export default async function retention(ctx?: JobContext): Promise<void> {
  const db = getDb("observability");
  for (const scope of SCOPES) {
    ctx?.signal?.throwIfAborted();
    await db.query(
      `delete from ${scope.raw}
        where collected_at < now() - interval '14 days'
          and collected_at < coalesce((select max(bucket) from ${scope.hourly}), '-infinity'::timestamptz)`,
    );
    ctx?.signal?.throwIfAborted();
    await db.query(`delete from ${scope.hourly} where bucket < now() - interval '180 days'`);
    ctx?.signal?.throwIfAborted();
    await db.query(`delete from ${scope.daily} where bucket < now() - interval '2 years'`);
  }
}
