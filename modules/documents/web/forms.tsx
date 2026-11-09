/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
"use client";

import Link from "next/link";
import { type ReactNode, useActionState, useEffect, useMemo, useRef, useState } from "react";
import { PAGE_SIZES, PROFILE_FIELDS, PROFILE_SECTIONS, type ProfileField } from "../src/profile.ts";
import { type DocumentFieldSpec, fieldUses, isMultiline } from "../src/document-rules.ts";
import { MAX_IMPORT_BYTES, looksLikeHtml, suggestFromFileName } from "../src/template-import.ts";
import type { TemplateField } from "../src/template-rules.ts";
import { type VariableField, type VariableRow, variableFieldName } from "../src/variable-rules.ts";
import { Notice, Portlet } from "./components.tsx";
import type { ArchiveFormState, ClearSendFormState, DocumentFormState, ProfileFormState, RefreshFormState, TemplateFormState } from "./form-state.ts";
import { TEMPLATE_KINDS } from "./queries.ts";

import { postAction } from "./post-action.ts";

/** The route a form posts to. The page passes the path; the permission of the route is checked by the platform. */
const useRoute = <S extends object>(endpoint: string) => useMemo(() => postAction<S>(endpoint), [endpoint]);

const KIND_LABELS: Record<(typeof TEMPLATE_KINDS)[number], string> = { nda: "NDA", contract: "Contract", proposal: "Proposal", other: "Other" };

interface Aria {
  id: string;
  name: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
  "aria-required"?: true;
}

