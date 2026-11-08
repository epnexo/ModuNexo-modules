/**
 * Log only the error code: driver messages can include the host and database name, and values must never be logged.
 * `detail` is for text the caller has already made safe (see the engine adapter's stderr tail).
 */
export function logFailure(scope: string, error: unknown, detail?: string): void {
  const fields = typeof error === "object" && error !== null ? (error as { code?: unknown; name?: unknown }) : {};
  const label = [fields.code, fields.name].find((value): value is string => typeof value === "string") ?? "unknown error";
  if (detail) console.error(`documents: ${scope}:`, label, detail);
  else console.error(`documents: ${scope}:`, label);
}
