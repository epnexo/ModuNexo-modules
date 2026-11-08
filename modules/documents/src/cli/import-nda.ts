import pg from "pg";
import { formatImportReport, importNda, parseImportArgs } from "../nda-import.ts";

async function main(): Promise<void> {
  const args = parseImportArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env or export it.");

  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    for (const line of formatImportReport(await importNda(pool, args.skillDir))) console.log(line);
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
