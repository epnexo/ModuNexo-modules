import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VariableRow } from "../src/variable-rules.ts";
import { EMPTY_TEMPLATE_VALUES, type TemplateFormState } from "../web/form-state.ts";
import { TemplateForm } from "../web/forms.tsx";

const noop = async <S,>(state: S) => state;
const row = (marker: string, extra: Partial<VariableRow> = {}): VariableRow => ({ marker, label: "", help: "", kind: "", default: "", locale: "es", ...extra });
const state = (extra: Partial<TemplateFormState> = {}): TemplateFormState => ({ values: EMPTY_TEMPLATE_VALUES, errors: {}, ...extra });
const render = (s: TemplateFormState, mode: "create" | "edit" = "edit", options: string[] = []) =>
  renderToStaticMarkup(createElement(TemplateForm, { endpoint: "/documents/test", initial: s, mode, id: mode === "edit" ? 7 : undefined, counterpartyOptions: options }));
const ROWS = [row("B_NOMBRE", { label: "Nombre de la contraparte", help: "Razón social" }), row("FECHA", { kind: "date", locale: "en", label: "Fecha" }), row("FINALIDAD", { default: "evaluar" }), row("PIE")];

function danglingReferences(markup: string): string[] {
  const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
  const refs = [...markup.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) => m[1]!.split(" ")).concat([...markup.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]!));
  return refs.filter((ref) => !ids.has(ref));
}

