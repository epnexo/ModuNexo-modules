import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { takeNumber } from "../src/counter-store.ts";
import { inTransaction } from "../src/transaction.ts";
import { type TestDb, openMigratedPool } from "./helpers/db.ts";

let pool: TestDb | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_numbering"));
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query("delete from documents.counters");
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

const take = (prefix: string, year: number) => inTransaction(pool!, (tx) => takeNumber(tx, prefix, year));
const last = async (prefix: string, year: number) =>
  (await pool!.query("select last_number from documents.counters where prefix = $1 and year = $2", [prefix, year])).rows[0]?.last_number as number | undefined;

describe("takeNumber", () => {
  test("starts at 1 and counts up for a prefix and year", async () => {
    assert.deepEqual([await take("NDA", 2026), await take("NDA", 2026), await take("NDA", 2026)], [1, 2, 3]);
    assert.equal(await last("NDA", 2026), 3);
  });

  test("counts each prefix and each year on its own", async () => {
    assert.equal(await take("NDA", 2026), 1);
    assert.equal(await take("CON", 2026), 1);
    assert.equal(await take("NDA", 2027), 1);
    assert.equal(await take("NDA", 2026), 2);
  });

  test("keeps counting past 999", async () => {
    await pool!.query("insert into documents.counters (prefix, year, last_number) values ('NDA', 2026, 999)");
    assert.equal(await take("NDA", 2026), 1000);
  });

  test("never gives two concurrent creations the same number, on a first number and on later ones", async () => {
    for (const round of [1, 2]) {
      const numbers = await Promise.all(Array.from({ length: 8 }, () => take("NDA", 2026)));
      assert.deepEqual([...numbers].sort((a, b) => a - b), Array.from({ length: 8 }, (_, i) => (round - 1) * 8 + i + 1), `round ${round}`);
    }
    assert.equal(await last("NDA", 2026), 16);
  });

  test("a failed creation does not consume a number", async () => {
    assert.equal(await take("NDA", 2026), 1);
    await assert.rejects(
      inTransaction(pool!, async (tx) => {
        assert.equal(await takeNumber(tx, "NDA", 2026), 2);
        throw new Error("render failed");
      }),
      /render failed/,
    );
    assert.equal(await last("NDA", 2026), 1);
    assert.equal(await take("NDA", 2026), 2);
  });

  test("a failed first creation leaves no counter row behind", async () => {
    await assert.rejects(inTransaction(pool!, async (tx) => (await takeNumber(tx, "NDA", 2026), Promise.reject(new Error("x")))), /x/);
    assert.equal(await last("NDA", 2026), undefined);
    assert.equal(await take("NDA", 2026), 1);
  });

  test("a creation waiting behind another gets the next number only after the first one decides", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const taken = new Promise<void>((resolve) => (holding = resolve));
    const first = inTransaction(pool!, async (tx) => {
      const n = await takeNumber(tx, "NDA", 2026);
      holding();
      await hold;
      return n;
    });
    let second: Promise<number> | undefined;
    try {
      await taken;
      let secondDone = false;
      second = take("NDA", 2026).then((n) => ((secondDone = true), n));
      await untilWaitingOnALock();
      assert.equal(secondDone, false, "the second creation waits for the first");
    } finally {
      release();
    }
    assert.deepEqual([await first, await second], [1, 2]);
  });
});

/** Polls the server until a backend is blocked on a lock: the signal that the second creation reached the counter row and is waiting there. */
async function untilWaitingOnALock(): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const { rows } = await pool!.query("select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()");
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the second creation never waited on the counter row");
}
