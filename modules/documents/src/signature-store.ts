import type { Queryable } from "../web/queries.ts";

/** SQL for the signature state of a document. Every value goes in as a parameter. */

/** One signer as stored in `signing_links`. `link` is sensitive: whoever has it can sign. `status` and `at` come from a status refresh. */
export interface SigningLink {
  role: string;
  name: string;
  email: string;
  link: string;
  status?: string;
  at?: string;
}

/** The row a send reads under a lock. Anything that comes from a JSON column is unchecked until used. */
export interface SigningRow {
  id: number;
  ref: string;
  status: string;
  counterpartyName: string;
  pdfPath: string | null;
  /** The id of the PDF in the platform file store; null for a row from before the store. */
  pdfFileId: string | null;
  signatureFields: unknown;
  /** The profile values the document used, as a snapshot. */
  profile: Record<string, string>;
  docusealSubmissionId: number | null;
  /** When a send of this document started and has not finished (see migration 0003), else null. */
  sendStartedAt: Date | null;
}

const asStrings = (value: unknown): Record<string, string> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};

/** Read the row and keep it locked until the transaction ends, so two sends of one document never run side by side. */
export async function lockDocumentForSigning(tx: Queryable, id: number): Promise<SigningRow | null> {
  const { rows } = await tx.query(
    `select id, ref, status, counterparty_name, pdf_path, pdf_file_id, signature_fields, data, docuseal_submission_id, send_started_at
     from documents.documents where id = $1 for update`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const data = (row.data ?? {}) as { profile?: unknown };
  return {
    id: Number(row.id),
    ref: row.ref as string,
    status: row.status as string,
    counterpartyName: row.counterparty_name as string,
    pdfPath: typeof row.pdf_path === "string" ? row.pdf_path : null,
    pdfFileId: typeof row.pdf_file_id === "string" && row.pdf_file_id !== "" ? row.pdf_file_id : null,
    signatureFields: row.signature_fields,
    profile: asStrings(data.profile),
    docusealSubmissionId: row.docuseal_submission_id === null || row.docuseal_submission_id === undefined ? null : Number(row.docuseal_submission_id),
    sendStartedAt: row.send_started_at instanceof Date ? row.send_started_at : null,
  };
}

/**
 * Mark the document as being sent. Call it inside the transaction that locked the row and commit it before DocuSeal is
 * asked for anything: a second request then sees the mark instead of creating a second submission. The time is cut to
 * milliseconds so the value read back is the value stored, which `releaseSend` compares.
 */
export async function claimSend(tx: Queryable, id: number): Promise<Date | null> {
  const { rows } = await tx.query(
    `update documents.documents
        set send_started_at = date_trunc('milliseconds', clock_timestamp()), updated_at = now()
      where id = $1 and send_started_at is null and docuseal_submission_id is null and status = 'generated'
      returning send_started_at`,
    [id],
  );
  return rows[0]?.send_started_at instanceof Date ? rows[0].send_started_at : null;
}

/** Remove the mark a send wrote, only if it is still that send's mark: the owner may have cleared it and another send claimed the document. */
export async function releaseSend(db: Queryable, id: number, claimed: Date): Promise<void> {
  await db.query("update documents.documents set send_started_at = null, updated_at = now() where id = $1 and send_started_at = $2 and docuseal_submission_id is null", [id, claimed]);
}

/**
 * The owner's explicit action: clear the mark of an unfinished send. It changes nothing else and never calls DocuSeal.
 * A mark younger than `minAgeMs` may belong to a send that is still inside its DocuSeal calls, so it is refused; the age
 * is compared with the database clock in the statement that clears, so nothing can change between the check and the write.
 */
export async function clearSendMark(db: Queryable, id: number, minAgeMs: number): Promise<"cleared" | "nothing-to-clear" | { result: "too-early"; waitMs: number }> {
  const where = "id = $1 and send_started_at is not null and docuseal_submission_id is null and status = 'generated'";
  const { rows } = await db.query(
    `update documents.documents set send_started_at = null, updated_at = now()
      where ${where} and send_started_at <= clock_timestamp() - make_interval(secs => $2::float8 / 1000)
      returning id`,
    [id, minAgeMs],
  );
  if (rows.length === 1) return "cleared";
  const young = await db.query(`select extract(epoch from (send_started_at + make_interval(secs => $2::float8 / 1000) - clock_timestamp())) * 1000 as wait_ms from documents.documents where ${where}`, [id, minAgeMs]);
  return young.rows.length === 1 ? { result: "too-early", waitMs: Math.max(Math.ceil(Number(young.rows[0]!.wait_ms)), 1) } : "nothing-to-clear";
}

/**
 * Store a submission DocuSeal accepted: ids, links, the status and the end of the send mark, in one statement. It matches
 * only the mark `claimed` by the send that made the submission, so a late send never records over (and never wipes) the
 * mark of another send; a document that already holds this same submission also matches, so a retry after an uncertain
 * answer changes nothing.
 */
export async function recordSubmission(db: Queryable, id: number, claimed: Date, submission: { templateId: number; submissionId: number; links: SigningLink[] }): Promise<"recorded" | "conflict"> {
  const { rows } = await db.query(
    `update documents.documents
        set docuseal_template_id = $2, docuseal_submission_id = $3, signing_links = $4::jsonb, status = 'sent', send_started_at = null, updated_at = now()
      where id = $1 and status in ('generated', 'sent') and ((docuseal_submission_id is null and send_started_at = $5) or docuseal_submission_id = $3)
      returning id`,
    [id, submission.templateId, submission.submissionId, JSON.stringify(submission.links), claimed],
  );
  return rows.length === 1 ? "recorded" : "conflict";
}

const isWebLink = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/** The stored signers, keeping only entries that are well formed. A link that is not http or https is dropped, so it can never become an `href`. */
export function parseSigningLinks(value: unknown): SigningLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): SigningLink[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { role, name, email, link, status, at } = entry as Record<string, unknown>;
    if (typeof role !== "string" || typeof name !== "string" || typeof email !== "string" || !isWebLink(link)) return [];
    return [{ role, name, email, link, ...(typeof status === "string" ? { status } : {}), ...(typeof at === "string" ? { at } : {}) }];
  });
}

