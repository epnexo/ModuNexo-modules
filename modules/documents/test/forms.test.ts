import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROFILE_FIELDS } from "../src/profile.ts";
import { MarkerPanel } from "../web/components.tsx";
import { ArchiveForm, ProfileForm, TemplateForm } from "../web/forms.tsx";
import { EMPTY_TEMPLATE_VALUES, type ProfileFormState, type TemplateFormState } from "../web/form-state.ts";

const noop = async <S,>(state: S) => state;

const templateState = (extra: Partial<TemplateFormState> = {}): TemplateFormState => ({ values: EMPTY_TEMPLATE_VALUES, errors: {}, ...extra });
const profileState = (extra: Partial<ProfileFormState> = {}): ProfileFormState => ({
  values: Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, ""])),
  errors: {},
  ...extra,
});

const renderTemplate = (state: TemplateFormState, mode: "create" | "edit" = "create", counterpartyOptions: string[] = []) =>
  renderToStaticMarkup(createElement(TemplateForm, { endpoint: "/documents/test", initial: state, mode, id: mode === "edit" ? 7 : undefined, counterpartyOptions }));
const renderProfile = (state: ProfileFormState) => renderToStaticMarkup(createElement(ProfileForm, { endpoint: "/documents/test", initial: state }));

/** Every id referenced by an `aria-describedby` or a `for` attribute must exist in the markup. */
function danglingReferences(markup: string): string[] {
  const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
  const refs = [
    ...[...markup.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) => m[1]!.split(" ")),
    ...[...markup.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]!),
  ];
  return refs.filter((ref) => !ids.has(ref));
}

