/** What each metric the collectors send is called, how its value reads, and where it starts to worry. Unknown keys still render. */

import type { RuleKind } from "./rules.ts";

export type Unit = "percent" | "celsius" | "bytes" | "rate" | "seconds" | "number";
export type Tone = "ok" | "warning" | "danger";

interface MetricInfo {
  label: string;
  unit: Unit;
  /** Values at or above this are a warning / a problem. Only for metrics where higher is worse. */
  warn?: number;
  crit?: number;
}

export const METRICS: Record<string, MetricInfo> = {
  cpuPercent: { label: "CPU", unit: "percent", warn: 80, crit: 95 },
  memUsedPercent: { label: "Memory", unit: "percent", warn: 85, crit: 95 },
  swapUsedPercent: { label: "Swap", unit: "percent", warn: 50, crit: 80 },
  diskUsedPercent: { label: "Disk", unit: "percent", warn: 85, crit: 95 },
  tempCelsius: { label: "Temperature", unit: "celsius", warn: 70, crit: 80 },
  load1: { label: "Load (1 min)", unit: "number" },
  uptimeSeconds: { label: "Uptime", unit: "seconds" },
  memTotalBytes: { label: "Total memory", unit: "bytes" },
  memAvailableBytes: { label: "Available memory", unit: "bytes" },
  swapUsedBytes: { label: "Swap used", unit: "bytes" },
  guestsRunning: { label: "Guests running", unit: "number" },
  guestsNotBackedUp: { label: "Guests without backup", unit: "number", warn: 1 },
  up: { label: "Up", unit: "number" },
  netInBytesPerSec: { label: "Network in", unit: "rate" },
  netOutBytesPerSec: { label: "Network out", unit: "rate" },
  diskReadBytesPerSec: { label: "Disk read", unit: "rate" },
  diskWriteBytesPerSec: { label: "Disk write", unit: "rate" },
};

/** The metrics a host page draws a chart for, in this order, when the host reports them. */
export const CHART_METRICS = ["cpuPercent", "memUsedPercent", "diskUsedPercent", "swapUsedPercent", "load1", "tempCelsius", "guestsRunning", "guestsNotBackedUp"] as const;

/** The metrics a guest page draws a chart for, in this order, when the guest reports them. */
export const GUEST_CHART_METRICS = ["cpuPercent", "memUsedPercent", "diskUsedPercent", "netInBytesPerSec", "netOutBytesPerSec", "diskReadBytesPerSec", "diskWriteBytesPerSec"] as const;

export const metricLabel = (key: string): string => METRICS[key]?.label ?? key;
export const metricUnit = (key: string): Unit => METRICS[key]?.unit ?? "number";

const GIB = 1024 ** 3;

export function formatValue(unit: Unit, value: number): string {
  switch (unit) {
    case "percent": return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
    case "celsius": return `${value.toFixed(1)} °C`;
    case "bytes": return `${(value / GIB).toFixed(1)} GiB`;
    case "rate": return value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB/s` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB/s` : `${Math.round(value)} B/s`;
    case "seconds": return value >= 86_400 ? `${(value / 86_400).toFixed(1)} days` : `${(value / 3600).toFixed(1)} hours`;
    case "number": return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
}

export const formatMetric = (key: string, value: number): string => formatValue(metricUnit(key), value);

/** ok below the warning level, danger at or above the critical level, warning in between; ok for a metric with no levels. */
export function toneOf(key: string, value: number): Tone {
  const info = METRICS[key];
  if (info?.crit !== undefined && value >= info.crit) return "danger";
  if (info?.warn !== undefined && value >= info.warn) return "warning";
  return "ok";
}

/** A span of seconds as "2d 4h", "3h 5m" or "12m": the two largest units, so it stays short. */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** "just now", "5 min ago", "3 h ago" or "2 d ago" from an age in minutes; "never" for none. */
export function ago(minutes: number | null): string {
  if (minutes === null) return "never";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
}

const stamp = (date: Date): string => date.toISOString().slice(0, 16).replace("T", " ");
export const formatTime = (date: Date): string => `${stamp(date)} UTC`;

/** The label under an axis tick: the time of day for short ranges, the date for long ones. */
export const axisTime = (epochMs: number, spanMs: number): string => {
  const iso = new Date(epochMs).toISOString();
  return spanMs <= 86_400_000 ? iso.slice(11, 16) : iso.slice(5, 10);
};

/** The condition of an alert rule in words, for example "Disk > 85% for 15 min" or "no data for 5 min". */
export function describeRule(rule: { kind: RuleKind; metric: string | null; operator: ">" | "<"; threshold: number; forMinutes: number }): string {
  if (rule.kind === "offline") return `No data for more than ${rule.threshold} min`;
  if (rule.kind === "container_down") return `Container not running${rule.forMinutes > 0 ? ` for ${rule.forMinutes} min` : ""}`;
  if (rule.kind === "guest_down") return `Guest stopped${rule.forMinutes > 0 ? ` for ${rule.forMinutes} min` : ""}`;
  const key = rule.metric ?? "";
  const duration = rule.forMinutes > 0 ? ` for ${rule.forMinutes} min` : "";
  return `${metricLabel(key)} ${rule.operator} ${formatMetric(key, rule.threshold)}${duration}`;
}
