import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inTransaction } from "../src/transaction.ts";

/** A fake pool that records the statements and how its connection was released. */
function fakePool(failOn?: string) {
  const log: string[] = [];
  const released: unknown[] = [];
  const client = {
    query: async (text: string) => {
      log.push(text);
      if (text === failOn) throw new Error(`${text} failed`);
      return { rows: [] };
    },
    release: (error?: Error | boolean) => void released.push(error),
  };
  return { db: { query: async () => ({ rows: [] }), connect: async () => client }, log, released };
}

describe("inTransaction", () => {
  it("begins, runs the work on the one connection, commits and releases it", async () => {
    const { db, log, released } = fakePool();
    const result = await inTransaction(db, async (tx) => (await tx.query("work"), "done"));
    assert.equal(result, "done");
    assert.deepEqual(log, ["begin", "work", "commit"]);
    assert.deepEqual(released, [false]);
  });

  it("rolls back and rethrows when the work fails", async () => {
    const { db, log, released } = fakePool();
    await assert.rejects(inTransaction(db, async () => Promise.reject(new Error("boom"))), /boom/);
    assert.deepEqual(log, ["begin", "rollback"]);
    assert.deepEqual(released, [false]);
  });

  it("rolls back when the commit fails", async () => {
    const { db, log } = fakePool("commit");
    await assert.rejects(inTransaction(db, async () => 1), /commit failed/);
    assert.deepEqual(log, ["begin", "commit", "rollback"]);
  });

  it("releases the connection as broken when the rollback itself fails, and still rethrows the first error", async () => {
    const { db, released } = fakePool("rollback");
    await assert.rejects(inTransaction(db, async () => Promise.reject(new Error("first"))), /first/);
    assert.deepEqual(released, [true]);
  });
});
