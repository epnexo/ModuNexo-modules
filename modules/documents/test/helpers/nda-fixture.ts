/**
 * Small stand-ins for the skill's files, written for the tests with invented data. They have the same marker names and
 * the same few structural spots the importer touches (style markers, the datos rule, the optional clause marker), and
 * nothing of the real template's text.
 */

export const TEMPLATE = `<!DOCTYPE html>
<html lang="es">
<head>
<title>Acuerdo {{REF}}</title>
<style>
  @page { size: {{PAGINA}}; margin: 20mm;
    @bottom-left { content: "{{PIE}}"; font-family: {{FUENTE}}; } }
  body { font-family: {{FUENTE}}; }
  .franja { background: {{COLOR}}; }
  .parte .datos { font-size: 8pt; color: gray; }
</style>
</head>
<body>
<div class="marca">{{LOGO}}<span>{{A_CORTO}}</span></div>
<div class="ref">Ref <b>{{REF}}</b> {{FECHA}}</div>
<p class="intro">{{INTRO}}</p>
<div class="parte"><div class="nombre">{{A_NOMBRE}}</div><div class="datos">{{A_DATOS}}</div></div>
<div class="parte"><div class="nombre">{{B_NOMBRE}}</div><div class="datos">{{B_DATOS}}</div></div>
<p>{{FINALIDAD}} {{A_INFO}} {{B_INFO}} {{LEY_DATOS}} {{LEY_APLICABLE}} {{TRIBUNALES}} {{DIAS_NEGOCIACION}} {{MESES}} {{ANOS}} {{DIAS_DEVOLUCION}} {{B_CORTO}}</p>
{{CLAUSULA_CONOCIMIENTO}}
<h2>{{N_DEVOLUCION}}. one</h2>
<h2>{{N_DURACION}}. two</h2>
<h2>{{N_INCUMPLIMIENTO}}. three</h2>
<h2>{{N_LEY}}. four</h2>
<h2>{{N_FINALES}}. five</h2>
<div class="firma"><div class="datos">{{A_FIRMANTE}}</div><div class="datos">{{B_FIRMANTE}}</div></div>
</body>
</html>
`;

export const CLAUSE = `
  <div class="clausula">
    <h2><span class="num">8.</span>Invented clause</h2>
    <p>Invented text for the optional clause.</p>
  </div>
`;

/** The part of the skill's script the importer reads: one triple-quoted constant among other Python. */
export const SCRIPT = `import os
LEYES = {"zz": "invented law"}
CLAUSULA_CONOCIMIENTO = """${CLAUSE}"""
EJEMPLO = "Mi Empresa"
`;

/**
 * The skill's script with the parts the variable settings read, in the shape of the real file (a dict, constants made of
 * adjacent string literals, and the one function that joins the laws) but with invented text.
 */
export const SCRIPT_FULL = `${SCRIPT}
LEYES_DATOS = {
    "zz": "the invented law of Zedland",
    "yy": "the invented law of Yedland",
}
LEY_DATOS_GENERICA = "the generic invented law"
FINALIDAD_DEFAULT = ("evaluate an invented "
                     "collaboration")
INFO_B_DEFAULT = ("invented information about "
                  "their operation.")
def ley_datos(pa, pb):
    la, lb = LEYES_DATOS.get((pa or "").lower()), LEYES_DATOS.get((pb or "").lower())
    if la or lb:
        return f"{la or lb}, as well as the invented law of the other party"
    return LEY_DATOS_GENERICA
`;

export function config(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    mi_empresa: {
      nombre: "Acme Test S.A.",
      corto: "Acme",
      linea_id: "ID 123",
      domicilio: "1 Test Street",
      representante: "Pat Example",
      cargo: "Director",
      email: "legal@acme.test",
      ciudad: "Testville",
      pais: "ZZ",
    },
    lo_que_comparto: "invented shared material",
    marca: { color: "#112233", logo: "", fuente: "" },
    documento: { prefijo: "NDA", pagina: "a4", carpeta: "~/Docs" },
    terminos: {
      ley_aplicable: "the invented law",
      tribunales: "the invented courts",
      dias_negociacion: 15,
      meses_cobertura: 6,
      anos_confidencialidad: 2,
      dias_devolucion: 5,
      clausula_conocimiento_general: true,
    },
    docuseal: { subida: "manual", orden: "random" },
    ...overrides,
  };
}
