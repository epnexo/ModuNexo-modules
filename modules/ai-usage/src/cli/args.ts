import { parseArgs } from "node:util";

export const TOOLS = ["claude-code", "codex", "pi", "opencode"] as const;

export interface IngestArgs {
  tool: string | undefined;
  claudeDir: string | undefined;
  codexDir: string | undefined;
  piDir: string | undefined;
  opencodeDir: string | undefined;
  /** The platform address: when set, usage is sent to it instead of written to a database. */
  url: string | undefined;
  stateFile: string | undefined;
}

/** `--url` (or AI_USAGE_URL) switches to sending; the token is only read from AI_USAGE_TOKEN so it stays out of the shell history. `--tool` and one `--<tool>-dir` per tool; each directory also comes from AI_USAGE_<TOOL>_DIR (CLAUDE, CODEX, PI, OPENCODE). */
export function parseIngestArgs(argv: string[], env: Record<string, string | undefined>): IngestArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      tool: { type: "string" },
      "claude-dir": { type: "string" },
      "codex-dir": { type: "string" },
      "pi-dir": { type: "string" },
      "opencode-dir": { type: "string" },
      url: { type: "string" },
      "state-file": { type: "string" },
    },
    strict: true,
  });
  if (values.tool !== undefined && !(TOOLS as readonly string[]).includes(values.tool)) {
    throw new Error(`unknown tool "${values.tool}"; expected one of: ${TOOLS.join(", ")}`);
  }
  return {
    tool: values.tool,
    claudeDir: values["claude-dir"] ?? env.AI_USAGE_CLAUDE_DIR,
    codexDir: values["codex-dir"] ?? env.AI_USAGE_CODEX_DIR,
    piDir: values["pi-dir"] ?? env.AI_USAGE_PI_DIR,
    opencodeDir: values["opencode-dir"] ?? env.AI_USAGE_OPENCODE_DIR,
    url: values.url ?? env.AI_USAGE_URL,
    stateFile: values["state-file"] ?? env.AI_USAGE_STATE_FILE,
  };
}
