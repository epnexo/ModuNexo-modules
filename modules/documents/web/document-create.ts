import { getDb } from "@modunexo/sdk";
import { loadConfig } from "../src/config.ts";
import { scratchDir } from "../src/file-store.ts";
import { pdfEngineFromEnv } from "../src/pdf-engine.ts";
import { answer, handleForm } from "./post.ts";
import { submitNewDocumentWith } from "./submit-document.ts";

/** The new-document form. The gate has already required `documents.write`. */
export const POST = (request: Request): Promise<Response> =>
  handleForm(request, async (fields) => answer(await submitNewDocumentWith(async () => ({ db: getDb("documents"), engine: pdfEngineFromEnv(await loadConfig()), dir: scratchDir() }), fields)));
