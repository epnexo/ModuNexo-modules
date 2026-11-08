import { cancelBooking } from "../lib/bookings.ts";
import { fieldsOf, idOf, readForm, redirect, refuse } from "../lib/form.ts";

/** Cancels a booking. The gate has already required `agenda.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const id = idOf(fieldsOf(form).id);
  if (id === null) return refuse('"id" must be a number.', 400);
  const done = await cancelBooking(id);
  return done.ok ? redirect("/agenda") : refuse("No such booking.", 404);
}
