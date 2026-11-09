import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeHtml, suggestFromFileName } from "../src/template-import.ts";
import { validateTemplate } from "../src/template-rules.ts";

test("suggests a name and a valid slug from the file name of any document", () => {
  assert.deepEqual(suggestFromFileName("Mutual NDA v2.html"), { name: "Mutual NDA v2", slug: "mutual-nda-v2" });
  assert.deepEqual(suggestFromFileName("contrato_de_servicios.HTM"), { name: "contrato de servicios", slug: "contrato-de-servicios" });
  assert.deepEqual(suggestFromFileName("C:\\docs\\Propuesta Comercial 2026.html"), { name: "Propuesta Comercial 2026", slug: "propuesta-comercial-2026" });
  assert.equal(suggestFromFileName("Acuerdo de Confidencialidad ñandú.html").slug, "acuerdo-de-confidencialidad-nandu");
});

test("the suggested slug passes the template rules, and a file name with nothing usable suggests nothing", () => {
  const { name, slug } = suggestFromFileName("x".repeat(200) + ".html");
  const checked = validateTemplate({ name, slug, kind: "other", refPrefix: "DOC", bodyHtml: "<p>{{A}}</p>" });
  assert.equal(checked.ok, true);
  assert.deepEqual(suggestFromFileName("¿¡.html").slug, "");
});

test("recognizes an HTML file by its name", () => {
  for (const name of ["a.html", "a.HTM", "a.xhtml"]) assert.equal(looksLikeHtml(name), true, name);
  for (const name of ["a.pdf", "a.html.exe", "html", "a.txt"]) assert.equal(looksLikeHtml(name), false, name);
});