/** A label, a control, help and an error, bound by id: the control reports the error and the help to assistive technology. */
function Field({
  name,
  label,
  error,
  help,
  hint,
  note,
  required,
  wide,
  children,
}: {
  name: string;
  label: string;
  error?: string | undefined;
  help?: string | undefined;
  /** The owner's help line; `help` then follows it in small text. */
  hint?: string | undefined;
  /** A line under the field about what it is made from, described to assistive technology like the help. */
  note?: string | undefined;
  required?: boolean | undefined;
  wide?: boolean | undefined;
  children: (aria: Aria) => ReactNode;
}) {
  const id = `f-${name}`;
  const describedBy = [help ? `${id}-help` : "", note ? `${id}-uses` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
  return (
    <div className={wide ? "field wide" : "field"}>
      <label className="field-label" htmlFor={id}>
        {label}
        {required ? <span className="required"> (required)</span> : null}
      </label>
      {children({
        id,
        name,
        ...(error ? { "aria-invalid": true as const } : {}),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(required ? { "aria-required": true as const } : {}),
      })}
      {help ? (
        <p id={`${id}-help`} className="field-help">
          {hint ? (
            <>
              {hint} <small>{help}</small>
            </>
          ) : (
            help
          )}
        </p>
      ) : null}
      {note ? (
        <p id={`${id}-uses`} className="field-help">
          {note}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** After a failed submit, move focus to the first invalid field so a keyboard user lands on the problem. */
function useFocusFirstInvalid(failed: boolean, state: unknown) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (failed) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [failed, state]);
  return form;
}

function FormNotices({ errors, message, saved, savedTitle }: { errors: object; message?: string | undefined; saved?: boolean | undefined; savedTitle: string }) {
  if (message) return <Notice tone="error" title={message} />;
  if (Object.keys(errors).length > 0) return <Notice tone="error" title="Check the highlighted fields." />;
  if (saved) return <Notice tone="ok" title={savedTitle} />;
  return null;
}

const VARIABLE_KIND_OPTIONS = [
  ["line", "One line"],
  ["text", "Long text"],
  ["date", "Date"],
] as const;
const DATE_LANGUAGE_OPTIONS = [
  ["es", "Spanish"],
  ["en", "English"],
] as const;
const VARIABLE_FIELD_NAMES: Record<VariableField, string> = { label: "Label", help: "Help", kind: "Kind", default: "Default", locale: "Date language" };

/** The kind a row has when none is chosen: the word rule on the marker name. */
const automaticKind = (marker: string) => (isMultiline(marker) ? "text" : "line");

/**
 * The settings of the variables the saved body asks for each document: one dense row per marker, in the order of
 * the body, with an accessible name on every input. Owner text only ever reaches the page as an input value.
 */
function VariablesSection({ rows, errors }: { rows: VariableRow[]; errors: Record<string, string> }) {
  const control = (row: VariableRow, field: VariableField) => {
    const name = variableFieldName(row.marker, field);
    const error = errors[`${row.marker}.${field}`];
    const aria = {
      id: `f-${name}`,
      name,
      "aria-label": `${VARIABLE_FIELD_NAMES[field]} for ${row.marker}`,
      ...(error ? { "aria-invalid": true as const, "aria-describedby": `f-${name}-error` } : {}),
    };
    return { aria, error, name };
  };
  const cell = (row: VariableRow, field: VariableField, input: (aria: ReturnType<typeof control>["aria"]) => ReactNode) => {
    const { aria, error, name } = control(row, field);
    return (
      <td>
        {input(aria)}
        {error ? (
          <p id={`f-${name}-error`} className="field-error">
            {error}
          </p>
        ) : null}
      </td>
    );
  };

  return (
    <section className="variables" aria-labelledby="variables-heading">
      <h3 id="variables-heading" className="form-section-title">
        Variables
      </h3>
      <p className="field-help">
        The label, help line and starting value shown on the new-document form for each value asked per document. Leave an input blank to keep the default behavior. A default can use other fields: write their marker, such as {"{{B_NOMBRE}}"}, and it is filled in when the document is created. The list comes from the saved body: a marker you add to the body appears here after you save.
      </p>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          The saved body asks for no values for each document.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="variables-table">
            <thead>
              <tr>
                <th>Marker</th>
                <th>Label</th>
                <th>Help</th>
                <th>Kind</th>
                <th>Default</th>
                <th>Date language</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const longText = (row.kind === "" ? automaticKind(row.marker) : row.kind) === "text";
                return (
                  <tr key={row.marker} data-marker={row.marker}>
                    <td>
                      <code>{`{{${row.marker}}}`}</code>
                    </td>
                    {cell(row, "label", (aria) => (
                      <input {...aria} className="input" type="text" defaultValue={row.label} autoComplete="off" />
                    ))}
                    {cell(row, "help", (aria) => (
                      <input {...aria} className="input" type="text" defaultValue={row.help} autoComplete="off" />
                    ))}
                    {cell(row, "kind", (aria) => (
                      <select {...aria} className="input" defaultValue={row.kind}>
                        <option value="">{`Automatic: ${automaticKind(row.marker) === "text" ? "long text" : "one line"}`}</option>
                        {VARIABLE_KIND_OPTIONS.map(([value, text]) => (
                          <option key={value} value={value}>
                            {text}
                          </option>
                        ))}
                      </select>
                    ))}
                    {cell(row, "default", (aria) =>
                      longText ? (
                        <textarea {...aria} className="input" defaultValue={row.default} rows={2} autoComplete="off" />
                      ) : (
                        <input {...aria} className="input" type="text" defaultValue={row.default} autoComplete="off" />
                      ),
                    )}
                    {cell(row, "locale", (aria) => (
                      <select {...aria} className="input" defaultValue={row.locale}>
                        {DATE_LANGUAGE_OPTIONS.map(([value, text]) => (
                          <option key={value} value={value}>
                            {text}
                          </option>
                        ))}
                      </select>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * `counterpartyOptions` are the markers of the saved body that are asked for each document: the choice of the
 * counterparty-name marker depends on the saved body, so a new template offers none until it is saved.
 */
/**
 * Load the body of any document from an HTML file on the owner's computer. The file is read in the browser and put in the
 * form below; nothing is saved until the form is. A name and a slug are suggested from the file name, only into empty fields.
 */
function LoadFromFile({ form }: { form: React.RefObject<HTMLFormElement | null> }) {
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const control = (name: string) => form.current?.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;
  async function load(file: File | undefined) {
    if (!file) return;
    if (!looksLikeHtml(file.name)) return setMessage({ tone: "error", text: "Choose an HTML file (.html or .htm)." });
    if (file.size > MAX_IMPORT_BYTES) return setMessage({ tone: "error", text: "The file is too large to be a template body (the limit is 1 MB)." });
    const body = control("bodyHtml");
    const text = await file.text();
    if (!body) return;
    if (body.value.trim() !== "" && !window.confirm("Replace the body already written in the form with this file?")) return;
    body.value = text;
    const suggested = suggestFromFileName(file.name);
    for (const field of ["name", "slug"] as const) {
      const input = control(field);
      if (input && input.value.trim() === "") input.value = suggested[field];
    }
    setMessage({ tone: "ok", text: `Loaded ${file.name}. Review the fields below and create the template.` });
  }
  return (
    <div className="field wide">
      <label className="field-label" htmlFor="load-html">
        Load the body from an HTML file
      </label>
      <input id="load-html" className="input" type="file" accept=".html,.htm,text/html" onChange={(event) => void load(event.target.files?.[0])} />
      <span className="field-help">Works for any document: a contract, a proposal, an NDA. Mark each value to fill with {"{{NAME}}"}.</span>
      {message ? (
        <span className={message.tone === "error" ? "field-error" : "field-help"} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </span>
      ) : null}
    </div>
  );
}

export function TemplateForm({
  endpoint,
  initial,
  mode,
  id,
  counterpartyOptions,
}: {
  endpoint: string;
  initial: TemplateFormState;
  mode: "create" | "edit";
  id?: number | undefined;
  counterpartyOptions: string[];
}) {
  const [state, formAction, pending] = useActionState(useRoute<TemplateFormState>(endpoint), initial);
  const form = useFocusFirstInvalid(Object.keys(state.errors).length > 0, state);
  const error = (field: TemplateField) => state.errors[field];
  const chosen = state.values.counterpartyMarker;
  // The markers asked per document: the rows when the state has them (they follow the body just saved), else the page's list.
  const offered = state.variables ? state.variables.map((row) => row.marker) : counterpartyOptions;
  // A stored choice the body no longer offers stays visible, so saving does not drop it without saying so.
  const options = chosen !== "" && !offered.includes(chosen) ? [...offered, chosen] : offered;

  return (
    <form ref={form} action={formAction} className="form" aria-label="Template" noValidate>
      <FormNotices errors={{ ...state.errors, ...state.variableErrors }} message={state.message} saved={state.saved} savedTitle="Template saved." />
      {state.dropped && state.dropped.length > 0 ? <Notice title={`Settings dropped for markers no longer in the body: ${state.dropped.join(", ")}.`} /> : null}
      {mode === "edit" && id !== undefined ? <input type="hidden" name="id" value={id} /> : null}
      <div className="form-grid">
        {mode === "create" ? <LoadFromFile form={form} /> : null}
        <Field name="name" label="Name" error={error("name")} required>
          {(aria) => <input {...aria} className="input" type="text" defaultValue={state.values.name} autoComplete="off" />}
        </Field>
        <Field name="slug" label="Slug" error={error("slug")} help="Lowercase letters and digits, separated by hyphens." required>
          {(aria) => <input {...aria} className="input" type="text" defaultValue={state.values.slug} autoComplete="off" spellCheck={false} />}
        </Field>
        <Field name="kind" label="Kind" error={error("kind")} required>
          {(aria) => (
            <select {...aria} className="input" defaultValue={state.values.kind}>
              <option value="">Choose a kind</option>
              {TEMPLATE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field name="refPrefix" label="Numbering prefix" error={error("refPrefix")} help="Uppercase letters and digits. Document numbers read PREFIX-YYYY-NNN." required>
          {(aria) => <input {...aria} className="input" type="text" defaultValue={state.values.refPrefix} autoComplete="off" spellCheck={false} />}
        </Field>
        <Field
          name="counterpartyMarker"
          label="Counterparty name comes from"
          error={error("counterpartyMarker")}
          help={
            mode === "create"
              ? "Save the template first, then choose the marker that holds the counterparty's name."
              : "Used for the title, the file name and the registry. Without one, the new-document form asks for the name on its own."
          }
        >
          {(aria) => (
            <select {...aria} className="input" defaultValue={chosen}>
              <option value="">None: ask for the name separately</option>
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field name="bodyHtml" label="Body (HTML)" error={error("bodyHtml")} help="Write the document as HTML. Put each value to fill in a marker such as {{NAME}}." required wide>
          {(aria) => <textarea {...aria} className="input code" defaultValue={state.values.bodyHtml} rows={24} spellCheck={false} autoComplete="off" />}
        </Field>
      </div>
      {mode === "edit" && state.variables ? <VariablesSection rows={state.variables} errors={state.variableErrors ?? {}} /> : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Saving…" : mode === "create" ? "Create template" : "Save changes"}
        </button>
        <Link className="btn" href="/documents/templates">
          Cancel
        </Link>
      </div>
    </form>
  );
}

function ProfileControl({ field, aria, value }: { field: ProfileField; aria: Aria; value: string }) {
  switch (field.kind) {
    case "textarea":
      return <textarea {...aria} className="input" defaultValue={value} rows={4} autoComplete="off" />;
    case "page":
      return (
        <select {...aria} className="input" defaultValue={value}>
          <option value="">Not set</option>
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size === "A4" ? "A4" : "Letter"}
            </option>
          ))}
        </select>
      );
    case "email":
      return <input {...aria} className="input" type="email" defaultValue={value} autoComplete="off" />;
    case "integer":
      return <input {...aria} className="input" type="text" inputMode="numeric" defaultValue={value} autoComplete="off" />;
    case "country":
      return <input {...aria} className="input" type="text" defaultValue={value} maxLength={2} autoComplete="off" spellCheck={false} />;
    case "color":
      return <input {...aria} className="input" type="text" defaultValue={value} autoComplete="off" spellCheck={false} />;
    default:
      return <input {...aria} className="input" type="text" defaultValue={value} autoComplete="off" />;
  }
}

export function ProfileForm({ endpoint, initial }: { endpoint: string; initial: ProfileFormState }) {
  const [state, formAction, pending] = useActionState(useRoute<ProfileFormState>(endpoint), initial);
  const form = useFocusFirstInvalid(Object.keys(state.errors).length > 0, state);

  return (
    <form ref={form} action={formAction} className="form" aria-label="Owner profile" noValidate>
      <FormNotices errors={state.errors} message={state.message} saved={state.saved} savedTitle="Profile saved." />
      {PROFILE_SECTIONS.map((section) => (
        <Portlet key={section.id} title={section.title}>
          {"note" in section ? <p className="portlet-note">{section.note}</p> : null}
          <div className="form-grid">
            {PROFILE_FIELDS.filter((field) => field.section === section.id).map((field) => (
              <Field key={field.key} name={field.key} label={field.label} error={state.errors[field.key]} help={field.help ?? `Marker {{${field.key}}}`} required={field.required} wide={field.kind === "textarea"}>
                {(aria) => <ProfileControl field={field} aria={aria} value={state.values[field.key] ?? ""} />}
              </Field>
            ))}
          </div>
        </Portlet>
      ))}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}

export function ArchiveForm({ endpoint, initial, id }: { endpoint: string; initial: ArchiveFormState; id: number }) {
  const [state, formAction, pending] = useActionState(useRoute<ArchiveFormState>(endpoint), initial);
  return (
    <form
      action={formAction}
      className="form"
      aria-label="Archive template"
      onSubmit={(event) => {
        if (!window.confirm("Archive this template? It will be hidden from the list.")) event.preventDefault();
      }}
    >
      {state.message ? <Notice tone="error" title={state.message} /> : null}
      <p className="portlet-note" style={{ margin: 0 }}>
        An archived template is hidden from the list and cannot be edited. Documents already created keep their own copy of the body.
      </p>
      <input type="hidden" name="id" value={id} />
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          Archive template
        </button>
      </div>
    </form>
  );
}

/**
 * The variables a template asks for a new document. A long-text variable gets a textarea, every other kind a single line (a date is
 * text: it goes into the document as written). A field starts with what the owner entered, else its initial value.
 */
export function DocumentForm({
  endpoint,
  initial,
  templateId,
  fields,
  profileKeys = [],
}: {
  endpoint: string;
  initial: DocumentFormState;
  templateId: number;
  fields: DocumentFieldSpec[];
  /** The keys the owner profile has a value for, so a profile marker in a value can be named. */
  profileKeys?: string[];
}) {
  const [state, formAction, pending] = useActionState(useRoute<DocumentFormState>(endpoint), initial);
  const form = useFocusFirstInvalid(Object.keys(state.errors).length > 0, state);

  return (
    <form ref={form} action={formAction} className="form" aria-label="New document" noValidate>
      <FormNotices errors={state.errors} message={state.message} savedTitle="" />
      <input type="hidden" name="templateId" value={templateId} />
      <div className="form-grid">
        {fields.map((field) => {
          const shown = state.values[field.name] ?? field.initial;
          const uses = fieldUses(shown, fields, profileKeys);
          return (
            <Field
              key={field.name}
              name={field.name}
              label={field.label}
              error={state.errors[field.name]}
              help={field.help ?? undefined}
              hint={field.hint ?? undefined}
              note={uses.length > 0 ? `Uses ${uses.join(", ")}. They are filled in when the document is created.` : undefined}
              required
              wide={field.multiline}
            >
              {(aria) =>
                field.multiline ? (
                  <textarea {...aria} className="input" defaultValue={shown} rows={4} autoComplete="off" />
                ) : (
                  <input {...aria} className="input" type="text" defaultValue={shown} autoComplete="off" />
                )
              }
            </Field>
          );
        })}
      </div>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Creating…" : "Create document"}
        </button>
        <Link className="btn" href="/documents/new">
          Change template
        </Link>
      </div>
    </form>
  );
}

/** The two signers of a document and how they sign. Pre-filled by the page; the server checks every value again. */
export function SignatureForm({ endpoint, initial, documentId }: { endpoint: string; initial: DocumentFormState; documentId: number }) {
  const [state, formAction, pending] = useActionState(useRoute<DocumentFormState>(endpoint), initial);
  const form = useFocusFirstInvalid(Object.keys(state.errors).length > 0, state);
  const value = (name: string) => state.values[name] ?? "";

  return (
    <form ref={form} action={formAction} className="form" aria-label="Send for signature" noValidate>
      <FormNotices errors={state.errors} message={state.message} savedTitle="" />
      <input type="hidden" name="documentId" value={documentId} />
      <div className="form-grid">
        <Field name="ownerName" label="Your name" error={state.errors.ownerName} required>
          {(aria) => <input {...aria} className="input" type="text" defaultValue={value("ownerName")} autoComplete="off" />}
        </Field>
        <Field name="ownerEmail" label="Your email" error={state.errors.ownerEmail} required>
          {(aria) => <input {...aria} className="input" type="email" defaultValue={value("ownerEmail")} autoComplete="off" />}
        </Field>
        <Field name="counterpartyName" label="Counterparty signer's name" error={state.errors.counterpartyName} required>
          {(aria) => <input {...aria} className="input" type="text" defaultValue={value("counterpartyName")} autoComplete="off" />}
        </Field>
        <Field name="counterpartyEmail" label="Counterparty signer's email" error={state.errors.counterpartyEmail} required>
          {(aria) => <input {...aria} className="input" type="email" defaultValue={value("counterpartyEmail")} autoComplete="off" />}
        </Field>
        <Field name="order" label="Signing order" error={state.errors.order} required>
          {(aria) => (
            <select {...aria} className="input" defaultValue={state.values.order ?? "random"}>
              <option value="random">Either can sign first</option>
              <option value="preserved">You sign first, then the counterparty</option>
            </select>
          )}
        </Field>
      </div>
      <p className="portlet-note" style={{ margin: 0 }}>
        The platform sends no email. You get a signing link for each signer and share it yourself.
      </p>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Sending…" : "Send for signature"}
        </button>
      </div>
    </form>
  );
}

/** Reads the submission from DocuSeal and updates the status. On demand only. */
export function RefreshForm({ endpoint, initial, documentId }: { endpoint: string; initial: RefreshFormState; documentId: number }) {
  const [state, formAction, pending] = useActionState(useRoute<RefreshFormState>(endpoint), initial);
  return (
    <form action={formAction} className="form" aria-label="Refresh status">
      {state.message ? <Notice tone="error" title={state.message} /> : state.done ? <Notice tone="ok" title={state.done} /> : null}
      {state.note ? <Notice title={state.note} /> : null}
      <input type="hidden" name="documentId" value={documentId} />
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Refreshing…" : "Refresh status"}
        </button>
      </div>
    </form>
  );
}

/** Clears the mark of an unfinished send. A separate action on purpose: it never sends, and the owner takes it after checking DocuSeal. */
export function ClearSendForm({ endpoint, initial, documentId }: { endpoint: string; initial: ClearSendFormState; documentId: number }) {
  const [state, formAction, pending] = useActionState(useRoute<ClearSendFormState>(endpoint), initial);
  return (
    <form
      action={formAction}
      className="form"
      aria-label="Clear unfinished send"
      onSubmit={(event) => {
        if (!window.confirm("Clear the unfinished send? Do this only after checking in DocuSeal that no signature request exists for this document.")) event.preventDefault();
      }}
    >
      {state.message ? <Notice tone="error" title={state.message} /> : null}
      <input type="hidden" name="documentId" value={documentId} />
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          Clear unfinished send
        </button>
      </div>
    </form>
  );
}
