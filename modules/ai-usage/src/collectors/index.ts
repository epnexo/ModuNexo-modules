import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector } from "../collector.ts";
import { createClaudeCodeCollector } from "./claude-code.ts";
import { createCodexCollector } from "./codex.ts";
import { createOpenCodeCollector } from "./opencode.ts";
import { createPiCollector } from "./pi.ts";

export interface CollectorRoots {
  claudeDir?: string;
  codexDir?: string;
  piDir?: string;
  opencodeDir?: string;
}

/** Collectors for every supported tool. Roots default to the current user's home and can be overridden for tests. */
export function createCollectors(roots: CollectorRoots = {}, home: string = homedir()): Collector[] {
  return [
    createClaudeCodeCollector({ root: roots.claudeDir ?? join(home, ".claude", "projects") }),
    createCodexCollector({ root: roots.codexDir ?? join(home, ".codex", "sessions") }),
    createPiCollector({ root: roots.piDir ?? join(home, ".pi", "agent", "sessions") }),
    createOpenCodeCollector({ root: roots.opencodeDir ?? join(home, ".local", "share", "opencode") }),
  ];
}
