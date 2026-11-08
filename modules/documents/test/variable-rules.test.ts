import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type VariableRow, submittedVariableRows, validateVariables, variableFieldName, variableRows } from "../src/variable-rules.ts";

const row = (marker: string, extra: Partial<VariableRow> = {}): VariableRow => ({ marker, label: "", help: "", kind: "", default: "", locale: "es", ...extra });
const PROFILE = { A_NOMBRE: "Acme", A_CORTO: "Acme" };
const check = (submitted: VariableRow[], askable: string[] = submitted.map((r) => r.marker), existing = {}) => validateVariables({ askable, submitted, existing, profile: PROFILE });
const settingsOf = (result: ReturnType<typeof check>) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ok ? result.settings : {};
};
const errorsOf = (result: ReturnType<typeof check>) => {
  assert.equal(result.ok, false);
  return result.ok ? {} : result.errors;
};

describe("reading the submitted rows", () => {
  it("names the inputs variables.<MARKER>.<field>", () => {
    assert.equal(variableFieldName("B_NOMBRE", "label"), "variables.B_NOMBRE.label");
  });

  it("groups the entries by marker, in the order they appear, and keeps the text as typed", () => {
    const rows = submittedVariableRows({
      name: "ignored",
      "variables.B_NOMBRE.label": "  Nombre  ",
      "variables.B_NOMBRE.kind": "line",
      "variables.FECHA.default": "a\r\nb",
      "variables.B_NOMBRE.help": "Ayuda",
      "variables.FECHA.locale": "en",
    });
    assert.deepEqual(rows, [
      { marker: "B_NOMBRE", label: "  Nombre  ", help: "Ayuda", kind: "line", default: "", locale: "es" },
      { marker: "FECHA", label: "", help: "", kind: "", default: "a\nb", locale: "en" },
    ]);
  });

  it("ignores keys that are not a valid marker and field, and non-text entries", () => {
    const rows = submittedVariableRows({
      "variables.b_low.label": "x",
      "variables..label": "x",
      "variables.X.other": "x",
      "variables.X.label.extra": "x",
      "variables.Y.label": undefined,
      "variables.constructor.label": "x",
      variables: "x",
    });
    assert.deepEqual(rows, []);
  });

  it("shows stored settings as rows for the markers asked, blank where nothing is set and Spanish for the date language", () => {
    const rows = variableRows(["B_NOMBRE", "FECHA", "PIE"], { FECHA: { label: "Fecha", kind: "date", locale: "en", default: "x" }, GONE: { label: "not asked" } });
    assert.deepEqual(rows, [
      row("B_NOMBRE"),
      { marker: "FECHA", label: "Fecha", help: "", kind: "date", default: "x", locale: "en" },
      row("PIE"),
    ]);
  });
});

describe("validateVariables: what is kept", () => {
  it("keeps the settings that are set and leaves a blank label, help and default as not set", () => {
    const settings = settingsOf(check([row("B_NOMBRE", { label: " Nombre ", help: " Ayuda ", default: " Beta " }), row("PIE", { label: "  ", help: "", default: "\n" })]));
    assert.deepEqual(settings, { B_NOMBRE: { label: "Nombre", help: "Ayuda", default: "Beta" } });
  });

  it("stores the kind when chosen and nothing when blank", () => {
    assert.deepEqual(settingsOf(check([row("A", { kind: "text" }), row("B", { kind: "line" }), row("C")])), { A: { kind: "text" }, B: { kind: "line" } });
  });

  it("stores the locale for a date, Spanish when blank, and drops it for any other kind", () => {
    const settings = settingsOf(check([row("A", { kind: "date", locale: "en" }), row("B", { kind: "date", locale: "" }), row("C", { kind: "line", locale: "en" }), row("D", { locale: "en" })]));
    assert.deepEqual(settings, { A: { kind: "date", locale: "en" }, B: { kind: "date", locale: "es" }, C: { kind: "line" } });
  });

  it("gives back the rows as they will be shown next: normalized, in the order asked", () => {
    const result = check([row("B", { label: " L " }), row("A", { kind: "date", locale: "en" })], ["A", "B"]);
    assert.equal(result.ok && result.rows.map((r) => r.marker).join(), "A,B");
    assert.deepEqual(result.ok && result.rows[1], { marker: "B", label: "L", help: "", kind: "", default: "", locale: "es" });
  });
});

