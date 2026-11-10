import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Notice, RegistryBody } from "../web/components.tsx";
import type { DocumentRow } from "../web/queries.ts";

const render = <P extends object>(component: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(component, props));

const rows: DocumentRow[] = [
  {
    id: 12,
    ref: "NDA-2026-002",
    title: "NDA <Beta>",
    counterpartyName: "Beta & Co",
    templateName: "Mutual NDA",
    kind: "nda",
    status: "sent",
    createdAt: new Date("2026-10-02T09:30:00Z"),
    hasPdf: true,
  },
  {
    id: 11,
    ref: "CON-2026-001",
    title: "Services",
    counterpartyName: "Globex",
    templateName: "Services contract",
    kind: "contract",
    status: "completed",
    createdAt: new Date("2026-10-01T08:00:00Z"),
    hasPdf: false,
  },
];

describe("RegistryBody", () => {
  it("links each reference to the detail page of its document, and offers to create the first one", () => {
    const html = render(RegistryBody, { rows });
    assert.match(html, /<a [^>]*href="\/documents\/12"[^>]*>NDA-2026-002<\/a>/);
    assert.match(html, /<a [^>]*href="\/documents\/11"[^>]*>CON-2026-001<\/a>/);
    assert.match(render(RegistryBody, { rows: [] }), /<a [^>]*href="\/documents\/new"[^>]*>Create the first one<\/a>/);
  });

  it("shows the KPI row and a short sentence instead of a table when there are no documents", () => {
    const html = render(RegistryBody, { rows: [] });
    assert.match(html, /class="stats"/);
    assert.match(html, /No documents yet\./);
    assert.doesNotMatch(html, /<table/);
  });

  it("renders one row per document with its status badge, in the order given", () => {
    const html = render(RegistryBody, { rows });
    assert.match(html, /<table/);
    assert.ok(html.indexOf("NDA-2026-002") < html.indexOf("CON-2026-001"));
    assert.match(html, /<span class="badge badge-warning">Sent<\/span>/);
    assert.match(html, /<span class="badge badge-success">Completed<\/span>/);
    assert.match(html, /2026-10-02 09:30/);
    assert.doesNotMatch(html, /No documents yet/);
  });

  it("escapes values that come from the database", () => {
    const html = render(RegistryBody, { rows });
    assert.match(html, /NDA &lt;Beta&gt;/);
    assert.match(html, /Beta &amp; Co/);
  });
});

describe("RegistryBody: previews", () => {
  const anchor = (html: string, href: string) => html.match(new RegExp(`<a [^>]*href="${href.replace(/[?]/g, "\\?")}"[^>]*>`))?.[0];

  it("links a document that has a PDF to the inline preview, in a new tab, named after the document", () => {
    const tag = anchor(render(RegistryBody, { rows }), "/documents/12/pdf?inline=1");
    assert.ok(tag, "the preview link is there");
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer"/);
    assert.match(tag, /aria-label="Preview NDA-2026-002 \(opens in a new tab\)"/);
    assert.match(render(RegistryBody, { rows }), /<a [^>]*>Preview<\/a>/);
  });

  it("shows no preview link for a document without a PDF", () => {
    const html = render(RegistryBody, { rows });
    assert.equal(anchor(html, "/documents/11/pdf?inline=1"), undefined);
    assert.equal((html.match(/inline=1/g) ?? []).length, 1);
  });
});

describe("Notice", () => {
  it("renders the error tone as an alert", () => {
    const html = render(Notice, { tone: "error", title: "Documents are unavailable", children: "The database is unreachable." });
    assert.match(html, /class="notice notice-error"/);
    assert.match(html, /role="alert"/);
    assert.match(html, /<strong>Documents are unavailable<\/strong>/);
  });
});
