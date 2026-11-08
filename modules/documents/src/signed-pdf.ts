import type { Queryable } from "../web/queries.ts";
import type { DocusealClient, DocusealError } from "./docuseal-client.ts";
import { pdfFileName } from "./file-store.ts";
import { getSigningState } from "./signature-store.ts";

/**
 * The signed PDF of a completed document, fetched from DocuSeal on demand and not stored. Like the /nda skill's
 * `descargar`, it lists the submission's documents and downloads the first; the client only fetches a URL on the
 * configured origin, and without the token.
 */

export type SignedPdfResult =
  | { ok: true; bytes: Uint8Array; fileName: string }
  | { ok: false; kind: "not-found" }
  | { ok: false; kind: "not-completed"; status: string }
  | { ok: false; kind: "not-configured" }
  | { ok: false; kind: "no-documents" }
  | { ok: false; kind: "docuseal"; error: DocusealError }
  /** The DocuSeal client itself failed unexpectedly (it should never throw). Not a database failure. */
  | { ok: false; kind: "docuseal-failed"; cause: unknown };

export interface SignedPdfDeps {
  db: Queryable;
  /** Null when signing is not configured. */
  docuseal: DocusealClient | null;
}

export async function fetchSignedPdf(deps: SignedPdfDeps, documentId: number): Promise<SignedPdfResult> {
  const state = await getSigningState(deps.db, documentId);
  if (state === null) return { ok: false, kind: "not-found" };
  if (state.status !== "completed" || state.docusealSubmissionId === null) return { ok: false, kind: "not-completed", status: state.status };
  if (deps.docuseal === null) return { ok: false, kind: "not-configured" };

  const docuseal = deps.docuseal;
  let listed;
  try {
    listed = await docuseal.listDocuments(state.docusealSubmissionId);
  } catch (cause) {
    return { ok: false, kind: "docuseal-failed", cause };
  }
  if (!listed.ok) return { ok: false, kind: "docuseal", error: listed.error };
  const first = listed.value[0];
  if (first === undefined) return { ok: false, kind: "no-documents" };

  let file;
  try {
    file = await docuseal.downloadDocument(first.url);
  } catch (cause) {
    return { ok: false, kind: "docuseal-failed", cause };
  }
  if (!file.ok) return { ok: false, kind: "docuseal", error: file.error };
  return { ok: true, bytes: file.value, fileName: pdfFileName(state.ref, state.counterpartyName).replace(/\.pdf$/, "-signed.pdf") };
}
