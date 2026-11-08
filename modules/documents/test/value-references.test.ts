import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDocumentHtml } from "../src/document-html.ts";
import { MULTI_LINE_MAX, SINGLE_LINE_MAX } from "../src/document-rules.ts";
import { checkReferences, referencedFields, resolveValues, type ValueField } from "../src/value-references.ts";

const line = (name: string, label = name): ValueField => ({ name, label, multiline: false });
const text = (name: string, label = name): ValueField => ({ name, label, multiline: true });
const PROFILE = { A_NOMBRE: "Acme", A_CORTO: "Acme" };
const REF = "NDA-2026-007";

function resolve(fields: ValueField[], values: Record<string, string>, profile: Record<string, string> = PROFILE) {
  return resolveValues({ fields, values, profile, ref: REF });
}
function values(result: ReturnType<typeof resolve>): Record<string, string> {
  assert.ok(result.ok, JSON.stringify(result));
  return result.values;
}
function errors(result: ReturnType<typeof resolve>): Record<string, string> {
  assert.equal(result.ok, false);
  return result.ok ? {} : result.errors;
}

describe("resolveValues", () => {
  it("returns values without markers exactly as they are", () => {
    const input = { B_NOMBRE: "Beta S.A.", FINALIDAD: "evaluar {una} colaboración {{ B }} {{x}}" };
    assert.deepEqual(values(resolve([line("B_NOMBRE"), line("FINALIDAD")], input)), input);
  });

  it("fills a profile marker and REF", () => {
    const out = values(resolve([line("PIE")], { PIE: "{{A_CORTO}} · Acuerdo {{REF}}" }));
    assert.equal(out.PIE, `Acme · Acuerdo ${REF}`);
  });

  it("fills a marker asked per document with the value of that field, whatever the order of the fields", () => {
    const fields = [line("B_CORTO"), line("B_NOMBRE")];
    assert.deepEqual(values(resolve(fields, { B_CORTO: "{{B_NOMBRE}}", B_NOMBRE: "Beta" })), { B_CORTO: "Beta", B_NOMBRE: "Beta" });
  });

  it("resolves a chain in dependency order and each value once", () => {
    const fields = [text("INTRO"), line("B_CORTO"), line("B_NOMBRE")];
    const out = values(resolve(fields, { INTRO: "{{A_CORTO}} y {{B_CORTO}}", B_CORTO: "{{B_NOMBRE}}", B_NOMBRE: "Beta" }));
    assert.equal(out.INTRO, "Acme y Beta");
  });

  it("uses a field's own resolved value in every field that refers to it", () => {
    const fields = [line("X"), line("Y"), line("Z")];
    const out = values(resolve(fields, { X: "{{Z}}!", Y: "{{Z}}?", Z: "z {{REF}}" }));
    assert.deepEqual(out, { X: `z ${REF}!`, Y: `z ${REF}?`, Z: `z ${REF}` });
  });

  it("does not scan substituted text again: a marker inside a profile value stays as written", () => {
    const profile = { A_CORTO: "Acme {{B_NOMBRE}} {{REF}}" };
    const out = values(resolve([line("PIE"), line("B_NOMBRE")], { PIE: "{{A_CORTO}}", B_NOMBRE: "Beta" }, profile));
    assert.equal(out.PIE, "Acme {{B_NOMBRE}} {{REF}}");
  });

  it("does not scan substituted text again: a group that stayed as written in a field is not resolved by the field that uses it", () => {
    const profile = { A_NOMBRE: "Acme" };
    const out = values(resolve([line("P"), line("Q")], { P: "{{Q}}", Q: "{{NOT_A_MARKER}} {{A_NOMBRE}}" }, profile));
    assert.equal(out.Q, "{{NOT_A_MARKER}} Acme");
    assert.equal(out.P, "{{NOT_A_MARKER}} Acme");
  });

  it("leaves unknown and malformed groups exactly as written", () => {
    const given = "{{UNKNOWN}} {{ A_NOMBRE }} {{a_nombre}} {{}} {{A-B}} {{OPEN} {{UNCLOSED";
    assert.equal(values(resolve([line("X")], { X: given })).X, given);
  });

  it("reads a marker next to braces as the marker engine does", () => {
    assert.equal(values(resolve([line("X")], { X: "{{{A_NOMBRE}}}" })).X, "{Acme}");
  });

  it("reports a profile marker the platform knows but the profile has no value for, on the field, instead of leaving it", () => {
    const result = errors(resolve([line("FIRMA", "Signer"), line("OK")], { FIRMA: "{{A_REPRESENTANTE}} · {{A_CARGO}}", OK: "fine" }));
    assert.deepEqual(Object.keys(result), ["FIRMA"]);
    assert.match(result.FIRMA!, /A_REPRESENTANTE/);
    assert.match(result.FIRMA!, /A_CARGO/);
    assert.match(result.FIRMA!, /owner profile/);
  });

  it("treats a name that is neither a field, REF nor a profile key as unknown text, not as an error", () => {
    assert.equal(values(resolve([line("X")], { X: "{{FREE_FORM}}" })).X, "{{FREE_FORM}}");
  });

  it("a marker asked per document wins over a profile key of the same name the profile lacks", () => {
    assert.deepEqual(values(resolve([line("A_CARGO"), line("X")], { A_CARGO: "Director", X: "{{A_CARGO}}" }, {})), { A_CARGO: "Director", X: "Director" });
  });

  it("reports a field that refers to itself", () => {
    const result = errors(resolve([line("A", "Alpha"), line("B")], { A: "x {{A}}", B: "ok" }));
    assert.deepEqual(Object.keys(result), ["A"]);
    assert.match(result.A!, /itself/);
  });

  it("reports every field of a cycle, naming the others by label", () => {
    const fields = [line("A", "Alpha"), line("B", "Beta"), line("C", "Gamma"), line("D", "Delta")];
    const result = errors(resolve(fields, { A: "{{B}}", B: "{{C}}", C: "{{A}}", D: "fine" }));
    assert.deepEqual(Object.keys(result).sort(), ["A", "B", "C"]);
    assert.match(result.A!, /Beta/);
    assert.match(result.A!, /Gamma/);
    assert.doesNotMatch(result.A!, /Alpha/);
    assert.match(result.B!, /Alpha/);
    assert.match(result.B!, /Gamma/);
  });

  it("does not report a field that only uses a cycle", () => {
    const result = errors(resolve([line("A"), line("B"), line("C")], { A: "{{B}}", B: "{{A}}", C: "{{A}}" }));
    assert.deepEqual(Object.keys(result).sort(), ["A", "B"]);
  });

  it("refuses a resolved value longer than the limit of its field, on that field", () => {
    const given = "x".repeat(SINGLE_LINE_MAX - 4);
    const result = errors(resolve([line("LONG"), line("BASE")], { LONG: "{{BASE}}{{BASE}}", BASE: given }));
    assert.deepEqual(Object.keys(result), ["LONG"]);
    assert.match(result.LONG!, new RegExp(`${SINGLE_LINE_MAX} characters`));
  });

  it("accepts a resolved value exactly at the limit and applies the paragraph limit to a paragraph", () => {
    const base = "y".repeat(SINGLE_LINE_MAX);
    assert.equal(values(resolve([line("A"), line("B")], { A: base, B: "{{A}}" })).B, base);
    const para = "z".repeat(MULTI_LINE_MAX);
    assert.equal(values(resolve([text("A"), text("B")], { A: para, B: "{{A}}" })).B, para);
    assert.equal(resolve([text("A"), text("B")], { A: para, B: "{{A}}x" }).ok, false);
  });

  it("refuses line breaks that a single-line field gets from a paragraph", () => {
    const result = errors(resolve([line("ONE"), text("MANY")], { ONE: "{{MANY}}", MANY: "a\nb" }));
    assert.deepEqual(Object.keys(result), ["ONE"]);
    assert.match(result.ONE!, /single line/);
  });

  it("lets a paragraph field keep the line breaks it gets", () => {
    assert.equal(values(resolve([text("A"), text("B")], { A: "a\nb", B: "x {{A}}" })).B, "x a\nb");
  });

  it("refuses a control character that arrives from the profile", () => {
    const result = errors(resolve([line("X")], { X: "{{A_NOMBRE}}" }, { A_NOMBRE: "Ac\u0007me" }));
    assert.match(result.X!, /control characters/);
  });

  it("refuses a value that is blank once resolved", () => {
    const result = errors(resolve([line("X", "Short name")], { X: "{{A_NOMBRE}}" }, { A_NOMBRE: "   " }));
    assert.equal(result.X, "Enter short name.");
  });

  it("is bounded: a value that expands into many fields cannot grow without limit", () => {
    const names = Array.from({ length: 40 }, (_, i) => `F${i}`);
    const fields = names.map((name) => line(name));
    const given: Record<string, string> = { F0: "x".repeat(SINGLE_LINE_MAX) };
    for (let i = 1; i < names.length; i++) given[names[i]!] = `{{F${i - 1}}}`.repeat(SINGLE_LINE_MAX / 6 | 0);
    const started = Date.now();
    const result = errors(resolve(fields, given));
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(Object.keys(result), ["F1"], "the first field that overflows is refused; the ones that use it are not computed");
  });

  it("leaves the plain text alone: no escaping at this stage", () => {
    const given = `<b>&"'{{UNKNOWN}}`;
    assert.equal(values(resolve([line("A"), line("B")], { A: given, B: "{{A}}" })).B, given);
  });

  it("does not let a value change the platform's REF or inject markup once the body is built", () => {
    const profile = { A_NOMBRE: `Acme <script>"&'` };
    const resolved = values(resolve([line("B_CORTO"), line("B_NOMBRE")], { B_CORTO: "{{A_NOMBRE}} / {{B_NOMBRE}}", B_NOMBRE: `Be<ta> & "Co" 'x' {{A_NOMBRE}}` }, profile));
    assert.equal(resolved.B_NOMBRE, `Be<ta> & "Co" 'x' Acme <script>"&'`);
    const html = buildDocumentHtml("<p>{{B_CORTO}}</p><i>{{REF}}</i>", {}, resolved, REF).html;
    assert.equal(html, "<p>Acme &lt;script&gt;&quot;&amp;&#39; / Be&lt;ta&gt; &amp; &quot;Co&quot; &#39;x&#39; Acme &lt;script&gt;&quot;&amp;&#39;</p><i>NDA-2026-007</i>");
  });

  it("prints a group that stayed as written literally, escaped once and never filled by the body engine", () => {
    const resolved = values(resolve([line("P"), line("B_NOMBRE")], { P: "{{FREE}} {{B_NOMBRE}}", B_NOMBRE: "{{A_NOMBRE}}" }));
    const html = buildDocumentHtml("<p>{{P}}</p>", {}, resolved, REF);
    assert.equal(html.html, "<p>{{FREE}} Acme</p>");
    assert.deepEqual(html.missing, []);
  });
});

