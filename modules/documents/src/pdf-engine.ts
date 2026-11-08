import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logFailure } from "../web/log.ts";
import { findRepoRoot } from "./file-store.ts";

/**
 * The PDF engine adapter, the only place that knows about Python. It runs the vendored `render/render.py` with the
 * interpreter named by `DOCUMENTS_PYTHON`: the HTML goes to its stdin, the PDF is written where `pdfPath` says, and
 * its stdout is one JSON document with the page count and the signature boxes. Failures come back as typed results.
 */

export type RenderFailure = "not-configured" | "interpreter-missing" | "weasyprint-missing" | "render-error" | "timeout" | "spawn-failed";

/** A box marked `data-campo` in the HTML. `page` is 0-based; x, y, w, h are fractions of the page. */
export interface SignatureField {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RenderResult = { ok: true; pages: number; fields: SignatureField[] } | { ok: false; reason: RenderFailure };

/** Injectable, so everything above it is tested with a fake. */
export interface PdfEngine {
  render(request: { html: string; pdfPath: string }): Promise<RenderResult>;
}

export interface PdfEngineConfig {
  /** The interpreter (`DOCUMENTS_PYTHON`). Blank or unset means the engine is not configured. */
  python: string | undefined;
  /** The one folder the render script may read files from, with fonts in its `fonts` folder (`DOCUMENTS_ASSETS_DIR`). */
  assetsDir?: string | undefined;
  timeoutMs?: number | undefined;
  /** The render script. Tests point it at a fake. */
  script?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  /** The working directory the default script location is found from. Tests point it outside a checkout. */
  cwd?: (() => string) | undefined;
  /** Starts the child. Tests hand it a fake. */
  spawn?: typeof spawn | undefined;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const WEASYPRINT_MISSING = 3;

/** What the interpreter needs to run and find its libraries and fonts. The rest of the environment, secrets included, stays behind. */
const CHILD_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "LD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "FONTCONFIG_FILE", "FONTCONFIG_PATH", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_DIRS"];

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseField(value: unknown): SignatureField | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, page, x, y, w, h } = value as Record<string, unknown>;
  if (typeof id !== "string" || id === "" || !Number.isInteger(page) || (page as number) < 0 || !finite(x) || !finite(y) || !finite(w) || !finite(h)) return null;
  return { id, page: page as number, x, y, w, h };
}

/** The script's stdout, or null when it is not the document the adapter expects. */
function parseOutput(text: string): { pages: number; fields: SignatureField[] } | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { pages, fields } = data as Record<string, unknown>;
  if (!Number.isInteger(pages) || (pages as number) < 1 || !Array.isArray(fields)) return null;
  const parsed = fields.map(parseField);
  if (parsed.some((field) => field === null)) return null;
  return { pages: pages as number, fields: parsed as SignatureField[] };
}

/** The largest delay a Node timer accepts; a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How much of the end of stderr is kept for the log. */
const STDERR_TAIL_BYTES = 4 * 1024;
const MAX_LOGGED_LINES = 8;
/** The only stderr lines logged: the ones render.py writes itself. Anything else could echo document text, so it is only counted. */
const SAFE_STDERR_LINES = [/^render failed: [A-Za-z_][A-Za-z0-9_.]{0,80}$/, /^WeasyPrint is not installed for this Python interpreter\.$/, /^The HTML is larger than \d+ bytes\.$/];

/** Only a missing or unusable interpreter is a configuration problem; any other failure to start is worth trying again. */
function reasonForSpawnError(error: unknown): RenderFailure {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "EACCES" ? "interpreter-missing" : "spawn-failed";
}

/** The end of the child's stderr reduced to the lines that are safe to log, plus how many others were left out. */
function safeStderr(tail: Buffer): string {
  const lines = tail.toString("utf8").split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const safe = lines.filter((line) => SAFE_STDERR_LINES.some((pattern) => pattern.test(line)));
  const hidden = lines.length - safe.length;
  return [...safe.slice(-MAX_LOGGED_LINES), ...(hidden > 0 ? [`(${hidden} other line${hidden === 1 ? "" : "s"} not logged)`] : [])].join(" | ");
}

