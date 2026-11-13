import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ago, axisTime, describeRule, formatMetric, formatValue, toneOf } from "../../modules/observability/lib/format.ts";

describe("metric formatting", () => {
  it("writes each unit the way people read it", () => {
    assert.equal(formatValue("percent", 41.07), "41%");
    assert.equal(formatValue("percent", 0.246), "0.2%");
    assert.equal(formatValue("celsius", 50.82), "50.8 °C");
    assert.equal(formatValue("bytes", 17_006_837_760), "15.8 GiB");
    assert.equal(formatValue("seconds", 43_200), "12.0 hours");
    assert.equal(formatValue("seconds", 172_800), "2.0 days");
    assert.deepEqual([formatValue("number", 3), formatValue("number", 0.456)], ["3", "0.46"]);
    assert.equal(formatMetric("unknownThing", 7), "7");
  });

  it("reads a tone from the warning and critical levels of a metric", () => {
    assert.deepEqual([toneOf("diskUsedPercent", 50), toneOf("diskUsedPercent", 85), toneOf("diskUsedPercent", 95)], ["ok", "warning", "danger"]);
    assert.equal(toneOf("guestsNotBackedUp", 0), "ok");
    assert.equal(toneOf("guestsNotBackedUp", 7), "warning");
    assert.equal(toneOf("load1", 99), "ok");
  });

  it("says how long ago something happened", () => {
    assert.deepEqual([ago(null), ago(0.4), ago(5.9), ago(120), ago(3000)], ["never", "just now", "5 min ago", "2 h ago", "2 d ago"]);
  });

  it("labels the time axis with the time for short windows and the date for long ones", () => {
    const at = Date.UTC(2026, 10, 13, 9, 30);
    assert.equal(axisTime(at, 3_600_000), "09:30");
    assert.equal(axisTime(at, 7 * 86_400_000), "11-13");
  });

  it("describes a rule in words", () => {
    assert.equal(describeRule({ kind: "metric", metric: "diskUsedPercent", operator: ">", threshold: 85, forMinutes: 15 }), "Disk > 85% for 15 min");
    assert.equal(describeRule({ kind: "metric", metric: "tempCelsius", operator: ">", threshold: 80, forMinutes: 0 }), "Temperature > 80.0 °C");
    assert.equal(describeRule({ kind: "offline", metric: null, operator: ">", threshold: 5, forMinutes: 0 }), "No data for more than 5 min");
  });
});
