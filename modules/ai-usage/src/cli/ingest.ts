import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createCollectors } from "../collectors/index.ts";
import { ingest } from "../ingest.ts";
import { send } from "../remote-sender.ts";
import { HELP, parseIngestArgs } from "./args.ts";
import { defaultConfigPath, loadConfig, resolveSending, trustCertificateAuthority } from "./config.ts";
import { terminalPrompter } from "./prompt.ts";
import { runSetup } from "./setup.ts";

const fmt = (n: number) => n.toLocaleString("en-US");

/** Sends instead of writing to a database: needs only the platform address and a token with the scope `ai_usage.write`. */
async function sendToPlatform(url: string, token: string | undefined, stateFile: string | undefined, collectors: ReturnType<typeof createCollectors>): Promise<void> {
  if (!token) throw new Error("There is no token. Run this command with --setup, or export AI_USAGE_TOKEN with a service token that holds the scope ai_usage.write.");
  const file = stateFile ?? join(homedir(), ".config", "ai-usage", "state.json");
  for (const report of await send(collectors, { url, token, stateFile: file })) {
    console.log(
      `${report.tool}: files scanned ${fmt(report.filesScanned)}, skipped unchanged ${fmt(report.filesSkipped)}, files failed ${fmt(report.filesFailed)}, ` +
        `sessions inserted ${fmt(report.sessionsInserted)}, events inserted ${fmt(report.eventsInserted)}, tokens inserted ${fmt(report.tokensInserted)}`,
    );
    for (const failed of report.failedFiles) console.log(`  failed: ${failed.id} (${failed.reason})`);
    if (report.filesFailed > 0) process.exitCode = 1;
  }
}

/** Shows what the logs hold, so you can see what a real run would send. Nothing leaves the machine. */
async function dryRun(collectors: ReturnType<typeof createCollectors>): Promise<void> {
  for (const report of await send(collectors, { url: "http://dry-run.invalid", token: "", stateFile: "", dryRun: true })) {
    console.log(`${report.tool}: files found ${fmt(report.filesScanned)}, sessions ${fmt(report.sessionsInserted)}, events ${fmt(report.eventsInserted)}, tokens ${fmt(report.tokensInserted)} (dry run: nothing sent)`);
    for (const failed of report.failedFiles) console.log(`  failed: ${failed.id} (${failed.reason})`);
  }
}

async function main(): Promise<void> {
  const args = parseIngestArgs(process.argv.slice(2), process.env);
  if (args.help) {
    console.log(HELP);
    return;
  }
  const configPath = args.configFile ?? defaultConfigPath();
  if (args.setup) {
    await runSetup({ path: configPath, prompter: terminalPrompter(), current: { ...loadConfig(configPath), ...(args.url !== undefined ? { url: args.url } : {}) }, log: (line) => console.log(line) });
    return;
  }
  const collectors = createCollectors({ claudeDir: args.claudeDir, codexDir: args.codexDir, piDir: args.piDir, opencodeDir: args.opencodeDir }).filter((c) => !args.tool || c.toolId === args.tool);
  if (args.dryRun) return dryRun(collectors);
  const sending = resolveSending(args, process.env, loadConfig(configPath));
  if (sending.url !== undefined) {
    if (sending.caFile !== undefined) trustCertificateAuthority(sending.caFile);
    return sendToPlatform(sending.url, sending.token, args.stateFile, collectors);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env or export it.");
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
