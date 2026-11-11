import { loadConfig } from "../src/config.ts";
import { type EngineCheckState, checkEngine, describeEngineCheck } from "../src/engine-check.ts";
import { type PdfEngine, pdfEngineFromEnv } from "../src/pdf-engine.ts";
import { logFailure } from "./log.ts";
import { answer, handleForm } from "./post.ts";

/** Runs the test against an engine and returns the state the page shows. Split from the route so a test can pass a fake. */
export async function runEngineCheck(engine: PdfEngine): Promise<EngineCheckState> {
  return describeEngineCheck(await checkEngine({ engine }));
}

/**
 * `POST /documents/settings/test-engine`: renders one test page with the engine configured in the module's settings.
 * The gate has already required `documents.write`; `handleForm` checks the origin. The answer is a fixed message.
 */
export const POST = (request: Request): Promise<Response> =>
  handleForm(request, async () => {
    let engine: PdfEngine;
    try {
      engine = pdfEngineFromEnv(await loadConfig());
    } catch (error) {
      logFailure("could not set up the engine test", error);
      return answer({ state: { tone: "error", message: "The engine settings could not be read. Details are in the server log." } satisfies EngineCheckState });
    }
    return answer({ state: await runEngineCheck(engine) });
  });
