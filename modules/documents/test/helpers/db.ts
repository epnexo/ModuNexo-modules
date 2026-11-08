import { fileURLToPath } from "node:url";
import { Registry, coreManifest, discoverModules, migrate } from "@epnexo/core";
import { openTestPool, resolveTestDatabaseUrl } from "@epnexo/core/testing";
import type pg from "pg";

const modulesDir = fileURLToPath(new URL("../../..", import.meta.url));

/** Environment whose test database is `<name>_<suffix>_test`, so each test file of the module gets its own database. */
export function testEnv(suffix: string): NodeJS.ProcessEnv {
  const base = resolveTestDatabaseUrl();
  if (!base) return process.env;
  const url = new URL(base);
  url.pathname = url.pathname.replace(/_test$/, `_${suffix}_test`);
  return { ...process.env, TEST_DATABASE_URL: url.toString() };
}

/** A pool on a fresh `documents` schema with every migration applied, or the reason there is none. */
export async function openMigratedPool(suffix: string): Promise<{ pool?: pg.Pool; skipReason?: string }> {
  const { pool, skipReason } = await openTestPool(testEnv(suffix));
  if (!pool) return { skipReason };
  await pool.query("drop schema if exists documents cascade");
  const tracking = await pool.query("select to_regclass('core.schema_migrations') is not null as present");
  if (tracking.rows[0].present) await pool.query("delete from core.schema_migrations where module_id = 'documents'");
  const registry = new Registry();
  registry.register(coreManifest);
  for (const manifest of await discoverModules(modulesDir)) registry.register(manifest);
  await migrate(pool, registry);
  return { pool };
}
