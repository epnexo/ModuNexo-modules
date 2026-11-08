import type { SignatureField } from "./pdf-engine.ts";

/**
 * Whether the stored signature layout can be sent to DocuSeal: the four boxes the /nda skill places, a signature and
 * a date for each side. The layout comes from the render script, but the column is untrusted until checked.
 */

export const SIGNATURE_BOXES = ["firma-1", "fecha-1", "firma-2", "fecha-2"] as const;

export type LayoutCheck = { ok: true; fields: SignatureField[] } | { ok: false; reason: string };

const fraction = (value: unknown, min: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= 1;

/** Slack for a box whose far edge rounds a hair past the page edge. */
const EDGE_TOLERANCE = 1e-6;

export function checkSignatureLayout(stored: unknown): LayoutCheck {
  const fields = typeof stored === "object" && stored !== null ? (stored as { fields?: unknown }).fields : undefined;
  const pages = typeof stored === "object" && stored !== null ? (stored as { pages?: unknown }).pages : undefined;
  if (!Array.isArray(fields)) return { ok: false, reason: "This document has no stored signature layout." };
  if (fields.length !== SIGNATURE_BOXES.length) {
    return { ok: false, reason: `The layout has ${fields.length} signature boxes; signing needs exactly four (a signature and a date for each side).` };
  }

  if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 1) return { ok: false, reason: "The layout has no valid page count." };

  const seen = new Set<string>();
  const checked: SignatureField[] = [];
  for (const entry of fields) {
    const { id, page, x, y, w, h } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const label = typeof id === "string" ? id : "a box";
    // A box signing does not use leaves one of the four missing, which is reported below.
    if (typeof id !== "string" || !(SIGNATURE_BOXES as readonly string[]).includes(id)) continue;
    if (seen.has(id)) return { ok: false, reason: `The layout has the box ${id} twice.` };
    seen.add(id);
    if (!Number.isInteger(page) || (page as number) < 0 || !fraction(x, 0) || !fraction(y, 0) || !fraction(w, Number.MIN_VALUE) || !fraction(h, Number.MIN_VALUE)) {
      return { ok: false, reason: `The box ${label} has coordinates that cannot be placed on a page.` };
    }
    if ((page as number) >= pages) return { ok: false, reason: `The box ${label} is on page ${(page as number) + 1}, but the document has ${pages} ${pages === 1 ? "page" : "pages"}.` };
    if ((x as number) + (w as number) > 1 + EDGE_TOLERANCE || (y as number) + (h as number) > 1 + EDGE_TOLERANCE) return { ok: false, reason: `The box ${label} does not fit inside the page.` };
    checked.push({ id, page: page as number, x, y, w, h });
  }
  const missing = SIGNATURE_BOXES.find((id) => !seen.has(id));
  return missing ? { ok: false, reason: `The layout is missing the box ${missing}.` } : { ok: true, fields: checked };
}
