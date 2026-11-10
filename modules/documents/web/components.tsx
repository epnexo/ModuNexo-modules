import Link from "next/link";
import type { ReactNode } from "react";
import type { MarkerGroups } from "../src/markers.ts";
import type { DocumentRow } from "./queries.ts";
import { documentKpis, formatCreated, statusBadge } from "./registry.ts";

export function Notice({ title, children, tone = "warn" }: { title: string; children?: ReactNode; tone?: "warn" | "error" | "ok" }) {
  return (
    <div className={tone === "error" ? "notice notice-error" : tone === "ok" ? "notice notice-success" : "notice"} role={tone === "error" ? "alert" : "status"}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** A titled box of the page: the platform's card with a heading above its content. */
export function Portlet({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card flex flex-col gap-3" aria-label={title}>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div>{children}</div>
    </section>
  );
}

function Kpis({ rows }: { rows: DocumentRow[] }) {
  return (
    <dl className="stats" aria-label="Headline numbers">
      {documentKpis(rows).map((card) => (
        <div key={card.label} className="stat">
          <dt className="stat-label">{card.label}</dt>
          <dd className="stat-value tabular-nums">{card.value}</dd>
          <dd className="stat-sub">{card.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

function DocumentsTable({ rows }: { rows: DocumentRow[] }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Reference</th>
            <th>Title</th>
            <th>Counterparty</th>
            <th>Template</th>
            <th>Status</th>
            <th>Created (UTC)</th>
            <th>PDF</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const badge = statusBadge(row.status);
            return (
              <tr key={row.ref}>
                <td className="tabular-nums">
                  <Link href={`/documents/${row.id}`}>{row.ref}</Link>
                </td>
                <td>{row.title}</td>
                <td>{row.counterpartyName}</td>
                <td>{row.templateName}</td>
                <td>
                  <span className={badge.className}>{badge.label}</span>
                </td>
                <td className="tabular-nums" style={{ whiteSpace: "nowrap" }}>
                  {formatCreated(row.createdAt)}
                </td>
                <td>
                  {row.hasPdf ? (
                    <a href={`/documents/${row.id}/pdf?inline=1`} target="_blank" rel="noopener noreferrer" aria-label={`Preview ${row.ref} (opens in a new tab)`}>
                      Preview
                    </a>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The KPI row and the registry portlet, for the rows as read (newest first). */
export function RegistryBody({ rows }: { rows: DocumentRow[] }) {
  return (
    <>
      <Kpis rows={rows} />
      <Portlet title="Documents">
        {rows.length === 0 ? (
          <p className="text-muted" style={{ margin: 0 }}>
            No documents yet. <Link href="/documents/new">Create the first one</Link>.
          </p>
        ) : (
          <DocumentsTable rows={rows} />
        )}
      </Portlet>
    </>
  );
}

function ChipList({ names }: { names: string[] }) {
  return names.length === 0 ? (
    <p className="text-muted" style={{ margin: 0 }}>
      None.
    </p>
  ) : (
    <ul className="dc-chips">
      {names.map((name) => (
        <li key={name} className="dc-chip">
          {name}
        </li>
      ))}
    </ul>
  );
}

/** The markers of a saved template body in the two groups, as names only: the body itself is never rendered as HTML. */
export function MarkerPanel({ groups, malformed }: { groups: MarkerGroups; malformed: string[] }) {
  const none = groups.fromProfile.length === 0 && groups.perDocument.length === 0;
  return (
    <div style={{ display: "grid", gap: "var(--card-gap)" }}>
      <p className="mb-3 text-sm text-muted" style={{ margin: 0 }}>
        Based on the saved body. A marker is written {"{{NAME}}"}, in capitals, digits and underscores. {"{{REF}}"} is filled by the platform with the document number.
      </p>
      {none ? (
        <p className="text-muted" style={{ margin: 0 }}>
          No markers in the saved body.
        </p>
      ) : (
        <>
          <section>
            <h3>Filled from the profile ({groups.fromProfile.length})</h3>
            <ChipList names={groups.fromProfile} />
          </section>
          <section>
            <h3>Asked for each document ({groups.perDocument.length})</h3>
            <ChipList names={groups.perDocument} />
          </section>
        </>
      )}
      {malformed.length > 0 ? (
        <Notice title="These groups are not valid markers and stay as written">
          {malformed.map((group, index) => (
            <code key={group} style={{ marginRight: index < malformed.length - 1 ? 8 : 0 }}>
              {group}
            </code>
          ))}
        </Notice>
      ) : null}
    </div>
  );
}
