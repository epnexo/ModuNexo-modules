import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Where generated PDFs live and how their names are made. Nothing here reads a request: paths are checked as they come out of the database. */

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

/** `DOCUMENTS_DIR`, or `var/documents` at the repository root. A relative setting is relative to the repository root. */
export function documentsDir(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string {
  const root = findRepoRoot(cwd);
  const setting = env.DOCUMENTS_DIR?.trim();
  return setting ? resolve(root, setting) : join(root, "var", "documents");
}

/** Create the folder if needed, readable by its owner only. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * True when `target` does not exist (the caller answers not found) or resolves to a place inside `base`. A link that
 * cannot be resolved, because it dangles or loops, is treated as outside: the open would follow it anywhere. Any other
 * error from the file system is thrown for the caller to log.
 */
function linkStaysInside(base: string, target: string): boolean {
  try {
    lstatSync(target);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw error;
  }
  let real: string;
  try {
    real = realpathSync(target);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ELOOP") return false;
    throw error;
  }
  return real.startsWith(realpathSync(base) + sep);
}

/**
 * The absolute path of `relativePath` below `dir`, or null when it would leave `dir`. The value may come from a
 * database row, so it is treated as hostile: no absolute paths, no `..`, no NUL. With `followLinks`, a file that is
 * a symbolic link out of the folder is refused too.
 */
export function resolveInside(dir: string, relativePath: string, options: { followLinks?: boolean } = {}): string | null {
  if (typeof relativePath !== "string" || relativePath === "" || relativePath.includes("\0") || isAbsolute(relativePath)) return null;
  const base = resolve(dir);
  const target = resolve(base, relativePath);
  const inside = (root: string, path: string) => path.startsWith(root + sep);
  if (!inside(base, target)) return null;
  if (options.followLinks && !linkStaysInside(base, target)) return null;
  return target;
}

/** Make a finished file private to its owner and move it into place. The temporary file lives in the same folder, so the move is one atomic rename. */
export async function moveIntoPlace(from: string, to: string): Promise<void> {
  await chmod(from, 0o600);
  await rename(from, to);
}

export async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Cleanup after a failure must not hide the failure itself.
  }
}

