import Link from "next/link";
import type { ReactNode } from "react";
import type { MarkerGroups } from "../src/markers.ts";
import type { DocumentRow } from "./queries.ts";
import { documentKpis, formatCreated, statusBadge } from "./registry.ts";

export function Notice({ title, children, tone = "warn" }: { title: string; children?: ReactNode; tone?: "warn" | "error" | "ok" }) {
  return (
    <div className={`notice ${tone === "warn" ? "" : tone}`} role={tone === "error" ? "alert" : "status"}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** The shell's portlet pattern: a header band holding the heading, a body holding the content. */
export function Portlet({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="portlet" aria-label={title}>
      <header className="portlet-head">
        <h2>{title}</h2>
      </header>
      <div className="portlet-body">{children}</div>
    </section>
  );
}

function Kpis({ rows }: { rows: DocumentRow[] }) {
  return (
    <dl className="kpis" aria-label="Headline numbers">
      {documentKpis(rows).map((card, i) => (
        <div key={card.label} className={`kpi kpi-${i + 1}`}>
          <dt>{card.label}</dt>
          <dd className="kpi-value num">{card.value}</dd>
          <dd className="kpi-sub">{card.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

function DocumentsTable({ rows }: { rows: DocumentRow[] }) {
  return (
    <div className="table-wrap">
      <table>
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
                <td className="num">
                  <Link href={`/documents/${row.id}`}>{row.ref}</Link>
                </td>
                <td>{row.title}</td>
                <td>{row.counterpartyName}</td>
                <td>{row.templateName}</td>
                <td>
                  <span className={badge.className}>{badge.label}</span>
                </td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
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
          <p className="muted" style={{ margin: 0 }}>
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
    <p className="muted" style={{ margin: 0 }}>
      None.
    </p>
  ) : (
    <ul className="chips">
      {names.map((name) => (
        <li key={name} className="chip">
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
    <div style={{ display: "grid", gap: "var(--portlet-pad)" }}>
      <p className="portlet-note" style={{ margin: 0 }}>
        Based on the saved body. A marker is written {"{{NAME}}"}, in capitals, digits and underscores. {"{{REF}}"} is filled by the platform with the document number.
      </p>
      {none ? (
        <p className="muted" style={{ margin: 0 }}>
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
