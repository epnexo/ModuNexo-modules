import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BODY_MAX, parseTemplateId, validateTemplate } from "../src/template-rules.ts";

const valid = { name: "Mutual NDA", slug: "mutual-nda", kind: "nda", refPrefix: "NDA", bodyHtml: "<p>{{B_NOMBRE}}</p>" };
const expected = { ...valid, counterpartyMarker: null };

describe("validateTemplate", () => {
  it("accepts a complete template", () => {
    const result = validateTemplate(valid);
    assert.deepEqual(result, { ok: true, value: expected });
  });

  it("keeps the counterparty marker when it is one of the body's markers, and none when it is blank", () => {
    const set = validateTemplate({ ...valid, counterpartyMarker: " B_NOMBRE " });
    assert.deepEqual(set, { ok: true, value: { ...valid, counterpartyMarker: "B_NOMBRE" } });
    for (const blank of ["", "  ", undefined]) assert.deepEqual(validateTemplate({ ...valid, counterpartyMarker: blank }), { ok: true, value: expected });
  });

  it("refuses a counterparty marker that is not a marker of the body", () => {
    for (const bad of ["OTHER", "b_nombre", "{{B_NOMBRE}}", "B NOMBRE", "B_NOMBRE;"]) {
      const result = validateTemplate({ ...valid, counterpartyMarker: bad });
      assert.equal(result.ok, false, bad);
      if (!result.ok) {
        assert.match(result.errors.counterpartyMarker!, /markers in the body/i, bad);
        assert.equal(result.values.counterpartyMarker, bad);
      }
    }
  });

  it("refuses the reference as counterparty marker: the platform fills it", () => {
    const result = validateTemplate({ ...valid, bodyHtml: "{{REF}} {{B_NOMBRE}}", counterpartyMarker: "REF" });
    assert.equal(result.ok, false);
  });

  it("trims name, slug, kind and prefix but keeps the body as typed", () => {
    const result = validateTemplate({ ...valid, name: "  Mutual NDA ", slug: " mutual-nda ", refPrefix: " NDA ", bodyHtml: "  <p>x</p>\n" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.name, "Mutual NDA");
    assert.equal(result.value.slug, "mutual-nda");
    assert.equal(result.value.refPrefix, "NDA");
    assert.equal(result.value.bodyHtml, "  <p>x</p>\n");
  });

  it("stores line breaks of the body as plain newlines", () => {
    const result = validateTemplate({ ...valid, bodyHtml: "<p>a</p>\r\n<p>b</p>\r\n" });
    assert.equal(result.ok && result.value.bodyHtml, "<p>a</p>\n<p>b</p>\n");
  });

  it("requires every field, with a message for each", () => {
    const result = validateTemplate({});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(Object.keys(result.errors).sort(), ["bodyHtml", "kind", "name", "refPrefix", "slug"]);
    for (const message of Object.values(result.errors)) assert.match(message, /^[A-Z].*\.$/);
  });

  it("treats a blank body as missing", () => {
    const result = validateTemplate({ ...valid, bodyHtml: " \n\t " });
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(Object.keys(result.errors), ["bodyHtml"]);
  });

  it("accepts lowercase words and digits joined by single hyphens as slug", () => {
    for (const slug of ["nda", "a1", "service-agreement-2", "1"]) assert.equal(validateTemplate({ ...valid, slug }).ok, true, slug);
    for (const slug of ["NDA", "a_b", "a b", "-a", "a-", "a--b", "ñandú", "a/b", "../x", "a".repeat(61)]) {
      const result = validateTemplate({ ...valid, slug });
      assert.equal(result.ok, false, slug);
      if (!result.ok) assert.ok(result.errors.slug, slug);
    }
  });

  it("accepts only the four kinds", () => {
    for (const kind of ["nda", "contract", "proposal", "other"]) assert.equal(validateTemplate({ ...valid, kind }).ok, true, kind);
    for (const kind of ["memo", "NDA", "", "nda,other"]) assert.equal(validateTemplate({ ...valid, kind }).ok, false, kind);
  });

  it("accepts uppercase letters and digits as prefix, up to ten characters", () => {
    for (const refPrefix of ["NDA", "C2", "A1B2C3D4E5"]) assert.equal(validateTemplate({ ...valid, refPrefix }).ok, true, refPrefix);
    for (const refPrefix of ["nda", "N-A", "N A", "NDA_1", "A1B2C3D4E5F", "ÑDA"]) {
      const result = validateTemplate({ ...valid, refPrefix });
      assert.equal(result.ok, false, refPrefix);
      if (!result.ok) assert.ok(result.errors.refPrefix, refPrefix);
    }
  });

  it("limits the name and the body size", () => {
    assert.equal(validateTemplate({ ...valid, name: "n".repeat(120) }).ok, true);
    assert.equal(validateTemplate({ ...valid, name: "n".repeat(121) }).ok, false);
    assert.equal(validateTemplate({ ...valid, bodyHtml: "x".repeat(BODY_MAX) }).ok, true);
    const tooBig = validateTemplate({ ...valid, bodyHtml: "x".repeat(BODY_MAX + 1) });
    assert.equal(tooBig.ok, false);
    if (!tooBig.ok) assert.match(tooBig.errors.bodyHtml!, /at most/);
  });

  it("returns the entered values with the errors so the form keeps them", () => {
    const result = validateTemplate({ ...valid, slug: "Bad Slug", bodyHtml: "<p>kept</p>" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.values, { name: "Mutual NDA", slug: "Bad Slug", kind: "nda", refPrefix: "NDA", bodyHtml: "<p>kept</p>", counterpartyMarker: "" });
    assert.deepEqual(Object.keys(result.errors), ["slug"]);
  });

  it("ignores fields it does not know", () => {
    const result = validateTemplate({ ...valid, id: "5", archivedAt: "now" });
    assert.deepEqual(result, { ok: true, value: expected });
  });
});

describe("parseTemplateId", () => {
  it("accepts positive integers written in plain digits", () => {
    assert.equal(parseTemplateId("1"), 1);
    assert.equal(parseTemplateId("42"), 42);
  });

  it("rejects everything else", () => {
    for (const value of ["0", "-1", "01", "1.5", "1e3", " 1", "1 ", "abc", "", "9999999999999999999", undefined, null, "1; drop table x"]) {
      assert.equal(parseTemplateId(value as string), null, String(value));
    }
  });
});
