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
  help: boolean;
  /** Read the logs and show what would be sent, without sending or remembering anything. */
  dryRun: boolean;
  /** Ask for the platform address and the token once and save them, so later runs need no exports. */
  setup: boolean;
  configFile: string | undefined;
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
      help: { type: "boolean", short: "h" },
      "dry-run": { type: "boolean" },
      setup: { type: "boolean" },
      "config-file": { type: "string" },
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
    help: values.help ?? false,
    dryRun: values["dry-run"] ?? false,
    setup: values.setup ?? false,
    configFile: values["config-file"] ?? env.AI_USAGE_CONFIG_FILE,
  };
}

export const HELP = `Reads the logs of your AI coding tools and stores their token usage (counters, models and dates only; never prompts or paths).

Usage: ingest [options]

First time:
  --setup                Ask for the platform address and the token once and save them in ~/.config/ai-usage/config.json (readable only by you). After that, running with no options sends.

Where to put it (pick one):
  --url <address>        Send it to the platform (or AI_USAGE_URL). Needs AI_USAGE_TOKEN or a saved token: a service token with the scope ai_usage.write.
  DATABASE_URL           With no --url, write straight to the module's Postgres.
  --dry-run              Only show what was found. Sends nothing, writes nothing, remembers nothing.

What to read:
  --tool <name>          One of ${TOOLS.join(", ")}. Default: all.
  --claude-dir, --codex-dir, --pi-dir, --opencode-dir <path>
                         Where a tool keeps its logs (or AI_USAGE_<TOOL>_DIR). Default: its folder in your home.

Other:
  --state-file <path>    Where sending remembers how far it read (or AI_USAGE_STATE_FILE). Default: ~/.config/ai-usage/state.json
  --config-file <path>   Where --setup keeps the address and the token (or AI_USAGE_CONFIG_FILE). Default: ~/.config/ai-usage/config.json
  -h, --help             Show this text.
`;
