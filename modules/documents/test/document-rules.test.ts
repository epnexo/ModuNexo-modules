import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COUNTERPARTY_FIELD, MULTI_LINE_MAX, SINGLE_LINE_MAX, documentFields, isMultiline, markerLabel, parseDocumentId, resolveVariable, validateDocumentValues } from "../src/document-rules.ts";

describe("field kinds and labels", () => {
  it("uses a textarea when a word of the marker name says the value is a paragraph, and a single line otherwise", () => {
    for (const marker of ["INTRO", "FINALIDAD", "B_INFO", "B_DATOS", "LEY_DATOS", "PURPOSE", "SCOPE_TEXT", "NOTAS"]) assert.equal(isMultiline(marker), true, marker);
    for (const marker of ["B_NOMBRE", "B_CORTO", "B_FIRMANTE", "PIE", "FECHA", "INFORMAL", "DATOSX", "CLIENT"]) assert.equal(isMultiline(marker), false, marker);
  });

  it("makes the marker name readable", () => {
    assert.equal(markerLabel("B_NOMBRE"), "B nombre");
    assert.equal(markerLabel("FINALIDAD"), "Finalidad");
    assert.equal(markerLabel("_X__Y"), "X y");
  });

  it("lists one field per variable with the raw marker as help, and the counterparty name first", () => {
    const fields = documentFields(["FECHA", "B_NOMBRE", "B_DATOS"], "B_NOMBRE");
    assert.deepEqual(fields.map((f) => [f.name, f.label, f.help, f.multiline]), [
      ["B_NOMBRE", "Counterparty name", "Marker {{B_NOMBRE}}", false],
      ["FECHA", "Fecha", "Marker {{FECHA}}", false],
      ["B_DATOS", "B datos", "Marker {{B_DATOS}}", true],
    ]);
  });

  it("asks for the counterparty name as a field of its own when the template names no marker", () => {
    const fields = documentFields(["FECHA"], null);
    assert.deepEqual(fields.map((f) => [f.name, f.label]), [[COUNTERPARTY_FIELD, "Counterparty name"], ["FECHA", "Fecha"]]);
    assert.equal(fields[0]!.help, null);
  });

  it("asks for the name on its own when the chosen marker is not a variable any more", () => {
    assert.equal(documentFields(["FECHA"], "B_NOMBRE")[0]!.name, COUNTERPARTY_FIELD);
  });
});

describe("validateDocumentValues", () => {
  const fields = documentFields(["B_NOMBRE", "FECHA", "B_DATOS"], "B_NOMBRE");

  it("trims, joins the values by marker and takes the counterparty name from its marker", () => {
    const result = validateDocumentValues(fields, "B_NOMBRE", { B_NOMBRE: "  Beta Ltd ", FECHA: "9 de octubre", B_DATOS: "Line 1\r\nLine 2 " });
    assert.deepEqual(result, { ok: true, counterpartyName: "Beta Ltd", values: { B_NOMBRE: "Beta Ltd", FECHA: "9 de octubre", B_DATOS: "Line 1\nLine 2" } });
  });

  it("takes the counterparty name from its own field when there is no marker", () => {
    const own = documentFields(["FECHA"], null);
    const result = validateDocumentValues(own, null, { [COUNTERPARTY_FIELD]: "Beta", FECHA: "hoy" });
    assert.deepEqual(result, { ok: true, counterpartyName: "Beta", values: { FECHA: "hoy" } });
  });

  it("requires every field and keeps what was entered", () => {
    const result = validateDocumentValues(fields, "B_NOMBRE", { B_NOMBRE: "Beta", FECHA: "   ", B_DATOS: undefined });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(Object.keys(result.errors).sort(), ["B_DATOS", "FECHA"]);
    assert.equal(result.values.B_NOMBRE, "Beta");
    assert.match(result.errors.FECHA!, /Enter/);
  });

  it("limits a line to 200 characters and a textarea to 2000", () => {
    const ok = validateDocumentValues(fields, "B_NOMBRE", { B_NOMBRE: "x".repeat(SINGLE_LINE_MAX), FECHA: "a", B_DATOS: "y".repeat(MULTI_LINE_MAX) });
    assert.equal(ok.ok, true);
    const bad = validateDocumentValues(fields, "B_NOMBRE", { B_NOMBRE: "x".repeat(SINGLE_LINE_MAX + 1), FECHA: "a", B_DATOS: "y".repeat(MULTI_LINE_MAX + 1) });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.deepEqual(Object.keys(bad.errors).sort(), ["B_DATOS", "B_NOMBRE"]);
  });

  it("allows line breaks only in a textarea, and no control characters anywhere", () => {
    const bad = validateDocumentValues(fields, "B_NOMBRE", { B_NOMBRE: "a\nb", FECHA: "a\u0000b", B_DATOS: "a\u001bb" });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.deepEqual(Object.keys(bad.errors).sort(), ["B_DATOS", "B_NOMBRE", "FECHA"]);
    assert.equal(validateDocumentValues(fields, "B_NOMBRE", { B_NOMBRE: "a", FECHA: "a", B_DATOS: "a\n\tb" }).ok, true);
  });

  it("keeps markup and braces as text: escaping is the marker engine's job", () => {
    const result = validateDocumentValues(fields, "B_NOMBRE", { B_NOMBRE: "<b>{{X}}</b> & Co", FECHA: "a", B_DATOS: "b" });
    assert.equal(result.ok && result.values.B_NOMBRE, "<b>{{X}}</b> & Co");
  });

  it("ignores values for fields the template does not ask", () => {
    const result = validateDocumentValues(fields, "B_NOMBRE", { B_NOMBRE: "a", FECHA: "a", B_DATOS: "a", EXTRA: "x", REF: "FORGED" });
    assert.deepEqual(result.ok && Object.keys(result.values).sort(), ["B_DATOS", "B_NOMBRE", "FECHA"]);
  });

  it("does not read inherited properties of the input as values", () => {
    const result = validateDocumentValues(documentFields(["constructor"], null), null, { [COUNTERPARTY_FIELD]: "a" });
    assert.equal(result.ok, false);
  });
});

