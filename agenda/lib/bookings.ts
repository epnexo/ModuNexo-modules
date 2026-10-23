import { getDb, publishEvent, type DbQueryable } from "@modunexo/sdk";
import { hasNul, type Checked } from "./check.ts";
import { slotsFor } from "./slots.ts";

const MODULE = "agenda";

export type BookingFields = { startsAt: Date; attendeeName: string; contactId: number | null; notes: string | null };
export type BookingRow = { id: number; startsAt: Date; endsAt: Date; status: "booked" | "cancelled"; attendeeName: string; contactId: number | null; notes: string | null };
type RawBooking = { id: string; starts_at: Date; ends_at: Date; status: "booked" | "cancelled"; attendee_name: string; contact_id: string | null; notes: string | null };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 instant that names its zone (`Z` or an offset); a bare local time is refused because it would be a guess. */
export function instantOf(raw: unknown): Date | null {
  if (typeof raw !== "string" || !ISO.test(raw)) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Checks what a form or the service API sends for a booking; the error names the first field that cannot be used. */
export function bookingInput(raw: Record<string, unknown>): Checked<BookingFields> {
  const startsAt = instantOf(raw.startsAt);
  if (startsAt === null) return { ok: false, error: '"startsAt" must be an ISO 8601 time with its zone, like 2026-10-26T09:00:00Z.' };
  const name = typeof raw.attendeeName === "string" && !hasNul(raw.attendeeName) ? raw.attendeeName.trim() : "";
  if (name === "" || name.length > 200) return { ok: false, error: '"attendeeName" must be a text of 1 to 200 characters.' };
  const rawContact = typeof raw.contactId === "number" ? String(raw.contactId) : typeof raw.contactId === "string" ? raw.contactId.trim() : "";
  if (rawContact !== "" && !/^\d{1,15}$/.test(rawContact)) return { ok: false, error: '"contactId" must be a number.' };
  if (raw.notes !== undefined && raw.notes !== null && (typeof raw.notes !== "string" || hasNul(raw.notes))) return { ok: false, error: '"notes" must be a text.' };
  const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";
  if (notes.length > 2000) return { ok: false, error: '"notes" must be at most 2000 characters.' };
  return { ok: true, value: { startsAt, attendeeName: name, contactId: rawContact === "" ? null : Number(rawContact), notes: notes === "" ? null : notes } };
}

const COLUMNS = "id, starts_at, ends_at, status, attendee_name, contact_id, notes";
const toRow = (row: RawBooking): BookingRow => ({ id: Number(row.id), startsAt: row.starts_at, endsAt: row.ends_at, status: row.status, attendeeName: row.attendee_name, contactId: row.contact_id === null ? null : Number(row.contact_id), notes: row.notes });

async function announce(tx: DbQueryable, row: BookingRow, change: "created" | "rescheduled" | "cancelled"): Promise<void> {
  await publishEvent(MODULE, "booking.updated", { bookingId: row.id, contactId: row.contactId, change, status: row.status, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() }, { tx });
}

/**
 * Every write that decides who holds a slot takes this lock first, so two requests for the same time (or for neighbours
 * inside the buffer) are decided one after the other against the bookings the previous one left.
 */
const lock = (tx: DbQueryable) => tx.query("select pg_advisory_xact_lock(hashtext('agenda.bookings'))");

/** Books a free slot for the attendee. Anything that is not a free slot (off the grid, closed, past, beyond the horizon, taken, inside a buffer) is `not_available`. */
export async function bookSlot(fields: BookingFields, now: Date = new Date()): Promise<{ ok: true; id: number } | { ok: false; error: "not_available" }> {
  return getDb(MODULE).transaction(async (tx) => {
    await lock(tx);
    const slot = (await slotsFor(tx, now)).find((candidate) => candidate.startsAt.getTime() === fields.startsAt.getTime());
    if (slot === undefined) return { ok: false as const, error: "not_available" as const };
    const made = await tx.query<RawBooking>(
      `insert into bookings (starts_at, ends_at, attendee_name, contact_id, notes) values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
      [slot.startsAt, slot.endsAt, fields.attendeeName, fields.contactId, fields.notes],
    );
    const row = toRow(made.rows[0]!);
    await announce(tx, row, "created");
    return { ok: true as const, id: row.id };
  });
}

export async function cancelBooking(id: number): Promise<{ ok: true; changed: boolean } | { ok: false; error: "not_found" }> {
  return getDb(MODULE).transaction(async (tx) => {
    await lock(tx);
    const found = await tx.query<RawBooking>(`select ${COLUMNS} from bookings where id = $1 for update`, [id]);
    if (found.rows[0] === undefined) return { ok: false as const, error: "not_found" as const };
    if (found.rows[0].status === "cancelled") return { ok: true as const, changed: false };
    const done = await tx.query<RawBooking>(`update bookings set status = 'cancelled', cancelled_at = clock_timestamp(), updated_at = clock_timestamp() where id = $1 returning ${COLUMNS}`, [id]);
    await announce(tx, toRow(done.rows[0]!), "cancelled");
    return { ok: true as const, changed: true };
  });
}

/** Moves a booked booking to another free slot; its own current slot counts as free for it. Asking for the slot it already has changes nothing. */
export async function rescheduleBooking(id: number, startsAt: Date, now: Date = new Date()): Promise<{ ok: true; changed: boolean } | { ok: false; error: "not_found" | "not_booked" | "not_available" }> {
  return getDb(MODULE).transaction(async (tx) => {
    await lock(tx);
    const found = await tx.query<RawBooking>(`select ${COLUMNS} from bookings where id = $1 for update`, [id]);
    const current = found.rows[0];
    if (current === undefined) return { ok: false as const, error: "not_found" as const };
    if (current.status !== "booked") return { ok: false as const, error: "not_booked" as const };
    const slot = (await slotsFor(tx, now, id)).find((candidate) => candidate.startsAt.getTime() === startsAt.getTime());
    if (slot === undefined) return { ok: false as const, error: "not_available" as const };
    if (slot.startsAt.getTime() === current.starts_at.getTime()) return { ok: true as const, changed: false };
    const moved = await tx.query<RawBooking>(`update bookings set starts_at = $2, ends_at = $3, updated_at = clock_timestamp() where id = $1 returning ${COLUMNS}`, [id, slot.startsAt, slot.endsAt]);
    await announce(tx, toRow(moved.rows[0]!), "rescheduled");
    return { ok: true as const, changed: true };
  });
}

export async function getBooking(id: number): Promise<BookingRow | null> {
  const found = await getDb(MODULE).query<RawBooking>(`select ${COLUMNS} from bookings where id = $1`, [id]);
  return found.rows[0] === undefined ? null : toRow(found.rows[0]);
}

/** The bookings that start in [from, to), oldest first, cancelled ones included. */
export async function weekBookings(from: Date, to: Date): Promise<BookingRow[]> {
  const found = await getDb(MODULE).query<RawBooking>(`select ${COLUMNS} from bookings where starts_at >= $1 and starts_at < $2 order by starts_at, id`, [from, to]);
  return found.rows.map(toRow);
}
