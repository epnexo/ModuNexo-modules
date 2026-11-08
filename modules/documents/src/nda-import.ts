import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { listMarkers, splitMarkers } from "./markers.ts";
import { type SettingPiece, ndaVariableSettings } from "./nda-variables.ts";
import { type PortedPart, portNda } from "./nda-port.ts";
import { addMissingProfileKeys, getProfile } from "./profile-store.ts";
import { createTemplate, getTemplateBySlug, lockVariables, setVariables } from "./template-store.ts";
import { type Transactional, inTransaction } from "./transaction.ts";

/**
 * The explicit NDA import: read the skill's template, config and script, port them, and store what is not there yet.
 * It never overwrites: a template that exists, edited or archived, keeps its body and every column, and the profile
 * only gains the keys it does not have. The one thing it adds to an existing template is the pieces of its variable
 * settings that are still empty (label, help, kind, default, each on its own); a piece that is set is never
 * overwritten, so the import can be run again and does nothing the second time.
 */

/**
 * What happened to the template's variable settings: `set` (a new template was created with them), `filled` (an existing
 * template had empty pieces and this run filled them), `kept` (nothing was empty, or the settings changed meanwhile)
 * or `none` (the template asks for none of the NDA's markers, so nothing was written).
 */
export interface VariablesReport {
  status: "set" | "filled" | "kept" | "none";
  /** Markers that got settings or pieces of them. */
  count: number;
  /** What was filled, by marker and piece. */
  filled: Array<{ marker: string; pieces: SettingPiece[] }>;
  withDefault: string[];
  today: string[];
  withoutDefault: Array<{ marker: string; reason: string }>;
  warnings: string[];
}

export interface ImportReport {
  template: { status: "created" | "unchanged"; id?: number };
  variables: VariablesReport;
  /** Profile keys added by this run. Names only. */
  profileAdded: string[];
  parts: PortedPart[];
  warnings: string[];
  changed: boolean;
}

/** A file of the skill folder by its path inside it. The error names that path, never the folder. */
async function readSkillFile(dir: string, relative: string, optional = false): Promise<string> {
  try {
    return await readFile(join(dir, relative), "utf8");
  } catch (error) {
    if (optional && (error as { code?: string }).code === "ENOENT") return "";
    throw new Error(`Cannot read ${relative} in the skill folder.`, { cause: error });
  }
}

export async function importNda(db: Transactional, skillDir: string): Promise<ImportReport> {
  const templateHtml = await readSkillFile(skillDir, "templates/nda.html");
  const configText = await readSkillFile(skillDir, "config.json");
  const script = await readSkillFile(skillDir, "scripts/nda.py", true);
  let config: unknown;
  try {
    config = JSON.parse(configText);
  } catch {
    throw new Error("config.json in the skill folder is not valid JSON.");
  }

  const ported = portNda({ templateHtml, script, config });
  // One transaction: a failure in any write leaves none of them behind.
  const done = await inTransaction(db, async (tx) => {
    const profileAdded = await addMissingProfileKeys(tx, ported.profile);
    const profile = await getProfile(tx);
    // The settings are for the markers the template asks per document: the body it already has, else the one being created.
    const existing = await getTemplateBySlug(tx, ported.template.slug);
    const markers = splitMarkers(listMarkers(existing?.bodyHtml ?? ported.template.bodyHtml), profile).perDocument;
    const build = (have: Parameters<typeof ndaVariableSettings>[0]["existing"]) => ndaVariableSettings({ script, ownerCountry: profile.A_PAIS, markers, profile, existing: have });

    let created: Awaited<ReturnType<typeof createTemplate>> | null = null;
    let target = existing;
    let built = build({});
    let status: VariablesReport["status"] = "none";
    if (!target) {
      created = await createTemplate(tx, ported.template, built.settings);
      if (!created.ok) target = await getTemplateBySlug(tx, ported.template.slug);
      else status = built.filled.length > 0 ? "set" : "none";
    }
    if (!created?.ok && target) {
      // The row is locked while its settings are read and written, so a save from the web cannot be lost in between.
      const current = await lockVariables(tx, target.id);
      built = build(current ?? {});
      if (built.filled.length === 0) status = markers.some((marker) => Object.hasOwn(built.settings, marker)) ? "kept" : "none";
      else status = (await setVariables(tx, target.id, built.settings)) ? "filled" : "kept";
    }
    return { created, profileAdded, built, status };
  });

  const { created, profileAdded, built, status } = done;
  const reported = status === "set" || status === "filled";
  return {
    template: created?.ok ? { status: "created", id: created.id } : { status: "unchanged" },
    variables: {
      status,
      count: reported ? built.filled.length : 0,
      filled: reported ? built.filled : [],
      withDefault: reported ? built.withDefault : [],
      today: reported ? built.today : [],
      withoutDefault: reported ? built.withoutDefault : [],
      warnings: reported ? built.warnings : [],
    },
    profileAdded,
    parts: ported.parts,
    warnings: ported.warnings,
    changed: Boolean(created?.ok) || profileAdded.length > 0 || reported,
  };
}

/** The lines the command prints. They carry template and key names and the treatment of each part, no owner values. */
export function formatImportReport(report: ImportReport): string[] {
  const lines = [
    report.template.status === "created" ? `Template nda: created (id ${report.template.id}).` : "Template nda: already exists, left as it is.",
    ...formatVariables(report.variables),
    report.profileAdded.length > 0 ? `Profile: added ${report.profileAdded.length} keys (${report.profileAdded.join(", ")}).` : "Profile: no keys added, every key was already there.",
    "Computed parts of the skill's NDA:",
    ...report.parts.map((part) => `  - ${part.part} [${part.how}]: ${part.treatment}`),
  ];
  if (report.warnings.length > 0) lines.push("Notes:", ...report.warnings.map((warning) => `  - ${warning}`));
  if (!report.changed) lines.push("Nothing changed.");
  return lines;
}

/** The lines about the variable settings: marker names, pieces and reasons only, never a value. */
function formatVariables(variables: VariablesReport): string[] {
  if (variables.status === "kept") return ["Variables: nothing was empty, the settings were left as they are."];
  if (variables.status === "none") return ["Variables: nothing to set, the template asks for none of the NDA's markers."];
  const lines =
    variables.status === "set"
      ? [`Variables: set for ${variables.count} markers.`]
      : [`Variables: filled the empty settings of ${variables.count} markers.`, ...variables.filled.map((entry) => `  - ${entry.marker}: ${entry.pieces.join(", ")}`)];
  if (variables.withDefault.length > 0) lines.push(`  defaults filled: ${variables.withDefault.join(", ")}`);
  if (variables.today.length > 0) lines.push(`  starts with today's date: ${variables.today.join(", ")}`);
  if (variables.withoutDefault.length > 0) lines.push("  start empty:", ...variables.withoutDefault.map((entry) => `    - ${entry.marker}: ${entry.reason}`));
  if (variables.warnings.length > 0) lines.push(...variables.warnings.map((warning) => `  note: ${warning}`));
  return lines;
}

export function parseImportArgs(argv: string[]): { skillDir: string } {
  let skillDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--skill-dir") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("--skill-dir needs a folder.");
      skillDir = value;
    } else if (arg.startsWith("--skill-dir=")) {
      skillDir = arg.slice("--skill-dir=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!skillDir) throw new Error("Pass the skill folder: --skill-dir <path>.");
  return { skillDir: skillDir === "~" ? homedir() : skillDir.startsWith("~/") ? join(homedir(), skillDir.slice(2)) : skillDir };
}