describe("the Variables section of the template form", () => {
  it("has a row for each marker asked per document, in order, with the marker named", () => {
    const markup = render(state({ variables: ROWS }));
    assert.match(markup, />Variables<\/h3>/);
    const markers = [...markup.matchAll(/<tr[^>]*data-marker="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(markers, ["B_NOMBRE", "FECHA", "FINALIDAD", "PIE"]);
    assert.match(markup, /<code>\{\{B_NOMBRE\}\}<\/code>/);
  });

  it("says the list comes from the saved body and that a marker added to the body appears after saving", () => {
    assert.match(render(state({ variables: ROWS })), /comes from the saved body[^<]*appears here after you save/i);
  });

  it("says in one sentence that a default can use other fields by writing their marker", () => {
    const markup = render(state({ variables: ROWS }));
    assert.match(markup, /A default can use other fields: write their marker, such as \{\{B_NOMBRE\}\}, and it is filled in when the document is created\./);
  });

  it("is not there for a new template, which has no saved body yet", () => {
    assert.doesNotMatch(render(state({ variables: [] }), "create"), /Variables/);
  });

  it("says when the saved body asks for nothing per document", () => {
    const markup = render(state({ variables: [] }));
    assert.match(markup, />Variables<\/h3>/);
    assert.match(markup, /asks for no values/);
    assert.doesNotMatch(markup, /<table/);
  });

  it("names the inputs variables.<MARKER>.<field> and binds an accessible name to each", () => {
    const markup = render(state({ variables: [row("B_NOMBRE")] }));
    for (const field of ["label", "help", "kind", "default", "locale"]) {
      const tag = markup.match(new RegExp(`<(input|select|textarea)[^>]*name="variables\\.B_NOMBRE\\.${field}"[^>]*>`))?.[0];
      assert.ok(tag, field);
      assert.match(tag, new RegExp(`id="f-variables\\.B_NOMBRE\\.${field}"`));
      assert.match(tag, /aria-label="[^"]*B_NOMBRE"/);
    }
    assert.deepEqual(danglingReferences(markup), []);
  });

  it("shows the stored values, selects the kind and the date language, and puts a long default in a textarea", () => {
    const markup = render(state({ variables: ROWS }));
    assert.match(markup, /name="variables\.B_NOMBRE\.label"[^>]*value="Nombre de la contraparte"|value="Nombre de la contraparte"[^>]*name="variables\.B_NOMBRE\.label"/);
    assert.match(markup, /value="Razón social"/);
    assert.match(markup, /<select[^>]*name="variables\.FECHA\.kind"[^>]*>[\s\S]*?<option value="date" selected="">Date<\/option>/);
    assert.match(markup, /<select[^>]*name="variables\.FECHA\.locale"[^>]*>[\s\S]*?<option value="en" selected="">English<\/option>/);
    assert.match(markup, /<textarea[^>]*name="variables\.FINALIDAD\.default"[^>]*>evaluar<\/textarea>/, "a marker named FINALIDAD is long text by the word rule");
    assert.match(markup, /<input[^>]*name="variables\.B_NOMBRE\.default"/);
    assert.doesNotMatch(markup, /<textarea[^>]*name="variables\.B_NOMBRE\.default"/);
  });

  it("offers the chosen kind first, with what automatic means for each marker", () => {
    const markup = render(state({ variables: [row("B_NOMBRE"), row("INTRO")] }));
    assert.match(markup, /<select[^>]*name="variables\.B_NOMBRE\.kind"[^>]*>\s*<option value=""[^>]*>Automatic: one line<\/option>/);
    assert.match(markup, /<select[^>]*name="variables\.INTRO\.kind"[^>]*>\s*<option value=""[^>]*>Automatic: long text<\/option>/);
    for (const text of ["One line", "Long text", "Date", "Spanish", "English"]) assert.ok(markup.includes(`>${text}</option>`), text);
  });

  it("uses a textarea for a default when the chosen kind is long text and a line otherwise, whatever the name", () => {
    const markup = render(state({ variables: [row("B_NOMBRE", { kind: "text" }), row("INTRO", { kind: "line" })] }));
    assert.match(markup, /<textarea[^>]*name="variables\.B_NOMBRE\.default"/);
    assert.match(markup, /<input[^>]*name="variables\.INTRO\.default"/);
  });

  it("escapes what the owner typed and never renders it as markup", () => {
    const evil = `"><script>alert(1)</script>`;
    const markup = render(state({ variables: [row("B_NOMBRE", { label: evil, help: evil, default: evil }), row("FINALIDAD", { default: `</textarea><script>1</script>` })] }));
    // React adds its own form-replay script to server markup; only the owner's text must not become a tag.
    assert.doesNotMatch(markup, /<script>(alert|1<)|"><script/);
    assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("shows each error next to its field, marks the field invalid and announces that fields need attention", () => {
    const markup = render(state({ variables: ROWS, variableErrors: { "B_NOMBRE.label": "Use at most 80 characters.", "FINALIDAD.default": "Use at most 2000 characters." } }));
    assert.match(markup, /<p id="f-variables\.B_NOMBRE\.label-error" class="field-error">Use at most 80 characters\.<\/p>/);
    assert.match(markup, /<input[^>]*name="variables\.B_NOMBRE\.label"[^>]*aria-invalid="true"|<input[^>]*aria-invalid="true"[^>]*name="variables\.B_NOMBRE\.label"/);
    assert.match(markup, /aria-describedby="f-variables\.B_NOMBRE\.label-error"/);
    assert.doesNotMatch(markup, /<input[^>]*name="variables\.B_NOMBRE\.help"[^>]*aria-invalid/);
    assert.match(markup, /role="alert"[^>]*>\s*<strong>Check the highlighted fields\./);
    assert.deepEqual(danglingReferences(markup), []);
  });

  it("names the markers whose settings the save dropped", () => {
    const markup = render(state({ saved: true, variables: ROWS, dropped: ["PIE_OLD", "X"] }));
    assert.match(markup, /Template saved\./);
    assert.match(markup, /dropped[^<]*PIE_OLD, X/);
    assert.doesNotMatch(render(state({ saved: true, variables: ROWS, dropped: [] })), /dropped/);
  });

  it("offers the counterparty name choice from the markers in the rows, so a marker saved just now is there without a reload", () => {
    const markup = render(state({ variables: [row("B_NOMBRE"), row("NUEVO")] }), "edit", ["B_NOMBRE"]);
    assert.match(markup, /<option value="NUEVO"[^>]*>NUEVO<\/option>/);
  });

  it("keeps the counterparty choice from the options when the state has no rows", () => {
    assert.match(render(state(), "edit", ["B_CORTO"]), /<option value="B_CORTO"/);
  });
});
