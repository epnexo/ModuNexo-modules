import { getDb } from "@modunexo/sdk";
import { docusealFromEnv } from "../src/docuseal-client.ts";
import { describeDocusealError, docusealCode } from "../src/docuseal-messages.ts";
import { parseDocumentId } from "../src/document-rules.ts";
import { type SignedPdfDeps, fetchSignedPdf } from "../src/signed-pdf.ts";
import { logFailure } from "./log.ts";

/**
 * `GET /documents/[id]/signed-pdf`: fetch the signed PDF from DocuSeal and pass it on. The id is parsed strictly. An unknown
 * id is a 404, a document that is not completed a 409, signing not set up a 503, a DocuSeal timeout a 504, any other DocuSeal
 * failure a 502, a database failure a 500. Each failure is logged by code only.
 */

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** A file name that is safe in a header: letters, digits, dot, hyphen and underscore. */
const headerName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "_") || "document-signed.pdf";

export async function downloadSignedPdf(deps: SignedPdfDeps, idParam: string): Promise<Response> {
  const id = parseDocumentId(idParam);
  if (id === null) return plain(404, "Not found");

  let result;
  try {
    result = await fetchSignedPdf(deps, id);
  } catch (error) {
    // The only things that can throw here are the database reads; a DocuSeal failure comes back as a result.
    logFailure("could not read the document from the database for the signed PDF", error);
    return plain(500, "The document could not be loaded.");
  }
  if (result.ok) {
    return new Response(result.bytes as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(result.bytes.length),
        "Content-Disposition": `attachment; filename="${headerName(result.fileName)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  switch (result.kind) {
    case "not-found":
      return plain(404, "Not found");
    case "not-completed":
      return plain(409, "This document has not been signed by everyone yet.");
    case "not-configured":
      logFailure("could not fetch the signed PDF", { code: docusealCode({ kind: "not-configured" }) });
      return plain(503, describeDocusealError({ kind: "not-configured" }));
    case "no-documents":
      logFailure("could not fetch the signed PDF", { code: "docuseal-no-documents" });
      return plain(502, "DocuSeal has no signed document for this request yet. Try again in a minute.");
    case "docuseal-failed":
      logFailure("DocuSeal failed unexpectedly while fetching the signed PDF", result.cause);
      return plain(502, "DocuSeal could not be used right now. Try again in a moment.");
    case "docuseal":
      logFailure("could not fetch the signed PDF", { code: docusealCode(result.error) });
      return plain(result.error.kind === "unreachable" && result.error.reason === "timeout" ? 504 : 502, describeDocusealError(result.error));
  }
}

/** Like `downloadSignedPdf`, but the dependencies are built inside the guard: a pool or an environment that cannot be set up still answers in plain text. */
export async function downloadSignedPdfWith(makeDeps: () => SignedPdfDeps, idParam: string): Promise<Response> {
  if (parseDocumentId(idParam) === null) return plain(404, "Not found");
  let deps: SignedPdfDeps;
  try {
    deps = makeDeps();
  } catch (error) {
    logFailure("could not set up the signed PDF download", error);
    return plain(500, "The signed PDF could not be fetched right now. Check the server log.");
  }
  return downloadSignedPdf(deps, idParam);
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return downloadSignedPdfWith(() => {
    const client = docusealFromEnv(process.env);
    return { db: getDb("documents"), docuseal: client.ok ? client.value : null };
  }, id);
}
