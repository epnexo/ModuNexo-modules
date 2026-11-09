import { Notice } from "./components.tsx";

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
export function ImportNda() {
  return (
    <details className="details">
      <summary>NDA from the /nda skill (also fills your profile)</summary>
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
