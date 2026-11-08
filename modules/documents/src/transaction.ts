import type { DbQueryable } from "@modunexo/sdk";
import type { Queryable } from "../web/queries.ts";

/** What a transaction needs from the data handle: a way to run several statements as one unit. `getDb(...)` satisfies it. */
export interface Transactional extends Queryable {
  transaction<T>(run: (tx: DbQueryable) => Promise<T>): Promise<T>;
}

/**
 * Run `work` as one unit: all of its statements commit, or none does. An error rolls everything back and is rethrown.
 * Do not call another service from inside `work`: the transaction stays open while it waits.
 */
export function inTransaction<T>(db: Transactional, work: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction((tx) => work(tx));
}
