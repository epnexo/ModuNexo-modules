import { bookSlot, bookingInput } from "../lib/bookings.ts";
import { now } from "../lib/clock.ts";
import { NOT_AVAILABLE, agendaAt, fieldsOf, readForm, redirect, refuse } from "../lib/form.ts";
import { loadSettings } from "../lib/settings.ts";

/** The booking form. The gate has already required `agenda.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const checked = bookingInput(fieldsOf(form));
  if (!checked.ok) return refuse(checked.error, 400);
  const made = await bookSlot(checked.value, now());
  if (!made.ok) return refuse(NOT_AVAILABLE, 409);
  return redirect(agendaAt(checked.value.startsAt, (await loadSettings()).timezone));
}
