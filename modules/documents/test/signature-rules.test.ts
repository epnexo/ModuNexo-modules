import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkSignatureLayout } from "../src/signature-layout.ts";
import { ownerSignerDefaults, validateSigners } from "../src/signature-rules.ts";

const box = (id: string, extra: Record<string, unknown> = {}) => ({ id, page: 2, x: 0.1, y: 0.8, w: 0.3, h: 0.05, ...extra });
const four = () => [box("firma-1"), box("fecha-1"), box("firma-2"), box("fecha-2")];

describe("checkSignatureLayout", () => {
  it("accepts the four boxes of the skill, in the stored order", () => {
    const stored = { pages: 3, fields: [box("firma-2"), box("fecha-1", { x: 0.5 }), box("firma-1"), box("fecha-2")] };
    const checked = checkSignatureLayout(stored);
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.ok && checked.fields.map((f) => f.id), ["firma-2", "fecha-1", "firma-1", "fecha-2"]);
    assert.equal(checked.ok && checked.fields[1]!.x, 0.5);
  });

  it("says there is no layout for a document without one", () => {
    for (const stored of [null, undefined, "x", 3, [], {}, { pages: 1 }, { fields: "x" }]) {
      const checked = checkSignatureLayout(stored);
      assert.equal(checked.ok, false, JSON.stringify(stored));
      assert.match(checked.ok ? "" : checked.reason, /layout/i);
    }
  });

  it("names the count when there are not exactly four boxes", () => {
    for (const fields of [[], four().slice(0, 3), [...four(), box("firma-3")]]) {
      const checked = checkSignatureLayout({ pages: 3, fields });
      assert.equal(checked.ok, false);
      assert.match(checked.ok ? "" : checked.reason, new RegExp(`${fields.length} signature box`));
    }
  });

  it("names the box that is missing or repeated", () => {
    const missing = checkSignatureLayout({ pages: 3, fields: [box("firma-1"), box("fecha-1"), box("firma-2"), box("fecha-3")] });
    assert.match(missing.ok ? "" : missing.reason, /fecha-2/);
    const repeated = checkSignatureLayout({ pages: 3, fields: [box("firma-1"), box("firma-1"), box("firma-2"), box("fecha-2")] });
    assert.equal(repeated.ok, false);
    assert.match(repeated.ok ? "" : repeated.reason, /fecha-1|firma-1/);
  });

  it("refuses a box with coordinates DocuSeal could not place", () => {
    const bad: Record<string, unknown>[] = [{ x: -0.1 }, { x: 1.2 }, { y: 2 }, { w: 0 }, { h: -1 }, { w: 1.5 }, { page: -1 }, { page: 1.5 }, { x: "0.1" }, { x: null }, { y: Number.NaN }];
    for (const extra of bad) {
      const checked = checkSignatureLayout({ pages: 3, fields: [box("firma-1", extra), box("fecha-1"), box("firma-2"), box("fecha-2")] });
      assert.equal(checked.ok, false, JSON.stringify(extra));
      assert.match(checked.ok ? "" : checked.reason, /firma-1/);
    }
  });

  it("skips an entry that is not an object and reports the box it leaves missing, so the per-entry branch is reached", () => {
    // Four entries, so the count check passes and each entry is looked at.
    for (const junk of [null, "x", 7, undefined, []]) {
      const checked = checkSignatureLayout({ pages: 3, fields: [junk, ...four().slice(1)] });
      assert.equal(checked.ok, false, String(junk));
      assert.match(checked.ok ? "" : checked.reason, /missing the box firma-1/, String(junk));
    }
  });

  it("keeps a box inside the page: x + w and y + h within 1, with a tolerance of one millionth for rounding", () => {
    const placed = (extra: Record<string, unknown>) => checkSignatureLayout({ pages: 3, fields: [box("firma-1", extra), box("fecha-1"), box("firma-2"), box("fecha-2")] });
    for (const extra of [{ x: 0.8, w: 0.3 }, { y: 0.97, h: 0.05 }, { x: 1, w: 0.1 }, { x: 0.5, w: 0.5 + 1e-5 }, { y: 0.9, h: 0.1 + 1e-5 }]) {
      const checked = placed(extra);
      assert.equal(checked.ok, false, JSON.stringify(extra));
      assert.match(checked.ok ? "" : checked.reason, /firma-1.*inside the page|inside the page.*firma-1/, JSON.stringify(extra));
    }
    for (const extra of [{ x: 0.7, w: 0.3 }, { y: 0.95, h: 0.05 }, { x: 0, y: 0, w: 1, h: 1 }, { x: 0.7, w: 0.3 + 1e-7 }, { y: 0.9, h: 0.1 + 1e-7 }]) {
      assert.equal(placed(extra).ok, true, JSON.stringify(extra));
    }
  });

  it("keeps the page index inside the stored page count, and needs a page count", () => {
    const withPages = (pages: unknown, page: number) => checkSignatureLayout({ pages, fields: [box("firma-1", { page }), box("fecha-1", { page }), box("firma-2", { page }), box("fecha-2", { page })] });
    assert.equal(withPages(3, 2).ok, true);
    assert.equal(withPages(1, 0).ok, true);
    for (const [pages, page] of [[3, 3], [1, 1], [3, 9]] as const) {
      const checked = withPages(pages, page);
      assert.equal(checked.ok, false, `${pages}/${page}`);
      assert.match(checked.ok ? "" : checked.reason, /page 4|page \d+.*(has|only)|beyond/i, `${pages}/${page}`);
    }
    for (const pages of [undefined, null, 0, -1, 2.5, "3", Number.NaN]) {
      const checked = withPages(pages, 0);
      assert.equal(checked.ok, false, String(pages));
      assert.match(checked.ok ? "" : checked.reason, /page count/i, String(pages));
    }
  });
});