describe("TemplateForm", () => {
  it("renders a real label bound to each control", () => {
    const markup = renderTemplate(templateState());
    for (const name of ["name", "slug", "kind", "refPrefix", "counterpartyMarker", "bodyHtml"]) {
      assert.match(markup, new RegExp(`<label[^>]*for="f-${name}"`), name);
      assert.match(markup, new RegExp(`<(input|select|textarea)[^>]*id="f-${name}"[^>]*name="${name}"|<(input|select|textarea)[^>]*name="${name}"[^>]*id="f-${name}"`), name);
    }
    assert.deepEqual(danglingReferences(markup), []);
  });

  it("offers the four kinds and a first empty choice", () => {
    const markup = renderTemplate(templateState());
    assert.match(markup, /<option value=""[^>]*>Choose a kind<\/option>/);
    for (const kind of ["nda", "contract", "proposal", "other"]) assert.match(markup, new RegExp(`<option value="${kind}"`));
  });

  it("offers the markers asked for each document as the source of the counterparty name, optional", () => {
    const markup = renderTemplate(templateState({ values: { ...EMPTY_TEMPLATE_VALUES, counterpartyMarker: "B_NOMBRE" } }), "edit", ["B_CORTO", "B_NOMBRE"]);
    assert.match(markup, /<label[^>]*for="f-counterpartyMarker"[^>]*>Counterparty name comes from/);
    assert.match(markup, /<select[^>]*name="counterpartyMarker"/);
    assert.match(markup, /<option value=""[^>]*>None: ask for the name separately<\/option>/);
    assert.match(markup, /<option value="B_CORTO"[^>]*>B_CORTO<\/option>/);
    assert.match(markup, /<option value="B_NOMBRE" selected="">B_NOMBRE<\/option>/);
    assert.doesNotMatch(markup, /f-counterpartyMarker[^>]*aria-required/);
  });

  it("keeps a stored counterparty marker that is no longer offered, so saving does not drop it silently", () => {
    const markup = renderTemplate(templateState({ values: { ...EMPTY_TEMPLATE_VALUES, counterpartyMarker: "GONE" } }), "edit", ["B_NOMBRE"]);
    assert.match(markup, /<option value="GONE" selected="">GONE<\/option>/);
  });

  it("explains in a new template that the choice needs a saved body", () => {
    assert.match(renderTemplate(templateState()), /Save the template first/);
  });

  it("shows the entered values again, escaped, and selects the kind", () => {
    const markup = renderTemplate(templateState({ values: { name: `A "quoted" <name>`, slug: "x", kind: "contract", refPrefix: "CON", bodyHtml: "<p>{{A}}</p></textarea><script>1</script>", counterpartyMarker: "" } }));
    assert.match(markup, /value="A &quot;quoted&quot; &lt;name&gt;"/);
    assert.match(markup, /<option value="contract" selected="">/);
    assert.match(markup, /&lt;p&gt;\{\{A\}\}&lt;\/p&gt;&lt;\/textarea&gt;&lt;script&gt;1&lt;\/script&gt;<\/textarea>/);
    assert.doesNotMatch(markup, /<script>1<\/script>/);
  });

  it("associates each error with its field and marks the field invalid", () => {
    const markup = renderTemplate(templateState({ errors: { slug: "Enter a slug.", bodyHtml: "Enter the template body." } }));
    assert.match(markup, /<input[^>]*id="f-slug"[^>]*aria-invalid="true"[^>]*aria-describedby="[^"]*f-slug-error[^"]*"|<input[^>]*aria-describedby="[^"]*f-slug-error[^"]*"[^>]*aria-invalid="true"/);
    assert.match(markup, /<p id="f-slug-error" class="field-error">Enter a slug\.<\/p>/);
    assert.match(markup, /<p id="f-bodyHtml-error" class="field-error">Enter the template body\.<\/p>/);
    assert.doesNotMatch(markup, /<input[^>]*id="f-name"[^>]*aria-invalid/);
    assert.deepEqual(danglingReferences(markup), []);
  });

  it("announces that fields need attention when there are errors", () => {
    assert.match(renderTemplate(templateState({ errors: { name: "Enter a name." } })), /role="alert"[^>]*>\s*<strong>Check the highlighted fields\./);
    assert.doesNotMatch(renderTemplate(templateState()), /role="alert"/);
  });

  it("shows a form-level message as an alert", () => {
    assert.match(renderTemplate(templateState({ message: "The database is unreachable." })), /role="alert"[\s\S]*The database is unreachable\./);
  });

  it("shows the saved state", () => {
    assert.match(renderTemplate(templateState({ saved: true }), "edit"), /class="notice notice-success"[^>]*>\s*<strong>Template saved\./);
  });

  it("carries the checked id in edit mode only, and names the submit button by mode", () => {
    assert.match(renderTemplate(templateState(), "edit"), /<input type="hidden" name="id" value="7"\/>/);
    assert.doesNotMatch(renderTemplate(templateState(), "create"), /name="id"/);
    assert.match(renderTemplate(templateState(), "create"), /<button[^>]*type="submit"[^>]*>Create template<\/button>/);
    assert.match(renderTemplate(templateState(), "edit"), /<button[^>]*type="submit"[^>]*>Save changes<\/button>/);
  });

  it("is a labelled form with a way back to the list", () => {
    const markup = renderTemplate(templateState());
    assert.match(markup, /<form[^>]*aria-label="Template"/);
    assert.match(markup, /<a [^>]*href="\/documents\/templates"[^>]*>Cancel<\/a>/);
  });
});

