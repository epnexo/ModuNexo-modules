import { basename } from "node:path";
import { type FileMeta, type StoredFile, getDb, getFile } from "@modunexo/sdk";
import { parseDocumentId } from "../src/document-rules.ts";
import { getDocumentPdf } from "../src/document-store.ts";
import { logFailure } from "./log.ts";
import type { Queryable } from "./queries.ts";

/**
 * `GET /documents/[id]/pdf`: send the stored PDF as a download, or with `?inline=1` for the browser's own viewer (the
 * same handler, so the 404 and 500 behavior cannot differ). The id is parsed strictly. The bytes come from the
 * platform's file store by the id kept on the document; this module never reads a path.
 */

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const failed = (message: string) => new Response(message, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** A file name that is safe in a header: letters, digits, dot, hyphen and underscore. */
const headerName = (stored: string): string => basename(stored).replace(/[^A-Za-z0-9._-]/g, "_") || "document.pdf";

export interface DownloadOptions {
  inline?: boolean;
  /** The platform's `getFile`; tests pass their own. */
  getFile?: (moduleId: string, id: string) => Promise<StoredFile | null>;
}

export async function downloadPdf(db: Queryable, idParam: string, options: DownloadOptions = {}): Promise<Response> {
  const id = parseDocumentId(idParam);
  if (id === null) return notFound();

  let stored: { name: string; fileId: string } | null;
  try {
    stored = await getDocumentPdf(db, id);
  } catch (error) {
    logFailure("could not load the document file", error);
    return failed("The document could not be loaded.");
  }
  if (stored === null) return notFound();

  let file: StoredFile | null;
  try {
    file = await (options.getFile ?? getFile)("documents", stored.fileId);
  } catch (error) {
    logFailure("could not open the document file", error);
    return failed("The document could not be read.");
  }
  if (file === null) return notFound();

  const meta: FileMeta = file.meta;
  return new Response(file.stream, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(meta.size),
      "Content-Disposition": `${options.inline ? "inline" : "attachment"}; filename="${headerName(stored.name)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** True when the request asks for the inline variant: `?inline=1`, nothing else. */
export function wantsInline(url: string): boolean {
  try {
    return new URL(url).searchParams.get("inline") === "1";
  } catch {
    return false;
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return downloadPdf(getDb("documents"), id, { inline: wantsInline(request.url) });
}
