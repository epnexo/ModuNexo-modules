import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDocumentHtml, sampleReference, templatePreviewHtml } from "../src/document-html.ts";
import { formatReference } from "../src/reference.ts";
import { substitute } from "../src/markers.ts";

const BODY = `<p>{{REF}} {{A_NOMBRE}} for {{B_NOMBRE}} on {{FECHA}} / {{B_NOMBRE}} {{ bad }}</p>`;

describe("buildDocumentHtml", () => {
  it("fills REF, the profile values and the entered values with escaping, in one pass", () => {
    const built = buildDocumentHtml(BODY, { A_NOMBRE: "Acme & <Sons>" }, { B_NOMBRE: "{{A_NOMBRE}}", FECHA: "<b>1</b>" }, "NDA-2026-004");
    assert.deepEqual(built, substitute(BODY, { A_NOMBRE: "Acme & <Sons>", B_NOMBRE: "{{A_NOMBRE}}", FECHA: "<b>1</b>", REF: "NDA-2026-004" }));
    assert.equal(built.html, "<p>NDA-2026-004 Acme &amp; &lt;Sons&gt; for {{A_NOMBRE}} on &lt;b&gt;1&lt;/b&gt; / {{A_NOMBRE}} {{ bad }}</p>");
    assert.deepEqual(built.missing, []);
  });

  it("reports a marker without a value and leaves it as written", () => {
    const built = buildDocumentHtml(BODY, {}, {}, "NDA-2026-004");
    assert.deepEqual(built.missing, ["A_NOMBRE", "B_NOMBRE", "FECHA"]);
    assert.match(built.html, /\{\{A_NOMBRE\}\}/);
  });

  it("lets the platform's REF win over a value with the same name", () => {
    assert.equal(buildDocumentHtml("{{REF}}", {}, { REF: "FAKE" }, "NDA-2026-004").html, "NDA-2026-004");
  });
});

describe("sampleReference", () => {
  it("keeps the template's prefix and shows the shape instead of numbers", () => {
    assert.equal(sampleReference("NDA"), "NDA-YYYY-NNN");
    assert.equal(sampleReference("CON2"), "CON2-YYYY-NNN");
  });

  it("can never be a number the platform issues", () => {
    const issued = formatReference("NDA", 2026, 1);
    assert.match(issued, /^NDA-\d{4}-\d{3,}$/);
    assert.doesNotMatch(sampleReference("NDA"), /^[A-Z0-9]{1,10}-\d{4}-\d{3,}$/);
  });
});

describe("templatePreviewHtml", () => {
  const template = { refPrefix: "NDA", bodyHtml: BODY };

  it("fills the profile, writes the sample reference and puts each asked marker between square brackets", () => {
    const built = templatePreviewHtml(template, { A_NOMBRE: "Acme & <Sons>", UNUSED: "x" });
    assert.equal(built.html, "<p>NDA-YYYY-NNN Acme &amp; &lt;Sons&gt; for [B_NOMBRE] on [FECHA] / [B_NOMBRE] {{ bad }}</p>");
    assert.deepEqual(built.missing, []);
  });

  it("is the same text creation builds when the asked values are the placeholders", () => {
    const profile = { A_NOMBRE: "Acme" };
    const asCreated = buildDocumentHtml(BODY, profile, { B_NOMBRE: "[B_NOMBRE]", FECHA: "[FECHA]" }, sampleReference("NDA"));
    assert.equal(templatePreviewHtml(template, profile).html, asCreated.html);
  });

  it("still previews a body with malformed groups, no markers, or a marker the profile also has twice", () => {
    assert.equal(templatePreviewHtml({ refPrefix: "NDA", bodyHtml: "<p>{{ x }} {{}} {{lower}}</p>" }, {}).html, "<p>{{ x }} {{}} {{lower}}</p>");
    assert.equal(templatePreviewHtml({ refPrefix: "NDA", bodyHtml: "" }, {}).html, "");
    assert.equal(templatePreviewHtml({ refPrefix: "NDA", bodyHtml: "{{A}}{{A}}" }, { A: "1" }).html, "11");
  });

  it("does not expand a profile value that looks like a marker", () => {
    assert.equal(templatePreviewHtml({ refPrefix: "NDA", bodyHtml: "{{A}} {{B}}" }, { A: "{{B}}" }).html, "{{B}} [B]");
  });

  it("keeps showing bracketed marker names for a template whose variables have defaults and labels", () => {
    const withSettings = { ...template, variables: { B_NOMBRE: { label: "Nombre", default: "Beta" }, FECHA: { kind: "date" as const, default: "hoy" } } };
    assert.equal(templatePreviewHtml(withSettings, { A_NOMBRE: "Acme" }).html, templatePreviewHtml(template, { A_NOMBRE: "Acme" }).html);
    assert.doesNotMatch(templatePreviewHtml(withSettings, {}).html, /Beta|hoy|Nombre/);
  });
});
