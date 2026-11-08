import type { Queryable } from "../web/queries.ts";

/**
 * Take the next number for a prefix and year. Run it on the connection of the transaction that inserts the
 * document: the upsert locks the counter row until that transaction ends, so two creations cannot get the same
 * number, and a rollback gives the number back.
 */
export async function takeNumber(db: Queryable, prefix: string, year: number): Promise<number> {
  const { rows } = await db.query(
    `insert into documents.counters as c (prefix, year, last_number)
     values ($1, $2, 1)
     on conflict (prefix, year) do update set last_number = c.last_number + 1
     returning last_number`,
    [prefix, year],
  );
  return Number(rows[0]!.last_number);
}