describe("validateSigners", () => {
  const raw = { ownerName: "Ana Gómez", ownerEmail: "ana@acme.test", counterpartyName: "Ben Ruiz", counterpartyEmail: "ben@beta.test", order: "preserved" };

  it("accepts two signers and an order, trimmed", () => {
    const checked = validateSigners({ ...raw, ownerName: "  Ana Gómez ", counterpartyEmail: " ben@beta.test " });
    assert.deepEqual(checked, { ok: true, value: { owner: { name: "Ana Gómez", email: "ana@acme.test" }, counterparty: { name: "Ben Ruiz", email: "ben@beta.test" }, order: "preserved" } });
    assert.equal(validateSigners({ ...raw, order: "random" }).ok, true);
  });

  it("asks for each missing field next to it and keeps what was entered", () => {
    const checked = validateSigners({ ownerName: " ", ownerEmail: "", counterpartyName: "Ben", order: "" });
    assert.equal(checked.ok, false);
    if (checked.ok) return;
    assert.deepEqual(Object.keys(checked.errors).sort(), ["counterpartyEmail", "order", "ownerEmail", "ownerName"]);
    assert.deepEqual(checked.values, { ownerName: "", ownerEmail: "", counterpartyName: "Ben", counterpartyEmail: "", order: "" });
  });

  it("checks the emails", () => {
    for (const email of ["ana\u0007@acme.test", "ana@acme\u007f.test", "a\u0000na@acme.test", "ana@acme.test\u0085", "an\u001ba@acme.test", "ana", "ana@", "@acme.test", "ana@acme", "a b@acme.test", "ana@acme.test, ben@x.test", "ana@acme..test", `${"a".repeat(250)}@acme.test`, "ana@acme.test\nbcc:x@y.test"]) {
      const checked = validateSigners({ ...raw, ownerEmail: email });
      assert.equal(checked.ok, false, email);
      assert.ok(!checked.ok && checked.errors.ownerEmail, email);
    }
  });

  it("checks the names: length, one line, no control characters", () => {
    for (const name of ["x".repeat(201), "two\nlines", "bell\u0007", "nul\0"]) {
      const checked = validateSigners({ ...raw, counterpartyName: name });
      assert.equal(checked.ok, false, JSON.stringify(name));
      assert.ok(!checked.ok && checked.errors.counterpartyName);
    }
    assert.equal(validateSigners({ ...raw, ownerName: "x".repeat(200) }).ok, true);
  });

  it("refuses an order DocuSeal does not know, a missing one, and the same email for both signers", () => {
    for (const order of ["", "later", "RANDOM", undefined]) {
      const checked = validateSigners({ ...raw, order });
      assert.ok(!checked.ok && checked.errors.order, String(order));
    }
    const same = validateSigners({ ...raw, counterpartyEmail: "ANA@acme.test" });
    assert.ok(!same.ok && same.errors.counterpartyEmail && !same.errors.ownerEmail);
  });

  it("ignores fields it does not ask for and values that are not text", () => {
    const checked = validateSigners({ ...raw, templateId: "9", extra: "x" } as Record<string, string | undefined>);
    assert.equal(checked.ok, true);
    assert.equal(validateSigners({ ...raw, ownerName: 5 } as unknown as Record<string, string>).ok, false);
  });
});

describe("ownerSignerDefaults", () => {
  it("uses the representative when there is one, else the company, and its email", () => {
    assert.deepEqual(ownerSignerDefaults({ A_REPRESENTANTE: "Ana", A_NOMBRE: "Acme", A_EMAIL: "a@acme.test" }), { name: "Ana", email: "a@acme.test" });
    assert.deepEqual(ownerSignerDefaults({ A_NOMBRE: "Acme", A_EMAIL: "a@acme.test" }), { name: "Acme", email: "a@acme.test" });
    assert.deepEqual(ownerSignerDefaults({}), { name: "", email: "" });
  });
});
