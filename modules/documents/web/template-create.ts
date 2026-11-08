import { getDb } from "@modunexo/sdk";
import { answer, handleForm } from "./post.ts";
import { submitNewTemplate } from "./submit.ts";

/** The new-template form. The gate has already required `documents.write`. */
export const POST = (request: Request): Promise<Response> => handleForm(request, async (fields) => answer(await submitNewTemplate(getDb("documents"), fields)));
