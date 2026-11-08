import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSigningLinks } from "../src/signature-store.ts";

const good = { role: "Acme", name: "Ana", email: "ana@acme.test", link: "https://sign.example.test/s/a" };

describe("parseSigningLinks", () => {
  it("returns nothing for a value that is not a list", () => {
    for (const value of [null, undefined, "x", 3, true, {}, { 0: good, length: 1 }]) assert.deepEqual(parseSigningLinks(value), [], String(value));
  });

  it("keeps a well formed entry as it is and drops every key it does not know", () => {
    assert.deepEqual(parseSigningLinks([{ ...good, note: "x", extra: [1] }]), [good]);
  });

  it("drops an entry that is not an object", () => {
    assert.deepEqual(parseSigningLinks([null, "x", 7, true, undefined, [good], good]), [good]);
  });

  it("drops an entry whose role, name or email is missing or is not text", () => {
    for (const key of ["role", "name", "email"] as const) {
      assert.deepEqual(parseSigningLinks([{ ...good, [key]: undefined }]), [], `${key} missing`);
      for (const value of [5, null, true, ["x"], { a: 1 }]) assert.deepEqual(parseSigningLinks([{ ...good, [key]: value }]), [], `${key} ${JSON.stringify(value)}`);
    }
  });

  it("drops an entry whose link is not an absolute http or https URL, so it can never become an href", () => {
    for (const link of ["javascript:alert(1)", "data:text/html,<b>", "file:///etc/passwd", "ftp://x.test/a", "//evil.test/x", "/s/a", "s/a", "", "not a url", 5, null, undefined, ["https://a.test"]]) {
      assert.deepEqual(parseSigningLinks([{ ...good, link }]), [], String(link));
    }
    assert.equal(parseSigningLinks([{ ...good, link: "http://192.0.2.10:3000/s/a" }]).length, 1);
  });

  it("keeps a status and a time only when they are text", () => {
    assert.deepEqual(parseSigningLinks([{ ...good, status: "completed", at: "2026-10-12T10:00:00.000Z" }]), [{ ...good, status: "completed", at: "2026-10-12T10:00:00.000Z" }]);
    assert.deepEqual(parseSigningLinks([{ ...good, status: 5, at: false }]), [good]);
    assert.deepEqual(parseSigningLinks([{ ...good, status: null, at: {} }]), [good]);
    assert.deepEqual(parseSigningLinks([{ ...good, status: "opened" }]), [{ ...good, status: "opened" }]);
  });

  it("keeps the order of the entries it keeps", () => {
    const second = { ...good, role: "Beta" };
    assert.deepEqual(parseSigningLinks([second, null, good]), [second, good]);
  });
});
