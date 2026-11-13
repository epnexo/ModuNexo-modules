import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRule } from "../../modules/observability/lib/rules.ts";

const base = { name: " Low disk ", kind: "metric", metric: "diskUsedPercent", operator: ">", threshold: "85", forMinutes: "15", severity: "critical", host: " pi ", enabled: "on" };

describe("parseRule", () => {
  it("reads a metric rule from form fields, trimming text and mapping the checkbox", () => {
    assert.deepEqual(parseRule(base), { ok: true, value: { name: "Low disk", kind: "metric", metric: "diskUsedPercent", operator: ">", threshold: 85, forMinutes: 15, severity: "critical", host: "pi", enabled: true } });
    const unchecked = parseRule({ ...base, host: "", enabled: undefined as unknown as string });
    assert.deepEqual(unchecked.ok && [unchecked.value.host, unchecked.value.enabled], [null, false]);
  });

  it("fixes the metric, operator and duration of a no-data rule", () => {
    assert.deepEqual(parseRule({ name: "Offline", kind: "offline", threshold: "5", metric: "ignored", operator: "<", forMinutes: "30" }), { ok: true, value: { name: "Offline", kind: "offline", metric: null, operator: ">", threshold: 5, forMinutes: 0, severity: "warning", host: null, enabled: false } });
  });

  it("refuses what the evaluator could not run", () => {
    const refused = (fields: Record<string, string>) => { const result = parseRule({ ...base, ...fields }); return result.ok ? "accepted" : result.error; };
    assert.match(refused({ name: " " }), /name/);
    assert.match(refused({ name: "x".repeat(81) }), /name/);
    assert.match(refused({ kind: "other" }), /kind/);
    assert.match(refused({ severity: "info" }), /severity/);
    assert.match(refused({ threshold: "" }), /threshold/);
    assert.match(refused({ threshold: "abc" }), /threshold/);
    assert.match(refused({ metric: "Disk Used" }), /metric/);
    assert.match(refused({ operator: "=" }), /operator/);
    assert.match(refused({ forMinutes: "1.5" }), /duration/);
    assert.match(refused({ forMinutes: "1441" }), /duration/);
    assert.match(refused({ forMinutes: "-1" }), /duration/);
    assert.match(refused({ host: "h".repeat(81) }), /host/);
    assert.match(parseRule({ name: "o", kind: "offline", threshold: "0" }).ok ? "accepted" : "minutes", /minutes/);
  });
});
