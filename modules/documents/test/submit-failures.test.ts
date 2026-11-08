import assert from "node:assert/strict";
import { printed } from "./helpers/printed.ts";
import { describe, it } from "node:test";
import { submitNewDocumentWith } from "../web/submit-document.ts";
import { submitArchive, submitNewTemplate, submitProfile, submitTemplateUpdate } from "../web/submit.ts";

/** Database failures with an in-memory stub, so they run whether or not a test database is reachable. */

const failing = { query: async () => Promise.reject(Object.assign(new Error("connect failed postgres://u:hunter2@db.internal/x"), { code: "ECONNREFUSED" })) };
const form = (extra: Record<string, string> = {}) => ({ name: "Mutual NDA", slug: "nda", kind: "nda", refPrefix: "NDA", bodyHtml: "<p>{{B_NOMBRE}}</p>", ...extra });

describe("submit services when the database fails", () => {
  it("submitNewTemplate answers with a safe message and keeps the values", async (t) => {
    t.mock.method(console, "error", () => {});
    const outcome = await submitNewTemplate(failing, form());
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.match(outcome.state.message!, /unreachable/);
    assert.doesNotMatch(JSON.stringify(outcome), /hunter2|db\.internal/);
    assert.equal(outcome.state.values.name, "Mutual NDA");
  });

  it("submitTemplateUpdate answers with a safe message", async (t) => {
    t.mock.method(console, "error", () => {});
    const outcome = await submitTemplateUpdate(failing, { ...form(), id: "1" });
    assert.ok("state" in outcome);
    if ("state" in outcome) assert.match(outcome.state.message!, /unreachable/);
  });

  it("submitArchive answers with a safe message", async (t) => {
    t.mock.method(console, "error", () => {});
    const outcome = await submitArchive(failing, { id: "1" });
    assert.ok("state" in outcome);
    if ("state" in outcome) assert.match(outcome.state.message!, /unreachable/);
  });

  it("submitProfile answers with a safe message and keeps the values", async (t) => {
    t.mock.method(console, "error", () => {});
    const state = await submitProfile(failing, { A_NOMBRE: "Acme Ltd", A_EMAIL: "legal@acme.test", COLOR: "#2563EB" });
    assert.match(state.message!, /unreachable/);
    assert.equal(state.values.A_NOMBRE, "Acme Ltd");
    assert.doesNotMatch(JSON.stringify(state), /hunter2/);
  });
});

describe("submitNewDocumentWith: setting up the engine, the pool and the folder", () => {
  const typed = { templateId: "1", B_NOMBRE: "Beta", FECHA: "hoy" };

  it("answers with a message on the form, keeps what was typed and logs only the error name, when setting up throws", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const outcome = await submitNewDocumentWith(() => {
      throw new TypeError("cwd /srv/secret-path is gone");
    }, typed);
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.match(outcome.state.message!, /not set up|server log/i);
    assert.equal(outcome.state.values.B_NOMBRE, "Beta");
    assert.equal(outcome.state.values.templateId, undefined);
    assert.doesNotMatch(JSON.stringify(outcome) + printed(logged), /secret-path/);
    assert.match(printed(logged), /TypeError/);
  });

  it("names the database setting when the pool cannot be built for lack of DATABASE_URL", async (t) => {
    t.mock.method(console, "error", () => {});
    const outcome = await submitNewDocumentWith(() => {
      throw new Error("DATABASE_URL is not set");
    }, typed);
    assert.ok("state" in outcome);
    if ("state" in outcome) assert.match(outcome.state.message!, /DATABASE_URL/);
  });

  it("carries on with the dependencies it was given when setting up works", async (t) => {
    t.mock.method(console, "error", () => {});
    const down = { query: async () => Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), connect: async () => Promise.reject(new Error("down")) };
    const outcome = await submitNewDocumentWith(() => ({ db: down, engine: { render: async () => ({ ok: false as const, reason: "timeout" as const }) }, dir: "/nowhere" }), typed);
    assert.ok("state" in outcome);
    if ("state" in outcome) assert.match(outcome.state.message!, /unreachable/);
  });
});
