import type { TemplateField } from "../src/template-rules.ts";
import type { VariableRow } from "../src/variable-rules.ts";

/** What a form action hands back to its form: the values to show again, field errors, and a form-level message. */

export interface TemplateFormState {
  values: Record<TemplateField, string>;
  errors: Partial<Record<TemplateField, string>>;
  /** A problem that belongs to no field, for example the database being down. */
  message?: string;
  saved?: boolean;
  /**
   * The rows of the Variables section: one per marker the saved body asks for each document. After a save they are
   * the rows of the body just saved; after a failure, the rows that were submitted, as typed.
   */
  variables?: VariableRow[];
  /** Errors of the Variables section, keyed `<MARKER>.<field>`. */
  variableErrors?: Record<string, string>;
  /** Markers whose settings the save dropped because the body no longer asks for them. */
  dropped?: string[];
}

export interface ProfileFormState {
  values: Record<string, string>;
  errors: Record<string, string>;
  message?: string;
  saved?: boolean;
}

/** The new-document form: values and errors are keyed by field name (a marker, or `counterpartyName`). */
export interface DocumentFormState {
  values: Record<string, string>;
  errors: Record<string, string>;
  message?: string;
}

/** What the status-refresh button shows afterwards: an error, a confirmation, or a note about a status the platform does not know. */
export interface RefreshFormState {
  message?: string;
  done?: string;
  note?: string;
  /** Set when the refresh moved the document out of `sent`: the form that would show `done` is about to disappear, so the action redirects and the page shows it. */
  moved?: "completed" | "declined" | "expired";
}

export interface ArchiveFormState {
  message?: string;
}

/** The button that clears an unfinished send: an error, or nothing (success redirects to the page). */
export interface ClearSendFormState {
  message?: string;
}

/** A form field as received: every FormData entry that is plain text. */
export type FormInput = Record<string, string | undefined>;

export const EMPTY_TEMPLATE_VALUES: Record<TemplateField, string> = { name: "", slug: "", kind: "", refPrefix: "", bodyHtml: "", counterpartyMarker: "" };
