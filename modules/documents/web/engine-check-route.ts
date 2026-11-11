import { loadConfig } from "../src/config.ts";
import { type EngineCheckAnswer, checkEngine, describeEngineCheck } from "../src/engine-check.ts";
import { type PdfEngine, pdfEngineFromEnv } from "../src/pdf-engine.ts";
import { logFailure } from "./log.ts";
import { refuse, sameOrigin } from "./post.ts";

/** Runs the test against an engine and returns the answer the Settings screen shows. Split from the route so a test can pass a fake. */
export async function runEngineCheck(engine: PdfEngine): Promise<EngineCheckAnswer> {
  return describeEngineCheck(await checkEngine({ engine }));
}

/**
 * `POST /documents/settings/test-engine`: the connection check of the manifest. The Settings screen posts here, from this site
 * and with the administrator's session, and shows the answer `{ ok, message }`. The gate has already required `documents.write`;
 * this checks that the browser sent the request from our own page. It renders one test page with the engine configured in the
 * module's settings and stores nothing; the answer is a fixed message.
 */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request.headers)) return refuse("The request must come from this site.", 403);
  let engine: PdfEngine;
  try {
    engine = pdfEngineFromEnv(await loadConfig());
  } catch (error) {
    logFailure("could not set up the engine test", error);
    return Response.json({ ok: false, message: "The engine settings could not be read. Details are in the server log." } satisfies EngineCheckAnswer);
  }
  try {
    return Response.json(await runEngineCheck(engine));
  } catch (error) {
    logFailure("the engine test failed", error);
    return Response.json({ ok: false, message: "The test could not be completed. Details are in the server log." } satisfies EngineCheckAnswer);
  }
}
