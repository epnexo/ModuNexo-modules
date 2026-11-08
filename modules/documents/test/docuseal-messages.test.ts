import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DocusealError } from "../src/docuseal-client.ts";
import { describeDocusealError, docusealCode } from "../src/docuseal-messages.ts";

const ALL: DocusealError[] = [
  { kind: "not-configured" },
  { kind: "unreachable", reason: "timeout" },
  { kind: "unreachable", reason: "network" },
  { kind: "outcome-unknown", reason: "timeout" },
  { kind: "outcome-unknown", reason: "interrupted" },
  { kind: "unauthorized", status: 401 },
  { kind: "not-found" },
  { kind: "rejected", status: 422 },
  { kind: "server-error", status: 503 },
  { kind: "unexpected", what: "template document" },
  { kind: "refused-url" },
];

describe("DocuSeal error text", () => {
  it("gives every failure a distinct code for the log that carries no detail beyond the kind and the status", () => {
    const codes = ALL.map(docusealCode);
    assert.equal(new Set(codes).size, ALL.length);
    assert.deepEqual(codes.slice(5, 9), ["docuseal-unauthorized-401", "docuseal-not-found", "docuseal-rejected-422", "docuseal-server-error-503"]);
    for (const code of codes) assert.match(code, /^docuseal-[a-z0-9-]+$/);
  });

  it("gives every failure a plain message, and names the variables when signing is not configured", () => {
    for (const error of ALL) assert.ok(describeDocusealError(error).length > 20, error.kind);
    assert.match(describeDocusealError({ kind: "not-configured" }), /DocuSeal address/);
    assert.match(describeDocusealError({ kind: "not-configured" }), /API token/);
    assert.match(describeDocusealError({ kind: "unauthorized", status: 403 }), /DocuSeal API token/);
    assert.match(describeDocusealError({ kind: "unreachable", reason: "network" }), /DocuSeal address/);
    assert.match(describeDocusealError({ kind: "rejected", status: 422 }), /422/);
    assert.match(describeDocusealError({ kind: "server-error", status: 503 }), /503/);
  });

  it("does not echo anything from an answer", () => {
    assert.doesNotMatch(describeDocusealError({ kind: "unexpected", what: "<script>" }), /script/);
  });
});
