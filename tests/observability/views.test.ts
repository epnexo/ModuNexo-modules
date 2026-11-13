import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AlertRow, FleetRow, RuleRow } from "../../modules/observability/lib/queries.ts";
import AlertsView from "../../modules/observability/web/alerts-view.tsx";
import FleetView from "../../modules/observability/web/fleet-view.tsx";
import HostView from "../../modules/observability/web/host-view.tsx";
import RulesView from "../../modules/observability/web/rules-view.tsx";

const render = <P extends object>(component: ComponentType<P>, props: P): string => renderToStaticMarkup(createElement(component, props));
const now = Date.UTC(2026, 10, 13, 12, 0);
const host = (fields: Partial<FleetRow> & { hostName: string }): FleetRow => ({ id: 1, version: "1.0.0", lastSampleAt: new Date(now - 60_000), status: "online", metrics: {}, firing: 0, ...fields });
const alert = (fields: Partial<AlertRow> = {}): AlertRow => ({ id: 1, state: "firing", severity: "critical", startedAt: new Date(now - 600_000), resolvedAt: null, value: 91, rule: "Low disk space", kind: "metric", metric: "diskUsedPercent", operator: ">", threshold: 85, host: "pi", ...fields });
const rule = (fields: Partial<RuleRow> = {}): RuleRow => ({ id: 1, name: "Low disk space", kind: "metric", metric: "diskUsedPercent", operator: ">", threshold: 85, forMinutes: 15, severity: "warning", host: null, enabled: true, ...fields });

describe("the fleet view", () => {
  const fleet = [
    host({ id: 1, hostName: "pi", metrics: { cpuPercent: 12, memUsedPercent: 41, diskUsedPercent: 91, tempCelsius: 52, load1: 0.3, uptimeSeconds: 90_000 }, firing: 1 }),
    host({ id: 2, hostName: "vps-home", status: "offline", lastSampleAt: null }),
  ];

  it("summarises the fleet and links each host", () => {
    const html = render(FleetView, { fleet, now });
    assert.match(html, /Hosts online<\/dt><dd class="stat-value">1 \/ 2/);
    assert.match(html, /Alerts firing<\/dt><dd class="stat-value">1</);
    assert.match(html, /Fullest disk<\/dt><dd class="stat-value">91%/);
    assert.match(html, /href="\/observability\/collector\/vps-home"/);
    assert.match(html, /badge badge-success">Online/);
    assert.match(html, /badge badge-danger">Offline/);
    assert.match(html, /1 alert is firing/);
    assert.match(html, /data-tone="warning" style="width:91%"/);
  });

  it("explains an empty fleet", () => {
    assert.match(render(FleetView, { fleet: [], now }), /No hosts have reported yet/);
  });
});

describe("the host view", () => {
  const props = { host: host({ hostName: "pi", metrics: { cpuPercent: 12 } }), range: "24h" as const, firing: [], history: [alert({ state: "resolved", resolvedAt: new Date(now - 60_000) })], events: [], now };

  it("draws one chart per metric, marks the open range and lists the host's alerts", () => {
    const series = [{ metric: "cpuPercent", points: [{ t: now - 600_000, avg: 10, min: 8, max: 12 }, { t: now - 300_000, avg: 14, min: 12, max: 16 }] }];
    const html = render(HostView, { ...props, series });
    assert.match(html, /aria-label="CPU, latest 14%/);
    assert.match(html, /<a href="\?range=24h" aria-current="page">24 hours<\/a>/);
    assert.match(html, /<a href="\?range=7d">7 days<\/a>/);
    assert.match(html, /Resolved/);
  });

  it("says so when a chart has no data in the window", () => {
    assert.match(render(HostView, { ...props, series: [{ metric: "cpuPercent", points: [] }] }), /No data for cpu in this window/);
  });
});

describe("the alerts and rules views", () => {
  it("separates firing alerts from history and shows the rules read-only", () => {
    const html = render(AlertsView, { firing: [alert()], history: [alert(), alert({ id: 2, state: "resolved", resolvedAt: new Date(now) })], rules: [rule(), rule({ id: 2, name: "Off", enabled: false })] });
    assert.match(html, /Firing now<\/dt><dd class="stat-value">1</);
    assert.match(html, /Rules enabled<\/dt><dd class="stat-value">1 \/ 2/);
    assert.match(html, /Disk &gt; 85% for 15 min/);
    assert.match(html, /Recent history/);
    assert.match(html, /href="\/observability\/rules"/);
  });

  it("says nothing is firing when it is not", () => {
    assert.match(render(AlertsView, { firing: [], history: [], rules: [] }), /Nothing is firing/);
  });

  it("gives each rule its own form posting to the save route, plus one to add", () => {
    const html = render(RulesView, { rules: [rule(), rule({ id: 2, name: "High CPU", enabled: false })] });
    assert.equal((html.match(/action="\/observability\/rules\/save"/g) ?? []).length, 3);
    assert.match(html, /name="id" value="2"/);
    assert.match(html, /Save High CPU/);
    assert.match(html, /Add rule/);
  });
});