export function createPdfEngine(config: PdfEngineConfig): PdfEngine {
  const python = config.python?.trim();
  const limit = config.timeoutMs;
  const timeoutMs = Math.min(typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_TIMEOUT_MS, MAX_TIMER_MS);
  const source = config.env ?? process.env;
  const env = Object.fromEntries(CHILD_ENV.filter((name) => source[name] !== undefined).map((name) => [name, source[name]])) as NodeJS.ProcessEnv;
  const start = config.spawn ?? spawn;

  /** The render script. Found when it is needed, from the working directory (not import.meta.url, which a bundler rewrites), so building the engine never throws. */
  function locateScript(): string | null {
    if (config.script) return config.script;
    const found = join(findRepoRoot((config.cwd ?? process.cwd)()), "modules", "documents", "render", "render.py");
    return existsSync(found) ? found : null;
  }

  return {
    render({ html, pdfPath }) {
      if (!python) return Promise.resolve({ ok: false, reason: "not-configured" });
      let script: string | null;
      try {
        script = locateScript();
      } catch (error) {
        logFailure("could not locate the render script", error);
        return Promise.resolve({ ok: false, reason: "render-error" });
      }
      if (script === null) {
        logFailure("could not locate the render script", { code: "script not found" });
        return Promise.resolve({ ok: false, reason: "render-error" });
      }
      const args = [script, "--pdf", pdfPath, ...(config.assetsDir ? ["--assets", config.assetsDir] : [])];

      return new Promise<RenderResult>((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (result: RenderResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };

        // No shell: the arguments are an array and nothing is interpolated into a command line.
        let child: ChildProcess;
        try {
          child = start(python, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, env });
        } catch (error) {
          logFailure("could not start the render script", error);
          return finish({ ok: false, reason: reasonForSpawnError(error) });
        }
        child.on("error", (error) => {
          logFailure("could not run the render script", error);
          finish({ ok: false, reason: reasonForSpawnError(error) });
        });
        const { stdin, stdout, stderr } = child;
        if (!stdin || !stdout || !stderr) {
          child.kill("SIGKILL");
          logFailure("could not run the render script", { code: "no standard streams" });
          return finish({ ok: false, reason: "spawn-failed" });
        }

        timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({ ok: false, reason: "timeout" });
        }, timeoutMs);

        const out: Buffer[] = [];
        let outBytes = 0;
        stdout.on("data", (chunk: Buffer) => {
          outBytes += chunk.length;
          if (outBytes > MAX_STDOUT_BYTES) {
            child.kill("SIGKILL");
            logFailure("the render script printed too much", { code: "output too large" });
            finish({ ok: false, reason: "render-error" });
          } else out.push(chunk);
        });
        // stderr is drained so the child never blocks on a full pipe; only its last few KB are kept, for the log.
        let tail = Buffer.alloc(0);
        stderr.on("data", (chunk: Buffer) => {
          tail = Buffer.concat([tail, chunk]);
          if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES);
        });

        child.on("close", (code, signal) => {
          if (code === WEASYPRINT_MISSING) return finish({ ok: false, reason: "weasyprint-missing" });
          if (code !== 0) {
            logFailure("the render script failed", { code: signal ? `signal ${signal}` : `exit ${code}` }, safeStderr(tail));
            return finish({ ok: false, reason: "render-error" });
          }
          const parsed = parseOutput(Buffer.concat(out).toString("utf8"));
          if (!parsed) logFailure("the render script failed", { code: "unexpected output" }, safeStderr(tail));
          finish(parsed ? { ok: true, ...parsed } : { ok: false, reason: "render-error" });
        });

        // A child that exits early closes stdin under us: that is its exit code's business, not an unhandled error.
        stdin.on("error", () => {});
        stdin.end(html, "utf8");
      });
    },
  };
}

/** The engine configured by `DOCUMENTS_PYTHON`, `DOCUMENTS_ASSETS_DIR` and, optionally, `DOCUMENTS_RENDER_TIMEOUT_MS`. */
export function pdfEngineFromEnv(env: Record<string, string | undefined> = process.env): PdfEngine {
  return createPdfEngine({ ...renderSettingsFromEnv(env), env });
}

/** The three settings, as the engine takes them: a blank assets folder and a time limit that is not a positive whole number count as unset. */
export function renderSettingsFromEnv(env: Record<string, string | undefined>): Pick<PdfEngineConfig, "python" | "assetsDir" | "timeoutMs"> {
  const timeout = Number(env.DOCUMENTS_RENDER_TIMEOUT_MS);
  return {
    python: env.DOCUMENTS_PYTHON,
    assetsDir: env.DOCUMENTS_ASSETS_DIR?.trim() || undefined,
    timeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : undefined,
  };
}

const MESSAGES: Record<RenderFailure, string> = {
  "not-configured": "The PDF engine is not configured. Set DOCUMENTS_PYTHON in .env to a Python interpreter that has WeasyPrint, then restart the app.",
  "interpreter-missing": "The PDF engine could not be started: the interpreter named by DOCUMENTS_PYTHON was not found or cannot run.",
  "weasyprint-missing": "WeasyPrint is not installed for the interpreter named by DOCUMENTS_PYTHON.",
  "render-error": "The PDF could not be generated. Details are in the server log.",
  timeout: "The PDF took too long to generate and was stopped.",
  "spawn-failed": "The PDF engine could not be started right now. Wait a moment and try again; details are in the server log.",
};

/** A message that is safe to show: it names the setting to fix, never a path or anything from the document. */
export function describeRenderFailure(reason: RenderFailure): string {
  return MESSAGES[reason];
}
