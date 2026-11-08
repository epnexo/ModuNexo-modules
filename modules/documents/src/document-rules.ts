import { listMarkers } from "./markers.ts";
import { PROFILE_FIELDS } from "./profile.ts";
import { parseRowId } from "./row-id.ts";
import { type DateLocale, type VariableKind, type VariableSetting, type VariableSettings, longDate } from "./variables.ts";

/**
 * What the new-document form asks and how an answer is checked. Pure. Every value is plain text: it is
 * HTML-escaped by the marker engine when it goes into the document, never interpreted.
 */

export const SINGLE_LINE_MAX = 200;
export const MULTI_LINE_MAX = 2000;
/** The form field that holds the counterparty name when the template names no marker for it. */
export const COUNTERPARTY_FIELD = "counterpartyName";

/**
 * The rule for a textarea: a marker is a paragraph when one of the words of its name (split on `_`) is in this
 * list, for example INTRO, FINALIDAD, B_INFO or B_DATOS. Every other marker is a single line.
 */
const PARAGRAPH_WORDS = new Set(["INTRO", "INTRODUCTION", "FINALIDAD", "PURPOSE", "INFO", "DATOS", "DETAILS", "TEXTO", "TEXT", "DESCRIPCION", "DESCRIPTION", "NOTAS", "NOTES", "ALCANCE", "SCOPE", "OBJETO"]);

export function isMultiline(marker: string): boolean {
  return marker.split("_").some((word) => PARAGRAPH_WORDS.has(word));
}

/** `B_NOMBRE` as `B nombre`. The raw marker is shown next to it as help. */
export function markerLabel(marker: string): string {
  const words = marker.split("_").filter(Boolean).join(" ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What a variable is for the forms and pages: its settings with the old behavior filling whatever is not set. */
export interface ResolvedVariable {
  label: string;
  /** The owner's help line, or null. */
  help: string | null;
  kind: VariableKind;
  locale: DateLocale;
  /** The value the new-document form starts with. */
  initial: string;
}

/**
 * The one resolution of a variable, used by the new-document form, the detail page and the template page. Label: the
 * setting, else `fallbackLabel` (the readable marker name). Kind: the setting, else the word rule. Initial value: the
 * setting's default; for a date with no default, today's date written out in the variable's locale (Spanish unless set).
 * Without settings the result is what the form showed before settings existed, with an empty initial value.
 */
export function resolveVariable(marker: string, setting: VariableSetting | undefined, now: Date, fallbackLabel: string = markerLabel(marker)): ResolvedVariable {
  const kind = setting?.kind ?? (isMultiline(marker) ? "text" : "line");
  const locale = setting?.locale ?? "es";
  return {
    label: setting?.label ?? fallbackLabel,
    help: setting?.help ?? null,
    kind,
    locale,
    initial: setting?.default ?? (kind === "date" ? longDate(now, locale) : ""),
  };
}

export interface DocumentFieldSpec {
  /** The form field name: the marker, or COUNTERPARTY_FIELD. */
  name: string;
  label: string;
  /** The raw marker note, or null for the counterparty field that has none. */
  help: string | null;
  /** The owner's help line from the template's settings, or null. */
  hint: string | null;
  kind: VariableKind;
  /** A paragraph field (`text`); every other kind is a single line. */
  multiline: boolean;
  /** What the field starts with: the default, today's date for a date, else empty. */
  initial: string;
}

/**
 * The fields of the form: the counterparty name first, then the other variables in the order of the body. `settings` are
 * the template's variable settings; `now` decides the date a date variable starts with.
 */
export function documentFields(variables: string[], counterpartyMarker: string | null, settings: VariableSettings = {}, now: Date = new Date()): DocumentFieldSpec[] {
  const marker = counterpartyMarker !== null && variables.includes(counterpartyMarker) ? counterpartyMarker : null;
  const field = (name: string, fallbackLabel: string): DocumentFieldSpec => {
    const resolved = resolveVariable(name, Object.hasOwn(settings, name) ? settings[name] : undefined, now, fallbackLabel);
    return { name, label: resolved.label, help: `Marker {{${name}}}`, hint: resolved.help, kind: resolved.kind, multiline: resolved.kind === "text", initial: resolved.initial };
  };
  return [
    marker === null ? { name: COUNTERPARTY_FIELD, label: "Counterparty name", help: null, hint: null, kind: "line", multiline: false, initial: "" } : field(marker, "Counterparty name"),
    ...variables.filter((name) => name !== marker).map((name) => field(name, markerLabel(name))),
  ];
}

/**
 * The labels of what a text uses when the document is created, in order of first appearance and once each: the other
 * fields of the form by their label, a profile marker the profile has a value for by its profile label, and `REF`. A group
 * that names none of these is not a reference and is not listed. `profileKeys` are the keys the owner profile has a value for.
 */
export function fieldUses(text: string, fields: DocumentFieldSpec[], profileKeys: string[]): string[] {
  const labels: string[] = [];
  for (const name of listMarkers(text)) {
    const field = fields.find((candidate) => candidate.name === name);
    if (field) labels.push(field.label);
    else if (name === "REF") labels.push("the document number");
    else if (profileKeys.includes(name)) labels.push(`${PROFILE_FIELDS.find((profileField) => profileField.key === name)?.label ?? name} (profile)`);
  }
  return [...new Set(labels)];
}

export type DocumentValidation =
  | { ok: true; counterpartyName: string; values: Record<string, string> }
  | { ok: false; errors: Record<string, string>; values: Record<string, string> };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** Check the answers for the fields asked. Anything else in `raw` is ignored. `values` is what was entered, trimmed, to show again. */
export function validateDocumentValues(fields: DocumentFieldSpec[], counterpartyMarker: string | null, raw: Record<string, string | undefined>): DocumentValidation {
  const errors: Record<string, string> = {};
  const entered: Record<string, string> = {};
  for (const field of fields) {
    const given = Object.hasOwn(raw, field.name) ? raw[field.name] : undefined;
    const value = (typeof given === "string" ? given : "").replaceAll("\r\n", "\n").trim();
    entered[field.name] = value;
    const max = field.multiline ? MULTI_LINE_MAX : SINGLE_LINE_MAX;
    if (value === "") errors[field.name] = `Enter ${field.label.toLowerCase()}.`;
    else if (value.length > max) errors[field.name] = `Use at most ${max} characters.`;
    else if (CONTROL.test(value)) errors[field.name] = "Remove the control characters.";
    else if (!field.multiline && value.includes("\n")) errors[field.name] = "Use a single line.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors, values: entered };

  // The name comes from the marker when there is one, else from the field of its own; the arguments must agree on which.
  const nameField = counterpartyMarker ?? COUNTERPARTY_FIELD;
  if (!Object.hasOwn(entered, nameField)) return { ok: false, errors: { [nameField]: "Enter the counterparty name." }, values: entered };
  const counterpartyName = entered[nameField]!;
  const { [COUNTERPARTY_FIELD]: _name, ...values } = entered;
  return { ok: true, counterpartyName, values };
}

/** The id of a document from a URL segment. */
export const parseDocumentId = parseRowId;
