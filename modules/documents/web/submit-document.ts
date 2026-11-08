import { describeDbError } from "../src/db-error.ts";
import { createDocument } from "../src/create-document.ts";
import { type PdfEngine, describeRenderFailure } from "../src/pdf-engine.ts";
import { parseTemplateId } from "../src/template-rules.ts";
import type { Transactional } from "../src/transaction.ts";
import type { DocumentFormState, FormInput } from "./form-state.ts";
import { logFailure } from "./log.ts";

/** What the new-document form does with a submission, apart from reading FormData and navigating. */

export type DocumentOutcome = { state: DocumentFormState } | { redirectTo: string };

const UNAVAILABLE = "This template no longer exists or is archived.";
const FILE_ERROR = "The PDF could not be stored. Check that the documents folder exists and can be written to.";
const SETUP_ERROR = "The document service is not set up correctly. Details are in the server log.";
const FILE_CODES = new Set(["EACCES", "EPERM", "ENOSPC", "EROFS", "ENOENT", "ENOTDIR", "EISDIR", "EEXIST", "EMFILE", "EDQUOT"]);

export interface Deps {
  db: Transactional;
  engine: PdfEngine;
  dir: string;
}

export async function submitNewDocument(deps: Deps, raw: FormInput): Promise<DocumentOutcome> {
  const empty: DocumentFormState = { values: {}, errors: {} };
  const templateId = parseTemplateId(raw.templateId);
  if (templateId === null) return { state: { ...empty, message: UNAVAILABLE } };

  try {
    const result = await createDocument(deps, { templateId, fields: raw });
    if (result.ok) return { redirectTo: `/documents/${result.id}?created=1` };
    if (result.kind === "invalid") return { state: { values: result.values, errors: result.errors } };
    if (result.kind === "template-unavailable") return { state: { ...empty, message: UNAVAILABLE } };
    if (result.kind === "unfilled") {
      logFailure("a document template has markers without a value", { code: `${result.markers.length} markers` });
      return { state: { values: entered(raw), errors: {}, message: `The template uses markers that have no value: ${result.markers.slice(0, 5).join(", ")}. Fill them in the template or the owner profile and try again.` } };
    }
    logFailure("could not render a document", { code: result.reason });
    return { state: { values: entered(raw), errors: {}, message: describeRenderFailure(result.reason) } };
  } catch (error) {
    logFailure("could not create a document", error);
    const code = (error as { code?: unknown } | null)?.code;
    const message = typeof code === "string" && FILE_CODES.has(code) ? FILE_ERROR : describeDbError(error).message;
    return { state: { values: entered(raw), errors: {}, message } };
  }
}

/**
 * Like `submitNewDocument`, but the dependencies are built here, inside the guard: the pool, the engine and the documents
 * folder come from the environment and the working directory, so a server started from an unexpected place must still
 * answer on the form instead of failing the action.
 */
export async function submitNewDocumentWith(makeDeps: () => Deps | Promise<Deps>, raw: FormInput): Promise<DocumentOutcome> {
  let deps: Deps;
  try {
    deps = await makeDeps();
  } catch (error) {
    logFailure("could not set up the document service", error);
    const described = describeDbError(error);
    return { state: { values: entered(raw), errors: {}, message: described.kind === "not-configured" ? described.message : SETUP_ERROR } };
  }
  return submitNewDocument(deps, raw);
}

/** What was typed, to show again after a failure that is not about a field. The template id and other plumbing are left out. */
function entered(raw: FormInput): Record<string, string> {
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "templateId"));
}