describe("validateVariables: limits", () => {
  it("allows a label of 80 characters, a help of 200 and nothing longer", () => {
    assert.equal(check([row("A", { label: "x".repeat(80), help: "y".repeat(200) })]).ok, true);
    const errors = errorsOf(check([row("A", { label: "x".repeat(81), help: "y".repeat(201) })]));
    assert.deepEqual(Object.keys(errors).sort(), ["A.help", "A.label"]);
    assert.match(errors["A.label"]!, /80/);
    assert.match(errors["A.help"]!, /200/);
  });

  it("limits a default to what the value has for its kind: 200 for a line and a date, 2000 for long text", () => {
    assert.equal(check([row("A", { default: "x".repeat(200) }), row("B", { kind: "date", default: "x".repeat(200) }), row("C", { kind: "text", default: "x".repeat(2000) })]).ok, true);
    const errors = errorsOf(check([row("A", { default: "x".repeat(201) }), row("B", { kind: "date", default: "x".repeat(201) }), row("C", { kind: "text", default: "x".repeat(2001) })]));
    assert.deepEqual(Object.keys(errors).sort(), ["A.default", "B.default", "C.default"]);
  });

  it("takes the limit from the word rule when no kind is chosen: a marker named INTRO is long text", () => {
    assert.equal(check([row("INTRO", { default: "x".repeat(2000) })]).ok, true);
    assert.equal(check([row("INTRO", { kind: "line", default: "x".repeat(201) })]).ok, false);
    assert.equal(check([row("B_NOMBRE", { kind: "text", default: "x".repeat(201) })]).ok, true);
  });

  it("refuses a line break in a default unless the effective kind is long text", () => {
    assert.match(errorsOf(check([row("A", { default: "a\nb" })]))["A.default"]!, /single line/);
    assert.match(errorsOf(check([row("A", { kind: "date", default: "a\nb" })]))["A.default"]!, /single line/);
    assert.deepEqual(settingsOf(check([row("A", { kind: "text", default: "a\nb" })])), { A: { kind: "text", default: "a\nb" } });
    assert.deepEqual(settingsOf(check([row("INTRO", { default: "a\nb" })])), { INTRO: { default: "a\nb" } });
  });

  it("refuses control characters everywhere; only a line break is allowed, and only in a long-text default", () => {
    for (const bad of ["a\u0000b", "a\u001bb", "a\u007fb", "a\tb"]) {
      assert.match(errorsOf(check([row("A", { label: bad })]))["A.label"]!, /control/, `label ${JSON.stringify(bad)}`);
      assert.match(errorsOf(check([row("A", { help: bad })]))["A.help"]!, /control/, `help ${JSON.stringify(bad)}`);
      assert.match(errorsOf(check([row("A", { default: bad })]))["A.default"]!, /control/, `default ${JSON.stringify(bad)}`);
      assert.match(errorsOf(check([row("A", { kind: "text", default: bad })]))["A.default"]!, /control/, `text default ${JSON.stringify(bad)}`);
    }
    assert.match(errorsOf(check([row("A", { label: "a\nb" })]))["A.label"]!, /control|single line/);
    assert.match(errorsOf(check([row("A", { help: "a\nb" })]))["A.help"]!, /control|single line/);
  });

  it("accepts only the fixed kinds and locales", () => {
    const errors = errorsOf(check([row("A", { kind: "number" }), row("B", { kind: "date", locale: "fr" })]));
    assert.deepEqual(Object.keys(errors).sort(), ["A.kind", "B.locale"]);
  });

  it("reports every error at once, keyed by marker and field", () => {
    const errors = errorsOf(check([row("A", { label: "x".repeat(81) }), row("B", { default: "{{X}}" }), row("C")]));
    assert.deepEqual(Object.keys(errors).sort(), ["A.label", "B.default"]);
  });
});

