import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listMarkers, malformedMarkers, substitute } from "../src/markers.ts";
import { portNda } from "../src/nda-port.ts";
import { templateFormValues, validateTemplate } from "../src/template-rules.ts";
import { CLAUSE, SCRIPT, TEMPLATE, config } from "./helpers/nda-fixture.ts";

const port = (overrides: Record<string, unknown> = {}, extra: { templateHtml?: string; script?: string } = {}) =>
  portNda({ templateHtml: extra.templateHtml ?? TEMPLATE, script: extra.script ?? SCRIPT, config: config(overrides) });

const treatment = (result: ReturnType<typeof port>, part: string) => result.parts.find((p) => p.part === part)?.treatment;
const how = (result: ReturnType<typeof port>, part: string) => result.parts.find((p) => p.part === part)?.how;

describe("portNda: the optional clause and the numbering", () => {
  it("writes the clause in place and numbers the closing clauses from 9", () => {
    const { body } = port();
    assert.ok(body.includes(CLAUSE));
    assert.deepEqual([...body.matchAll(/<h2>(\d+)\. (\w+)<\/h2>/g)].map((m) => `${m[1]} ${m[2]}`), ["9 one", "10 two", "11 three", "12 four", "13 five"]);
    assert.doesNotMatch(body, /CLAUSULA_CONOCIMIENTO|N_[A-Z]+\}\}/);
  });

  it("leaves the clause out and numbers from 8 when the owner turned it off", () => {
    const { body } = port({ terminos: { ...config().terminos, clausula_conocimiento_general: false } });
    assert.ok(!body.includes("Invented clause"));
    assert.deepEqual([...body.matchAll(/<h2>(\d+)\. /g)].map((m) => m[1]), ["8", "9", "10", "11", "12"]);
  });

  it("keeps the clause on when the config does not say", () => {
    const { clausula_conocimiento_general: _unset, ...terminos } = config().terminos;
    const { body } = port({ terminos });
    assert.ok(body.includes("Invented clause"));
  });

  it("refuses to build a different document when the clause text cannot be read from the script", () => {
    assert.throws(() => port({}, { script: "EJEMPLO = 'x'" }), /clause/i);
    assert.throws(() => port({}, { script: 'CLAUSULA_CONOCIMIENTO = """has \\n escape"""' }), /clause/i);
  });

  it("does not need the clause text when it is turned off", () => {
    assert.doesNotThrow(() => port({ terminos: { ...config().terminos, clausula_conocimiento_general: false } }, { script: "nothing here" }));
  });

  it("records the treatment of both parts", () => {
    const result = port();
    assert.equal(how(result, "Optional clause"), "import");
    assert.equal(how(result, "Clause numbering"), "import");
  });
});

describe("portNda: owner data baked into fixed text", () => {
  it("builds the owner card and the signer line the way the skill does", () => {
    const { body } = port();
    assert.ok(body.includes('<div class="datos">ID 123<br>1 Test Street<br>Representada por Pat Example, Director<br>legal@acme.test</div>'));
    assert.ok(body.includes('<div class="datos">Pat Example · Director</div>'));
  });

  it("never lets owner text become a live marker, in the card or in the signer line", () => {
    const hostile = "{{B_NOMBRE}} and {{ANYTHING}}";
    const result = port({ mi_empresa: { ...config().mi_empresa, domicilio: hostile, representante: hostile, cargo: "{{A_NOMBRE}}" } });
    const markers = listMarkers(result.body);
    assert.ok(!markers.includes("ANYTHING"), "an owner-supplied group is not a marker");
    assert.equal(result.body.match(/\{\{A_NOMBRE\}\}/g)?.length, 1, "only the template's own A_NOMBRE marker remains");
    assert.equal(result.body.match(/\{\{B_NOMBRE\}\}/g)?.length, 1, "only the template's own B_NOMBRE marker remains");
    assert.deepEqual(malformedMarkers(result.body), []);
    assert.ok(result.body.includes("&#123;&#123;ANYTHING}}"), "the text is kept and renders as written");
  });

  it("skips empty lines and says the owner acts on their own behalf without a representative", () => {
    const { body } = port({ mi_empresa: { ...config().mi_empresa, linea_id: "", domicilio: "", representante: "", cargo: "" } });
    assert.ok(body.includes('<div class="datos">Actúa en nombre propio<br>legal@acme.test</div>'));
    assert.ok(body.includes('<div class="datos">En nombre propio</div>'));
  });

  it("escapes the owner's text", () => {
    const { body } = port({ mi_empresa: { ...config().mi_empresa, domicilio: "1 <b>Main</b> & Co" } });
    assert.ok(body.includes("1 &lt;b&gt;Main&lt;/b&gt; &amp; Co"));
    assert.ok(!body.includes("<b>Main</b>"));
  });

  it("records the treatment", () => {
    const result = port();
    assert.equal(how(result, "Owner card and signer line"), "import");
  });
});

