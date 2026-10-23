import { getDb, publishEvent } from "@modunexo/sdk";

const MODULE = "contacts";
const LIST_LIMIT = 100;

export type ContactFields = { name: string; phone: string | null; email: string | null; identity: string | null; notes: string | null };
export type ContactRow = { id: number; name: string; phone: string | null; email: string | null; identity: string | null; notes: string | null; createdAt: Date; updatedAt: Date };
type RawContact = { id: string; name: string; phone: string | null; email: string | null; identity: string | null; notes: string | null; created_at: Date; updated_at: Date };

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** Postgres cannot store a NUL character in text, so it is refused here, as a bad request, instead of failing the write. */
export const hasNul = (value: string): boolean => value.includes("\u0000");

/** One optional text field: absent or blank is null; anything else must be a text within `max` characters without NUL. */
function optional(raw: unknown, field: string, max: number): Checked<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string" || hasNul(raw)) return { ok: false, error: `"${field}" must be a text.` };
  const value = raw.trim();
  if (value === "") return { ok: true, value: null };
  if (value.length > max) return { ok: false, error: `"${field}" must be at most ${max} characters.` };
  return { ok: true, value };
}

/** Checks what a form or a caller sends for a contact; the error names the first field that cannot be used. */
export function contactInput(raw: Record<string, unknown>): Checked<ContactFields> {
  const name = typeof raw.name === "string" && !hasNul(raw.name) ? raw.name.trim() : "";
  if (name === "" || name.length > 200) return { ok: false, error: '"name" must be a text of 1 to 200 characters.' };
  const phone = optional(raw.phone, "phone", 40);
  if (!phone.ok) return phone;
  const email = optional(raw.email, "email", 200);
  if (!email.ok) return email;
  if (email.value !== null && !email.value.includes("@")) return { ok: false, error: '"email" must be an address with an @.' };
  const identity = optional(raw.identity, "identity", 200);
  if (!identity.ok) return identity;
  const notes = optional(raw.notes, "notes", 4000);
  if (!notes.ok) return notes;
  return { ok: true, value: { name, phone: phone.value, email: email.value, identity: identity.value, notes: notes.value } };
}

const toRow = (row: RawContact): ContactRow => ({
  id: Number(row.id),
  name: row.name,
  phone: row.phone,
  email: row.email,
  identity: row.identity,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const COLUMNS = "id, name, phone, email, identity, notes, created_at, updated_at";
const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;

/** Stores a contact and announces `contact.created` in the same transaction. An identity another contact already has is refused. */
export async function createContact(fields: ContactFields): Promise<{ ok: true; id: number } | { ok: false; error: "identity_taken" }> {
  return getDb(MODULE).transaction(async (tx) => {
    const stored = await tx.query<{ id: string }>(
      "insert into contacts (name, phone, email, identity, notes) values ($1, $2, $3, $4, $5) on conflict (identity) do nothing returning id",
      [fields.name, fields.phone, fields.email, fields.identity, fields.notes],
    );
    if (stored.rows.length === 0) return { ok: false as const, error: "identity_taken" as const };
    const id = Number(stored.rows[0]!.id);
    await publishEvent(MODULE, "contact.created", { contactId: id }, { tx });
    return { ok: true as const, id };
  });
}

export async function updateContact(id: number, fields: ContactFields): Promise<{ ok: true } | { ok: false; error: "not_found" | "identity_taken" }> {
  try {
    return await getDb(MODULE).transaction(async (tx) => {
      if (fields.identity !== null) {
        const clash = await tx.query("select 1 from contacts where identity = $1 and id <> $2", [fields.identity, id]);
        if (clash.rows.length > 0) return { ok: false as const, error: "identity_taken" as const };
      }
      const updated = await tx.query(
        "update contacts set name = $2, phone = $3, email = $4, identity = $5, notes = $6, updated_at = clock_timestamp() where id = $1",
        [id, fields.name, fields.phone, fields.email, fields.identity, fields.notes],
      );
      return updated.rowCount === 0 ? { ok: false as const, error: "not_found" as const } : { ok: true as const };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: "identity_taken" };
    throw error;
  }
}

/** Removes the contact; its leads and their history go with it (the database cascades). Announces `contact.deleted`. */
export async function deleteContact(id: number): Promise<boolean> {
  return getDb(MODULE).transaction(async (tx) => {
    const removed = await tx.query("delete from contacts where id = $1", [id]);
    if (removed.rowCount === 0) return false;
    await publishEvent(MODULE, "contact.deleted", { contactId: id }, { tx });
    return true;
  });
}

export async function getContact(id: number): Promise<ContactRow | null> {
  const found = await getDb(MODULE).query<RawContact>(`select ${COLUMNS} from contacts where id = $1`, [id]);
  return found.rows[0] === undefined ? null : toRow(found.rows[0]);
}

export async function contactByIdentity(identity: string): Promise<ContactRow | null> {
  const found = await getDb(MODULE).query<RawContact>(`select ${COLUMNS} from contacts where identity = $1`, [identity]);
  return found.rows[0] === undefined ? null : toRow(found.rows[0]);
}

/** The newest `limit` (100 by default), or those whose name, phone, email or identity contain the search (case does not matter, no wildcards). */
export async function listContacts(search = "", limit = LIST_LIMIT): Promise<ContactRow[]> {
  const needle = search.trim().toLowerCase();
  const found = await getDb(MODULE).query<RawContact>(
    `select ${COLUMNS} from contacts
      where $1 = '' or strpos(lower(name), $1) > 0 or strpos(lower(coalesce(phone, '')), $1) > 0
         or strpos(lower(coalesce(email, '')), $1) > 0 or strpos(lower(coalesce(identity, '')), $1) > 0
      order by id desc limit $2`,
    [needle, limit],
  );
  return found.rows.map(toRow);
}
