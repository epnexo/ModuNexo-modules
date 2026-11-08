import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Queryable } from "../web/queries.ts";
import { updateTemplate } from "../src/template-store.ts";

const input = { name: "Mutual NDA", slug: "nda", kind: "nda" as const, refPrefix: "NDA", bodyHtml: "<p>x</p>", counterpartyMarker: null };
const rejecting = (error: unknown): Queryable => ({ query: async () => Promise.reject(error) });
const violation = (constraint: string | undefined) => Object.assign(new Error("duplicate key"), { code: "23505", ...(constraint ? { constraint } : {}) });

describe("updateTemplate: unique violations", () => {
  it("reports slug-taken when the violated constraint is the slug's", async () => {
    assert.equal(await updateTemplate(rejecting(violation("templates_slug_key")), 1, input), "slug-taken");
  });

  it("surfaces any other unique violation as an error", async () => {
    await assert.rejects(updateTemplate(rejecting(violation("templates_something_else_key")), 1, input), { code: "23505" });
    await assert.rejects(updateTemplate(rejecting(violation(undefined)), 1, input), { code: "23505" });
  });

  it("surfaces errors that are not unique violations", async () => {
    await assert.rejects(updateTemplate(rejecting(Object.assign(new Error("down"), { code: "ECONNREFUSED" })), 1, input), { code: "ECONNREFUSED" });
  });
});
