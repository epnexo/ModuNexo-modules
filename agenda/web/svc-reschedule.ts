import { instantOf, rescheduleBooking } from "../lib/bookings.ts";
import { now } from "../lib/clock.ts";
import { idOf, refuse } from "../lib/form.ts";
import { readJson } from "../lib/service.ts";

/** Service API: moves a booking to another free slot. Needs the scope `bookings.write`. */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const id = idOf(body.id);
  if (id === null) return refuse('"id" must be a number.', 400);
  const startsAt = instantOf(body.startsAt);
  if (startsAt === null) return refuse('"startsAt" must be an ISO 8601 time with its zone, like 2026-10-26T09:00:00Z.', 400);
  const moved = await rescheduleBooking(id, startsAt, now());
  if (moved.ok) return Response.json({ ok: true, changed: moved.changed });
  if (moved.error === "not_found") return refuse("not_found", 404);
  return refuse(moved.error === "not_booked" ? "not_booked" : "not_available", 409);
}
