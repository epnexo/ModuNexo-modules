import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hoursInput, loadHours, loadSettings, saveSettings, settingsInput } from "../../agenda/lib/settings.ts";
import agenda from "../../agenda/manifest.ts";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";

const MODULE_DIR = fileURLToPath(new URL("../../agenda/", import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  const registry = new Registry();
  registry.registerCore();
  registry.register(agenda);
  await migrate(pool, registry, { moduleDirs: { agenda: MODULE_DIR } });
  await pool.query("insert into core.modules (id, state, installed_version) values ('agenda', 'enabled', $1)", [agenda.version]);
  registerModuleRuntime(pool, { current: registry });
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

const form = (over: Record<string, string> = {}): Record<string, string> => ({ timezone: "America/Bogota", slotMinutes: "45", bufferMinutes: "15", horizonDays: "21", d1_start: "08:00", d1_end: "12:00", d2_start: "13:00", d2_end: "18:30", ...over });
const checked = (raw: Record<string, string>) => {
  const out = settingsInput(raw);
  assert.ok(out.ok, JSON.stringify(out));
  return out.value;
};

describe("the agenda starts configured", { concurrency: false }, () => {
  it("in UTC, 30-minute slots, no buffer, 14 days ahead, Monday to Friday from 09:00 to 17:00", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.deepEqual(await loadSettings(), { timezone: "UTC", slotMinutes: 30, bufferMinutes: 0, horizonDays: 14 });
    assert.deepEqual(await loadHours(), [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })));
  });
});

describe("settingsInput", () => {
  it("reads the form: zone, numbers, and a window per weekday, a blank pair meaning closed", () => {
    const value = checked(form());
    assert.deepEqual(value.settings, { timezone: "America/Bogota", slotMinutes: 45, bufferMinutes: 15, horizonDays: 21 });
    assert.deepEqual(value.hours, [{ weekday: 1, startMinute: 480, endMinute: 720 }, { weekday: 2, startMinute: 780, endMinute: 1110 }]);
  });

  it("accepts 24:00 as the end of the day and a day with no window", () => {
    assert.deepEqual(checked(form({ d1_start: "00:00", d1_end: "24:00", d2_start: "", d2_end: "" })).hours, [{ weekday: 1, startMinute: 0, endMinute: 1440 }]);
    assert.deepEqual(checked(form({ d1_start: "", d1_end: "", d2_start: "", d2_end: "" })).hours, []);
  });

  it("refuses what it cannot use and names the field", () => {
    const bad: [string, Record<string, string>][] = [
      ["timezone", { timezone: "Mars/Base" }],
      ["timezone", { timezone: "" }],
      ["slotMinutes", { slotMinutes: "4" }],
      ["slotMinutes", { slotMinutes: "481" }],
      ["slotMinutes", { slotMinutes: "ten" }],
      ["bufferMinutes", { bufferMinutes: "-1" }],
      ["bufferMinutes", { bufferMinutes: "241" }],
      ["horizonDays", { horizonDays: "0" }],
      ["horizonDays", { horizonDays: "91" }],
      ["d1_start", { d1_start: "8:00" }],
      ["d1_end", { d1_end: "25:00" }],
      ["d1_end", { d1_end: "" }],
      ["d1_start", { d1_start: "", d1_end: "12:00" }],
      ["d1_end", { d1_start: "12:00", d1_end: "12:00" }],
      ["d1_end", { d1_start: "12:00", d1_end: "09:00" }],
    ];
    for (const [field, over] of bad) {
      const out = settingsInput(form(over));
      assert.equal(out.ok, false, JSON.stringify(over));
      if (!out.ok) assert.match(out.error, new RegExp(`"${field}"`), JSON.stringify(over));
    }
  });
});

describe("hoursInput", () => {
  it("refuses two windows that overlap on the same day and accepts ones that touch", () => {
    assert.equal(hoursInput([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 700, endMinute: 900 }]).ok, false);
    assert.equal(hoursInput([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 720, endMinute: 900 }]).ok, true);
    assert.equal(hoursInput([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 2, startMinute: 600, endMinute: 900 }]).ok, true);
  });
});

describe("saveSettings", { concurrency: false }, () => {
  it("replaces the settings and every window in one write", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const value = checked(form());
    await saveSettings(value.settings, value.hours);
    assert.deepEqual(await loadSettings(), value.settings);
    assert.deepEqual(await loadHours(), value.hours);
  });

  it("changes nothing when a window cannot be stored", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const before = { settings: await loadSettings(), hours: await loadHours() };
    await assert.rejects(saveSettings({ timezone: "UTC", slotMinutes: 10, bufferMinutes: 0, horizonDays: 7 }, [{ weekday: 1, startMinute: 600, endMinute: 600 }]));
    assert.deepEqual({ settings: await loadSettings(), hours: await loadHours() }, before);
  });
});
