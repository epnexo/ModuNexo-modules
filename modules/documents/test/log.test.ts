import assert from "node:assert/strict";
import { printed } from "./helpers/printed.ts";
import { describe, it } from "node:test";
import { logFailure } from "../web/log.ts";

describe("logFailure", () => {
  it("logs the error code, or the name when there is no code", (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    logFailure("scope", Object.assign(new Error("secret message"), { code: "ECONNREFUSED" }));
    logFailure("scope", new TypeError("secret message"));
    assert.deepEqual(logged.map((args) => args[1]), ["ECONNREFUSED", "TypeError"]);
    assert.doesNotMatch(printed(logged), /secret message/);
  });

  it("adds the detail the caller made safe after the label", (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    logFailure("scope", { code: "exit 1" }, "render failed: ValueError");
    assert.deepEqual(logged[0], ["documents: scope:", "exit 1", "render failed: ValueError"]);
  });

  it("does not throw on a rejection that is undefined, null or not an object", (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    for (const reason of [undefined, null, "boom: postgres://u:hunter2@db/x", 42, true, Symbol("s")]) {
      assert.doesNotThrow(() => logFailure("scope", reason), String(typeof reason));
    }
    assert.equal(logged.length, 6);
    assert.doesNotMatch(printed(logged), /hunter2/, "a string rejection is never printed");
  });
});
