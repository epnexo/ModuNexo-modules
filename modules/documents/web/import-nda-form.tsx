import { Notice } from "./components.tsx";

/** What the import form left in the address. Only these codes are read; anything else shows nothing. */
export interface ImportResult {
  imported?: string | undefined;
  profile?: string | undefined;
  error?: string | undefined;
}

const IMPORT_ERRORS: Record<string, string> = {
  "missing-files": "Choose the three files of the bundle: the template (.html), the config (.json) and the script (.py).",
  "too-large": "One of the files is too large to be part of the skill.",
  "invalid-files": "The files could not be read as a template bundle. Check that these are the bundle's own files.",
  failed: "The template could not be imported. Details are in the platform logs.",
};

export function importNotice(result: ImportResult) {
  if (result.error !== undefined && Object.hasOwn(IMPORT_ERRORS, result.error)) return <Notice title="Template not imported" tone="error">{IMPORT_ERRORS[result.error]}</Notice>;
  const added = Number(result.profile);
  const keys = Number.isInteger(added) && added > 0 ? ` ${added} profile ${added === 1 ? "field was" : "fields were"} added.` : "";
  if (result.imported === "created") return <Notice title="Template imported" tone="ok">The template was created.{keys}</Notice>;
  if (result.imported === "unchanged") return <Notice title="Nothing to import" tone="ok">The template already exists and was left as it is.{keys}</Notice>;
  return null;
}

/** The skill's own files are uploaded: the platform has no skill folder, and they hold the owner's details, so they never live in the module. */
export function ImportNda() {
  return (
    <details className="dc-details">
      <summary>Import a ready-made template bundle (also fills your profile)</summary>
      <form method="post" action="/documents/templates/import-nda" encType="multipart/form-data" className="form" style={{ marginTop: "0.75rem" }}>
        <p className="mb-3 text-sm text-muted">
          Pick the three files of a template bundle, for example the <code>/nda</code> skill: the template (<code>.html</code>), <code>config.json</code> and the script (<code>.py</code>). They create the template and fill your profile. Nothing that already exists is overwritten.
        </p>
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor="imp-template">Template (.html)</label>
            <input id="imp-template" className="input dc-file" type="file" name="template" accept=".html,text/html" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="imp-config">Config (.json)</label>
            <input id="imp-config" className="input dc-file" type="file" name="config" accept=".json,application/json" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="imp-script">Script (.py)</label>
            <input id="imp-script" className="input dc-file" type="file" name="script" accept=".py,text/x-python" required />
          </div>
        </div>
        <div className="form-actions">
          <button className="btn" type="submit">Import template</button>
        </div>
      </form>
    </details>
  );
}
