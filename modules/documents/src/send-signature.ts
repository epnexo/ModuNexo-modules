import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { logFailure } from "../web/log.ts";
import { MAX_TIMEOUT_MS, type DocusealClient, type DocusealError, type DocusealResult } from "./docuseal-client.ts";
import { docusealCode } from "./docuseal-messages.ts";
import { hasStoredPdf } from "./document-store.ts";
import { checkSignatureLayout } from "./signature-layout.ts";
import { buildTemplateUpdate, roleNames, templateNameForPdf } from "./signature-payload.ts";
import { validateSigners } from "./signature-rules.ts";
import { type SigningLink, claimSend, clearSendMark, lockDocumentForSigning, recordSubmission, releaseSend } from "./signature-store.ts";
import type { Queryable } from "../web/queries.ts";
import { type Transactional, inTransaction } from "./transaction.ts";

/**
 * Send a generated document for signature, the way the /nda skill does in manual mode: the owner has uploaded the PDF
 * to DocuSeal under its own name; this finds that template, places the four boxes from the stored coordinates, creates
 * the submission without email and stores the links.
 *
 * One document must never end with two DocuSeal submissions, and a submission DocuSeal accepted must never be lost
 * silently. DocuSeal's calls take time and the row lock cannot be held across them, so the send is a mark instead:
 *
 *  1. In one short transaction the row is locked, checked, and marked (`send_started_at`); the transaction commits.
 *     From then on any other send of this document is refused ("unfinished") without calling DocuSeal.
 *  2. DocuSeal is asked, with no database lock held.
 *  3. The mark ends in one of three ways: recorded (the submission, its links and `status = sent` are written in the
 *     same statement that clears the mark); cleared, because DocuSeal is known not to have created a submission; or
 *     kept, because it may have. A kept mark makes the page show an unfinished send, and only the owner's explicit
 *     action clears it, after checking DocuSeal. Nothing sends again by itself.
 *
 * If DocuSeal accepts the submission but the write fails, the write is tried once more (it is safe to repeat, and also
 * settles a write whose answer was lost). If that fails too, or the document no longer matches, the ids go to the
 * server log, never the emails or links, the mark stays, and the result says the submission exists in DocuSeal but is
 * not recorded. Nothing is archived or deleted in DocuSeal.
 */

export type SendStep = "find" | "read" | "fields" | "submission";

export type SendResult =
  | { ok: true; submissionId: number }
  | { ok: false; kind: "not-configured" }
  | { ok: false; kind: "invalid"; errors: Record<string, string>; values: Record<string, string> }
  | { ok: false; kind: "not-found" }
  | { ok: false; kind: "already-sent" }
  | { ok: false; kind: "wrong-status"; status: string }
  | { ok: false; kind: "not-ready"; reason: string }
  | { ok: false; kind: "not-uploaded"; fileName: string }
  | { ok: false; kind: "docuseal"; step: SendStep; error: DocusealError }
  /** A send of this document is running, or one started earlier and did not finish: nothing was called. */
  | { ok: false; kind: "unfinished" }
  /** DocuSeal may or may not have created the submission: the document stays marked as an unfinished send. */
  | { ok: false; kind: "outcome-unknown"; error: DocusealError }
  /** DocuSeal made the submission but the platform could not save it. The ids are in the server log. */
  | { ok: false; kind: "unrecorded"; submissionId: number };

/**
 * The longest a send can still be running after its mark was written. One send makes four sequential DocuSeal calls
 * (find the template, read it, place the fields, create the submission), each under the client's time limit, which is
 * never above `MAX_TIMEOUT_MS` whatever is configured; the rest is margin for the database steps around them and for
 * clock differences. The owner's clear is refused until a mark is older than this.
 */
export const SEND_CALLS = 4;
export const SEND_MAX_DURATION_MS = SEND_CALLS * MAX_TIMEOUT_MS + 60_000;

export interface SendDeps {
  db: Transactional;
  /** Null when signing is not configured. */
  docuseal: DocusealClient | null;
  newUuid?: () => string;
}

interface Accepted {
  templateId: number;
  submissionId: number;
  links: SigningLink[];
}

/** A refusal that leaves no doubt that DocuSeal created nothing. Anything else at the submission step may have been applied. */
const NOTHING_CREATED = new Set<DocusealError["kind"]>(["not-configured", "unauthorized", "not-found", "rejected", "refused-url"]);

