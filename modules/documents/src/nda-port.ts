import { escapeHtml, listMarkers } from "./markers.ts";
import { type Profile, validateProfile } from "./profile.ts";
import { type TemplateInput, validateTemplate } from "./template-rules.ts";

/**
 * Port the NDA of the /nda skill into a template and an owner profile. Pure: it takes the text of the skill's
 * template, the text of its script (for the one clause that lives there) and its parsed config, and returns what
 * to store. Parts the skill computes in Python are either resolved here into fixed text, because they depend only
 * on the owner's configuration, or left as ordinary markers, because they depend on the counterparty or on the
 * single document. Nothing here adds logic to the template language.
 */

export interface PortedPart {
  part: string;
  how: "import" | "profile" | "document" | "left out";
  treatment: string;
}

export interface PortResult {
  body: string;
  template: TemplateInput;
  profile: Profile;
  parts: PortedPart[];
  /** Notes for the person running the import. They name keys and parts, never owner values. */
  warnings: string[];
}

const DEFAULT_COLOR = "#2563eb";
const DEFAULT_FONTS = ["NDA Sans", "Inter", "Helvetica Neue", "Arial", "Liberation Sans", "DejaVu Sans"];
/** Defaults the skill applies when the config leaves a term out. */
const TERM_DEFAULTS = { dias_negociacion: 30, meses_cobertura: 12, anos_confidencialidad: 3, dias_devolucion: 10 };
const EXAMPLE_COMPANY = "Mi Empresa";
const COUNTERPARTY_MARKER = "B_NOMBRE";
const DATOS_RULE = ".parte .datos { ";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Json => (isRecord(value) ? value : {});
/** Owner text fixed into the body: HTML-escaped, and its braces written as entities so `{{X}}` in it can never become a live marker. */
const fixed = (value: string): string => escapeHtml(value).replaceAll("{", "&#123;");
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

/** Replace every occurrence of one marker, taking the replacement literally. */
const fill = (body: string, name: string, value: string) => body.split(`{{${name}}}`).join(value);

function readClause(script: string): string {
  const match = script.match(/CLAUSULA_CONOCIMIENTO\s*=\s*"""([\s\S]*?)"""/);
  if (!match || match[1]!.includes("\\")) {
    throw new Error("Could not read the optional clause from the skill's script. The import stops instead of building a different document.");
  }
  return match[1]!;
}

function ownerCard(owner: Json): { datos: string; firmante: string } {
  const rep = text(owner.representante);
  const cargo = text(owner.cargo);
  const who = rep ? `Representada por ${fixed(rep)}${cargo ? `, ${fixed(cargo)}` : ""}` : "Actúa en nombre propio";
  const lines = [fixed(text(owner.linea_id)), fixed(text(owner.domicilio)), who, fixed(text(owner.email))];
  return { datos: lines.filter(Boolean).join("<br>"), firmante: rep ? `${fixed(rep)}${cargo ? ` · ${fixed(cargo)}` : ""}` : "En nombre propio" };
}

