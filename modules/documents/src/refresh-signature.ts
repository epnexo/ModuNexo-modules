import type { Queryable } from "../web/queries.ts";
import { logFailure } from "../web/log.ts";
import type { DocusealClient, DocusealError } from "./docuseal-client.ts";
import { docusealCode } from "./docuseal-messages.ts";
import { type SignatureStatus, completionTime, mapSubmissionStatus, mergeStoredSigners, safeReported } from "./signature-status.ts";
import { applyRefresh, getSigningState } from "./signature-store.ts";

/**
 * Read a sent document's submission from DocuSeal and update its status, completion time and each signer's status.
 * On demand only: no polling, no job. A status the platform does not know changes nothing and comes back for a note.
 */

export type RefreshResult =
  /** `signersChanged` says whether any signer's status or time moved, whether or not the document status did. */
  | { ok: true; outcome: "updated" | "unchanged"; status: SignatureStatus; signersChanged: boolean }
  /** DocuSeal reported a status the platform does not know: nothing was changed. `reported` is safe to show. */
  | { ok: true; outcome: "unknown"; reported: string }
  | { ok: false; kind: "not-configured" }
  | { ok: false; kind: "not-found" }
  | { ok: false; kind: "not-sent"; status: string }
  | { ok: false; kind: "docuseal"; error: DocusealError }
  /** The row changed while DocuSeal was being asked. */
  | { ok: false; kind: "stale" };

export interface RefreshDeps {
  db: Queryable;
  /** Null when signing is not configured. */
  docuseal: DocusealClient | null;
  now?: () => Date;
}

export async function refreshSignature(deps: RefreshDeps, documentId: number): Promise<RefreshResult> {
  if (deps.docuseal === null) return { ok: false, kind: "not-configured" };
  const state = await getSigningState(deps.db, documentId);
  if (state === null) return { ok: false, kind: "not-found" };
  if (state.status !== "sent" || state.docusealSubmissionId === null) return { ok: false, kind: "not-sent", status: state.status };

  const submission = await deps.docuseal.getSubmission(state.docusealSubmissionId);
  if (!submission.ok) {
    logFailure("could not refresh a signature status", { code: docusealCode(submission.error) });
    return { ok: false, kind: "docuseal", error: submission.error };
  }

  const status = mapSubmissionStatus(submission.value.status);
  if (status === null) {
    logFailure("DocuSeal reported a status that is not known", { code: "unknown-status" });
    return { ok: true, outcome: "unknown", reported: safeReported(submission.value.status) };
  }
  const completedAt = status === "completed" ? (completionTime(submission.value.completedAt, submission.value.signers) ?? (deps.now ?? (() => new Date()))()) : null;
  const merged = mergeStoredSigners(state.storedLinks, submission.value.signers);
  const applied = await applyRefresh(deps.db, documentId, { submissionId: state.docusealSubmissionId, status, completedAt, links: merged.value });
  if (applied === "stale") return { ok: false, kind: "stale" };
  return { ok: true, outcome: status === state.status ? "unchanged" : "updated", status, signersChanged: merged.changed };
}
