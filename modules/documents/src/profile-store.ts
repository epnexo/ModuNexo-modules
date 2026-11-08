import type { Queryable } from "../web/queries.ts";
import type { Profile } from "./profile.ts";

/** SQL for the owner profile: one row in `documents.settings`, enforced by the table. */

export async function getProfile(db: Queryable): Promise<Profile> {
  const { rows } = await db.query("select profile from documents.settings where id = 1");
  return (rows[0]?.profile as Profile | undefined) ?? {};
}

/** Apply a form save: `set` keys win, `remove` keys go, every other key stays. One statement, so it is atomic. */
export async function saveProfile(db: Queryable, change: { set: Profile; remove: string[] }): Promise<void> {
  await db.query(
    `insert into documents.settings as s (id, profile)
     values (1, $1::jsonb)
     on conflict (id) do update
       set profile = (s.profile - $2::text[]) || excluded.profile, updated_at = now()`,
    [JSON.stringify(change.set), change.remove],
  );
}

/**
 * Add the keys the profile does not have yet and leave the rest as it is (the import command uses this).
 * Returns the keys that were added; changes nothing, not even `updated_at`, when there are none.
 */
export async function addMissingProfileKeys(db: Queryable, values: Profile): Promise<string[]> {
  if (Object.keys(values).length === 0) return [];
  const { rows } = await db.query(
    `with prior as (select profile from documents.settings where id = 1)
     insert into documents.settings as s (id, profile)
     values (1, $1::jsonb)
     on conflict (id) do update
       set profile = excluded.profile || s.profile, updated_at = now()
       where s.profile <> excluded.profile || s.profile
     returning (select profile from prior) as before`,
    [JSON.stringify(values)],
  );
  if (!rows[0]) return [];
  const before = (rows[0].before as Profile | null) ?? {};
  return Object.keys(values).filter((key) => !Object.hasOwn(before, key));
}
