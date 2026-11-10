/** Pure helpers for the registry page: what the KPI row counts and how a status is shown. */

import type { DocumentRow, DocumentStatus } from "./queries.ts";

export interface KpiCard {
  label: string;
  value: string;
  sub: string;
}

/** Counts derived from the same rows the table shows. Declined and expired documents only count in the total. */
export function documentKpis(rows: DocumentRow[]): KpiCard[] {
  const count = (...statuses: DocumentStatus[]) => rows.filter((row) => statuses.includes(row.status)).length;
  return [
    { label: "Total", value: String(rows.length), sub: "documents in the registry" },
    { label: "Awaiting signature", value: String(count("sent")), sub: "sent, not signed yet" },
    { label: "Completed", value: String(count("completed")), sub: "signed by every party" },
    { label: "Drafts", value: String(count("draft", "generated")), sub: "not sent yet" },
  ];
}

const BADGES: Record<DocumentStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "badge" },
  generated: { label: "Generated", className: "badge" },
  sent: { label: "Sent", className: "badge badge-warning" },
  completed: { label: "Completed", className: "badge badge-success" },
  declined: { label: "Declined", className: "badge badge-danger" },
  expired: { label: "Expired", className: "badge badge-danger" },
};

const UNKNOWN_BADGE = { label: "Unknown", className: "badge" };

/** The badge of a status; a value the page does not know (a newer schema, a bad row) gets a neutral one instead of breaking the table. */
export function statusBadge(status: DocumentStatus): { label: string; className: string } {
  return Object.hasOwn(BADGES, status) ? BADGES[status] : UNKNOWN_BADGE;
}

/** `YYYY-MM-DD HH:MM` in UTC, like the other pages. */
export function formatCreated(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}
