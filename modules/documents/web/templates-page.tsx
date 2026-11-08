import Link from "next/link";
import { listMarkers, splitMarkers } from "../src/markers.ts";
import type { Profile } from "../src/profile.ts";
import type { Template } from "../src/template-store.ts";
import { Notice, Portlet } from "./components.tsx";
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
    <div className="table-wrap">
      <table>
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
              <td className="num">{template.refPrefix}</td>
              <td className="num right">{askedPerDocument(template, data.profile)}</td>
              <td className="num" style={{ whiteSpace: "nowrap" }}>
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

/** What the Import NDA form left in the address. Only these codes are read; anything else shows nothing. */
export interface ImportResult {
  imported?: string | undefined;
  profile?: string | undefined;
  error?: string | undefined;
}

const IMPORT_ERRORS: Record<string, string> = {
  "missing-files": "Choose the three files of the skill: the NDA template, the config and the script.",
  "too-large": "One of the files is too large to be part of the skill.",
  "invalid-files": "The files could not be read as the skill's NDA. Check that these are the skill's own files.",
  failed: "The NDA could not be imported. Details are in the platform logs.",
};

export function importNotice(result: ImportResult) {
  if (result.error !== undefined && Object.hasOwn(IMPORT_ERRORS, result.error)) return <Notice title="NDA not imported" tone="error">{IMPORT_ERRORS[result.error]}</Notice>;
  const added = Number(result.profile);
  const keys = Number.isInteger(added) && added > 0 ? ` ${added} profile ${added === 1 ? "field was" : "fields were"} added.` : "";
  if (result.imported === "created") return <Notice title="NDA imported" tone="ok">The NDA template was created.{keys}</Notice>;
  if (result.imported === "unchanged") return <Notice title="Nothing to import" tone="ok">The NDA template already exists and was left as it is.{keys}</Notice>;
  return null;
}

/** The skill's own files are uploaded: the platform has no skill folder, and they hold the owner's details, so they never live in the module. */
function ImportNda() {
  return (
    <details className="details">
      <summary>Import the NDA from the /nda skill</summary>
      <form method="post" action="/documents/templates/import-nda" encType="multipart/form-data" className="form" style={{ marginTop: "0.75rem" }}>
        <p className="portlet-note">
          Pick three files from your skill folder: <code>templates/nda.html</code>, <code>config.json</code> and <code>scripts/nda.py</code>. They create the NDA template and fill your profile. Nothing that already exists is overwritten.
        </p>
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor="imp-template">NDA template (nda.html)</label>
            <input id="imp-template" className="input" type="file" name="template" accept=".html,text/html" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="imp-config">Config (config.json)</label>
            <input id="imp-config" className="input" type="file" name="config" accept=".json,application/json" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="imp-script">Script (nda.py)</label>
            <input id="imp-script" className="input" type="file" name="script" accept=".py,text/x-python" required />
          </div>
        </div>
        <div className="form-actions">
          <button className="btn" type="submit">Import NDA</button>
        </div>
      </form>
    </details>
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
        <div className="page-body">
          <Unavailable title="Templates are unavailable" error={error} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageBar title="Templates" description={DESCRIPTION} current="templates" />
      <div className="page-body">
        {importNotice(result)}
        <Portlet title="Templates">
          <div style={{ display: "grid", gap: "var(--portlet-pad)" }}>
            <div className="form-actions">
              <Link className="btn primary" href="/documents/templates/new">
                New template
              </Link>
            </div>
            {data.templates.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No templates yet.
              </p>
            ) : (
              <TemplatesTable data={data} />
            )}
            <ImportNda />
          </div>
        </Portlet>
      </div>
    </div>
  );
}
