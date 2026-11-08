import type { Queryable } from "../web/queries.ts";

/** What a transaction needs from a pool: a way to check out one connection. A `pg.Pool` satisfies it. */
export interface Transactional extends Queryable {
  connect(): Promise<Queryable & { release(error?: Error | boolean): void }>;
}

/**
 * Run `work` on one connection between BEGIN and COMMIT. Any error rolls back and is rethrown; a failed rollback
 * releases the connection as broken, so the pool discards it instead of reusing it.
 */
export async function inTransaction<T>(db: Transactional, work: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken = false;
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}
