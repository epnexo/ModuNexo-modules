import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PdfEngine, type RenderFailure, describeRenderFailure } from "./pdf-engine.ts";

/** One short line: enough to prove the engine answers, accepts the token and can lay out a page. */
const TEST_HTML = "<!doctype html><html><body><p>PDF engine connection test.</p></body></html>";

export type EngineCheck = { ok: true; pages: number } | { ok: false; reason: RenderFailure };

/** What the check route answers, the platform's `{ ok, message }` contract. Never carries text from the engine, only fixed messages. */
export interface EngineCheckAnswer {
  ok: boolean;
  message: string;
}

export interface EngineCheckDeps {
  engine: PdfEngine;
  /** Where the throwaway folder is made. Tests point it at their own. */
  tmpBase?: string;
}

/**
 * Renders the test page with the engine as configured (the service when its address is set, otherwise the local
 * interpreter) and throws the PDF away. Nothing is stored; the folder is private to the process owner and removed
 * afterwards, whatever the outcome. One render per call, bounded by the engine's own time limit.
 */
export async function checkEngine(deps: EngineCheckDeps): Promise<EngineCheck> {
  const folder = await mkdtemp(join(deps.tmpBase ?? tmpdir(), "documents-check-"));
  try {
    const rendered = await deps.engine.render({ html: TEST_HTML, pdfPath: join(folder, "check.pdf") });
    return rendered.ok ? { ok: true, pages: rendered.pages } : { ok: false, reason: rendered.reason };
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

/** The answer for the Settings screen: the same wording the template preview uses for a failure. */
export function describeEngineCheck(result: EngineCheck): EngineCheckAnswer {
  if (result.ok) return { ok: true, message: "Connected. The PDF engine accepted the token and rendered a test page." };
  return { ok: false, message: describeRenderFailure(result.reason) };
}
