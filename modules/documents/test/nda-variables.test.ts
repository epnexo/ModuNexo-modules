import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ndaVariableSettings } from "../src/nda-variables.ts";
import { validateVariables, variableRows } from "../src/variable-rules.ts";
import { SCRIPT, SCRIPT_FULL } from "./helpers/nda-fixture.ts";

const NDA_MARKERS = ["B_NOMBRE", "B_CORTO", "B_DATOS", "B_INFO", "B_FIRMANTE", "FINALIDAD", "INTRO", "PIE", "FECHA", "LEY_DATOS"];
const PROFILE = { A_NOMBRE: "Acme Test S.A.", A_CORTO: "Acme" };
const build = (extra: Partial<Parameters<typeof ndaVariableSettings>[0]> = {}) => ndaVariableSettings({ script: SCRIPT_FULL, ownerCountry: "zz", markers: NDA_MARKERS, profile: PROFILE, existing: {}, ...extra });

describe("the NDA's variable settings: labels and kinds", () => {
  it("has a Spanish label, a help line and a kind for each of the ten markers the NDA asks", () => {
    const { settings } = build();
    assert.deepEqual(Object.keys(settings), NDA_MARKERS, "in the order given");
    assert.deepEqual(
      Object.entries(settings).map(([marker, s]) => [marker, s.label, s.kind]),
      [
        ["B_NOMBRE", "Nombre de la contraparte", "line"],
        ["B_CORTO", "Nombre corto de la contraparte", "line"],
        ["B_DATOS", "Datos de la contraparte (identificación, domicilio, representante, correo)", "text"],
        ["B_INFO", "Información que comparte la contraparte", "text"],
        ["B_FIRMANTE", "Firmante de la contraparte", "line"],
        ["FINALIDAD", "Finalidad de la colaboración", "text"],
        ["INTRO", "Introducción del acuerdo", "text"],
        ["PIE", "Texto del pie de página", "line"],
        ["FECHA", "Fecha de efectos", "date"],
        ["LEY_DATOS", "Legislación de protección de datos", "text"],
      ],
    );
    for (const [marker, s] of Object.entries(settings)) assert.ok(s.help && s.help.length > 10, `${marker} has a help line`);
  });

  it("makes the effective date a date written in Spanish, with no stored default so it starts as today", () => {
    const { settings, today } = build();
    assert.deepEqual(settings.FECHA, { label: "Fecha de efectos", help: settings.FECHA!.help!, kind: "date", locale: "es" });
    assert.deepEqual(today, ["FECHA"]);
  });

  it("gives settings only to the markers it is asked about, whatever the template", () => {
    const { settings } = build({ markers: ["FECHA", "OTHER", "B_NOMBRE"] });
    assert.deepEqual(Object.keys(settings), ["FECHA", "B_NOMBRE"]);
    assert.deepEqual(build({ markers: [] }).settings, {});
  });

  it("passes the rules that check what the owner saves: every limit and kind is valid", () => {
    const { settings } = build();
    const result = validateVariables({ askable: NDA_MARKERS, submitted: variableRows(NDA_MARKERS, settings), existing: {}, profile: PROFILE });
    assert.equal(result.ok, true, JSON.stringify(!result.ok && result.errors));
    assert.deepEqual(result.ok && result.settings, settings);
  });
});

describe("the NDA's defaults, taken from the skill's script", () => {
  it("carries the purpose and the counterparty information the skill uses when the spec has none", () => {
    const { settings, withDefault } = build();
    assert.equal(settings.FINALIDAD!.default, "evaluate an invented collaboration");
    assert.equal(settings.B_INFO!.default, "invented information about their operation.");
    assert.deepEqual(withDefault, ["B_CORTO", "B_INFO", "FINALIDAD", "INTRO", "PIE", "LEY_DATOS"].sort((a, b) => NDA_MARKERS.indexOf(a) - NDA_MARKERS.indexOf(b)));
  });

  it("proposes the law of the owner's country the way the skill does when the counterparty's country is missing", () => {
    assert.equal(build({ ownerCountry: "zz" }).settings.LEY_DATOS!.default, "the invented law of Zedland, as well as the invented law of the other party");
    assert.equal(build({ ownerCountry: "YY" }).settings.LEY_DATOS!.default, "the invented law of Yedland, as well as the invented law of the other party");
  });

  it("falls back to the skill's generic wording when the owner's country is unknown or not in its table", () => {
    for (const ownerCountry of [undefined, "", "qq", "  "]) assert.equal(build({ ownerCountry }).settings.LEY_DATOS!.default, "the generic invented law", String(ownerCountry));
  });

  it("gives no default to what is the counterparty's own data, and says why", () => {
    const { settings, withoutDefault } = build();
    assert.deepEqual(withoutDefault.map((w) => w.marker), ["B_NOMBRE", "B_DATOS", "B_FIRMANTE"]);
    for (const { marker, reason } of withoutDefault) {
      assert.equal(settings[marker]!.default, undefined, marker);
      assert.ok(reason.length > 20, marker);
    }
    assert.match(withoutDefault.find((w) => w.marker === "B_FIRMANTE")!.reason, /representative/);
  });

  it("reports only the markers it was asked about", () => {
    const result = build({ markers: ["B_INFO", "B_FIRMANTE"] });
    assert.deepEqual(result.withDefault, ["B_INFO"]);
    assert.deepEqual(result.withoutDefault.map((w) => w.marker), ["B_FIRMANTE"]);
  });
});

