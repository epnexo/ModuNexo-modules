import { parseDocumentId } from "../src/document-rules.ts";
import { answer, handleForm } from "./post.ts";
import { signingDeps } from "./deps.ts";
import { refreshNavigation, submitRefreshWith } from "./submit-signature.ts";

/** Asks DocuSeal for the status of a sent document and stores it. The gate has already required `documents.write`. */
export const POST = (request: Request): Promise<Response> =>
  handleForm(request, async (fields) => {
    const state = await submitRefreshWith(signingDeps, fields);
    const { revalidate, redirectTo } = refreshNavigation(parseDocumentId(fields.documentId), state);
    if (redirectTo !== null) return answer({ redirectTo });
    // The page shows the stored status, so a refresh that wrote something and has nothing to say reloads it.
    return answer({ state }, { reload: revalidate !== null });
  });
