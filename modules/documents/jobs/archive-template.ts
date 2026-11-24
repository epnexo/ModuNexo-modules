import { getDb, type JobContext } from "@modunexo/sdk";
import { archiveTemplate } from "../src/template-store.ts";

/**
 * The job behind the `archive_template` action: archives one template, so it is no longer offered for new documents. What was
 * approved is exactly the template id in the payload and nothing else, so anything else in it is refused. Archiving a template
 * that is already archived (or gone) is not an error: running it twice leaves the same result.
 */
export default async function archiveTemplateJob(context: JobContext): Promise<void> {
  const payload = context.payload;
  const keys = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? Object.keys(payload) : [];
  const id = keys.length === 1 && keys[0] === "template" ? (payload as { template: unknown }).template : undefined;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new Error("the payload must be { template: <the id of a template> }");
  await archiveTemplate(getDb("documents"), id);
}
