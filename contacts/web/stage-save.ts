import { fieldsOf, idOf, readForm, redirect, refuse } from "../lib/form.ts";
import { addStage, renameStage, stageName } from "../lib/pipeline.ts";

/** Adds a stage, or renames the one named by `id`. The gate has already required `contacts.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const fields = fieldsOf(form);
  const name = stageName(fields.name);
  if (!name.ok) return refuse(name.error, 400);
  if (fields.id === undefined || fields.id.trim() === "") {
    await addStage(name.value);
    return redirect("/pipeline");
  }
  const id = idOf(fields.id);
  if (id === null) return refuse('"id" must be a number.', 400);
  const renamed = await renameStage(id, name.value);
  return renamed.ok ? redirect("/pipeline") : refuse("No such stage.", 404);
}
