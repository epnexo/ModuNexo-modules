import pg from "pg";
import type { Transactional } from "../transaction.ts";
import { formatImportReport, importNda, parseImportArgs } from "../nda-import.ts";

/**
 * This command runs outside the platform, against a database you point it at, so it cannot use `getDb`. It gives the
 * stores the same shape `getDb` has: `query`, and `transaction` on one connection.
 */
function transactional(pool: pg.Pool): Transactional {
  const query: Transactional["query"] = async (text, values) => {
    const result = await pool.query(text, values);
    return { rows: result.rows };
  };
  return {
    query,
    async transaction(run) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const done = await run({ query: async (sql, params) => ({ rows: (await client.query(sql, params as unknown[])).rows, rowCount: 0 }) });
        await client.query("commit");
        return done;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function main(): Promise<void> {
  const args = parseImportArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env or export it.");

  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    for (const line of formatImportReport(await importNda(transactional(pool), args.skillDir))) console.log(line);
  } catch (error) {
    // 3F000: invalid schema name, 42P01: undefined table. Both mean the module was never migrated.
    const code = (error as { code?: string }).code;
    if (code === "3F000" || code === "42P01") throw new Error("the documents schema is missing; run `npm run db:migrate` first", { cause: error });
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
