import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { takeNumber } from "./counter-store.ts";
import { COUNTERPARTY_FIELD, type DocumentFieldSpec, documentFields, validateDocumentValues } from "./document-rules.ts";
import { findDocumentIdByRef, insertGeneratedDocument } from "./document-store.ts";
import { ensureDir, moveIntoPlace, pdfFileName, removeQuietly } from "./file-store.ts";
import { buildDocumentHtml } from "./document-html.ts";
import { listMarkers, splitMarkers } from "./markers.ts";
import { formatReference } from "./reference.ts";
import type { PdfEngine, RenderFailure } from "./pdf-engine.ts";
import type { VariableSettings } from "./variables.ts";
import { getProfile } from "./profile-store.ts";
import { getTemplate } from "./template-store.ts";
import { type Transactional, inTransaction } from "./transaction.ts";
import { resolveValues } from "./value-references.ts";

/**
 * Create a document from a template: check the answers, then in one transaction take the number, render the PDF,
 * insert the row and put the file in place. Any failure rolls the transaction back and removes the files, so there
 * is no half-created document, no orphan file and no consumed number.
 *
 * One case needs a decision: the commit itself fails after the file was moved into place. If the server refused it
 * (the error carries an SQLSTATE code) the transaction is rolled back and the file goes. If the connection died with
 * no answer, the commit may have happened anyway (pg reports only that the connection ended), so the row is looked up
 * by its reference: found, the document exists and the file stays; not found, the file goes; unknown (the lookup fails
 * too), the file stays. A file without a row is harmless and rebuildable; a row without its file is a broken document.
 */

export interface CreateDeps {
  db: Transactional;
  engine: PdfEngine;
  /** The documents folder; created on demand. */
  dir: string;
  now?: () => Date;
}

export type CreateResult =
  | { ok: true; id: number; ref: string }
  | { ok: false; kind: "template-unavailable" }
  | { ok: false; kind: "invalid"; errors: Record<string, string>; values: Record<string, string> }
  | { ok: false; kind: "render"; reason: RenderFailure }
  /** The body still has markers without a value after the form was checked. Not expected: the checks and the substitution read the same lists. */
  | { ok: false; kind: "unfilled"; markers: string[] };

/** Thrown inside the transaction to roll it back when the engine reports a failure. */
class RenderRefused extends Error {
  constructor(readonly reason: RenderFailure) {
    super(`render refused: ${reason}`);
  }
}

/** Thrown inside the transaction, after the number was taken, when the values that use other fields cannot be resolved. */
class Unresolved extends Error {
  constructor(readonly errors: Record<string, string>) {
    super("the values could not be resolved");
  }
}

class Unfilled extends Error {
  constructor(readonly markers: string[]) {
    super("a marker has no value");
  }
}

/** True for an error the server sent back with its SQLSTATE: the statement was refused, so nothing was committed. */
const refusedByServer = (error: unknown) => /^[0-9A-Z]{5}$/.test(String((error as { code?: unknown } | null)?.code));

/**
 * The fields a template asks for a new document: its per-document markers, with the counterparty name first, labelled
 * and started from the template's variable settings. `now` decides the date a date variable starts with.
 */
export function fieldsForTemplate(
  body: string,
  chosenMarker: string | null,
  profile: Record<string, string>,
  settings: VariableSettings = {},
  now: Date = new Date(),
): { fields: DocumentFieldSpec[]; counterpartyMarker: string | null; fromProfile: string[] } {
  const groups = splitMarkers(listMarkers(body), profile);
  // A choice that is no longer a per-document marker (the body or the profile changed) falls back to the separate field.
  const counterpartyMarker = chosenMarker !== null && groups.perDocument.includes(chosenMarker) ? chosenMarker : null;
  return { fields: documentFields(groups.perDocument, counterpartyMarker, settings, now), counterpartyMarker, fromProfile: groups.fromProfile };
}

export async function createDocument(deps: CreateDeps, input: { templateId: number; fields: Record<string, string | undefined> }): Promise<CreateResult> {
  const template = await getTemplate(deps.db, input.templateId);
  if (!template || template.archivedAt !== null) return { ok: false, kind: "template-unavailable" };
  const profile = await getProfile(deps.db);
  const now = (deps.now ?? (() => new Date()))();

  const { fields, counterpartyMarker, fromProfile } = fieldsForTemplate(template.bodyHtml, template.counterpartyMarker, profile, template.variables, now);
  const checked = validateDocumentValues(fields, counterpartyMarker, input.fields);
  if (!checked.ok) return { ok: false, kind: "invalid", errors: checked.errors, values: checked.values };

  const used = Object.fromEntries(fromProfile.map((name) => [name, profile[name]!]));
  const year = now.getUTCFullYear();

  const temporary = join(deps.dir, `.tmp-${randomUUID()}.pdf`);
  let finalPath: string | undefined;
  let issued: string | undefined;
  try {
    return await inTransaction(deps.db, async (tx): Promise<CreateResult> => {
      const ref = formatReference(template.refPrefix, year, await takeNumber(tx, template.refPrefix, year));
      issued = ref;
      // The values that use other fields are filled once the real reference is known and before anything is built from them.
      const resolution = resolveValues({ fields: fields.filter((field) => field.name !== COUNTERPARTY_FIELD), values: checked.values, profile, ref });
      if (!resolution.ok) throw new Unresolved(resolution.errors);
      const values = resolution.values;
      const counterpartyName = counterpartyMarker === null ? checked.counterpartyName : values[counterpartyMarker]!;
      const { html, missing } = buildDocumentHtml(template.bodyHtml, used, values, ref);
      if (missing.length > 0) throw new Unfilled(missing);

      await ensureDir(deps.dir);
      const rendered = await deps.engine.render({ html, pdfPath: temporary });
      if (!rendered.ok) throw new RenderRefused(rendered.reason);

      const pdfPath = pdfFileName(ref, counterpartyName);
      const id = await insertGeneratedDocument(tx, {
        ref,
        templateId: template.id,
        templateBodySnapshot: template.bodyHtml,
        title: `${template.name} — ${counterpartyName}`,
        counterpartyName,
        data: { values, profile: used },
        pdfPath,
        signatureFields: { pages: rendered.pages, fields: rendered.fields },
      });
      await moveIntoPlace(temporary, join(deps.dir, pdfPath));
      finalPath = join(deps.dir, pdfPath);
      return { ok: true, id, ref };
    });
  } catch (error) {
    await removeQuietly(temporary);
    if (error instanceof RenderRefused) return { ok: false, kind: "render", reason: error.reason };
    if (error instanceof Unresolved) return { ok: false, kind: "invalid", errors: error.errors, values: counterpartyMarker === null ? { ...checked.values, [COUNTERPARTY_FIELD]: checked.counterpartyName } : checked.values };
    if (error instanceof Unfilled) return { ok: false, kind: "unfilled", markers: error.markers };
    if (finalPath) {
      const outcome = refusedByServer(error) ? "rolled-back" : await commitOutcome(deps.db, issued!);
      if (typeof outcome === "number") return { ok: true, id: outcome, ref: issued! };
      if (outcome === "rolled-back") await removeQuietly(finalPath);
    }
    throw error;
  }
}

/** After a commit that ended without an answer: the id when the document exists, "rolled-back" when it does not, "unknown" when that cannot be found out. */
async function commitOutcome(db: Transactional, ref: string): Promise<number | "rolled-back" | "unknown"> {
  try {
    return (await findDocumentIdByRef(db, ref)) ?? "rolled-back";
  } catch {
    return "unknown";
  }
}
