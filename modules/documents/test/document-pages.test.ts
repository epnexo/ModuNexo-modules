import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocumentDetail } from "../src/document-store.ts";
import type { Template } from "../src/template-store.ts";
import type { VariableSettings } from "../src/variables.ts";
import { renderDocumentPage } from "../web/document-page.tsx";
import { DocumentForm } from "../web/forms.tsx";
import { renderNewDocumentPage, type NewDocumentData } from "../web/new-document-page.tsx";
import { documentFields } from "../src/document-rules.ts";

const html = (element: ReactElement) => renderToStaticMarkup(createElement("div", null, element));
const isNotFound = (error: unknown) => String((error as { digest?: string }).digest).includes("404");

const template = (extra: Partial<Template> = {}): Template => ({
  id: 7,
  slug: "nda",
  name: "Mutual NDA",
  kind: "nda",
  refPrefix: "NDA",
  bodyHtml: "<p>{{REF}} {{A_NOMBRE}} {{B_NOMBRE}} {{FECHA}} {{B_DATOS}}</p>",
  counterpartyMarker: "B_NOMBRE",
  createdAt: new Date("2026-10-01T08:00:00Z"),
  updatedAt: new Date("2026-10-02T09:30:00Z"),
  archivedAt: null,
  variables: {},
  ...extra,
});

const NOW = () => new Date(2026, 9, 12, 21, 30);
const SETTINGS: VariableSettings = {
  B_NOMBRE: { label: "Nombre de la contraparte", help: "Razón social, como en el acuerdo" },
  FECHA: { label: "Fecha de efectos", kind: "date", locale: "es" },
  B_DATOS: { label: "Datos de la contraparte", default: "Línea 1\nLínea 2" },
};

const data = (extra: Partial<NewDocumentData> = {}): NewDocumentData => ({ templates: [template()], chosen: null, profile: { A_NOMBRE: "Acme" }, ...extra });

