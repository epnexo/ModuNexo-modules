import { type FileHandle, open } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { getDb } from "@modunexo/sdk";
import { parseDocumentId } from "../src/document-rules.ts";
import { getDocumentPdfPath } from "../src/document-store.ts";
import { documentsDir, resolveInside } from "../src/file-store.ts";
import { logFailure } from "./log.ts";
import type { Queryable } from "./queries.ts";

/**
 * `GET /documents/[id]/pdf`: stream the stored PDF as a download, or with `?inline=1` for the browser's own viewer (the
 * same handler, so the 404, 500 and containment behavior cannot differ). The id is parsed strictly, and the path in the database is
 * treated as hostile: it must resolve to a regular file inside the documents folder, or the answer is a plain 404.
 */

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** A file name that is safe in a header: letters, digits, dot, hyphen and underscore. */
const headerName = (stored: string): string => basename(stored).replace(/[^A-Za-z0-9._-]/g, "_") || "document.pdf";

/** Not there: the file is missing, or something in its path is not a folder. */
const isMissing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as { code?: string } | null)?.code ?? "");

const failed = () => new Response("The document could not be read.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export async function downloadPdf(db: Queryable, dir: string, idParam: string, files: { open?: typeof open; inline?: boolean } = {}): Promise<Response> {
  const id = parseDocumentId(idParam);
  if (id === null) return notFound();

  let stored: string | null;
  try {
    stored = await getDocumentPdfPath(db, id);
  } catch (error) {
    logFailure("could not load the document file", error);
    return new Response("The document could not be loaded.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (stored === null) return notFound();

  // The file is opened here, before any response exists, so every way it can fail still has a status to answer with.
  let handle: FileHandle | undefined;
  try {
    const path = resolveInside(dir, stored, { followLinks: true });
    if (path === null) return notFound();
    handle = await (files.open ?? open)(/* turbopackIgnore: true */ path, "r");
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return notFound();
    }
    const stream = handle.createReadStream();
    stream.on("error", (error) => logFailure("could not stream the document file", error));
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(info.size),
        "Content-Disposition": `${files.inline ? "inline" : "attachment"}; filename="${headerName(stored)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    await handle?.close().catch(() => {});
    if (isMissing(error)) return notFound();
    logFailure("could not open the document file", error);
    return failed();
  }
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
  return downloadPdf(getDb("documents"), documentsDir(), id, { inline: wantsInline(request.url) });
}
