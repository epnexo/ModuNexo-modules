import { hasStoredPdf } from "../src/document-store.ts";

/**
 * SQL for the documents registry. Every function takes any object with a `query` method (a `pg.Pool` in the
 * app, the test pool in tests) and returns plain typed rows.
 */

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const DOCUMENT_STATUSES = ["draft", "generated", "sent", "completed", "declined", "expired"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const TEMPLATE_KINDS = ["nda", "contract", "proposal", "other"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export interface DocumentRow {
  id: number;
  ref: string;
  title: string;
  counterpartyName: string;
  templateName: string;
  kind: TemplateKind;
  status: DocumentStatus;
  createdAt: Date;
  /** The same rule as the download and the detail page: a stored path that is not blank. */
  hasPdf: boolean;
}

/** Every document with the name and kind of its template, newest first. */
export async function listDocuments(db: Queryable): Promise<DocumentRow[]> {
  const { rows } = await db.query(
    `select d.id, d.ref, d.title, d.counterparty_name, t.name as template_name, t.kind, d.status, d.created_at, d.pdf_path
     from documents.documents d
     join documents.templates t on t.id = d.template_id
     order by d.created_at desc, d.id desc`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    ref: row.ref as string,
    title: row.title as string,
    counterpartyName: row.counterparty_name as string,
    templateName: row.template_name as string,
    kind: row.kind as TemplateKind,
    status: row.status as DocumentStatus,
    createdAt: row.created_at as Date,
    hasPdf: hasStoredPdf(row.pdf_path),
  }));
}
