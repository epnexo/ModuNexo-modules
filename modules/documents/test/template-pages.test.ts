import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Template } from "../src/template-store.ts";
import { renderSettingsPage } from "../web/settings-page.tsx";
import { renderTemplateEditPage } from "../web/template-edit-page.tsx";
import { renderTemplatesPage } from "../web/templates-page.tsx";

const html = (element: ReactElement) => renderToStaticMarkup(createElement("div", null, element));
const quiet = (t: { mock: { method: (object: object, name: "error", implementation: () => void) => unknown } }) => t.mock.method(console, "error", () => {});

const template = (extra: Partial<Template> = {}): Template => ({
  id: 7,
  slug: "nda",
  name: "Mutual NDA",
  kind: "nda",
  refPrefix: "NDA",
  bodyHtml: "<p>{{A_NOMBRE}} {{B_NOMBRE}} {{REF}} {{ bad }}</p>",
  createdAt: new Date("2026-10-01T08:00:00Z"),
  updatedAt: new Date("2026-10-02T09:30:00Z"),
  archivedAt: null,
  variables: {},
  counterpartyMarker: null,
  ...extra,
});

const isNotFound = (error: unknown) => String((error as { digest?: string }).digest).includes("404");

describe("templates page", () => {
  it("lists name, kind, prefix, variables asked per document and updated time, with Templates marked", async () => {
    const markup = html(
      await renderTemplatesPage(async () => ({
        templates: [template(), template({ id: 8, name: "Services", kind: "contract", refPrefix: "CON", bodyHtml: "{{A_NOMBRE}}" })],
        profile: { A_NOMBRE: "Acme" },
      })),
    );
    assert.match(markup, /<a [^>]*href="\/documents\/templates\/7"[^>]*>Mutual NDA<\/a>/);
    assert.match(markup, /<th[^>]*>Asked per document<\/th>/);
    assert.match(markup, /<td class="tabular-nums right">1<\/td>/);
    assert.match(markup, /<td class="tabular-nums right">0<\/td>/);
    assert.match(markup, /Contract/);
    assert.match(markup, /2026-10-02 09:30/);
    assert.match(markup, /<a [^>]*aria-current="page"[^>]*>Templates<\/a>/);
    assert.match(markup, /<a [^>]*href="\/documents\/templates\/new"[^>]*>New template<\/a>/);
  });

  it("links each template to its preview in a new tab, named after the template", async () => {
    const markup = html(await renderTemplatesPage(async () => ({ templates: [template(), template({ id: 8, name: "Services" })], profile: {} })));
    const tag = markup.match(/<a [^>]*href="\/documents\/templates\/7\/preview"[^>]*>/)?.[0];
    assert.ok(tag, "the preview link is there");
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer"/);
    assert.match(tag, /aria-label="Preview Mutual NDA \(opens in a new tab\)"/);
    assert.match(markup, /<a [^>]*href="\/documents\/templates\/8\/preview"[^>]*aria-label="Preview Services \(opens in a new tab\)"/);
    assert.match(markup, />Preview<\/a>/);
  });

  it("escapes the template name in the preview link's name", async () => {
    const markup = html(await renderTemplatesPage(async () => ({ templates: [template({ name: 'x" onfocus="1' })], profile: {} })));
    assert.doesNotMatch(markup, /onfocus="1/);
  });

  it("shows a short sentence and the new-template link when there are no templates", async () => {
    const markup = html(await renderTemplatesPage(async () => ({ templates: [], profile: {} })));
    assert.match(markup, /No templates yet\./);
    assert.doesNotMatch(markup, /<table/);
    assert.match(markup, /href="\/documents\/templates\/new"/);
  });

  it("escapes names that come from the database", async () => {
    const markup = html(await renderTemplatesPage(async () => ({ templates: [template({ name: "<img src=x onerror=alert(1)>" })], profile: {} })));
    assert.doesNotMatch(markup, /<img/);
    assert.match(markup, /&lt;img src=x/);
  });

  it("renders a safe notice when the query throws, and keeps the module sections", async (t) => {
    quiet(t);
    const markup = html(await renderTemplatesPage(async () => Promise.reject(Object.assign(new Error("x"), { code: "42P01" }))));
    assert.match(markup, /Templates are unavailable/);
    assert.match(markup, /install or upgrade the module/i);
    assert.match(markup, /href="\/documents"/);
  });
});

describe("template edit page", () => {
  const load = (found: Template | null, profile: Record<string, string> = { A_NOMBRE: "Acme" }) => async () => ({ template: found, profile });

  it("renders the empty create form, with no markers and no archive section, for a new template", async () => {
    const markup = html(await renderTemplateEditPage({ idParam: undefined, saved: false, load: load(null) }));
    assert.match(markup, /<h1>New template<\/h1>/);
    assert.match(markup, /Create template/);
    assert.doesNotMatch(markup, /Archive template|Asked for each document/);
    assert.match(markup, /<a [^>]*aria-current="page"[^>]*>Templates<\/a>/);
  });

  it("renders the saved template, its markers in two groups and the archive action", async () => {
    const markup = html(await renderTemplateEditPage({ idParam: "7", saved: false, load: load(template()) }));
    assert.match(markup, /<h1>Mutual NDA<\/h1>/);
    assert.match(markup, /Save changes/);
    assert.match(markup, /Filled from the profile \(1\)/);
    assert.match(markup, /Asked for each document \(1\)/);
    assert.match(markup, /<li class="dc-chip">A_NOMBRE<\/li>/);
    assert.match(markup, /not valid markers/);
    assert.match(markup, /Archive template/);
    assert.match(markup, /name="id" value="7"/);
  });

  it("offers a preview of the saved body in a new tab, says it ignores unsaved edits, and has none for a new or archived template", async () => {
    const markup = html(await renderTemplateEditPage({ idParam: "7", saved: false, load: load(template()) }));
    const tag = markup.match(/<a [^>]*href="\/documents\/templates\/7\/preview"[^>]*>/)?.[0];
    assert.ok(tag, "the preview link is there");
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer"/);
    assert.match(tag, /aria-label="Preview Mutual NDA \(opens in a new tab\)"/);
    assert.match(markup, /Shows the saved body, not unsaved changes\./);
    assert.doesNotMatch(html(await renderTemplateEditPage({ idParam: undefined, saved: false, load: load(null) })), /preview/i);
    assert.doesNotMatch(html(await renderTemplateEditPage({ idParam: "7", saved: false, load: load(template({ archivedAt: new Date("2026-10-03T00:00:00Z") })) })), /\/preview/);
  });

  it("lists the variables of the saved body in a Variables section, with the stored settings, and none for a new or archived template", async () => {
    const stored = template({ bodyHtml: "{{A_NOMBRE}} {{B_NOMBRE}} {{FECHA}} {{REF}}", variables: { B_NOMBRE: { label: "Nombre de la contraparte" }, FECHA: { kind: "date", locale: "en" }, GONE: { label: "not in the body" } } });
    const markup = html(await renderTemplateEditPage({ idParam: "7", saved: false, load: load(stored) }));
    assert.match(markup, />Variables<\/h3>/);
    assert.deepEqual([...markup.matchAll(/<tr[^>]*data-marker="([^"]+)"/g)].map((m) => m[1]), ["B_NOMBRE", "FECHA"], "profile markers and REF are not asked, so they have no row");
    assert.match(markup, /value="Nombre de la contraparte"/);
    assert.match(markup, /<option value="date" selected="">Date<\/option>/);
    assert.doesNotMatch(markup, /not in the body/);
    assert.doesNotMatch(html(await renderTemplateEditPage({ idParam: undefined, saved: false, load: load(null) })), /Variables/);
    assert.doesNotMatch(html(await renderTemplateEditPage({ idParam: "7", saved: false, load: load(template({ archivedAt: new Date("2026-10-03T00:00:00Z") })) })), /Variables/);
  });

  it("never renders the body as live HTML", async () => {
    const markup = html(await renderTemplateEditPage({ idParam: "7", saved: false, load: load(template({ bodyHtml: "<script>alert(1)</script><style>body{}</style>{{X}}" })) }));
    assert.doesNotMatch(markup, /<script>alert/);
    assert.doesNotMatch(markup, /<style>body/);
    assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("shows a saved notice after a create redirect", async () => {
    assert.match(html(await renderTemplateEditPage({ idParam: "7", saved: true, load: load(template()) })), /Template saved\./);
  });

  it("shows an archived template without the form", async () => {
    const markup = html(await renderTemplateEditPage({ idParam: "7", saved: false, load: load(template({ archivedAt: new Date("2026-10-03T00:00:00Z") })) }));
    assert.match(markup, /This template is archived/);
    assert.doesNotMatch(markup, /<form|<textarea|Archive template/);
  });

  it("answers 404 for a missing template and for an id that is not a number, without querying", async () => {
    await assert.rejects(renderTemplateEditPage({ idParam: "7", saved: false, load: load(null) }), isNotFound);
    for (const idParam of ["abc", "0", "-3", "7x", "1; drop"]) {
      let loaded = false;
      await assert.rejects(
        renderTemplateEditPage({ idParam, saved: false, load: async () => ((loaded = true), { template: null, profile: {} }) }),
        isNotFound,
        idParam,
      );
      assert.equal(loaded, false, "a bad id never reaches the database");
    }
  });

  it("renders a safe notice when the query throws", async (t) => {
    quiet(t);
    const markup = html(await renderTemplateEditPage({ idParam: "7", saved: false, load: async () => Promise.reject(new Error("boom")) }));
    assert.match(markup, /The template is unavailable/);
    assert.doesNotMatch(markup, /boom|<form/);
  });
});

describe("profile page", () => {
  it("renders the form with the stored values and Profile marked", async () => {
    const markup = html(await renderSettingsPage(async () => ({ A_NOMBRE: "Acme & Co", A_EMAIL: "" })));
    assert.match(markup, /<h1>Owner profile<\/h1>/);
    assert.match(markup, /value="Acme &amp; Co"/);
    assert.match(markup, /Save profile/);
    assert.match(markup, /<a [^>]*aria-current="page"[^>]*>Profile<\/a>/);
  });

  it("offers to test the PDF engine, posting to its own route, and shows no result before it is used", async () => {
    const markup = html(await renderSettingsPage(async () => ({})));
    assert.match(markup, /aria-label="Test the PDF engine"/);
    assert.match(markup, /Test connection/);
    assert.doesNotMatch(markup, /Connected\.|class="notice/);
  });

  it("renders a safe notice when the query throws", async (t) => {
    quiet(t);
    const markup = html(await renderSettingsPage(async () => Promise.reject(new Error("boom"))));
    assert.match(markup, /The profile is unavailable/);
    assert.doesNotMatch(markup, /<form|boom/);
  });
});

describe("importing a template", () => {
  const load = async () => ({ template: null, profile: {} });

  it("offers, on the new-template page, to load any document from an HTML file and to import the NDA", async () => {
    const markup = html(await renderTemplateEditPage({ idParam: undefined, saved: false, load }));
    assert.match(markup, /Load the body from an HTML file/);
    assert.match(markup, /type="file"[^>]*accept="\.html,\.htm,text\/html"/);
    const form = markup.match(/<form [^>]*action="\/documents\/templates\/import-nda"[^>]*>/)?.[0] ?? "";
    assert.match(form, /enctype="multipart\/form-data"/i);
    assert.match(form, /method="post"/);
    for (const field of ["template", "config", "script"]) {
      const input = markup.match(new RegExp(`<input [^>]*name="${field}"[^>]*>`))?.[0] ?? "";
      assert.match(input, /type="file"/, field);
    }
  });

  it("does not offer the file loader when editing a template, where it could overwrite a saved body by accident", async () => {
    const markup = html(await renderTemplateEditPage({ idParam: "7", saved: false, load: async () => ({ template: template(), profile: {} }) }));
    assert.doesNotMatch(markup, /Load the body from an HTML file|import-nda/);
  });

  it("shows why an NDA import failed where the form is, for a known code only", async () => {
    assert.match(html(await renderTemplateEditPage({ idParam: undefined, saved: false, importError: "invalid-files", load })), /Template not imported/);
    assert.doesNotMatch(html(await renderTemplateEditPage({ idParam: undefined, saved: false, importError: "<b>x</b>", load })), /Template not imported|<b>x/);
  });

  it("no longer carries the import form on the list, which only reports the result", async () => {
    const markup = html(await renderTemplatesPage(async () => ({ templates: [], profile: {} }), { imported: "created", profile: "2" }));
    assert.doesNotMatch(markup, /import-nda/);
    assert.match(markup, /The template was created\. 2 profile fields were added/);
  });
});
