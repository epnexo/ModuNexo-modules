import { configInput, saveConfig } from "../lib/config.ts";
import { fieldsOf, readForm, redirect, refuse } from "../lib/form.ts";

/** Saves the behaviour settings: on or off, the instructions, the wait, the history and the limit. The gate has already required `assistant.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const checked = configInput(fieldsOf(form));
  if (!checked.ok) return refuse(checked.error, 400);
  await saveConfig(checked.value);
  return redirect("/assistant/settings");
}