describe("a default may use other fields", () => {
  it("accepts a marker asked per document, a profile marker that has a value and REF", () => {
    const settings = settingsOf(check([row("PIE", { default: "{{A_CORTO}} y {{B_CORTO}} · {{REF}}" }), row("B_CORTO", { default: "{{B_NOMBRE}}" }), row("B_NOMBRE")]));
    assert.equal(settings.PIE?.default, "{{A_CORTO}} y {{B_CORTO}} · {{REF}}");
    assert.equal(settings.B_CORTO?.default, "{{B_NOMBRE}}");
  });

  it("refuses a marker the template does not know, naming it, on that default only", () => {
    const errors = errorsOf(check([row("A", { default: "x {{NOPE}} y" }), row("B_NOMBRE")]));
    assert.deepEqual(Object.keys(errors), ["A.default"]);
    assert.match(errors["A.default"]!, /\{\{NOPE\}\}/);
  });

  it("refuses a profile marker the profile has no value for", () => {
    const errors = errorsOf(check([row("A", { default: "{{A_CARGO}}" })]));
    assert.match(errors["A.default"]!, /A_CARGO/);
    assert.match(errors["A.default"]!, /owner profile/);
  });

  it("leaves a malformed group alone: it is text", () => {
    assert.equal(check([row("A", { default: "{{ b }} {{}} {{a}} {x} {{ open" })]).ok, true);
  });

  it("refuses defaults that refer to each other in a circle, on each of them, naming the others by label", () => {
    const errors = errorsOf(check([row("A", { label: "First", default: "{{B}}" }), row("B", { label: "Second", default: "{{A}}" }), row("C", { default: "{{A}}" })]));
    assert.deepEqual(Object.keys(errors).sort(), ["A.default", "B.default"]);
    assert.match(errors["A.default"]!, /Second/);
    assert.match(errors["B.default"]!, /First/);
  });

  it("refuses a default that refers to itself", () => {
    assert.match(errorsOf(check([row("A", { default: "a {{A}}" })]))["A.default"]!, /itself/);
  });

  it("uses the readable marker name for a field with no label when it names a cycle", () => {
    const errors = errorsOf(check([row("B_CORTO", { default: "{{B_NOMBRE}}" }), row("B_NOMBRE", { default: "{{B_CORTO}}" })]));
    assert.match(errors["B_CORTO.default"]!, /B nombre/);
  });

  it("checks the markers of a default that was not submitted against the stored default", () => {
    const stored = { A: { default: "{{B}}" }, B: { default: "{{A}}" } };
    const errors = errorsOf(check([row("A", { default: "{{B}}" })], ["A", "B"], stored));
    assert.deepEqual(Object.keys(errors).sort(), ["A.default", "B.default"]);
  });

  it("reports a reference error next to the other errors of the section", () => {
    const errors = errorsOf(check([row("A", { label: "x".repeat(81), default: "{{NOPE}}" }), row("B", { default: "{{NOPE}}" })]));
    assert.deepEqual(Object.keys(errors).sort(), ["A.default", "A.label", "B.default"]);
  });

  it("a default with references is kept as written in the settings", () => {
    const result = check([row("INTRO", { default: "{{A_CORTO}} y {{B_CORTO}}" }), row("B_CORTO")]);
    assert.ok(result.ok);
    assert.equal(result.ok && result.rows[0]!.default, "{{A_CORTO}} y {{B_CORTO}}");
  });
});

describe("validateVariables: which markers can have settings", () => {
  it("drops the settings of a marker that is not asked per document any more, and says which", () => {
    const result = check([row("A", { label: "A" }), row("GONE", { label: "Gone" })], ["A"], {});
    assert.equal(result.ok && result.dropped.join(), "GONE");
    assert.deepEqual(result.ok && result.settings, { A: { label: "A" } });
  });

  it("does not validate the inputs of a marker that is dropped", () => {
    const result = check([row("A"), row("GONE", { label: "x".repeat(500), kind: "bad" })], ["A"]);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.dropped.join(), "GONE");
  });

  it("does not report a dropped marker whose inputs were blank and that had nothing stored", () => {
    const result = check([row("A"), row("GONE")], ["A"]);
    assert.deepEqual(result.ok && result.dropped, []);
  });

  it("drops a stored entry the form did not submit when the marker is not asked any more", () => {
    const result = check([row("A", { label: "A" })], ["A"], { OLD: { label: "Old" }, A: { label: "stale" } });
    assert.equal(result.ok && result.dropped.join(), "OLD");
    assert.deepEqual(result.ok && result.settings, { A: { label: "A" } });
  });

  it("keeps the stored settings of an asked marker the form did not submit, such as one added to the body since", () => {
    const result = check([row("A", { label: "A" })], ["A", "NEW"], { NEW: { label: "Kept" } });
    assert.deepEqual(result.ok && result.settings, { A: { label: "A" }, NEW: { label: "Kept" } });
    assert.deepEqual(result.ok && result.dropped, []);
  });

  it("accepts no settings for a marker the template does not ask: profile markers and REF are never asked", () => {
    const result = check([row("A_NOMBRE", { label: "profile" }), row("REF", { label: "ref" }), row("B", { label: "b" })], ["B"]);
    assert.deepEqual(result.ok && result.settings, { B: { label: "b" } });
    assert.deepEqual(result.ok && result.dropped, ["A_NOMBRE", "REF"]);
  });

  it("lists each dropped marker once, in the order submitted and then stored", () => {
    const result = check([row("X", { label: "1" }), row("X", { label: "2" })], [], { Y: { label: "y" } });
    assert.deepEqual(result.ok && result.dropped, ["X", "Y"]);
  });

  it("returns an empty object when there is nothing to keep", () => {
    assert.deepEqual(settingsOf(check([row("A")])), {});
    assert.deepEqual(settingsOf(check([], [], {})), {});
  });
});
