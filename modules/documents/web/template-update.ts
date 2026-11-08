import { getDb } from "@modunexo/sdk";
import { answer, handleForm } from "./post.ts";
import { submitTemplateUpdate } from "./submit.ts";

/** The edit-template form. The gate has already required `documents.write`. */
export const POST = (request: Request): Promise<Response> => handleForm(request, async (fields) => answer(await submitTemplateUpdate(getDb("documents"), fields)));
