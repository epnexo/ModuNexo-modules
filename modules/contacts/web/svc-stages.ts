import { listStages } from "../lib/pipeline.ts";

/** Service API: the pipeline stages in order. Needs the scope `leads.read`. */
export async function GET(_request: Request): Promise<Response> {
  return Response.json({ stages: await listStages() });
}