describe("the NDA's defaults when the script is not what was expected", () => {
  it("keeps the labels and leaves the defaults empty, with a warning for each default it could not read", () => {
    const result = ndaVariableSettings({ script: SCRIPT, ownerCountry: "zz", markers: NDA_MARKERS, profile: PROFILE });
    assert.equal(result.settings.B_NOMBRE!.label, "Nombre de la contraparte");
    assert.equal(result.settings.FINALIDAD!.default, undefined);
    assert.equal(result.settings.B_INFO!.default, undefined);
    assert.equal(result.settings.LEY_DATOS!.default, undefined);
    assert.deepEqual(result.withDefault, ["B_CORTO", "INTRO", "PIE"], "the composed defaults do not depend on the script");
    assert.equal(result.warnings.length, 3);
    for (const marker of ["FINALIDAD", "B_INFO", "LEY_DATOS"]) assert.ok(result.warnings.some((w) => w.includes(marker)), marker);
  });

  it("does not guess a string it cannot read exactly: an escape or a concatenation leaves the default out", () => {
    const script = SCRIPT_FULL.replace('FINALIDAD_DEFAULT = ("evaluate an invented "', 'FINALIDAD_DEFAULT = ("evaluate an \\\\n invented "').replace('INFO_B_DEFAULT = ("invented information about "', 'INFO_B_DEFAULT = ("a" + "b" + f"{x}"').replace('    "yy": "the invented law of Yedland",\n', "");
    const result = ndaVariableSettings({ script, ownerCountry: "zz", markers: NDA_MARKERS });
    assert.equal(result.settings.FINALIDAD!.default, undefined);
    assert.equal(result.settings.B_INFO!.default, undefined);
    assert.equal(result.settings.LEY_DATOS!.default?.startsWith("the invented law of Zedland"), true, "the rest of the script still reads");
  });

  it("leaves the law out when the script does not say how the skill joins it, instead of making the wording up", () => {
    const script = SCRIPT_FULL.replace(/return f"\{la or lb\}[^\n]*\n/, "return la\n");
    const result = ndaVariableSettings({ script, ownerCountry: "zz", markers: NDA_MARKERS });
    assert.equal(result.settings.LEY_DATOS!.default, undefined);
    assert.ok(result.warnings.some((w) => w.includes("LEY_DATOS")));
  });

  it("stays within the limits of the rules even for a long default in the script", () => {
    const script = SCRIPT_FULL.replace('INFO_B_DEFAULT = ("invented information about "', `INFO_B_DEFAULT = ("${"x".repeat(2500)}"`).replace('"their operation.")', '"")');
    const result = ndaVariableSettings({ script, ownerCountry: "zz", markers: NDA_MARKERS });
    assert.equal(result.settings.B_INFO!.default, undefined);
    assert.ok(result.warnings.some((w) => w.includes("B_INFO")));
  });
});

describe("the NDA's defaults that use other fields", () => {
  it("composes the short name, the introduction and the footer from the markers of the NDA template", () => {
    const { settings } = build();
    assert.equal(settings.B_CORTO!.default, "{{B_NOMBRE}}");
    assert.equal(settings.INTRO!.default, "Antes de compartir información sensible, {{A_CORTO}} y {{B_CORTO}} dejan por escrito cómo la van a proteger. Las mismas reglas aplican a las dos partes.");
    assert.equal(settings.PIE!.default, "{{A_CORTO}} y {{B_CORTO}} · Acuerdo de confidencialidad {{REF}}");
  });

  it("names the owner by the company name when the profile has no short name, as the skill does", () => {
    const { settings } = build({ profile: { A_NOMBRE: "Acme Test S.A." } });
    assert.match(settings.INTRO!.default!, /\{\{A_NOMBRE\}\} y \{\{B_CORTO\}\}/);
    assert.doesNotMatch(settings.PIE!.default!, /A_CORTO/);
  });

  it("leaves the counterparty's signer without a default: it is built from a representative and a position the template does not ask", () => {
    const { settings, withoutDefault } = build();
    assert.equal(settings.B_FIRMANTE!.default, undefined);
    assert.match(withoutDefault.find((w) => w.marker === "B_FIRMANTE")!.reason, /representative and position/);
  });

  it("drops a composed default whose markers the template does not have, with a warning, and keeps the rest", () => {
    const markers = NDA_MARKERS.filter((marker) => marker !== "B_CORTO");
    const result = build({ markers });
    assert.equal(result.settings.INTRO!.default, undefined);
    assert.equal(result.settings.PIE!.default, undefined);
    assert.equal(result.settings.FINALIDAD!.default, "evaluate an invented collaboration");
    assert.ok(result.warnings.some((w) => w.includes("INTRO")));
    assert.ok(result.warnings.some((w) => w.includes("PIE")));
  });
});

describe("filling only what is still empty", () => {
  it("fills each piece on its own and never overwrites one that is set", () => {
    const existing = { B_NOMBRE: { label: "Mi etiqueta" }, B_CORTO: { default: "{{B_NOMBRE}} (corto)", kind: "text" as const }, FECHA: { kind: "date" as const, locale: "en" as const } };
    const result = build({ existing });
    assert.equal(result.settings.B_NOMBRE!.label, "Mi etiqueta");
    assert.equal(result.settings.B_NOMBRE!.kind, "line");
    assert.ok(result.settings.B_NOMBRE!.help);
    assert.deepEqual(result.settings.B_CORTO, { label: "Nombre corto de la contraparte", help: result.settings.B_CORTO!.help!, kind: "text", default: "{{B_NOMBRE}} (corto)" });
    assert.deepEqual(result.settings.FECHA, { label: "Fecha de efectos", help: result.settings.FECHA!.help!, kind: "date", locale: "en" }, "an existing language stays");
  });

  it("reports what it filled, by marker and piece, and nothing for a complete marker", () => {
    const complete = build().settings;
    const existing = { ...complete, INTRO: { label: complete.INTRO!.label!, help: complete.INTRO!.help!, kind: complete.INTRO!.kind! } };
    const result = build({ existing });
    assert.deepEqual(result.filled, [{ marker: "INTRO", pieces: ["default"] }]);
    assert.deepEqual(result.withDefault, ["INTRO"]);
  });

  it("changes nothing and fills nothing when every piece is set: a second run is empty", () => {
    const first = build();
    const again = build({ existing: first.settings });
    assert.deepEqual(again.filled, []);
    assert.deepEqual(again.settings, first.settings);
  });

  it("keeps the settings of markers it does not know", () => {
    const result = build({ existing: { EXTRA: { label: "Mine" } } });
    assert.deepEqual(result.settings.EXTRA, { label: "Mine" });
  });

  it("does not fill a default that would make defaults refer to each other, and says so", () => {
    const result = build({ existing: { B_NOMBRE: { default: "{{B_CORTO}}" } } });
    assert.equal(result.settings.B_CORTO!.default, undefined);
    assert.equal(result.settings.B_NOMBRE!.default, "{{B_CORTO}}");
    assert.ok(result.warnings.some((w) => w.includes("B_CORTO")));
  });

  it("fills around an owner's default that is not valid, leaving it as it is", () => {
    const result = build({ existing: { INTRO: { default: "{{NOPE}}" } } });
    assert.deepEqual(result.filled.find((entry) => entry.marker === "INTRO")?.pieces, ["label", "help", "kind"]);
    assert.equal(result.settings.INTRO!.default, "{{NOPE}}", "the owner's text is not touched");
    assert.equal(result.settings.PIE!.default, "{{A_CORTO}} y {{B_CORTO}} · Acuerdo de confidencialidad {{REF}}");
  });
});
