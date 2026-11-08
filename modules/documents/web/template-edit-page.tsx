import Link from "next/link";
import { notFound } from "next/navigation";
import { listMarkers, malformedMarkers, splitMarkers } from "../src/markers.ts";
import type { Profile } from "../src/profile.ts";
import { parseTemplateId, templateFormValues } from "../src/template-rules.ts";
import { variableRows } from "../src/variable-rules.ts";
import type { Template } from "../src/template-store.ts";
import { ENDPOINTS } from "./endpoints.ts";
import { MarkerPanel, Notice, Portlet } from "./components.tsx";
import { EMPTY_TEMPLATE_VALUES } from "./form-state.ts";
import { ArchiveForm, TemplateForm } from "./forms.tsx";
import { logFailure } from "./log.ts";
import { PageBar } from "./nav.tsx";
import { Unavailable } from "./page-state.tsx";

export interface TemplateEditData {
  template: Template | null;
  profile: Profile;
}

/**
 * The new-template page (`idParam` undefined) or the edit page of one template. A bad or unknown id is a 404; a
 * database failure is a notice. The saved body only ever reaches the page as the text of a textarea and as marker
 * names, never as HTML.
 */
export async function renderTemplateEditPage({
  idParam,
  saved,
  load,
}: {
  idParam: string | undefined;
  saved: boolean;
  load: (id: number) => Promise<TemplateEditData>;
}) {
  if (idParam === undefined) {
    return (
      <div>
        <PageBar title="New template" description="Write the document as HTML and mark each value to fill with {{NAME}}." current="templates" />
        <div className="page-body">
          <Portlet title="Template">
            <TemplateForm endpoint={ENDPOINTS.createTemplate} initial={{ values: EMPTY_TEMPLATE_VALUES, errors: {} }} mode="create" counterpartyOptions={[]} />
          </Portlet>
        </div>
      </div>
    );
  }

  const id = parseTemplateId(idParam);
  if (id === null) notFound();

  let data: TemplateEditData;
  try {
    data = await load(id);
  } catch (error) {
    logFailure("could not load the template", error);
    return (
      <div>
        <PageBar title="Template" current="templates" />
        <div className="page-body">
          <Unavailable title="The template is unavailable" error={error} />
        </div>
      </div>
    );
  }
  const { template, profile } = data;
  if (template === null) notFound();

  if (template.archivedAt !== null) {
    return (
      <div>
        <PageBar title={template.name} description="Archived template." current="templates" />
        <div className="page-body">
          <Notice title="This template is archived">
            It is hidden from the list and cannot be edited. <Link href="/documents/templates">Back to templates</Link>
          </Notice>
        </div>
      </div>
    );
  }

  const groups = splitMarkers(listMarkers(template.bodyHtml), profile);
  return (
    <div>
      <PageBar title={template.name} description={`Slug ${template.slug}. Numbered ${template.refPrefix}-YYYY-NNN.`} current="templates" />
      <div className="page-body">
        <Portlet title="Template">
          <TemplateForm
            endpoint={ENDPOINTS.updateTemplate}
            initial={{ values: templateFormValues(template), errors: {}, variables: variableRows(groups.perDocument, template.variables), ...(saved ? { saved: true } : {}) }}
            mode="edit"
            id={template.id}
            counterpartyOptions={groups.perDocument}
          />
        </Portlet>
        <Portlet title="Markers">
          <MarkerPanel groups={groups} malformed={malformedMarkers(template.bodyHtml)} />
        </Portlet>
        <Portlet title="Preview">
          <div className="form-actions">
            <a className="btn" href={`/documents/templates/${template.id}/preview`} target="_blank" rel="noopener noreferrer" aria-label={`Preview ${template.name} (opens in a new tab)`}>
              Preview
            </a>
            <span className="portlet-note">Shows the saved body, not unsaved changes.</span>
          </div>
        </Portlet>
        <Portlet title="Archive">
          <ArchiveForm endpoint={ENDPOINTS.archiveTemplate} initial={{}} id={template.id} />
        </Portlet>
      </div>
    </div>
  );
}