/** What a status refresh or a signed-PDF download needs. */
export interface SigningState {
  id: number;
  ref: string;
  status: string;
  counterpartyName: string;
  docusealSubmissionId: number | null;
  /** The signers that are well formed, for display and for the signed-PDF download. */
  links: SigningLink[];
  /** The column as stored, untouched: a refresh merges into this, never into `links`, so nothing stored is dropped. */
  storedLinks: unknown;
}

export async function getSigningState(db: Queryable, id: number): Promise<SigningState | null> {
  const { rows } = await db.query("select id, ref, status, counterparty_name, docuseal_submission_id, signing_links from documents.documents where id = $1", [id]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    ref: row.ref as string,
    status: row.status as string,
    counterpartyName: row.counterparty_name as string,
    docusealSubmissionId: row.docuseal_submission_id === null || row.docuseal_submission_id === undefined ? null : Number(row.docuseal_submission_id),
    links: parseSigningLinks(row.signing_links),
    storedLinks: row.signing_links,
  };
}

/**
 * Store what a refresh learned. It matches only a document that is still `sent` with this submission, so a refresh that
 * raced another change writes nothing and says so.
 */
export async function applyRefresh(db: Queryable, id: number, change: { submissionId: number; status: string; completedAt: Date | null; links: unknown }): Promise<"applied" | "stale"> {
  const { rows } = await db.query(
    `update documents.documents
        set status = $3, completed_at = $4, signing_links = coalesce($5::jsonb, signing_links), updated_at = now()
      where id = $1 and docuseal_submission_id = $2 and status = 'sent'
      returning id`,
    [id, change.submissionId, change.status, change.completedAt, Array.isArray(change.links) ? JSON.stringify(change.links) : null],
  );
  return rows.length === 1 ? "applied" : "stale";
}
