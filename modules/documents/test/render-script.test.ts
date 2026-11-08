import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPdfEngine } from "../src/pdf-engine.ts";

const run = promisify(execFile);
const RENDER = fileURLToPath(new URL("../render/render.py", import.meta.url));

let dir: string;
let assets: string;
let outside: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "documents-render-"));
  assets = join(dir, "assets");
  outside = join(dir, "outside");
  await mkdir(join(assets, "fonts"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(assets, "logo.png"), "png-bytes");
  await writeFile(join(outside, "secret.txt"), "secret");
  await writeFile(join(outside, "evil.css"), "[data-campo] { display: none }");
  await symlink(join(outside, "secret.txt"), join(assets, "link-out.txt"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The script's fetcher needs no WeasyPrint, so any Python 3 can check what it allows. */
async function fetcherVerdicts(python: string, urls: string[], assetsDir: string | null): Promise<Record<string, string> | undefined> {
  const probe = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("render", sys.argv[1]); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
fetcher = mod.SafeFetcher(sys.argv[2] or None)
out = {}
for url in json.loads(sys.argv[3]):
    try:
        r = fetcher.fetch(url)
        body = r["string"] if isinstance(r, dict) else r._file_obj.read()
        out[url] = "allowed:" + body.decode("latin-1")[:12]
    except Exception as e:
        out[url] = "refused:" + type(e).__name__
print(json.dumps(out))`;
  try {
    // -B and the variable keep the interpreter from writing a __pycache__ next to the script it imports.
    const { stdout } = await run(python, ["-B", "-c", probe, RENDER, assetsDir ?? "", JSON.stringify(urls)], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    return JSON.parse(stdout) as Record<string, string>;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

const PYTHON = () => process.env.DOCUMENTS_PYTHON?.trim() || "python3";

/** Runs a few lines of Python that import the script as a module (no WeasyPrint needed) and returns what they print. */
async function probe(code: string, ...args: string[]): Promise<string | undefined> {
  const loader = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("render", sys.argv[1]); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
`;
  try {
    const { stdout } = await run(PYTHON(), ["-B", "-c", loader + code, RENDER, ...args], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    return stdout;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The script run for real, with its stdin, against a folder that may hold a stand-in `weasyprint` package. */
function runScript(args: string[], html: string, pythonPath?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON(), ["-B", RENDER, ...args], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...(pythonPath ? { PYTHONPATH: pythonPath } : {}) } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(html);
  });
}

/** A stand-in for the part of WeasyPrint the script uses: it logs and warns, as the real one can, and writes (or fails to write) the PDF. */
async function stubWeasyprint(root: string, writePdf: string): Promise<string> {
  const stub = join(root, "stub");
  await mkdir(join(stub, "weasyprint", "text"), { recursive: true });
  await writeFile(
    join(stub, "weasyprint", "__init__.py"),
    `import logging, warnings
class CSS:
    def __init__(self, **kwargs): pass
class _Document:
    pages = []
    def write_pdf(self, path):
${writePdf}
class HTML:
    def __init__(self, **kwargs): pass
    def render(self, **kwargs):
        logging.getLogger("weasyprint").warning("Failed to load image at SECRET-DOC-TEXT")
        warnings.warn("SECRET-DOC-TEXT")
        return _Document()
`,
  );
  await writeFile(join(stub, "weasyprint", "text", "__init__.py"), "");
  await writeFile(join(stub, "weasyprint", "text", "fonts.py"), "class FontConfiguration:\n    pass\n");
  return stub;
}

describe("render script: what it writes", () => {
  const stubbed = async (writePdf: string, name: string) => {
    const folder = join(dir, name);
    await mkdir(folder);
    return { folder, pythonPath: await stubWeasyprint(folder, writePdf) };
  };

  it("writes the PDF to a temporary file in the destination folder and moves it into place only when the render finished", async () => {
    const { folder, pythonPath } = await stubbed(`        open(path, "w").write("NEW")\n        open(path + ".seen", "w").write("")`, "atomic-ok");
    const out = join(folder, "out.pdf");
    await writeFile(out, "OLD");
    const result = await runScript(["--pdf", out], "<p>x</p>", pythonPath);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(out, "utf8"), "NEW");
    const left = (await readdir(folder)).filter((name) => name !== "stub" && name !== "out.pdf");
    assert.equal(left.length, 1, "only the marker the stand-in wrote next to the temporary file");
    assert.match(left[0]!, /^\..+\.pdf\.seen$/, "the stand-in was handed a hidden temporary file, not the final path");
  });

  it("leaves the existing file and no temporary file behind when the render fails halfway", async () => {
    const { folder, pythonPath } = await stubbed(`        open(path, "w").write("HALF")\n        raise RuntimeError("disk on fire SECRET-DOC-TEXT")`, "atomic-fail");
    const out = join(folder, "out.pdf");
    await writeFile(out, "OLD");
    const result = await runScript(["--pdf", out], "<p>x</p>", pythonPath);
    assert.equal(result.code, 1);
    assert.equal(await readFile(out, "utf8"), "OLD", "the previous file is untouched");
    assert.deepEqual((await readdir(folder)).sort(), ["out.pdf", "stub"], "the half-written temporary file is removed");
    assert.equal(result.stderr.trim(), "render failed: RuntimeError", "the type only: the message could echo document text");
  });

  it("keeps everything WeasyPrint logs or warns about off stderr", async () => {
    const { folder, pythonPath } = await stubbed(`        open(path, "w").write("NEW")`, "quiet");
    const result = await runScript(["--pdf", join(folder, "out.pdf")], "<p>x</p>", pythonPath);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "", "log records and warnings can carry document text");
  });
});

describe("render script: file URLs", () => {
  it("builds file URLs the fetcher can read back, for an assets folder with #, ?, %, quotes and spaces in its path", async (t) => {
    const odd = join(dir, `odd #1 ?x %41 "q" 'q'`);
    await mkdir(join(odd, "fonts"), { recursive: true });
    await writeFile(join(odd, "logo.png"), "png-bytes");
    await writeFile(join(odd, "fonts", "Inter-Regular.ttf"), "font-bytes");
    const out = await probe(
      `from urllib.parse import urljoin
fetcher = mod.SafeFetcher(sys.argv[2])
base = mod.directory_url(fetcher.root)
css = mod.font_css(sys.argv[2])
font_url = css.split('url("')[1].split('")')[0]
body = lambda r: (r["string"] if isinstance(r, dict) else r._file_obj.read()).decode()
print(json.dumps({"image": body(fetcher.fetch(urljoin(base, "logo.png"))), "font": body(fetcher.fetch(font_url))}))`,
      odd,
    );
    if (out === undefined) return t.skip("no Python 3 to run the script");
    assert.deepEqual(JSON.parse(out), { image: "png-bytes", font: "font-bytes" });
  });

  it("does not decode a path twice: a folder named like an escape is not another folder", async (t) => {
    const tricky = join(dir, "100%25");
    const other = join(dir, "100%");
    await mkdir(tricky);
    await mkdir(other);
    await writeFile(join(tricky, "a.txt"), "tricky");
    await writeFile(join(other, "a.txt"), "other");
    const out = await probe(`from urllib.parse import urljoin
fetcher = mod.SafeFetcher(sys.argv[2])
r = fetcher.fetch(urljoin(mod.directory_url(fetcher.root), "a.txt"))
print(r["string"].decode() if isinstance(r, dict) else r._file_obj.read().decode())`, tricky);
    if (out === undefined) return t.skip("no Python 3 to run the script");
    assert.equal(out.trim(), "tricky");
  });
});

describe("render script: loading it for a probe", () => {
  it("leaves no bytecode folder next to the script", async (t) => {
    const folder = join(fileURLToPath(new URL("../render", import.meta.url)), "__pycache__");
    const verdicts = await fetcherVerdicts(process.env.DOCUMENTS_PYTHON?.trim() || "python3", [], null);
    if (!verdicts) return t.skip("no Python 3 to run the script");
    assert.equal(existsSync(folder), false, "a test run must not dirty the working tree");
  });
});

describe("render script: what it may fetch", () => {
  it("allows data: URIs and files inside the assets folder, and refuses everything else", async (t) => {
    const python = process.env.DOCUMENTS_PYTHON?.trim() || "python3";
    const url = (path: string) => pathToFileURL(path).href;
    const urls = {
      data: "data:text/plain;base64,aGVsbG8=",
      inside: url(join(assets, "logo.png")),
      traversal: `${url(assets)}/../outside/secret.txt`,
      encodedTraversal: `${url(assets)}/..%2foutside/secret.txt`,
      outside: url(join(outside, "secret.txt")),
      symlinkOut: url(join(assets, "link-out.txt")),
      sibling: url(`${assets}-sibling/x`),
      passwd: "file:///etc/passwd",
      remoteHost: `file://example.com${join(assets, "logo.png")}`,
      http: "http://127.0.0.1:9/x.png",
      https: "https://example.com/x.css",
      ftp: "ftp://example.com/x",
      relative: "logo.png",
    };
    const verdicts = await fetcherVerdicts(python, Object.values(urls), assets);
    if (!verdicts) return t.skip(`no Python 3 to run the script (tried ${python})`);
    const verdict = (name: keyof typeof urls) => verdicts[urls[name]]!;
    assert.equal(verdict("data"), "allowed:hello");
    assert.equal(verdict("inside"), "allowed:png-bytes");
    for (const name of ["traversal", "encodedTraversal", "outside", "symlinkOut", "sibling", "passwd", "remoteHost", "http", "https", "ftp", "relative"] as const) {
      assert.match(verdict(name), /^refused:/, name);
    }
  });

  it("refuses every file when no assets folder is given, and still allows data: URIs", async (t) => {
    const python = process.env.DOCUMENTS_PYTHON?.trim() || "python3";
    const file = pathToFileURL(join(assets, "logo.png")).href;
    const data = "data:text/plain;base64,aGVsbG8=";
    const verdicts = await fetcherVerdicts(python, [file, data], null);
    if (!verdicts) return t.skip(`no Python 3 to run the script (tried ${python})`);
    assert.match(verdicts[file]!, /^refused:/);
    assert.equal(verdicts[data], "allowed:hello");
  });
});

const PAGE = (body: string, head = "") => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>@page { size: A4; margin: 20mm } .box { height: 20mm; width: 60mm; border: 1px solid black }</style>${head}</head><body>${body}</body></html>`;

describe("render script with the real WeasyPrint", () => {
  const python = process.env.DOCUMENTS_PYTHON?.trim();
  const real = (name: string, body: (python: string) => Promise<void>) => it(name, async (t) => (python ? body(python) : t.skip("DOCUMENTS_PYTHON is not set, so the real WeasyPrint is not available")));

  real("renders a PDF and reports the page count and the signature boxes in page fractions", async (python) => {
    const pdfPath = join(dir, "real.pdf");
    const html = PAGE(`<p>Hola ñ — acuerdo</p><div class="box" data-campo="firma-1"></div><div style="page-break-before: always"></div><div class="box" data-campo="firma-2"></div><div class="box" data-campo="firma-2"></div>`);
    const result = await createPdfEngine({ python, assetsDir: assets, timeoutMs: 60_000 }).render({ html, pdfPath });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.pages, 2);
    assert.deepEqual(result.fields.map((f) => [f.id, f.page]), [["firma-1", 0], ["firma-2", 1]], "a repeated id is reported once, at its first box");
    for (const f of result.fields) {
      for (const v of [f.x, f.y, f.w, f.h]) assert.ok(v >= 0 && v <= 1, `${f.id} ${v}`);
      assert.ok(f.x + f.w <= 1 && f.y + f.h <= 1);
    }
    assert.ok(Math.abs(result.fields[0]!.w - 60 / 210) < 0.01, "60 mm on an A4 page is 60/210 of its width");
    assert.equal((await readFile(pdfPath)).subarray(0, 5).toString(), "%PDF-");
  });

  real("does not load a stylesheet or an image from outside the assets folder", async (python) => {
    const evil = pathToFileURL(join(outside, "evil.css")).href;
    const html = PAGE(`<div class="box" data-campo="firma-1"></div><img src="http://127.0.0.1:9/x.png">`, `<link rel="stylesheet" href="${evil}">`);
    const result = await createPdfEngine({ python, assetsDir: assets }).render({ html, pdfPath: join(dir, "refused.pdf") });
    assert.equal(result.ok && result.fields.length, 1, "the stylesheet that would hide the box was not read");
  });

  real("renders with no assets folder", async (python) => {
    const result = await createPdfEngine({ python }).render({ html: PAGE(`<p>x</p><div class="box" data-campo="a"></div>`), pdfPath: join(dir, "bare.pdf") });
    assert.equal(result.ok && result.pages, 1);
  });

  real("reports an unwritable output path as a render error", async (python) => {
    const result = await createPdfEngine({ python }).render({ html: PAGE("<p>x</p>"), pdfPath: join(dir, "no-such-folder", "x.pdf") });
    assert.deepEqual(result, { ok: false, reason: "render-error" });
  });
});
