import { randomUUID } from "node:crypto";
import { FILES_SERVICE, type FileMeta, type FilesService, type PutFileInput, type PutFileOptions } from "@modunexo/sdk";

/** What the fake store kept for one `putFile`. `tx` is the handle the caller gave, so a test can check the file was written in the caller's transaction. */
export interface Stored {
  meta: FileMeta;
  bytes: Uint8Array;
  tx: PutFileOptions["tx"];
}

export interface FakeFiles {
  /** Every file put, in order. */
  stored: Stored[];
  /** Make the next `put` fail with this error. */
  failNextPut(error: Error): void;
  /** The platform removes the bytes of a transaction that rolled back; the test database calls this when one does. */
  dropFor(tx: PutFileOptions["tx"]): void;
  uninstall(): void;
}

async function bytesOf(data: PutFileInput["data"]): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  const chunks: Uint8Array[] = [];
  if (data instanceof ReadableStream) {
    const reader = data.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) chunks.push(next.value);
  } else {
    for await (const chunk of data) chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Registers an in-memory files service under the symbol the platform uses, so `putFile` and `getFile` work in a test.
 * The real service stores the bytes on disk and writes its row in the caller's transaction; this keeps what matters to
 * the module: the id it hands back, the bytes, and whether the caller's transaction was passed.
 */
export function installFakeFiles(): FakeFiles {
  const stored: Stored[] = [];
  let failure: Error | undefined;
  const service: FilesService = {
    async put(moduleId, input, options) {
      if (failure) {
        const error = failure;
        failure = undefined;
        throw error;
      }
      const bytes = await bytesOf(input.data);
      const meta: FileMeta = { id: randomUUID(), name: input.name, contentType: "application/pdf", size: bytes.length, sha256: "fake", ref: input.ref ?? null, createdAt: new Date().toISOString() };
      stored.push({ meta, bytes, tx: options.tx });
      void moduleId;
      return meta;
    },
    async get(_moduleId, id) {
      const found = stored.find((file) => file.meta.id === id);
      return found ? { meta: found.meta, stream: new Response(found.bytes as unknown as BodyInit).body! } : null;
    },
    async stat(_moduleId, id) {
      return stored.find((file) => file.meta.id === id)?.meta ?? null;
    },
    async list() {
      return stored.map((file) => file.meta);
    },
    async remove(_moduleId, id) {
      const at = stored.findIndex((file) => file.meta.id === id);
      if (at < 0) return false;
      stored.splice(at, 1);
      return true;
    },
  };
  const holder = globalThis as typeof globalThis & { [FILES_SERVICE]?: FilesService };
  holder[FILES_SERVICE] = service;
  return {
    stored,
    failNextPut: (error) => {
      failure = error;
    },
    dropFor: (tx) => {
      for (let at = stored.length - 1; at >= 0; at -= 1) if (tx !== undefined && stored[at]!.tx === tx) stored.splice(at, 1);
    },
    uninstall: () => {
      delete holder[FILES_SERVICE];
    },
  };
}
