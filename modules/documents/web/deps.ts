import { getDb } from "@modunexo/sdk";
import { loadConfig } from "../src/config.ts";
import { docusealFromEnv } from "../src/docuseal-client.ts";

/** The data handle and the DocuSeal client (null when the DocuSeal address or token setting is missing), built when a request runs, from the module settings. */
export async function signingDeps() {
  const client = docusealFromEnv(await loadConfig());
  return { db: getDb("documents"), docuseal: client.ok ? client.value : null };
}
