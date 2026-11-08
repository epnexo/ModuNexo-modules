import { getDb, getFile } from "@modunexo/sdk";
import { loadConfig } from "../src/config.ts";
import { docusealFromEnv } from "../src/docuseal-client.ts";

/** The data handle and the DocuSeal client (null when the DocuSeal address or token setting is missing), built when a request runs, from the module settings. */
export async function signingDeps() {
  const client = docusealFromEnv(await loadConfig());
  return { db: getDb("documents"), docuseal: client.ok ? client.value : null, readPdf: readStoredPdf };
}

/** The bytes of a PDF kept in the platform file store, or null when it is not there. */
async function readStoredPdf(fileId: string): Promise<Uint8Array | null> {
  const file = await getFile("documents", fileId);
  return file === null ? null : new Uint8Array(await new Response(file.stream).arrayBuffer());
}
