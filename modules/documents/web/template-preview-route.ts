import { getDb } from "@modunexo/sdk";
import { loadConfig } from "../src/config.ts";
import { type PdfEngine, type RenderFailure, describeRenderFailure, pdfEngineFromEnv } from "../src/pdf-engine.ts";
import { parseTemplateId } from "../src/template-rules.ts";
import { type TemplatePreviewDeps, renderTemplatePreview } from "../src/template-preview.ts";
import { logFailure } from "./log.ts";

/**
 * `GET /documents/templates/[id]/preview`: the saved body of a template as a PDF, answered inline. The id is parsed
 * strictly; an unknown, archived or malformed id is a 404. It filters nothing through a form: unsaved edits are not
 * previewed. Nothing is stored (see `renderTemplatePreview`). One render per request, bounded by the engine's own time
 * limit; there are no retries. Failures answer in plain text and are logged by code only.
 */

export type PreviewDeps = TemplatePreviewDeps;

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** A file name that is safe in a header: letters, digits, dot, hyphen and underscore. */
const headerName = (slug: string): string => `${slug.replace(/[^A-Za-z0-9._-]/g, "_") || "template"}-preview.pdf`;

/** Configuration problems are the owner's to fix (503), a timeout is 504, any other render failure is 502. */
const STATUS: Record<RenderFailure, number> = {
  "not-configured": 503,
  "interpreter-missing": 503,
  "weasyprint-missing": 503,
  timeout: 504,
  "render-error": 502,
  "spawn-failed": 502,
};

export async function previewTemplatePdf(deps: PreviewDeps, idParam: string): Promise<Response> {
  const id = parseTemplateId(idParam);
  if (id === null) return plain(404, "Not found");

  let result;
  try {
    result = await renderTemplatePreview(deps, id);
  } catch (error) {
    logFailure("could not build the template preview", error);
    return plain(500, "The template preview could not be built. Details are in the server log.");
  }
  if (result.ok) {
    return new Response(result.bytes as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(result.bytes.length),
        "Content-Disposition": `inline; filename="${headerName(result.slug)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  switch (result.kind) {
    case "not-found":
      return plain(404, "Not found");
    case "render":
      logFailure("could not render the template preview", { code: result.reason });
      return plain(STATUS[result.reason], describeRenderFailure(result.reason));
    case "output":
      logFailure("could not read the template preview", { code: result.code });
      return plain(502, "The PDF could not be generated. Details are in the server log.");
  }
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  let engine: PdfEngine;
  let db;
  try {
    engine = pdfEngineFromEnv(await loadConfig());
    db = getDb("documents");
  } catch (error) {
    logFailure("could not set up the template preview", error);
    return plain(500, "The template preview could not be built. Details are in the server log.");
  }
  return previewTemplatePdf({ db, engine }, id);
}
