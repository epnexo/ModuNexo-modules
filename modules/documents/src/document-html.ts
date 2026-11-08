import { type Substitution, listMarkers, splitMarkers, substitute } from "./markers.ts";

/**
 * The one place a document's HTML is built from a template body. Creation and the template preview both call
 * `buildDocumentHtml`, so the preview cannot drift from what a real document renders.
 */

/**
 * The body with `REF`, the profile values the body uses and the values entered for the document filled in (escaped, one
 * pass). `REF` is applied last: it is the platform's own marker and no entered value can replace it.
 */
export function buildDocumentHtml(body: string, used: Record<string, string>, values: Record<string, string>, ref: string): Substitution {
  return substitute(body, { ...used, ...values, REF: ref });
}

/**
 * The reference a template preview shows: the template's own prefix and the shape of a number. It has letters where a
 * real one has digits, so it can never be mistaken for a number the platform issued.
 */
export const sampleReference = (prefix: string): string => `${prefix}-YYYY-NNN`;

/**
 * The saved body as a preview shows it: profile markers filled from the owner profile, `REF` as the sample reference,
 * and every marker asked per document as its own name between square brackets. Nothing is read from a form.
 */
export function templatePreviewHtml(template: { refPrefix: string; bodyHtml: string }, profile: Record<string, string>): Substitution {
  const groups = splitMarkers(listMarkers(template.bodyHtml), profile);
  const used = Object.fromEntries(groups.fromProfile.map((name) => [name, profile[name]!]));
  const placeholders = Object.fromEntries(groups.perDocument.map((name) => [name, `[${name}]`]));
  return buildDocumentHtml(template.bodyHtml, used, placeholders, sampleReference(template.refPrefix));
}
