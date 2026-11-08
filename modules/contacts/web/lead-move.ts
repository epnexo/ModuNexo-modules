import { fieldsOf, idOf, readForm, redirect, refuse } from "../lib/form.ts";
import { moveLead } from "../lib/pipeline.ts";

/** Moves a lead to a stage. The gate has already required `contacts.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const fields = fieldsOf(form);
  const leadId = idOf(fields.leadId);
  if (leadId === null) return refuse('"leadId" must be a number.', 400);
  const stageId = idOf(fields.stageId);
  if (stageId === null) return refuse('"stageId" must be a number.', 400);
  const moved = await moveLead(leadId, stageId);
  if (moved.ok) return redirect("/pipeline");
  return refuse(moved.error === "lead_not_found" ? "No such lead." : "No such stage.", 404);
}
