import { readdirSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SourceFile } from "../collector.ts";

/** Recursively list files whose name matches, sorted by path. A missing root yields an empty list. */
export async function findFiles(root: string, matches: (name: string) => boolean): Promise<SourceFile[]> {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && matches(entry.name)) found.push(path);
    }
  };
  walk(root);
  found.sort();
  return Promise.all(
    found.map(async (path) => {
      const info = await stat(path);
      return { path, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
    }),
  );
}

export interface ReadLines {
  lines: string[];
  /** Offset just after the last newline that was consumed. */
  offset: number;
}

/** Read the complete (newline-terminated) lines from `offset`. A trailing partial line is left for the next run. */
export async function readCompleteLines(path: string, offset: number): Promise<ReadLines> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size <= offset) return { lines: [], offset };
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end === -1) return { lines: [], offset };
    const text = buffer.subarray(0, end).toString("utf8");
    return { lines: text.split("\n"), offset: offset + end + 1 };
  } finally {
    await handle.close();
  }
}

/** Parse one JSON line into an object; anything else (blank, broken, non-object) is ignored. */
export function parseObject(line: string): Record<string, unknown> | null {
  if (line === "") return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export const asString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** A finite, non-negative number, or null when the field is absent or malformed. */
export function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Last path segment of a working directory, used as the project label. The full path is never kept. */
export function projectLabel(cwd: unknown): string | null {
  const path = asString(cwd);
  if (!path) return null;
  return basename(path.replace(/[\\/]+$/, "")) || null;
}
