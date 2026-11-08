import { getDb } from "@modunexo/sdk";
import { answer, handleForm } from "./post.ts";
import { submitArchive } from "./submit.ts";

/** The archive-template button. The gate has already required `documents.write`. */
export const POST = (request: Request): Promise<Response> => handleForm(request, async (fields) => answer(await submitArchive(getDb("documents"), fields)));
