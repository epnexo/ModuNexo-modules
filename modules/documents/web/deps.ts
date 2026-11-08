import { getDb } from "@modunexo/sdk";
import { docusealFromEnv } from "../src/docuseal-client.ts";

/** The data handle and the DocuSeal client (null when `DOCUSEAL_URL` or `DOCUSEAL_API_TOKEN` is missing), built when a request runs. */
export function signingDeps() {
  const client = docusealFromEnv(process.env);
  return { db: getDb("documents"), docuseal: client.ok ? client.value : null };
}
