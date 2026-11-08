import assert from "node:assert/strict";
import { printed } from "./helpers/printed.ts";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderRegistryPage } from "../web/registry-page.tsx";
import type { DocumentRow } from "../web/queries.ts";

const html = (element: ReactElement) => renderToStaticMarkup(createElement("div", null, element));

const row: DocumentRow = {
  id: 5,
  ref: "NDA-2026-001",
  title: "NDA Acme",
  counterpartyName: "Acme",
  templateName: "Mutual NDA",
  kind: "nda",
  status: "sent",
  createdAt: new Date("2026-10-02T09:30:00Z"),
  hasPdf: true,
};

describe("registry page", () => {
  it("renders the registry from the rows it loads, with the module sections and Documents marked", async () => {
    const markup = html(await renderRegistryPage(async () => [row]));
    assert.match(markup, /<h1>Documents<\/h1>/);
    assert.match(markup, /NDA-2026-001/);
    assert.match(markup, /<a [^>]*aria-current="page"[^>]*>Documents<\/a>/);
    assert.equal(markup.match(/aria-current="page"/g)?.length, 1);
    assert.match(markup, /href="\/documents\/templates"/);
    assert.match(markup, /href="\/documents\/settings"/);
  });

  it("puts New document in the page bar, linking to the form", async () => {
    const markup = html(await renderRegistryPage(async () => []));
    assert.match(markup, /<a [^>]*class="btn primary"[^>]*href="\/documents\/new"[^>]*>New document<\/a>|<a [^>]*href="\/documents\/new"[^>]*class="btn primary"[^>]*>New document<\/a>/);
  });

  it("renders the empty state for an empty registry", async () => {
    assert.match(html(await renderRegistryPage(async () => [])), /No documents yet\./);
  });

  it("renders a safe notice, not the error, when the query throws, and logs only the error code", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const secret = "postgres://user:hunter2@db.internal:5435/platform";
    const markup = html(await renderRegistryPage(async () => Promise.reject(Object.assign(new Error(`connect failed ${secret}`), { code: "ECONNREFUSED" }))));

    assert.match(markup, /Documents are unavailable/);
    assert.match(markup, /role="alert"/);
    assert.match(markup, /The database is unreachable/);
    assert.doesNotMatch(markup, /hunter2|db\.internal|<table/);
    assert.equal(logged.length, 1);
    assert.doesNotMatch(printed(logged), /hunter2|db\.internal/);
    assert.match(String(logged[0]![1]), /ECONNREFUSED/);
  });

  it("still shows the module sections when the query fails", async (t) => {
    t.mock.method(console, "error", () => {});
    const markup = html(await renderRegistryPage(async () => Promise.reject(new Error("boom"))));
    assert.match(markup, /href="\/documents\/templates"/);
    assert.match(markup, /The database query failed/);
  });
});
