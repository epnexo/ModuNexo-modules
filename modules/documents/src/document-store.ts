import { basename } from "node:path";
import type { Queryable } from "../web/queries.ts";
import type { SignatureField } from "./pdf-engine.ts";
import { checkSignatureLayout } from "./signature-layout.ts";
import { type SigningLink, parseSigningLinks } from "./signature-store.ts";
import { type VariableSettings, parseVariableSettings } from "./variables.ts";

/** SQL for documents. Every value goes in as a parameter. */

export interface NewDocument {
  ref: string;
  templateId: number;
  templateBodySnapshot: string;
  title: string;
  counterpartyName: string;
  /** The values asked for this document and the profile values the body used, so it can be rebuilt later. */
  data: { values: Record<string, string>; profile: Record<string, string> };
  /** Relative to the documents folder. */
  pdfPath: string;
  signatureFields: { pages: number; fields: SignatureField[] };
}

/** Insert a generated document. The `ref` is unique, so a number can never be used twice. */
export async function insertGeneratedDocument(db: Queryable, document: NewDocument): Promise<number> {
  const { rows } = await db.query(
    `insert into documents.documents (ref, template_id, template_body_snapshot, title, counterparty_name, data, status, pdf_path, signature_fields)
     values ($1, $2, $3, $4, $5, $6::jsonb, 'generated', $7, $8::jsonb)
     returning id`,
    [document.ref, document.templateId, document.templateBodySnapshot, document.title, document.counterpartyName, JSON.stringify(document.data), document.pdfPath, JSON.stringify(document.signatureFields)],
  );
  return Number(rows[0]!.id);
}

/** The one rule for "this document has a PDF": a stored path that is not blank. The detail page and the download both use it. */
export const hasStoredPdf = (pdfPath: unknown): pdfPath is string => typeof pdfPath === "string" && pdfPath.trim() !== "";

export interface DocumentDetail {
  id: number;
  ref: string;
  title: string;
  counterpartyName: string;
  templateName: string;
  status: string;
  createdAt: Date;
  /** From the stored layout; null for a document that has none. */
  pages: number | null;
  values: Record<string, string>;
  profile: Record<string, string>;
  /** The variable settings the template has now (labels for the values), empty when it has none. */
  templateVariables: VariableSettings;
  hasPdf: boolean;
  /** The stored file name of the PDF (the name DocuSeal gives the template when it is uploaded), or null. */
  pdfName: string | null;
  completedAt: Date | null;
  /** Whether DocuSeal has a submission for this document. */
  hasSubmission: boolean;
  /** When a send of this document started and has not finished, else null. See migration 0003. */
  sendStartedAt: Date | null;
  /** The signers as stored; the links in them are sensitive. */
  signers: SigningLink[];
  /** Whether the stored PDF and layout can be sent for signature, and if not, why. */
  signature: { ready: true } | { ready: false; reason: string };
}

const asStrings = (value: unknown): Record<string, string> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};

export async function getDocument(db: Queryable, id: number): Promise<DocumentDetail | null> {
  const { rows } = await db.query(
    `select d.id, d.ref, d.title, d.counterparty_name, d.status, d.created_at, d.completed_at, d.data, d.pdf_path, d.signature_fields,
            d.docuseal_submission_id, d.send_started_at, d.signing_links, t.name as template_name, t.variables as template_variables
     from documents.documents d
     join documents.templates t on t.id = d.template_id
     where d.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const data = (row.data ?? {}) as { values?: unknown; profile?: unknown };
  const pages = (row.signature_fields as { pages?: unknown } | null)?.pages;
  const hasPdf = hasStoredPdf(row.pdf_path);
  const layout = checkSignatureLayout(row.signature_fields);
  const signature: DocumentDetail["signature"] = !hasPdf ? { ready: false, reason: "This document has no PDF." } : layout.ok ? { ready: true } : { ready: false, reason: layout.reason };
  return {
    id: Number(row.id),
    ref: row.ref as string,
    title: row.title as string,
    counterpartyName: row.counterparty_name as string,
    templateName: row.template_name as string,
    status: row.status as string,
    createdAt: row.created_at as Date,
    pages: Number.isInteger(pages) ? (pages as number) : null,
    values: asStrings(data.values),
    profile: asStrings(data.profile),
    templateVariables: parseVariableSettings(row.template_variables),
    hasPdf,
    pdfName: hasPdf ? basename(row.pdf_path as string) : null,
    completedAt: row.completed_at instanceof Date ? row.completed_at : null,
    hasSubmission: row.docuseal_submission_id !== null && row.docuseal_submission_id !== undefined,
    sendStartedAt: row.send_started_at instanceof Date ? row.send_started_at : null,
    signers: parseSigningLinks(row.signing_links),
    signature,
  };
}

/** The stored location of a document's PDF, relative to the documents folder. Treat it as untrusted. */
export async function getDocumentPdfPath(db: Queryable, id: number): Promise<string | null> {
  const { rows } = await db.query("select pdf_path from documents.documents where id = $1", [id]);
  return hasStoredPdf(rows[0]?.pdf_path) ? rows[0].pdf_path : null;
}

/** The id of the document with this reference, or null: how a creation finds out whether its commit happened. */
export async function findDocumentIdByRef(db: Queryable, ref: string): Promise<number | null> {
  const { rows } = await db.query("select id from documents.documents where ref = $1", [ref]);
  return rows[0] ? Number(rows[0].id) : null;
}
