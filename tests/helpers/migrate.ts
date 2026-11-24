import { moduleRolesFor } from "@modunexo/core/data";
import { migrate as migrateCore } from "@modunexo/core/runner";

/**
 * `migrate` as the platform runs it: each module gets its own database login, owns its schema and runs its migrations on
 * it. Without the roles the schema belongs to the platform user and the module's login cannot see it, which is not what
 * a module meets in production.
 */
export const migrate = (...[pool, registry, options]: Parameters<typeof migrateCore>): ReturnType<typeof migrateCore> =>
  migrateCore(pool, registry, { moduleRoles: moduleRolesFor(pool), ...options });
