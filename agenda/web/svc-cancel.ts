import { cancelBooking } from "../lib/bookings.ts";
import { idOf, refuse } from "../lib/form.ts";
import { readJson } from "../lib/service.ts";

/** Service API: cancels a booking. Needs the scope `bookings.write`. */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const id = idOf(body.id);
  if (id === null) return refuse('"id" must be a number.', 400);
  const done = await cancelBooking(id);
  return done.ok ? Response.json({ ok: true, changed: done.changed }) : refuse("not_found", 404);
}
