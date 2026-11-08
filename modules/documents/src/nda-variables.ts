import type { Profile } from "./profile.ts";
import { validateVariables, variableRows } from "./variable-rules.ts";
import type { VariableKind, VariableSetting, VariableSettings } from "./variables.ts";

/**
 * The labels, help lines, kinds and defaults of the NDA's variables. Pure. The Spanish text is the owner's content,
 * written for the platform. Two kinds of default are carried. Static ones are read from the /nda skill's script, so
 * they do not drift (purpose, counterparty information, data-protection law). Composed ones are what the skill builds
 * from other values, written as references to the fields they use: the counterparty's short name (its name), the
 * introduction (both short names) and the footer (both short names and the reference). The skill's bold on the names
 * is not carried, since a value is plain text. The counterparty's signer is built from a representative and a position
 * that this template does not ask separately, so it has no default and the report says why.
 *
 * `existing` are the settings the template already has. Only the pieces that are still empty are filled (label, help,
 * kind, default, each on its own); a piece that is set is never overwritten.
 */

interface NdaVariable {
  label: string;
  help: string;
  kind: VariableKind;
  /** Why the variable starts empty; absent when it has a default or starts as today's date. */
  noDefault?: string;
}

const NDA_VARIABLES: Record<string, NdaVariable> = {
  B_NOMBRE: {
    label: "Nombre de la contraparte",
    help: "Razón social o nombre completo, tal como debe figurar en el acuerdo.",
    kind: "line",
    noDefault: "the skill has no default: it is the counterparty's own data",
  },
  B_CORTO: {
    label: "Nombre corto de la contraparte",
    help: "Nombre con el que se le llamará en el texto del acuerdo, por ejemplo su marca o nombre comercial.",
    kind: "line",
  },
  B_DATOS: {
    label: "Datos de la contraparte (identificación, domicilio, representante, correo)",
    help: "Escribe una línea por dato: identificación fiscal, domicilio, quién la representa y correo electrónico.",
    kind: "text",
    noDefault: "the skill has no default: it is the counterparty's own data",
  },
  B_INFO: {
    label: "Información que comparte la contraparte",
    help: "Tipo de información confidencial que entregará la contraparte. Completa la frase «De [contraparte]: …».",
    kind: "text",
  },
  B_FIRMANTE: {
    label: "Firmante de la contraparte",
    help: "Nombre y cargo de quien firma por la contraparte, por ejemplo «Ana López · Directora». Si firma en nombre propio, escribe «En nombre propio».",
    kind: "line",
    noDefault: "the skill builds it from the counterparty's representative and position, which the template does not ask separately, so it is typed",
  },
  FINALIDAD: {
    label: "Finalidad de la colaboración",
    help: "Completa la frase «Las partes quieren …». Escríbela en minúscula y sin punto final.",
    kind: "text",
  },
  INTRO: {
    label: "Introducción del acuerdo",
    help: "Párrafo breve al inicio del acuerdo. Menciona a las dos partes por su nombre corto.",
    kind: "text",
  },
  PIE: {
    label: "Texto del pie de página",
    help: "Línea impresa al pie de cada página, por ejemplo «Acme y Beta · Acuerdo de confidencialidad NDA-2026-001».",
    kind: "line",
  },
  FECHA: {
    label: "Fecha de efectos",
    help: "Se escribe en el acuerdo tal como aparece aquí. Empieza con la fecha de hoy.",
    kind: "date",
  },
  LEY_DATOS: {
    label: "Legislación de protección de datos",
    help: "Completa la frase «conforme a …». Si el país de la contraparte es otro, ajusta el texto.",
    kind: "text",
  },
};

/** A piece of a variable's settings, as the import fills them. */
export type SettingPiece = "label" | "help" | "kind" | "default" | "locale";

export interface NdaVariables {
  /** The template's settings after filling: what it had plus the pieces filled now, in the order of `markers`, then any others it had. */
  settings: VariableSettings;
  /** What this run filled, by marker, in the order of `markers`. Empty when nothing was empty. */
  filled: Array<{ marker: string; pieces: SettingPiece[] }>;
  /** Markers whose default was filled now. */
  withDefault: string[];
  /** Markers filled now that start as today's date. */
  today: string[];
  /** Markers asked that have no default, and why. */
  withoutDefault: Array<{ marker: string; reason: string }>;
  /** Defaults that could not be used. They name markers, never values. */
  warnings: string[];
}

const LITERAL = /"([^"\\\n]*)"/g;

/** A module constant of the script made of plain double-quoted literals, adjacent or in parentheses; null for anything else. */
function pythonString(script: string, name: string): string | null {
  const match = new RegExp(`^${name}\\s*=\\s*\\(?\\s*((?:"[^"\\\\\\n]*"\\s*)+)\\)?[ \\t]*$`, "m").exec(script);
  return match ? [...match[1]!.matchAll(LITERAL)].map((literal) => literal[1]).join("") : null;
}

