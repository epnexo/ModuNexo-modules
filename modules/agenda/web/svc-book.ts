import { bookSlot, bookingInput } from "../lib/bookings.ts";
import { now } from "../lib/clock.ts";
import { refuse } from "../lib/form.ts";
import { readJson } from "../lib/service.ts";

/** Service API: books a free slot. Needs the scope `bookings.write`. Answers 201 with the booking, 409 `not_available` for a time that is not free. */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const checked = bookingInput(body);
  if (!checked.ok) return refuse(checked.error, 400);
  const made = await bookSlot(checked.value, now());
  if (!made.ok) return refuse("not_available", 409);
  return Response.json({ id: made.id, startsAt: made.startsAt.toISOString(), endsAt: made.endsAt.toISOString() }, { status: 201 });
}
