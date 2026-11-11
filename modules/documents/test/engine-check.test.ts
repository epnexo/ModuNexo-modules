import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runEngineCheck } from "../web/engine-check-route.ts";
import { checkEngine, describeEngineCheck } from "../src/engine-check.ts";
import { type PdfEngine, type RenderFailure, describeRenderFailure } from "../src/pdf-engine.ts";

let base: string;
before(async () => {
  base = await mkdtemp(join(tmpdir(), "engine-check-test-"));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

const answering = (pages: number): PdfEngine => ({
  async render({ pdfPath }) {
    await writeFile(pdfPath, "%PDF-fake");
    return { ok: true, pages, fields: [] };
  },
});
const failing = (reason: RenderFailure): PdfEngine => ({ render: async () => ({ ok: false, reason }) });

describe("checkEngine", () => {
  it("renders one test page and reports the page count", async () => {
    assert.deepEqual(await checkEngine({ engine: answering(1), tmpBase: base }), { ok: true, pages: 1 });
  });

  it("hands the engine a document and a path inside its own folder", async () => {
    let seen: { html: string; pdfPath: string } | undefined;
    const engine: PdfEngine = {
      async render(request) {
        seen = request;
        return { ok: true, pages: 1, fields: [] };
      },
    };
    await checkEngine({ engine, tmpBase: base });
    assert.ok(seen !== undefined);
    assert.match(seen.html, /^<!doctype html>/i);
    assert.ok(seen.pdfPath.startsWith(base), "the PDF goes under the base folder given");
  });

  it("carries every failure reason through unchanged", async () => {
    for (const reason of ["not-configured", "interpreter-missing", "weasyprint-missing", "render-error", "timeout", "spawn-failed", "engine-unreachable", "engine-unauthorized"] as const) {
      assert.deepEqual(await checkEngine({ engine: failing(reason), tmpBase: base }), { ok: false, reason });
    }
  });

  it("removes its folder after a success, a failure and a throw", async () => {
    await checkEngine({ engine: answering(1), tmpBase: base });
    await checkEngine({ engine: failing("timeout"), tmpBase: base });
    await assert.rejects(checkEngine({ engine: { render: async () => Promise.reject(new Error("boom")) }, tmpBase: base }), /boom/);
    assert.deepEqual(await readdir(base), []);
  });
});

describe("describeEngineCheck", () => {
  it("says it is connected when the page rendered", () => {
    const answer = describeEngineCheck({ ok: true, pages: 1 });
    assert.equal(answer.ok, true);
    assert.match(answer.message, /^Connected\./);
  });

  it("uses the same wording as the template preview for every failure, and names the setting to fix", () => {
    for (const reason of ["not-configured", "engine-unreachable", "engine-unauthorized", "timeout", "weasyprint-missing"] as const) {
      const answer = describeEngineCheck({ ok: false, reason });
      assert.equal(answer.ok, false);
      assert.equal(answer.message, describeRenderFailure(reason));
    }
    assert.match(describeEngineCheck({ ok: false, reason: "engine-unauthorized" }).message, /token/);
    assert.match(describeEngineCheck({ ok: false, reason: "engine-unreachable" }).message, /address/);
  });
});

describe("runEngineCheck", () => {
  it("answers with the platform's check contract, { ok, message }", async () => {
    assert.equal((await runEngineCheck(answering(1))).ok, true);
    assert.deepEqual(await runEngineCheck(failing("engine-unauthorized")), { ok: false, message: describeRenderFailure("engine-unauthorized") });
  });
});
