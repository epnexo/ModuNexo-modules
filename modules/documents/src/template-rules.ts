import { TEMPLATE_KINDS, type TemplateKind } from "../web/queries.ts";
import { PLATFORM_MARKERS, listMarkers } from "./markers.ts";
import { parseRowId } from "./row-id.ts";

/** Largest template body accepted, in characters. */
export const BODY_MAX = 200_000;
const NAME_MAX = 120;
const SLUG_MAX = 60;
const PREFIX_MAX = 10;

export interface TemplateInput {
  name: string;
  slug: string;
  kind: TemplateKind;
  refPrefix: string;
  bodyHtml: string;
  /** The marker whose value is the counterparty's name, or null when the form asks for the name on its own. */
  counterpartyMarker: string | null;
}

export type TemplateField = keyof TemplateInput;

export interface TemplateInvalid {
  ok: false;
  errors: Partial<Record<TemplateField, string>>;
  /** What was entered, so the form can show it again. */
  values: Record<TemplateField, string>;
}

/** A template as the form shows it: every field as text, no marker as an empty string. */
export function templateFormValues(template: TemplateInput): Record<TemplateField, string> {
  return {
    name: template.name,
    slug: template.slug,
    kind: template.kind,
    refPrefix: template.refPrefix,
    bodyHtml: template.bodyHtml,
    counterpartyMarker: template.counterpartyMarker ?? "",
  };
}

export interface TemplateValid {
  ok: true;
  value: TemplateInput;
}

/**
 * Validate a submitted template form. Pure: uniqueness of the slug is a database matter and is checked where the
 * row is written. Name, slug, kind and prefix are trimmed; the body is kept as typed apart from its line breaks.
 */
export function validateTemplate(raw: Record<string, string | undefined>): TemplateValid | TemplateInvalid {
  const text = (key: TemplateField) => (raw[key] ?? "").trim();
  const values: Record<TemplateField, string> = {
    name: text("name"),
    slug: text("slug"),
    kind: text("kind"),
    refPrefix: text("refPrefix"),
    bodyHtml: (raw.bodyHtml ?? "").replaceAll("\r\n", "\n"),
    counterpartyMarker: text("counterpartyMarker"),
  };
  const errors: TemplateInvalid["errors"] = {};

  if (values.name === "") errors.name = "Enter a name.";
  else if (values.name.length > NAME_MAX) errors.name = `Use at most ${NAME_MAX} characters.`;

  if (values.slug === "") errors.slug = "Enter a slug.";
  else if (values.slug.length > SLUG_MAX || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.slug)) {
    errors.slug = `Use lowercase letters and digits separated by single hyphens, at most ${SLUG_MAX} characters.`;
  }

  if (!(TEMPLATE_KINDS as readonly string[]).includes(values.kind)) errors.kind = "Choose a kind.";

  if (values.refPrefix === "") errors.refPrefix = "Enter a numbering prefix.";
  else if (!/^[A-Z0-9]+$/.test(values.refPrefix) || values.refPrefix.length > PREFIX_MAX) {
    errors.refPrefix = `Use uppercase letters and digits only, at most ${PREFIX_MAX} characters.`;
  }

  if (values.bodyHtml.trim() === "") errors.bodyHtml = "Enter the template body.";
  else if (values.bodyHtml.length > BODY_MAX) errors.bodyHtml = `Use at most ${BODY_MAX.toLocaleString("en-US")} characters.`;

  if (values.counterpartyMarker !== "" && (PLATFORM_MARKERS.includes(values.counterpartyMarker) || !listMarkers(values.bodyHtml).includes(values.counterpartyMarker))) {
    errors.counterpartyMarker = "Choose one of the markers in the body, or none.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, values };
  return { ok: true, value: { ...values, kind: values.kind as TemplateKind, counterpartyMarker: values.counterpartyMarker || null } };
}

/** A template id from a form field or a URL segment. */
export const parseTemplateId = parseRowId;
