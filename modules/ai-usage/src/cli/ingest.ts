import pg from "pg";
import { createCollectors } from "../collectors/index.ts";
import { ingest } from "../ingest.ts";
import { parseIngestArgs } from "./args.ts";

const fmt = (n: number) => n.toLocaleString("en-US");

async function main(): Promise<void> {
  const args = parseIngestArgs(process.argv.slice(2), process.env);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env or export it.");

  const collectors = createCollectors({ claudeDir: args.claudeDir, codexDir: args.codexDir, piDir: args.piDir, opencodeDir: args.opencodeDir }).filter((c) => !args.tool || c.toolId === args.tool);
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    for (const report of await ingest(pool, collectors)) {
      console.log(
        `${report.tool}: files scanned ${fmt(report.filesScanned)}, skipped unchanged ${fmt(report.filesSkipped)}, files failed ${fmt(report.filesFailed)}, ` +
          `sessions inserted ${fmt(report.sessionsInserted)}, events inserted ${fmt(report.eventsInserted)}, ` +
          `tokens inserted ${fmt(report.tokensInserted)}, tokens in database ${fmt(report.tokensInDatabase)}`,
      );
      // Failed files are named by tool and path hash prefix only, never by path.
      for (const failed of report.failedFiles) console.log(`  failed: ${failed.id} (${failed.reason})`);
      if (report.filesFailed > 0) process.exitCode = 1;
    }
  } catch (error) {
    // 3F000: invalid schema name, 42P01: undefined table. Both mean the module was never migrated.
    const code = (error as { code?: string }).code;
    if (code === "3F000" || code === "42P01") throw new Error("the ai_usage schema is missing; run `npm run db:migrate` first", { cause: error });
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
