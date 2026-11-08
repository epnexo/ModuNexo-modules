import { fileURLToPath } from "node:url";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";
import type pg from "pg";
import type { Transactional } from "../../src/transaction.ts";
import documents from "../../manifest.ts";

const MODULE_DIR = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A pool plus the `transaction` method `getDb(...)` has, so the stores run against it unchanged. `transaction` runs
 * on one connection between begin and commit, like the platform's handle.
 */
export type TestDb = pg.Pool & Transactional;

function withTransaction(pool: pg.Pool): TestDb {
  return Object.assign(pool, {
    async transaction<T>(run: (tx: { query: pg.Pool["query"] }) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const done = await run(client as never);
        await client.query("commit");
        return done;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  }) as unknown as TestDb;
}

/**
 * A pool on a scratch database with every `documents` migration applied, or the reason there is none. Ending the pool
 * drops the scratch database. `suffix` is kept so each test file reads the same as before.
 */
export async function openMigratedPool(_suffix: string): Promise<{ pool?: TestDb; skipReason?: string }> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return { skipReason: scratch.skipReason };
  const pool = createPool(scratch.url);
  const registry = new Registry();
  registry.registerCore();
  registry.register(documents);
  await migrate(pool, registry, { moduleDirs: { documents: MODULE_DIR } });
  await pool.query("insert into core.modules (id, state, installed_version) values ('documents', 'enabled', $1)", [documents.version]);
  const end = pool.end.bind(pool);
  pool.end = (async () => {
    await end();
    await scratch.drop();
  }) as typeof pool.end;
  return { pool: withTransaction(pool) };
}
