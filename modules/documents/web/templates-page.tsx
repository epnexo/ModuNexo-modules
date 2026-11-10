import Link from "next/link";
import { listMarkers, splitMarkers } from "../src/markers.ts";
import type { Profile } from "../src/profile.ts";
import type { Template } from "../src/template-store.ts";
import { Portlet } from "./components.tsx";
import { type ImportResult, importNotice } from "./import-nda-form.tsx";
import { logFailure } from "./log.ts";
import { PageBar } from "./nav.tsx";
import { Unavailable } from "./page-state.tsx";
import { formatCreated } from "./registry.ts";

export interface TemplatesPageData {
  templates: Template[];
  profile: Profile;
}

const DESCRIPTION = "Document types written as HTML with markers. Archived templates are hidden.";

const KIND_LABELS: Record<string, string> = { nda: "NDA", contract: "Contract", proposal: "Proposal", other: "Other" };

/** How many values a document made from this body has to be given, apart from the ones the profile fills. */
export function askedPerDocument(template: Template, profile: Profile): number {
  return splitMarkers(listMarkers(template.bodyHtml), profile).perDocument.length;
}

function TemplatesTable({ data }: { data: TemplatesPageData }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Prefix</th>
            <th className="right">Asked per document</th>
            <th>Updated (UTC)</th>
            <th>PDF</th>
          </tr>
        </thead>
        <tbody>
          {data.templates.map((template) => (
            <tr key={template.id}>
              <td>
                <Link href={`/documents/templates/${template.id}`}>{template.name}</Link>
              </td>
              <td>{KIND_LABELS[template.kind] ?? template.kind}</td>
              <td className="tabular-nums">{template.refPrefix}</td>
              <td className="tabular-nums right">{askedPerDocument(template, data.profile)}</td>
              <td className="tabular-nums" style={{ whiteSpace: "nowrap" }}>
                {formatCreated(template.updatedAt)}
              </td>
              <td>
                <a href={`/documents/templates/${template.id}/preview`} target="_blank" rel="noopener noreferrer" aria-label={`Preview ${template.name} (opens in a new tab)`}>
                  Preview
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The template list for whatever `load` returns, so a test can render it with a stub instead of the database. */
export async function renderTemplatesPage(load: () => Promise<TemplatesPageData>, result: ImportResult = {}) {
  let data: TemplatesPageData;
  try {
    data = await load();
  } catch (error) {
    logFailure("could not load the templates", error);
    return (
      <div>
        <PageBar title="Templates" description={DESCRIPTION} current="templates" />
        <div className="dc-page">
          <Unavailable title="Templates are unavailable" error={error} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageBar title="Templates" description={DESCRIPTION} current="templates" />
      <div className="dc-page">
        {importNotice(result)}
        <Portlet title="Templates">
          <div style={{ display: "grid", gap: "var(--portlet-pad)" }}>
            <div className="form-actions">
              <Link className="btn btn-primary" href="/documents/templates/new">
                New template
              </Link>
            </div>
            {data.templates.length === 0 ? (
              <p className="text-muted" style={{ margin: 0 }}>
                No templates yet.
              </p>
            ) : (
              <TemplatesTable data={data} />
            )}
          </div>
        </Portlet>
      </div>
    </div>
  );
}
