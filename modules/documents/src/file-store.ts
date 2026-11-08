import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** How PDF names are made, and the scratch folder where a PDF is rendered before the platform's file store takes it. Nothing here reads a request. */

const SLUG_MAX = 40;

/** Lower-case ASCII words joined by hyphens, at most 40 characters; `counterparty` when nothing is left. */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "counterparty";
}

/** `<REF>-<slug of the counterparty>.pdf` */
export function pdfFileName(ref: string, counterparty: string): string {
  return `${ref}-${slugify(counterparty)}.pdf`;
}

/** The nearest folder up from `start` that holds a package.json with workspaces; `start` itself when there is none. */
export function findRepoRoot(start: string): string {
  for (let current = resolve(start); ; current = dirname(current)) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as { workspaces?: unknown };
      if (manifest.workspaces) return current;
    } catch {
      // no package.json here, or not JSON: keep going up
    }
    if (dirname(current) === current) return resolve(start);
  }
}

/** The folder where a PDF is rendered before it is stored. It holds nothing that must survive: every file in it is removed after use. */
export function scratchDir(): string {
  return join(tmpdir(), "modunexo-documents");
}

/** Create the folder if needed, readable by its owner only. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Cleanup after a failure must not hide the failure itself.
  }
}

