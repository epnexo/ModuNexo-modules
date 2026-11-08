import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { type PdfEngineConfig, type RenderFailure, createPdfEngine, describeRenderFailure, pdfEngineFromEnv, renderSettingsFromEnv } from "../src/pdf-engine.ts";

/** The "interpreter" is node and the "render script" a small fake, so no Python or WeasyPrint is needed here. */

let dir: string;
const script = (name: string) => join(dir, name);

const FAKES: Record<string, string> = {
  "ok.mjs": `
    import { writeFileSync } from "node:fs";
    const chunks = []; for await (const c of process.stdin) chunks.push(c);
    const html = Buffer.concat(chunks).toString("utf8");
    const pdf = process.argv[process.argv.indexOf("--pdf") + 1];
    writeFileSync(pdf, "%PDF-fake");
    process.stdout.write(JSON.stringify({ pages: 3, fields: [{ id: "firma-1", page: 2, x: 0.1, y: 0.4, w: 0.38, h: 0.07 }], seen: { html, args: process.argv.slice(2), hasDb: "DATABASE_URL" in process.env, hasPath: "PATH" in process.env } }));
  `,
  "fail.mjs": `process.stderr.write("render failed: ValueError\\n"); process.exit(1);`,
  "noweasy.mjs": `process.stderr.write("WeasyPrint is not installed for this Python interpreter.\\n"); process.exit(3);`,
  "garbage.mjs": `process.stdout.write("this is not json"); `,
  "shape.mjs": `process.stdout.write(JSON.stringify({ pages: 0, fields: [] }));`,
  "badfield.mjs": `process.stdout.write(JSON.stringify({ pages: 1, fields: [{ id: "a", page: 0, x: "left", y: 0, w: 1, h: 1 }] }));`,
  "hang.mjs": `setInterval(() => {}, 1000);`,
  "huge.mjs": `process.stdout.write("x".repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000);`,
  "noisy.mjs": `process.stderr.write("e".repeat(500000)); process.stdout.write(JSON.stringify({ pages: 1, fields: [] }));`,
  // The script's own message, then text a library could print with a document value in it.
  "leaky.mjs": `process.stderr.write("WARNING Failed to load image at http://host/SECRET-DOC-TEXT.png\\nrender failed: ValueError\\n"); process.exit(1);`,
  "late.mjs": `process.stderr.write("e".repeat(500000) + "\\nrender failed: LateError\\n", () => process.exit(1));`,
  "killed.mjs": `process.stderr.write("render failed: Killed\\n", () => process.kill(process.pid, "SIGKILL"));`,
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "documents-engine-"));
  for (const [name, source] of Object.entries(FAKES)) await writeFile(join(dir, name), source);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const engine = (name: string, extra: Partial<PdfEngineConfig> = {}) => createPdfEngine({ python: process.execPath, script: script(name), timeoutMs: 5000, ...extra });
const request = () => ({ html: "<p>Hola ñ — ok</p>", pdfPath: join(dir, "out put; $(touch pwned).pdf") });

