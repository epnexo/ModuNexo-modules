/**
 * The owner profile: company data, branding and default terms, stored once as a flat map of marker name to
 * text. Any template can use any key as a marker. The keys below are the ones the form edits; they use the
 * marker names of the NDA template so that template fills without rewriting.
 */

/** Marker name to text. Blank values are never stored: a key is either set or absent. */
export type Profile = Record<string, string>;

export type FieldKind = "text" | "textarea" | "email" | "color" | "page" | "integer" | "country";

export interface ProfileField {
  key: string;
  label: string;
  kind: FieldKind;
  section: string;
  required?: boolean;
  help?: string;
}

export const PROFILE_SECTIONS = [
  { id: "company", title: "Company" },
  { id: "representative", title: "Representative" },
  { id: "content", title: "What you share" },
  { id: "branding", title: "Branding", note: "The logo and the font are not editable here yet." },
  { id: "terms", title: "Default terms" },
] as const;

export const PROFILE_FIELDS: ProfileField[] = [
  { key: "A_NOMBRE", label: "Company name", kind: "text", section: "company", required: true, help: "Legal name as it appears in the document." },
  { key: "A_CORTO", label: "Short name", kind: "text", section: "company", help: "Used where the document names a party briefly." },
  { key: "A_LINEA_ID", label: "Tax or registration line", kind: "text", section: "company" },
  { key: "A_DOMICILIO", label: "Address", kind: "text", section: "company" },
  { key: "A_CIUDAD", label: "City and country", kind: "text", section: "company" },
  { key: "A_PAIS", label: "Country code", kind: "country", section: "company", help: "Two letters, for example au or do." },
  { key: "A_EMAIL", label: "Email", kind: "email", section: "company", required: true },
  { key: "A_REPRESENTANTE", label: "Representative", kind: "text", section: "representative", help: "Leave blank when you sign on your own behalf." },
  { key: "A_CARGO", label: "Position", kind: "text", section: "representative" },
  { key: "A_INFO", label: "Information you share", kind: "textarea", section: "content", help: "Completes the sentence that lists your confidential information." },
  { key: "COLOR", label: "Accent color", kind: "color", section: "branding", help: "Six-digit hex value starting with #." },
  { key: "PAGINA", label: "Page size", kind: "page", section: "branding" },
  { key: "LEY_APLICABLE", label: "Governing law", kind: "text", section: "terms" },
  { key: "TRIBUNALES", label: "Courts", kind: "text", section: "terms" },
  { key: "DIAS_NEGOCIACION", label: "Days to negotiate a dispute", kind: "integer", section: "terms" },
  { key: "MESES", label: "Months of coverage", kind: "integer", section: "terms" },
  { key: "ANOS", label: "Years of confidentiality", kind: "integer", section: "terms" },
  { key: "DIAS_DEVOLUCION", label: "Business days to return information", kind: "integer", section: "terms" },
];

export const PAGE_SIZES = ["A4", "letter"] as const;

const TEXT_MAX = 200;
const TEXTAREA_MAX = 2000;
const EMAIL_MAX = 254;

/** An address like name@example.com: no spaces, one `@`, a dotted domain, at most 254 characters. */
export const isEmailAddress = (value: string): boolean => value.length <= EMAIL_MAX && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);

export interface ProfileInvalid {
  ok: false;
  errors: Record<string, string>;
  /** What was entered, normalised only by trimming, so the form can show it again. */
  values: Record<string, string>;
}

export interface ProfileValid {
  ok: true;
  /** Keys to write. */
  set: Profile;
  /** Form keys left blank, to remove from the stored profile. */
  remove: string[];
}

/** The problem with one non-blank value, or the value to store. */
function check(field: ProfileField, value: string): { error: string } | { value: string } {
  switch (field.kind) {
    case "text":
      return value.length > TEXT_MAX ? { error: `Use at most ${TEXT_MAX} characters.` } : { value };
    case "textarea":
      return value.length > TEXTAREA_MAX ? { error: `Use at most ${TEXTAREA_MAX} characters.` } : { value };
    case "email":
      return isEmailAddress(value) ? { value } : { error: "Enter an email address like name@example.com." };
    case "color":
      return /^#[0-9a-fA-F]{6}$/.test(value) ? { value: value.toLowerCase() } : { error: "Use a six-digit hex color starting with #." };
    case "page":
      return (PAGE_SIZES as readonly string[]).includes(value) ? { value } : { error: "Choose A4 or letter." };
    case "integer":
      return /^[0-9]{1,3}$/.test(value) && Number(value) >= 1 ? { value: String(Number(value)) } : { error: "Enter a whole number from 1 to 999." };
    case "country":
      return /^[A-Za-z]{2}$/.test(value) ? { value: value.toLowerCase() } : { error: "Use a two-letter country code." };
  }
}

const REQUIRED_MESSAGE: Record<string, string> = {
  A_NOMBRE: "Enter the company name.",
  A_EMAIL: "Enter an email address.",
};

/** Validate the submitted form. Keys that are not profile fields are ignored. */
export function validateProfile(raw: Record<string, string | undefined>): ProfileValid | ProfileInvalid {
  const set: Profile = {};
  const remove: string[] = [];
  const errors: Record<string, string> = {};
  const values: Record<string, string> = {};

  for (const field of PROFILE_FIELDS) {
    const entered = (raw[field.key] ?? "").replaceAll("\r\n", "\n").trim();
    values[field.key] = entered;
    if (entered === "") {
      if (field.required) errors[field.key] = REQUIRED_MESSAGE[field.key] ?? "This field is required.";
      else remove.push(field.key);
      continue;
    }
    const checked = check(field, entered);
    if ("error" in checked) errors[field.key] = checked.error;
    else set[field.key] = checked.value;
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors, values } : { ok: true, set, remove };
}
