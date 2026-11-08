import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseIngestArgs } from "../../modules/ai-usage/src/cli/args.ts";
import { createCollectors } from "../../modules/ai-usage/src/collectors/index.ts";

describe("parseIngestArgs", () => {
  it("defaults to every tool and the home directory roots", () => {
    assert.deepEqual(parseIngestArgs([], {}), { tool: undefined, claudeDir: undefined, codexDir: undefined, piDir: undefined, opencodeDir: undefined, url: undefined, stateFile: undefined });
  });

  it("reads the tool and roots from flags", () => {
    assert.deepEqual(parseIngestArgs(["--tool", "codex", "--codex-dir", "/x", "--claude-dir", "/y"], {}), {
      tool: "codex",
      claudeDir: "/y",
      codexDir: "/x",
      piDir: undefined,
      opencodeDir: undefined,
      url: undefined,
      stateFile: undefined,
    });
  });

  it("reads the Pi and OpenCode roots from flags and environment variables", () => {
    const env = { AI_USAGE_PI_DIR: "/env/pi", AI_USAGE_OPENCODE_DIR: "/env/oc" };
    assert.deepEqual(parseIngestArgs(["--tool", "pi", "--opencode-dir", "/flag/oc"], env), {
      tool: "pi",
      claudeDir: undefined,
      codexDir: undefined,
      piDir: "/env/pi",
      opencodeDir: "/flag/oc",
      url: undefined,
      stateFile: undefined,
    });
    assert.equal(parseIngestArgs(["--tool", "opencode"], {}).tool, "opencode");
  });

  it("falls back to environment variables, with flags taking precedence", () => {
    const env = { AI_USAGE_CLAUDE_DIR: "/env/claude", AI_USAGE_CODEX_DIR: "/env/codex" };
    assert.deepEqual(parseIngestArgs(["--codex-dir", "/flag"], env), { tool: undefined, claudeDir: "/env/claude", codexDir: "/flag", piDir: undefined, opencodeDir: undefined, url: undefined, stateFile: undefined });
  });

  it("rejects an unknown tool", () => {
    assert.throws(() => parseIngestArgs(["--tool", "vim"], {}), /unknown tool "vim"; expected one of: claude-code, codex, pi, opencode/);
  });

  it("rejects unknown flags", () => {
    assert.throws(() => parseIngestArgs(["--nope"], {}));
  });
});

describe("createCollectors", () => {
  it("registers every supported tool, with roots under the given home by default", async () => {
    const collectors = createCollectors({}, "/nonexistent-home");
    assert.deepEqual(collectors.map((c) => c.toolId), ["claude-code", "codex", "pi", "opencode"]);
    for (const collector of collectors) assert.deepEqual(await collector.discover(), []);
  });
});

describe("parseIngestArgs sending", () => {
  it("reads the platform address and the state file from flags or the environment", () => {
    assert.equal(parseIngestArgs(["--url", "https://p.test", "--state-file", "/s.json"], {}).url, "https://p.test");
    const fromEnv = parseIngestArgs([], { AI_USAGE_URL: "https://env.test", AI_USAGE_STATE_FILE: "/env.json" });
    assert.deepEqual([fromEnv.url, fromEnv.stateFile], ["https://env.test", "/env.json"]);
  });

  it("has no token flag, so a token never ends up in the shell history", () => {
    assert.throws(() => parseIngestArgs(["--token", "x"], {}));
  });
});
