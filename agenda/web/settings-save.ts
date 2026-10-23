import { fieldsOf, readForm, redirect, refuse } from "../lib/form.ts";
import { saveSettings, settingsInput } from "../lib/settings.ts";

/** Saves the zone, the slot, the buffer, the horizon and the weekly hours together. The gate has already required `agenda.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const checked = settingsInput(fieldsOf(form));
  if (!checked.ok) return refuse(checked.error, 400);
  await saveSettings(checked.value.settings, checked.value.hours);
  return redirect("/agenda/settings");
}
