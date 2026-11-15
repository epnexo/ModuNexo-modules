import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatDuration, formatMetric } from "../../modules/observability/lib/format.ts";
import type { AlertRow, FleetRow, GuestRow, GuestSession, RuleRow } from "../../modules/observability/lib/queries.ts";
import AlertsView from "../../modules/observability/web/alerts-view.tsx";
import FleetView from "../../modules/observability/web/fleet-view.tsx";
import LiveRefresh from "../../modules/observability/web/live-refresh.tsx";
import GuestView from "../../modules/observability/web/guest-view.tsx";
import HostView from "../../modules/observability/web/host-view.tsx";
import RulesView from "../../modules/observability/web/rules-view.tsx";

const render = <P extends object>(component: ComponentType<P>, props: P): string => renderToStaticMarkup(createElement(component, props));
const now = Date.UTC(2026, 10, 13, 12, 0);
const host = (fields: Partial<FleetRow> & { hostName: string }): FleetRow => ({ id: 1, version: "1.0.0", lastSampleAt: new Date(now - 60_000), status: "online", metrics: {}, firing: 0, trend: [], ...fields });
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
    assert.match(html, /Avg<\/dt><dd[^>]*>12%/);
    assert.match(html, /Peak<\/dt><dd[^>]*>16%/);
    assert.match(html, /Low<\/dt><dd[^>]*>8.0%/);
    assert.match(html, /Change<\/dt><dd[^>]*>▲ 4.0%/);
    assert.match(html, /obs-area/);
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

const guest = (fields: Partial<GuestRow> = {}): GuestRow => ({
  id: 7, collectorId: 1, hostName: "proxmox", vmid: 101, name: "opnsense", kind: "qemu", node: "pve", running: true, backedUp: true,
  firstSeenAt: new Date(now - 30 * 86_400_000), lastSeenAt: new Date(now - 60_000), lastUpAt: new Date(now - 60_000),
  upSeconds: { "7d": 6 * 86_400, "30d": 25 * 86_400, "90d": 25 * 86_400 }, availability: { "7d": 85.7, "30d": 83.3, "90d": 83.3 }, ...fields,
});

describe("the guests on a host page", () => {
  const props = { host: host({ hostName: "proxmox" }), range: "24h" as const, firing: [], history: [], events: [], series: [], now };

  it("lists each guest with its state, availability and a link to its page", () => {
    const html = render(HostView, { ...props, guests: [guest(), guest({ id: 8, vmid: 106, name: "adguard", kind: "lxc", running: false, backedUp: false, lastUpAt: new Date(now - 3 * 3_600_000) })] });
    assert.match(html, /href="\/observability\/guest\/7"[^>]*>opnsense/);
    assert.match(html, /href="\/observability\/guest\/8"[^>]*>adguard/);
    assert.match(html, /badge badge-success">Running/);
    assert.match(html, /class="badge">Stopped/);
    assert.match(html, /83\.3%/);
    assert.match(html, /Not backed up/);
  });

  it("shows no guest section when the host has none", () => {
    assert.doesNotMatch(render(HostView, { ...props, guests: [] }), /Guests/);
  });
});

describe("the guest view", () => {
  const sessions: GuestSession[] = [{ startedAt: new Date(now - 2 * 86_400_000), endedAt: null }, { startedAt: new Date(now - 5 * 86_400_000), endedAt: new Date(now - 4 * 86_400_000) }];
  const series = [{ metric: "cpuPercent", points: [{ t: now - 600_000, avg: 10, min: 8, max: 12 }, { t: now - 300_000, avg: 14, min: 12, max: 16 }] }];
  const props = { guest: guest(), range: "24h" as const, series, sessions, now };

  it("shows who the guest is, how long it has been up, its sessions and its trends", () => {
    const html = render(GuestView, props);
    assert.match(html, /<h1>opnsense<\/h1>/);
    assert.match(html, /VM · 101/);
    assert.match(html, /href="\/observability\/collector\/proxmox"/);
    assert.match(html, /Time up/);
    assert.match(html, /6d 0h/);
    assert.match(html, /85\.7%/);
    assert.match(html, /Still running/);
    assert.match(html, /aria-label="CPU, latest 14%/);
    assert.match(html, /<a href="\?range=7d">7 days<\/a>/);
  });

  it("says when a stopped guest was last up", () => {
    const html = render(GuestView, { ...props, guest: guest({ running: false, lastUpAt: new Date(now - 3 * 3_600_000) }) });
    assert.match(html, /Last up/);
    assert.match(html, /3 h ago/);
    assert.match(html, /class="badge">Stopped/);
  });
});

describe("guest formatting", () => {
  it("writes durations compactly and rates in binary units", () => {
    assert.equal(formatDuration(0), "0m");
    assert.equal(formatDuration(59 * 60), "59m");
    assert.equal(formatDuration(3 * 3600 + 5 * 60), "3h 5m");
    assert.equal(formatDuration(2 * 86_400 + 4 * 3600), "2d 4h");
    assert.equal(formatMetric("netInBytesPerSec", 2048), "2.0 KiB/s");
    assert.equal(formatMetric("netOutBytesPerSec", 5 * 1024 ** 2), "5.0 MiB/s");
    assert.equal(formatMetric("netInBytesPerSec", 12), "12 B/s");
  });
});

describe("the live page", () => {
  it("shows a live indicator with a switch to pause the refresh", () => {
    const html = render(LiveRefresh, { intervalSeconds: 30 });
    assert.match(html, /obs-live/);
    assert.match(html, /Live/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /Refreshes every 30 s/);
  });

  it("is on the fleet, host and guest pages", () => {
    assert.match(render(FleetView, { fleet: [host({ hostName: "pi" })], now }), /obs-live/);
    assert.match(render(HostView, { host: host({ hostName: "pi" }), range: "24h", series: [], firing: [], history: [], events: [], now }), /obs-live/);
    assert.match(render(GuestView, { guest: guest(), range: "24h", series: [], sessions: [], now }), /obs-live/);
  });

  it("draws a sparkline on a host card only when it has a trend", () => {
    const withTrend = render(FleetView, { fleet: [host({ hostName: "pi", metrics: { cpuPercent: 12 }, trend: [10, 20, 30] })], now });
    assert.match(withTrend, /<svg class="obs-spark"[^>]*role="img"[^>]*aria-label="CPU, last hour"/);
    assert.match(withTrend, /<polyline points="0,/);
    assert.doesNotMatch(render(FleetView, { fleet: [host({ hostName: "pi", metrics: { cpuPercent: 12 }, trend: [] })], now }), /obs-spark/);
  });
});
