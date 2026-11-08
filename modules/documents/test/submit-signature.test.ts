import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RefreshDeps, RefreshResult } from "../src/refresh-signature.ts";
import type { SendDeps, SendResult } from "../src/send-signature.ts";
import { printed } from "./helpers/printed.ts";
import { refreshNavigation, submitClearSendWith, submitRefreshWith, submitSendWith } from "../web/submit-signature.ts";

const deps = { db: {}, docuseal: null } as unknown as SendDeps & RefreshDeps;
const RAW = { documentId: "9", ownerName: "Ana", ownerEmail: "ana@acme.test", counterpartyName: "Ben", counterpartyEmail: "ben@beta.test", order: "random" };

/** A send that answers with one result and records how it was called. */
function sending(result: SendResult | Error) {
  const calls: { id: number; raw: Record<string, string | undefined> }[] = [];
  const send = async (_deps: SendDeps, id: number, raw: Record<string, string | undefined>) => {
    calls.push({ id, raw });
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, send };
}
function refreshing(result: RefreshResult | Error) {
  const calls: number[] = [];
  const refresh = async (_deps: RefreshDeps, id: number) => {
    calls.push(id);
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, refresh };
}

const message = (outcome: Awaited<ReturnType<typeof submitSendWith>>) => ("state" in outcome ? outcome.state.message : undefined);
const sendWith = (result: SendResult | Error, raw = RAW) => {
  const s = sending(result);
  return submitSendWith(() => deps, raw, s.send).then((outcome) => ({ outcome, calls: s.calls }));
};

describe("submitSendWith", () => {
  it("passes the strictly parsed document id and the form to the service, and redirects to the document after a send", async () => {
    const { outcome, calls } = await sendWith({ ok: true, submissionId: 77 });
    assert.deepEqual(outcome, { redirectTo: "/documents/9?sent=1" });
    assert.equal(calls[0]!.id, 9);
    assert.equal(calls[0]!.raw.ownerEmail, "ana@acme.test");
  });

  it("redirects to the document with a note when it was already sent", async () => {
    assert.deepEqual((await sendWith({ ok: false, kind: "already-sent" })).outcome, { redirectTo: "/documents/9?sent=already" });
  });

  it("does not call the service for a document id that is not a plain positive number", async () => {
    for (const documentId of ["abc", "", "0", "-1", "9x", "1;drop", "007", undefined]) {
      const { outcome, calls } = await sendWith({ ok: true, submissionId: 1 }, { ...RAW, documentId } as typeof RAW);
      assert.equal(calls.length, 0, String(documentId));
      assert.match(message(outcome) ?? "", /no longer exists/);
    }
  });

  it("returns the field errors and the entered values, without the document id", async () => {
    const { outcome } = await sendWith({ ok: false, kind: "invalid", errors: { ownerEmail: "Enter an email address like name@example.com." }, values: { ownerEmail: "nope", ownerName: "Ana" } });
    assert.deepEqual(outcome, { state: { values: { ownerEmail: "nope", ownerName: "Ana" }, errors: { ownerEmail: "Enter an email address like name@example.com." } } });
  });

  it("explains each outcome that is not a field error, keeping what was typed", async () => {
    const cases: [SendResult, RegExp][] = [
      [{ ok: false, kind: "not-found" }, /no longer exists/],
      [{ ok: false, kind: "wrong-status", status: "completed" }, /Only a generated document/],
      [{ ok: false, kind: "not-ready", reason: "The layout has 3 signature boxes; signing needs exactly four." }, /3 signature boxes/],
      [{ ok: false, kind: "not-configured" }, /DocuSeal address and API token/],
      [{ ok: false, kind: "not-uploaded", fileName: "NDA-2026-001-beta.pdf" }, /NDA-2026-001-beta\.pdf could not be read from the file store.*Generate the document again/],
      [{ ok: false, kind: "docuseal", step: "upload", error: { kind: "server-error", status: 503 } }, /uploading the PDF to DocuSeal.*503/],
      [{ ok: false, kind: "docuseal", step: "fields", error: { kind: "rejected", status: 422 } }, /placing the signature fields.*422/],
      [{ ok: false, kind: "docuseal", step: "submission", error: { kind: "unauthorized", status: 401 } }, /creating the signature request.*DocuSeal API token/],
      [{ ok: false, kind: "docuseal", step: "find", error: { kind: "unreachable", reason: "network" } }, /looking for the template.*DocuSeal address/],
      [{ ok: false, kind: "unrecorded", submissionId: 77 }, /submission 77.*could not save.*Do not send it again/],
      [{ ok: false, kind: "unfinished" }, /running, or an earlier one did not finish/],
      [{ ok: false, kind: "outcome-unknown", error: { kind: "outcome-unknown", reason: "timeout" } }, /did not confirm.*may have created.*Do not send again yet/],
    ];
    for (const [result, pattern] of cases) {
      const { outcome } = await sendWith(result);
      assert.match(message(outcome) ?? "", pattern, JSON.stringify(result));
      assert.deepEqual("state" in outcome ? outcome.state.values : null, { ownerName: "Ana", ownerEmail: "ana@acme.test", counterpartyName: "Ben", counterpartyEmail: "ben@beta.test", order: "random" });
    }
  });

  it("answers on the form, logging only the code, when the service throws", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const { outcome } = await sendWith(Object.assign(new Error("connect failed postgres://u:hunter2@db/x ana@acme.test"), { code: "ECONNREFUSED" }));
    assert.match(message(outcome) ?? "", /unreachable/);
    assert.doesNotMatch(JSON.stringify(outcome) + printed(logged), /hunter2|ana@acme\.test.*connect/);
    assert.match(printed(logged), /ECONNREFUSED/);
  });

  it("answers on the form when the dependencies cannot be built", async (t) => {
    t.mock.method(console, "error", () => {});
    const outcome = await submitSendWith(
      () => {
        throw new Error("DATABASE_URL is not set");
      },
      RAW,
      sending({ ok: true, submissionId: 1 }).send,
    );
    assert.ok("state" in outcome && outcome.state.message);
    assert.equal("state" in outcome && outcome.state.values.ownerName, "Ana");
  });
});