describe("new document page: picking a template", () => {
  it("lists the templates as links that carry the choice in the URL, with Documents marked", async () => {
    const markup = html(await renderNewDocumentPage({ templateParam: undefined, load: async () => data({ templates: [template(), template({ id: 8, name: "Services", kind: "contract", refPrefix: "CON" })] }) }));
    assert.match(markup, /<h1>New document<\/h1>/);
    assert.match(markup, /<a [^>]*href="\/documents\/new\?template=7"[^>]*>Mutual NDA<\/a>/);
    assert.match(markup, /href="\/documents\/new\?template=8"/);
    assert.match(markup, /CON-YYYY-NNN/);
    assert.match(markup, /<a [^>]*aria-current="page"[^>]*>Documents<\/a>/);
    assert.doesNotMatch(markup, /<form/);
  });

  it("points to the new-template page when there is no template", async () => {
    const markup = html(await renderNewDocumentPage({ templateParam: undefined, load: async () => data({ templates: [] }) }));
    assert.match(markup, /href="\/documents\/templates\/new"/);
    assert.doesNotMatch(markup, /<table/);
  });

  it("escapes template names", async () => {
    const markup = html(await renderNewDocumentPage({ templateParam: undefined, load: async () => data({ templates: [template({ name: "<img src=x onerror=1>" })] }) }));
    assert.doesNotMatch(markup, /<img/);
  });

  it("shows a safe notice when the data cannot be loaded", async (t) => {
    t.mock.method(console, "error", () => {});
    const markup = html(await renderNewDocumentPage({ templateParam: undefined, load: async () => Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" })) }));
    assert.match(markup, /Templates are unavailable/);
    assert.match(markup, /unreachable/);
  });
});

describe("new document page: the variables form", () => {
  const form = async (chosen: Template | null = template(), profile: Record<string, string> = { A_NOMBRE: "Acme" }) => html(await renderNewDocumentPage({ templateParam: "7", load: async () => data({ chosen, profile }) }));

  it("asks only for the per-document markers, the counterparty name first, never REF or profile values", async () => {
    const markup = await form();
    const labels = [...markup.matchAll(/<label[^>]*>([^<]*)/g)].map((m) => m[1]!.trim());
    assert.deepEqual(labels, ["Counterparty name", "Fecha", "B datos"]);
    assert.doesNotMatch(markup, /name="REF"|name="A_NOMBRE"/);
    assert.match(markup, /<input type="hidden" name="templateId" value="7"\/>/);
    assert.match(markup, /Create document/);
  });

  it("shows the raw marker as help and uses a textarea only for paragraph markers", async () => {
    const markup = await form();
    assert.match(markup, /Marker \{\{FECHA\}\}/);
    assert.match(markup, /<input[^>]*name="FECHA"/);
    assert.match(markup, /<textarea[^>]*name="B_DATOS"/);
    assert.match(markup, /<input[^>]*name="B_NOMBRE"/);
  });

  it("asks for the counterparty name on its own field when the template has no marker for it", async () => {
    const markup = await form(template({ counterpartyMarker: null }));
    assert.match(markup, /<input[^>]*name="counterpartyName"/);
    assert.match(markup, /<input[^>]*name="B_NOMBRE"/);
    assert.match(markup, /<label[^>]*>B nombre/);
  });

  it("says a template is archived instead of showing the form", async () => {
    const markup = await form(template({ archivedAt: new Date("2026-10-03T00:00:00Z") }));
    assert.match(markup, /This template is archived/);
    assert.doesNotMatch(markup, /<form/);
  });

  it("answers 404 for an unknown template and for an id that is not a number, without loading for a bad id", async () => {
    await assert.rejects(renderNewDocumentPage({ templateParam: "7", load: async () => data({ chosen: null }) }), isNotFound);
    for (const templateParam of ["abc", "0", "-1", "7x", "1;drop", ""]) {
      let loaded = false;
      await assert.rejects(renderNewDocumentPage({ templateParam, load: async () => ((loaded = true), data()) }), isNotFound, templateParam);
      assert.equal(loaded, false);
    }
  });
});

describe("new document page: labels and defaults from the template's variables", () => {
  const form = async (variables: VariableSettings = SETTINGS, profile: Record<string, string> = { A_NOMBRE: "Acme" }) =>
    html(await renderNewDocumentPage({ templateParam: "7", now: NOW, load: async () => data({ chosen: template({ variables }), profile }) }));

  it("uses the label of the settings as the field label and the help line, with the raw marker in small text after it", async () => {
    const markup = await form();
    const labels = [...markup.matchAll(/<label[^>]*>([^<]*)/g)].map((m) => m[1]!.trim());
    assert.deepEqual(labels, ["Nombre de la contraparte", "Fecha de efectos", "Datos de la contraparte"]);
    assert.match(markup, /<p id="f-B_NOMBRE-help" class="field-help">Razón social, como en el acuerdo <small>Marker \{\{B_NOMBRE\}\}<\/small><\/p>/);
    assert.match(markup, /<p id="f-FECHA-help" class="field-help">Marker \{\{FECHA\}\}<\/p>/, "no help line from the settings: the marker note is as before");
  });

  it("pre-fills a date with today written out, as a one-line text field and not a date picker", async () => {
    const markup = await form();
    const tag = markup.match(/<input[^>]*name="FECHA"[^>]*>/)?.[0];
    assert.ok(tag);
    assert.match(tag, /value="12 de octubre de 2026"/);
    assert.match(tag, /type="text"/);
    assert.doesNotMatch(markup, /type="date"/);
  });

  it("pre-fills the defaults, a long one in a textarea, and leaves a field without a default empty", async () => {
    const markup = await form();
    assert.match(markup, /<textarea[^>]*name="B_DATOS"[^>]*>Línea 1\nLínea 2<\/textarea>/);
    assert.match(markup, /<input[^>]*name="B_NOMBRE"[^>]*value=""/);
  });

  it("shows a default as text, escaped", async () => {
    const markup = await form({ ...SETTINGS, B_NOMBRE: { default: `"><b>x</b>` }, B_DATOS: { default: "</textarea><i>y</i>" } });
    assert.doesNotMatch(markup, /<b>x<|<i>y<|"><b>/);
    assert.match(markup, /&lt;b&gt;x&lt;\/b&gt;/);
  });

  it("renders a template without settings exactly as before: raw labels, the marker note, empty fields", async () => {
    const markup = await form({});
    assert.deepEqual([...markup.matchAll(/<label[^>]*>([^<]*)/g)].map((m) => m[1]!.trim()), ["Counterparty name", "Fecha", "B datos"]);
    assert.doesNotMatch(markup, /<small>/);
    assert.deepEqual([...markup.matchAll(/<input[^>]*name="(?:B_NOMBRE|FECHA)"[^>]*value="([^"]*)"/g)].map((m) => m[1]), ["", ""]);
    assert.match(markup, /<textarea[^>]*name="B_DATOS"[^>]*><\/textarea>/);
  });
});

describe("new document page: values that use other fields", () => {
  const withRefs: VariableSettings = {
    B_NOMBRE: { label: "Nombre de la contraparte" },
    FECHA: { label: "Fecha de efectos", kind: "date", locale: "es" },
    B_DATOS: { label: "Datos <b>de la contraparte", default: "{{B_NOMBRE}} · {{A_NOMBRE}} · {{REF}} · {{B_NOMBRE}} {{LIBRE}}" },
  };
  const form = async (variables: VariableSettings = withRefs, profile: Record<string, string> = { A_NOMBRE: "Acme" }) =>
    html(await renderNewDocumentPage({ templateParam: "7", now: NOW, load: async () => data({ chosen: template({ variables }), profile }) }));

  it("starts the field with the expression as written, visible and editable", async () => {
    const markup = await form();
    assert.match(markup, /<textarea[^>]*name="B_DATOS"[^>]*>\{\{B_NOMBRE\}\} · \{\{A_NOMBRE\}\} · \{\{REF\}\} · \{\{B_NOMBRE\}\} \{\{LIBRE\}\}<\/textarea>/);
  });

  it("says under the field which fields it uses, by their labels, once each, and that they are filled in when the document is created", async () => {
    const markup = await form();
    const note = markup.match(/<p id="f-B_DATOS-uses" class="field-help">([^<]*)<\/p>/)?.[1];
    assert.equal(note, "Uses Nombre de la contraparte, Company name (profile), the document number. They are filled in when the document is created.");
  });

  it("has no such line under a field without references, and describes the line for assistive technology", async () => {
    const markup = await form();
    assert.doesNotMatch(markup, /f-B_NOMBRE-uses|f-FECHA-uses/);
    assert.match(markup, /<textarea[^>]*aria-describedby="[^"]*f-B_DATOS-uses/);
  });

  it("a profile marker the profile has no value for is not listed", async () => {
    const markup = await form({ ...withRefs, B_DATOS: { default: "{{A_CARGO}} {{B_NOMBRE}}" } });
    assert.match(markup, /Uses Nombre de la contraparte\. They are/);
  });

  it("escapes the labels", async () => {
    const markup = await form({ ...withRefs, B_NOMBRE: { label: "<i>x</i>" } });
    assert.doesNotMatch(markup, /<i>x/);
  });

  it("without references a template renders exactly as before", async () => {
    assert.doesNotMatch(await form({}), /-uses/);
  });
});

describe("DocumentForm", () => {
  const fields = documentFields(["B_NOMBRE", "B_DATOS"], "B_NOMBRE");
  const render = (state: { values?: Record<string, string>; errors?: Record<string, string>; message?: string }) =>
    renderToStaticMarkup(createElement(DocumentForm, { endpoint: "/documents/test", initial: { values: {}, errors: {}, ...state }, templateId: 7, fields }));

  it("keeps the entered values, escaped", () => {
    const markup = render({ values: { B_NOMBRE: `A "q" <b>`, B_DATOS: "</textarea><script>1</script>" } });
    assert.match(markup, /value="A &quot;q&quot; &lt;b&gt;"/);
    assert.doesNotMatch(markup, /<script>1<\/script>/);
  });

  it("shows each error next to its field, marks it invalid, and announces it", () => {
    const markup = render({ errors: { B_DATOS: "Enter b datos." } });
    assert.match(markup, /<p id="f-B_DATOS-error" class="field-error">Enter b datos\.<\/p>/);
    assert.match(markup, /<textarea[^>]*aria-invalid="true"/);
    assert.doesNotMatch(markup, /<input[^>]*name="B_NOMBRE"[^>]*aria-invalid/);
    assert.match(markup, /role="alert"[^>]*>\s*<strong>Check the highlighted fields\./);
  });

  it("shows a form-level message as an alert", () => {
    assert.match(render({ message: "The PDF engine is not configured." }), /role="alert"[\s\S]*The PDF engine is not configured\./);
  });

  it("starts from the initial values of the fields and lets what the owner entered win over them, an emptied field included", () => {
    const withDefaults = documentFields(["B_NOMBRE", "B_DATOS"], "B_NOMBRE", { B_NOMBRE: { default: "Default name" }, B_DATOS: { default: "Default data" } });
    const show = (values: Record<string, string>) => renderToStaticMarkup(createElement(DocumentForm, { endpoint: "/documents/test", initial: { values, errors: {} }, templateId: 7, fields: withDefaults }));
    const fresh = show({});
    assert.match(fresh, /name="B_NOMBRE"[^>]*value="Default name"/);
    assert.match(fresh, />Default data<\/textarea>/);
    const again = show({ B_NOMBRE: "Typed name", B_DATOS: "" });
    assert.match(again, /name="B_NOMBRE"[^>]*value="Typed name"/);
    assert.doesNotMatch(again, /Default name|Default data/);
  });

  it("keeps an expression as typed after a refusal and describes the fields it uses from what was typed", () => {
    const named = documentFields(["B_NOMBRE", "B_CORTO"], "B_NOMBRE", { B_NOMBRE: { label: "Nombre" }, B_CORTO: { label: "Corto", default: "{{B_NOMBRE}}" } });
    const show = (values: Record<string, string>) => renderToStaticMarkup(createElement(DocumentForm, { endpoint: "/documents/test", initial: { values, errors: { B_CORTO: "x" } }, templateId: 7, fields: named, profileKeys: ["A_CORTO"] }));
    const typed = show({ B_NOMBRE: "Beta", B_CORTO: "{{A_CORTO}} y {{B_NOMBRE}}" });
    assert.match(typed, /name="B_CORTO"[^>]*value="\{\{A_CORTO\}\} y \{\{B_NOMBRE\}\}"/);
    assert.match(typed, /Uses Short name \(profile\), Nombre\./);
    assert.doesNotMatch(show({ B_NOMBRE: "Beta", B_CORTO: "plain" }), /-uses/);
  });

  it("marks every field required", () => {
    assert.equal(render({}).match(/aria-required="true"/g)?.length, 2);
  });
});

const signing = { configured: true, loadOwner: async () => ({ name: "", email: "" }) };

const detail = (extra: Partial<DocumentDetail> = {}): DocumentDetail => ({
  id: 9,
  ref: "NDA-2026-001",
  title: "Mutual NDA — Beta <Ltd>",
  counterpartyName: "Beta <Ltd>",
  templateName: "Mutual NDA",
  status: "generated",
  createdAt: new Date("2026-10-09T12:34:00Z"),
  pages: 3,
  values: { B_NOMBRE: "Beta <Ltd>", B_DATOS: "line 1\nline 2", FECHA: "9 de octubre" },
  profile: { A_NOMBRE: "Acme" },
  hasPdf: true,
  pdfName: "NDA-2026-001-beta.pdf",
  completedAt: null,
  hasSubmission: false,
  templateVariables: {},
  sendStartedAt: null,
  signers: [],
  signature: { ready: true },
  ...extra,
});

describe("document page", () => {
  const page = async (d: DocumentDetail | null = detail(), created = false) => html(await renderDocumentPage({ ...signing, idParam: "9", created, load: async () => d }));

  it("shows reference, title, counterparty, template, status, time, pages and the values used", async () => {
    const markup = await page();
    assert.match(markup, /<h1>NDA-2026-001<\/h1>/);
    for (const text of ["Mutual NDA — Beta &lt;Ltd&gt;", "Beta &lt;Ltd&gt;", "Mutual NDA", "2026-10-09 12:34", "9 de octubre", "Acme", "B_DATOS"]) assert.ok(markup.includes(text), text);
    assert.match(markup, /<span class="badge">Generated<\/span>/);
    assert.match(markup, /<dt>Pages<\/dt><dd class="num">3<\/dd>/);
    assert.match(markup, /<a [^>]*aria-current="page"[^>]*>Documents<\/a>/);
  });

  it("links to the PDF download, and says so when there is no file", async () => {
    assert.match(await page(), /<a [^>]*href="\/documents\/9\/pdf"[^>]*>Download PDF<\/a>/);
    const none = await page(detail({ hasPdf: false, pdfName: null, signature: { ready: false, reason: "This document has no PDF." } }));
    assert.doesNotMatch(none, /Download PDF/);
    assert.match(none, /no PDF/);
  });

  it("offers a preview in a new tab next to the download, named after the document, and none without a file", async () => {
    const markup = await page();
    const tag = markup.match(/<a [^>]*href="\/documents\/9\/pdf\?inline=1"[^>]*>/)?.[0];
    assert.ok(tag, "the preview link is there");
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer"/);
    assert.match(tag, /aria-label="Preview NDA-2026-001 PDF \(opens in a new tab\)"/);
    assert.match(markup, />Preview<\/a>/);
    assert.ok(markup.indexOf("Download PDF") < markup.indexOf("inline=1"), "next to the download");
    assert.match(markup, /<a [^>]*href="\/documents\/9\/pdf"[^>]*>Download PDF<\/a>/, "the download is unchanged");
    const none = await page(detail({ hasPdf: false, pdfName: null, signature: { ready: false, reason: "This document has no PDF." } }));
    assert.doesNotMatch(none, /inline=1|Preview/);
  });

  it("shows the label of the template's settings next to each value used, with the marker in small text, and the readable name when there is none", async () => {
    const markup = await page(detail({ templateVariables: { B_NOMBRE: { label: "Nombre de la contraparte" }, FECHA: { label: "Fecha de efectos" } } }));
    assert.match(markup, /<dt>Nombre de la contraparte <small>B_NOMBRE<\/small><\/dt><dd[^>]*>Beta &lt;Ltd&gt;<\/dd>/);
    assert.match(markup, /<dt>Fecha de efectos <small>FECHA<\/small><\/dt><dd[^>]*>9 de octubre<\/dd>/);
    assert.match(markup, /<dt>B datos <small>B_DATOS<\/small><\/dt>/, "no setting: the readable marker name");
  });

  it("shows the readable name with the marker for a document of a template without settings, and keeps the profile values as they were", async () => {
    const markup = await page();
    assert.match(markup, /<dt>B nombre <small>B_NOMBRE<\/small><\/dt>/);
    assert.match(markup, /<dt>A_NOMBRE<\/dt><dd[^>]*>Acme<\/dd>/);
  });

  it("never renders a label as markup", async () => {
    const markup = await page(detail({ templateVariables: { B_NOMBRE: { label: "<img src=x onerror=1>" } } }));
    assert.doesNotMatch(markup, /<img/);
    assert.match(markup, /&lt;img src=x/);
  });

  it("leaves the page count out when it is not known", async () => {
    assert.doesNotMatch(await page(detail({ pages: null })), /Pages/);
  });

  it("never renders stored values as markup", async () => {
    const markup = await page(detail({ values: { X: "<script>alert(1)</script><img src=x onerror=1>" }, title: "<b>t</b>" }));
    assert.doesNotMatch(markup, /<script>alert|<img|<b>t/);
    assert.match(markup, /&lt;script&gt;alert\(1\)/);
  });

  it("confirms a creation after the redirect", async () => {
    assert.match(await page(detail(), true), /Document created\./);
    assert.doesNotMatch(await page(), /Document created\./);
  });

  it("answers 404 for an unknown document and for an id that is not a number, without loading for a bad id", async () => {
    await assert.rejects(renderDocumentPage({ ...signing, idParam: "9", created: false, load: async () => null }), isNotFound);
    for (const idParam of ["abc", "0", "-3", "9x", "1; drop", "007"]) {
      let loaded = false;
      await assert.rejects(renderDocumentPage({ ...signing, idParam, created: false, load: async () => ((loaded = true), detail()) }), isNotFound, idParam);
      assert.equal(loaded, false);
    }
  });

  it("shows a safe notice when the document cannot be loaded", async (t) => {
    t.mock.method(console, "error", () => {});
    const markup = html(await renderDocumentPage({ ...signing, idParam: "9", created: false, load: async () => Promise.reject(Object.assign(new Error("secret"), { code: "42P01" })) }));
    assert.match(markup, /The document is unavailable/);
    assert.doesNotMatch(markup, /secret/);
  });
});
