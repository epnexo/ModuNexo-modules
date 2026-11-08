import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inTransaction } from "../src/transaction.ts";

/** A fake data handle that records what `transaction` was asked to run. */
function fakeDb(failWith?: Error) {
  const statements: string[] = [];
  const tx = { query: async (text: string) => (statements.push(text), { rows: [], rowCount: 0 }) };
  const db = {
    query: async () => ({ rows: [] }),
    transaction: async <T>(run: (t: typeof tx) => Promise<T>): Promise<T> => {
      statements.push("begin");
      try {
        const done = await run(tx);
        statements.push("commit");
        return done;
      } catch (error) {
        statements.push("rollback");
        throw failWith ?? error;
      }
    },
  };
  return { db, statements };
}

describe("inTransaction", () => {
  it("runs the work on the handle the platform gives it and returns its result", async () => {
    const { db, statements } = fakeDb();
    const result = await inTransaction(db, async (tx) => (await tx.query("work"), "done"));
    assert.equal(result, "done");
    assert.deepEqual(statements, ["begin", "work", "commit"]);
  });

  it("rethrows the error of the work, after the platform rolled it back", async () => {
    const { db, statements } = fakeDb();
    await assert.rejects(inTransaction(db, async () => Promise.reject(new Error("boom"))), /boom/);
    assert.deepEqual(statements, ["begin", "rollback"]);
  });
});