describe("ProfileForm", () => {
  it("renders every profile field with a bound label, grouped in sections", () => {
    const markup = renderProfile(profileState());
    for (const field of PROFILE_FIELDS) {
      assert.match(markup, new RegExp(`<label[^>]*for="f-${field.key}"`), field.key);
      assert.match(markup, new RegExp(`id="f-${field.key}"`), field.key);
    }
    assert.deepEqual(danglingReferences(markup), []);
    for (const title of ["Company", "Representative", "Branding", "Default terms"]) assert.match(markup, new RegExp(`<h2 class="text-lg font-semibold tracking-tight">${title}</h2>`));
  });

  it("marks the required fields and offers page sizes", () => {
    const markup = renderProfile(profileState());
    assert.match(markup, /<input[^>]*id="f-A_NOMBRE"[^>]*aria-required="true"|<input[^>]*aria-required="true"[^>]*id="f-A_NOMBRE"/);
    assert.match(markup, /Company name<span class="ml-1 text-danger"> \(required\)<\/span>/);
    assert.match(markup, /<select[^>]*id="f-PAGINA"/);
    assert.match(markup, /<option value="A4"/);
    assert.match(markup, /<option value="letter"/);
  });

  it("uses a color-capable text field with the pattern, not a free color widget", () => {
    assert.match(renderProfile(profileState()), /<input[^>]*id="f-COLOR"[^>]*type="text"|<input[^>]*type="text"[^>]*id="f-COLOR"/);
  });

  it("shows values, errors tied to their fields, and the saved state", () => {
    const markup = renderProfile(profileState({ values: { ...profileState().values, A_NOMBRE: "Acme & Co", COLOR: "blue" }, errors: { COLOR: "Use a six-digit hex color starting with #." }, saved: false }));
    assert.match(markup, /value="Acme &amp; Co"/);
    assert.match(markup, /<p id="f-COLOR-error" class="field-error">Use a six-digit hex color starting with #\.<\/p>/);
    assert.deepEqual(danglingReferences(markup), []);
    assert.match(renderProfile(profileState({ saved: true })), /class="notice notice-success"[^>]*>\s*<strong>Profile saved\./);
  });
});

describe("ArchiveForm", () => {
  it("posts the checked id with a secondary button and explains what archiving does", () => {
    const markup = renderToStaticMarkup(createElement(ArchiveForm, { endpoint: "/documents/test", initial: {}, id: 7 }));
    assert.match(markup, /<input type="hidden" name="id" value="7"\/>/);
    assert.match(markup, /<button[^>]*class="btn"[^>]*>Archive template<\/button>/);
    assert.match(markup, /hidden from the list/i);
  });

  it("shows a message as an alert", () => {
    const markup = renderToStaticMarkup(createElement(ArchiveForm, { endpoint: "/documents/test", initial: { message: "This template no longer exists or is archived." }, id: 7 }));
    assert.match(markup, /role="alert"/);
  });
});

describe("MarkerPanel", () => {
  it("lists the markers in the two groups, in order, as code", () => {
    const markup = renderToStaticMarkup(createElement(MarkerPanel, { groups: { fromProfile: ["A_NOMBRE", "COLOR"], perDocument: ["B_NOMBRE", "REF"] }, malformed: [] }));
    assert.match(markup, /Filled from the profile \(2\)/);
    assert.match(markup, /Asked for each document \(2\)/);
    assert.ok(markup.indexOf("A_NOMBRE") < markup.indexOf("COLOR") && markup.indexOf("COLOR") < markup.indexOf("B_NOMBRE"));
    assert.match(markup, /<li class="dc-chip">B_NOMBRE<\/li>/);
  });

  it("says that the platform fills the reference", () => {
    const markup = renderToStaticMarkup(createElement(MarkerPanel, { groups: { fromProfile: [], perDocument: ["A"] }, malformed: [] }));
    assert.match(markup, /\{\{REF\}\} is filled by the platform/);
  });

  it("says so when a group is empty or the body has no markers", () => {
    const markup = renderToStaticMarkup(createElement(MarkerPanel, { groups: { fromProfile: [], perDocument: [] }, malformed: [] }));
    assert.match(markup, /No markers in the saved body\./);
  });

  it("warns about malformed marker text, escaped", () => {
    const markup = renderToStaticMarkup(createElement(MarkerPanel, { groups: { fromProfile: [], perDocument: ["A"] }, malformed: ["{{ NAME }}", "{{<b>}}"] }));
    assert.match(markup, /not valid markers/);
    assert.match(markup, /\{\{ NAME \}\}/);
    assert.match(markup, /\{\{&lt;b&gt;\}\}/);
    assert.doesNotMatch(markup, /<b>/);
  });
});
