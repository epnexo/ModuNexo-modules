import { basename } from "node:path";
import type { TemplateFieldPayload, TemplateUpdate } from "./docuseal-client.ts";
import type { SignatureField } from "./pdf-engine.ts";
import { SIGNATURE_BOXES } from "./signature-layout.ts";

/** What the platform sends DocuSeal for a document, from stored data. Pure; the uuid source is injected. Mirrors `poner_campos_y_crear_links` of the /nda skill. */

const ROLE_MAX = 100;

/** DocuSeal names an uploaded template after the file without its extension; the skill looks it up that way. */
export const templateNameForPdf = (pdfPath: string): string => basename(pdfPath).replace(/\.pdf$/i, "");

const SUFFIX = " (2)";
const tidy = (value: string | undefined, fallback: string, max = ROLE_MAX): string => value?.replace(/\s+/g, " ").trim().slice(0, max).trim() || fallback;

/**
 * The role names of the two signers: the owner's short name and the counterparty's name. DocuSeal tells signers apart by
 * role, so two names that are equal ignoring case get a suffix on the counterparty, which still fits the limit.
 */
export function roleNames(owner: string | undefined, counterparty: string): { owner: string; counterparty: string } {
  const a = tidy(owner, "Owner");
  const b = tidy(counterparty, "Counterparty");
  if (b.toLowerCase() !== a.toLowerCase()) return { owner: a, counterparty: b };
  return { owner: a, counterparty: `${tidy(counterparty, "Counterparty", ROLE_MAX - SUFFIX.length)}${SUFFIX}` };
}

export type TemplateUpdateResult = { ok: true; update: TemplateUpdate } | { ok: false; reason: string };

export function buildTemplateUpdate(input: { fields: SignatureField[]; attachmentUuid: string; existingSubmitterUuids: string[]; ownerRole: string; counterpartyRole: string; newUuid: () => string }): TemplateUpdateResult {
  // Only the four known boxes become fields: anything else is refused whole instead of guessed at.
  const unknown = input.fields.find((box) => !(SIGNATURE_BOXES as readonly string[]).includes(box.id));
  if (unknown) return { ok: false, reason: "The layout has a signature box this app does not recognise." };

  // The template keeps the submitter uuids it already has, so a repeated send does not pile up submitters.
  const ownerUuid = input.existingSubmitterUuids[0] ?? input.newUuid();
  const counterpartyUuid = input.existingSubmitterUuids[1] ?? input.newUuid();
  const sides: Record<string, { role: string; uuid: string }> = { "1": { role: input.ownerRole, uuid: ownerUuid }, "2": { role: input.counterpartyRole, uuid: counterpartyUuid } };

  const fields = input.fields.map((box): TemplateFieldPayload => {
    const [kind, side] = box.id.split("-") as [string, string];
    const signer = sides[side]!;
    return {
      uuid: input.newUuid(),
      submitter_uuid: signer.uuid,
      required: true,
      name: `${kind === "firma" ? "Firma" : "Fecha"} ${signer.role}`,
      type: kind === "firma" ? "signature" : "date",
      areas: [{ x: box.x, y: box.y, w: box.w, h: box.h, page: box.page, attachment_uuid: input.attachmentUuid }],
    };
  });
  return {
    ok: true,
    update: {
      submitters: [
        { name: input.ownerRole, uuid: ownerUuid },
        { name: input.counterpartyRole, uuid: counterpartyUuid },
      ],
      fields,
    },
  };
}
