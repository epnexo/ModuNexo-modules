import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsPage from "../../modules/observability/web/settings-page.tsx";
import observability from "../../modules/observability/manifest.ts";

describe("the collector tokens page", () => {
  const html = renderToStaticMarkup(createElement(SettingsPage));

  it("is about collector tokens and offers to create one", () => {
    assert.match(html, /<h1[^>]*>Collector tokens<\/h1>/);
    assert.match(html, /Create token/);
    assert.match(html, /collectors\.write/);
  });

  it("no longer walks through the old agent's configuration", () => {
    assert.doesNotMatch(html, /Configure the host/);
    assert.doesNotMatch(html, /systemd/);
    assert.doesNotMatch(html, /internal CA/i);
    assert.doesNotMatch(html, /modunexo-agent/);
  });

  it("keeps the route, the permission and the dashboard alert it had", () => {
    assert.equal(observability.pages?.find((page) => page.path === "/observability/settings")?.permission, "observability.admin");
    assert.ok(observability.dashboard?.alerts?.some((alert) => alert.key === "offline_collectors"));
  });
});
