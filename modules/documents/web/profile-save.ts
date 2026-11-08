import { getDb } from "@modunexo/sdk";
import { answer, handleForm } from "./post.ts";
import { submitProfile } from "./submit.ts";

/** The owner-profile form. The gate has already required `documents.write`. */
export const POST = (request: Request): Promise<Response> => handleForm(request, async (fields) => answer({ state: await submitProfile(getDb("documents"), fields) }));
