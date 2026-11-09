import { ImportInputError, importNdaFiles } from "../src/nda-import.ts";
import type { Transactional } from "../src/transaction.ts";
import { logFailure } from "./log.ts";
import { sameOrigin } from "./post.ts";

/** The three files of the skill together are about 50 KB; this leaves room and still refuses anything that is not them. */
const MAX_BODY_BYTES = 2_000_000;
const MAX_FILE_BYTES = 1_000_000;

export type ImportError = "missing-files" | "too-large" | "invalid-files" | "failed";

const back = (query: string): Response => new Response(null, { status: 303, headers: { location: `/documents/templates?${query}` } });
/** A failure goes back to the page that holds the form, where the owner can fix the files. */
const failed = (code: ImportError): Response => new Response(null, { status: 303, headers: { location: `/documents/templates/new?import_error=${code}` } });

async function textOf(value: FormDataEntryValue | null): Promise<string | "too-large" | null> {
  if (typeof value === "string" || value === null) return null;
  if (value.size > MAX_FILE_BYTES) return "too-large";
  return value.size === 0 ? null : await value.text();
}

/**
 * The "Import NDA" form: the owner picks the skill's own files (the platform has no skill folder to read), the NDA is
 * ported exactly as the explicit import does it, and the browser is sent back to the templates list with a short code
 * the page turns into a message. The database is asked for only after the request has passed the origin check. Nothing from the files, and no error text, ever goes into the address.
 */
export async function importNdaFromRequest(request: Request, db: () => Transactional): Promise<Response> {
  if (!sameOrigin(request.headers)) return Response.json({ error: "The request must come from this site." }, { status: 403 });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return failed("too-large");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return failed("missing-files");
  }
  const [templateHtml, configText, script] = await Promise.all([textOf(form.get("template")), textOf(form.get("config")), textOf(form.get("script"))]);
  if (templateHtml === "too-large" || configText === "too-large" || script === "too-large") return failed("too-large");
  if (templateHtml === null || configText === null || script === null) return failed("missing-files");
  try {
    const report = await importNdaFiles(db(), { templateHtml, configText, script });
    return back(`imported=${report.template.status}&profile=${report.profileAdded.length}`);
  } catch (error) {
    if (error instanceof ImportInputError) return failed("invalid-files");
    logFailure("could not import the NDA", error);
    return failed("failed");
  }
}
