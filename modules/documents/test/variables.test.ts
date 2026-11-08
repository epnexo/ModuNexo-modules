import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { longDate, parseVariableSettings } from "../src/variables.ts";

describe("longDate", () => {
  it("writes the date out in Spanish, the way the skill does: day, month name in lower case, year", () => {
    assert.equal(longDate(new Date(2026, 9, 12, 10, 0), "es"), "12 de octubre de 2026");
    assert.equal(longDate(new Date(2027, 0, 1, 0, 0), "es"), "1 de enero de 2027");
    assert.equal(longDate(new Date(2026, 8, 30), "es"), "30 de septiembre de 2026");
  });

  it("writes the date out in English", () => {
    assert.equal(longDate(new Date(2026, 9, 12, 10, 0), "en"), "October 12, 2026");
    assert.equal(longDate(new Date(2027, 0, 1), "en"), "January 1, 2027");
  });

  it("uses the calendar day of the server's time zone, so late evening is still the same day", () => {
    assert.equal(longDate(new Date(2026, 9, 12, 23, 59, 59), "es"), "12 de octubre de 2026");
    assert.equal(longDate(new Date(2026, 9, 12, 0, 0, 0), "en"), "October 12, 2026");
  });
});

describe("parseVariableSettings", () => {
  it("keeps well-formed settings", () => {
    const stored = { B_NOMBRE: { label: "Nombre", help: "Ayuda", kind: "line", default: "x" }, FECHA: { kind: "date", locale: "es" } };
    assert.deepEqual(parseVariableSettings(stored), stored);
  });

  it("reads anything that is not an object as no settings", () => {
    for (const value of [null, undefined, "x", 3, [], [{ a: 1 }], true]) assert.deepEqual(parseVariableSettings(value), {}, String(value));
  });

  it("skips what the application never writes: odd marker names, non-object entries, unknown fields and values of the wrong type", () => {
    const parsed = parseVariableSettings({
      b_nombre: { label: "lower case marker" },
      "A B": { label: "space" },
      X: "not an object",
      Y: ["array"],
      Z: { label: 3, help: null, kind: "number", default: ["a"], locale: "fr", extra: "x" },
      OK: { label: "kept", kind: "text", locale: "en", extra: "dropped" },
      __proto__: { label: "x" },
    });
    assert.deepEqual(parsed, { OK: { label: "kept", kind: "text", locale: "en" } });
  });

  it("omits an entry that ends up with nothing set", () => {
    assert.deepEqual(parseVariableSettings({ X: {}, Y: { label: "" } }), {});
  });
});
