import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROFILE_FIELDS, PROFILE_SECTIONS, validateProfile } from "../src/profile.ts";

const valid = { A_NOMBRE: "Acme Ltd", A_EMAIL: "legal@acme.test" };

describe("PROFILE_FIELDS", () => {
  it("has unique marker-style keys, each in a known section", () => {
    const keys = PROFILE_FIELDS.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length);
    const sections = new Set<string>(PROFILE_SECTIONS.map((s) => s.id));
    for (const field of PROFILE_FIELDS) {
      assert.match(field.key, /^[A-Z_][A-Z0-9_]*$/);
      assert.ok(sections.has(field.section), field.key);
      assert.ok(field.label.length > 0);
    }
  });

  it("covers what the NDA needs from the owner", () => {
    const keys = PROFILE_FIELDS.map((f) => f.key);
    for (const key of ["A_NOMBRE", "A_CORTO", "A_EMAIL", "A_INFO", "COLOR", "PAGINA", "LEY_APLICABLE", "TRIBUNALES", "DIAS_NEGOCIACION", "MESES", "ANOS", "DIAS_DEVOLUCION"]) {
      assert.ok(keys.includes(key), key);
    }
  });
});

describe("validateProfile", () => {
  it("accepts the required fields alone and keeps only the filled ones", () => {
    const result = validateProfile(valid);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.set, valid);
    assert.ok(result.remove.includes("A_CORTO"));
    assert.ok(!result.remove.includes("A_NOMBRE"));
  });

  it("trims values and drops blank optional ones into `remove`", () => {
    const result = validateProfile({ ...valid, A_NOMBRE: "  Acme Ltd  ", A_DOMICILIO: "   " });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.set.A_NOMBRE, "Acme Ltd");
    assert.ok(!("A_DOMICILIO" in result.set));
    assert.ok(result.remove.includes("A_DOMICILIO"));
  });

  it("requires the company name and the email", () => {
    const result = validateProfile({ A_NOMBRE: " ", A_EMAIL: "" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(Object.keys(result.errors).sort(), ["A_EMAIL", "A_NOMBRE"]);
    assert.match(result.errors.A_NOMBRE!, /company name/i);
  });

  it("keeps the entered values when it fails", () => {
    const result = validateProfile({ ...valid, A_EMAIL: "nope", A_CORTO: "Acme" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.values.A_CORTO, "Acme");
    assert.equal(result.values.A_EMAIL, "nope");
    assert.equal(result.values.A_NOMBRE, "Acme Ltd");
  });

  it("checks the email shape", () => {
    for (const email of ["nope", "a@b", "a b@c.d", "@c.d"]) {
      const result = validateProfile({ ...valid, A_EMAIL: email });
      assert.equal(result.ok, false, email);
    }
  });

  it("accepts a six-digit hex color and lower-cases it, and rejects anything else", () => {
    const ok = validateProfile({ ...valid, COLOR: "#2563EB" });
    assert.equal(ok.ok && ok.set.COLOR, "#2563eb");
    for (const color of ["2563eb", "#256", "#25 63eb", "red", "#2563eb;}", "url(x)"]) {
      const result = validateProfile({ ...valid, COLOR: color });
      assert.equal(result.ok, false, color);
      if (!result.ok) assert.ok(result.errors.COLOR, color);
    }
  });

  it("accepts only A4 or letter as page size", () => {
    assert.equal(validateProfile({ ...valid, PAGINA: "A4" }).ok, true);
    assert.equal(validateProfile({ ...valid, PAGINA: "letter" }).ok, true);
    assert.equal(validateProfile({ ...valid, PAGINA: "legal" }).ok, false);
    assert.equal(validateProfile({ ...valid, PAGINA: "a4" }).ok, false);
  });

  it("accepts whole numbers from 1 to 999 for the terms and normalises leading zeros", () => {
    const ok = validateProfile({ ...valid, DIAS_NEGOCIACION: "030", MESES: "12" });
    assert.equal(ok.ok && ok.set.DIAS_NEGOCIACION, "30");
    for (const n of ["0", "-1", "1.5", "abc", "1000", "1e2"]) {
      const result = validateProfile({ ...valid, ANOS: n });
      assert.equal(result.ok, false, n);
    }
  });

  it("takes a two-letter country code in lower case", () => {
    const ok = validateProfile({ ...valid, A_PAIS: "AU" });
    assert.equal(ok.ok && ok.set.A_PAIS, "au");
    assert.equal(validateProfile({ ...valid, A_PAIS: "aus" }).ok, false);
    assert.equal(validateProfile({ ...valid, A_PAIS: "a1" }).ok, false);
  });

  it("limits the length of text and long text", () => {
    assert.equal(validateProfile({ ...valid, A_NOMBRE: "x".repeat(201) }).ok, false);
    assert.equal(validateProfile({ ...valid, A_NOMBRE: "x".repeat(200) }).ok, true);
    assert.equal(validateProfile({ ...valid, A_INFO: "x".repeat(2001) }).ok, false);
    assert.equal(validateProfile({ ...valid, A_INFO: "x".repeat(2000) }).ok, true);
  });

  it("stores line breaks of long text as plain newlines", () => {
    const result = validateProfile({ ...valid, A_INFO: "one\r\ntwo" });
    assert.equal(result.ok && result.set.A_INFO, "one\ntwo");
  });

  it("ignores keys that are not profile fields", () => {
    const result = validateProfile({ ...valid, EXTRA: "x", id: "9" });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(Object.keys(result.set).sort(), ["A_EMAIL", "A_NOMBRE"]);
  });

  it("treats a missing field like a blank one", () => {
    const result = validateProfile({ A_NOMBRE: "Acme", A_EMAIL: "a@b.co", A_CORTO: undefined });
    assert.equal(result.ok, true);
  });
});