describe("pdf engine adapter", () => {
  it("passes the html on stdin and the output path as one argument, and returns pages and fields", async () => {
    const asked = request();
    const result = await engine("ok.mjs", { assetsDir: "/some/assets dir" }).render(asked);
    assert.deepEqual(result, { ok: true, pages: 3, fields: [{ id: "firma-1", page: 2, x: 0.1, y: 0.4, w: 0.38, h: 0.07 }] });
    assert.equal(await readFile(asked.pdfPath, "utf8"), "%PDF-fake");
    assert.equal(existsSync(join(dir, "pwned")), false, "no shell ever sees the path");
  });

  it("sends the arguments as an array, the assets folder only when configured, and no secrets of the environment", async () => {
    // A script that writes what it was given to the pdf path, since the adapter returns only pages and fields.
    const echo = join(dir, "echo.mjs");
    await writeFile(echo, FAKES["ok.mjs"]!.replace(`writeFileSync(pdf, "%PDF-fake")`, `writeFileSync(pdf, JSON.stringify({ html, args: process.argv.slice(2), hasDb: "DATABASE_URL" in process.env, hasPath: "PATH" in process.env }))`));
    const run = async (assetsDir: string | undefined) => {
      const pdfPath = join(dir, "echo.json");
      const env = { PATH: process.env.PATH, DATABASE_URL: "postgres://secret", HOME: "/home/x" };
      const result = await createPdfEngine({ python: process.execPath, script: echo, timeoutMs: 5000, env, assetsDir }).render({ html: "<p>stdin</p>", pdfPath });
      assert.equal(result.ok, true);
      return JSON.parse(await readFile(pdfPath, "utf8")) as { html: string; args: string[]; hasDb: boolean; hasPath: boolean };
    };
    const withAssets = await run("/a b/assets");
    assert.deepEqual(withAssets.args, ["--pdf", join(dir, "echo.json"), "--assets", "/a b/assets"]);
    assert.equal(withAssets.html, "<p>stdin</p>");
    assert.equal(withAssets.hasDb, false, "the database URL is not handed to the interpreter");
    assert.equal(withAssets.hasPath, true);
    assert.deepEqual((await run(undefined)).args, ["--pdf", join(dir, "echo.json")]);
  });

  it("reports not configured when no interpreter is named, without running anything", async () => {
    for (const python of [undefined, "", "   "]) {
      assert.deepEqual(await createPdfEngine({ python, script: script("ok.mjs") }).render(request()), { ok: false, reason: "not-configured" });
    }
  });

  it("logs the exit code and only the safe lines of the stderr tail of a failed render", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    assert.deepEqual(await engine("leaky.mjs").render(request()), { ok: false, reason: "render-error" });
    const text = JSON.stringify(logged);
    assert.match(text, /exit 1/);
    assert.match(text, /render failed: ValueError/);
    assert.doesNotMatch(text, /SECRET-DOC-TEXT/, "a line the script did not write itself is never logged");
    assert.match(text, /1 other line/, "the dropped line is counted");
  });

  it("keeps only the bounded tail of stderr for the log, and logs the signal that ended the child", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    await engine("late.mjs").render(request());
    assert.match(JSON.stringify(logged), /render failed: LateError/, "the end of a long stderr is kept");
    assert.ok(JSON.stringify(logged).length < 8000, "and the log line stays small");
    logged.length = 0;
    assert.deepEqual(await engine("killed.mjs").render(request()), { ok: false, reason: "render-error" });
    assert.match(JSON.stringify(logged), /signal SIGKILL/);
  });

  it("answers a synchronous failure to start the child with a typed result instead of rejecting", async (t) => {
    t.mock.method(console, "error", () => {});
    assert.deepEqual(await createPdfEngine({ python: "py\0thon", script: script("ok.mjs") }).render(request()), { ok: false, reason: "spawn-failed" });
    assert.deepEqual(await engine("ok.mjs").render({ html: "x", pdfPath: "bad\0path.pdf" }), { ok: false, reason: "spawn-failed" });
  });

  it("answers a child without standard streams with a typed result and stops the child", async (t) => {
    t.mock.method(console, "error", () => {});
    let killed = false;
    const child = Object.assign(new EventEmitter(), { stdin: null, stdout: null, stderr: null, kill: () => ((killed = true), true) });
    const result = await createPdfEngine({ python: "python", script: "render.py", spawn: () => child as never }).render(request());
    assert.deepEqual(result, { ok: false, reason: "spawn-failed" });
    assert.equal(killed, true);
  });

  it("maps only ENOENT and EACCES on the error event to a missing interpreter, and logs the code of any other", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const failWith = (code: string) => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      setImmediate(() => child.emit("error", Object.assign(new Error("spawn failed"), { code })));
      return createPdfEngine({ python: "python", script: "render.py", spawn: () => child as never }).render(request());
    };
    assert.deepEqual(await failWith("ENOENT"), { ok: false, reason: "interpreter-missing" });
    assert.deepEqual(await failWith("EACCES"), { ok: false, reason: "interpreter-missing" });
    assert.deepEqual(await failWith("EAGAIN"), { ok: false, reason: "spawn-failed" });
    assert.deepEqual(await failWith("EMFILE"), { ok: false, reason: "spawn-failed" });
    assert.match(JSON.stringify(logged), /EAGAIN/);
  });

  it("does not stop at once when the time limit is above what a timer accepts", async () => {
    const result = await engine("ok.mjs", { timeoutMs: 2 ** 31 + 5 }).render(request());
    assert.equal(result.ok, true, "a limit above 2^31-1 ms is clamped, not turned into 1 ms by the timer");
  });

  it("uses the default time limit for a limit that is zero, negative or not a number", async () => {
    for (const timeoutMs of [0, -5, Number.NaN]) assert.equal((await engine("ok.mjs", { timeoutMs }).render(request())).ok, true, String(timeoutMs));
  });

  it("does not throw when it is built, or when it renders, from a working directory outside a checkout", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    // findRepoRoot gives back the folder it was given when no package.json with workspaces is above it,
    // so the default script would be <cwd>/modules/documents/render/render.py, which does not exist there.
    const built = createPdfEngine({ python: process.execPath, cwd: () => dir });
    assert.deepEqual(await built.render(request()), { ok: false, reason: "render-error" });
    assert.match(JSON.stringify(logged), /script not found/);
    const broken = createPdfEngine({
      python: process.execPath,
      cwd: () => {
        throw new Error("ENOENT: the working directory is gone");
      },
    });
    assert.deepEqual(await broken.render(request()), { ok: false, reason: "render-error" });
  });

  it("reports an interpreter that is missing or cannot run", async () => {
    assert.deepEqual(await createPdfEngine({ python: join(dir, "no-such-python"), script: script("ok.mjs") }).render(request()), { ok: false, reason: "interpreter-missing" });
    assert.deepEqual(await createPdfEngine({ python: dir, script: script("ok.mjs") }).render(request()), { ok: false, reason: "interpreter-missing" });
  });

  it("maps exit code 3 to WeasyPrint missing and any other failure to a render error", async () => {
    assert.deepEqual(await engine("noweasy.mjs").render(request()), { ok: false, reason: "weasyprint-missing" });
    assert.deepEqual(await engine("fail.mjs").render(request()), { ok: false, reason: "render-error" });
  });

  it("treats output that is not the expected JSON as a render error", async () => {
    for (const name of ["garbage.mjs", "shape.mjs", "badfield.mjs"]) assert.deepEqual(await engine(name).render(request()), { ok: false, reason: "render-error" }, name);
  });

  it("stops a render that runs past the time limit", async () => {
    const started = Date.now();
    assert.deepEqual(await engine("hang.mjs", { timeoutMs: 300 }).render(request()), { ok: false, reason: "timeout" });
    assert.ok(Date.now() - started < 4000);
  });

  it("stops a render that prints more than the limit instead of buffering it", async () => {
    assert.deepEqual(await engine("huge.mjs").render(request()), { ok: false, reason: "render-error" });
  });

  it("bounds what it keeps of stderr and still accepts a render that wrote a lot to it", async () => {
    assert.deepEqual(await engine("noisy.mjs").render(request()), { ok: true, pages: 1, fields: [] });
  });

  it("builds an engine from the environment that is not configured, or that cannot find its interpreter", async () => {
    assert.deepEqual(await pdfEngineFromEnv({}).render(request()), { ok: false, reason: "not-configured" });
    assert.deepEqual(await pdfEngineFromEnv({ DOCUMENTS_PYTHON: join(dir, "no-such-python") }).render(request()), { ok: false, reason: "interpreter-missing" });
  });

  it("reads the interpreter, the assets folder and the time limit from the environment", () => {
    assert.deepEqual(renderSettingsFromEnv({ DOCUMENTS_PYTHON: "/venv/bin/python", DOCUMENTS_ASSETS_DIR: "  /srv/assets ", DOCUMENTS_RENDER_TIMEOUT_MS: "90000" }), {
      python: "/venv/bin/python",
      assetsDir: "/srv/assets",
      timeoutMs: 90_000,
    });
    assert.deepEqual(renderSettingsFromEnv({}), { python: undefined, assetsDir: undefined, timeoutMs: undefined });
  });

  it("ignores a blank assets folder and a time limit that is not a positive whole number", () => {
    assert.equal(renderSettingsFromEnv({ DOCUMENTS_ASSETS_DIR: "   " }).assetsDir, undefined);
    for (const value of ["", "abc", "0", "-5", "1.5", "Infinity", " "]) assert.equal(renderSettingsFromEnv({ DOCUMENTS_RENDER_TIMEOUT_MS: value }).timeoutMs, undefined, JSON.stringify(value));
  });

  it("has a message for every failure that names the variable to set when it is the configuration", () => {
    const reasons: RenderFailure[] = ["not-configured", "interpreter-missing", "weasyprint-missing", "render-error", "timeout", "spawn-failed"];
    for (const reason of reasons) assert.ok(describeRenderFailure(reason).length > 20, reason);
    assert.match(describeRenderFailure("not-configured"), /DOCUMENTS_PYTHON/);
    assert.match(describeRenderFailure("interpreter-missing"), /DOCUMENTS_PYTHON/);
    assert.match(describeRenderFailure("weasyprint-missing"), /WeasyPrint/);
    assert.match(describeRenderFailure("spawn-failed"), /try again/i);
    assert.doesNotMatch(describeRenderFailure("spawn-failed"), /DOCUMENTS_PYTHON/, "a temporary failure does not send the owner to the settings");
  });
});
