import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queryable } from "../web/queries.ts";
import { templatePreviewHtml } from "./document-html.ts";
import type { PdfEngine, RenderFailure } from "./pdf-engine.ts";
import { getProfile } from "./profile-store.ts";
import { getTemplate } from "./template-store.ts";

/**
 * Render the saved body of a template to PDF bytes for a preview. It stores nothing: no document row, no number, no file
 * in the documents folder. The engine writes into a private temporary folder that is removed before this function
 * returns, whether the render worked or not, so no file outlives the call. A database or file-system failure is thrown.
 */

export interface TemplatePreviewDeps {
  db: Queryable;
  engine: PdfEngine;
  /** Where the private folder is made. Defaults to the system temporary folder. */
  tmpBase?: string | undefined;
  /** The largest PDF that is read back. A template preview is a few pages; this only bounds memory. */
  maxBytes?: number | undefined;
}

export const DEFAULT_MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

export type TemplatePreviewResult =
  | { ok: true; bytes: Buffer; slug: string }
  | { ok: false; kind: "not-found" }
  | { ok: false; kind: "render"; reason: RenderFailure }
  /** The engine said it worked, but the file is missing, is not a regular file or is over the limit. */
  | { ok: false; kind: "output"; code: "no-output" | "too-large" };

/** The bytes of the file, or the reason they were not read. */
async function readOutput(path: string, maxBytes: number): Promise<Buffer | "no-output" | "too-large"> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ENOENT") return "no-output";
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return "no-output";
    if (info.size > maxBytes) return "too-large";
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function renderTemplatePreview(deps: TemplatePreviewDeps, id: number): Promise<TemplatePreviewResult> {
  const template = await getTemplate(deps.db, id);
  if (!template || template.archivedAt !== null) return { ok: false, kind: "not-found" };
  const profile = await getProfile(deps.db);
  const { html } = templatePreviewHtml(template, profile);

  // mkdtemp makes the folder readable by its owner only; the profile data in the PDF never sits in a shared place.
  const folder = await mkdtemp(join(deps.tmpBase ?? tmpdir(), "documents-preview-"));
  try {
    const pdfPath = join(folder, "preview.pdf");
    const rendered = await deps.engine.render({ html, pdfPath });
    if (!rendered.ok) return { ok: false, kind: "render", reason: rendered.reason };
    const output = await readOutput(pdfPath, deps.maxBytes ?? DEFAULT_MAX_PREVIEW_BYTES);
    if (typeof output === "string") return { ok: false, kind: "output", code: output };
    return { ok: true, bytes: output, slug: template.slug };
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}