describe("validateDocumentValues when its arguments disagree", () => {
  it("never answers ok without a counterparty name: a marker that is not among the fields is an error", () => {
    const own = documentFields(["FECHA"], null);
    const result = validateDocumentValues(own, "B_NOMBRE", { FECHA: "hoy", B_NOMBRE: "Beta", [COUNTERPARTY_FIELD]: "Gamma" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.B_NOMBRE);
  });

  it("never answers ok without a counterparty name: no marker but no field of its own either", () => {
    const marked = documentFields(["B_NOMBRE", "FECHA"], "B_NOMBRE");
    const result = validateDocumentValues(marked, null, { B_NOMBRE: "Beta", FECHA: "hoy" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors[COUNTERPARTY_FIELD]);
    assert.equal(validateDocumentValues([], null, {}).ok, false);
  });

  it("always names the counterparty when it says ok", () => {
    for (const [fields, marker] of [[documentFields(["B_NOMBRE"], "B_NOMBRE"), "B_NOMBRE"], [documentFields([], null), null]] as const) {
      const result = validateDocumentValues(fields, marker, { B_NOMBRE: "Beta", [COUNTERPARTY_FIELD]: "Beta" });
      assert.equal(result.ok && typeof result.counterpartyName, "string");
    }
  });
});

describe("parseDocumentId", () => {
  it("accepts plain positive whole numbers and nothing else", () => {
    assert.equal(parseDocumentId("1"), 1);
    assert.equal(parseDocumentId("4200"), 4200);
    for (const bad of ["", "0", "-1", "007", "1x", "1.5", " 1", "1 ", "../1", "99999999999999999999", null, undefined]) assert.equal(parseDocumentId(bad as string), null, String(bad));
  });
});

describe("resolveVariable", () => {
  const now = new Date(2026, 9, 12, 10, 0);

  it("without settings gives the readable marker name, no help, the word rule for the kind and an empty start", () => {
    assert.deepEqual(resolveVariable("B_NOMBRE", undefined, now), { label: "B nombre", help: null, kind: "line", locale: "es", initial: "" });
    assert.deepEqual(resolveVariable("FINALIDAD", {}, now), { label: "Finalidad", help: null, kind: "text", locale: "es", initial: "" });
    assert.equal(resolveVariable("FECHA", undefined, now).initial, "", "a marker named FECHA is not a date unless the settings say so");
  });

  it("takes label, help and default from the settings", () => {
    const resolved = resolveVariable("B_NOMBRE", { label: "Nombre de la contraparte", help: "Razón social", default: "Beta" }, now);
    assert.deepEqual(resolved, { label: "Nombre de la contraparte", help: "Razón social", kind: "line", locale: "es", initial: "Beta" });
  });

  it("lets the kind of the settings win over the word rule, both ways", () => {
    assert.equal(resolveVariable("FINALIDAD", { kind: "line" }, now).kind, "line");
    assert.equal(resolveVariable("B_NOMBRE", { kind: "text" }, now).kind, "text");
    assert.equal(resolveVariable("B_NOMBRE", { kind: "date" }, now).kind, "date");
  });

  it("starts a date with today written out in its locale, in Spanish when none is set", () => {
    assert.equal(resolveVariable("FECHA", { kind: "date" }, now).initial, "12 de octubre de 2026");
    assert.equal(resolveVariable("FECHA", { kind: "date", locale: "es" }, now).initial, "12 de octubre de 2026");
    assert.equal(resolveVariable("FECHA", { kind: "date", locale: "en" }, now).initial, "October 12, 2026");
  });

  it("prefers a default over today's date", () => {
    assert.equal(resolveVariable("FECHA", { kind: "date", default: "1 de enero de 2027" }, now).initial, "1 de enero de 2027");
  });

  it("uses the fallback label it is given when the settings have none", () => {
    assert.equal(resolveVariable("B_NOMBRE", undefined, now, "Counterparty name").label, "Counterparty name");
    assert.equal(resolveVariable("B_NOMBRE", { label: "Mine" }, now, "Counterparty name").label, "Mine");
  });
});

describe("documentFields with settings", () => {
  const now = new Date(2026, 9, 12, 10, 0);

  it("labels, hints, kinds and starts each field from its settings and keeps the raw marker note", () => {
    const fields = documentFields(["B_NOMBRE", "FECHA", "B_DATOS", "PIE"], "B_NOMBRE", {
      B_NOMBRE: { label: "Nombre de la contraparte", help: "Razón social" },
      FECHA: { label: "Fecha de efectos", kind: "date" },
      B_DATOS: { label: "Datos", default: "Línea 1" },
    }, now);
    assert.deepEqual(
      fields.map((f) => [f.name, f.label, f.hint, f.help, f.kind, f.multiline, f.initial]),
      [
        ["B_NOMBRE", "Nombre de la contraparte", "Razón social", "Marker {{B_NOMBRE}}", "line", false, ""],
        ["FECHA", "Fecha de efectos", null, "Marker {{FECHA}}", "date", false, "12 de octubre de 2026"],
        ["B_DATOS", "Datos", null, "Marker {{B_DATOS}}", "text", true, "Línea 1"],
        ["PIE", "Pie", null, "Marker {{PIE}}", "line", false, ""],
      ],
    );
  });

  it("makes a field a textarea or a line from the effective kind, so the limits follow it", () => {
    const fields = documentFields(["B_NOMBRE", "B_DATOS"], "B_NOMBRE", { B_NOMBRE: { kind: "text" }, B_DATOS: { kind: "line" } });
    assert.deepEqual(fields.map((f) => f.multiline), [true, false]);
    const long = validateDocumentValues(fields, "B_NOMBRE", { B_NOMBRE: "x".repeat(SINGLE_LINE_MAX + 1), B_DATOS: "x" });
    assert.equal(long.ok, true, "a long-text field takes up to the paragraph limit");
    const multi = validateDocumentValues(fields, "B_NOMBRE", { B_NOMBRE: "x", B_DATOS: "a\nb" });
    assert.equal(multi.ok, false, "a line field refuses a line break");
  });

  it("gives the counterparty name its label from the settings, else the platform's own", () => {
    assert.equal(documentFields(["B_NOMBRE"], "B_NOMBRE", { B_NOMBRE: { label: "Nombre de la contraparte" } })[0]!.label, "Nombre de la contraparte");
    assert.equal(documentFields(["B_NOMBRE"], "B_NOMBRE", {})[0]!.label, "Counterparty name");
  });

  it("ignores settings of markers that are not variables of the form and of inherited property names", () => {
    const fields = documentFields(["FECHA"], null, { A_NOMBRE: { label: "profile marker" }, REF: { label: "ref" } });
    assert.deepEqual(fields.map((f) => f.label), ["Counterparty name", "Fecha"]);
  });
});

describe("a template with no settings behaves exactly as before settings existed", () => {
  /** The derivation as it was before this task: the readable name, the raw marker as help, the word rule for a paragraph. */
  function before(variables: string[], counterpartyMarker: string | null) {
    const marker = counterpartyMarker !== null && variables.includes(counterpartyMarker) ? counterpartyMarker : null;
    const field = (name: string, label: string, help: string | null) => ({ name, label, help, multiline: isMultiline(name) });
    return [
      marker === null ? { name: COUNTERPARTY_FIELD, label: "Counterparty name", help: null, multiline: false } : field(marker, "Counterparty name", `Marker {{${marker}}}`),
      ...variables.filter((name) => name !== marker).map((name) => field(name, markerLabel(name), `Marker {{${name}}}`)),
    ];
  }

  const nda = ["B_NOMBRE", "B_CORTO", "B_DATOS", "B_INFO", "B_FIRMANTE", "FINALIDAD", "INTRO", "PIE", "FECHA", "LEY_DATOS"];
  const cases: Array<[string[], string | null]> = [[nda, "B_NOMBRE"], [nda, null], [nda, "GONE"], [["FECHA"], null], [[], null], [["constructor_X", "A_B"], "A_B"]];

  it("derives the same fields, label, help, name and kind, and an empty start, for empty and for missing settings", () => {
    for (const [variables, counterparty] of cases) {
      for (const fields of [documentFields(variables, counterparty), documentFields(variables, counterparty, {}), documentFields(variables, counterparty, {}, new Date(2030, 0, 1))]) {
        assert.deepEqual(fields.map(({ name, label, help, multiline }) => ({ name, label, help, multiline })), before(variables, counterparty));
        assert.deepEqual(fields.map((f) => [f.hint, f.initial, f.kind]), fields.map((f) => [null, "", f.multiline ? "text" : "line"]));
      }
    }
  });

  it("validates exactly as before: every marker needs a value and the limits are the word rule's", () => {
    const fields = documentFields(nda, "B_NOMBRE", {});
    const result = validateDocumentValues(fields, "B_NOMBRE", {});
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(Object.keys(result.errors), nda);
  });
});
