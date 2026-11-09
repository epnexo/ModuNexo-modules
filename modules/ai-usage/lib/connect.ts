export const SCOPE = "ai_usage.write";
export const INGEST_PATH = "/svc/ai-usage/ingest";

/** The address people typed into the module's settings, cleaned up, or null when it is empty or not a web address. */
export function cleanAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The commands that connect this computer to the platform at `address` and send its usage. `--setup` asks for the
 * address and a token once and keeps them in the user's config folder, so the token is never typed into the command.
 */
export const sendCommand = (address: string): string =>
  [
    `# Once: save the address (${address}) and a token on this computer`,
    "node --import tsx src/cli/ingest.ts --setup",
    "# Then, whenever you want to send what changed",
    "node --import tsx src/cli/ingest.ts",
  ].join("\n");
