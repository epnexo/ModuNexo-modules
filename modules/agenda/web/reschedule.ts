import { instantOf, rescheduleBooking } from "../lib/bookings.ts";
import { now } from "../lib/clock.ts";
import { NOT_AVAILABLE, NOT_BOOKED, agendaAt, fieldsOf, idOf, readForm, redirect, refuse } from "../lib/form.ts";
import { loadSettings } from "../lib/settings.ts";

/** Moves a booking to another free slot. The gate has already required `agenda.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const fields = fieldsOf(form);
  const id = idOf(fields.id);
  if (id === null) return refuse('"id" must be a number.', 400);
  const startsAt = instantOf(fields.startsAt);
  if (startsAt === null) return refuse('"startsAt" must be an ISO 8601 time with its zone, like 2026-10-26T09:00:00Z.', 400);
  const moved = await rescheduleBooking(id, startsAt, now());
  if (moved.ok) return redirect(agendaAt(startsAt, (await loadSettings()).timezone));
  if (moved.error === "not_found") return refuse("No such booking.", 404);
  return refuse(moved.error === "not_booked" ? NOT_BOOKED : NOT_AVAILABLE, 409);
}
