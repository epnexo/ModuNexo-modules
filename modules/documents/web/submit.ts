import { describeDbError } from "@epnexo/core/pool";
import { PROFILE_FIELDS, validateProfile } from "../src/profile.ts";
import { listMarkers, splitMarkers } from "../src/markers.ts";
import { getProfile, saveProfile } from "../src/profile-store.ts";
import { parseTemplateId, templateFormValues, validateTemplate } from "../src/template-rules.ts";
import { archiveTemplate, createTemplate, getTemplate, updateTemplate } from "../src/template-store.ts";
import { submittedVariableRows, validateVariables } from "../src/variable-rules.ts";
import type { ArchiveFormState, FormInput, ProfileFormState, TemplateFormState } from "./form-state.ts";
import { logFailure } from "./log.ts";
import type { Queryable } from "./queries.ts";

/**
 * What each form does with a submission, apart from reading FormData and navigating: validate, write, and say what
 * the form shows next. The server actions are thin wrappers around these, so they run against a test database.
 */

export type TemplateOutcome = { state: TemplateFormState } | { redirectTo: string };
export type ArchiveOutcome = { state: ArchiveFormState } | { redirectTo: string };

const SLUG_TAKEN = "This slug is already used by another template, possibly an archived one.";
const NOT_EDITABLE = "This template no longer exists or is archived.";

function dbMessage(scope: string, error: unknown): string {
  logFailure(scope, error);
  return describeDbError(error).message;
}

export async function submitNewTemplate(db: Queryable, raw: FormInput): Promise<TemplateOutcome> {
  const checked = validateTemplate(raw);
  if (!checked.ok) return { state: { values: checked.values, errors: checked.errors } };
  const values = templateFormValues(checked.value);
  try {
    const created = await createTemplate(db, checked.value);
    if (!created.ok) return { state: { values, errors: { slug: SLUG_TAKEN } } };
    return { redirectTo: `/documents/templates/${created.id}?saved=1` };
  } catch (error) {
    return { state: { values, errors: {}, message: dbMessage("could not create a template", error) } };
  }
}

/**
 * Save a template with the settings of its variables. The settings are kept for the markers the body being saved asks
 * for each document; those of a marker the body no longer has are dropped and named in `dropped`. Nothing is written
 * unless the template fields and every setting are valid. Whatever the outcome, the rows show what was submitted or saved.
 */
export async function submitTemplateUpdate(db: Queryable, raw: FormInput): Promise<TemplateOutcome> {
  const submitted = submittedVariableRows(raw);
  const checked = validateTemplate(raw);
  if (!checked.ok) return { state: { values: checked.values, errors: checked.errors, variables: submitted } };
  const values = templateFormValues(checked.value);
  const id = parseTemplateId(raw.id);
  if (id === null) return { state: { values, errors: {}, variables: submitted, message: NOT_EDITABLE } };
  try {
    const current = await getTemplate(db, id);
    if (current === null || current.archivedAt !== null) return { state: { values, errors: {}, variables: submitted, message: NOT_EDITABLE } };
    const profile = await getProfile(db);
    const askable = splitMarkers(listMarkers(checked.value.bodyHtml), profile).perDocument;
    const variables = validateVariables({ askable, submitted, existing: current.variables, profile });
    if (!variables.ok) return { state: { values, errors: {}, variables: submitted, variableErrors: variables.errors } };

    const result = await updateTemplate(db, id, checked.value, variables.settings);
    if (result === "slug-taken") return { state: { values, errors: { slug: SLUG_TAKEN }, variables: submitted } };
    if (result === "not-found") return { state: { values, errors: {}, variables: submitted, message: NOT_EDITABLE } };
    return { state: { values, errors: {}, saved: true, variables: variables.rows, dropped: variables.dropped } };
  } catch (error) {
    return { state: { values, errors: {}, variables: submitted, message: dbMessage("could not update a template", error) } };
  }
}

export async function submitArchive(db: Queryable, raw: FormInput): Promise<ArchiveOutcome> {
  const id = parseTemplateId(raw.id);
  if (id === null) return { state: { message: NOT_EDITABLE } };
  try {
    if (!(await archiveTemplate(db, id))) return { state: { message: NOT_EDITABLE } };
    return { redirectTo: "/documents/templates" };
  } catch (error) {
    return { state: { message: dbMessage("could not archive a template", error) } };
  }
}

export async function submitProfile(db: Queryable, raw: FormInput): Promise<ProfileFormState> {
  const checked = validateProfile(raw);
  if (!checked.ok) return { values: checked.values, errors: checked.errors };
  const values = Object.fromEntries(PROFILE_FIELDS.map((field) => [field.key, checked.set[field.key] ?? ""]));
  try {
    await saveProfile(db, { set: checked.set, remove: checked.remove });
    return { values, errors: {}, saved: true };
  } catch (error) {
    return { values, errors: {}, message: dbMessage("could not save the profile", error) };
  }
}