describe("submitClearSendWith", () => {
  const clear = (result: "cleared" | "nothing-to-clear" | { result: "too-early"; waitMs: number } | Error, raw: Record<string, string | undefined> = { documentId: "9" }) => {
    const calls: number[] = [];
    const run = async (_db: unknown, id: number) => {
      calls.push(id);
      if (result instanceof Error) throw result;
      return result;
    };
    return submitClearSendWith(() => ({ db: {} as never }), raw, run).then((outcome) => ({ outcome, calls }));
  };

  it("clears the mark of the strictly parsed document id and redirects to the page with a confirmation", async () => {
    const { outcome, calls } = await clear("cleared");
    assert.deepEqual(outcome, { redirectTo: "/documents/9?sent=cleared" });
    assert.deepEqual(calls, [9]);
  });

  it("refuses a clear while the send may still be running and says, in whole minutes rounded up, when it becomes available", async () => {
    for (const [waitMs, minutes] of [[1, 1], [60_000, 1], [60_001, 2], [8 * 60_000 + 30_000, 9]] as const) {
      const { outcome } = await clear({ result: "too-early", waitMs });
      assert.ok("state" in outcome);
      assert.equal(outcome.state.message, `The send may still be running, so it cannot be cleared yet. Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}; the page will show the same notice until then.`);
    }
  });

  it("says there was nothing to clear, and does not call the service for a bad id", async () => {
    const { outcome } = await clear("nothing-to-clear");
    assert.ok("state" in outcome && /no unfinished send/i.test(outcome.state.message ?? ""));
    for (const documentId of ["abc", "", "0", "9x", undefined]) {
      const { outcome: bad, calls } = await clear("cleared", { documentId });
      assert.equal(calls.length, 0, String(documentId));
      assert.ok("state" in bad && /no longer exists/.test(bad.state.message ?? ""));
    }
  });

  it("answers on the form, logging only the code, when the database fails", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const { outcome } = await clear(Object.assign(new Error("connect failed postgres://u:hunter2@db/x"), { code: "ECONNREFUSED" }));
    assert.match(("state" in outcome && outcome.state.message) || "", /unreachable/);
    assert.doesNotMatch(printed(logged), /hunter2/);
    assert.match(printed(logged), /ECONNREFUSED/);
  });
});