function prefixFrom(value: unknown): string {
  const letters = text(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return letters || "NDA";
}

export function portNda(input: { templateHtml: string; script: string; config: unknown }): PortResult {
  const { config } = input;
  if (!isRecord(config)) throw new Error("The config must be a JSON object.");
  if (!isRecord(config.mi_empresa)) throw new Error("The config has no mi_empresa section.");
  const owner = config.mi_empresa;
  const brand = record(config.marca);
  const doc = record(config.documento);
  const terms = record(config.terminos);
  const warnings: string[] = [];
  const parts: PortedPart[] = [];

  if (!text(owner.nombre)) throw new Error("The config has no mi_empresa.nombre (the company name).");
  if (!text(owner.email)) throw new Error("The config has no mi_empresa.email.");
  if (text(owner.nombre).startsWith(EXAMPLE_COMPANY)) throw new Error("The config still has the example data. Fill in the owner's own data first.");

  let body = input.templateHtml;

  // Optional clause and the numbering that follows it: they depend only on the owner's config, so they become fixed text.
  const flag = terms.clausula_conocimiento_general;
  const withClause = flag === undefined ? true : Boolean(flag);
  body = fill(body, "CLAUSULA_CONOCIMIENTO", withClause ? readClause(input.script) : "");
  const first = withClause ? 9 : 8;
  ["N_DEVOLUCION", "N_DURACION", "N_INCUMPLIMIENTO", "N_LEY", "N_FINALES"].forEach((name, index) => {
    body = fill(body, name, String(first + index));
  });
  parts.push(
    { part: "Optional clause", how: "import", treatment: `Written into the template as fixed text because the config turns it ${withClause ? "on" : "off"}. Change it by editing the template.` },
    { part: "Clause numbering", how: "import", treatment: `Fixed numbers from ${first}, which follow from the optional clause. Renumber by editing the template.` },
  );

  // Font stack: computed from the owner's configured font and a fixed list of fallbacks.
  let font = text(brand.fuente);
  if (font && /["\\<>{};\u0000-\u001f]/.test(font)) {
    warnings.push("The brand font name has characters that are not allowed in a font family and was ignored.");
    font = "";
  }
  body = fill(body, "FUENTE", `${[font, ...DEFAULT_FONTS].filter(Boolean).map((name) => `"${name}"`).join(", ")}, sans-serif`);
  parts.push({ part: "Font stack", how: "import", treatment: "Fixed text in the template: the configured font name, if any, then the skill's fallbacks. The font file itself is not carried." });

  // Logo: an image embedded as base64 is not text.
  body = fill(body, "LOGO", "");
  if (text(brand.logo)) warnings.push("The config names a logo. It is not carried: images need upload handling that this import does not have.");
  parts.push({ part: "Logo", how: "left out", treatment: "Not carried: the skill embeds an image file as base64, and there is no upload handling yet. The marker is removed from the template." });

  // Owner card and signer line: lines joined with <br>, the empty ones skipped. Owner-only, so fixed HTML built here.
  const card = ownerCard(owner);
  body = fill(body, "A_DATOS", card.datos);
  body = fill(body, "A_FIRMANTE", card.firmante);
  parts.push({ part: "Owner card and signer line", how: "import", treatment: "Fixed text built from the config (lines joined, empty ones skipped). Changing the profile later does not change them; edit the template." });

  // The counterparty card is a marker whose value carries line breaks; the template CSS lets newlines break lines.
  if (body.includes(DATOS_RULE)) body = body.replace(DATOS_RULE, `${DATOS_RULE}white-space: pre-line; `);
  else warnings.push("The counterparty card rule (.parte .datos) was not found, so line breaks in its value will not show.");

  parts.push(
    { part: "Page size", how: "profile", treatment: "Marker PAGINA, filled from the profile (A4 or letter)." },
    { part: "Accent color", how: "profile", treatment: "Marker COLOR, filled from the profile." },
    { part: "Counterparty card", how: "document", treatment: "Marker B_DATOS, asked per document: one line per entry, separated by newlines (the template CSS breaks lines on them). Its signer line is B_FIRMANTE." },
    { part: "Data-protection law", how: "document", treatment: "Marker LEY_DATOS, asked per document: it depends on both parties' countries, so the template carries no table. The variable settings propose the law of the owner's country as the skill does without a counterparty country." },
    { part: "Footer text", how: "document", treatment: "Marker PIE, asked per document. It sits inside a CSS string, where HTML escaping shows characters such as & as entities." },
    { part: "Introduction", how: "document", treatment: "Marker INTRO, asked per document. The skill's default sentence is built from both short names, so the variable settings give it no default." },
    { part: "Default texts (purpose, counterparty information)", how: "document", treatment: "Markers FINALIDAD and B_INFO, asked per document. The variable settings start them with the skill's default wording." },
    { part: "Effective date", how: "document", treatment: "Marker FECHA, asked per document. The variable settings make it a date that starts as today written in Spanish words, as the skill does." },
  );

  // Profile: what the config holds that a template can use, checked by the same rules as the profile form.
  const term = (key: keyof typeof TERM_DEFAULTS) => (terms[key] === undefined ? String(TERM_DEFAULTS[key]) : text(terms[key]));
  const raw: Record<string, string> = {
    A_NOMBRE: text(owner.nombre),
    A_CORTO: text(owner.corto),
    A_LINEA_ID: text(owner.linea_id),
    A_DOMICILIO: text(owner.domicilio),
    A_CIUDAD: text(owner.ciudad),
    A_PAIS: text(owner.pais),
    A_EMAIL: text(owner.email),
    A_REPRESENTANTE: text(owner.representante),
    A_CARGO: text(owner.cargo),
    A_INFO: text(config.lo_que_comparto),
    COLOR: text(brand.color) || DEFAULT_COLOR,
    PAGINA: text(doc.pagina).toLowerCase() === "a4" ? "A4" : "letter",
    LEY_APLICABLE: text(terms.ley_aplicable),
    TRIBUNALES: text(terms.tribunales),
    DIAS_NEGOCIACION: term("dias_negociacion"),
    MESES: term("meses_cobertura"),
    ANOS: term("anos_confidencialidad"),
    DIAS_DEVOLUCION: term("dias_devolucion"),
  };
  let checked = validateProfile(raw);
  for (let attempt = 0; !checked.ok && attempt < 2; attempt++) {
    for (const [key, message] of Object.entries(checked.errors)) {
      if (key === "A_NOMBRE" || key === "A_EMAIL") throw new Error(`The config's ${key === "A_EMAIL" ? "mi_empresa.email" : "mi_empresa.nombre"} is not valid. ${message}`);
      if (key === "COLOR") {
        warnings.push(`COLOR: the configured value is not valid, the skill default is used. ${message}`);
        raw.COLOR = DEFAULT_COLOR;
      } else {
        warnings.push(`${key}: not imported. ${message}`);
        raw[key] = "";
      }
    }
    checked = validateProfile(raw);
  }
  if (!checked.ok) throw new Error("The profile derived from the config is not valid.");

  // The counterparty's name is the marker B_NOMBRE of the skill's template.
  const counterpartyMarker = listMarkers(body).includes(COUNTERPARTY_MARKER) ? COUNTERPARTY_MARKER : "";
  const candidate = validateTemplate({ name: "Mutual NDA", slug: "nda", kind: "nda", refPrefix: prefixFrom(doc.prefijo), bodyHtml: body, counterpartyMarker });
  if (!candidate.ok) throw new Error(`The ported template is not valid: ${Object.values(candidate.errors).join(" ")}`);

  return { body: candidate.value.bodyHtml, template: candidate.value, profile: checked.set, parts, warnings };
}