describe("portNda: fonts and logo", () => {
  it("writes the font stack of the skill with its generic fallbacks", () => {
    const { body } = port();
    assert.ok(body.includes('font-family: "NDA Sans", "Inter", "Helvetica Neue", "Arial", "Liberation Sans", "DejaVu Sans", sans-serif;'));
  });

  it("puts the configured font name first", () => {
    const { body } = port({ marca: { color: "#112233", logo: "", fuente: "Brand Sans" } });
    assert.ok(body.includes('font-family: "Brand Sans", "NDA Sans"'));
  });

  it("ignores a font name that could break out of the style and says so", () => {
    for (const fuente of ['Evil"; } body { x', "a\\b", "x</style><script>", "x{y}"]) {
      const result = port({ marca: { color: "#112233", logo: "", fuente } });
      assert.ok(result.body.includes('font-family: "NDA Sans"'), fuente);
      assert.ok(!result.body.includes("Evil") && !result.body.includes("</style><script>"), fuente);
      assert.ok(result.warnings.some((w) => /font/i.test(w)), fuente);
    }
  });

  it("drops the logo marker, quietly when there is no logo and with a warning when there is one", () => {
    const none = port();
    assert.ok(!none.body.includes("{{LOGO}}"));
    assert.deepEqual(none.warnings.filter((w) => /logo/i.test(w)), []);
    const some = port({ marca: { color: "#112233", logo: "assets/logo.png", fuente: "" } });
    assert.ok(!some.body.includes("{{LOGO}}"));
    assert.ok(some.warnings.some((w) => /logo/i.test(w)));
    assert.ok(!JSON.stringify(some).includes("assets/logo.png"), "the logo path is not echoed");
    assert.match(treatment(some, "Logo")!, /not carried/i);
  });
});