describe("referencedFields", () => {
  it("lists the fields a text uses, in order of first appearance, once each", () => {
    assert.deepEqual(referencedFields("{{B}} y {{A_CORTO}} {{B}} {{C}} {{REF}} {{x}}", ["A", "B", "C"]), ["B", "C"]);
  });

  it("is empty for a text without markers of those fields", () => {
    assert.deepEqual(referencedFields("plain {{ B }}", ["B"]), []);
  });
});

describe("checkReferences", () => {
  const fields = (entries: Record<string, string>) => Object.entries(entries).map(([name, value]) => ({ name, label: name.toLowerCase(), text: value }));

  it("accepts references to other fields, profile markers that have a value and REF", () => {
    assert.deepEqual(checkReferences({ fields: fields({ INTRO: "{{A_CORTO}} {{B_CORTO}} {{REF}}", B_CORTO: "{{B_NOMBRE}}", B_NOMBRE: "" }), profile: PROFILE }), {});
  });

  it("names a marker this template does not know", () => {
    const result = checkReferences({ fields: fields({ INTRO: "{{NOPE}} and {{OTHER}} {{A_CORTO}}", B: "" }), profile: PROFILE });
    assert.deepEqual(Object.keys(result), ["INTRO"]);
    assert.match(result.INTRO!, /\{\{NOPE\}\}/);
    assert.match(result.INTRO!, /\{\{OTHER\}\}/);
  });

  it("names a profile marker the profile has no value for", () => {
    const result = checkReferences({ fields: fields({ INTRO: "{{A_CARGO}}" }), profile: PROFILE });
    assert.match(result.INTRO!, /A_CARGO/);
    assert.match(result.INTRO!, /owner profile/);
  });

  it("does not take a malformed group for a reference", () => {
    assert.deepEqual(checkReferences({ fields: fields({ INTRO: "{{ A }} {{}} {{a}}" }), profile: PROFILE }), {});
  });

  it("reports each default of a cycle, naming the others", () => {
    const result = checkReferences({ fields: fields({ A: "{{B}}", B: "{{A}}", C: "{{A}}" }), profile: PROFILE });
    assert.deepEqual(Object.keys(result).sort(), ["A", "B"]);
    assert.match(result.A!, /\bb\b/);
    assert.match(result.B!, /\ba\b/);
  });

  it("reports a default that refers to itself", () => {
    const result = checkReferences({ fields: fields({ A: "{{A}}" }), profile: PROFILE });
    assert.match(result.A!, /itself/);
  });
});
