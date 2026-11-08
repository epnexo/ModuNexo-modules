import { getDb } from "@modunexo/sdk";
import { answer, handleForm } from "./post.ts";
import { submitClearSendWith } from "./submit-signature.ts";

/** Clears a send that never finished, so the document can be sent again. The gate has already required `documents.send`. */
export const POST = (request: Request): Promise<Response> => handleForm(request, async (fields) => answer(await submitClearSendWith(() => ({ db: getDb("documents") }), fields)));
