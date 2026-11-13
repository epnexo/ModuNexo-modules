import assert from "node:assert/strict";
import { describe, it } from "node:test";
import manifest from "../../modules/observability/manifest.ts";

describe("the observability manifest", () => {
  it("owns its schema and exposes the scoped collector heartbeat", () => {
    assert.equal(manifest.id, "observability");
    assert.equal(manifest.schema, "observability");
    assert.deepEqual(manifest.permissions?.map((permission) => permission.key), ["observability.read", "observability.admin"]);
    assert.deepEqual(manifest.scopes, [{ key: "collectors.write", label: "Send collector telemetry" }]);
    assert.equal(manifest.settings?.find((setting) => setting.key === "collector_ca")?.type, "secret");
    assert.deepEqual(manifest.pages?.find((page) => page.path === "/svc/observability/heartbeat"), {
      path: "/svc/observability/heartbeat",
      entry: "./web/heartbeat.ts",
      kind: "route",
      methods: ["POST"],
      scope: "collectors.write",
    });
  });
  it("evaluates alerts every minute and delivers its own alert event through a retried job", () => {
    assert.deepEqual(manifest.events, [{ name: "alert" }]);
    assert.deepEqual(manifest.subscriptions, [{ event: "observability.alert", job: "notify" }]);
    assert.equal(manifest.jobs?.find((job) => job.name === "evaluate")?.every, "1m");
    assert.equal(manifest.jobs?.find((job) => job.name === "notify")?.every, undefined);
    assert.deepEqual(manifest.settings?.filter((setting) => setting.key.startsWith("alert_webhook")).map((setting) => setting.type), ["string", "secret"]);
  });
});
