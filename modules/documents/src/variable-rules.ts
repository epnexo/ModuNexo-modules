import { MULTI_LINE_MAX, SINGLE_LINE_MAX, isMultiline, markerLabel } from "./document-rules.ts";
import type { Profile } from "./profile.ts";
import { checkReferences } from "./value-references.ts";
import { DATE_LOCALES, HELP_MAX, LABEL_MAX, VARIABLE_KINDS, type VariableKind, type VariableSetting, type VariableSettings } from "./variables.ts";

/**
 * Checking and normalizing the settings submitted with a template. Pure. Only markers the saved body asks for each
 * document can have settings. A default is the starting value of a field and may use other fields by their marker
 * (see `value-references.ts`): the markers it names must exist in this template or the owner profile, and defaults
 * must not depend on each other in a circle. A default is checked here, not resolved: it is filled in when a document is made.
 */

export type VariableField = "label" | "help" | "kind" | "default" | "locale";
const FIELDS: readonly VariableField[] = ["label", "help", "kind", "default", "locale"];

/** One row of the Variables section as text: what the inputs hold. */
export type VariableRowValues = Record<VariableField, string>;
export interface VariableRow extends VariableRowValues {
  marker: string;
}

/** The name of an input of the Variables section. */
export const variableFieldName = (marker: string, field: VariableField): string => `variables.${marker}.${field}`;

const INPUT_NAME = /^variables\.([A-Z_][A-Z0-9_]*)\.([a-z]+)$/;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_LINE_BREAK = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const blankRow = (marker: string): VariableRow => ({ marker, label: "", help: "", kind: "", default: "", locale: "es" });

/** The rows of the Variables section a form submitted, in the order they appear, with the text as typed (line endings made `\n`). */
export function submittedVariableRows(raw: Record<string, string | undefined>): VariableRow[] {
  const rows = new Map<string, VariableRow>();
  for (const [name, value] of Object.entries(raw)) {
    const match = INPUT_NAME.exec(name);
    if (!match || typeof value !== "string" || !(FIELDS as readonly string[]).includes(match[2]!)) continue;
    const marker = match[1]!;
    const row = rows.get(marker) ?? blankRow(marker);
    row[match[2] as VariableField] = value.replaceAll("\r\n", "\n");
    rows.set(marker, row);
  }
  return [...rows.values()];
}

/** The stored settings of the markers asked, as the rows the section shows. A date without a language is shown as Spanish, the language it is written in. */
export function variableRows(markers: string[], settings: VariableSettings): VariableRow[] {
  return markers.map((marker) => {
    const setting = Object.hasOwn(settings, marker) ? settings[marker]! : {};
    return { marker, label: setting.label ?? "", help: setting.help ?? "", kind: setting.kind ?? "", default: setting.default ?? "", locale: setting.locale ?? "es" };
  });
}

export type VariablesResult =
  | { ok: true; settings: VariableSettings; dropped: string[]; rows: VariableRow[] }
  /** Keyed by `<MARKER>.<field>`. */
  | { ok: false; errors: Record<string, string> };

function checkRow(row: VariableRow): { setting: VariableSetting; errors: Partial<Record<VariableField, string>> } {
  const errors: Partial<Record<VariableField, string>> = {};
  const setting: VariableSetting = {};
  const label = row.label.trim();
  const help = row.help.trim();
  const defaultText = row.default.trim();

  if (label.length > LABEL_MAX) errors.label = `Use at most ${LABEL_MAX} characters.`;
  else if (ANY_CONTROL.test(label)) errors.label = "Remove the control characters.";
  else if (label !== "") setting.label = label;

  if (help.length > HELP_MAX) errors.help = `Use at most ${HELP_MAX} characters.`;
  else if (ANY_CONTROL.test(help)) errors.help = "Remove the control characters.";
  else if (help !== "") setting.help = help;

  const kindText = row.kind.trim();
  if (kindText !== "" && !(VARIABLE_KINDS as readonly string[]).includes(kindText)) errors.kind = "Choose a kind from the list.";
  const kind = errors.kind ? undefined : (kindText as VariableKind | "");
  if (kind) setting.kind = kind;

  const localeText = row.locale.trim();
  if (localeText !== "" && !(DATE_LOCALES as readonly string[]).includes(localeText)) errors.locale = "Choose a language from the list.";
  else if (kind === "date") setting.locale = (localeText || "es") as "es" | "en";

  // The limits are the ones the value has for its effective kind: the chosen one, else the word rule on the marker name.
  const longText = (kind || (isMultiline(row.marker) ? "text" : "line")) === "text";
  const max = longText ? MULTI_LINE_MAX : SINGLE_LINE_MAX;
  if (defaultText.length > max) errors.default = `Use at most ${max} characters.`;
  else if (CONTROL_BUT_LINE_BREAK.test(defaultText)) errors.default = "Remove the control characters.";
  else if (!longText && defaultText.includes("\n")) errors.default = "Use a single line.";
  else if (defaultText !== "") setting.default = defaultText;

  return { setting, errors };
}

const hasContent = (row: VariableRow) => FIELDS.some((field) => row[field].trim() !== "" && !(field === "locale" && row.locale === "es"));

/**
 * Settings for the markers asked per document by the body being saved. `submitted` are the rows of the form; `existing`
 * the stored settings. A marker that is asked and was submitted takes the form's values; one that is asked and was not
 * submitted (a marker added to the body since the form was shown) keeps what is stored; one that is not asked any more
 * is dropped, and `dropped` names it when it had settings. Invalid rows of dropped markers are not checked.
 */
export function validateVariables(input: { askable: string[]; submitted: VariableRow[]; existing: VariableSettings; profile?: Profile }): VariablesResult {
  const asked = new Set(input.askable);
  const submitted = new Map<string, VariableRow>();
  for (const row of input.submitted) if (!submitted.has(row.marker)) submitted.set(row.marker, row);

  const errors: Record<string, string> = {};
  const settings: VariableSettings = {};
  for (const marker of input.askable) {
    const row = submitted.get(marker);
    if (!row) {
      if (Object.hasOwn(input.existing, marker)) settings[marker] = input.existing[marker]!;
      continue;
    }
    const checked = checkRow(row);
    for (const [field, message] of Object.entries(checked.errors)) errors[`${marker}.${field}`] = message;
    if (Object.keys(checked.setting).length > 0) settings[marker] = checked.setting;
  }
  // What the defaults refer to: the fields of this body, REF and the profile values. A default that already failed has no text to check.
  const references = checkReferences({
    fields: input.askable.map((marker) => ({ name: marker, label: settings[marker]?.label ?? markerLabel(marker), text: settings[marker]?.default ?? "" })),
    profile: input.profile ?? {},
  });
  for (const [marker, message] of Object.entries(references)) if (errors[`${marker}.default`] === undefined) errors[`${marker}.default`] = message;
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const dropped: string[] = [];
  for (const [marker, row] of submitted) if (!asked.has(marker) && hasContent(row)) dropped.push(marker);
  for (const marker of Object.keys(input.existing)) if (!asked.has(marker) && !dropped.includes(marker)) dropped.push(marker);
  return { ok: true, settings, dropped, rows: variableRows(input.askable, settings) };
}