describe("submitRefreshWith", () => {
  const refreshWith = async (result: RefreshResult | Error, raw: Record<string, string | undefined> = { documentId: "9" }) => {
    const r = refreshing(result);
    const state = await submitRefreshWith(() => deps, raw, r.refresh);
    return { state, calls: r.calls };
  };

  it("confirms an update and a status that stayed", async () => {
    assert.deepEqual((await refreshWith({ ok: true, outcome: "updated", status: "completed", signersChanged: true })).state, { done: "Status updated: the document is completed.", moved: "completed" });
    assert.deepEqual((await refreshWith({ ok: true, outcome: "unchanged", status: "sent", signersChanged: false })).state, { done: "Still waiting for signatures." });
  });

  it("says when signer progress changed although the document is still waiting", async () => {
    assert.deepEqual((await refreshWith({ ok: true, outcome: "unchanged", status: "sent", signersChanged: true })).state, { done: "Signer progress updated. Still waiting for signatures." });
  });

  it("marks a refresh that moved the document out of sent, so the action can show the confirmation on the page and not on a form that is about to disappear", async () => {
    for (const status of ["completed", "declined", "expired"] as const) {
      assert.equal((await refreshWith({ ok: true, outcome: "updated", status, signersChanged: false })).state.moved, status);
    }
    assert.equal((await refreshWith({ ok: true, outcome: "unchanged", status: "sent", signersChanged: true })).state.moved, undefined);
  });

  it("shows a note, with the reported status, when DocuSeal reports one the platform does not know", async () => {
    const { state } = await refreshWith({ ok: true, outcome: "unknown", reported: "archived" });
    assert.match(state.note ?? "", /"archived".*does not know.*not changed/);
    assert.equal(state.done, undefined);
  });

  it("explains each failure", async () => {
    const cases: [RefreshResult, RegExp][] = [
      [{ ok: false, kind: "not-configured" }, /DocuSeal address/],
      [{ ok: false, kind: "not-found" }, /no longer exists/],
      [{ ok: false, kind: "not-sent", status: "completed" }, /not waiting for signatures/],
      [{ ok: false, kind: "docuseal", error: { kind: "server-error", status: 503 } }, /503/],
      [{ ok: false, kind: "stale" }, /changed while.*Reload/],
    ];
    for (const [result, pattern] of cases) assert.match((await refreshWith(result)).state.message ?? "", pattern, JSON.stringify(result));
  });

  it("does not call the service for a bad document id, and answers on the form when the service throws", async (t) => {
    t.mock.method(console, "error", () => {});
    for (const id of ["abc", "", "0", "9x", undefined]) {
      const { state, calls } = await refreshWith({ ok: true, outcome: "unchanged", status: "sent", signersChanged: false }, { documentId: id });
      assert.equal(calls.length, 0, String(id));
      assert.match(state.message ?? "", /no longer exists/);
    }
    assert.match((await refreshWith(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).state.message ?? "", /unreachable/);
  });
});

describe("refreshNavigation", () => {
  it("revalidates the page before it redirects when the document left sent", () => {
    assert.deepEqual(refreshNavigation(9, { done: "x", moved: "completed" }), { revalidate: "/documents/9", redirectTo: "/documents/9?refreshed=completed" });
  });

  it("revalidates and stays when the refresh wrote something, and does nothing for an error or a bad id", () => {
    assert.deepEqual(refreshNavigation(9, { done: "Still waiting for signatures." }), { revalidate: "/documents/9", redirectTo: null });
    assert.deepEqual(refreshNavigation(9, { message: "failed" }), { revalidate: null, redirectTo: null });
    assert.deepEqual(refreshNavigation(null, { done: "x", moved: "declined" }), { revalidate: null, redirectTo: null });
  });
});
