import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createHttpPdfEngine, describeRenderFailure, pdfEngineFromEnv } from "../src/pdf-engine.ts";

const FIELDS = [{ id: "firma-1", page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.04 }];
const PDF = Buffer.from("%PDF-1.7 fake");

let server: Server;
let url: string;
let seen: { auth: string | undefined; body: string; path: string | undefined } | undefined;
let behave: (res: ServerResponse) => void;
let dir: string;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "http-engine-"));
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen = { auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8"), path: req.url };
      behave(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

describe("the HTTP PDF engine", () => {
  it("sends the HTML with the token, writes the PDF where it is asked and returns the pages and boxes", async () => {
    behave = (res) => json(res, 200, { pages: 2, fields: FIELDS, pdf: PDF.toString("base64") });
    const pdfPath = join(dir, "a.pdf");
    const result = await createHttpPdfEngine({ url: `${url}/`, token: "secret-token" }).render({ html: "<h1>Hola</h1>", pdfPath });
    assert.deepEqual(result, { ok: true, pages: 2, fields: FIELDS });
    assert.deepEqual(await readFile(pdfPath), PDF);
    assert.deepEqual(seen, { auth: "Bearer secret-token", body: "<h1>Hola</h1>", path: "/render" });
  });

  it("reports an unset token without calling the service", async () => {
    seen = undefined;
    assert.deepEqual(await createHttpPdfEngine({ url, token: undefined }).render({ html: "x", pdfPath: join(dir, "b.pdf") }), { ok: false, reason: "engine-unauthorized" });
    assert.equal(seen, undefined);
  });

  for (const [name, status, body, reason] of [
    ["a refused token", 401, { error: "unauthorized" }, "engine-unauthorized"],
    ["WeasyPrint missing in the service", 503, { error: "weasyprint-missing" }, "weasyprint-missing"],
    ["the service's time limit", 504, { error: "timeout" }, "timeout"],
    ["any other failure", 500, { error: "render-error" }, "render-error"],
    ["an answer without a PDF", 200, { pages: 1, fields: [] }, "render-error"],
    ["an answer with a broken box", 200, { pages: 1, fields: [{ id: "x" }], pdf: "AA==" }, "render-error"],
  ] as const) {
    it(`maps ${name} to ${reason} and writes nothing`, async () => {
      behave = (res) => json(res, status, body);
      const pdfPath = join(dir, `${reason}.pdf`);
      assert.deepEqual(await createHttpPdfEngine({ url, token: "t" }).render({ html: "x", pdfPath }), { ok: false, reason });
      await assert.rejects(readFile(pdfPath));
    });
  }

  it("treats a body that is not JSON as a render error", async () => {
    behave = (res) => {
      res.writeHead(502);
      res.end("<html>bad gateway</html>");
    };
    assert.deepEqual(await createHttpPdfEngine({ url, token: "t" }).render({ html: "x", pdfPath: join(dir, "c.pdf") }), { ok: false, reason: "render-error" });
  });

  it("reports a service that cannot be reached, and one that is too slow", async () => {
    assert.deepEqual(await createHttpPdfEngine({ url: "http://127.0.0.1:1", token: "t" }).render({ html: "x", pdfPath: join(dir, "d.pdf") }), { ok: false, reason: "engine-unreachable" });
    behave = () => {};
    assert.deepEqual(await createHttpPdfEngine({ url, token: "t", timeoutMs: 100 }).render({ html: "x", pdfPath: join(dir, "e.pdf") }), { ok: false, reason: "timeout" });
  });

  it("does not follow a redirect with the token", async () => {
    behave = (res) => {
      res.writeHead(302, { location: "http://192.0.2.1/steal" });
      res.end();
    };
    assert.deepEqual(await createHttpPdfEngine({ url, token: "t" }).render({ html: "x", pdfPath: join(dir, "f.pdf") }), { ok: false, reason: "engine-unreachable" });
  });

  it("is chosen when the engine address is set, and the local interpreter is used otherwise", async () => {
    behave = (res) => json(res, 200, { pages: 1, fields: [], pdf: PDF.toString("base64") });
    const http = pdfEngineFromEnv({ DOCUMENTS_ENGINE_URL: url, DOCUMENTS_ENGINE_TOKEN: "t", DOCUMENTS_PYTHON: "/nope" });
    assert.equal((await http.render({ html: "x", pdfPath: join(dir, "g.pdf") })).ok, true);
    assert.deepEqual(await pdfEngineFromEnv({}).render({ html: "x", pdfPath: join(dir, "h.pdf") }), { ok: false, reason: "not-configured" });
  });

  it("has a message for each new failure that names the setting to fix", () => {
    assert.match(describeRenderFailure("engine-unreachable"), /engine address.*Documents settings/);
    assert.match(describeRenderFailure("engine-unauthorized"), /engine token.*Documents settings/);
  });
});