/** The skill's table of data-protection laws by country code. */
function lawTable(script: string): Map<string, string> {
  const block = /^LEYES_DATOS\s*=\s*\{([\s\S]*?)^\}/m.exec(script)?.[1] ?? "";
  return new Map([...block.matchAll(/"([a-z]{2})"\s*:\s*"([^"\\\n]*)"/g)].map((entry) => [entry[1]!, entry[2]!]));
}

/** What the skill's `ley_datos` answers when only the owner's country is known: that country's law and the sentence about the other party. */
function ownerLaw(script: string, ownerCountry: string | undefined): string | null {
  const generic = pythonString(script, "LEY_DATOS_GENERICA");
  if (generic === null) return null;
  const table = lawTable(script);
  const law = table.get((ownerCountry ?? "").trim().toLowerCase());
  if (law === undefined) return table.size > 0 ? generic : null;
  const rest = /return f"\{la or lb\}([^"\\\n]*)"/.exec(script)?.[1];
  return rest === undefined ? null : `${law}${rest}`;
}

/** What the skill composes from other values, written as references. The owner's short name is `ownerShort`, as the skill falls back to the full name. */
function composedDefaults(ownerShort: string): Record<string, string> {
  return {
    B_CORTO: "{{B_NOMBRE}}",
    INTRO: `Antes de compartir información sensible, {{${ownerShort}}} y {{B_CORTO}} dejan por escrito cómo la van a proteger. Las mismas reglas aplican a las dos partes.`,
    PIE: `{{${ownerShort}}} y {{B_CORTO}} · Acuerdo de confidencialidad {{REF}}`,
  };
}

const PIECES: readonly SettingPiece[] = ["label", "help", "kind", "default", "locale"];

export function ndaVariableSettings(input: { script: string; ownerCountry: string | undefined; markers: string[]; profile?: Profile; existing?: VariableSettings }): NdaVariables {
  const profile = input.profile ?? {};
  const existing = input.existing ?? {};
  const scriptDefaults: Record<string, string | null> = {
    FINALIDAD: pythonString(input.script, "FINALIDAD_DEFAULT"),
    B_INFO: pythonString(input.script, "INFO_B_DEFAULT"),
    LEY_DATOS: ownerLaw(input.script, input.ownerCountry),
  };
  const composed = composedDefaults(Object.hasOwn(profile, "A_CORTO") ? "A_CORTO" : "A_NOMBRE");
  const result: NdaVariables = { settings: {}, filled: [], withDefault: [], today: [], withoutDefault: [], warnings: [] };

  // What the NDA wants each of its markers to have, then the pieces of it that the template is still missing.
  const asked = input.markers.filter((marker) => Object.hasOwn(NDA_VARIABLES, marker));
  const filled = new Map<string, Set<SettingPiece>>();
  const merged: VariableSettings = {};
  for (const marker of asked) {
    const known = NDA_VARIABLES[marker]!;
    const wanted: VariableSetting = { label: known.label, help: known.help, kind: known.kind };
    if (known.kind === "date") wanted.locale = "es";
    if (!known.noDefault) {
      if (Object.hasOwn(composed, marker)) wanted.default = composed[marker]!;
      else if (Object.hasOwn(scriptDefaults, marker)) {
        const text = scriptDefaults[marker];
        if (text === null || text === undefined) result.warnings.push(`${marker}: the skill's default could not be read exactly from its script or does not fit the limits, so the variable starts empty.`);
        else wanted.default = text;
      }
    }
    const have = Object.hasOwn(existing, marker) ? existing[marker]! : {};
    const next: VariableSetting = { ...have };
    const pieces = new Set<SettingPiece>();
    for (const piece of PIECES) {
      if (have[piece] !== undefined || wanted[piece] === undefined) continue;
      // The language belongs to a date: it is not filled into a variable the owner made another kind.
      if (piece === "locale" && next.kind !== "date") continue;
      (next as Record<string, unknown>)[piece] = wanted[piece];
      pieces.add(piece);
    }
    merged[marker] = next;
    if (pieces.size > 0) filled.set(marker, pieces);
  }
  for (const [marker, setting] of Object.entries(existing)) if (!Object.hasOwn(merged, marker)) merged[marker] = setting;

  // The same rules that check what the owner saves decide whether a default we fill can stand: its markers must exist in
  // this template and the defaults must not depend on each other in a circle. A filled default that fails is left out.
  for (let attempt = 0; attempt <= asked.length; attempt++) {
    const checked = validateVariables({ askable: input.markers, submitted: variableRows(input.markers, merged), existing: {}, profile });
    if (checked.ok) break;
    const refused = Object.keys(checked.errors)
      .filter((key) => key.endsWith(".default"))
      .map((key) => key.slice(0, -".default".length))
      .filter((marker) => filled.get(marker)?.has("default"));
    if (refused.length === 0) break;
    for (const marker of refused) {
      const { default: _dropped, ...rest } = merged[marker]!;
      merged[marker] = rest;
      filled.get(marker)!.delete("default");
      result.warnings.push(`${marker}: the default could not be used (it does not fit the limits, or uses a marker this template does not have, or would make defaults depend on each other), so the variable starts empty.`);
    }
  }

  result.settings = merged;
  for (const marker of asked) {
    const pieces = [...(filled.get(marker) ?? [])].sort((a, b) => PIECES.indexOf(a) - PIECES.indexOf(b));
    if (pieces.length > 0) {
      result.filled.push({ marker, pieces });
      if (pieces.includes("default")) result.withDefault.push(marker);
      if (merged[marker]!.kind === "date" && merged[marker]!.default === undefined) result.today.push(marker);
    }
    const known = NDA_VARIABLES[marker]!;
    if (known.noDefault && merged[marker]!.default === undefined) result.withoutDefault.push({ marker, reason: known.noDefault });
  }
  return result;
}