export async function sendForSignature(deps: SendDeps, documentId: number, raw: Record<string, string | undefined>): Promise<SendResult> {
  const { docuseal } = deps;
  if (docuseal === null) return { ok: false, kind: "not-configured" };
  const signers = validateSigners(raw);
  if (!signers.ok) return { ok: false, kind: "invalid", errors: signers.errors, values: signers.values };
  const newUuid = deps.newUuid ?? randomUUID;

  const claim = await inTransaction(deps.db, async (tx) => {
    const row = await lockDocumentForSigning(tx, documentId);
    if (row === null) return { ok: false, kind: "not-found" } as const;
    if (row.docusealSubmissionId !== null) return { ok: false, kind: "already-sent" } as const;
    if (row.status !== "generated") return { ok: false, kind: "wrong-status", status: row.status } as const;
    if (row.sendStartedAt !== null) return { ok: false, kind: "unfinished" } as const;
    if (!hasStoredPdf(row.pdfPath)) return { ok: false, kind: "not-ready", reason: "This document has no PDF." } as const;
    const layout = checkSignatureLayout(row.signatureFields);
    if (!layout.ok) return { ok: false, kind: "not-ready", reason: layout.reason } as const;
    const claimed = await claimSend(tx, documentId);
    if (claimed === null) return { ok: false, kind: "unfinished" } as const;
    return { ok: true, claimed, row, pdfPath: row.pdfPath, fields: layout.fields } as const;
  });
  if (!claim.ok) return claim;
  const { claimed, row, pdfPath, fields } = claim;

  /** Give the mark back, only when nothing was created. A failure here leaves the mark, which is the safe side. */
  const release = async () => {
    try {
      await releaseSend(deps.db, documentId, claimed);
    } catch (error) {
      logFailure("could not clear the send mark", error, `document=${documentId}`);
    }
  };
  const stepFailed = async <T>(step: SendStep, result: DocusealResult<T>): Promise<SendResult | null> => {
    if (result.ok) return null;
    logFailure(`DocuSeal ${step} failed`, { code: docusealCode(result.error) });
    await release();
    return { ok: false, kind: "docuseal", step, error: result.error };
  };

  let asking = false;
  let created: DocusealResult<{ submissionId: number; submitters: { role: string; link: string }[] }>;
  let templateId: number;
  const { owner, counterparty, order } = signers.value;
  const roles = roleNames(row.profile.A_CORTO || row.profile.A_NOMBRE, row.counterpartyName);
  try {
    const found = await docuseal.findTemplateByName(templateNameForPdf(pdfPath));
    const findFailure = await stepFailed("find", found);
    if (findFailure) return findFailure;
    if (!found.ok || found.value === null) {
      await release();
      return { ok: false, kind: "not-uploaded", fileName: basename(pdfPath) };
    }
    templateId = found.value.id;

    const template = await docuseal.getTemplate(templateId);
    const readFailure = await stepFailed("read", template);
    if (readFailure || !template.ok) return readFailure!;

    const built = buildTemplateUpdate({ fields, attachmentUuid: template.value.attachmentUuid, existingSubmitterUuids: template.value.submitterUuids, ownerRole: roles.owner, counterpartyRole: roles.counterparty, newUuid });
    if (!built.ok) {
      await release();
      return { ok: false, kind: "not-ready", reason: built.reason };
    }
    const updated = await docuseal.updateTemplate(templateId, built.update);
    const fieldsFailure = await stepFailed("fields", updated);
    if (fieldsFailure) return fieldsFailure;

    asking = true;
    created = await docuseal.createSubmission({
      templateId,
      order,
      submitters: [
        { role: roles.owner, name: owner.name, email: owner.email },
        { role: roles.counterparty, name: counterparty.name, email: counterparty.email },
      ],
    });
  } catch (error) {
    // Before the submission was asked for nothing exists in DocuSeal; once it was asked for, it may.
    if (!asking) await release();
    throw error;
  }

  if (!created.ok) {
    logFailure("DocuSeal submission failed", { code: docusealCode(created.error) });
    if (NOTHING_CREATED.has(created.error.kind)) {
      await release();
      return { ok: false, kind: "docuseal", step: "submission", error: created.error };
    }
    logFailure("signature may have been created by DocuSeal", { code: "outcome-unknown" }, `document=${documentId} template=${templateId}`);
    return { ok: false, kind: "outcome-unknown", error: created.error };
  }

  const submissionId = created.value.submissionId;
  const linkFor = (role: string) => created.value.submitters.find((submitter) => submitter.role === role)?.link;
  const ownerLink = linkFor(roles.owner);
  const counterpartyLink = linkFor(roles.counterparty);
  if (ownerLink === undefined || counterpartyLink === undefined) {
    // DocuSeal made the submission but its answer does not match the request: it cannot be stored as it is.
    return unrecorded(documentId, templateId, submissionId, "answer without a submitter for each requested role");
  }
  const accepted: Accepted = {
    templateId,
    submissionId,
    links: [
      { role: roles.owner, name: owner.name, email: owner.email, link: ownerLink },
      { role: roles.counterparty, name: counterparty.name, email: counterparty.email, link: counterpartyLink },
    ],
  };

  for (const attempt of [1, 2]) {
    try {
      const outcome = await recordSubmission(deps.db, documentId, claimed, accepted);
      if (outcome === "recorded") return { ok: true, submissionId };
      return unrecorded(documentId, templateId, submissionId, "the document no longer matches");
    } catch (error) {
      logFailure(attempt === 1 ? "could not record a signature request" : "could not record a signature request again", error);
    }
  }
  return unrecorded(documentId, templateId, submissionId, "the write failed twice");
}

/** DocuSeal holds a submission the platform does not have: leave the ids in the log, keep the mark, say so. */
function unrecorded(documentId: number, templateId: number, submissionId: number, why: string): SendResult {
  logFailure("signature accepted by DocuSeal but not recorded", { code: "unrecorded" }, `document=${documentId} template=${templateId} submission=${submissionId} (${why})`);
  return { ok: false, kind: "unrecorded", submissionId };
}

/** The owner's explicit action on a document that shows an unfinished send, taken after checking DocuSeal. */
export async function clearUnfinishedSend(db: Queryable, documentId: number): Promise<"cleared" | "nothing-to-clear" | { result: "too-early"; waitMs: number }> {
  return clearSendMark(db, documentId, SEND_MAX_DURATION_MS);
}