describe("portNda: what stays a marker", () => {
  const MARKERS_LEFT = [
    "PAGINA", "PIE", "COLOR", "A_CORTO", "REF", "FECHA", "INTRO", "A_NOMBRE", "B_NOMBRE", "B_DATOS", "FINALIDAD", "A_INFO", "B_INFO",
    "LEY_DATOS", "LEY_APLICABLE", "TRIBUNALES", "DIAS_NEGOCIACION", "MESES", "ANOS", "DIAS_DEVOLUCION", "B_CORTO", "B_FIRMANTE",
  ];

  it("leaves exactly the owner profile markers and the per-document markers", () => {
    assert.deepEqual(listMarkers(port().body).sort(), [...MARKERS_LEFT].sort());
  });

  it("lets the multi-line counterparty card break lines from newlines", () => {
    const { body } = port();
    assert.match(body, /\.parte \.datos \{ white-space: pre-line; font-size: 8pt;/);
    const filled = substitute(body, { B_DATOS: "line one\nline two" }).html;
    assert.ok(filled.includes("line one\nline two"));
  });

  it("warns when the card rule is not where it was expected", () => {
    const result = port({}, { templateHtml: TEMPLATE.replace(".parte .datos {", ".other {") });
    assert.ok(result.warnings.some((w) => /pre-line|counterparty card/i.test(w)));
  });

  it("renders without a missing marker once the profile and the per-document values are given", () => {
    const result = port();
    const values = { ...result.profile, REF: "NDA-2026-001", FECHA: "9 de octubre de 2026", PIE: "footer", INTRO: "intro", B_NOMBRE: "Beta <Ltd>", B_CORTO: "Beta", B_DATOS: "x", B_FIRMANTE: "y", FINALIDAD: "f", B_INFO: "i", LEY_DATOS: "l" };
    const rendered = substitute(result.body, values);
    assert.deepEqual(rendered.missing, []);
    assert.ok(rendered.html.includes("Beta &lt;Ltd&gt;"));
    assert.doesNotMatch(rendered.html, /\{\{/);
  });

  it("reports every computed part with its treatment", () => {
    const parts = port().parts.map((p) => p.part);
    for (const part of ["Optional clause", "Clause numbering", "Owner card and signer line", "Font stack", "Logo", "Page size", "Accent color", "Counterparty card", "Data-protection law", "Footer text", "Introduction", "Effective date"]) {
      assert.ok(parts.includes(part), part);
    }
    for (const part of port().parts) assert.ok(part.treatment.length > 0 && ["import", "profile", "document", "left out"].includes(part.how), part.part);
  });
});

describe("portNda: profile and template fields", () => {
  it("derives the profile from the config", () => {
    assert.deepEqual(port().profile, {
      A_NOMBRE: "Acme Test S.A.",
      A_CORTO: "Acme",
      A_LINEA_ID: "ID 123",
      A_DOMICILIO: "1 Test Street",
      A_CIUDAD: "Testville",
      A_PAIS: "zz",
      A_EMAIL: "legal@acme.test",
      A_REPRESENTANTE: "Pat Example",
      A_CARGO: "Director",
      A_INFO: "invented shared material",
      COLOR: "#112233",
      PAGINA: "A4",
      LEY_APLICABLE: "the invented law",
      TRIBUNALES: "the invented courts",
      DIAS_NEGOCIACION: "15",
      MESES: "6",
      ANOS: "2",
      DIAS_DEVOLUCION: "5",
    });
  });

  it("uses the skill's defaults for the terms and the color, and letter as page size", () => {
    const result = port({ marca: {}, documento: {}, terminos: {}, lo_que_comparto: "" });
    assert.equal(result.profile.COLOR, "#2563eb");
    assert.equal(result.profile.PAGINA, "letter");
    assert.deepEqual([result.profile.DIAS_NEGOCIACION, result.profile.MESES, result.profile.ANOS, result.profile.DIAS_DEVOLUCION], ["30", "12", "3", "10"]);
    assert.ok(!("LEY_APLICABLE" in result.profile));
    assert.ok(!("A_INFO" in result.profile));
  });

  it("leaves out values that are blank in the config", () => {
    const result = port({ mi_empresa: { ...config().mi_empresa, linea_id: "", cargo: "  " } });
    assert.ok(!("A_LINEA_ID" in result.profile) && !("A_CARGO" in result.profile));
  });

  it("drops an optional value the profile rules reject and says which", () => {
    const result = port({ marca: { color: "blue", logo: "", fuente: "" }, mi_empresa: { ...config().mi_empresa, pais: "zzz" } });
    assert.ok(!("A_PAIS" in result.profile));
    assert.equal(result.profile.COLOR, "#2563eb", "an invalid color falls back to the skill default");
    assert.ok(result.warnings.some((w) => w.includes("A_PAIS")));
    assert.ok(result.warnings.some((w) => w.includes("COLOR")));
  });

  it("fails when the company name or the email is missing, or still the example", () => {
    assert.throws(() => port({ mi_empresa: { ...config().mi_empresa, nombre: "" } }), /nombre|company name/i);
    assert.throws(() => port({ mi_empresa: { ...config().mi_empresa, email: "" } }), /email/i);
    assert.throws(() => port({ mi_empresa: { ...config().mi_empresa, nombre: "Mi Empresa S.R.L." } }), /example/i);
    assert.throws(() => portNda({ templateHtml: TEMPLATE, script: SCRIPT, config: "nope" }), /config/i);
    assert.throws(() => portNda({ templateHtml: TEMPLATE, script: SCRIPT, config: {} }), /mi_empresa/);
  });

  it("builds a template the platform accepts", () => {
    const result = port();
    assert.deepEqual(result.template.slug, "nda");
    assert.deepEqual([result.template.kind, result.template.refPrefix, result.template.name], ["nda", "NDA", "Mutual NDA"]);
    assert.equal(validateTemplate(templateFormValues(result.template)).ok, true);
    assert.equal(result.template.counterpartyMarker, "B_NOMBRE");
  });

  it("turns the skill's prefix into letters and digits only", () => {
    assert.equal(port({ documento: { prefijo: "nda-2 x" } }).template.refPrefix, "NDA2X");
    assert.equal(port({ documento: { prefijo: "Ñandú" } }).template.refPrefix, "NANDU");
    assert.equal(port({ documento: { prefijo: "!!!" } }).template.refPrefix, "NDA");
    assert.equal(port({ documento: { prefijo: "ABCDEFGHIJKLMNOP" } }).template.refPrefix, "ABCDEFGHIJ");
    assert.equal(port({ documento: {} }).template.refPrefix, "NDA");
  });

  it("does not put owner values into warnings or parts", () => {
    const result = port({ marca: { color: "#112233", logo: "secret/logo.png", fuente: 'bad"font' }, mi_empresa: { ...config().mi_empresa, pais: "zzz" } });
    const text = JSON.stringify([result.warnings, result.parts]);
    for (const value of ["Acme", "legal@acme.test", "Pat Example", "1 Test Street", "secret/logo.png", 'bad"font']) assert.ok(!text.includes(value), value);
  });
});
