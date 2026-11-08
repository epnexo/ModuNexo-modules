/**
 * The settings a template keeps for its variables: a label, a help line, a kind and a default value for the markers
 * asked per document. Types, limits and the tolerant reader of what the database holds. The rules that check a
 * submission are in `variable-rules.ts`; the resolution the forms and pages share is `resolveVariable` in `document-rules.ts`.
 */

export const VARIABLE_KINDS = ["line", "text", "date"] as const;
export type VariableKind = (typeof VARIABLE_KINDS)[number];

export const DATE_LOCALES = ["es", "en"] as const;
export type DateLocale = (typeof DATE_LOCALES)[number];

export const LABEL_MAX = 80;
export const HELP_MAX = 200;

/** Every field is optional: a missing one means "not set", and the variable behaves as it did before settings existed. */
export interface VariableSetting {
  label?: string;
  help?: string;
  kind?: VariableKind;
  default?: string;
  /** Only for `kind: "date"`. */
  locale?: DateLocale;
}

/** Marker name to its settings. The empty object is a template without settings. */
export type VariableSettings = Record<string, VariableSetting>;

const MARKER_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Read what the database holds. The column only guarantees a JSON object, so everything else is checked here: an
 * entry the application would not have written (odd marker name, wrong type, unknown field) is skipped rather than trusted.
 */
export function parseVariableSettings(value: unknown): VariableSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const settings: VariableSettings = {};
  for (const [marker, entry] of Object.entries(value)) {
    if (!MARKER_NAME.test(marker) || typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;
    const setting: VariableSetting = {};
    for (const key of ["label", "help", "default"] as const) {
      const text = source[key];
      if (typeof text === "string" && text !== "") setting[key] = text;
    }
    if ((VARIABLE_KINDS as readonly unknown[]).includes(source.kind)) setting.kind = source.kind as VariableKind;
    if ((DATE_LOCALES as readonly unknown[]).includes(source.locale)) setting.locale = source.locale as DateLocale;
    if (Object.keys(setting).length > 0) settings[marker] = setting;
  }
  return settings;
}

const MONTHS: Record<DateLocale, readonly string[]> = {
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};

/**
 * Today's date written out long: `12 de octubre de 2026` (es, the skill's own format) or `October 12, 2026` (en).
 * It reads the calendar fields of `now` in the server's local time zone, not UTC: the owner's day is the day on the
 * machine's clock, and a document made at 22:00 local time must not carry tomorrow's date. The month names are
 * tables here so the text does not depend on the ICU data of the runtime.
 */
export function longDate(now: Date, locale: DateLocale): string {
  const month = MONTHS[locale][now.getMonth()]!;
  return locale === "es" ? `${now.getDate()} de ${month} de ${now.getFullYear()}` : `${month} ${now.getDate()}, ${now.getFullYear()}`;
}
