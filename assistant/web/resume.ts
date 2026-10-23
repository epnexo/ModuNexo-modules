import { fieldsOf, idOf, readForm, redirect, refuse } from "../lib/form.ts";
import { conversationExists } from "../lib/inbox.ts";
import { resumeConversation } from "../lib/state.ts";

/** Lets the assistant answer in a conversation again. Pressing it for a conversation that is not stopped is harmless. The gate has already required `assistant.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const id = idOf(fieldsOf(form).conversationId);
  if (id === null) return refuse('"conversationId" must be a number.', 400);
  if (!(await conversationExists(id))) return refuse("No such conversation.", 404);
  await resumeConversation(id);
  return redirect("/assistant");
}
