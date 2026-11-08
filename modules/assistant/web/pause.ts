import { fieldsOf, idOf, readForm, redirect, refuse } from "../lib/form.ts";
import { conversationExists } from "../lib/inbox.ts";
import { pauseConversation } from "../lib/state.ts";

/** Stops the assistant in one conversation, by hand. The gate has already required `assistant.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const id = idOf(fieldsOf(form).conversationId);
  if (id === null) return refuse('"conversationId" must be a number.', 400);
  if (!(await conversationExists(id))) return refuse("No such conversation.", 404);
  await pauseConversation(id, "manual");
  return redirect("/assistant");
}
