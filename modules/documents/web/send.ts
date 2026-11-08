import { answer, handleForm } from "./post.ts";
import { signingDeps } from "./deps.ts";
import { submitSendWith } from "./submit-signature.ts";

/** Sends a document to be signed. The gate has already required `documents.send`. */
export const POST = (request: Request): Promise<Response> => handleForm(request, async (fields) => answer(await submitSendWith(signingDeps, fields)));
