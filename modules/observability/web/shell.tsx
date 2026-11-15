import type { ReactNode } from "react";
import type { HostStatus } from "../lib/queries.ts";

/** The title bar every Observability page starts with. */
export function Bar({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <header className="obs-bar">
      <div>
        <h1>{title}</h1>
        {subtitle === undefined ? null : <p className="obs-sub">{subtitle}</p>}
      </div>
      {children === undefined ? null : <div className="obs-tools">{children}</div>}
    </header>
  );
}

export type Section = "fleet" | "containers" | "alerts";

/** Fleet, Containers and Alerts as a segmented control; the open one is marked with aria-current. */
export function SubNav({ current, firing }: { current: Section; firing: number }) {
  return (
    <nav className="seg" aria-label="Observability sections">
      <a href="/observability" aria-current={current === "fleet" ? "page" : undefined}>Fleet</a>
      <a href="/observability/containers" aria-current={current === "containers" ? "page" : undefined}>Containers</a>
      <a href="/observability/alerts" aria-current={current === "alerts" ? "page" : undefined}>Alerts{firing > 0 ? ` (${firing})` : ""}</a>
    </nav>
  );
}

const STATUS: Record<HostStatus, { className: string; text: string }> = {
  online: { className: "badge badge-success", text: "Online" },
  stale: { className: "badge badge-warning", text: "Delayed" },
  offline: { className: "badge badge-danger", text: "Offline" },
};

export function StatusBadge({ status }: { status: HostStatus }) {
  const { className, text } = STATUS[status];
  return <span className={className}>{text}</span>;
}

export function SeverityBadge({ severity }: { severity: "warning" | "critical" }) {
  return <span className={severity === "critical" ? "badge badge-danger" : "badge badge-warning"}>{severity === "critical" ? "Critical" : "Warning"}</span>;
}

/** Sets a platform variable on one element, for example `--stat-tone`, without writing a colour. */
export const withVar = (name: string, value: string) => ({ [name]: value }) as React.CSSProperties;
