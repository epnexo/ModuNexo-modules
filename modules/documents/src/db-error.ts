const UNREACHABLE = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "57P01", "08006", "08001"]);

/**
 * A message that is safe to show for a failed database call. The raw error can carry SQL, table names or values,
 * so it is only logged by the caller, never shown.
 */
export function describeDbError(error: unknown): { kind: "not-configured" | "failed"; message: string } {
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  if (code === "3F000" || code === "42P01") {
    return { kind: "failed", message: "The documents tables are missing. Install or upgrade the module so its migrations run." };
  }
  if (code === "23505") return { kind: "failed", message: "That value is already in use." };
  if (code === "40001" || code === "40P01") return { kind: "failed", message: "The data changed at the same time. Try again." };
  if (typeof code === "string" && UNREACHABLE.has(code)) {
    return { kind: "failed", message: "The database is unreachable right now. Try again in a moment." };
  }
  if (name === "DbUnavailableError" || name === "DbAccessError") {
    return { kind: "not-configured", message: "The documents data is not available: the module must be installed and enabled." };
  }
  return { kind: "failed", message: "The database query failed. Try again, and check the platform logs if it keeps failing." };
}
